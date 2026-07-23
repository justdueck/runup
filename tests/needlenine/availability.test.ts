import { describe, expect, it } from "vitest";
import {
  assessTail,
  busyBlocksForAircraft,
  computeAvailability,
  matchTailsToRoster,
  mergeIntervals,
  normalizeTailNumber,
  rosterFlags,
  subtractIntervals,
  tailCandidates,
} from "../../src/providers/needlenine/availability.js";
import { projectRosterRecords, projectScheduleRecords } from "../../src/providers/needlenine/site.js";
import { zonedDateTimeToUtcMs } from "../../src/providers/needlenine/time.js";
import { makeWindow } from "../../src/types.js";
import { rawAppointment, rawRosterRow, stamp, TZ } from "./fixtures.js";

const OWN_USER = 90099;

/** Local (America/Los_Angeles) instant helper. */
const at = (date: string, hhmm: string): number => zonedDateTimeToUtcMs(date, hhmm, TZ);

const roster = projectRosterRecords([
  rawRosterRow({ FI_ID: 101, FI_TAIL_NUMBER: "N11111 (RFS101)" }),
  rawRosterRow({ FI_ID: 202, FI_TAIL_NUMBER: "N22222 (RFS202)" }),
  rawRosterRow({
    FI_ID: 303,
    FI_TAIL_NUMBER: "N33333 (RFS303)",
    maintenance: [{ MAI_ID: 1, MAI_NAME: "100 Hour", MAI_EXPIRATION_DATE: null, MAI_HOURS_REMAINING: -1.5, MAI_REQ_FOR_DISPATCH: 1 }],
    opendiscrepancies: [{ DIS_ID: 1, DIS_TYPE: "2", DIS_DESCRIPTION: "PII squawk text", DIS_RESTRICTIONS: "DAY ONLY", DIS_STATUS: 1 }],
  }),
  rawRosterRow({ FI_ID: 404, FI_TAIL_NUMBER: "Frasca - 40404", FI_GROP: 9 }),
  rawRosterRow({ FI_ID: 505, FI_TAIL_NUMBER: "N55555 (RFS505)", FI_STATUS: 3 }),
]);

describe("tail matching", () => {
  it("normalizes and derives comparable candidates from display strings", () => {
    expect(normalizeTailNumber("  n556nd \t(rfs720) ")).toBe("N556ND (RFS720)");
    expect(tailCandidates("N556ND (RFS720)")).toEqual(["N556ND (RFS720)", "N556ND"]);
    expect(tailCandidates("Frasca - 14837")).toEqual(["FRASCA - 14837"]);
    expect(tailCandidates("N678SP")).toEqual(["N678SP"]);
  });

  it("matches profile tails to roster rows, tolerating the fleet-code suffix", () => {
    const map = matchTailsToRoster(["n11111", "N22222", "N99999", "Frasca - 40404"], roster);
    expect(map.get("n11111")?.id).toBe(101);
    expect(map.get("N22222")?.id).toBe(202);
    expect(map.get("N99999")).toBeNull();
    expect(map.get("Frasca - 40404")?.id).toBe(404);
  });

  it("prefers the active row when a tail appears twice", () => {
    const dup = projectRosterRecords([
      rawRosterRow({ FI_ID: 1, FI_TAIL_NUMBER: "N11111 (OLD)", FI_STATUS: 3 }),
      rawRosterRow({ FI_ID: 2, FI_TAIL_NUMBER: "N11111 (NEW)", FI_STATUS: 1 }),
    ]);
    expect(matchTailsToRoster(["N11111"], dup).get("N11111")?.id).toBe(2);
  });
});

describe("interval math", () => {
  it("merges overlapping and touching intervals, dropping empty ones", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 }, // touching
        { start: 25, end: 28 }, // nested
        { start: 40, end: 40 }, // empty
        { start: 50, end: 45 }, // inverted
        { start: 5, end: 8 },
      ]),
    ).toEqual([
      { start: 5, end: 8 },
      { start: 10, end: 30 },
    ]);
    expect(mergeIntervals([])).toEqual([]);
  });

  it("subtracts busy from the window, clipping at both edges", () => {
    const window = { start: 100, end: 200 };
    expect(subtractIntervals(window, [{ start: 50, end: 120 }, { start: 150, end: 160 }, { start: 190, end: 300 }])).toEqual([
      { start: 120, end: 150 },
      { start: 160, end: 190 },
    ]);
    expect(subtractIntervals(window, [])).toEqual([window]);
    expect(subtractIntervals(window, [{ start: 0, end: 400 }])).toEqual([]);
    expect(subtractIntervals(window, [{ start: 200, end: 250 }])).toEqual([window]); // touching end = free
    expect(subtractIntervals(window, [{ start: 0, end: 100 }])).toEqual([window]); // touching start = free
  });
});

describe("busyBlocksForAircraft", () => {
  const day = "2026-07-24";
  const records = projectScheduleRecords([
    rawAppointment({ IA_ID: 1, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00"), IA_FLIGHT_TYPE: 5 }),
    // cancelled by status -> ignored
    rawAppointment({ IA_ID: 2, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "12:00"), IA_END_TIME: stamp(day, "14:00"), IA_APPOINTMENT_STATUS: 2 }),
    // deleted via delete reason -> ignored
    rawAppointment({ IA_ID: 3, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "14:00"), IA_END_TIME: stamp(day, "15:00"), IA_DELETE_APPOINTMENT_REASON: "wx" }),
    // maintenance block
    rawAppointment({ IA_ID: 4, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "15:00"), IA_END_TIME: stamp(day, "17:00"), IA_FLIGHT_TYPE: 3, IA_APPOINTMENT_STATUS: 5 }),
    // own reservation
    rawAppointment({ IA_ID: 5, IA_AIRCRAFT_ID: 101, IA_USER_ID: OWN_USER, IA_START_TIME: stamp(day, "17:00"), IA_END_TIME: stamp(day, "18:00") }),
    // other aircraft -> ignored
    rawAppointment({ IA_ID: 6, IA_AIRCRAFT_ID: 202, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00") }),
    // duplicate id (same day captured twice) -> counted once
    rawAppointment({ IA_ID: 1, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00") }),
    // no aircraft (ground lesson) -> ignored
    rawAppointment({ IA_ID: 7, IA_AIRCRAFT_ID: 0, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00") }),
    // malformed times -> ignored
    rawAppointment({ IA_ID: 8, IA_AIRCRAFT_ID: 101, IA_START_TIME: "not a stamp", IA_END_TIME: stamp(day, "12:00") }),
    // zero-length -> ignored
    rawAppointment({ IA_ID: 9, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "18:00"), IA_END_TIME: stamp(day, "18:00") }),
  ]);

  it("keeps only real busy blocks with the right kinds and neutral labels", () => {
    const blocks = busyBlocksForAircraft(records, 101, { ownUserId: OWN_USER });
    expect(blocks).toEqual([
      { start: at(day, "10:00"), end: at(day, "12:00"), kind: "reservation", label: "training booking" },
      { start: at(day, "15:00"), end: at(day, "17:00"), kind: "maintenance", label: "maintenance block" },
      { start: at(day, "17:00"), end: at(day, "18:00"), kind: "own-reservation", label: "training booking" },
    ]);
  });

  it("treats time-off rows attached to an aircraft as 'other'", () => {
    const timeOff = projectScheduleRecords([
      rawAppointment({ IA_ID: 20, IA_AIRCRAFT_ID: 101, IA_FLIGHT_TYPE: 6, IA_START_TIME: stamp(day, "08:00"), IA_END_TIME: stamp(day, "09:00") }),
    ]);
    expect(busyBlocksForAircraft(timeOff, 101)[0]).toMatchObject({ kind: "other", label: "time off" });
  });

  it("extends a still-dispatched flight past its scheduled end until now", () => {
    const late = projectScheduleRecords([
      rawAppointment({
        IA_ID: 30,
        IA_AIRCRAFT_ID: 101,
        IA_START_TIME: stamp(day, "08:00"),
        IA_END_TIME: stamp(day, "10:00"),
        checkout: { CA_ID: 1, CA_STATUS: 1 }, // checked out, not back in
      }),
    ]);
    const now = at(day, "10:45");
    const [block] = busyBlocksForAircraft(late, 101, { nowMs: now });
    expect(block.end).toBe(now);
    expect(block.label).toBe("training booking (still checked out)");
    // Checked back in (CA_STATUS 2): scheduled end stands.
    const backIn = projectScheduleRecords([
      rawAppointment({ IA_ID: 31, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "08:00"), IA_END_TIME: stamp(day, "10:00"), checkout: { CA_ID: 2, CA_STATUS: 2 } }),
    ]);
    expect(busyBlocksForAircraft(backIn, 101, { nowMs: now })[0].end).toBe(at(day, "10:00"));
  });
});

describe("rosterFlags", () => {
  it("grounds a tail with overdue dispatch-required maintenance and reports discrepancies", () => {
    const row = roster.find((r) => r.id === 303)!;
    const { flags, grounded } = rosterFlags(row, "2026-07-24");
    expect(grounded).toBe(true);
    expect(flags).toContain("dispatch-required maintenance overdue: 100 Hour (1.5 h overdue)");
    expect(flags).toContain("open discrepancy (type 2; restrictions: DAY ONLY)");
    expect(flags.join(" ")).not.toContain("PII squawk text");
  });

  it("uses local-date comparison for expiration dates and ignores non-dispatch items", () => {
    const rows = projectRosterRecords([
      rawRosterRow({
        FI_ID: 1,
        maintenance: [
          { MAI_NAME: "Annual", MAI_EXPIRATION_DATE: "2026-07-23", MAI_HOURS_REMAINING: null, MAI_REQ_FOR_DISPATCH: 1 },
          { MAI_NAME: "Oil change", MAI_EXPIRATION_DATE: "2026-01-01", MAI_HOURS_REMAINING: -50, MAI_REQ_FOR_DISPATCH: 0 },
        ],
      }),
    ]);
    expect(rosterFlags(rows[0], "2026-07-23").grounded).toBe(false); // expires today: still valid today
    const overdue = rosterFlags(rows[0], "2026-07-24");
    expect(overdue.grounded).toBe(true);
    expect(overdue.flags).toEqual(["dispatch-required maintenance overdue: Annual (expired 2026-07-23)"]);
  });

  it("flags inactive and relocating aircraft", () => {
    const inactive = roster.find((r) => r.id === 505)!;
    expect(rosterFlags(inactive, "2026-07-24")).toEqual({
      flags: ["aircraft is not active on the school roster"],
      grounded: true,
    });
    const moving = projectRosterRecords([rawRosterRow({ FI_ID: 6, relocatelocation: { R: 1 } })])[0];
    const result = rosterFlags(moving, "2026-07-24");
    expect(result.grounded).toBe(false);
    expect(result.flags[0]).toMatch(/pending location change/);
  });
});

describe("computeAvailability", () => {
  const day = "2026-07-24";
  const records = projectScheduleRecords([
    rawAppointment({ IA_ID: 1, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "10:00"), IA_END_TIME: stamp(day, "12:00") }),
    rawAppointment({ IA_ID: 2, IA_AIRCRAFT_ID: 202, IA_USER_ID: OWN_USER, IA_START_TIME: stamp(day, "11:30"), IA_END_TIME: stamp(day, "14:00") }),
    // Cancelled booking on N33333 must not block; its overdue MX grounds it anyway.
    rawAppointment({ IA_ID: 3, IA_AIRCRAFT_ID: 303, IA_START_TIME: stamp(day, "09:00"), IA_END_TIME: stamp(day, "12:00"), IA_APPOINTMENT_STATUS: 2, IA_DELETE_APPOINTMENT_REASON: "cancelled" }),
    // Stray record days away (data anomaly) must be ignored by the window filter.
    rawAppointment({ IA_ID: 4, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp("2026-08-30", "10:00"), IA_END_TIME: stamp("2026-08-30", "12:00") }),
  ]);

  function windowFor(startHm: string, endHm: string) {
    return makeWindow(new Date(at(day, startHm)), new Date(at(day, endHm)));
  }

  it("reports free intervals, blocks, flags and the whole-window free tails", () => {
    const result = computeAvailability({
      window: windowFor("09:00", "13:00"),
      tails: ["N11111", "N22222", "N33333", "N44444", "N11111"], // duplicate is de-duped
      roster,
      records,
      timeZone: TZ,
      ownUserId: OWN_USER,
      nowMs: at(day, "08:00"),
      checkDateLocal: day,
    });

    expect(result.availableTails).toEqual([]);
    expect(result.tails.map((t) => [t.tail, t.status])).toEqual([
      ["N11111", "partially-available"],
      ["N22222", "partially-available"],
      ["N33333", "unavailable"],
      ["N44444", "not-on-roster"],
    ]);

    const n1 = result.tails[0];
    expect(n1.aircraftId).toBe(101);
    expect(n1.free.map((f) => [f.startLocal, f.endLocal, f.durationHours])).toEqual([
      [`${day} 09:00`, `${day} 10:00`, 1],
      [`${day} 12:00`, `${day} 13:00`, 1],
    ]);
    expect(n1.blocks).toEqual([
      {
        start: new Date(at(day, "10:00")).toISOString(),
        end: new Date(at(day, "12:00")).toISOString(),
        startLocal: `${day} 10:00`,
        endLocal: `${day} 12:00`,
        kind: "reservation",
        label: "training booking",
      },
    ]);

    const n2 = result.tails[1];
    expect(n2.blocks.map((b) => b.kind)).toEqual(["own-reservation"]);
    expect(n2.free.map((f) => f.durationHours)).toEqual([2.5]); // 09:00-11:30

    const n3 = result.tails[2];
    expect(n3.status).toBe("unavailable");
    expect(n3.blocks).toEqual([]); // cancelled booking ignored
    expect(n3.free.map((f) => f.durationHours)).toEqual([4]); // interval math still reported
    expect(n3.flags.join(" | ")).toMatch(/maintenance overdue/);

    const n4 = result.tails[3];
    expect(n4).toMatchObject({ status: "not-on-roster", aircraftId: null, free: [], blocks: [] });
    expect(result.notes.join(" ")).toMatch(/own-reservation/);
  });

  it("lists a tail as available only when the whole window is free", () => {
    const result = computeAvailability({
      window: windowFor("07:00", "09:30"), // before every booking
      tails: ["N11111", "N22222"],
      roster,
      records,
      timeZone: TZ,
      ownUserId: OWN_USER,
      nowMs: at(day, "06:00"),
      checkDateLocal: day,
    });
    expect(result.availableTails).toEqual(["N11111", "N22222"]);
    expect(result.tails.every((t) => t.status === "available")).toBe(true);
    expect(result.tails[0].free).toEqual([
      {
        start: new Date(at(day, "07:00")).toISOString(),
        end: new Date(at(day, "09:30")).toISOString(),
        startLocal: `${day} 07:00`,
        endLocal: `${day} 09:30`,
        durationHours: 2.5,
      },
    ]);
  });

  it("marks a fully-booked window as unavailable and handles a window spanning local midnight", () => {
    const evening = projectScheduleRecords([
      // 22:00 local on the 24th until 01:00 local on the 25th (naive UTC stamps cross the UTC date too).
      rawAppointment({ IA_ID: 50, IA_AIRCRAFT_ID: 101, IA_START_TIME: stamp(day, "22:00"), IA_END_TIME: stamp("2026-07-25", "01:00") }),
    ]);
    const window = makeWindow(new Date(at(day, "22:30")), new Date(at("2026-07-25", "00:30")));
    const result = computeAvailability({
      window,
      tails: ["N11111"],
      roster,
      records: evening,
      timeZone: TZ,
      ownUserId: null,
      nowMs: at(day, "20:00"),
      checkDateLocal: day,
    });
    expect(result.tails[0].status).toBe("unavailable");
    expect(result.tails[0].free).toEqual([]);
    expect(result.tails[0].blocks[0]).toMatchObject({ startLocal: `${day} 22:00`, endLocal: "2026-07-25 01:00" });
    expect(result.availableTails).toEqual([]);
  });

  it("returns a note (and no tails) for an invalid window", () => {
    const bad = computeAvailability({
      window: { start: "not a date", end: "still not", durationHours: 0 },
      tails: ["N11111"],
      roster,
      records,
      timeZone: TZ,
      ownUserId: null,
      nowMs: 0,
      checkDateLocal: day,
    });
    expect(bad.tails).toEqual([]);
    expect(bad.notes[0]).toMatch(/Invalid window/);
  });

  it("assessTail handles a roster row without an id like an unknown tail", () => {
    const orphan = { ...roster[0], id: null };
    const result = assessTail({
      tail: "N11111",
      roster: orphan,
      records,
      window: { start: at(day, "09:00"), end: at(day, "10:00") },
      timeZone: TZ,
      ownUserId: null,
      nowMs: 0,
      checkDateLocal: day,
    });
    expect(result.status).toBe("not-on-roster");
  });
});
