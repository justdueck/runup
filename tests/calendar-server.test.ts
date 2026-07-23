import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { FixtureCalendarProvider } from "../src/providers/calendar.js";
import { FixtureAvailabilityProvider } from "../src/providers/availability.js";
import { NaiveRoutePlanner } from "../src/providers/routes.js";
import { REDACTED_ICAL_URL } from "../src/profile.js";
import { makeWindow } from "../src/types.js";
import type { HttpTextFetcher } from "../src/http.js";
import { fixtureWeatherClient, loadTextFixture, MemoryIcsFetcher } from "./helpers.js";

/** Stand-ins for Google Calendar "secret address in iCal format" URLs (bearer secrets). */
const SECRET_URL = "https://calendar.google.com/calendar/ical/pilot%40example.com/private-3f9e2bd0secret/basic.ics";
const SECRET_URL_2 = "https://calendar.google.com/calendar/ical/work%40example.com/private-77aa11work/basic.ics";
const SECRET_URL_3 = "https://calendar.google.com/calendar/ical/club%40example.com/private-cc42club/basic.ics";
const SECRET_TOKEN = "private-3f9e2bd0secret";
const ALL_SECRET_URLS = `${SECRET_URL},${SECRET_URL_2},${SECRET_URL_3}`;

/** Serves the fixture calendars for the secret URLs entirely in memory (one feed per fixture). */
async function inMemoryIcsFetcher(): Promise<HttpTextFetcher> {
  return new MemoryIcsFetcher({
    [SECRET_URL]: await loadTextFixture("ical-plain.ics"),
    [SECRET_URL_2]: await loadTextFixture("ical-tzid.ics"),
    [SECRET_URL_3]: await loadTextFixture("ical-allday.ics"),
  });
}

let dir: string;
let client: Client;

async function connect(deps: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(clientTransport);
  return c;
}

function textOf(result: unknown): string {
  return (
    (result as { content?: Array<{ type: string; text?: string }> }).content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n") ?? ""
  );
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "runup-cal-"));
});

afterEach(async () => {
  if (client) await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("calendar wiring through the MCP server", () => {
  it("uses the iCal provider when RUNUP_ICAL_URLS is set (busy subtracted, daylight tagged, URL never leaked)", async () => {
    client = await connect({
      profilePath: path.join(dir, "profile.json"),
      env: { RUNUP_ICAL_URLS: ALL_SECRET_URLS },
      icsFetcher: await inMemoryIcsFetcher(),
      weather: fixtureWeatherClient().client,
    });

    const result = await client.callTool({
      name: "get_free_windows",
      arguments: { startDate: "2026-07-24", minDurationHours: 1 },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      source: string;
      timezone: string;
      windows: Array<{ start: string; end: string; durationHours: number; daylight: string; sun: Array<{ airport: string }> }>;
      notes: string[];
    };
    expect(payload.source).toBe("ical-calendar");
    expect(payload.timezone).toBe("America/Los_Angeles");
    // Dentist 10:00-11:00 PDT (buffered 09:00-11:30) and the 14:00-15:30 PDT call (buffered 13:00-16:00) are busy;
    // the all-day event is ignored by default; TRANSPARENT/CANCELLED events do not block.
    expect(payload.windows.map((w) => [w.start, w.end])).toEqual([
      ["2026-07-24T07:00:00-07:00", "2026-07-24T09:00:00-07:00"],
      ["2026-07-24T11:30:00-07:00", "2026-07-24T13:00:00-07:00"],
      ["2026-07-24T16:00:00-07:00", "2026-07-24T21:00:00-07:00"],
    ]);
    // Daylight tagging (not filtering): the morning slot is daytime, the evening one runs past sunset.
    expect(payload.windows[0].daylight).toBe("day");
    expect(payload.windows[2].daylight).toBe("mixed");
    expect(payload.windows[0].sun.map((s) => s.airport)).toEqual(["KPAE", "KTIW"]);
    expect(payload.notes.join(" ")).toMatch(/3 private iCal feed/);
    // The secret URLs never appear anywhere in the output.
    const json = JSON.stringify(result);
    expect(json).not.toContain(SECRET_TOKEN);
    expect(json).not.toContain("private-77aa11work");
    expect(json).not.toContain("private-cc42club");
  });

  it("keeps the iCal URL out of the error path", async () => {
    const boom: HttpTextFetcher = {
      getText: async (url: string) => {
        throw new Error(`fetch failed: getaddrinfo ENOTFOUND while fetching ${url}`); // low-level error naming the URL
      },
    };
    client = await connect({
      profilePath: path.join(dir, "profile.json"),
      env: { RUNUP_ICAL_URLS: SECRET_URL },
      icsFetcher: boom,
      weather: fixtureWeatherClient().client,
    });
    const result = await client.callTool({ name: "get_free_windows", arguments: { startDate: "2026-07-24" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/iCal feed #1/);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain("calendar.google.com/calendar/ical");
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  it("falls back to the fixture provider with a clear note when no calendar is configured", async () => {
    const morning = makeWindow(new Date("2026-07-24T16:00:00Z"), new Date("2026-07-24T19:30:00Z"), "morning (fixture)");
    client = await connect({
      profilePath: path.join(dir, "profile.json"),
      env: {},
      providers: {
        calendar: new FixtureCalendarProvider([morning]),
        availability: new FixtureAvailabilityProvider({ N678SP: [] }),
        routes: new NaiveRoutePlanner(),
      },
      weather: fixtureWeatherClient().client,
    });
    const result = await client.callTool({ name: "get_free_windows", arguments: { startDate: "2026-07-24" } });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as { source: string; windows: Array<{ label: string; daylight: string }>; notes: string[] };
    expect(payload.source).toBe("fixture-calendar");
    expect(payload.windows[0].label).toBe("morning (fixture)");
    expect(payload.windows[0].daylight).toBe("day"); // 09:00-12:30 PDT in late July
    const notes = payload.notes.join(" ");
    expect(notes).toMatch(/No calendar is configured/);
    expect(notes).toMatch(/RUNUP_ICAL_URLS/);
  });

  it("redacts calendar.icalUrls in get_profile / update_profile and ignores echoed placeholders", async () => {
    const profileFile = path.join(dir, "profile.json");
    client = await connect({
      profilePath: profileFile,
      env: {},
      icsFetcher: await inMemoryIcsFetcher(),
      weather: fixtureWeatherClient().client,
    });

    // Store a secret feed URL through update_profile.
    const updated = await client.callTool({
      name: "update_profile",
      arguments: { patch: { calendar: { icalUrls: [SECRET_URL], allDayEventsBlock: true } } },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.stringify(updated)).not.toContain(SECRET_TOKEN);
    expect((updated.structuredContent as { calendar: { icalUrls: string[] } }).calendar.icalUrls).toEqual([
      REDACTED_ICAL_URL,
    ]);
    // ...but the real URL IS persisted on disk (that file lives outside the repo, gitignored).
    expect(JSON.parse(await readFile(profileFile, "utf8")).calendar.icalUrls).toEqual([SECRET_URL]);

    // get_profile is redacted too.
    const profile = await client.callTool({ name: "get_profile", arguments: {} });
    expect(JSON.stringify(profile)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(profile)).toContain(REDACTED_ICAL_URL);

    // Round-tripping the redacted placeholder must not clobber the stored secret.
    const roundTrip = await client.callTool({
      name: "update_profile",
      arguments: { patch: { calendar: { icalUrls: [REDACTED_ICAL_URL], bufferBeforeMinutes: 45 } } },
    });
    expect(roundTrip.isError).toBeFalsy();
    const onDisk = JSON.parse(await readFile(profileFile, "utf8"));
    expect(onDisk.calendar.icalUrls).toEqual([SECRET_URL]);
    expect(onDisk.calendar.bufferBeforeMinutes).toBe(45);
    expect(onDisk.calendar.allDayEventsBlock).toBe(true); // untouched sibling survives

    // And the profile-sourced URL now drives get_free_windows (env unset).
    const windows = await client.callTool({
      name: "get_free_windows",
      arguments: { startDate: "2026-07-25", minDurationHours: 1 },
    });
    expect(windows.isError).toBeFalsy();
    expect((windows.structuredContent as { source: string }).source).toBe("ical-calendar");
    expect(JSON.stringify(windows)).not.toContain(SECRET_TOKEN);
  });

  it("plan_day uses the calendar selection too (fixture fallback carries the configuration note)", async () => {
    const morning = makeWindow(new Date("2026-07-25T16:00:00Z"), new Date("2026-07-25T19:30:00Z"), "morning (fixture)");
    client = await connect({
      profilePath: path.join(dir, "profile.json"),
      env: {},
      providers: {
        calendar: new FixtureCalendarProvider([morning]),
        availability: new FixtureAvailabilityProvider({ N678SP: [] }),
        routes: new NaiveRoutePlanner(),
      },
      weather: fixtureWeatherClient().client,
    });
    const result = await client.callTool({ name: "plan_day", arguments: { date: "2026-07-25" } });
    expect(result.isError).toBeFalsy();
    const plan = result.structuredContent as { notes: string[]; windows: Array<{ window: { daylight: string } }> };
    expect(plan.notes.join(" ")).toMatch(/No calendar is configured/);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].window.daylight).toBe("day");
  });
});
