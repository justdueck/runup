/**
 * Personal-minimums scoring: a pure function from observed/forecast
 * conditions + the pilot's minimums to per-limit pass/fail with margins and
 * an overall go / no-go.
 *
 * Design notes
 * - Conservative by default: a limit that cannot be evaluated because data is
 *   missing (visibility not reported, sky condition missing) makes the
 *   overall verdict "no-go". A limit that is skipped because the *user*
 *   omitted optional input (no runway heading for crosswind) does not.
 * - `margin` is always "room to spare" in the limit's own unit: positive is
 *   good, negative means beyond the limit. `marginRatio` (margin / required)
 *   makes limits with different units comparable.
 */
import type { MinimumsBlock, PersonalMinimums } from "./profile.js";
import { round1, round2 } from "./util.js";

export type TimeOfDay = "day" | "night";
export type LimitId = "ceilingFt" | "visSm" | "windKt" | "gustSpreadKt" | "crosswindKt";
export type CheckStatus = "pass" | "fail" | "skipped" | "unknown";

/** Structural subset of a ConditionSummary that the scorer needs. */
export interface ScorableConditions {
  wind: { speedKt: number; gustSpreadKt: number };
  visibility: { sm: number | null; greaterThan: boolean };
  ceiling: { ft: number | null; reported: boolean };
  crosswind: { runwayHeadingDeg: number | null; crosswindKt: number | null };
}

export interface LimitCheck {
  limit: LimitId;
  label: string;
  /** min: actual must be >= required; max: actual must be <= required. */
  kind: "min" | "max";
  unit: "ft" | "sm" | "kt";
  required: number;
  actual: number | null;
  status: CheckStatus;
  /** Room to spare in the limit's unit (positive = ok). Null when not evaluated. */
  margin: number | null;
  /** margin / required, for comparing limits across units. */
  marginRatio: number | null;
  note?: string;
}

export interface ScoreResult {
  verdict: "go" | "no-go";
  timeOfDay: TimeOfDay;
  checks: LimitCheck[];
  reasons: string[];
}

const LIMIT_META: Record<LimitId, { label: string; kind: "min" | "max"; unit: "ft" | "sm" | "kt" }> = {
  ceilingFt: { label: "Ceiling", kind: "min", unit: "ft" },
  visSm: { label: "Visibility", kind: "min", unit: "sm" },
  windKt: { label: "Surface wind", kind: "max", unit: "kt" },
  gustSpreadKt: { label: "Gust spread", kind: "max", unit: "kt" },
  crosswindKt: { label: "Crosswind", kind: "max", unit: "kt" },
};

export function scoreConditions(
  conditions: ScorableConditions,
  minimums: PersonalMinimums,
  opts: { timeOfDay?: TimeOfDay } = {},
): ScoreResult {
  const timeOfDay: TimeOfDay = opts.timeOfDay ?? "day";
  const limits: MinimumsBlock = timeOfDay === "night" ? minimums.night : minimums.day;
  const checks: LimitCheck[] = [];

  // Ceiling: null with sky reported = no ceiling (clear/scattered) = pass.
  if (!conditions.ceiling.reported) {
    checks.push(makeCheck("ceilingFt", limits.ceilingFt, null, "unknown", "sky condition missing from the report"));
  } else if (conditions.ceiling.ft === null) {
    checks.push(makeCheck("ceilingFt", limits.ceilingFt, null, "pass", "no ceiling reported (clear or scattered only)"));
  } else {
    checks.push(evaluate("ceilingFt", limits.ceilingFt, conditions.ceiling.ft));
  }

  // Visibility.
  if (conditions.visibility.sm === null) {
    checks.push(makeCheck("visSm", limits.visSm, null, "unknown", "visibility not reported"));
  } else {
    const check = evaluate("visSm", limits.visSm, conditions.visibility.sm);
    if (conditions.visibility.greaterThan) check.note = `reported as ${conditions.visibility.sm}+ SM`;
    checks.push(check);
  }

  // Steady wind and gust spread.
  checks.push(evaluate("windKt", limits.windKt, conditions.wind.speedKt));
  checks.push(evaluate("gustSpreadKt", limits.gustSpreadKt, conditions.wind.gustSpreadKt));

  // Crosswind: skipped (not failed) when no runway heading was supplied.
  if (conditions.crosswind.runwayHeadingDeg === null) {
    checks.push(makeCheck("crosswindKt", limits.crosswindKt, null, "skipped", "no runway heading supplied"));
  } else if (conditions.crosswind.crosswindKt === null) {
    checks.push(
      makeCheck("crosswindKt", limits.crosswindKt, null, "unknown", "wind direction missing - crosswind not computable"),
    );
  } else {
    const check = evaluate("crosswindKt", limits.crosswindKt, conditions.crosswind.crosswindKt);
    check.note = `runway heading ${pad3(conditions.crosswind.runwayHeadingDeg)}`;
    checks.push(check);
  }

  const blocking = checks.filter((c) => c.status === "fail" || c.status === "unknown");
  const verdict: "go" | "no-go" = blocking.length === 0 ? "go" : "no-go";

  return { verdict, timeOfDay, checks, reasons: buildReasons(checks, verdict, timeOfDay) };
}

function evaluate(limit: LimitId, required: number, actual: number): LimitCheck {
  const meta = LIMIT_META[limit];
  const margin = meta.kind === "min" ? actual - required : required - actual;
  return {
    limit,
    label: meta.label,
    kind: meta.kind,
    unit: meta.unit,
    required,
    actual,
    status: margin >= 0 ? "pass" : "fail",
    margin: round1(margin),
    marginRatio: required !== 0 ? round2(margin / required) : null,
  };
}

function makeCheck(
  limit: LimitId,
  required: number,
  actual: number | null,
  status: CheckStatus,
  note?: string,
): LimitCheck {
  const meta = LIMIT_META[limit];
  return {
    limit,
    label: meta.label,
    kind: meta.kind,
    unit: meta.unit,
    required,
    actual,
    status,
    margin: null,
    marginRatio: null,
    ...(note ? { note } : {}),
  };
}

function buildReasons(checks: LimitCheck[], verdict: "go" | "no-go", timeOfDay: TimeOfDay): string[] {
  const reasons: string[] = [];
  for (const c of checks) {
    if (c.status === "fail") {
      const relation = c.kind === "min" ? "below" : "above";
      const shortfall = Math.abs(c.margin ?? 0);
      reasons.push(
        `${c.label} ${fmt(c.actual)} ${c.unit} is ${relation} your ${timeOfDay} minimum of ${c.required} ${c.unit} ` +
          `(${shortfall} ${c.unit} ${c.kind === "min" ? "short" : "over"})`,
      );
    }
  }
  for (const c of checks) {
    if (c.status === "unknown") {
      reasons.push(`${c.label} could not be evaluated: ${c.note ?? "data missing"} (treated as no-go)`);
    }
  }
  for (const c of checks) {
    if (c.status === "skipped") {
      reasons.push(`${c.label} not evaluated: ${c.note ?? "not applicable"}`);
    }
  }
  if (verdict === "go") {
    const tightest = checks
      .filter((c) => c.status === "pass" && c.marginRatio !== null)
      .sort((a, b) => (a.marginRatio ?? 0) - (b.marginRatio ?? 0))[0];
    if (tightest) {
      reasons.unshift(
        `All personal minimums (${timeOfDay}) pass; tightest is ${tightest.label.toLowerCase()}: ` +
          `${fmt(tightest.actual)}/${tightest.required} ${tightest.unit} (${tightest.margin} ${tightest.unit} to spare)`,
      );
    } else {
      reasons.unshift(`All evaluated personal minimums (${timeOfDay}) pass`);
    }
  }
  return reasons;
}

const fmt = (n: number | null): string => (n === null ? "?" : String(n));
const pad3 = (deg: number | null): string => (deg === null ? "?" : String(Math.round(deg)).padStart(3, "0"));
