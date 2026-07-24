import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer, PROFILE_UI_URI } from "../src/server.js";
import { loadProfile } from "../src/profile.js";
import { FixtureCalendarProvider } from "../src/providers/calendar.js";
import { FixtureAvailabilityProvider, SchedulerAvailabilityProvider } from "../src/providers/availability.js";
import { NaiveRoutePlanner } from "../src/providers/routes.js";
import { makeWindow } from "../src/types.js";
import { fixtureWeatherClient } from "./helpers.js";

const EXPECTED_TOOLS = [
  "get_profile",
  "update_profile",
  "get_free_windows",
  "get_conditions",
  "get_aircraft_availability",
  "get_scheduler_status",
  "plan_routes",
  "plan_day",
  "export_foreflight",
];

let dir: string;
let client: Client;

/** First text content of a tool result (where friendly error messages land). */
function firstText(result: unknown): string | undefined {
  return (result as { content?: Array<{ type: string; text?: string }> }).content?.find((c) => c.type === "text")?.text;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "runup-server-"));
  const morning = makeWindow(new Date(2026, 6, 25, 9, 0), new Date(2026, 6, 25, 12, 30), "morning");
  const server = createServer({
    profilePath: path.join(dir, "profile.json"),
    providers: {
      calendar: new FixtureCalendarProvider([morning]),
      availability: new FixtureAvailabilityProvider({ N678SP: [], N12345: [] }),
      routes: new NaiveRoutePlanner(),
    },
    weather: fixtureWeatherClient().client,
    loadUiHtml: async () => "<!DOCTYPE html><html><body><h1>profile form (test)</h1></body></html>",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("runup MCP server", () => {
  it("registers the expected tools with UI metadata on the profile tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    const getProfile = tools.find((t) => t.name === "get_profile")!;
    const meta = getProfile._meta as Record<string, unknown> | undefined;
    expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PROFILE_UI_URI);
    expect(meta?.["ui/resourceUri"]).toBe(PROFILE_UI_URI); // legacy key populated by registerAppTool

    // `airports` is optional now: omitted -> defaults to the profile's home airports.
    const conditions = tools.find((t) => t.name === "get_conditions")!;
    expect(conditions.inputSchema.required ?? []).not.toContain("airports");
  });

  it("serves the profile & minimums View as an MCP Apps resource", async () => {
    const { resources } = await client.listResources();
    const uiResource = resources.find((r) => r.uri === PROFILE_UI_URI);
    expect(uiResource?.mimeType).toBe(RESOURCE_MIME_TYPE);

    const read = await client.readResource({ uri: PROFILE_UI_URI });
    expect(read.contents[0]).toMatchObject({ uri: PROFILE_UI_URI, mimeType: RESOURCE_MIME_TYPE });
    expect(String(read.contents[0].text)).toContain("profile form (test)");
  });

  it("get_profile returns defaults and update_profile persists a deep patch", async () => {
    const before = await client.callTool({ name: "get_profile", arguments: {} });
    expect((before.structuredContent as { homeAirports: string[] }).homeAirports).toEqual(["KPAE", "KTIW"]);

    const updated = await client.callTool({
      name: "update_profile",
      arguments: { patch: { homeAirports: ["KBFI"], minimums: { day: { crosswindKt: 10 } } } },
    });
    const profile = updated.structuredContent as {
      homeAirports: string[];
      minimums: { day: { crosswindKt: number; ceilingFt: number } };
    };
    expect(profile.homeAirports).toEqual(["KBFI"]); // array replaced wholesale
    expect(profile.minimums.day.crosswindKt).toBe(10);
    expect(profile.minimums.day.ceilingFt).toBe(3000); // untouched

    const after = await client.callTool({ name: "get_profile", arguments: {} });
    expect((after.structuredContent as { homeAirports: string[] }).homeAirports).toEqual(["KBFI"]);
  });

  it("update_profile rejects invalid patches as tool errors", async () => {
    const result = await client.callTool({
      name: "update_profile",
      arguments: { patch: { minimums: { day: { ceilingFt: -100 } } } },
    });
    expect(result.isError).toBe(true);
  });

  it("get_conditions scores fixture METARs against the profile minimums", async () => {
    const result = await client.callTool({
      name: "get_conditions",
      arguments: { airports: ["KPAE", "KHQM"], runwayHeadingDeg: 340 },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      results: Array<{ airport: string; score: { verdict: string } | null; summary: { flightCategory: string } | null }>;
    };
    const byAirport = Object.fromEntries(payload.results.map((r) => [r.airport, r]));
    expect(byAirport.KPAE.score?.verdict).toBe("go");
    expect(byAirport.KHQM.score?.verdict).toBe("no-go");
    expect(byAirport.KHQM.summary?.flightCategory).toBe("LIFR");
  });

  it("get_conditions defaults to the profile's home airports when none are given", async () => {
    const result = await client.callTool({ name: "get_conditions", arguments: { runwayHeadingDeg: 340 } });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      airports: string[];
      results: Array<{ airport: string; score: { verdict: string } | null }>;
      notes: string[];
    };
    expect(payload.airports).toEqual(["KPAE", "KTIW"]);
    const byAirport = Object.fromEntries(payload.results.map((r) => [r.airport, r]));
    expect(byAirport.KPAE.score?.verdict).toBe("go");
    expect(byAirport.KTIW.score?.verdict).toBe("no-go"); // BKN015 below the day ceiling minimum
    expect(payload.notes.join(" ")).toMatch(/home airports/);
  });

  it("get_scheduler_status reports an unconfigured scheduler with setup steps and no secrets", async () => {
    const result = await client.callTool({ name: "get_scheduler_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const status = result.structuredContent as {
      configured: boolean;
      email: string | null;
      notes: string[];
      credentials: Record<string, unknown>;
    };
    expect(status.configured).toBe(false);
    expect(status.email).toBeNull();
    expect(status.notes.join(" ")).toMatch(/update_profile/);
    expect(JSON.stringify(status)).not.toMatch(/password":\s*"[^[]/); // only variable names / booleans, never values
  });

  it("the default availability provider falls back to fixture data with a setup note", async () => {
    const profileFile = path.join(dir, "profile.json");
    const server = createServer({
      profilePath: profileFile,
      providers: {
        calendar: new FixtureCalendarProvider([]),
        availability: new SchedulerAvailabilityProvider({
          loadProfile: () => loadProfile(profileFile),
          env: {},
          fixture: new FixtureAvailabilityProvider({ N678SP: [] }),
        }),
        routes: new NaiveRoutePlanner(),
      },
      weather: fixtureWeatherClient().client,
      loadUiHtml: async () => "<html></html>",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const other = new Client({ name: "test-client-2", version: "0.0.0" });
    await other.connect(clientTransport);
    try {
      const result = await other.callTool({
        name: "get_aircraft_availability",
        arguments: { start: "2026-07-25T16:00:00Z", end: "2026-07-25T19:30:00Z" },
      });
      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent as { source: string; availableTails: string[]; notes: string[] };
      expect(payload.source).toBe("fixture-availability");
      expect(payload.availableTails).toEqual(["N678SP"]);
      expect(payload.notes.join(" ")).toMatch(/No flight-school scheduler is configured/);
    } finally {
      await other.close();
    }
  });

  it("get_aircraft_availability validates the window and returns free tails", async () => {
    const ok = await client.callTool({
      name: "get_aircraft_availability",
      arguments: { start: "2026-07-25T16:00:00Z", end: "2026-07-25T19:30:00Z" },
    });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { availableTails: string[] }).availableTails).toEqual(["N12345", "N678SP"]);

    const reversed = await client.callTool({
      name: "get_aircraft_availability",
      arguments: { start: "2026-07-25T19:30:00Z", end: "2026-07-25T16:00:00Z" },
    });
    expect(reversed.isError).toBe(true);
    expect(firstText(reversed)).toMatch(/start must be before end/);

    const notATimestamp = await client.callTool({
      name: "get_aircraft_availability",
      arguments: { start: "tomorrow morning", end: "2026-07-25T19:30:00Z" },
    });
    expect(notATimestamp.isError).toBe(true);
    expect(firstText(notATimestamp)).toMatch(/start: expected an ISO-8601 date-time/);
  });

  it("plan_routes rejects impossible dates and empty windows but accepts offset timestamps", async () => {
    const impossible = await client.callTool({
      name: "plan_routes",
      arguments: { start: "2026-02-30T09:00:00Z", end: "2026-02-30T12:00:00Z" }, // Feb 30 does not exist
    });
    expect(impossible.isError).toBe(true);
    expect(firstText(impossible)).toMatch(/ISO-8601/);

    const empty = await client.callTool({
      name: "plan_routes",
      arguments: { start: "2026-07-25T16:00:00Z", end: "2026-07-25T16:00:00Z" },
    });
    expect(empty.isError).toBe(true);
    expect(firstText(empty)).toMatch(/before end/);

    const ok = await client.callTool({
      name: "plan_routes",
      arguments: { start: "2026-07-25T09:00:00-07:00", end: "2026-07-25T12:30:00-07:00" },
    });
    expect(ok.isError).toBeFalsy();
    const routes = (ok.structuredContent as { routes: Array<{ foreflight: { route: string; openUrl: string } }> }).routes;
    expect(routes.length).toBeGreaterThan(0);
    // Every candidate carries a one-tap ForeFlight handoff link.
    for (const r of routes) {
      expect(r.foreflight.openUrl).toMatch(/^foreflightmobile:\/\/maps\/search\?q=/);
      expect(r.foreflight.route.split(" ").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("export_foreflight returns a deep link and writes a Garmin .fpl file", async () => {
    const result = await client.callTool({
      name: "export_foreflight",
      arguments: { route: ["KPAE", "KAWO", "KPAE"], routeName: "Arlington lunch run" },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      route: string;
      openUrl: string;
      fpl: { fileName: string; xml: string; savedTo: string | null } | null;
      notes: string[];
    };
    expect(payload.route).toBe("KPAE KAWO KPAE");
    expect(payload.openUrl).toBe("foreflightmobile://maps/search?q=KPAE%20KAWO%20KPAE");
    expect(payload.fpl?.fileName).toBe("KPAE-KAWO-KPAE.fpl");
    expect(payload.fpl?.savedTo).toBe(path.join(dir, "exports", "KPAE-KAWO-KPAE.fpl"));
    const onDisk = await readFile(payload.fpl!.savedTo!, "utf8");
    expect(onDisk).toBe(payload.fpl!.xml);
    expect(onDisk).toContain("http://www8.garmin.com/xmlschemas/FlightPlan/v1");
    expect(onDisk).toContain("<route-name>ARLINGTON LUNCH RUN</route-name>");
    expect(payload.notes.join(" ")).toMatch(/Send To > Flights/);
  });

  it("export_foreflight still links unknown airports but skips the .fpl", async () => {
    const result = await client.callTool({
      name: "export_foreflight",
      arguments: { route: ["KPAE", "KZZZ"] },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as { openUrl: string; fpl: unknown; notes: string[] };
    expect(payload.openUrl).toBe("foreflightmobile://maps/search?q=KPAE%20KZZZ");
    expect(payload.fpl).toBeNull();
    expect(payload.notes.join(" ")).toMatch(/No coordinates for KZZZ/);
  });

  it("plan_day composes the full picture", async () => {
    const result = await client.callTool({
      name: "plan_day",
      arguments: { date: "2026-07-25", runwayHeadingDeg: 340 },
    });
    expect(result.isError).toBeFalsy();
    const plan = result.structuredContent as {
      homeAirports: string[];
      conditions: Array<{ airport: string; score: { verdict: string } | null }>;
      windows: Array<{ availability: { availableTails: string[] } | null; routes: unknown[]; notes: string[] }>;
    };
    expect(plan.homeAirports).toEqual(["KPAE", "KTIW"]);
    const byAirport = Object.fromEntries(plan.conditions.map((c) => [c.airport, c]));
    expect(byAirport.KPAE.score?.verdict).toBe("go");
    expect(byAirport.KTIW.score?.verdict).toBe("no-go");
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].availability?.availableTails).toEqual(["N12345", "N678SP"]);
    expect(plan.windows[0].routes.length).toBeGreaterThan(0);
    expect(plan.windows[0].notes.join(" ")).toMatch(/below personal minimums at KTIW/);
    // Text fallback is always present for non-UI hosts.
    expect((result.content as Array<{ type: string }>)[0].type).toBe("text");
  });
});
