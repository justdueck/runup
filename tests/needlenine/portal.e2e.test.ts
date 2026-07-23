/**
 * End-to-end: the real PortalSession (headless chromium) + NeedleNineProvider
 * against the local mock portal. Never touches the live site. Skips with a
 * clear warning only when no chromium binary can be launched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProfile, defaultProfile, type Profile } from "../../src/profile.js";
import { ENV_PASSWORD, Secret } from "../../src/providers/needlenine/credentials.js";
import { PortalError, PortalSession } from "../../src/providers/needlenine/portal-session.js";
import { NeedleNineError, NeedleNineProvider } from "../../src/providers/needlenine/provider.js";
import { addDaysToDate, localDateOf, zonedDateTimeToUtcMs } from "../../src/providers/needlenine/time.js";
import { makeWindow } from "../../src/types.js";
import { startMockPortal, type MockPortal } from "../mock-portal/server.js";
import { PII, rawAppointment, rawRosterRow, stamp, TZ } from "./fixtures.js";

const EMAIL = "pilot.e2e@example.com";
const PASSWORD = "correct-horse-Battery9!";
const WRONG_PASSWORD = "definitely-not-the-password-Zx7";

async function probeChromium(): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
}

const skipReason = await probeChromium();
if (skipReason) {
  // Prominent, actionable skip note (never a silent pass).
  console.warn(
    `[needlenine e2e] SKIPPED — chromium is not launchable in this environment (${skipReason}). ` +
      "Install it with `npx playwright install chromium` or set RUNUP_CHROMIUM_PATH to run this suite.",
  );
}
const suite = skipReason ? describe.skip : describe;

// Tenant-local calendar days relative to now (the mock schedule page derives "today" the same way).
const today = localDateOf(Date.now(), TZ);
const tomorrow = addDaysToDate(today, 1);
const at = (date: string, hhmm: string): number => zonedDateTimeToUtcMs(date, hhmm, TZ);

const roster = [
  rawRosterRow({ FI_ID: 101, FI_TAIL_NUMBER: "N11111 (RFS101)" }),
  rawRosterRow({ FI_ID: 202, FI_TAIL_NUMBER: "N22222 (RFS202)" }),
  rawRosterRow({
    FI_ID: 303,
    FI_TAIL_NUMBER: "N33333 (RFS303)",
    maintenance: [{ MAI_ID: 7, MAI_NAME: "100 Hour", MAI_EXPIRATION_DATE: null, MAI_HOURS_REMAINING: -3.2, MAI_REQ_FOR_DISPATCH: 1 }],
    opendiscrepancies: [
      { DIS_ID: 9, DIS_TYPE: "2", DIS_DESCRIPTION: `Landing light inop ${PII.squawkNote}`, DIS_RESTRICTIONS: "DAY ONLY", DIS_STATUS: 1 },
    ],
  }),
  rawRosterRow({ FI_ID: 404, FI_TAIL_NUMBER: "Frasca - 40404", FI_GROP: 9 }),
  rawRosterRow({ FI_ID: 505, FI_TAIL_NUMBER: "N55555 (RFS505)" }),
  rawRosterRow({ FI_ID: 606, FI_TAIL_NUMBER: "N66666 (RFS606)" }),
];

const schedules: Record<string, unknown[]> = {
  [today]: [
    rawAppointment({ IA_ID: 4001, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(today, "15:00"), IA_END_TIME: stamp(today, "17:00") }),
  ],
  [tomorrow]: [
    rawAppointment({ IA_ID: 5001, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(tomorrow, "10:00"), IA_END_TIME: stamp(tomorrow, "12:00") }),
    rawAppointment({ IA_ID: 5002, IA_AIRCRAFT_ID: 202, IA_USER_ID: 90099, IA_START_TIME: stamp(tomorrow, "11:30"), IA_END_TIME: stamp(tomorrow, "14:00") }),
    rawAppointment({
      IA_ID: 5003,
      IA_AIRCRAFT_ID: 303,
      IA_FLIGHT_TYPE: 3,
      IA_APPOINTMENT_STATUS: 5,
      IA_START_TIME: stamp(tomorrow, "06:00"),
      IA_END_TIME: stamp(tomorrow, "18:00"),
      user: null,
      instructor: null,
    }),
    // Cancelled booking must not block N66666.
    rawAppointment({
      IA_ID: 5004,
      IA_AIRCRAFT_ID: 606,
      IA_APPOINTMENT_STATUS: 2,
      IA_DELETE_APPOINTMENT_REASON: "student sick",
      IA_START_TIME: stamp(tomorrow, "09:00"),
      IA_END_TIME: stamp(tomorrow, "12:00"),
    }),
    // Stray record days away (data anomaly).
    rawAppointment({ IA_ID: 5005, IA_AIRCRAFT_ID: 606, IA_START_TIME: stamp(addDaysToDate(tomorrow, 10), "10:00"), IA_END_TIME: stamp(addDaysToDate(tomorrow, 10), "12:00") }),
    // Aircraft the pilot is not checked out in.
    rawAppointment({ IA_ID: 5006, IA_AIRCRAFT_ID: 505, IA_START_TIME: stamp(tomorrow, "09:00"), IA_END_TIME: stamp(tomorrow, "12:00") }),
  ],
};

function e2eProfile(portalUrl: string): Profile {
  return validateProfile({
    ...defaultProfile(),
    aircraft: ["N11111", "N22222", "N33333", "N44444", "N66666"].map((tail) => ({
      tail,
      type: "C172",
      checkedOut: true,
      cruiseKtas: 110,
      fuelBurnGph: 9,
      usableFuelGal: 53,
    })).concat([{ tail: "N678SP", type: "C172S", checkedOut: false, cruiseKtas: 115, fuelBurnGph: 9.5, usableFuelGal: 53 }]),
    scheduler: { provider: "needlenine", email: EMAIL, portalUrl, timezone: TZ },
  });
}

suite("NeedleNine portal automation against the local mock portal", { timeout: 90_000 }, () => {
  let mock: MockPortal;
  let provider: NeedleNineProvider;
  const logs: string[] = [];

  beforeAll(async () => {
    mock = await startMockPortal({ email: EMAIL, password: PASSWORD, roster, schedules, timezone: TZ });
    provider = new NeedleNineProvider({
      loadProfile: async () => e2eProfile(mock.url),
      env: { [ENV_PASSWORD]: PASSWORD },
      platform: "linux", // never touch a real macOS keychain from tests
      logger: (line) => logs.push(line),
    });
  }, 60_000);

  afterAll(async () => {
    await provider?.dispose();
    await mock?.close();
  }, 30_000);

  it("logs in, drives the schedule to the day, and computes per-tail availability from captured data", async () => {
    const window = makeWindow(new Date(at(tomorrow, "09:00")), new Date(at(tomorrow, "12:00")));
    const result = await provider.getAircraftAvailability(window);

    expect(result.source).toBe("needlenine");
    expect(result.availableTails).toEqual(["N66666"]);
    const byTail = Object.fromEntries((result.tails ?? []).map((t) => [t.tail, t]));
    expect(byTail.N11111.status).toBe("partially-available");
    expect(byTail.N11111.blocks.map((b) => [b.startLocal, b.endLocal, b.kind])).toEqual([
      [`${tomorrow} 10:00`, `${tomorrow} 12:00`, "reservation"],
    ]);
    expect(byTail.N11111.free.map((f) => f.durationHours)).toEqual([1]);
    expect(byTail.N22222.status).toBe("partially-available");
    expect(byTail.N22222.blocks[0].kind).toBe("own-reservation"); // identity captured from user/info
    expect(byTail.N33333.status).toBe("unavailable");
    expect(byTail.N33333.flags.join(" | ")).toMatch(/maintenance overdue.*100 Hour/);
    expect(byTail.N33333.blocks[0]).toMatchObject({ kind: "maintenance" });
    expect(byTail.N44444.status).toBe("not-on-roster");
    expect(byTail.N66666.status).toBe("available"); // cancelled booking + far stray both ignored

    // Privacy: nothing about other members, the squawk text, or the password reaches the output.
    const text = JSON.stringify(result);
    for (const secret of [PASSWORD, ...Object.values(PII)]) expect(text).not.toContain(secret);
    expect(text).not.toContain("student sick");

    // The automation read the schedule for the target day.
    const scheduleRequests = mock.requests.filter((r) => r.path.startsWith("/api/schedule?"));
    expect(scheduleRequests.some((r) => r.path.includes(`scheduledate=${tomorrow}`))).toBe(true);
    // Diagnostic log lines carry no secrets either.
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("spans multiple local days, steps the calendar back, and reuses cached days", async () => {
    const before = mock.requests.filter((r) => r.path.startsWith("/api/schedule?")).length;
    // Today 20:00 -> tomorrow 08:00 local: today came from the initial page load, tomorrow from the last query.
    const window = makeWindow(new Date(at(today, "20:00")), new Date(at(tomorrow, "08:00")));
    const result = await provider.getAircraftAvailability(window);
    expect(result.availableTails).toEqual(["N11111", "N22222", "N66666"]);
    const n3 = result.tails!.find((t) => t.tail === "N33333")!;
    expect(n3.status).toBe("unavailable"); // grounded + MX block overlaps 06:00-08:00 tomorrow
    expect(n3.blocks.map((b) => b.kind)).toEqual(["maintenance"]);
    // No new schedule fetches were needed (both days cached in-session).
    const after = mock.requests.filter((r) => r.path.startsWith("/api/schedule?")).length;
    expect(after).toBe(before);
  });

  it("reads a day with no bookings (tiny encrypted body) as an empty day", async () => {
    const quietDay = addDaysToDate(tomorrow, 2);
    const window = makeWindow(new Date(at(quietDay, "09:00")), new Date(at(quietDay, "11:00")));
    const result = await provider.getAircraftAvailability(window);
    expect(result.availableTails).toEqual(["N11111", "N22222", "N66666"]);
    const requested = mock.requests.some((r) => r.path.startsWith("/api/schedule?") && r.path.includes(`scheduledate=${quietDay}`));
    expect(requested).toBe(true);
  });

  it("never touches booking, check-in, or cancel controls (read-only automation)", () => {
    expect(mock.mutations).toEqual([]);
    const forbidden = mock.requests.filter((r) => /deleteappointment|checkin|creation/i.test(r.path));
    expect(forbidden).toEqual([]);
    expect(mock.requests.filter((r) => r.path === "/api/schedule" && r.method !== "GET")).toEqual([]);
  });

  it("reports a rejected login as a friendly one-liner without echoing the password", async () => {
    const bad = new NeedleNineProvider({
      loadProfile: async () => e2eProfile(mock.url),
      env: { [ENV_PASSWORD]: WRONG_PASSWORD },
      platform: "linux",
    });
    try {
      const window = makeWindow(new Date(at(tomorrow, "09:00")), new Date(at(tomorrow, "10:00")));
      const err = await bad.getAircraftAvailability(window).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(NeedleNineError);
      expect(err?.message).toMatch(/rejected the login/i);
      expect(err?.message).toMatch(new RegExp(ENV_PASSWORD)); // hint names the env fallback (login came from env)
      expect(err?.message).not.toContain(WRONG_PASSWORD);
      expect(err?.stack ?? "").not.toContain(WRONG_PASSWORD);
    } finally {
      await bad.dispose();
    }
  });

  it("closes the browser on dispose and refuses further use", async () => {
    const session = await PortalSession.open(
      { portalUrl: mock.url, timezone: TZ, dayCacheTtlMs: 1 },
      { email: EMAIL, password: new Secret(PASSWORD), source: "env" },
    );
    expect(session.isAlive()).toBe(true);
    const records = await session.fetchScheduleDay(today);
    expect(records.length).toBeGreaterThan(0);
    expect((await session.roster()).map((r) => r.id)).toContain(101);
    expect(session.identity()).toEqual({ userId: 90099 });

    // Expired cache while the calendar already shows this day: must re-fetch (reload), not fail.
    const countToday = (): number =>
      mock.requests.filter((r) => r.path.startsWith("/api/schedule?") && r.path.includes(`scheduledate=${today}`)).length;
    const before = countToday();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refetched = await session.fetchScheduleDay(today);
    expect(refetched.length).toBe(records.length);
    expect(countToday()).toBeGreaterThan(before);

    await session.dispose();
    expect(session.isAlive()).toBe(false);
    await session.dispose(); // idempotent
    await expect(session.fetchScheduleDay(today)).rejects.toBeInstanceOf(PortalError);
  });
});
