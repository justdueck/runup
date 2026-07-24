import { describe, expect, it } from "vitest";
import {
  attributeScheduleDate,
  briefError,
  defaultChromiumSandbox,
  sanitizeDebugEnv,
} from "../../src/providers/needlenine/portal-session.js";
import { projectScheduleRecords } from "../../src/providers/needlenine/site.js";
import { rawAppointment, stamp, TZ } from "./fixtures.js";

describe("attributeScheduleDate", () => {
  const day = "2026-07-24";
  const records = projectScheduleRecords([
    rawAppointment({ IA_ID: 1, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "07:00"), IA_END_TIME: stamp(day, "09:00") }),
    rawAppointment({ IA_ID: 2, IA_AIRCRAFT_ID: 202, IA_START_TIME: stamp(day, "13:00"), IA_END_TIME: stamp(day, "15:00") }),
    rawAppointment({ IA_ID: 3, IA_AIRCRAFT_ID: 303, IA_START_TIME: stamp(day, "22:30"), IA_END_TIME: stamp("2026-07-25", "00:30") }),
    // A stray from another day (data anomaly) does not win the vote.
    rawAppointment({ IA_ID: 4, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp("2026-09-01", "10:00"), IA_END_TIME: stamp("2026-09-01", "12:00") }),
  ]);

  it("attributes a payload to the dominant tenant-local start date (naive UTC parsed)", () => {
    // Local starts: 07-24, 07-24, 07-24 (22:30 local is still the 24th), stray 09-01 -> mode 07-24.
    expect(attributeScheduleDate(records, TZ, null)).toBe(day);
    expect(attributeScheduleDate(records, TZ, "1999-01-01")).toBe(day);
  });

  it("falls back to the observed response date for undated/empty payloads", () => {
    const undated = projectScheduleRecords([rawAppointment({ IA_START_TIME: "not a stamp" })]);
    expect(attributeScheduleDate(undated, TZ, day)).toBe(day);
    expect(attributeScheduleDate([], TZ, day)).toBe(day);
    expect(attributeScheduleDate([], TZ, null)).toBeNull();
  });

  it("prefers the response date when no local date has a majority", () => {
    const split = projectScheduleRecords([
      rawAppointment({ IA_ID: 10, IA_START_TIME: stamp("2026-07-24", "12:00") }),
      rawAppointment({ IA_ID: 11, IA_START_TIME: stamp("2026-07-25", "12:00") }),
      rawAppointment({ IA_ID: 12, IA_START_TIME: stamp("2026-07-26", "12:00") }),
    ]);
    expect(attributeScheduleDate(split, TZ, "2026-07-25")).toBe("2026-07-25");
  });
});

describe("sanitizeDebugEnv", () => {
  it("strips playwright debug tokens (which can echo protocol payloads) but keeps unrelated ones", () => {
    const env: NodeJS.ProcessEnv = { DEBUG: "app:*,pw:api,pw:protocol,playwright:*,mydebug", PWDEBUG: "1" };
    sanitizeDebugEnv(env);
    expect(env.DEBUG).toBe("app:*,mydebug");
    expect(env.PWDEBUG).toBeUndefined();

    const star: NodeJS.ProcessEnv = { DEBUG: "*" };
    sanitizeDebugEnv(star);
    expect(star.DEBUG).toBeUndefined();

    const untouched: NodeJS.ProcessEnv = { DEBUG: "vitest:runner" };
    sanitizeDebugEnv(untouched);
    expect(untouched.DEBUG).toBe("vitest:runner");
  });
});

describe("defaultChromiumSandbox", () => {
  it("keeps the renderer sandbox on for desktop OSes and off for Linux containers", () => {
    expect(defaultChromiumSandbox({}, "darwin")).toBe(true);
    expect(defaultChromiumSandbox({}, "win32")).toBe(true);
    expect(defaultChromiumSandbox({}, "linux")).toBe(false);
  });

  it("honors an explicit RUNUP_CHROMIUM_SANDBOX override", () => {
    expect(defaultChromiumSandbox({ RUNUP_CHROMIUM_SANDBOX: "0" }, "darwin")).toBe(false);
    expect(defaultChromiumSandbox({ RUNUP_CHROMIUM_SANDBOX: "false" }, "darwin")).toBe(false);
    expect(defaultChromiumSandbox({ RUNUP_CHROMIUM_SANDBOX: "1" }, "linux")).toBe(true);
    expect(defaultChromiumSandbox({ RUNUP_CHROMIUM_SANDBOX: "true" }, "linux")).toBe(true);
    expect(defaultChromiumSandbox({ RUNUP_CHROMIUM_SANDBOX: "maybe" }, "linux")).toBe(false); // junk -> platform default
  });
});

describe("briefError", () => {
  it("keeps a single trimmed line and never a stack dump", () => {
    const err = new Error("first line\n    at Something (file.js:1:1)\n    at deeper");
    expect(briefError(err)).toBe("first line");
    expect(briefError("plain string")).toBe("plain string");
    expect(briefError(new Error(`${"x".repeat(500)}`))).toHaveLength(200);
    expect(briefError(new Error("\n\n  \nreal message here"))).toBe("real message here");
  });
});
