/**
 * Calendar providers.
 *
 * TODO(GoogleCalendarProvider): real implementation should read the pilot's
 * Google Calendar via the freebusy API (OAuth desktop flow, token cached in
 * the OS keychain - never in profile.json) and subtract busy blocks from a
 * configurable "flyable hours" template. Until the calendar source is
 * chosen, FixtureCalendarProvider returns canned windows.
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
