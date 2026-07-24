/**
 * Time-zone helpers (no dependency: Node ships full ICU, so Intl knows the
 * IANA database). Used to interpret the pilot's "flyable hours" (e.g.
 * 07:00-21:00) in the profile's IANA time zone and to print timestamps with
 * their local UTC offset.
 */

export interface LocalDateParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

export interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
  second: number;
}

/** True when `tz` is an IANA zone this runtime knows about (e.g. "America/Los_Angeles"). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock date/time parts of `date` in `timeZone`. */
export function localParts(date: Date, timeZone: string): LocalDateTimeParts {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  const values: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type === "literal") continue;
    values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Just the local calendar date (YYYY-MM-DD parts) of `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string): LocalDateParts {
  const p = localParts(date, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC offset in milliseconds (local minus UTC) at instant `date` in `timeZone`. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/**
 * The absolute instant at which the wall clock in `timeZone` reads the given
 * local date/time. Handles DST transitions by re-checking the offset at the
 * candidate instant (a skipped local time resolves to the instant after the gap).
 */
export function zonedTimeToUtc(parts: LocalDateParts & { hour?: number; minute?: number; second?: number }, timeZone: string): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  // First guess assumes UTC == wall clock, then correct by the zone offset at that instant (twice for DST edges).
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Add whole calendar days to a local date (calendar arithmetic, DST-agnostic). */
export function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** "YYYY-MM-DD" for a local date. */
export function formatLocalDate(parts: LocalDateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Parse "YYYY-MM-DD" (a real calendar date) into parts; throws on garbage. */
export function parseLocalDate(text: string): LocalDateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`dates must be YYYY-MM-DD, got "${text}"`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`dates must be real calendar dates, got "${text}"`);
  }
  return { year, month, day };
}

/** Parse "HH:MM" (24 h) into hour/minute; throws on garbage. */
export function parseLocalTime(text: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) throw new Error(`times must be HH:MM (24-hour), got "${text}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * ISO-8601 timestamp with the zone's UTC offset at that instant, e.g.
 * "2026-07-23T07:00:00-07:00". (Round-trips through Date.parse.)
 */
export function formatIsoWithOffset(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const offsetMin = Math.round(zoneOffsetMs(date, timeZone) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** "HH:MM" local wall-clock time of an instant in `timeZone`. */
export function formatLocalHm(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Compare two local dates: negative when a < b, 0 when equal, positive when a > b. */
export function compareLocalDates(a: LocalDateParts, b: LocalDateParts): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}
