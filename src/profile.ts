/**
 * Pilot profile & personal minimums store.
 *
 * Persists a single JSON document at:
 *   ${RUNUP_HOME:-~/.runup}/profile.json
 *
 * Scheduler/flight-school credentials must never be written here — see the
 * TODO stub at the bottom of this file for the intended OS-keychain approach.
 * The one sensitive value the profile MAY hold is `calendar.icalUrls`
 * (private iCal feed URLs, a fallback for the RUNUP_ICAL_URLS env var); it
 * is redacted from every tool result via {@link redactProfile}, and this file
 * lives outside the repo (${RUNUP_HOME:-~/.runup}) and is gitignored.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isValidTimeZone } from "./tz.js";
import { writeFileAtomic } from "./util.js";

export const PROFILE_SCHEMA_VERSION = 1 as const;

/** Default IANA zone for the sample pilot (Puget Sound). */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

/** ICAO / FAA identifier, e.g. "KPAE" or "S43" (normalized to uppercase). */
export const AirportIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Za-z0-9]{3,4}$/, { message: "expected a 3-4 character airport identifier (e.g. KPAE)" });

/**
 * The pilot's home airports (ICAO/FAA ids). At least one; order matters:
 * the first entry is the primary field. Patches replace the whole list.
 */
export const HomeAirportsSchema = z
  .array(AirportIdSchema)
  .min(1, { message: "at least one home airport is required" });

export const MinimumsBlockSchema = z.object({
  /** Lowest ceiling (ft AGL) the pilot will fly under. */
  ceilingFt: z.number().nonnegative(),
  /** Lowest visibility (statute miles). */
  visSm: z.number().nonnegative(),
  /** Max steady surface wind (kt). */
  windKt: z.number().nonnegative(),
  /** Max gust spread, i.e. gust minus steady wind (kt). */
  gustSpreadKt: z.number().nonnegative(),
  /** Max crosswind component on the runway in use (kt). */
  crosswindKt: z.number().nonnegative(),
});
export type MinimumsBlock = z.infer<typeof MinimumsBlockSchema>;

export const PersonalMinimumsSchema = z.object({
  day: MinimumsBlockSchema,
  night: MinimumsBlockSchema,
});
export type PersonalMinimums = z.infer<typeof PersonalMinimumsSchema>;

export const AircraftSchema = z.object({
  tail: z.string().trim().min(1),
  type: z.string().trim().min(1),
  /** Whether the pilot is currently checked out in this tail/type at the school. */
  checkedOut: z.boolean(),
  cruiseKtas: z.number().positive(),
  fuelBurnGph: z.number().positive(),
  usableFuelGal: z.number().positive(),
  notes: z.string().optional(),
});
export type Aircraft = z.infer<typeof AircraftSchema>;

export const CurrencyGoalsSchema = z.object({
  nightLandings: z.boolean(),
  ifrApproaches: z.boolean(),
  passengerCurrency: z.boolean(),
  notes: z.string().optional(),
});
export type CurrencyGoals = z.infer<typeof CurrencyGoalsSchema>;

/** IANA time zone name, e.g. "America/Los_Angeles" (must be known to this runtime). */
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => isValidTimeZone(tz), { message: 'expected an IANA time zone such as "America/Los_Angeles"' });

/** Local wall-clock time "HH:MM" (24 h). */
export const LocalTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'expected a 24-hour "HH:MM" time such as "07:00"' });

export const PreferencesSchema = z
  .object({
    /** e.g. "local practice", "cross-country", "food run". */
    typicalFlightKinds: z.array(z.string().trim().min(1)),
    /** Round-trip planning cap in nautical miles. */
    maxDistanceNm: z.number().positive(),
    budgetPerFlightUsd: z.number().positive(),
    /** The pilot's home IANA time zone; calendar days / flyable hours are interpreted here. */
    timezone: TimeZoneSchema.default(DEFAULT_TIME_ZONE),
    /** Earliest local time a free window may start (flyable hours). */
    earliestLocalTime: LocalTimeSchema.default("07:00"),
    /** Latest local time a free window may end (flyable hours). */
    latestLocalTime: LocalTimeSchema.default("21:00"),
  })
  .refine((p) => p.earliestLocalTime < p.latestLocalTime, {
    message: "earliestLocalTime must be before latestLocalTime",
    path: ["latestLocalTime"],
  });
export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * iCal / ICS calendar source. `icalUrls` are BEARER SECRETS (a Google
 * Calendar "secret address in iCal format" grants read access to anyone who
 * has it): prefer the RUNUP_ICAL_URLS environment variable; the values here
 * are the fallback and are always redacted in tool output.
 */
export const CalendarConfigSchema = z.object({
  /** Private iCal (ICS) feed URLs. Never echoed back by any tool (see {@link redactProfile}). */
  icalUrls: z.array(z.string().trim().min(1)).default([]),
  /** Whether all-day calendar events block the day (default: they don't). */
  allDayEventsBlock: z.boolean().default(false),
  /** Minutes to keep clear before each event. */
  bufferBeforeMinutes: z.number().nonnegative().default(60),
  /** Minutes to keep clear after each event. */
  bufferAfterMinutes: z.number().nonnegative().default(30),
  /** Free windows shorter than this many hours are dropped (default). */
  minDurationHours: z.number().positive().default(2.5),
});
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;

export const ProfileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  homeAirports: HomeAirportsSchema,
  aircraft: z.array(AircraftSchema),
  minimums: PersonalMinimumsSchema,
  currencyGoals: CurrencyGoalsSchema,
  preferences: PreferencesSchema,
  // Defaulted so profile.json files written before the calendar leg still validate.
  calendar: CalendarConfigSchema.default(() => defaultCalendarConfig()),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Patch shape accepted by `update_profile`: every section optional, minimums
 * blocks individually partial. `schemaVersion` is intentionally not patchable.
 * Arrays (`homeAirports`, `aircraft`, `calendar.icalUrls`), when present,
 * replace the whole list (simplest predictable rule). Patch fields never
 * carry defaults, so an omitted field always means "leave unchanged".
 */
export const ProfilePatchSchema = z
  .object({
    homeAirports: HomeAirportsSchema.optional(),
    aircraft: z.array(AircraftSchema).optional(),
    minimums: z
      .object({
        day: MinimumsBlockSchema.partial().optional(),
        night: MinimumsBlockSchema.partial().optional(),
      })
      .optional(),
    currencyGoals: CurrencyGoalsSchema.partial().optional(),
    preferences: z
      .object({
        typicalFlightKinds: z.array(z.string().trim().min(1)).optional(),
        maxDistanceNm: z.number().positive().optional(),
        budgetPerFlightUsd: z.number().positive().optional(),
        timezone: TimeZoneSchema.optional(),
        earliestLocalTime: LocalTimeSchema.optional(),
        latestLocalTime: LocalTimeSchema.optional(),
      })
      .optional(),
    calendar: z
      .object({
        icalUrls: z
          .array(z.string().trim().min(1))
          .optional()
          .describe(
            "Private iCal (ICS) feed URLs (bearer secrets - prefer the RUNUP_ICAL_URLS env var). " +
              "Replaces the whole list; redacted placeholders are ignored.",
          ),
        allDayEventsBlock: z.boolean().optional(),
        bufferBeforeMinutes: z.number().nonnegative().optional(),
        bufferAfterMinutes: z.number().nonnegative().optional(),
        minDurationHours: z.number().positive().optional(),
      })
      .optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

/** Default calendar block: no feed configured, sensible buffers around events. */
export function defaultCalendarConfig(): CalendarConfig {
  return {
    icalUrls: [],
    allDayEventsBlock: false,
    bufferBeforeMinutes: 60,
    bufferAfterMinutes: 30,
    minDurationHours: 2.5,
  };
}

/** Sensible starter values; placeholders the pilot should personalize. */
export function defaultProfile(): Profile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    // First entry is the primary field. KPAE = Paine Field (Everett, WA),
    // KTIW = Tacoma Narrows (WA).
    homeAirports: ["KPAE", "KTIW"],
    aircraft: [],
    minimums: {
      day: { ceilingFt: 3000, visSm: 5, windKt: 20, gustSpreadKt: 10, crosswindKt: 8 },
      night: { ceilingFt: 5000, visSm: 7, windKt: 15, gustSpreadKt: 8, crosswindKt: 6 },
    },
    currencyGoals: {
      nightLandings: true,
      ifrApproaches: false,
      passengerCurrency: true,
      notes: "Keep passenger (3 T/O + landings in 90 days) and night currency.",
    },
    preferences: {
      typicalFlightKinds: ["local practice", "cross-country", "food run"],
      maxDistanceNm: 250,
      budgetPerFlightUsd: 300,
      timezone: DEFAULT_TIME_ZONE,
      earliestLocalTime: "07:00",
      latestLocalTime: "21:00",
    },
    calendar: defaultCalendarConfig(),
  };
}

// --- Secret handling: iCal URLs are redacted from every tool result -------------

/** Placeholder shown wherever a configured iCal URL would otherwise appear. */
export const REDACTED_ICAL_URL = "***configured***";

/**
 * Copy of the profile safe to return from tools / render in the UI: every
 * configured iCal URL is replaced by {@link REDACTED_ICAL_URL} (the count
 * survives, the secret does not).
 */
export function redactProfile(profile: Profile): Profile {
  const clone = structuredClone(profile);
  clone.calendar.icalUrls = clone.calendar.icalUrls.map(() => REDACTED_ICAL_URL);
  return clone;
}

/**
 * Drop redacted placeholders from a patch's `calendar.icalUrls` so a client
 * that round-trips the (redacted) profile can never overwrite the stored
 * secrets with placeholders. If only placeholders were sent, the whole key
 * is removed (meaning "leave the configured URLs unchanged"); an explicit
 * empty array still clears them.
 */
export function stripRedactedIcalUrls(patch: ProfilePatch): ProfilePatch {
  const urls = patch.calendar?.icalUrls;
  if (!urls || urls.length === 0) return patch;
  const real = urls.filter((u) => u.trim() !== REDACTED_ICAL_URL);
  const next: ProfilePatch = structuredClone(patch);
  if (real.length === 0) delete next.calendar!.icalUrls;
  else next.calendar!.icalUrls = real;
  return next;
}

export class ProfileValidationError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

/** Directory holding profile.json (env override: RUNUP_HOME). */
export function profileHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RUNUP_HOME;
  if (configured && configured.trim().length > 0) return configured;
  return path.join(os.homedir(), ".runup");
}

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(profileHomeDir(env), "profile.json");
}

/** Load the profile; returns defaults when the file does not exist yet. */
export async function loadProfile(filePath: string = profilePath()): Promise<Profile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultProfile();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProfileValidationError(`profile.json is not valid JSON: ${(err as Error).message}`, []);
  }
  return validateProfile(parsed);
}

/** Validate arbitrary input against the profile schema (throws ProfileValidationError). */
export function validateProfile(input: unknown): Profile {
  const result = ProfileSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new ProfileValidationError("profile failed schema validation", issues);
  }
  return result.data;
}

/** Validate then persist the profile (pretty JSON, atomic write, serialized per file). */
export async function saveProfile(profile: Profile, filePath: string = profilePath()): Promise<Profile> {
  return enqueueSave(filePath, () => writeProfileFile(profile, filePath));
}

/**
 * Validate and atomically write the profile as pretty JSON so readers never
 * see a partial write. Callers must hold the file's save queue
 * ({@link enqueueSave}).
 */
async function writeProfileFile(profile: Profile, filePath: string): Promise<Profile> {
  const valid = validateProfile(profile);
  await writeFileAtomic(filePath, `${JSON.stringify(valid, null, 2)}\n`);
  return valid;
}

/**
 * Per-file save queues. `patchProfile` is a read-modify-write, so without
 * serialization two overlapping `update_profile` calls could both read the
 * same starting profile and the later write would silently drop the earlier
 * patch. Tasks run strictly in submission order; a failed task does not
 * poison the queue for later ones.
 */
const saveQueues = new Map<string, Promise<unknown>>();

function enqueueSave<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  saveQueues.set(key, run);
  const settled = (): void => {
    if (saveQueues.get(key) === run) saveQueues.delete(key);
  };
  run.then(settled, settled);
  return run;
}

/**
 * Pure merge of a patch onto a profile: objects merge recursively, arrays and
 * scalars are replaced. Result is re-validated.
 */
export function applyProfilePatch(profile: Profile, patch: ProfilePatch): Profile {
  const cleanPatch = ProfilePatchSchema.parse(patch);
  const merged = deepMerge(structuredClone(profile) as Record<string, unknown>, cleanPatch as Record<string, unknown>);
  return validateProfile(merged);
}

/**
 * Load, patch, save, and return the updated profile. The whole
 * read-modify-write runs in the file's save queue, so overlapping calls
 * apply in order and both patches persist.
 */
export async function patchProfile(patch: ProfilePatch, filePath: string = profilePath()): Promise<Profile> {
  return enqueueSave(filePath, async () => {
    const current = await loadProfile(filePath);
    const next = applyProfilePatch(current, patch);
    return writeProfileFile(next, filePath);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = deepMerge(base[key] as Record<string, unknown>, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/**
 * TODO(credentials): flight-school scheduler credentials.
 *
 * NOT implemented on purpose. Credentials must never be stored in
 * profile.json (that file is plain text, meant to be readable/portable).
 * The plan is to keep them in the OS keychain — macOS Keychain via the
 * `security` CLI / Keychain Services, Windows Credential Manager, or
 * libsecret on Linux (a small cross-platform module such as `keytar` or the
 * platform CLIs). The NeedleNineProvider will call this to fetch the
 * NeedleNine portal email/password (or a session token) at runtime.
 */
export async function getSchedulerCredentials(): Promise<never> {
  throw new Error(
    "Scheduler credential storage is not implemented yet: use the OS keychain, never profile.json.",
  );
}
