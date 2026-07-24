/**
 * Pure availability math over the projected portal payloads (no I/O).
 *
 * Inputs: the school's aircraft roster (FI_* rows, projected by site.ts),
 * the flat per-day appointment rows (IA_* rows, projected), the pilot's
 * checked-out tail numbers, and a requested window. Output: per-tail free
 * intervals, the busy blocks that break them up (identities already
 * stripped at capture time), airworthiness/roster flags, and the list of
 * tails free for the whole window.
 *
 * Time model: portal stamps are naive UTC ("YYYY-MM-DD HH:mm:ss"); windows
 * are ISO instants; results carry both ISO (UTC) and tenant-local
 * wall-clock renderings for narration.
 */
import { round2 } from "../../util.js";
import type { AircraftAvailability, BusyBlock, BusyBlockKind, FreeInterval, TailAvailability, TimeWindow } from "../../types.js";
import {
  AIRCRAFT_ACTIVE_STATUS,
  APPOINTMENT_STATUS,
  CHECKOUT_DISPATCHED_STATUSES,
  FLIGHT_TYPE,
  FLIGHT_TYPE_LABELS,
  type PortalRosterRecord,
  type PortalScheduleRecord,
} from "./site.js";
import { formatLocalDateTime, parseNaiveUtc } from "./time.js";

// --- Tail matching -----------------------------------------------------------------

/** Uppercase, single-space form of a tail/display string for comparison. */
export function normalizeTailNumber(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Comparable candidates for one roster display string. The roster shows
 * tails as "N556ND (RFS720)" (tail + fleet code) or "Frasca - 15551" for
 * simulators; a profile tail such as "N556ND" should match the first form.
 */
export function tailCandidates(display: string): string[] {
  const norm = normalizeTailNumber(display);
  const candidates = new Set<string>([norm]);
  const paren = norm.indexOf(" (");
  if (paren > 0) candidates.add(norm.slice(0, paren).trim());
  const firstToken = norm.split(" ")[0];
  if (/^N[0-9A-Z]{1,5}$/.test(firstToken)) candidates.add(firstToken);
  return [...candidates];
}

/** Map each requested tail to its roster row (null when the roster has no match). */
export function matchTailsToRoster(
  tails: readonly string[],
  roster: readonly PortalRosterRecord[],
): Map<string, PortalRosterRecord | null> {
  const index = new Map<string, PortalRosterRecord[]>();
  for (const row of roster) {
    if (!row.tailDisplay) continue;
    for (const key of tailCandidates(row.tailDisplay)) {
      const list = index.get(key);
      if (list) list.push(row);
      else index.set(key, [row]);
    }
  }
  const result = new Map<string, PortalRosterRecord | null>();
  for (const tail of tails) {
    const matches = index.get(normalizeTailNumber(tail)) ?? [];
    // Prefer an active row when the roster carries the same tail more than once.
    const active = matches.find((r) => r.status === AIRCRAFT_ACTIVE_STATUS);
    result.set(tail, active ?? matches[0] ?? null);
  }
  return result;
}

// --- Interval math -------------------------------------------------------------

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Merge overlapping or touching intervals; empty/inverted intervals are dropped. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/** Free sub-intervals of `window` not covered by (already merged, sorted) busy intervals. */
export function subtractIntervals(window: Interval, busy: readonly Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/** True when [a) and [b) share any time (touching endpoints do not overlap). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

// --- Busy blocks from appointment records -------------------------------------------

export interface AircraftBusyBlock extends Interval {
  kind: BusyBlockKind;
  label?: string;
}

/**
 * Busy blocks on one aircraft (by roster id) from the day-schedule records.
 * - cancelled/deleted rows never block;
 * - maintenance rows (flight type 3 / status 5) always do;
 * - tentative ("potential") bookings count as busy (safest);
 * - the pilot's own bookings are marked separately (no identities anywhere);
 * - a flight still dispatched past its scheduled end keeps the airframe busy until `now`.
 */
export function busyBlocksForAircraft(
  records: readonly PortalScheduleRecord[],
  aircraftId: number,
  opts: { ownUserId?: number | null; nowMs?: number } = {},
): AircraftBusyBlock[] {
  const seenIds = new Set<number>();
  const blocks: AircraftBusyBlock[] = [];
  for (const r of records) {
    if (r.aircraftId !== aircraftId) continue;
    if (r.id !== null) {
      if (seenIds.has(r.id)) continue; // the same day can be captured twice; count each appointment once
      seenIds.add(r.id);
    }
    if (r.deleted || r.appointmentStatus === APPOINTMENT_STATUS.CANCELLED) continue;
    const start = parseNaiveUtc(r.start);
    let end = parseNaiveUtc(r.end);
    if (start === null || end === null || end <= start) continue;

    let kind: BusyBlockKind = "reservation";
    const isMaintenance =
      r.flightType === FLIGHT_TYPE.MAINTENANCE || r.appointmentStatus === APPOINTMENT_STATUS.MAINTENANCE;
    if (isMaintenance) kind = "maintenance";
    else if (r.flightType === FLIGHT_TYPE.TIME_OFF) kind = "other";
    else if (opts.ownUserId !== undefined && opts.ownUserId !== null && r.userId === opts.ownUserId) kind = "own-reservation";

    let label = r.flightType !== null ? FLIGHT_TYPE_LABELS[r.flightType] : undefined;

    // An aircraft that is still checked out (dispatched) past its scheduled end is not free yet.
    const now = opts.nowMs;
    if (
      now !== undefined &&
      r.checkoutStatus !== null &&
      CHECKOUT_DISPATCHED_STATUSES.has(r.checkoutStatus) &&
      end < now &&
      start <= now
    ) {
      end = now;
      label = label ? `${label} (still checked out)` : "still checked out";
    }

    blocks.push({ start, end, kind, ...(label ? { label } : {}) });
  }
  return blocks.sort((a, b) => a.start - b.start || a.end - b.end);
}

// --- Roster (airworthiness / dispatch) flags -----------------------------------------

/** Human-readable flags for one roster row; `grounding` ones make the tail unavailable. */
export function rosterFlags(row: PortalRosterRecord, checkDateLocal: string): { flags: string[]; grounded: boolean } {
  const flags: string[] = [];
  let grounded = false;

  if (row.status !== null && row.status !== AIRCRAFT_ACTIVE_STATUS) {
    flags.push("aircraft is not active on the school roster");
    grounded = true;
  }
  if (row.relocating) flags.push("aircraft has a pending location change (may be at another field)");

  for (const item of row.maintenance) {
    if (!item.requiredForDispatch) continue;
    const hoursOverdue = item.hoursRemaining !== null && item.hoursRemaining < 0;
    const dateExpired = item.expirationDate !== null && item.expirationDate < checkDateLocal;
    if (hoursOverdue || dateExpired) {
      const detail = hoursOverdue ? `${Math.abs(round2(item.hoursRemaining ?? 0))} h overdue` : `expired ${item.expirationDate}`;
      flags.push(`dispatch-required maintenance overdue: ${item.name ?? "inspection"} (${detail})`);
      grounded = true;
    }
  }

  for (const d of row.discrepancies) {
    const bits = [d.type ? `type ${d.type}` : null, d.restrictions ? `restrictions: ${d.restrictions}` : null].filter(
      Boolean,
    );
    flags.push(`open discrepancy${bits.length ? ` (${bits.join("; ")})` : ""}`);
  }

  return { flags, grounded };
}

// --- Per-tail assessment ---------------------------------------------------------------

export interface AssessTailInput {
  tail: string;
  roster: PortalRosterRecord | null;
  /** All captured schedule records for the days the window spans (any aircraft). */
  records: readonly PortalScheduleRecord[];
  window: Interval;
  timeZone: string;
  /** The logged-in member's user id (marks "your" bookings), if known. */
  ownUserId: number | null;
  nowMs: number;
  /** Tenant-local date (YYYY-MM-DD) of the flight day, used for maintenance-expiration checks. */
  checkDateLocal: string;
}

export function assessTail(input: AssessTailInput): TailAvailability {
  const { tail, roster, window, timeZone } = input;
  if (!roster || roster.id === null) {
    return {
      tail,
      aircraftId: null,
      status: "not-on-roster",
      free: [],
      blocks: [],
      flags: [`${tail} is not on the school's aircraft roster (check the tail number in your profile).`],
    };
  }

  const { flags, grounded } = rosterFlags(roster, input.checkDateLocal);
  const allBlocks = busyBlocksForAircraft(input.records, roster.id, {
    ownUserId: input.ownUserId,
    nowMs: input.nowMs,
  });
  const inWindow = allBlocks.filter((b) => overlaps(b, window));
  const merged = mergeIntervals(inWindow);
  const freeIntervals = subtractIntervals(window, merged);

  const blocks: BusyBlock[] = inWindow.map((b) => toBusyBlock(b, timeZone));
  const free: FreeInterval[] = freeIntervals.map((f) => toFreeInterval(f, timeZone));

  let status: TailAvailability["status"];
  if (grounded) status = "unavailable";
  else if (free.length === 1 && freeIntervals[0].start === window.start && freeIntervals[0].end === window.end) {
    status = "available";
  } else if (free.length === 0) status = "unavailable";
  else status = "partially-available";

  return { tail, aircraftId: roster.id, status, free, blocks, flags };
}

// --- Whole-window computation ------------------------------------------------------

export interface ComputeAvailabilityInput {
  window: TimeWindow;
  /** Profile tails to assess (checked-out ones), in profile order. */
  tails: readonly string[];
  roster: readonly PortalRosterRecord[];
  records: readonly PortalScheduleRecord[];
  timeZone: string;
  ownUserId: number | null;
  nowMs: number;
  /** Tenant-local date (YYYY-MM-DD) of the flight day, for maintenance-expiration checks (never before today). */
  checkDateLocal: string;
}

export interface ComputeAvailabilityResult {
  tails: TailAvailability[];
  /** Tails free for the whole window (subset of `tails`, profile order). */
  availableTails: string[];
  notes: string[];
}

export function computeAvailability(input: ComputeAvailabilityInput): ComputeAvailabilityResult {
  const windowMs: Interval = { start: Date.parse(input.window.start), end: Date.parse(input.window.end) };
  const notes: string[] = [];
  if (!(Number.isFinite(windowMs.start) && Number.isFinite(windowMs.end)) || windowMs.end <= windowMs.start) {
    return { tails: [], availableTails: [], notes: ["Invalid window: start must be before end."] };
  }

  const uniqueTails = dedupeTails(input.tails);
  const rosterByTail = matchTailsToRoster(uniqueTails, input.roster);
  const tails: TailAvailability[] = uniqueTails.map((tail) =>
    assessTail({
      tail,
      roster: rosterByTail.get(tail) ?? null,
      records: input.records,
      window: windowMs,
      timeZone: input.timeZone,
      ownUserId: input.ownUserId,
      nowMs: input.nowMs,
      checkDateLocal: input.checkDateLocal,
    }),
  );

  const availableTails = tails.filter((t) => t.status === "available").map((t) => t.tail);
  if (tails.some((t) => t.blocks.some((b) => b.kind === "own-reservation"))) {
    notes.push("A block marked own-reservation is your own existing booking on that tail.");
  }
  if (input.records.some((r) => r.potentialStatus !== null && r.potentialStatus > 1)) {
    notes.push("Tentative ('potential') bookings are counted as busy.");
  }
  return { tails, availableTails, notes };
}

/** Assemble the tool-facing availability payload. */
export function toAircraftAvailability(
  window: TimeWindow,
  result: ComputeAvailabilityResult,
  source: string,
  extraNotes: string[] = [],
): AircraftAvailability {
  return {
    window,
    availableTails: result.availableTails,
    source,
    notes: [...extraNotes, ...result.notes],
    tails: result.tails,
  };
}

// --- helpers ---------------------------------------------------------------------------

function dedupeTails(tails: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tails) {
    const tail = normalizeTailNumber(raw);
    if (!tail || seen.has(tail)) continue;
    seen.add(tail);
    out.push(tail);
  }
  return out;
}

function toBusyBlock(block: AircraftBusyBlock, timeZone: string): BusyBlock {
  return {
    start: new Date(block.start).toISOString(),
    end: new Date(block.end).toISOString(),
    startLocal: formatLocalDateTime(block.start, timeZone),
    endLocal: formatLocalDateTime(block.end, timeZone),
    kind: block.kind,
    ...(block.label ? { label: block.label } : {}),
  };
}

function toFreeInterval(interval: Interval, timeZone: string): FreeInterval {
  return {
    start: new Date(interval.start).toISOString(),
    end: new Date(interval.end).toISOString(),
    startLocal: formatLocalDateTime(interval.start, timeZone),
    endLocal: formatLocalDateTime(interval.end, timeZone),
    durationHours: round2((interval.end - interval.start) / 3_600_000),
  };
}
