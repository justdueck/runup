/**
 * Shared interval math over half-open [start, end) epoch-millisecond ranges.
 * Used by both calendar free/busy computation (ical-calendar) and aircraft
 * schedule availability (needlenine) — one implementation so edge-case
 * semantics (touching intervals merge, empty/inverted intervals drop) can
 * never drift between providers.
 */

/** A half-open [start, end) instant interval in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Sort + merge overlapping (or touching) intervals; empty/inverted intervals are dropped. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** `free` minus every busy interval (busy need not be pre-merged). Result is sorted. */
export function subtractIntervals(free: Interval, busy: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [{ ...free }];
  for (const b of mergeIntervals(busy)) {
    const next: Interval[] = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) {
        next.push(p); // no overlap
        continue;
      }
      if (b.start > p.start) next.push({ start: p.start, end: b.start });
      if (b.end < p.end) next.push({ start: b.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/** True when [a) and [b) share any time (touching endpoints do not overlap). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
