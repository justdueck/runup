import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProfilePatch,
  defaultProfile,
  loadProfile,
  patchProfile,
  profileHomeDir,
  profilePath,
  ProfilePatchSchema,
  ProfileValidationError,
  saveProfile,
} from "../src/profile.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "runup-profile-"));
  file = path.join(dir, "profile.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("profile store", () => {
  it("resolves the home directory from RUNUP_HOME with a ~/.runup fallback", () => {
    expect(profileHomeDir({ RUNUP_HOME: "/tmp/custom" })).toBe("/tmp/custom");
    expect(profileHomeDir({})).toBe(path.join(os.homedir(), ".runup"));
    expect(profilePath({ RUNUP_HOME: "/tmp/custom" })).toBe("/tmp/custom/profile.json");
  });

  it("returns sane defaults when no profile exists yet", async () => {
    const profile = await loadProfile(file);
    expect(profile).toEqual(defaultProfile());
    expect(profile.homeAirports).toEqual(["KPAE", "KTIW"]);
    expect(profile.minimums.day.ceilingFt).toBeGreaterThan(0);
    expect(profile.schemaVersion).toBe(1);
  });

  it("round-trips a saved profile", async () => {
    const profile = { ...defaultProfile(), homeAirports: ["KBFI"] };
    await saveProfile(profile, file);
    const loaded = await loadProfile(file);
    expect(loaded.homeAirports).toEqual(["KBFI"]);
  });

  it("deep-merges patches: nested minimums merge, arrays replace", async () => {
    const before = defaultProfile();
    const patched = applyProfilePatch(before, {
      minimums: { day: { ceilingFt: 4000 } },
      aircraft: [
        { tail: "N678SP", type: "C172S", checkedOut: true, cruiseKtas: 115, fuelBurnGph: 9.5, usableFuelGal: 53 },
      ],
      homeAirports: ["KOLM"],
    });
    expect(patched.minimums.day.ceilingFt).toBe(4000);
    expect(patched.minimums.day.visSm).toBe(before.minimums.day.visSm); // untouched sibling survives
    expect(patched.minimums.night).toEqual(before.minimums.night);
    expect(patched.aircraft.map((a) => a.tail)).toEqual(["N678SP"]);
    expect(patched.homeAirports).toEqual(["KOLM"]); // arrays replace wholesale (not appended)
    expect(before.minimums.day.ceilingFt).toBe(3000); // input not mutated
    expect(before.homeAirports).toEqual(["KPAE", "KTIW"]); // input array not mutated
  });

  it("persists patches through patchProfile", async () => {
    await patchProfile({ homeAirports: ["khqm", " kpwt "] }, file); // trimmed + uppercased by the schema
    const loaded = await loadProfile(file);
    expect(loaded.homeAirports).toEqual(["KHQM", "KPWT"]);
  });

  it("rejects unknown keys and invalid identifiers in patches", () => {
    expect(ProfilePatchSchema.safeParse({ schemaVersion: 2 }).success).toBe(false); // not patchable
    expect(ProfilePatchSchema.safeParse({ homeAirport: "KPAE" }).success).toBe(false); // old singular key
    expect(ProfilePatchSchema.safeParse({ homeAirports: ["not-an-airport!"] }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ homeAirports: [] }).success).toBe(false); // min 1
    expect(ProfilePatchSchema.safeParse({ homeAirports: "KPAE" }).success).toBe(false); // must be a list
    expect(ProfilePatchSchema.safeParse({ homeAirports: ["S43", "0S9"] }).success).toBe(true); // FAA ids ok
    expect(ProfilePatchSchema.safeParse({ minimums: { day: { ceilingFt: -5 } } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ minimums: { day: { ceilingFt: 2500 } } }).success).toBe(true);
  });

  it("raises ProfileValidationError with issue details for a corrupt file", async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, homeAirports: ["KPAE"] }), "utf8");
    await expect(loadProfile(file)).rejects.toBeInstanceOf(ProfileValidationError);
    try {
      await loadProfile(file);
    } catch (err) {
      const issues = (err as ProfileValidationError).issues.join("\n");
      expect(issues).toMatch(/minimums/);
      expect(issues).toMatch(/aircraft/);
    }
  });

  it("rejects malformed JSON with a helpful error", async () => {
    await writeFile(file, "{ not json", "utf8");
    await expect(loadProfile(file)).rejects.toThrow(/not valid JSON/);
  });
});
