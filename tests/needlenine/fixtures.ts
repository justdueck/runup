/**
 * Synthetic NeedleNine fixtures (fake tails, ids, and people — no real data).
 * Raw shapes mirror the documented IA_* (appointment) and FI_* (roster)
 * records so tests exercise the real projection code paths.
 */
import { zonedDateTimeToUtcMs } from "../../src/providers/needlenine/time.js";

export const TZ = "America/Los_Angeles";

/** Strings that must never appear in tool output (other members' identities in raw fixtures). */
export const PII = {
  studentName: "Alice Otherperson",
  studentEmail: "alice.pii@example.invalid",
  instructorName: "Bob Instructorname",
  instructorEmail: "bob.cfi.pii@example.invalid",
  squawkNote: "reported by Member Fullname on the ramp",
} as const;

/** Naive UTC "YYYY-MM-DD HH:mm:ss" of an epoch-ms instant. */
export function naiveUtcStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Tenant-local wall clock -> naive UTC stamp string. */
export function stamp(date: string, hhmm: string, timeZone: string = TZ): string {
  return naiveUtcStamp(zonedDateTimeToUtcMs(date, hhmm, timeZone));
}

let nextId = 481200;

/** Raw appointment record (IA_* fields) with realistic nested objects and PII the projection must drop. */
export function rawAppointment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (overrides.IA_ID as number | undefined) ?? nextId++;
  return {
    IA_ID: id,
    IA_AIRCRAFT_ID: 0,
    IA_INSTRUCTOR_ID: 91001,
    IA_USER_ID: 92002,
    IA_TENANT_ID: 77,
    IA_LOCATION_ID: "loc-uuid-1",
    IA_START_TIME: "2026-07-24 17:00:00",
    IA_END_TIME: "2026-07-24 19:00:00",
    IA_PRE_BRIEF_TIME: null,
    IA_POST_BRIEF_TIME: null,
    IA_PRE_BRIEF_ORI_TIME: "2026-07-24 17:00:00",
    IA_POST_BRIEF_ORI_TIME: "2026-07-24 19:00:00",
    IA_FLIGHT_TYPE: 5,
    IA_APPOINTMENT_STATUS: 1,
    IA_APPOINTMENT_CHECK_IN_STATUS: 0,
    IA_POTENTIAL_STATUS: 1,
    IA_APPOINTMENT_COMMENT: `Bring headset — ${PII.studentName}`,
    IA_ALTERNATE_APPOINTMENT: 0,
    IA_COURSE_ID: 12,
    IA_LESSON_ID: 34,
    IA_IS_FLIGHT_SCHEDULE: 1,
    IA_IS_GROUND_SCHEDULE: 0,
    IA_CREATED_BY: 92002,
    IA_MODIFIED_BY: 92002,
    IA_CREATED_DATE: "2026-07-20 15:00:00",
    IA_MODIFIED_DATE: "2026-07-20 15:00:00",
    IA_DELETE_APPOINTMENT_REASON: "",
    IA_DELETE_APPOINTMENT_COMMENT: "",
    aircraft: null,
    instructor: {
      USER_ID: 91001,
      USER_UUID: "instructor-uuid-1",
      USER_EMAIL: PII.instructorEmail,
      USER_TYPE: 3,
      USER_STATUS: 1,
      userinfo: { UI_ID: 1, UI_USER_ID: 91001, UI_FIRST_NAME: PII.instructorName.split(" ")[0], UI_LAST_NAME: PII.instructorName.split(" ")[1] },
    },
    user: { UI_ID: 2, UI_USER_ID: 92002, UI_FIRST_NAME: PII.studentName.split(" ")[0], UI_LAST_NAME: PII.studentName.split(" ")[1] },
    userbase: { USER_ID: 92002, USER_UUID: "student-uuid-1", USER_EMAIL: PII.studentEmail, USER_TYPE: 1, USER_STATUS: 1 },
    createdby: null,
    updatedby: null,
    course: { COU_ID: 12, COU_NAME: "Private Pilot" },
    lesson_detail: { LES_ID: 34, LES_TITLE: "Stalls", LES_COURSE_ID: 12 },
    checkout: null,
    location: { LOC_UUID: "loc-uuid-1", LOC_AIRPORT: "KRNT" },
    ...overrides,
  };
}

/** Raw roster row (FI_* fields). */
export function rawRosterRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FI_ID: 101,
    FI_TAIL_NUMBER: "N11111 (RFS101)",
    FI_GROP: 5,
    FI_MODEL_CODE: "C172 G1000",
    FI_LOCATION_ID: "loc-uuid-1",
    FI_STATUS: 1,
    AS_SEQUENCE_NUMBER: 1,
    flightgroup: { AG_ID: 5, AG_NAME: "C172 G1000", AG_STATUS: 1 },
    maintenance: [],
    opendiscrepancies: [],
    changelocation: null,
    relocatelocation: null,
    ...overrides,
  };
}
