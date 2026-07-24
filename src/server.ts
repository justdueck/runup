/**
 * MCP server wiring: tools, the profile/minimums UI resource, and JSON
 * result shaping. Kept separate from the stdio entry point (index.ts) so
 * tests can construct the server with fixtures.
 *
 * IMPORTANT: stdout carries the MCP protocol - log to stderr only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  AirportIdSchema,
  loadProfile,
  patchProfile,
  profilePath as defaultProfilePath,
  ProfilePatchSchema,
} from "./profile.js";
import { exportForeflight, withForeflight } from "./foreflight.js";
import { AviationWeatherClient, summarizeMetar, summarizeTaf } from "./weather.js";
import { scoreConditions } from "./scoring.js";
import { dateSpan, planDay, resolveAircraftPerformance } from "./planning.js";
import { FixtureCalendarProvider } from "./providers/calendar.js";
import { FixtureAvailabilityProvider } from "./providers/availability.js";
import { NaiveRoutePlanner } from "./providers/routes.js";
import type { Providers } from "./providers/types.js";
import { makeWindow, type TimeWindow } from "./types.js";

export const SERVER_NAME = "runup";
export const SERVER_VERSION = "0.1.0";

/** URI of the profile & minimums form (MCP Apps View). */
export const PROFILE_UI_URI = "ui://runup/profile-form.html";

/**
 * ISO-8601 date-time ("Z", ±HH:MM offset, or local time), calendar-aware
 * (rejects 2026-02-30). Enforced by a refinement so the schema published to
 * the model stays a plain string with a `format` hint rather than a regex.
 */
const IsoDateTimePattern = z.iso.datetime({ offset: true, local: true });
export const IsoTimestampSchema = z.string().refine((s) => IsoDateTimePattern.safeParse(s).success, {
  message: 'expected an ISO-8601 date-time such as "2026-07-25T16:00:00Z"',
});

/** Time-window input shared by the window tools: ISO-8601 `start`/`end`, start strictly before end. */
export const TimeWindowInputSchema = z
  .object({ start: IsoTimestampSchema, end: IsoTimestampSchema })
  .refine(
    (w) => {
      const start = Date.parse(w.start);
      const end = Date.parse(w.end);
      // Ordering is only checked once both timestamps parse; malformed values carry their own issue.
      return Number.isNaN(start) || Number.isNaN(end) || start < end;
    },
    { message: "window start must be before end", path: ["end"] },
  );

/** Model-facing field schemas for a window (validated in the handler via {@link TimeWindowInputSchema}). */
const WINDOW_INPUT_SHAPE = {
  start: z.string().meta({
    description: 'Window start, ISO-8601 date-time (e.g. "2026-07-25T16:00:00Z" or with a UTC offset).',
    format: "date-time",
  }),
  end: z.string().meta({
    description: "Window end, ISO-8601 date-time; must be after `start`.",
    format: "date-time",
  }),
};

export interface ServerDeps {
  /** Path to profile.json (defaults to ${RUNUP_HOME:-~/.runup}/profile.json). */
  profilePath?: string;
  providers?: Providers;
  weather?: AviationWeatherClient;
  /** Loader for the built profile-form HTML (defaults to dist/ui/profile-form.html). */
  loadUiHtml?: () => Promise<string>;
}

export function defaultProviders(): Providers {
  return {
    calendar: new FixtureCalendarProvider(),
    availability: new FixtureAvailabilityProvider(),
    routes: new NaiveRoutePlanner(),
  };
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const profileFile = deps.profilePath ?? defaultProfilePath();
  const providers = deps.providers ?? defaultProviders();
  const weather = deps.weather ?? new AviationWeatherClient();
  const loadUiHtml = deps.loadUiHtml ?? defaultUiHtmlLoader;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // --- Profile & minimums (with MCP Apps UI) --------------------------------

  registerAppTool(
    server,
    "get_profile",
    {
      title: "Get pilot profile",
      description:
        "Return the persisted pilot profile: home airports (ICAO ids, primary first), aircraft, personal " +
        "minimums (day/night), currency goals, and preferences. Renders an editable profile & minimums form " +
        "in MCP Apps hosts.",
      inputSchema: {},
      _meta: { ui: { resourceUri: PROFILE_UI_URI } },
    },
    async (): Promise<CallToolResult> => jsonResult(await loadProfile(profileFile)),
  );

  registerAppTool(
    server,
    "update_profile",
    {
      title: "Update pilot profile",
      description:
        "Apply a partial update (deep merge) to the pilot profile and persist it. Nested objects merge; " +
        "arrays such as `homeAirports` and `aircraft` are replaced wholesale. Returns the full updated " +
        "profile. Never put credentials here.",
      inputSchema: { patch: ProfilePatchSchema.describe("Partial profile: only the fields to change.") },
      _meta: { ui: { resourceUri: PROFILE_UI_URI } },
    },
    async ({ patch }): Promise<CallToolResult> => jsonResult(await patchProfile(patch, profileFile)),
  );

  registerAppResource(
    server,
    "Pilot profile & personal minimums form",
    PROFILE_UI_URI,
    {
      description: "Editable form for the pilot profile and day/night personal minimums.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: PROFILE_UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await loadUiHtml() }],
    }),
  );

  // --- Calendar ---------------------------------------------------------------

  server.registerTool(
    "get_free_windows",
    {
      title: "Get free calendar windows",
      description:
        "List free time windows in the pilot's calendar for a date range (currently a fixture provider - " +
        "canned data until the calendar source is chosen).",
      inputSchema: {
        startDate: z.string().describe("Range start, YYYY-MM-DD (local)."),
        endDate: z.string().optional().describe("Range end (inclusive day), YYYY-MM-DD. Defaults to startDate."),
        minDurationHours: z.number().positive().optional().describe("Drop windows shorter than this many hours."),
      },
    },
    async ({ startDate, endDate, minDurationHours }): Promise<CallToolResult> => {
      const range = dateSpan(startDate, endDate ?? startDate);
      const windows = await providers.calendar.getFreeWindows(
        range,
        minDurationHours !== undefined ? { minDurationHours } : {},
      );
      return jsonResult({ source: providers.calendar.name, range, windows });
    },
  );

  // --- Weather / conditions ---------------------------------------------------

  server.registerTool(
    "get_conditions",
    {
      title: "Get conditions vs personal minimums",
      description:
        "Fetch current METARs (and TAFs) for one or more airports from aviationweather.gov, summarize " +
        "ceiling/visibility/wind/gusts (plus crosswind when a runway heading is given), and score each against " +
        "the profile's personal minimums with a go/no-go verdict and reasons. Omit `airports` to score all of " +
        "the profile's home airports.",
      inputSchema: {
        airports: z
          .array(AirportIdSchema)
          .min(1)
          .max(10)
          .optional()
          .describe(
            "ICAO/FAA identifiers, e.g. [\"KPAE\", \"KHQM\"]. Defaults to the profile's home airports when omitted.",
          ),
        runwayHeadingDeg: z
          .number()
          .int()
          .min(1)
          .max(360)
          .optional()
          .describe("Runway heading in degrees (e.g. 340 for runway 34) to evaluate crosswind; applied to every airport."),
        timeOfDay: z.enum(["day", "night"]).optional().describe("Which minimums block to score against (default day)."),
      },
    },
    async ({ airports: requested, runwayHeadingDeg, timeOfDay }): Promise<CallToolResult> => {
      const profile = await loadProfile(profileFile);
      const usedDefaults = !requested || requested.length === 0;
      const airports = usedDefaults ? profile.homeAirports : requested;
      const [metars, tafs] = await Promise.all([weather.getMetars(airports), weather.getTafs(airports).catch(() => [])]);
      const results = airports.map((id) => {
        const metar = metars.find((m) => m.icaoId.toUpperCase() === id.toUpperCase());
        if (!metar) return { airport: id, summary: null, score: null, note: "no METAR returned" };
        const summary = summarizeMetar(metar, runwayHeadingDeg !== undefined ? { runwayHeadingDeg } : {});
        const score = scoreConditions(summary, profile.minimums, timeOfDay ? { timeOfDay } : {});
        return { airport: id, summary, score };
      });
      return jsonResult({
        airports,
        minimums: profile.minimums,
        results,
        tafs: tafs.map(summarizeTaf),
        notes: [
          ...(usedDefaults ? [`No airports given; scored the profile's home airports (${profile.homeAirports.join(", ")}).`] : []),
          "Runway heading (if given) is applied to every airport; per-runway data is TODO.",
          "Scores use current METARs; forecast (TAF) periods are returned for context but not yet scored.",
        ],
      });
    },
  );

  // --- Aircraft availability ---------------------------------------------------

  server.registerTool(
    "get_aircraft_availability",
    {
      title: "Get aircraft availability",
      description:
        "Check which aircraft tails at the flight school appear free for a time window (currently a fixture " +
        "provider; the school's scheduler is not wired up yet).",
      inputSchema: WINDOW_INPUT_SHAPE,
    },
    async ({ start, end }): Promise<CallToolResult> => {
      const parsed = windowFromInput({ start, end });
      if ("error" in parsed) return parsed.error;
      return jsonResult(await providers.availability.getAircraftAvailability(parsed.window));
    },
  );

  // --- Routes ---------------------------------------------------------------------

  server.registerTool(
    "plan_routes",
    {
      title: "Plan candidate routes for a window",
      description:
        "Propose out-and-back destinations (plus a local-practice option per home field) whose round trip fits " +
        "the given window at the aircraft's cruise speed with fuel and time buffers, departing each of the " +
        "profile's home airports and using its max distance and budget. Aircraft comes from `tail` or the profile.",
      inputSchema: {
        ...WINDOW_INPUT_SHAPE,
        tail: z.string().optional().describe("Tail number to plan with (must be in the profile for real numbers)."),
        maxCandidates: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ start, end, tail, maxCandidates }): Promise<CallToolResult> => {
      const parsed = windowFromInput({ start, end });
      if ("error" in parsed) return parsed.error;
      const { window } = parsed;
      const profile = await loadProfile(profileFile);
      const { aircraft, notes } = resolveAircraftPerformance(profile, tail ? { tail } : {});
      const routes = await providers.routes.planRoutes(
        window,
        aircraft,
        profile,
        maxCandidates !== undefined ? { maxCandidates } : {},
      );
      return jsonResult({ window, aircraft, notes, routes: routes.map(withForeflight) });
    },
  );

  // --- ForeFlight handoff ------------------------------------------------------

  server.registerTool(
    "export_foreflight",
    {
      title: "Export a route to ForeFlight",
      description:
        "Turn a planned route into a ForeFlight handoff: a foreflightmobile:// deep link that opens the route " +
        "in ForeFlight's Maps view when tapped on an iPhone/iPad with ForeFlight installed (save it as a " +
        "Flight there and ForeFlight sync carries it to your other devices), plus a Garmin .fpl flight-plan " +
        "file ForeFlight can import, written under the runup data directory. Route candidates from " +
        "plan_routes/plan_day already carry the deep link in their `foreflight` field; use this tool for the " +
        ".fpl file or a custom waypoint sequence.",
      inputSchema: {
        route: z
          .array(AirportIdSchema)
          .min(1)
          .max(20)
          .describe(
            'Airport identifiers in flying order, e.g. ["KPAE", "KAWO", "KPAE"] for an out-and-back. ' +
              "Repeat the home field at the end for a round trip.",
          ),
        routeName: z.string().max(50).optional().describe("Name for the saved flight plan (defaults to the route string)."),
        save: z
          .boolean()
          .default(true)
          .describe("Write the .fpl file to disk (default true). Set false to just get the link and XML."),
      },
    },
    async ({ route, routeName, save }): Promise<CallToolResult> =>
      jsonResult(
        await exportForeflight(route, {
          exportsDir: path.join(path.dirname(profileFile), "exports"),
          ...(routeName !== undefined ? { routeName } : {}),
          save,
        }),
      ),
  );

  // --- Composite: plan a whole day ---------------------------------------------

  server.registerTool(
    "plan_day",
    {
      title: "Plan a flying day",
      description:
        "Compose the whole picture for a date: free calendar windows -> aircraft availability -> current " +
        "conditions vs personal minimums at every home airport -> candidate routes per window. Returns one " +
        "structured plan for the model to narrate.",
      inputSchema: {
        date: z.string().describe("Date to plan, YYYY-MM-DD (local)."),
        timeOfDay: z.enum(["day", "night"]).optional().describe("Which minimums block to use (default day)."),
        runwayHeadingDeg: z.number().int().min(1).max(360).optional().describe("Home runway heading for crosswind."),
        minWindowHours: z.number().positive().optional().describe("Ignore free windows shorter than this (default 1.5)."),
      },
    },
    async ({ date, timeOfDay, runwayHeadingDeg, minWindowHours }): Promise<CallToolResult> => {
      const profile = await loadProfile(profileFile);
      const plan = await planDay(
        {
          date,
          ...(timeOfDay ? { timeOfDay } : {}),
          ...(runwayHeadingDeg !== undefined ? { runwayHeadingDeg } : {}),
          ...(minWindowHours !== undefined ? { minWindowHours } : {}),
        },
        { profile, providers, weather },
      );
      return jsonResult(plan);
    },
  );

  return server;
}

// --- helpers -----------------------------------------------------------------------

/** Structured JSON result: text fallback for non-UI hosts + structuredContent for Views/clients. */
export function jsonResult(payload: unknown): CallToolResult {
  const structuredContent =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { result: payload };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent,
  };
}

/** Friendly tool error result (isError: true) for invalid input. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Validate window inputs and build the window, or a friendly error result on bad input. */
function windowFromInput(input: { start: string; end: string }): { window: TimeWindow } | { error: CallToolResult } {
  const parsed = TimeWindowInputSchema.safeParse(input);
  if (!parsed.success) return { error: errorResult(`Invalid time window: ${formatIssues(parsed.error)}`) };
  return { window: makeWindow(new Date(parsed.data.start), new Date(parsed.data.end)) };
}

/** One-line summary of zod issues, e.g. "start: expected an ISO-8601 date-time ...; end: ...". */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/** Default UI loader: dist/ui/profile-form.html next to the compiled server, with a graceful fallback. */
async function defaultUiHtmlLoader(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "ui", "profile-form.html");
  try {
    return await fs.readFile(candidate, "utf8");
  } catch {
    return FALLBACK_UI_HTML;
  }
}

const FALLBACK_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Runup - Profile</title></head>
<body style="font-family: system-ui, sans-serif; padding: 1rem;">
  <h3>Profile &amp; minimums form not built</h3>
  <p>Run <code>npm run build</code> so <code>dist/ui/profile-form.html</code> exists. The
  <code>get_profile</code>/<code>update_profile</code> tools still work without the UI.</p>
</body></html>`;
