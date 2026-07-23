/**
 * Pure form-values -> `update_profile` patch builder for the profile View.
 * Kept DOM-free so it can be unit tested outside the browser.
 *
 * Key rule: a cleared numeric field means "leave unchanged" (the key is
 * omitted from the partial patch), never a silent 0.
 */

/** Minimums keys and their input steps: visibility can be fractional (SM), knots/feet stay integers. */
export const MINIMUMS_FIELDS = [
  { key: "ceilingFt", label: "Ceiling (ft, min)", step: "1" },
  { key: "visSm", label: "Visibility (SM, min)", step: "any" },
  { key: "windKt", label: "Wind (kt, max)", step: "1" },
  { key: "gustSpreadKt", label: "Gust spread (kt, max)", step: "1" },
  { key: "crosswindKt", label: "Crosswind (kt, max)", step: "1" },
] as const;
export type MinimumsKey = (typeof MINIMUMS_FIELDS)[number]["key"];
export type MinimumsBlockPatch = Partial<Record<MinimumsKey, number>>;

/** Reads a raw form field ("" when cleared, null when the field is absent). */
export type FieldReader = (name: string) => string | null;

/**
 * Numeric form field -> number, or `undefined` when the field is cleared /
 * absent / not a number. An explicit "0" is kept as 0 (a legitimate value);
 * only an empty field means "leave unchanged".
 */
export function readNumberField(read: FieldReader, name: string): number | undefined {
  const raw = read(name);
  if (raw === null) return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Partial minimums block for one time of day: cleared fields are omitted, not zeroed. */
export function readMinimumsBlock(read: FieldReader, block: "day" | "night"): MinimumsBlockPatch {
  const patch: MinimumsBlockPatch = {};
  for (const { key } of MINIMUMS_FIELDS) {
    const value = readNumberField(read, `minimums.${block}.${key}`);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

/**
 * Build the `update_profile` patch from the form. Home airports replace the
 * whole list; numeric fields that were cleared are simply left out so the
 * server keeps the current value.
 */
export function buildProfilePatch(read: FieldReader): Record<string, unknown> {
  const homeAirports = (read("homeAirports") ?? "")
    .split(/[\s,]+/)
    .map((id) => id.trim().toUpperCase())
    .filter((id) => id.length > 0);

  const preferences: Record<string, number> = {};
  const maxDistanceNm = readNumberField(read, "preferences.maxDistanceNm");
  if (maxDistanceNm !== undefined) preferences.maxDistanceNm = maxDistanceNm;
  const budgetPerFlightUsd = readNumberField(read, "preferences.budgetPerFlightUsd");
  if (budgetPerFlightUsd !== undefined) preferences.budgetPerFlightUsd = budgetPerFlightUsd;

  return {
    homeAirports,
    minimums: { day: readMinimumsBlock(read, "day"), night: readMinimumsBlock(read, "night") },
    ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
  };
}
