/**
 * Shared domain types used across providers, planning, and the MCP tools.
 * Times are ISO 8601 strings (UTC or with offset) so results serialize cleanly
 * into MCP tool output.
 */
import { round2 } from "./util.js";

/** Daylight classification of a window at the home airports (see src/daylight.ts). */
export type DaylightTag = "day" | "night" | "mixed" | "unknown";

/** Sun events at one airport for a local day (ISO timestamps with the profile-zone offset). */
export interface AirportSunTimes {
  airport: string;
  /** Local date (YYYY-MM-DD, profile zone) the times refer to. */
  date: string;
  sunrise: string | null;
  sunset: string | null;
  /** Morning civil twilight begins (sun 6 degrees below the horizon). */
  civilDawn: string | null;
  /** Evening civil twilight ends. */
  civilDusk: string | null;
  /** True when the window ran past local midnight (times are for the start day). */
  spansLocalMidnight?: boolean;
}

/** A contiguous block of time the pilot could fly. */
export interface TimeWindow {
  /** ISO 8601 start timestamp. */
  start: string;
  /** ISO 8601 end timestamp. */
  end: string;
  /** Convenience: (end - start) in hours, rounded to 2 decimals. */
  durationHours: number;
  /** Optional label, e.g. "morning slot" or the calendar gap description. */
  label?: string;
  /** Daylight tag at the home airports (added by the daylight tagger). */
  daylight?: DaylightTag;
  /** Sun times per home airport used for the daylight tag. */
  sun?: AirportSunTimes[];
  /** Free-form notes (e.g. an unresolvable home airport). */
  notes?: string[];
}

/** Inclusive-ish date/time range used to query calendars. */
export interface DateRange {
  start: string;
  end: string;
}

/** A bundled airport record (see src/data/airports.json). */
export interface Airport {
  /** ICAO or FAA location identifier, e.g. "KPAE" or "S43". */
  icao: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt?: number;
  towered?: boolean;
  note?: string;
  /** Where the coordinates/elevation were transcribed from (placeholder-data provenance). */
  source?: string;
}

/** Performance figures the route planner needs; derived from the profile aircraft list. */
export interface AircraftPerformance {
  /** Tail number, or null when using a generic performance model. */
  tail: string | null;
  type: string;
  cruiseKtas: number;
  fuelBurnGph: number;
  usableFuelGal: number;
}

/** Result of an aircraft-availability query for one window. */
export interface AircraftAvailability {
  window: TimeWindow;
  /** Tail numbers that appear free for the whole window. */
  availableTails: string[];
  /** Which provider produced this (fixture, scheduler, ...). */
  source: string;
  notes: string[];
}

/** A candidate route sized to a window: out-and-back, or a local practice flight. */
export interface RouteCandidate {
  kind: "out-and-back" | "local";
  home: string;
  destination: {
    icao: string;
    name: string;
    lat: number;
    lon: number;
    note?: string;
  };
  /** One-way great-circle distance in nautical miles. */
  legDistanceNm: number;
  /** Round-trip great-circle distance in nautical miles. */
  totalDistanceNm: number;
  /** Estimated en-route time (both legs) plus fixed allowances, in hours. */
  estBlockTimeHours: number;
  /** Estimated fuel burn for the round trip, in US gallons. */
  estFuelGal: number;
  /** True when block time (+ buffer) fits inside the window and fuel is legal. */
  fitsWindow: boolean;
  margins: {
    spareTimeHours: number;
    fuelRemainingGal: number;
  };
  notes: string[];
}

export function makeWindow(start: Date, end: Date, label?: string): TimeWindow {
  const durationHours = round2(Math.max(0, (end.getTime() - start.getTime()) / 3_600_000));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    durationHours,
    ...(label ? { label } : {}),
  };
}
