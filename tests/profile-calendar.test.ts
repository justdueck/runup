import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProfilePatch,
  defaultProfile,
  loadProfile,
  ProfilePatchSchema,
  ProfileSchema,
  redactProfile,
  REDACTED_ICAL_URL,
  stripRedactedIcalUrls,
} from "../src/profile.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "runup-profile-cal-"));
  file = path.join(dir, "profile.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("calendar config & preferences additions", () => {
  it("defaults the calendar block, time zone and flyable hours", () => {
    const profile = defaultProfile();
    expect(profile.calendar).toEqual({
      icalUrls: [],
      allDayEventsBlock: false,
      bufferBeforeMinutes: 60,
      bufferAfterMinutes: 30,
      minDurationHours: 2.5,
    });
    expect(profile.preferences.timezone).toBe("America/Los_Angeles");
    expect(profile.preferences.earliestLocalTime).toBe("07:00");
    expect(profile.preferences.latestLocalTime).toBe("21:00");
    expect(ProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("fills the new fields when loading a pre-calendar profile.json (schemaVersion 1)", async () => {
    const legacy = defaultProfile() as unknown as Record<string, unknown>;
    delete legacy.calendar;
    const { timezone: _tz, earliestLocalTime: _e, latestLocalTime: _l, ...oldPrefs } = defaultProfile().preferences;
    legacy.preferences = oldPrefs;
    await writeFile(file, JSON.stringify(legacy), "utf8");
    const loaded = await loadProfile(file);
    expect(loaded.calendar).toEqual(defaultProfile().calendar);
    expect(loaded.preferences.timezone).toBe("America/Los_Angeles");
    expect(loaded.preferences.latestLocalTime).toBe("21:00");
  });

  it("validates the time zone, HH:MM times and their ordering", () => {
    expect(ProfilePatchSchema.safeParse({ preferences: { timezone: "Not/A_Zone" } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ preferences: { timezone: "Europe/Berlin" } }).success).toBe(true);
    expect(ProfilePatchSchema.safeParse({ preferences: { earliestLocalTime: "7am" } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ preferences: { earliestLocalTime: "07:00" } }).success).toBe(true);
    // Ordering is enforced on the merged profile.
    expect(() =>
      applyProfilePatch(defaultProfile(), { preferences: { earliestLocalTime: "22:00", latestLocalTime: "06:00" } }),
    ).toThrow(/schema validation/);
    expect(ProfilePatchSchema.safeParse({ calendar: { bufferBeforeMinutes: -5 } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ calendar: { minDurationHours: 0 } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ calendar: { allDayEventsBlock: true, icalUrls: ["https://x"] } }).success).toBe(true);
  });

  it("deep-merges calendar patches without a defaults reset", () => {
    const base = defaultProfile();
    const patched = applyProfilePatch(base, {
      preferences: { latestLocalTime: "20:00" },
      calendar: { bufferAfterMinutes: 15 },
    });
    expect(patched.preferences.latestLocalTime).toBe("20:00");
    expect(patched.preferences.timezone).toBe("America/Los_Angeles"); // sibling not reset to a default
    expect(patched.calendar.bufferAfterMinutes).toBe(15);
    expect(patched.calendar.bufferBeforeMinutes).toBe(60); // sibling survives
  });

  it("redacts iCal URLs and strips echoed placeholders from patches", () => {
    const profile = defaultProfile();
    profile.calendar.icalUrls = ["https://feed.example/one.ics", "https://feed.example/two.ics"];
    const redacted = redactProfile(profile);
    expect(redacted.calendar.icalUrls).toEqual([REDACTED_ICAL_URL, REDACTED_ICAL_URL]);
    expect(profile.calendar.icalUrls[0]).toBe("https://feed.example/one.ics"); // input untouched

    // Placeholder-only lists mean "leave unchanged" (key removed) ...
    expect(stripRedactedIcalUrls({ calendar: { icalUrls: [REDACTED_ICAL_URL] } })).toEqual({ calendar: {} });
    // ... a real URL mixed with placeholders keeps only the real one ...
    expect(stripRedactedIcalUrls({ calendar: { icalUrls: [REDACTED_ICAL_URL, "https://new.example/a.ics"] } })).toEqual({
      calendar: { icalUrls: ["https://new.example/a.ics"] },
    });
    // ... and an explicit empty list still clears the feed.
    expect(stripRedactedIcalUrls({ calendar: { icalUrls: [] } })).toEqual({ calendar: { icalUrls: [] } });
  });
});
