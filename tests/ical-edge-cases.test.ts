import { describe, expect, it } from "vitest";
import ical from "node-ical";
import { busyIntervalsFromCalendars, computeFreeWindows, IcalCalendarProvider, type IcalCalendarSettings } from "../src/providers/ical-calendar.js";
import { dateSpanInZone } from "../src/planning.js";
import type { HttpTextFetcher } from "../src/http.js";

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
const ics = (body: string): string =>
  ["BEGIN:VCALENDAR", "PRODID:-//runup tests//edge//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", ...body.trim().split("\n"), "END:VCALENDAR"]
    .map((l) => l.trim())
    .join("\r\n");
const laDay = (isoDate: string): { start: Date; end: Date } => ({
  start: new Date(`${isoDate}T00:00:00-07:00`),
  end: new Date(`${isoDate}T24:00:00-07:00`),
});

/**
 * Busy intervals that actually overlap the queried day. busyIntervalsFromCalendars
 * deliberately searches a widened window (buffers + a day either side), so its
 * raw output may include harmless intervals on neighbouring days.
 */
const busyOverlapping = (calendars: ical.CalendarResponse[], day: { start: Date; end: Date }, settings: IcalCalendarSettings) =>
  busyIntervalsFromCalendars(calendars, day, settings).filter((b) => b.end > day.start.getTime() && b.start < day.end.getTime());

describe("recurrence / all-day edge cases", () => {
  it("multi-day all-day event blocks every covered local day (allDayEventsBlock)", () => {
    // DTEND is exclusive: Jul 24, 25 and 26 are covered.
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART;VALUE=DATE:20260724
      DTEND;VALUE=DATE:20260727
      DTSTAMP:20260701T000000Z
      UID:trip@runup.test
      SUMMARY:Camping trip
      END:VEVENT`),
    );
    const blocking = { ...SETTINGS, allDayEventsBlock: true };
    const range = { start: new Date("2026-07-23T00:00:00-07:00"), end: new Date("2026-07-28T00:00:00-07:00") };
    expect(busyIntervalsFromCalendars([cal], range, blocking)).toEqual([
      { start: at("2026-07-24T00:00:00-07:00"), end: at("2026-07-27T00:00:00-07:00") },
    ]);
    // Jul 23 and Jul 27 stay flyable; the three trip days have no windows.
    const windows = computeFreeWindows(range, busyIntervalsFromCalendars([cal], range, blocking), blocking, 2.5);
    expect(windows.map((w) => w.start)).toEqual(["2026-07-23T07:00:00-07:00", "2026-07-27T07:00:00-07:00"]);
  });

  it("recurring all-day event (weekly) blocks only its days", () => {
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART;VALUE=DATE:20260703
      DTEND;VALUE=DATE:20260704
      RRULE:FREQ=WEEKLY;BYDAY=FR
      DTSTAMP:20260701T000000Z
      UID:friday-off@runup.test
      SUMMARY:Fridays blocked
      END:VEVENT`),
    );
    const blocking = { ...SETTINGS, allDayEventsBlock: true };
    // Fri Jul 24 blocked, Thu Jul 23 / Sat Jul 25 not.
    expect(busyOverlapping([cal], laDay("2026-07-24"), blocking)).toEqual([
      { start: at("2026-07-24T00:00:00-07:00"), end: at("2026-07-25T00:00:00-07:00") },
    ]);
    expect(busyOverlapping([cal], laDay("2026-07-23"), blocking)).toEqual([]);
    expect(busyOverlapping([cal], laDay("2026-07-25"), blocking)).toEqual([]);
    // End to end: Friday has no free window at all; Thursday and Saturday keep their full day.
    const week = { start: new Date("2026-07-23T00:00:00-07:00"), end: new Date("2026-07-26T00:00:00-07:00") };
    const windows = computeFreeWindows(week, busyIntervalsFromCalendars([cal], week, blocking), blocking, 2.5);
    expect(windows.map((w) => w.start)).toEqual(["2026-07-23T07:00:00-07:00", "2026-07-25T07:00:00-07:00"]);
  });

  it("weekly TZID RRULE follows local wall-clock time across the November DST change", () => {
    // Every Monday 09:00-10:00 America/Los_Angeles: 16:00Z while PDT, 17:00Z once PST (Nov 1 2026 fall back).
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VTIMEZONE
      TZID:America/Los_Angeles
      BEGIN:DAYLIGHT
      TZOFFSETFROM:-0800
      TZOFFSETTO:-0700
      TZNAME:PDT
      DTSTART:19700308T020000
      RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
      END:DAYLIGHT
      BEGIN:STANDARD
      TZOFFSETFROM:-0700
      TZOFFSETTO:-0800
      TZNAME:PST
      DTSTART:19701101T020000
      RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
      END:STANDARD
      END:VTIMEZONE
      BEGIN:VEVENT
      DTSTART;TZID=America/Los_Angeles:20261019T090000
      DTEND;TZID=America/Los_Angeles:20261019T100000
      RRULE:FREQ=WEEKLY;BYDAY=MO
      DTSTAMP:20261001T000000Z
      UID:standup-tz@runup.test
      SUMMARY:Monday standup 09:00 local
      END:VEVENT`),
    );
    const noBuf = { ...SETTINGS, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    // Oct 26 (still PDT, UTC-7): 09:00 local = 16:00Z.
    expect(busyIntervalsFromCalendars([cal], laDay("2026-10-26"), noBuf)).toEqual([
      { start: at("2026-10-26T16:00:00Z"), end: at("2026-10-26T17:00:00Z") },
    ]);
    // Nov 2 (PST, UTC-8 after the Nov 1 fall-back): same 09:00 local = 17:00Z.
    expect(
      busyIntervalsFromCalendars([cal], { start: new Date("2026-11-02T00:00:00-08:00"), end: new Date("2026-11-03T00:00:00-08:00") }, noBuf),
    ).toEqual([{ start: at("2026-11-02T17:00:00Z"), end: at("2026-11-02T18:00:00Z") }]);
  });

  it("RECURRENCE-ID override moves a later instance INTO the queried day (and frees the original day)", () => {
    // Weekly Thursdays 09:00-10:00 PDT (16:00Z); the Jul 30 instance is moved to Sat Jul 25 12:00-13:00 PDT.
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART:20260702T160000Z
      DTEND:20260702T170000Z
      RRULE:FREQ=WEEKLY;BYDAY=TH
      DTSTAMP:20260701T000000Z
      UID:weekly-move@runup.test
      SEQUENCE:0
      SUMMARY:Weekly standup
      END:VEVENT
      BEGIN:VEVENT
      DTSTART:20260725T190000Z
      DTEND:20260725T200000Z
      DTSTAMP:20260710T000000Z
      UID:weekly-move@runup.test
      RECURRENCE-ID:20260730T160000Z
      SEQUENCE:1
      SUMMARY:Weekly standup (Jul 30 moved to Sat Jul 25 12:00 PDT)
      END:VEVENT`),
    );
    const noBuf = { ...SETTINGS, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    // Sat Jul 25: only the moved instance appears (no Thursday rule instance is generated that day).
    expect(busyIntervalsFromCalendars([cal], laDay("2026-07-25"), noBuf)).toEqual([
      { start: at("2026-07-25T19:00:00Z"), end: at("2026-07-25T20:00:00Z") },
    ]);
    // Thu Jul 30: the original slot is gone (moved), so nothing is busy.
    expect(busyIntervalsFromCalendars([cal], laDay("2026-07-30"), noBuf)).toEqual([]);
    // Thu Jul 23: an ordinary rule instance is unaffected.
    expect(busyIntervalsFromCalendars([cal], laDay("2026-07-23"), noBuf)).toEqual([
      { start: at("2026-07-23T16:00:00Z"), end: at("2026-07-23T17:00:00Z") },
    ]);
  });

  it("EXDATE given with a TZID parameter excludes that instance", () => {
    // Daily 08:00 PDT (15:00Z) Jul 22-26; Jul 24 excluded via a TZID'd EXDATE.
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART;TZID=America/Los_Angeles:20260722T080000
      DTEND;TZID=America/Los_Angeles:20260722T090000
      RRULE:FREQ=DAILY;COUNT=5
      EXDATE;TZID=America/Los_Angeles:20260724T080000
      DTSTAMP:20260701T000000Z
      UID:daily-exdate-tz@runup.test
      SUMMARY:Daily brief
      END:VEVENT`),
    );
    const noBuf = { ...SETTINGS, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    expect(busyOverlapping([cal], laDay("2026-07-23"), noBuf)).toEqual([
      { start: at("2026-07-23T15:00:00Z"), end: at("2026-07-23T16:00:00Z") },
    ]);
    expect(busyOverlapping([cal], laDay("2026-07-24"), noBuf)).toEqual([]); // excluded
    expect(busyOverlapping([cal], laDay("2026-07-25"), noBuf)).toEqual([
      { start: at("2026-07-25T15:00:00Z"), end: at("2026-07-25T16:00:00Z") },
    ]);
    expect(busyOverlapping([cal], laDay("2026-07-27"), noBuf)).toEqual([]); // COUNT=5 ended Jul 26
  });

  it("a single occurrence marked Free (TRANSP:TRANSPARENT override) does not block; the series still does", () => {
    // Google Calendar: "mark this occurrence as Free" emits a RECURRENCE-ID override with TRANSP:TRANSPARENT.
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART:20260702T160000Z
      DTEND:20260702T170000Z
      RRULE:FREQ=WEEKLY;BYDAY=TH
      DTSTAMP:20260701T000000Z
      UID:weekly-free@runup.test
      SEQUENCE:0
      TRANSP:OPAQUE
      SUMMARY:Weekly standup (09:00 PDT)
      END:VEVENT
      BEGIN:VEVENT
      DTSTART:20260723T160000Z
      DTEND:20260723T170000Z
      DTSTAMP:20260710T000000Z
      UID:weekly-free@runup.test
      RECURRENCE-ID:20260723T160000Z
      SEQUENCE:1
      TRANSP:TRANSPARENT
      SUMMARY:Weekly standup (Jul 23 occurrence marked Free)
      END:VEVENT`),
    );
    const noBuf = { ...SETTINGS, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    // Jul 16: an ordinary opaque occurrence blocks 16:00-17:00Z.
    expect(busyOverlapping([cal], laDay("2026-07-16"), noBuf)).toEqual([
      { start: at("2026-07-16T16:00:00Z"), end: at("2026-07-16T17:00:00Z") },
    ]);
    // Jul 23: that occurrence shows as "Free" -> it must not block.
    expect(busyOverlapping([cal], laDay("2026-07-23"), noBuf)).toEqual([]);
  });

  it("an occurrence cancelled via a STATUS:CANCELLED override does not block", () => {
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART:20260702T160000Z
      DTEND:20260702T170000Z
      RRULE:FREQ=WEEKLY;BYDAY=TH
      DTSTAMP:20260701T000000Z
      UID:weekly-cancel@runup.test
      SEQUENCE:0
      SUMMARY:Weekly standup
      END:VEVENT
      BEGIN:VEVENT
      DTSTART:20260723T160000Z
      DTEND:20260723T170000Z
      DTSTAMP:20260710T000000Z
      UID:weekly-cancel@runup.test
      RECURRENCE-ID:20260723T160000Z
      SEQUENCE:1
      STATUS:CANCELLED
      SUMMARY:Weekly standup (Jul 23 cancelled)
      END:VEVENT`),
    );
    const noBuf = { ...SETTINGS, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    expect(busyOverlapping([cal], laDay("2026-07-23"), noBuf)).toEqual([]);
    expect(busyOverlapping([cal], laDay("2026-07-30"), noBuf)).toEqual([
      { start: at("2026-07-30T16:00:00Z"), end: at("2026-07-30T17:00:00Z") },
    ]);
  });

  it("timed event with no DTEND / DURATION is zero-length but its buffers still block", () => {
    const cal = ical.sync.parseICS(
      ics(`
      BEGIN:VEVENT
      DTSTART:20260724T180000Z
      DTSTAMP:20260701T000000Z
      UID:no-end@runup.test
      SUMMARY:Reminder with no duration (11:00 PDT)
      END:VEVENT`),
    );
    // 18:00Z with 60 min before / 30 min after -> 17:00Z-18:30Z busy.
    expect(busyIntervalsFromCalendars([cal], laDay("2026-07-24"), SETTINGS)).toEqual([
      { start: at("2026-07-24T17:00:00Z"), end: at("2026-07-24T18:30:00Z") },
    ]);
  });
});

describe("day-boundary and DST edge cases in computeFreeWindows", () => {
  it("fall-back day (Nov 1 2026): flyable band is a real 14 h, rendered with the PST offset", () => {
    const noBuf = { ...SETTINGS, minDurationHours: 0 };
    const range = { start: new Date("2026-11-01T00:00:00-07:00"), end: new Date("2026-11-02T00:00:00-08:00") }; // the LA day (25 h)
    const windows = computeFreeWindows(range, [], noBuf, 0);
    expect(windows).toHaveLength(1);
    // 07:00 and 21:00 local are both after the 02:00 transition -> PST (-08:00).
    expect(windows[0].start).toBe("2026-11-01T07:00:00-08:00");
    expect(windows[0].end).toBe("2026-11-01T21:00:00-08:00");
    expect(windows[0].durationHours).toBe(14);
  });

  it("spring-forward day (Mar 8 2026): 14 h band with the PDT offset", () => {
    const range = { start: new Date("2026-03-08T00:00:00-08:00"), end: new Date("2026-03-09T00:00:00-07:00") }; // the LA day (23 h)
    const windows = computeFreeWindows(range, [], { ...SETTINGS, minDurationHours: 0 }, 0);
    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe("2026-03-08T07:00:00-07:00");
    expect(windows[0].end).toBe("2026-03-08T21:00:00-07:00");
    expect(windows[0].durationHours).toBe(14);
  });

  it("a busy block hanging over the earliest flyable time only trims the front of the day", () => {
    // Event 05:00-08:00 PDT (12:00-15:00Z), buffered to 04:00-08:30 PDT: window opens at 08:30.
    const range = { start: new Date("2026-07-24T00:00:00-07:00"), end: new Date("2026-07-25T00:00:00-07:00") };
    const busy = [{ start: at("2026-07-24T11:00:00Z"), end: at("2026-07-24T15:30:00Z") }];
    const windows = computeFreeWindows(range, busy, SETTINGS, 2.5);
    expect(windows.map((w) => [w.start, w.end])).toEqual([["2026-07-24T08:30:00-07:00", "2026-07-24T21:00:00-07:00"]]);
  });

  it("get_free_windows-style range for the DST fall-back date resolves both midnights in the profile zone", () => {
    // dateSpanInZone is what the tool uses: Nov 1 spans 25 real hours in America/Los_Angeles.
    const range = dateSpanInZone("2026-11-01", "2026-11-01", "America/Los_Angeles");
    expect(range).toEqual({ start: "2026-11-01T07:00:00.000Z", end: "2026-11-02T08:00:00.000Z" });
    const spring = dateSpanInZone("2026-03-08", "2026-03-08", "America/Los_Angeles");
    expect(spring).toEqual({ start: "2026-03-08T08:00:00.000Z", end: "2026-03-09T07:00:00.000Z" });
  });
});

describe("provider-level behaviors", () => {
  const URL_A = "https://calendar.example/private-aaa/basic.ics";
  const URL_B = "https://calendar.example/private-bbb/basic.ics";

  it("a single failing feed fails the whole query but names only the feed number", async () => {
    const fetcher: HttpTextFetcher = {
      getText: async (url: string) => {
        if (url === URL_A) return ics(`
          BEGIN:VEVENT
          DTSTART:20260724T170000Z
          DTEND:20260724T180000Z
          DTSTAMP:20260701T000000Z
          UID:ok@runup.test
          SUMMARY:ok
          END:VEVENT`);
        throw new Error(`ECONNRESET while reading ${url}`);
      },
    };
    const provider = new IcalCalendarProvider([URL_A, URL_B], SETTINGS, fetcher);
    await expect(provider.getFreeWindows({ start: "2026-07-24T07:00:00Z", end: "2026-07-25T07:00:00Z" })).rejects.toThrow(
      /iCal feed #2 of 2/,
    );
    try {
      await provider.getFreeWindows({ start: "2026-07-24T07:00:00Z", end: "2026-07-25T07:00:00Z" });
    } catch (err) {
      expect((err as Error).message).not.toContain("private-bbb");
      expect((err as Error).message).not.toContain(URL_B);
    }
  });

  it("an unparseable feed is reported as a parse failure without the URL", async () => {
    const fetcher: HttpTextFetcher = { getText: async () => "this is not\nan ics feed at all" };
    const provider = new IcalCalendarProvider([URL_A], SETTINGS, fetcher);
    // node-ical is tolerant of garbage (yields an empty calendar) - either way no URL may surface.
    try {
      const windows = await provider.getFreeWindows({ start: "2026-07-24T07:00:00Z", end: "2026-07-25T07:00:00Z" });
      // Tolerant parse -> the whole flyable day is free.
      expect(windows.map((w) => w.durationHours)).toEqual([14]);
    } catch (err) {
      expect((err as Error).message).toMatch(/iCal feed #1 of 1/);
      expect((err as Error).message).not.toContain("private-aaa");
    }
  });

  it("scrubs the URL even when the fetcher throws a bare string (non-Error)", async () => {
    const fetcher: HttpTextFetcher = {
      getText: async (url: string) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw `socket hang up while streaming ${url}`; // some libraries throw plain strings
      },
    };
    const provider = new IcalCalendarProvider([URL_A], SETTINGS, fetcher);
    try {
      await provider.getFreeWindows({ start: "2026-07-24T07:00:00Z", end: "2026-07-25T07:00:00Z" });
      throw new Error("expected a rejection");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/iCal feed #1 of 1/);
      expect(message).not.toContain("private-aaa");
      expect(message).not.toContain(URL_A);
      expect(message).toContain("[redacted iCal URL]");
    }
  });

  it("rejects an inverted / invalid query range without touching the network", async () => {
    let fetched = 0;
    const fetcher: HttpTextFetcher = { getText: async () => (fetched++, "") };
    const provider = new IcalCalendarProvider([URL_A], SETTINGS, fetcher);
    await expect(provider.getFreeWindows({ start: "2026-07-25T07:00:00Z", end: "2026-07-24T07:00:00Z" })).rejects.toThrow(
      /Invalid date range/,
    );
    await expect(provider.getFreeWindows({ start: "garbage", end: "2026-07-24T07:00:00Z" })).rejects.toThrow(/Invalid date range/);
    expect(fetched).toBe(0);
  });
});
