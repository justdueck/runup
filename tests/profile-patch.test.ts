import { describe, expect, it } from "vitest";
import { buildProfilePatch, MINIMUMS_FIELDS, readNumberField, type FieldReader } from "../src/ui/profile-patch.js";
import { ProfilePatchSchema } from "../src/profile.js";

/** Map-backed stand-in for FormData: missing keys read as null, cleared inputs as "". */
function reader(values: Record<string, string>): FieldReader {
  return (name) => (name in values ? values[name] : null);
}

function fullForm(overrides: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = {
    homeAirports: "KPAE, KTIW",
    "preferences.maxDistanceNm": "250",
    "preferences.budgetPerFlightUsd": "300",
  };
  const defaults = { ceilingFt: "3000", visSm: "5", windKt: "20", gustSpreadKt: "10", crosswindKt: "8" };
  for (const block of ["day", "night"]) {
    for (const [key, v] of Object.entries(defaults)) values[`minimums.${block}.${key}`] = v;
  }
  return { ...values, ...overrides };
}

describe("profile form patch builder", () => {
  it("omits a cleared minimums field instead of persisting a silent 0", () => {
    const patch = buildProfilePatch(reader(fullForm({ "minimums.day.crosswindKt": "" }))) as {
      minimums: { day: Record<string, number>; night: Record<string, number> };
    };
    expect(patch.minimums.day).not.toHaveProperty("crosswindKt"); // cleared -> leave unchanged
    expect(patch.minimums.day.ceilingFt).toBe(3000); // siblings still sent
    expect(patch.minimums.night.crosswindKt).toBe(8); // other block untouched
    // The patch stays valid for update_profile (blocks are partial).
    expect(ProfilePatchSchema.safeParse(patch).success).toBe(true);
  });

  it("keeps an explicit 0 and fractional visibility", () => {
    const patch = buildProfilePatch(
      reader(fullForm({ "minimums.night.gustSpreadKt": "0", "minimums.day.visSm": " 1.5 " })),
    ) as { minimums: { day: Record<string, number>; night: Record<string, number> } };
    expect(patch.minimums.night.gustSpreadKt).toBe(0); // typed zero is a real value
    expect(patch.minimums.day.visSm).toBe(1.5); // fractional SM allowed
    expect(ProfilePatchSchema.safeParse(patch).success).toBe(true);
  });

  it("reads whitespace/absent/garbage numeric fields as unchanged", () => {
    const read = reader({ blank: "   ", garbage: "abc", zero: "0", half: "0.5" });
    expect(readNumberField(read, "blank")).toBeUndefined();
    expect(readNumberField(read, "garbage")).toBeUndefined();
    expect(readNumberField(read, "missing")).toBeUndefined();
    expect(readNumberField(read, "zero")).toBe(0);
    expect(readNumberField(read, "half")).toBe(0.5);
  });

  it("parses home airports into an uppercase list and drops cleared preferences", () => {
    const patch = buildProfilePatch(
      reader(fullForm({ homeAirports: " kbfi,kpae  s43", "preferences.budgetPerFlightUsd": "" })),
    ) as { homeAirports: string[]; preferences?: Record<string, number> };
    expect(patch.homeAirports).toEqual(["KBFI", "KPAE", "S43"]);
    expect(patch.preferences).toEqual({ maxDistanceNm: 250 }); // cleared budget omitted
  });

  it("keeps whole-number steps for knots/feet and a fractional step for visibility", () => {
    const steps = Object.fromEntries(MINIMUMS_FIELDS.map((f) => [f.key, f.step]));
    expect(steps.visSm).toBe("any");
    expect(steps.windKt).toBe("1");
    expect(steps.crosswindKt).toBe("1");
    expect(steps.gustSpreadKt).toBe("1");
  });
});
