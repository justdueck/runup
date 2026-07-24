import { describe, expect, it } from "vitest";
import ical from "node-ical";
import {
  busyIntervalsFromCalendars,
  computeFreeWindows,
  IcalCalendarProvider,
  resolveIcalUrls,
  scrubIcalUrls,
  type IcalCalendarSettings,
} from "../src/providers/ical-calendar.js";
import { mergeIntervals, subtractIntervals, type Interval } from "../src/intervals.js";
import { defaultProfile } from "../src/profile.js";
import type { HttpTextFetcher } from "../src/http.js";
import { loadTextFixture as readIcs, MemoryIcsFetcher } from "./helpers.js";

const SETTINGS: IcalCalendarSettings = {
  timeZone: "America/Los_Angeles",
  earliestLocalTime: "07:00",
  latestLocalTime: "21:00",
  allDayEventsBlock: false,
  bufferBeforeMinutes: 60,
  bufferAfterMinutes: 30,
  minDurationHours: 2.5,
};

const at = (iso: string): number => Date.parse(iso);

describe("interval math", () => {
  it("merges overlapping and touching intervals", () => {
    const merged = mergeIntervals([
      { start: 10, end: 20 },
      { start: 15, end: 25 },
      { start: 25, end: 30 }, // touching -> merged
      { start: 40, end: 50 },
      { start: 60, end: 55 }, // empty/inverted -> dropped
    ]);
    expect(merged).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 50 },
    ]);
  });

  it("subtracts busy intervals from a free block (edges and interior)", () => {
    const free: Interval = { start: 0, end: 100 };
    expect(subtractIntervals(free, [])).toEqual([{ start: 0, end: 100 }]);
    expect(subtractIntervals(free, [{ start: 30, end: 40 }])).toEqual([
      { start: 0, end: 30 },
      { start: 40, end: 100 },
    ]);
    // Busy overlapping the start edge and the end edge, plus one fully outside.
    expect(subtractIntervals(free, [{ start: -10, end: 10 }, { start: 90, end: 120 }, { start: 200, end: 300 }])).toEqual([
      { start: 10, end: 90 },
    ]);
    // Busy covering everything -> nothing free.
    expect(subtractIntervals(free, [{ start: -5, end: 105 }])).toEqual([]);
  });
});

describe("computeFreeWindows (day clipping in the profile zone, buffers, min duration)", () => {
  // 2026-07-24 in America/Los_Angeles (PDT, UTC-7): flyable hours 07:00-21:00 = 14:00Z -> 04:00Z(+1).
  const range = { start: new Date("2026-07-24T07:00:00Z"), end: new Date("2026-07-25T07:00:00Z") }; // the LA day, midnight-midnight

  it("clips a whole free day to the earliest/latest local flyable hours", () => {
    const windows = computeFreeWindows(range, [], SETTINGS, 2.5);
    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe("2026-07-24T07:00:00-07:00");
    expect(windows[0].end).toBe("2026-07-24T21:00:00-07:00");
    expect(windows[0].durationHours).toBe(14);
    expect(windows[0].label).toMatch(/Fri, Jul 24 07:00-21:00 PDT/);
  });

  it("subtracts a buffered busy block and drops sub-minimum leftovers", () => {
    // Dentist 10:00-11:00 PDT, already buffered 60 min before / 30 min after -> 09:00-11:30 busy.
    const busy: Interval[] = [{ start: at("2026-07-24T16:00:00Z"), end: at("2026-07-24T18:30:00Z") }];
    const strict = computeFreeWindows(range, busy, SETTINGS, 2.5);
    expect(strict.map((w) => [w.start, w.end])).toEqual([
      ["2026-07-24T11:30:00-07:00", "2026-07-24T21:00:00-07:00"], // the 07:00-09:00 (2 h) gap is under 2.5 h
    ]);
    const loose = computeFreeWindows(range, busy, SETTINGS, 1);
    expect(loose.map((w) => [w.start, w.end, w.durationHours])).toEqual([
      ["2026-07-24T07:00:00-07:00", "2026-07-24T09:00:00-07:00", 2],
      ["2026-07-24T11:30:00-07:00", "2026-07-24T21:00:00-07:00", 9.5],
    ]);
  });

  it("splits a multi-day range into per-local-day windows (never crossing local midnight)", () => {
    const twoDays = { start: new Date("2026-07-24T00:00:00-07:00"), end: new Date("2026-07-26T00:00:00-07:00") };
    const windows = computeFreeWindows(twoDays, [], SETTINGS, 2.5);
    expect(windows.map((w) => w.start)).toEqual(["2026-07-24T07:00:00-07:00", "2026-07-25T07:00:00-07:00"]);
    expect(windows.every((w) => w.durationHours === 14)).toBe(true);
  });

  it("respects a query range narrower than the flyable hours", () => {
    // Ask only for 12:00-15:00 PDT; result is clipped to that, not stretched to 07:00-21:00.
    const midday = { start: new Date("2026-07-24T12:00:00-07:00"), end: new Date("2026-07-24T15:00:00-07:00") };
    const windows = computeFreeWindows(midday, [], SETTINGS, 2.5);
    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe("2026-07-24T12:00:00-07:00");
    expect(windows[0].end).toBe("2026-07-24T15:00:00-07:00");
  });
});

describe("busyIntervalsFromCalendars (fixtures via node-ical)", () => {
  const laDay = (isoDate: string): { start: Date; end: Date } => ({
    start: new Date(`${isoDate}T00:00:00-07:00`),
    end: new Date(`${isoDate}T24:00:00-07:00`),
  });

  it("plain timed event: buffered busy block; TRANSPARENT and CANCELLED events are ignored", async () => {
    const calendars = [ical.sync.parseICS(await readIcs("ical-plain.ics"))];
    const busy = busyIntervalsFromCalendars(calendars, laDay("2026-07-24"), SETTINGS);
    // Dentist 17:00-18:00Z with 60 min before / 30 min after -> 16:00-18:30Z. Nothing else counts.
    expect(busy).toEqual([{ start: at("2026-07-24T16:00:00Z"), end: at("2026-07-24T18:30:00Z") }]);
  });

  it("weekly RRULE: EXDATE removes an instance and a RECURRENCE-ID override moves one", async () => {
    const calendars = [ical.sync.parseICS(await readIcs("ical-weekly.ics"))];
    // Jul 16 (Thursday): a plain rule instance 16:00-17:00Z, buffered.
    expect(busyIntervalsFromCalendars(calendars, laDay("2026-07-16"), SETTINGS)).toEqual([
      { start: at("2026-07-16T15:00:00Z"), end: at("2026-07-16T17:30:00Z") },
    ]);
    // Jul 23: the instance is overridden to 21:00-22:00Z (moved to the afternoon).
    expect(busyIntervalsFromCalendars(calendars, laDay("2026-07-23"), SETTINGS)).toEqual([
      { start: at("2026-07-23T20:00:00Z"), end: at("2026-07-23T22:30:00Z") },
    ]);
    // Jul 30: excluded by EXDATE -> nothing busy at all.
    expect(busyIntervalsFromCalendars(calendars, laDay("2026-07-30"), SETTINGS)).toEqual([]);
  });

  it("all-day event blocks the whole local day only when allDayEventsBlock is set (no buffers)", async () => {
    const calendars = [ical.sync.parseICS(await readIcs("ical-allday.ics"))];
    expect(busyIntervalsFromCalendars(calendars, laDay("2026-07-24"), SETTINGS)).toEqual([]); // default: ignored
    const blocking = busyIntervalsFromCalendars(calendars, laDay("2026-07-24"), { ...SETTINGS, allDayEventsBlock: true });
    // The whole LOCAL day (America/Los_Angeles midnight to midnight), not the buffered event times.
    expect(blocking).toEqual([{ start: at("2026-07-24T00:00:00-07:00"), end: at("2026-07-25T00:00:00-07:00") }]);
  });

  it("TZID event is placed at the correct absolute time (17:00 EDT = 14:00 PDT = 21:00Z)", async () => {
    const calendars = [ical.sync.parseICS(await readIcs("ical-tzid.ics"))];
    expect(busyIntervalsFromCalendars(calendars, laDay("2026-07-24"), SETTINGS)).toEqual([
      { start: at("2026-07-24T20:00:00Z"), end: at("2026-07-24T23:00:00Z") }, // 21:00-22:30Z +/- buffers
    ]);
  });
});

describe("IcalCalendarProvider (in-memory fetcher, several feeds)", () => {
  const PLAIN_URL = "https://calendar.google.com/calendar/ical/pilot%40example.com/private-plainsecret/basic.ics";
  const TZID_URL = "https://calendar.google.com/calendar/ical/work%40example.com/private-tzsecret/basic.ics";

  it("merges busy time across feeds and returns clipped free windows", async () => {
    const fetcher = new MemoryIcsFetcher({
      [PLAIN_URL]: await readIcs("ical-plain.ics"),
      [TZID_URL]: await readIcs("ical-tzid.ics"),
    });
    const provider = new IcalCalendarProvider([PLAIN_URL, TZID_URL], SETTINGS, fetcher);
    expect(provider.name).toBe("ical-calendar");
    // LA calendar day 2026-07-24 (midnight-to-midnight in America/Los_Angeles).
    const windows = await provider.getFreeWindows(
      { start: "2026-07-24T07:00:00.000Z", end: "2026-07-25T07:00:00.000Z" },
      { minDurationHours: 1 },
    );
    // Busy (buffered): dentist 09:00-11:30 PDT, east-coast call 13:00-16:00 PDT.
    expect(windows.map((w) => [w.start, w.end, w.durationHours])).toEqual([
      ["2026-07-24T07:00:00-07:00", "2026-07-24T09:00:00-07:00", 2],
      ["2026-07-24T11:30:00-07:00", "2026-07-24T13:00:00-07:00", 1.5],
      ["2026-07-24T16:00:00-07:00", "2026-07-24T21:00:00-07:00", 5],
    ]);
    expect(fetcher.requestedUrls.sort()).toEqual([PLAIN_URL, TZID_URL].sort());

    // Default minimum duration (2.5 h from settings) drops the short gaps.
    const strict = await provider.getFreeWindows({ start: "2026-07-24T07:00:00.000Z", end: "2026-07-25T07:00:00.000Z" });
    expect(strict.map((w) => w.start)).toEqual(["2026-07-24T16:00:00-07:00"]);
  });

  it("never leaks the secret feed URL in fetch errors", async () => {
    const failing: HttpTextFetcher = {
      // Simulate a low-level error that (like undici) mentions the URL it was fetching.
      getText: async (url: string) => {
        throw new Error(`fetch failed: getaddrinfo ENOTFOUND for ${url}`);
      },
    };
    const provider = new IcalCalendarProvider([PLAIN_URL], SETTINGS, failing);
    await expect(
      provider.getFreeWindows({ start: "2026-07-24T14:00:00.000Z", end: "2026-07-25T04:00:00.000Z" }),
    ).rejects.toThrow(/iCal feed #1 of 1/);
    try {
      await provider.getFreeWindows({ start: "2026-07-24T14:00:00.000Z", end: "2026-07-25T04:00:00.000Z" });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("private-plainsecret");
      expect(message).not.toContain(PLAIN_URL);
      expect(message).toContain("[redacted iCal URL]");
    }
  });

  it("scrubs every configured URL (including webcal:// and decoded spellings)", () => {
    const text = `boom ${PLAIN_URL} and webcal://calendar.google.com/calendar/ical/pilot%40example.com/private-plainsecret/basic.ics and https://calendar.google.com/calendar/ical/pilot@example.com/private-plainsecret/basic.ics`;
    const scrubbed = scrubIcalUrls(text, [PLAIN_URL]);
    expect(scrubbed).not.toContain("private-plainsecret");
    expect(scrubbed).toContain("[redacted iCal URL]");
  });
});

describe("resolveIcalUrls (env first, then profile)", () => {
  it("prefers RUNUP_ICAL_URLS over the profile and normalizes webcal://", () => {
    const profile = { ...defaultProfile(), calendar: { ...defaultProfile().calendar, icalUrls: ["https://profile.example/basic.ics"] } };
    expect(resolveIcalUrls({}, defaultProfile())).toEqual({ urls: [], source: "none" });
    expect(resolveIcalUrls({}, profile)).toEqual({ urls: ["https://profile.example/basic.ics"], source: "profile" });
    expect(resolveIcalUrls({ RUNUP_ICAL_URLS: " webcal://env.example/a.ics, , https://env.example/b.ics " }, profile)).toEqual({
      urls: ["https://env.example/a.ics", "https://env.example/b.ics"],
      source: "env",
    });
  });
});
