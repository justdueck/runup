/**
 * Aircraft availability providers.
 *
 * The flight school's scheduling system is not confirmed yet, so availability
 * is a pluggable provider. FixtureAvailabilityProvider serves canned bookings;
 * SchedulerBrowserProvider is the placeholder for the real thing.
 */
import type { AircraftAvailability, TimeWindow } from "../types.js";
import type { AvailabilityProvider } from "./types.js";

/** tail -> existing bookings (busy blocks). */
export type BookingLedger = Record<string, Array<{ start: string; end: string }>>;

/** Canned availability: a tail is free when none of its bookings overlap the window. */
export class FixtureAvailabilityProvider implements AvailabilityProvider {
  readonly name = "fixture-availability";
  private readonly ledger: BookingLedger;

  constructor(ledger?: BookingLedger) {
    this.ledger = ledger ?? defaultFixtureLedger();
  }

  async getAircraftAvailability(window: TimeWindow): Promise<AircraftAvailability> {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    const availableTails = Object.entries(this.ledger)
      .filter(([, bookings]) =>
        bookings.every((b) => {
          const bStart = Date.parse(b.start);
          const bEnd = Date.parse(b.end);
          return bEnd <= start || bStart >= end; // no overlap
        }),
      )
      .map(([tail]) => tail)
      .sort();
    return {
      window,
      availableTails,
      source: this.name,
      notes: ["Fixture data - not the real school schedule."],
    };
  }
}

/** Two example tails, one with a booking tomorrow midday. */
export function defaultFixtureLedger(now: Date = new Date()): BookingLedger {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const busyStart = new Date(tomorrow);
  busyStart.setHours(11, 0, 0, 0);
  const busyEnd = new Date(tomorrow);
  busyEnd.setHours(15, 0, 0, 0);
  return {
    N12345: [{ start: busyStart.toISOString(), end: busyEnd.toISOString() }],
    N678SP: [],
  };
}

/**
 * TODO: SchedulerBrowserProvider.
 *
 * Placeholder for the flight school's scheduling system. Once the system is
 * known this will drive it - most likely a headless browser (Playwright)
 * logging in with credentials pulled from the OS keychain (see
 * getSchedulerCredentials in profile.ts), scraping the schedule grid for the
 * requested window, and mapping bookings to tails. If the school's system
 * exposes an API or iCal feed, prefer that over browser automation.
 */
export class SchedulerBrowserProvider implements AvailabilityProvider {
  readonly name = "scheduler-browser (not implemented)";

  async getAircraftAvailability(_window: TimeWindow): Promise<AircraftAvailability> {
    throw new Error(
      "SchedulerBrowserProvider is not implemented yet - the school's scheduling system has not been chosen. " +
        "Use FixtureAvailabilityProvider for now.",
    );
  }
}
