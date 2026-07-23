import { describe, expect, it } from "vitest";
import {
  addDaysToDate,
  diffCalendarDays,
  formatLocalDateTime,
  localDateOf,
  localDatesSpanning,
  parseNaiveUtc,
  zonedDateTimeToUtcMs,
} from "../../src/providers/needlenine/time.js";

const TZ = "America/Los_Angeles";

describe("parseNaiveUtc", () => {
  it("treats portal stamps as UTC", () => {
    expect(parseNaiveUtc("2026-07-23 17:00:00")).toBe(Date.UTC(2026, 6, 23, 17, 0, 0));
    expect(parseNaiveUtc("2026-07-23T17:30")).toBe(Date.UTC(2026, 6, 23, 17, 30, 0));
  });

  it("rejects malformed and impossible stamps", () => {
    expect(parseNaiveUtc("2026-02-30 10:00:00")).toBeNull();
    expect(parseNaiveUtc("2026-13-01 10:00:00")).toBeNull();
    expect(parseNaiveUtc("2026-07-23 25:00:00")).toBeNull();
    expect(parseNaiveUtc("tomorrow")).toBeNull();
    expect(parseNaiveUtc("")).toBeNull();
    expect(parseNaiveUtc(null)).toBeNull();
    expect(parseNaiveUtc(undefined)).toBeNull();
  });
});

describe("local dates and windows", () => {
  it("maps UTC instants to the tenant-local calendar date (PDT is UTC-7)", () => {
    // 2026-07-24 05:59 UTC is still 2026-07-23 22:59 in Los Angeles.
    expect(localDateOf(Date.UTC(2026, 6, 24, 5, 59), TZ)).toBe("2026-07-23");
    // 07:00 UTC is midnight local -> the new day.
    expect(localDateOf(Date.UTC(2026, 6, 24, 7, 0), TZ)).toBe("2026-07-24");
  });

  it("lists every local day a window touches", () => {
    const start = Date.UTC(2026, 6, 24, 5, 0); // 22:00 local on 07-23
    const end = Date.UTC(2026, 6, 24, 8, 30); // 01:30 local on 07-24
    expect(localDatesSpanning(start, end, TZ)).toEqual(["2026-07-23", "2026-07-24"]);
  });

  it("does not include the next day for a window ending exactly at local midnight", () => {
    const start = Date.UTC(2026, 6, 24, 3, 0); // 20:00 local on 07-23
    const end = Date.UTC(2026, 6, 24, 7, 0); // exactly 00:00 local on 07-24
    expect(localDatesSpanning(start, end, TZ)).toEqual(["2026-07-23"]);
  });

  it("handles a degenerate window as its single day", () => {
    const t = Date.UTC(2026, 6, 24, 15, 0);
    expect(localDatesSpanning(t, t, TZ)).toEqual(["2026-07-24"]);
  });

  it("crosses the fall-back DST transition (2026-11-01) without dropping or repeating a date", () => {
    const start = Date.UTC(2026, 9, 31, 20, 0); // 13:00 PDT on 10-31
    const end = Date.UTC(2026, 10, 2, 21, 0); // 13:00 PST on 11-02
    expect(localDatesSpanning(start, end, TZ)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("zonedDateTimeToUtcMs", () => {
  it("converts a tenant-local wall clock to the UTC instant it names", () => {
    // 10:00 PDT (UTC-7) on 2026-07-24 == 17:00 UTC.
    expect(zonedDateTimeToUtcMs("2026-07-24", "10:00", TZ)).toBe(Date.UTC(2026, 6, 24, 17, 0));
    // 10:00 PST (UTC-8) in January.
    expect(zonedDateTimeToUtcMs("2026-01-15", "10:00", TZ)).toBe(Date.UTC(2026, 0, 15, 18, 0));
    // Round-trip through localDateOf/formatLocalDateTime.
    const ms = zonedDateTimeToUtcMs("2026-11-01", "12:30", TZ);
    expect(formatLocalDateTime(ms, TZ)).toBe("2026-11-01 12:30");
    expect(localDateOf(ms, TZ)).toBe("2026-11-01");
  });

  it("rejects malformed input", () => {
    expect(() => zonedDateTimeToUtcMs("2026-7-24", "10:00", TZ)).toThrow(/YYYY-MM-DD/);
    expect(() => zonedDateTimeToUtcMs("2026-07-24", "10am", TZ)).toThrow(/HH:mm/);
  });
});

describe("calendar arithmetic", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDaysToDate("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysToDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysToDate("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });

  it("diffs whole calendar days", () => {
    expect(diffCalendarDays("2026-07-23", "2026-07-24")).toBe(1);
    expect(diffCalendarDays("2026-07-24", "2026-07-20")).toBe(-4);
    expect(diffCalendarDays("2026-07-24", "2026-07-24")).toBe(0);
  });
});
