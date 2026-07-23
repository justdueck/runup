import { describe, expect, it } from "vitest";
import { dateSpan, dayRange, GENERIC_AIRCRAFT, planDay, resolveAircraftPerformance } from "../src/planning.js";
import { defaultProfile, type Profile } from "../src/profile.js";
import { FixtureCalendarProvider } from "../src/providers/calendar.js";
import { FixtureAvailabilityProvider } from "../src/providers/availability.js";
import { NaiveRoutePlanner } from "../src/providers/routes.js";
import { makeWindow } from "../src/types.js";
import { fixtureWeatherClient } from "./helpers.js";

function profileWithAircraft(): Profile {
  return {
    ...defaultProfile(),
    aircraft: [
      { tail: "N12345", type: "C172N", checkedOut: false, cruiseKtas: 108, fuelBurnGph: 8.5, usableFuelGal: 40 },
      { tail: "N678SP", type: "C172S", checkedOut: true, cruiseKtas: 115, fuelBurnGph: 9.5, usableFuelGal: 53 },
    ],
  };
}

describe("resolveAircraftPerformance", () => {
  const profile = profileWithAircraft();

  it("prefers an explicit tail and warns when it is not checked out", () => {
    const r = resolveAircraftPerformance(profile, { tail: "n12345" });
    expect(r.aircraft.tail).toBe("N12345");
    expect(r.notes.join(" ")).toMatch(/not marked checked-out/);
  });

  it("falls back to generic numbers for an unknown tail", () => {
    const r = resolveAircraftPerformance(profile, { tail: "N999ZZ" });
    expect(r.aircraft.type).toBe(GENERIC_AIRCRAFT.type);
    expect(r.aircraft.tail).toBe("N999ZZ");
  });

  it("intersects availability with checked-out aircraft", () => {
    const r = resolveAircraftPerformance(profile, { availableTails: ["N12345", "N678SP"] });
    expect(r.aircraft.tail).toBe("N678SP");
    const none = resolveAircraftPerformance(profile, { availableTails: ["N12345"] });
    expect(none.notes.join(" ")).toMatch(/None of your checked-out aircraft appear available/);
  });

  it("uses generic performance when the profile has no checked-out aircraft", () => {
    const r = resolveAircraftPerformance(defaultProfile(), {});
    expect(r.aircraft).toEqual(GENERIC_AIRCRAFT);
  });
});

describe("planDay", () => {
  it("composes windows, availability, conditions and routes", async () => {
    const date = "2026-07-25";
    const morning = makeWindow(new Date(2026, 6, 25, 9, 0), new Date(2026, 6, 25, 12, 30), "morning");
    const evening = makeWindow(new Date(2026, 6, 25, 17, 0), new Date(2026, 6, 25, 18, 0), "evening (short)");
    const { client } = fixtureWeatherClient();

    const plan = await planDay(
      { date, runwayHeadingDeg: 340 },
      {
        profile: profileWithAircraft(),
        providers: {
          calendar: new FixtureCalendarProvider([morning, evening]),
          availability: new FixtureAvailabilityProvider({
            N678SP: [],
            N12345: [{ start: morning.start, end: morning.end }],
          }),
          routes: new NaiveRoutePlanner(),
        },
        weather: client,
      },
    );

    expect(plan.homeAirports).toEqual(["KPAE", "KTIW"]);
    expect(plan.timeOfDay).toBe("day");
    // Conditions are scored at EVERY home airport, in profile order.
    expect(plan.conditions.map((c) => c.airport)).toEqual(["KPAE", "KTIW"]);
    const kpae = plan.conditions.find((c) => c.airport === "KPAE")!;
    const ktiw = plan.conditions.find((c) => c.airport === "KTIW")!;
    expect(kpae.summary?.station).toBe("KPAE");
    expect(kpae.score?.verdict).toBe("go");
    // Tacoma Narrows: BKN015 marine stratus is below the 3000 ft day ceiling minimum.
    expect(ktiw.summary?.station).toBe("KTIW");
    expect(ktiw.score?.verdict).toBe("no-go");
    // Only the morning window survives the default 1.5 h minimum.
    expect(plan.windows).toHaveLength(1);
    const w = plan.windows[0];
    expect(w.window.label).toBe("morning");
    expect(w.availability?.availableTails).toEqual(["N678SP"]);
    expect(w.aircraft.tail).toBe("N678SP");
    expect(w.routes.length).toBeGreaterThan(1);
    // The below-minimums home field is called out on the window.
    expect(w.notes.join(" ")).toMatch(/below personal minimums at KTIW/);
    expect(plan.notes.join(" ")).toMatch(/CURRENT METAR/);
  });

  it("validates the date format", () => {
    expect(() => dayRange("2026/07/25")).toThrow(/YYYY-MM-DD/);
    const r = dayRange("2026-07-25");
    expect(Date.parse(r.end) - Date.parse(r.start)).toBe(24 * 3_600_000);
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(() => dayRange("2026-02-30")).toThrow(/real calendar date/); // no Feb 30
    expect(() => dayRange("2026-04-31")).toThrow(/real calendar date/); // April has 30 days
    expect(() => dayRange("2026-13-01")).toThrow(/real calendar date/); // no month 13
    expect(() => dayRange("2026-00-10")).toThrow(/real calendar date/); // no month 0
    expect(() => dayRange("2026-02-29")).toThrow(/real calendar date/); // 2026 is not a leap year
    expect(() => dayRange("2028-02-29")).not.toThrow(); // 2028 is
    expect(() => dateSpan("2026-07-25", "2026-06-31")).toThrow(/real calendar date/); // end date checked too
  });
});
