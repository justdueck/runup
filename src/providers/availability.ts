/**
 * Aircraft availability providers.
 *
 * Availability is a pluggable provider. FixtureAvailabilityProvider serves
 * canned bookings; NeedleNineProvider is the (not yet implemented) placeholder
 * for the flight school's real scheduling system.
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
 * NeedleNineProvider - the flight school's scheduler. STUB: not implemented.
 *
 * The school uses NeedleNine (needlenine.com), which has no public API. Its
 * member portal is a SPA at portal.needlenine.com backed by a JSON API at
 * api.needlenine.com; login is email/password (no MFA or captcha documented).
 * Intended approach: authenticate, then call the same JSON endpoints the
 * portal's schedule page uses (mapped from a browser network capture) and
 * translate reservations for the window into busy tails. Fallback if those
 * endpoints prove unstable: drive the portal with Playwright and read the
 * schedule grid. Personal-use only, low volume, on demand - no polling.
 * Credentials come from the OS keychain via getSchedulerCredentials()
 * (also not implemented), never from profile.json.
 */
export class NeedleNineProvider implements AvailabilityProvider {
  readonly name = "needlenine (not implemented)";

  async getAircraftAvailability(_window: TimeWindow): Promise<AircraftAvailability> {
    throw new Error(
      "NeedleNineProvider is not implemented yet - the NeedleNine portal integration has not been built. " +
        "Use FixtureAvailabilityProvider for now.",
    );
  }
}
