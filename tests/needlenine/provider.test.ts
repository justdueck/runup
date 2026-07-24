import { describe, expect, it, vi } from "vitest";
import { defaultProfile, validateProfile, type Profile } from "../../src/profile.js";
import { FixtureAvailabilityProvider, SchedulerAvailabilityProvider } from "../../src/providers/availability.js";
import { MAX_DAYS_PER_QUERY, NeedleNineError, NeedleNineProvider } from "../../src/providers/needlenine/provider.js";
import type { SchedulerSession } from "../../src/providers/needlenine/portal-session.js";
import { PortalError } from "../../src/providers/needlenine/portal-session.js";
import { Secret } from "../../src/providers/needlenine/credentials.js";
import {
  projectRosterRecords,
  projectScheduleRecords,
  type PortalIdentity,
  type PortalRosterRecord,
  type PortalScheduleRecord,
} from "../../src/providers/needlenine/site.js";
import { zonedDateTimeToUtcMs } from "../../src/providers/needlenine/time.js";
import { makeWindow } from "../../src/types.js";
import { rawAppointment, rawRosterRow, stamp, TZ } from "./fixtures.js";

const PASSWORD = "pw-Zx9!secret-value";
const OWN_USER = 90099;

class FakeSession implements SchedulerSession {
  fetched: string[] = [];
  disposed = false;
  rosterCalls = 0;
  constructor(
    private readonly rosterRecords: PortalRosterRecord[],
    private readonly days: Map<string, PortalScheduleRecord[]>,
    private readonly ident: PortalIdentity | null = { userId: OWN_USER },
  ) {}

  async fetchScheduleDay(date: string): Promise<PortalScheduleRecord[]> {
    this.fetched.push(date);
    return this.days.get(date) ?? [];
  }
  async roster(): Promise<PortalRosterRecord[]> {
    this.rosterCalls += 1;
    return this.rosterRecords;
  }
  identity(): PortalIdentity | null {
    return this.ident;
  }
  isAlive(): boolean {
    return !this.disposed;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function schedulerProfile(): Profile {
  return validateProfile({
    ...defaultProfile(),
    aircraft: [
      { tail: "N11111", type: "C172", checkedOut: true, cruiseKtas: 110, fuelBurnGph: 9, usableFuelGal: 53 },
      { tail: "N22222", type: "C172", checkedOut: true, cruiseKtas: 110, fuelBurnGph: 9, usableFuelGal: 53 },
      { tail: "N678SP", type: "C172S", checkedOut: false, cruiseKtas: 115, fuelBurnGph: 9.5, usableFuelGal: 53 },
    ],
    scheduler: { provider: "needlenine", email: "pilot@example.com", timezone: TZ },
  });
}

const roster = projectRosterRecords([
  rawRosterRow({ FI_ID: 101, FI_TAIL_NUMBER: "N11111 (RFS101)" }),
  rawRosterRow({ FI_ID: 202, FI_TAIL_NUMBER: "N22222 (RFS202)" }),
]);

function newProvider(opts: {
  profile?: Profile;
  session?: FakeSession;
  open?: () => Promise<SchedulerSession>;
  now?: number;
}) {
  const session = opts.session ?? new FakeSession(roster, new Map());
  const openSession = vi.fn(opts.open ?? (async () => session));
  const resolveCredentials = vi.fn(async () => ({
    email: "pilot@example.com",
    password: new Secret(PASSWORD),
    source: "keychain" as const,
  }));
  const provider = new NeedleNineProvider({
    loadProfile: async () => opts.profile ?? schedulerProfile(),
    resolveCredentials,
    openSession,
    ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
    env: {},
  });
  return { provider, session, openSession, resolveCredentials };
}

const day = "2026-07-24";
const at = (d: string, hm: string): number => zonedDateTimeToUtcMs(d, hm, TZ);

describe("NeedleNineProvider (fake session)", () => {
  it("computes availability for the profile's checked-out tails", async () => {
    const days = new Map([
      [
        day,
        projectScheduleRecords([
          rawAppointment({ IA_ID: 1, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00") }),
        ]),
      ],
    ]);
    const { provider, session, openSession, resolveCredentials } = newProvider({
      session: new FakeSession(roster, days),
      now: at(day, "07:00"),
    });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "13:00")));
    const result = await provider.getAircraftAvailability(window);

    expect(openSession).toHaveBeenCalledOnce();
    expect(resolveCredentials).toHaveBeenCalledOnce();
    // One lookback day is fetched so overnight blocks from the previous local day are visible.
    expect(session.fetched).toEqual(["2026-07-23", day]);
    expect(result.source).toBe("needlenine");
    expect(result.availableTails).toEqual(["N22222"]);
    expect(result.tails?.map((t) => [t.tail, t.status])).toEqual([
      ["N11111", "partially-available"],
      ["N22222", "available"],
    ]);
    expect(result.notes.join(" ")).toMatch(/read-only/);
    expect(result.notes.join(" ")).toMatch(/pilot@example.com/);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);

    // Session reused on the next call (no relaunch, no re-resolve of credentials).
    await provider.getAircraftAvailability(window);
    expect(openSession).toHaveBeenCalledOnce();
    expect(resolveCredentials).toHaveBeenCalledOnce();
  });

  it("fetches every tenant-local day a window spans, in order", async () => {
    const { provider, session } = newProvider({});
    const window = makeWindow(new Date(at(day, "22:00")), new Date(at("2026-07-26", "01:00")));
    await provider.getAircraftAvailability(window);
    expect(session.fetched).toEqual(["2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"]);
  });

  it("returns a note (and never opens a browser) when no tails are checked out", async () => {
    const profile = validateProfile({ ...schedulerProfile(), aircraft: [] });
    const { provider, openSession } = newProvider({ profile });
    const result = await provider.getAircraftAvailability(makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00"))));
    expect(result.tails).toEqual([]);
    expect(result.notes[0]).toMatch(/checked-out/);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("rejects windows longer than the day cap without touching the portal", async () => {
    const { provider, openSession } = newProvider({});
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at("2026-08-30", "09:00")));
    await expect(provider.getAircraftAvailability(window)).rejects.toThrow(new RegExp(`${MAX_DAYS_PER_QUERY} days`));
    expect(openSession).not.toHaveBeenCalled();
  });

  it("reports not-configured profiles with a pointer to setup", async () => {
    const { provider, openSession } = newProvider({ profile: defaultProfile() });
    await expect(provider.getAircraftAvailability(makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00"))))).rejects.toThrow(
      /not configured.*get_scheduler_status/,
    );
    expect(openSession).not.toHaveBeenCalled();
  });

  it("turns portal errors into one-line messages with hints, and always scrubs the password", async () => {
    const open = async (): Promise<SchedulerSession> => {
      throw new PortalError("login-failed", `NeedleNine rejected the login (typed ${PASSWORD})`, "Update the stored password.");
    };
    const { provider } = newProvider({ open });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    const err = await provider.getAircraftAvailability(window).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(NeedleNineError);
    expect(err?.message).toMatch(/rejected the login/);
    expect(err?.message).toMatch(/Update the stored password/);
    expect(err?.message).not.toContain(PASSWORD);
    expect(err?.message).toContain("[redacted]");
    expect(err?.stack).not.toContain(PASSWORD);
  });

  it("wraps unexpected session failures without leaking internals", async () => {
    const session = new FakeSession(roster, new Map());
    session.fetchScheduleDay = async () => {
      throw new Error(`socket hang up while sending ${PASSWORD}\n    at Something.internal (node:internal)`);
    };
    const { provider } = newProvider({ session });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    await expect(provider.getAircraftAvailability(window)).rejects.toThrow(
      /^NeedleNine availability lookup failed: socket hang up while sending \[redacted\]$/,
    );
  });

  it("sees an overnight block that started the previous local day", async () => {
    const prev = "2026-07-23";
    const days = new Map([
      [
        prev,
        projectScheduleRecords([
          // Maintenance 22:00 (prev day) -> 10:00 (query day), tenant-local; lives in prev day's payload.
          rawAppointment({
            IA_ID: 7,
            IA_AIRCRAFT_ID: 101,
            IA_START_TIME: stamp(prev, "22:00"),
            IA_END_TIME: stamp(day, "10:00"),
            IA_FLIGHT_TYPE: 3,
          }),
        ]),
      ],
    ]);
    const { provider } = newProvider({ session: new FakeSession(roster, days), now: at(day, "07:00") });
    const window = makeWindow(new Date(at(day, "08:00")), new Date(at(day, "12:00")));
    const result = await provider.getAircraftAvailability(window);
    const n11111 = result.tails?.find((t) => t.tail === "N11111");
    expect(n11111?.status).toBe("partially-available");
    expect(n11111?.blocks.map((b) => b.kind)).toEqual(["maintenance"]);
    expect(n11111?.free.map((f) => [f.startLocal, f.endLocal])).toEqual([[`${day} 10:00`, `${day} 12:00`]]);
  });

  it("a config change while a session is opening never serves the old account", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = new FakeSession(roster, new Map());
    const second = new FakeSession(roster, new Map());
    const open = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstGate; // slow login for config A
        return first;
      })
      .mockResolvedValueOnce(second);

    const profileA = schedulerProfile();
    const profileB = validateProfile({
      ...schedulerProfile(),
      scheduler: { provider: "needlenine", email: "other@example.com", timezone: TZ },
    });
    let profile = profileA;
    const provider = new NeedleNineProvider({
      loadProfile: async () => profile,
      resolveCredentials: async () => ({ email: "x", password: new Secret(PASSWORD), source: "env" as const }),
      openSession: open,
      env: {},
    });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));

    const callA = provider.getAircraftAvailability(window).then(
      (r) => ({ ok: r }),
      (e: unknown) => ({ err: e as Error }),
    );
    await Promise.resolve(); // let call A reach its (gated) open
    profile = profileB; // "update_profile" switches accounts mid-login
    const callB = provider.getAircraftAvailability(window);
    releaseFirst();

    const resultB = await callB;
    expect(resultB.source).toBe("needlenine"); // B used the session opened for B's config
    expect(open).toHaveBeenCalledTimes(2);
    const outcomeA = await callA;
    // A must NOT have silently used the wrong session: it either failed with a
    // retryable error or (if it won the race before the switch) succeeded on its own session.
    if ("err" in outcomeA) expect(outcomeA.err.message).toMatch(/closed while opening|try again/);
    // The abandoned first session is closed, not orphaned.
    await new Promise((r) => setTimeout(r, 0));
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    await provider.dispose();
    expect(second.disposed).toBe(true);
  });

  it("dispose during an in-flight open closes the session it produces", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const session = new FakeSession(roster, new Map());
    const open = vi.fn().mockImplementation(async () => {
      await gate;
      return session;
    });
    const { provider } = newProvider({ open: () => open() });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    const call = provider.getAircraftAvailability(window).catch((e: unknown) => e as Error);
    await Promise.resolve();
    const disposed = provider.dispose();
    release();
    await disposed;
    expect(session.disposed).toBe(true); // no orphaned browser
    const outcome = await call;
    expect(outcome).toBeInstanceOf(NeedleNineError);
  });

  it("recreates the session after dispose or when it dies", async () => {
    const first = new FakeSession(roster, new Map());
    const second = new FakeSession(roster, new Map());
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { provider } = newProvider({ open });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    await provider.getAircraftAvailability(window);
    await provider.dispose();
    expect(first.disposed).toBe(true);
    await provider.getAircraftAvailability(window);
    expect(open).toHaveBeenCalledTimes(2);
    // A dead session (browser crashed) is replaced on the next call.
    second.disposed = true;
    const third = new FakeSession(roster, new Map());
    open.mockResolvedValueOnce(third);
    await provider.getAircraftAvailability(window);
    expect(open).toHaveBeenCalledTimes(3);
    await provider.dispose();
    await provider.dispose(); // idempotent
  });
});

describe("SchedulerAvailabilityProvider (delegating)", () => {
  it("falls back to fixture data with a setup note when nothing is configured", async () => {
    const fixture = new FixtureAvailabilityProvider({ N678SP: [], N12345: [] });
    const provider = new SchedulerAvailabilityProvider({
      loadProfile: async () => defaultProfile(),
      env: {},
      fixture,
    });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    const result = await provider.getAircraftAvailability(window);
    expect(result.source).toBe("fixture-availability");
    expect(result.availableTails).toEqual(["N12345", "N678SP"]);
    expect(result.notes.join(" ")).toMatch(/No flight-school scheduler is configured/);
    expect(result.notes.join(" ")).toMatch(/security add-generic-password/);
    await provider.dispose(); // no session was ever opened; must not throw
  });

  it("delegates to the NeedleNine provider when configured", async () => {
    const session = new FakeSession(roster, new Map());
    const needlenine = new NeedleNineProvider({
      loadProfile: async () => schedulerProfile(),
      resolveCredentials: async () => ({ email: "pilot@example.com", password: new Secret(PASSWORD), source: "env" }),
      openSession: async () => session,
      env: {},
    });
    const provider = new SchedulerAvailabilityProvider({
      loadProfile: async () => schedulerProfile(),
      env: {},
      needlenine,
    });
    const window = makeWindow(new Date(at(day, "09:00")), new Date(at(day, "10:00")));
    const result = await provider.getAircraftAvailability(window);
    expect(result.source).toBe("needlenine");
    expect(result.availableTails).toEqual(["N11111", "N22222"]);
    expect(session.fetched).toEqual(["2026-07-23", day]);
    await provider.dispose();
    expect(session.disposed).toBe(true);
  });
});
