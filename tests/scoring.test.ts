import { describe, expect, it } from "vitest";
import { scoreConditions, type LimitCheck, type ScorableConditions } from "../src/scoring.js";
import { defaultProfile, type PersonalMinimums } from "../src/profile.js";

const mins: PersonalMinimums = defaultProfile().minimums;
// day:   ceiling 3000, vis 5, wind 20, gustSpread 10, crosswind 8
// night: ceiling 5000, vis 7, wind 15, gustSpread 8,  crosswind 6

function conditions(overrides: Partial<{
  ceilingFt: number | null;
  ceilingReported: boolean;
  visSm: number | null;
  greaterThan: boolean;
  windKt: number;
  gustSpreadKt: number;
  runwayHeadingDeg: number | null;
  crosswindKt: number | null;
}> = {}): ScorableConditions {
  const o = {
    ceilingFt: null,
    ceilingReported: true,
    visSm: 10,
    greaterThan: true,
    windKt: 8,
    gustSpreadKt: 0,
    runwayHeadingDeg: null,
    crosswindKt: null,
    ...overrides,
  };
  return {
    wind: { speedKt: o.windKt, gustSpreadKt: o.gustSpreadKt },
    visibility: { sm: o.visSm, greaterThan: o.greaterThan },
    ceiling: { ft: o.ceilingFt, reported: o.ceilingReported },
    crosswind: { runwayHeadingDeg: o.runwayHeadingDeg, crosswindKt: o.crosswindKt },
  };
}

const byLimit = (checks: LimitCheck[], id: LimitCheck["limit"]): LimitCheck =>
  checks.find((c) => c.limit === id) as LimitCheck;

describe("scoreConditions", () => {
  it("calls a benign VFR day a go and reports the tightest margin", () => {
    const result = scoreConditions(conditions({ ceilingFt: 6000, visSm: 10, windKt: 8, gustSpreadKt: 0 }), mins);
    expect(result.verdict).toBe("go");
    expect(result.timeOfDay).toBe("day");
    expect(result.checks).toHaveLength(5);
    expect(byLimit(result.checks, "ceilingFt")).toMatchObject({ status: "pass", margin: 3000 });
    expect(byLimit(result.checks, "visSm")).toMatchObject({ status: "pass", margin: 5 });
    expect(byLimit(result.checks, "windKt")).toMatchObject({ status: "pass", margin: 12 });
    expect(byLimit(result.checks, "crosswindKt")).toMatchObject({ status: "skipped" });
    expect(result.reasons[0]).toMatch(/^All personal minimums \(day\) pass; tightest is/);
  });

  it("passes ceiling when no ceiling is reported and sky data is present", () => {
    const result = scoreConditions(conditions({ ceilingFt: null, ceilingReported: true }), mins);
    const ceiling = byLimit(result.checks, "ceilingFt");
    expect(ceiling.status).toBe("pass");
    expect(ceiling.margin).toBeNull();
    expect(ceiling.note).toMatch(/no ceiling/);
    expect(result.verdict).toBe("go");
  });

  it("fails when ceiling is below the day minimum with a negative margin", () => {
    const result = scoreConditions(conditions({ ceilingFt: 1200 }), mins);
    expect(result.verdict).toBe("no-go");
    const ceiling = byLimit(result.checks, "ceilingFt");
    expect(ceiling).toMatchObject({ status: "fail", actual: 1200, required: 3000, margin: -1800 });
    expect(ceiling.marginRatio).toBe(-0.6);
    expect(result.reasons.join("\n")).toMatch(/Ceiling 1200 ft is below your day minimum of 3000 ft \(1800 ft short\)/);
  });

  it("fails on visibility below minimums", () => {
    const result = scoreConditions(conditions({ visSm: 3, greaterThan: false }), mins);
    expect(result.verdict).toBe("no-go");
    expect(byLimit(result.checks, "visSm")).toMatchObject({ status: "fail", margin: -2 });
  });

  it("fails on steady wind and on gust spread independently", () => {
    const windy = scoreConditions(conditions({ windKt: 24, gustSpreadKt: 4 }), mins);
    expect(byLimit(windy.checks, "windKt")).toMatchObject({ status: "fail", margin: -4 });
    expect(byLimit(windy.checks, "gustSpreadKt")).toMatchObject({ status: "pass", margin: 6 });
    expect(windy.verdict).toBe("no-go");

    const gusty = scoreConditions(conditions({ windKt: 12, gustSpreadKt: 14 }), mins);
    expect(byLimit(gusty.checks, "windKt")).toMatchObject({ status: "pass" });
    expect(byLimit(gusty.checks, "gustSpreadKt")).toMatchObject({ status: "fail", margin: -4 });
    expect(gusty.verdict).toBe("no-go");
    expect(gusty.reasons.join("\n")).toMatch(/Gust spread 14 kt is above your day minimum of 10 kt \(4 kt over\)/);
  });

  it("evaluates crosswind only when a runway heading is provided", () => {
    const skipped = scoreConditions(conditions({ runwayHeadingDeg: null, crosswindKt: null }), mins);
    expect(byLimit(skipped.checks, "crosswindKt").status).toBe("skipped");
    expect(skipped.verdict).toBe("go");
    expect(skipped.reasons.join("\n")).toMatch(/Crosswind not evaluated/);

    const ok = scoreConditions(conditions({ runwayHeadingDeg: 310, crosswindKt: 5 }), mins);
    expect(byLimit(ok.checks, "crosswindKt")).toMatchObject({ status: "pass", margin: 3, note: "runway heading 310" });

    const tooMuch = scoreConditions(conditions({ runwayHeadingDeg: 310, crosswindKt: 11.5 }), mins);
    expect(byLimit(tooMuch.checks, "crosswindKt")).toMatchObject({ status: "fail", margin: -3.5 });
    expect(tooMuch.verdict).toBe("no-go");
  });

  it("is conservative when data is missing (unknown = no-go)", () => {
    const noVis = scoreConditions(conditions({ visSm: null }), mins);
    expect(byLimit(noVis.checks, "visSm").status).toBe("unknown");
    expect(noVis.verdict).toBe("no-go");
    expect(noVis.reasons.join("\n")).toMatch(/Visibility could not be evaluated: visibility not reported \(treated as no-go\)/);

    const noSky = scoreConditions(conditions({ ceilingFt: null, ceilingReported: false }), mins);
    expect(byLimit(noSky.checks, "ceilingFt").status).toBe("unknown");
    expect(noSky.verdict).toBe("no-go");

    const noWindDir = scoreConditions(conditions({ runwayHeadingDeg: 310, crosswindKt: null }), mins);
    expect(byLimit(noWindDir.checks, "crosswindKt").status).toBe("unknown");
    expect(noWindDir.verdict).toBe("no-go");
  });

  it("uses the night block when timeOfDay is night", () => {
    // ceiling 4000: fine by day (3000) but below the 5000 ft night minimum.
    const day = scoreConditions(conditions({ ceilingFt: 4000, windKt: 12 }), mins, { timeOfDay: "day" });
    const night = scoreConditions(conditions({ ceilingFt: 4000, windKt: 12 }), mins, { timeOfDay: "night" });
    expect(day.verdict).toBe("go");
    expect(night.verdict).toBe("no-go");
    expect(byLimit(night.checks, "ceilingFt")).toMatchObject({ required: 5000, margin: -1000 });
    expect(night.timeOfDay).toBe("night");
    expect(night.reasons.join("\n")).toMatch(/night minimum of 5000 ft/);
  });

  it("treats limits met exactly as passing (margin 0)", () => {
    const result = scoreConditions(
      conditions({ ceilingFt: 3000, visSm: 5, greaterThan: false, windKt: 20, gustSpreadKt: 10, runwayHeadingDeg: 90, crosswindKt: 8 }),
      mins,
    );
    expect(result.verdict).toBe("go");
    for (const c of result.checks) {
      expect(c.status).toBe("pass");
      expect(c.margin).toBe(0);
    }
    expect(result.reasons[0]).toMatch(/0 (ft|sm|kt) to spare/);
  });

  it("reports every failing limit, not just the first", () => {
    const result = scoreConditions(
      conditions({ ceilingFt: 800, visSm: 2, greaterThan: false, windKt: 30, gustSpreadKt: 15 }),
      mins,
    );
    expect(result.verdict).toBe("no-go");
    const failing = result.checks.filter((c) => c.status === "fail").map((c) => c.limit);
    expect(failing).toEqual(["ceilingFt", "visSm", "windKt", "gustSpreadKt"]);
    expect(result.reasons.filter((r) => r.includes("minimum")).length).toBe(4);
  });
});
