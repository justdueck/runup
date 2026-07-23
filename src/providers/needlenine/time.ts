/**
 * Time helpers for the NeedleNine provider.
 *
 * The portal stores every appointment stamp as a naive UTC string
 * ("YYYY-MM-DD HH:mm:ss", no offset) while the schedule UI works in the
 * school's tenant timezone (an IANA name, default America/Los_Angeles). These
 * helpers convert between the two without pulling in a date library: naive
 * UTC parsing, "which local calendar dates does this window touch", and a
 * local wall-clock -> UTC conversion used by tests/fixtures.
 */

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

/** Cache formatters per timezone (Intl construction is comparatively slow). */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "iso8601",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of an instant in the given IANA timezone. */
export function zonedParts(
  epochMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((p) => p.type === type)?.value ?? "0";
    return Number(raw);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local = utc + offset. */
export function timezoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.trunc(epochMs / 1000) * 1000;
}

/** Calendar date "YYYY-MM-DD" of an instant in the given IANA timezone. */
export function localDateOf(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "YYYY-MM-DD HH:mm" wall clock of an instant in the timezone (for human-facing output). */
export function formatLocalDateTime(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Convert a tenant-local wall-clock ("YYYY-MM-DD" + "HH:mm") into the UTC
 * instant it names. Resolves the zone offset iteratively so DST transitions
 * land correctly (ambiguous fall-back hours resolve to the earlier instant).
 */
export function zonedDateTimeToUtcMs(date: string, time: string, timeZone: string): number {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!dm || !tm) throw new Error(`expected "YYYY-MM-DD" + "HH:mm", got "${date}" "${time}"`);
  const naiveUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] ?? 0));
  // First guess treats the wall clock as UTC, then correct by the zone offset at that instant (twice).
  let instant = naiveUtc - timezoneOffsetMs(naiveUtc, timeZone);
  instant = naiveUtc - timezoneOffsetMs(instant, timeZone);
  return instant;
}

/** Add whole days to a "YYYY-MM-DD" date string (calendar arithmetic, no timezone involved). */
export function addDaysToDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new Error(`expected "YYYY-MM-DD", got "${date}"`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days, 12, 0, 0);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Whole calendar days from date `a` to date `b` (b - a); both "YYYY-MM-DD". */
export function diffCalendarDays(a: string, b: string): number {
  const toDayNumber = (d: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
    if (!m) throw new Error(`expected "YYYY-MM-DD", got "${d}"`);
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
  };
  return toDayNumber(b) - toDayNumber(a);
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
