/**
 * Daylight tagging: sunrise / sunset / civil twilight at the pilot's home
 * airports (lat/lon from the bundled airport dataset) via suncalc, plus a
 * day / night / mixed tag per free window. Purely informational - windows
 * are never filtered by daylight; a night window is still a window (e.g. for
 * night currency), it is just labeled.
 */
import { getTimes } from "suncalc";
import { bundledAirports, findAirport } from "./data/airports.js";
import type { Airport, AirportSunTimes, DaylightTag, TimeWindow } from "./types.js";
import { addDays, formatIsoWithOffset, formatLocalDate, localDate, zonedTimeToUtc } from "./tz.js";

/** Sun events at one airport for the local day containing an instant. */
export function sunTimesForAirport(
  airport: Airport,
  instant: Date,
  timeZone: string,
): AirportSunTimes {
  // Ask suncalc about the airport's local solar noon so the result is
  // unambiguously "that day" no matter what time `instant` is.
  const day = localDate(instant, timeZone);
  const localNoon = zonedTimeToUtc({ ...day, hour: 12 }, timeZone);
  const t = getTimes(localNoon, airport.lat, airport.lon);
  const iso = (d: Date | null | undefined): string | null =>
    d instanceof Date && !Number.isNaN(d.getTime()) ? formatIsoWithOffset(d, timeZone) : null;
  return {
    airport: airport.icao,
    date: formatLocalDate(day),
    sunrise: iso(t.sunrise),
    sunset: iso(t.sunset),
    // suncalc's "dawn"/"dusk" are civil twilight (sun 6 degrees below the horizon).
    civilDawn: iso(t.dawn),
    civilDusk: iso(t.dusk),
  };
}

/** Result of tagging one window: the tag, the per-airport sun times used, and any notes. */
export interface DaylightAssessment {
  daylight: DaylightTag;
  sun: AirportSunTimes[];
  notes: string[];
}

/**
 * Tag a window as "day" (entirely between sunrise and sunset at every
 * resolvable home airport), "night" (entirely outside civil twilight at
 * every home airport, i.e. it ends before civil dawn or starts after civil
 * dusk), otherwise "mixed" (it spans a sun boundary/twilight, or the home
 * airports disagree). Home airports missing from the airport dataset are
 * skipped with a note; if none resolve, the tag is "unknown".
 */
export function assessDaylight(
  window: { start: string; end: string },
  homeAirports: string[],
  timeZone: string,
  airports: Airport[] = bundledAirports,
): DaylightAssessment {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const notes: string[] = [];
  const sun: AirportSunTimes[] = [];

  for (const id of homeAirports) {
    const airport = findAirport(id, airports);
    if (!airport) {
      notes.push(`Home airport ${id.trim().toUpperCase()} is not in the airport dataset; no sun times for it.`);
      continue;
    }
    sun.push(sunTimesAcrossWindow(airport, start, end, timeZone));
  }

  if (sun.length === 0) return { daylight: "unknown", sun, notes };

  const allDay = sun.every((s) => isFullyBetween(start, end, s.sunrise, s.sunset));
  const allNight = sun.every((s) => isFullyOutside(start, end, s.civilDawn, s.civilDusk));
  const daylight: DaylightTag = allDay ? "day" : allNight ? "night" : "mixed";
  return { daylight, sun, notes };
}

/** Attach `daylight` + `sun` to each window (returns new objects; notes appended per window). */
export function tagWindowsWithDaylight(
  windows: TimeWindow[],
  homeAirports: string[],
  timeZone: string,
  airports: Airport[] = bundledAirports,
): TimeWindow[] {
  return windows.map((w) => {
    const { daylight, sun, notes } = assessDaylight(w, homeAirports, timeZone, airports);
    const combinedNotes = [...(w.notes ?? []), ...notes];
    return {
      ...w,
      daylight,
      sun,
      ...(combinedNotes.length > 0 ? { notes: combinedNotes } : {}),
    };
  });
}

/**
 * Sun times for the local day the window starts on; when the window ends
 * on a later local day (unusual - windows are clipped per day), the times of
 * the START day are still used and the later day is folded into "mixed".
 */
function sunTimesAcrossWindow(airport: Airport, start: Date, end: Date, timeZone: string): AirportSunTimes {
  const times = sunTimesForAirport(airport, start, timeZone);
  const startDay = localDate(start, timeZone);
  const nextDayStart = zonedTimeToUtc(addDays(startDay, 1), timeZone);
  return end.getTime() > nextDayStart.getTime() ? { ...times, spansLocalMidnight: true } : times;
}

function isFullyBetween(start: Date, end: Date, from: string | null, to: string | null): boolean {
  if (from === null || to === null) return false; // polar day/night etc.: no clean "day" band
  return start.getTime() >= Date.parse(from) && end.getTime() <= Date.parse(to);
}

/** True when the window lies wholly before `from` or wholly after `to` (both known). */
function isFullyOutside(start: Date, end: Date, from: string | null, to: string | null): boolean {
  if (from === null || to === null) return false;
  return end.getTime() <= Date.parse(from) || start.getTime() >= Date.parse(to);
}
