/**
 * Aircraft availability providers.
 *
 * - FixtureAvailabilityProvider serves canned bookings (placeholder data).
 * - NeedleNineProvider (./needlenine) reads the school's real NeedleNine
 *   schedule through portal automation.
 * - SchedulerAvailabilityProvider is what the tools use: it picks NeedleNine
 *   when the profile configures a scheduler and otherwise falls back to the
 *   fixture with a note explaining how to configure the real thing.
 */
import type { Profile } from "../profile.js";
import type { AircraftAvailability, TimeWindow } from "../types.js";
import type { AvailabilityProvider } from "./types.js";
import { keychainAddCommand } from "./needlenine/credentials.js";
import { resolveSchedulerConfig } from "./needlenine/config.js";
import { NeedleNineProvider } from "./needlenine/provider.js";

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

/** Shown alongside fixture results so it is obvious how to switch to the real schedule. */
export function schedulerNotConfiguredNote(): string {
  return (
    "No flight-school scheduler is configured, so this is placeholder (fixture) data. " +
    "To use your real NeedleNine schedule: (1) update_profile with " +
    '{"scheduler": {"provider": "needlenine", "email": "you@example.com"}}, then (2) store your portal ' +
    `password in the macOS keychain with: ${keychainAddCommand("you@example.com")} — see get_scheduler_status.`
  );
}

export interface SchedulerAvailabilityDeps {
  loadProfile: () => Promise<Profile>;
  env?: NodeJS.ProcessEnv;
  /** Placeholder provider used while no scheduler is configured. */
  fixture?: AvailabilityProvider;
  /** Real scheduler provider (defaults to a NeedleNineProvider sharing loadProfile/env). */
  needlenine?: NeedleNineProvider;
}

/** Delegates to NeedleNine when configured, otherwise fixture data plus a setup note. */
export class SchedulerAvailabilityProvider implements AvailabilityProvider {
  readonly name = "aircraft-availability";
  private readonly fixture: AvailabilityProvider;
  private readonly needlenine: NeedleNineProvider;

  constructor(private readonly deps: SchedulerAvailabilityDeps) {
    this.fixture = deps.fixture ?? new FixtureAvailabilityProvider();
    this.needlenine =
      deps.needlenine ??
      new NeedleNineProvider({
        loadProfile: deps.loadProfile,
        ...(deps.env ? { env: deps.env } : {}),
        logger: (line) => console.error(line),
      });
  }

  async getAircraftAvailability(window: TimeWindow): Promise<AircraftAvailability> {
    const profile = await this.deps.loadProfile();
    const cfg = resolveSchedulerConfig(profile, this.deps.env ?? process.env);
    if (!cfg) {
      const result = await this.fixture.getAircraftAvailability(window);
      return { ...result, notes: [...result.notes, schedulerNotConfiguredNote()] };
    }
    return this.needlenine.availabilityFor(window, profile, cfg);
  }

  /** Close any live portal session (called on server shutdown). */
  async dispose(): Promise<void> {
    await this.needlenine.dispose();
  }
}

/** Back-compat re-export: the concrete NeedleNine provider now lives under ./needlenine. */
export { NeedleNineProvider } from "./needlenine/provider.js";
