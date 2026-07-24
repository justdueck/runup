import { describe, expect, it } from "vitest";
import { assessDaylight, sunTimesForAirport, tagWindowsWithDaylight } from "../src/daylight.js";
import { findAirport } from "../src/data/airports.js";
import { formatLocalHm } from "../src/tz.js";
import { makeWindow } from "../src/types.js";

const TZ = "America/Los_Angeles";
const KPAE = findAirport("KPAE")!;

/** Minutes since local midnight of an ISO timestamp, in America/Los_Angeles. */
function localMinutes(iso: string | null): number {
  expect(iso).not.toBeNull();
  const hm = formatLocalHm(new Date(iso!), TZ);
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

describe("sun times (suncalc) at KPAE", () => {
  it("puts sunrise ~05:20-06:10 and sunset ~20:35-21:15 local on 2026-07-23 (tolerant band)", () => {
    const t = sunTimesForAirport(KPAE, new Date("2026-07-23T20:00:00Z"), TZ); // any instant on that LA day
    expect(t.airport).toBe("KPAE");
    expect(t.date).toBe("2026-07-23");
    expect(localMinutes(t.sunrise)).toBeGreaterThanOrEqual(5 * 60 + 20);
    expect(localMinutes(t.sunrise)).toBeLessThanOrEqual(6 * 60 + 10);
    expect(localMinutes(t.sunset)).toBeGreaterThanOrEqual(20 * 60 + 35);
    expect(localMinutes(t.sunset)).toBeLessThanOrEqual(21 * 60 + 15);
    // Civil dawn precedes sunrise; civil dusk follows sunset.
    expect(localMinutes(t.civilDawn)).toBeLessThan(localMinutes(t.sunrise));
    expect(localMinutes(t.civilDusk)).toBeGreaterThan(localMinutes(t.sunset));
    // Offsets are rendered in the profile zone (PDT).
    expect(t.sunrise!.endsWith("-07:00")).toBe(true);
  });
});

describe("daylight tagging", () => {
  it("tags midday day, deep night night, and a sunset-straddling window mixed", () => {
    const midday = { start: "2026-07-23T12:00:00-07:00", end: "2026-07-23T15:00:00-07:00" };
    expect(assessDaylight(midday, ["KPAE", "KTIW"], TZ).daylight).toBe("day");

    const lateNight = { start: "2026-07-23T23:00:00-07:00", end: "2026-07-23T23:45:00-07:00" };
    expect(assessDaylight(lateNight, ["KPAE"], TZ).daylight).toBe("night");

    // 19:30-21:30 local crosses sunset (~20:5x) and civil dusk (~21:3x) -> mixed.
    const evening = { start: "2026-07-23T19:30:00-07:00", end: "2026-07-23T21:30:00-07:00" };
    expect(assessDaylight(evening, ["KPAE", "KTIW"], TZ).daylight).toBe("mixed");
  });

  it("returns per-airport sun times and notes an unresolvable home airport", () => {
    const assessment = assessDaylight(
      { start: "2026-07-23T12:00:00-07:00", end: "2026-07-23T15:00:00-07:00" },
      ["KPAE", "ZZZZ"],
      TZ,
    );
    expect(assessment.sun.map((s) => s.airport)).toEqual(["KPAE"]);
    expect(assessment.notes.join(" ")).toMatch(/ZZZZ/);
    expect(assessment.daylight).toBe("day");

    const none = assessDaylight({ start: "2026-07-23T19:00:00Z", end: "2026-07-23T21:00:00Z" }, ["ZZZZ"], TZ);
    expect(none.daylight).toBe("unknown");
  });

  it("annotates windows without mutating the originals", () => {
    const w = makeWindow(new Date("2026-07-23T19:00:00Z"), new Date("2026-07-23T22:00:00Z"), "midday");
    const [tagged] = tagWindowsWithDaylight([w], ["KPAE", "KTIW"], TZ);
    expect(tagged.daylight).toBe("day");
    expect(tagged.sun?.map((s) => s.airport)).toEqual(["KPAE", "KTIW"]);
    expect(tagged.durationHours).toBe(3);
    expect(w).not.toHaveProperty("daylight"); // input untouched
  });
});
