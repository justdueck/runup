/**
 * Fixture calendar provider (canned windows).
 *
 * The real calendar source is {@link ../providers/ical-calendar.ts | IcalCalendarProvider},
 * which reads a private iCal (ICS) feed - e.g. a Google Calendar "secret
 * address in iCal format" - configured via RUNUP_ICAL_URLS or the profile's
 * calendar.icalUrls. This fixture provider is the fallback the server uses
 * when no feed is configured (its output carries a note saying so) and is
 * what the tests inject.
 */
import { makeWindow, type DateRange, type TimeWindow } from "../types.js";
import type { CalendarProvider } from "./types.js";

/** Returns canned free windows (defaults are generated relative to `now`). */
export class FixtureCalendarProvider implements CalendarProvider {
  readonly name = "fixture-calendar";
  private readonly windows: TimeWindow[];

  constructor(windows?: TimeWindow[], now: Date = new Date()) {
    this.windows = windows ?? defaultFixtureWindows(now);
  }

  async getFreeWindows(range: DateRange, opts: { minDurationHours?: number } = {}): Promise<TimeWindow[]> {
    const rangeStart = Date.parse(range.start);
    const rangeEnd = Date.parse(range.end);
    const minHours = opts.minDurationHours ?? 0;
    return this.windows.filter((w) => {
      const start = Date.parse(w.start);
      const end = Date.parse(w.end);
      const overlaps = start < rangeEnd && end > rangeStart;
      return overlaps && w.durationHours >= minHours;
    });
  }
}

/**
 * Canned data: for each of the next three days, a morning slot (09:00-12:30)
 * and an afternoon slot (14:00-17:00) in the machine's local time zone.
 */
export function defaultFixtureWindows(now: Date = new Date()): TimeWindow[] {
  const windows: TimeWindow[] = [];
  for (let dayOffset = 1; dayOffset <= 3; dayOffset++) {
    const base = new Date(now);
    base.setDate(base.getDate() + dayOffset);
    windows.push(
      makeWindow(atLocal(base, 9, 0), atLocal(base, 12, 30), "morning slot (fixture)"),
      makeWindow(atLocal(base, 14, 0), atLocal(base, 17, 0), "afternoon slot (fixture)"),
    );
  }
  return windows;
}

function atLocal(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}
