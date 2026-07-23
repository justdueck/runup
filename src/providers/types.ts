/**
 * Provider interfaces. Concrete data sources (Google Calendar, the flight
 * school's scheduler, FAA airport data) are unknown or not wired up yet, so
 * everything the planner needs sits behind these small interfaces with
 * fixture implementations for now.
 */
import type { Profile } from "../profile.js";
import type {
  AircraftAvailability,
  AircraftPerformance,
  DateRange,
  RouteCandidate,
  TimeWindow,
} from "../types.js";

/** Finds free time in the pilot's calendar. */
export interface CalendarProvider {
  readonly name: string;
  getFreeWindows(range: DateRange, opts?: { minDurationHours?: number }): Promise<TimeWindow[]>;
}

/** Checks which aircraft (tails) are free at the school for a window. */
export interface AvailabilityProvider {
  readonly name: string;
  getAircraftAvailability(window: TimeWindow): Promise<AircraftAvailability>;
}

/** Proposes candidate routes sized to a window for a given aircraft. */
export interface RoutePlanner {
  readonly name: string;
  planRoutes(
    window: TimeWindow,
    aircraft: AircraftPerformance,
    profile: Profile,
    opts?: { maxCandidates?: number },
  ): Promise<RouteCandidate[]>;
}

/** Bundle of everything the planning tools depend on (injectable for tests). */
export interface Providers {
  calendar: CalendarProvider;
  availability: AvailabilityProvider;
  routes: RoutePlanner;
}
