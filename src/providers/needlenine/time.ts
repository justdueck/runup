/**
 * Time helpers for the NeedleNine provider.
 *
 * The portal stores every appointment stamp as a naive UTC string
 * ("YYYY-MM-DD HH:mm:ss", no offset) while the schedule UI works in the
 * school's tenant timezone (an IANA name, default America/Los_Angeles).
 * Portal-stamp parsing lives here; all zone/date arithmetic delegates to the
 * shared helpers in src/tz.ts so DST edge-case behavior can never diverge
 * between the calendar and scheduler providers.
 */
import { addDays, compareLocalDates, formatLocalDate, formatLocalHm, localParts, parseLocalDate, zonedTimeToUtc } from "../../tz.js";

export const DEFAULT_TENANT_TIMEZONE = "America/Los_Angeles";

const NAIVE_STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse a portal "YYYY-MM-DD HH:mm:ss" naive UTC stamp into epoch milliseconds.
 * Returns null for malformed or impossible dates (e.g. 2026-02-30).
 */
export function parseNaiveUtc(stamp: string | null | undefined): number | null {
  if (typeof stamp !== "string") return null;
  const m = NAIVE_STAMP.exec(stamp.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  // Date.UTC silently rolls impossible values (Feb 30 -> Mar 2, 25:00 -> next day); reject those.
  if (
    !Number.isFinite(ms) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return ms;
}

/** Calendar date "YYYY-MM-DD" of an instant in the given IANA timezone. */
export function localDateOf(epochMs: number, timeZone: string): string {
  return formatLocalDate(localParts(new Date(epochMs), timeZone));
}

/** "YYYY-MM-DD HH:mm" wall clock of an instant in the timezone (for human-facing output). */
export function formatLocalDateTime(epochMs: number, timeZone: string): string {
  const at = new Date(epochMs);
  return `${formatLocalDate(localParts(at, timeZone))} ${formatLocalHm(at, timeZone)}`;
}

/**
 * Convert a tenant-local wall-clock ("YYYY-MM-DD" + "HH:mm[:ss]") into the
 * UTC instant it names (DST transitions handled by tz.zonedTimeToUtc).
 */
export function zonedDateTimeToUtcMs(date: string, time: string, timeZone: string): number {
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!tm) throw new Error(`expected "HH:mm[:ss]", got "${time}"`);
  return zonedTimeToUtc(
    { ...parseLocalDate(date.trim()), hour: Number(tm[1]), minute: Number(tm[2]), second: Number(tm[3] ?? 0) },
    timeZone,
  ).getTime();
}

/** Add whole days to a "YYYY-MM-DD" date string (calendar arithmetic, no timezone involved). */
export function addDaysToDate(date: string, days: number): string {
  return formatLocalDate(addDays(parseLocalDate(date.trim()), days));
}

/** Whole calendar days from date `a` to date `b` (b - a); both "YYYY-MM-DD". */
export function diffCalendarDays(a: string, b: string): number {
  return compareLocalDates(parseLocalDate(b.trim()), parseLocalDate(a.trim())) / 86_400_000;
}

/**
 * Every tenant-local calendar date touched by the half-open interval
 * [startMs, endMs). A window that ends exactly at local midnight does not
 * include the following day.
 */
export function localDatesSpanning(startMs: number, endMs: number, timeZone: string): string[] {
  const first = localDateOf(startMs, timeZone);
  const last = localDateOf(Math.max(startMs, endMs - 1), timeZone);
  const span = Math.max(0, diffCalendarDays(first, last));
  const dates: string[] = [];
  for (let i = 0; i <= span; i++) dates.push(addDaysToDate(first, i));
  return dates;
}

