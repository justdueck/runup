import { describe, expect, it } from "vitest";
import { greatCircleNm } from "../src/geo.js";
import { NaiveRoutePlanner, PLANNING_ALLOWANCES } from "../src/providers/routes.js";
import { bundledAirports, findAirport } from "../src/data/airports.js";
import { defaultProfile } from "../src/profile.js";
import { makeWindow, type AircraftPerformance } from "../src/types.js";

const c172: AircraftPerformance = { tail: "N678SP", type: "C172S", cruiseKtas: 110, fuelBurnGph: 9, usableFuelGal: 53 };

function windowOfHours(hours: number) {
  const start = new Date(2026, 6, 25, 9, 0, 0);
  return makeWindow(start, new Date(start.getTime() + hours * 3_600_000));
}

describe("great-circle distance", () => {
  it("is roughly right for known pairs", () => {
    const kpae = findAirport("KPAE")!;
    const kbli = findAirport("KBLI")!;
    // Paine Field (Everett) to Bellingham is about 54 nm.
    expect(greatCircleNm(kpae.lat, kpae.lon, kbli.lat, kbli.lon)).toBeCloseTo(54, 0);
    expect(greatCircleNm(0, 0, 0, 1)).toBeCloseTo(60, 0); // one degree of longitude at the equator
  });
});

describe("NaiveRoutePlanner", () => {
  it("proposes fitting out-and-back candidates plus a local option per home for a 3 h window", async () => {
    const planner = new NaiveRoutePlanner();
    const profile = defaultProfile(); // KPAE + KTIW homes, 250 nm max
    const window = windowOfHours(3);
    const routes = await planner.planRoutes(window, c172, profile);

    expect(routes.length).toBeGreaterThan(1);
    // A local-practice option is appended for each home field, primary first.
    const locals = routes.filter((r) => r.kind === "local");
    expect(locals.map((l) => l.home)).toEqual(["KPAE", "KTIW"]);
    expect(routes.slice(-2)).toEqual(locals);

    const outAndBacks = routes.filter((r) => r.kind === "out-and-back");
    expect(outAndBacks.length).toBeGreaterThan(0);
    for (const r of outAndBacks) {
      expect(profile.homeAirports).toContain(r.home);
      expect(r.destination.icao).not.toBe(r.home);
      expect(r.fitsWindow).toBe(true);
      expect(r.estBlockTimeHours + PLANNING_ALLOWANCES.windowBufferHours).toBeLessThanOrEqual(3);
      expect(r.margins.fuelRemainingGal).toBeGreaterThanOrEqual(0);
      expect(r.totalDistanceNm).toBeLessThanOrEqual(profile.preferences.maxDistanceNm);
    }
    // Sorted so the longest trip that still fits comes first.
    for (let i = 1; i < outAndBacks.length; i++) {
      expect(outAndBacks[i - 1].estBlockTimeHours).toBeGreaterThanOrEqual(outAndBacks[i].estBlockTimeHours);
    }
  });

  it("plans candidates departing every home airport", async () => {
    const planner = new NaiveRoutePlanner();
    const routes = await planner.planRoutes(windowOfHours(4), c172, defaultProfile(), { maxCandidates: 40 });
    const departures = new Set(routes.filter((r) => r.kind === "out-and-back").map((r) => r.home));
    expect(departures).toEqual(new Set(["KPAE", "KTIW"]));
  });

  it("honors the profile's max distance", async () => {
    const planner = new NaiveRoutePlanner();
    const profile = { ...defaultProfile(), preferences: { ...defaultProfile().preferences, maxDistanceNm: 60 } };
    const routes = await planner.planRoutes(windowOfHours(4), c172, profile);
    for (const r of routes.filter((x) => x.kind === "out-and-back")) {
      expect(r.totalDistanceNm).toBeLessThanOrEqual(60);
    }
  });

  it("explains why nothing fits a very short window instead of returning nothing", async () => {
    const planner = new NaiveRoutePlanner();
    const routes = await planner.planRoutes(windowOfHours(0.75), c172, defaultProfile());
    const outAndBacks = routes.filter((r) => r.kind === "out-and-back");
    expect(outAndBacks.length).toBeGreaterThan(0);
    for (const r of outAndBacks) {
      expect(r.fitsWindow).toBe(false);
      expect(r.notes.join(" ")).toMatch(/window is 0.75 h/);
    }
  });

  it("falls back to a local flight when the home airport is unknown to the sample data", async () => {
    const planner = new NaiveRoutePlanner();
    const profile = { ...defaultProfile(), homeAirports: ["KZZZ"] };
    const routes = await planner.planRoutes(windowOfHours(2), c172, profile);
    expect(routes).toHaveLength(1);
    expect(routes[0].kind).toBe("local");
    expect(routes[0].notes.join(" ")).toMatch(/not in the bundled airports sample/);
  });

  it("still plans from known homes and flags an unknown one", async () => {
    const planner = new NaiveRoutePlanner();
    const profile = { ...defaultProfile(), homeAirports: ["KPAE", "KZZZ"] };
    const routes = await planner.planRoutes(windowOfHours(3), c172, profile);
    expect(routes.filter((r) => r.kind === "out-and-back").length).toBeGreaterThan(0);
    const unknownLocal = routes.find((r) => r.kind === "local" && r.home === "KZZZ");
    expect(unknownLocal?.notes.join(" ")).toMatch(/not in the bundled airports sample/);
  });

  it("ships a small but non-trivial Puget Sound airport sample", () => {
    expect(bundledAirports.length).toBeGreaterThanOrEqual(15);
    expect(findAirport("kpae")?.name).toMatch(/Paine Field/);
    expect(findAirport("s43")?.name).toMatch(/Harvey/);
  });
});
