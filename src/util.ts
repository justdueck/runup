/** Small numeric helpers shared across the server. */

/** Round to 1 decimal place (normalizes -0 to 0). */
export function round1(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** Round to 2 decimal places (normalizes -0 to 0). */
export function round2(n: number): number {
  const rounded = Math.round(n * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
