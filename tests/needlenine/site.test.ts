import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildCaptureInitScript,
  CAPTURE_QUEUE_KEY,
  CAPTURE_QUEUE_MAX,
  classifyPortalPayload,
  isLoginUrl,
  loginUrl,
  projectIdentity,
  projectRosterRecords,
  projectScheduleRecords,
  scheduleDateOfRequestUrl,
  scheduleUrl,
  tenantIdFromPortalUrl,
  type CapturedEntry,
} from "../../src/providers/needlenine/site.js";
import { PII, rawAppointment, rawRosterRow } from "./fixtures.js";

describe("routes and URLs", () => {
  it("builds the login and desktop schedule URLs on the portal origin", () => {
    expect(loginUrl("https://portal.example.test")).toBe("https://portal.example.test/login");
    expect(scheduleUrl("https://portal.example.test", "abc-123")).toBe("https://portal.example.test/abc-123/DT/schedule");
  });

  it("detects the login page", () => {
    expect(isLoginUrl("https://portal.example.test/login")).toBe(true);
    expect(isLoginUrl("https://portal.example.test/login/")).toBe(true);
    expect(isLoginUrl("https://portal.example.test/abc/DT/schedule")).toBe(false);
    expect(isLoginUrl("not a url")).toBe(false);
  });

  it("pulls the tenant id out of in-app URLs and rejects others", () => {
    expect(tenantIdFromPortalUrl("https://p.test/b2f6c1de-7c4a/DT/dashboard")).toBe("b2f6c1de-7c4a");
    expect(tenantIdFromPortalUrl("https://p.test/tenant%20id/MB/schedule")).toBe("tenant id");
    expect(tenantIdFromPortalUrl("https://p.test/login")).toBeNull();
    expect(tenantIdFromPortalUrl("https://p.test/course")).toBeNull();
    expect(tenantIdFromPortalUrl("nonsense")).toBeNull();
  });

  it("recognizes the day-schedule API call and extracts its date", () => {
    const url =
      "https://p.test/api/schedule?userid=u&usertype=1&aircrafts=all&instructors=all&aircraftsgrp=all" +
      "&scheduleof=date&scheduledate=2026-07-23&schedulemonth=&kiosk=0";
    expect(scheduleDateOfRequestUrl(url)).toBe("2026-07-23");
    // Same prefix, different endpoints -> not the day schedule.
    expect(scheduleDateOfRequestUrl("https://p.test/api/schedule/reservation")).toBeNull();
    expect(scheduleDateOfRequestUrl("https://p.test/api/schedule/calendar/aircraft?scheduledate=2026-07-23")).toBeNull();
    // Missing/invalid date param.
    expect(scheduleDateOfRequestUrl("https://p.test/api/schedule?scheduleof=date")).toBeNull();
    expect(scheduleDateOfRequestUrl("https://p.test/api/schedule?scheduledate=07/23/2026")).toBeNull();
    expect(scheduleDateOfRequestUrl("data:not-a-url:::")).toBeNull();
  });
});

describe("payload classification", () => {
  it("classifies schedule, roster and identity payloads by shape", () => {
    expect(classifyPortalPayload([rawAppointment({ IA_AIRCRAFT_ID: 101 })])).toBe("schedule");
    expect(classifyPortalPayload([rawRosterRow()])).toBe("roster");
    expect(classifyPortalPayload({ USER_ID: 90099, USER_UUID: "uuid", USER_EMAIL: "x@y.test" })).toBe("identity");
  });

  it("never classifies the login response (api_token), empty arrays, or unrelated JSON", () => {
    expect(classifyPortalPayload({ api_token: "tok", USER_ID: 1, USER_UUID: "u" })).toBeNull();
    expect(classifyPortalPayload([])).toBeNull();
    expect(classifyPortalPayload([{ icaoId: "KRNT", temp: 21 }])).toBeNull(); // weather proxy shape
    expect(classifyPortalPayload({ results: { sunrise: "6:01:00 AM" } })).toBeNull();
    expect(classifyPortalPayload("string")).toBeNull();
    expect(classifyPortalPayload(42)).toBeNull();
    expect(classifyPortalPayload(null)).toBeNull();
    expect(classifyPortalPayload([null])).toBeNull();
    expect(classifyPortalPayload([[1, 2]])).toBeNull();
  });
});

describe("projections drop everything the math does not need (incl. PII)", () => {
  it("projects appointments to ids/times/codes only", () => {
    const raw = rawAppointment({
      IA_ID: 1,
      IA_AIRCRAFT_ID: "101", // ids can arrive as strings
      IA_START_TIME: "2026-07-24 17:00:00",
      IA_END_TIME: "2026-07-24 19:00:00",
      IA_FLIGHT_TYPE: 5,
      IA_APPOINTMENT_STATUS: 1,
      IA_DELETE_APPOINTMENT_REASON: "",
      aircraft: { FI_ID: 101, FI_TAIL_NUMBER: "N11111 (RFS101)", FI_SIMULATOR: 0 },
      checkout: { CA_ID: 3, CA_STATUS: 1 },
    });
    const [projected] = projectScheduleRecords([raw]);
    expect(projected).toEqual({
      id: 1,
      aircraftId: 101,
      instructorId: 91001,
      userId: 92002,
      start: "2026-07-24 17:00:00",
      end: "2026-07-24 19:00:00",
      flightType: 5,
      appointmentStatus: 1,
      checkInStatus: 0,
      potentialStatus: 1,
      deleted: false,
      tailDisplay: "N11111 (RFS101)",
      simulator: false,
      checkoutStatus: 1,
    });
    const text = JSON.stringify(projectScheduleRecords([raw]));
    for (const secret of Object.values(PII)) expect(text).not.toContain(secret);
    expect(text).not.toContain("Private Pilot");
    expect(text).not.toContain("uuid");
  });

  it("marks deleted/cancelled rows and simulators", () => {
    const [deleted] = projectScheduleRecords([rawAppointment({ IA_DELETE_APPOINTMENT_REASON: "weather" })]);
    expect(deleted.deleted).toBe(true);
    const [sim] = projectScheduleRecords([
      rawAppointment({ aircraft: { FI_ID: 9, FI_TAIL_NUMBER: "Frasca - 14837", FI_SIMULATOR: 1 } }),
    ]);
    expect(sim.simulator).toBe(true);
    expect(sim.tailDisplay).toBe("Frasca - 14837");
  });

  it("projects the roster to tails, groups, maintenance and discrepancy summaries (no descriptions)", () => {
    const raw = rawRosterRow({
      maintenance: [
        { MAI_ID: 1, MAI_NAME: "100 Hour", MAI_EXPIRATION_DATE: null, MAI_HOURS_REMAINING: -2.5, MAI_REQ_FOR_DISPATCH: 1 },
        { MAI_ID: 2, MAI_NAME: "Annual", MAI_EXPIRATION_DATE: "2026-05-31", MAI_HOURS_REMAINING: null, MAI_REQ_FOR_DISPATCH: "0" },
      ],
      opendiscrepancies: [
        { DIS_ID: 5, DIS_TYPE: "2", DIS_DESCRIPTION: `Landing light inop ${PII.squawkNote}`, DIS_RESTRICTIONS: "DAY ONLY", DIS_STATUS: 1 },
      ],
      changelocation: { CL_ID: 1 },
    });
    const [projected] = projectRosterRecords([raw]);
    expect(projected).toEqual({
      id: 101,
      tailDisplay: "N11111 (RFS101)",
      groupId: 5,
      groupName: "C172 G1000",
      modelCode: "C172 G1000",
      status: 1,
      locationId: "loc-uuid-1",
      sequence: 1,
      maintenance: [
        { name: "100 Hour", expirationDate: null, hoursRemaining: -2.5, requiredForDispatch: true },
        { name: "Annual", expirationDate: "2026-05-31", hoursRemaining: null, requiredForDispatch: false },
      ],
      discrepancies: [{ type: "2", restrictions: "DAY ONLY", status: 1 }],
      relocating: true,
    });
    expect(JSON.stringify(projected)).not.toContain(PII.squawkNote);
  });

  it("skips non-object rows defensively", () => {
    expect(projectScheduleRecords([1, "x", null, rawAppointment({ IA_ID: 7 })])).toHaveLength(1);
    expect(projectRosterRecords(null)).toEqual([]);
    expect(projectScheduleRecords({ not: "an array" })).toEqual([]);
  });

  it("keeps only the user id from the identity payload", () => {
    expect(projectIdentity({ USER_ID: "90099", USER_UUID: "u", USER_EMAIL: "e@x.test", api: "no" })).toEqual({
      userId: 90099,
    });
    expect(projectIdentity(null)).toEqual({ userId: null });
  });
});

describe("capture init script (evaluated in a fresh JS realm)", () => {
  function loadScript(): { run: (code: string) => unknown; queue: () => CapturedEntry[] } {
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(buildCaptureInitScript(), sandbox);
    return {
      run: (code) => vm.runInContext(code, sandbox),
      queue: () => JSON.parse(vm.runInContext(`JSON.stringify(globalThis[${JSON.stringify(CAPTURE_QUEUE_KEY)}] || [])`, sandbox) as string) as CapturedEntry[],
    };
  }

  it("wraps JSON.parse transparently and captures projected payloads in order", () => {
    const { run, queue } = loadScript();
    const schedulePayload = JSON.stringify([rawAppointment({ IA_ID: 11, IA_AIRCRAFT_ID: 101 })]);
    const rosterPayload = JSON.stringify([rawRosterRow(), rawRosterRow({ FI_ID: 202, FI_TAIL_NUMBER: "N22222 (RFS202)" })]);
    // The wrapped JSON.parse must still behave like the built-in for the app.
    expect(run(`JSON.parse('{"plain": [1,2,3]}').plain[2]`)).toBe(3);
    expect(run(`JSON.parse('42', (k, v) => v)`)).toBe(42); // reviver still supported
    expect(run(`typeof JSON.parse`)).toBe("function");
    expect(run(`JSON.parse.name`)).toBe("parse");
    run(`JSON.parse(${JSON.stringify(schedulePayload)})`);
    run(`JSON.parse(${JSON.stringify(rosterPayload)})`);
    run(`JSON.parse('{"USER_ID": 90099, "USER_UUID": "u-1", "USER_EMAIL": "me@x.test"}')`);
    run(`JSON.parse('{"api_token": "tok", "USER_ID": 1, "USER_UUID": "u"}')`); // never captured
    const entries = queue();
    expect(entries.map((e) => e.kind)).toEqual(["schedule", "roster", "identity"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    const schedule = entries[0].payload as Array<{ id: number; aircraftId: number }>;
    expect(schedule[0].id).toBe(11);
    expect(schedule[0].aircraftId).toBe(101);
    const text = JSON.stringify(entries);
    for (const secret of Object.values(PII)) expect(text).not.toContain(secret);
    expect(text).not.toContain("api_token");
    expect(text).not.toContain("me@x.test");
  });

  it("caps the in-page queue so a long session cannot grow memory", () => {
    const { run, queue } = loadScript();
    const payload = JSON.stringify(JSON.stringify([rawAppointment({ IA_AIRCRAFT_ID: 101 })]));
    for (let i = 0; i < CAPTURE_QUEUE_MAX + 15; i++) run(`JSON.parse(${payload})`);
    const entries = queue();
    expect(entries).toHaveLength(CAPTURE_QUEUE_MAX);
    expect(entries[entries.length - 1].seq).toBe(CAPTURE_QUEUE_MAX + 15);
  });

  it("never breaks the app when a payload is odd, and installs only once", () => {
    const { run, queue } = loadScript();
    // Objects with hostile getters must not throw out of JSON.parse.
    expect(() => run(`JSON.parse('[{"IA_ID": 1, "IA_START_TIME": "x"}]')`)).not.toThrow();
    expect(queue()).toHaveLength(1);
    // Re-installing is a no-op: still one wrapper, so one parse yields exactly one new entry.
    run(buildCaptureInitScript());
    run(`JSON.parse(${JSON.stringify(JSON.stringify([rawRosterRow()]))})`);
    expect(queue().map((e) => e.seq)).toEqual([1, 2]);
  });
});
