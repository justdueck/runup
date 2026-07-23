/**
 * plan_day: compose free windows -> aircraft availability -> conditions ->
 * candidate routes into one structured result the model can narrate.
 */
import { summarizeMetar, summarizeTaf, type AviationWeatherClient, type ConditionSummary, type TafSummary } from "./weather.js";
import { scoreConditions, type ScoreResult, type TimeOfDay } from "./scoring.js";
import { tagWindowsWithDaylight } from "./daylight.js";
import type { Profile } from "./profile.js";
import type { Providers } from "./providers/types.js";
import { addDays, compareLocalDates, parseLocalDate, zonedTimeToUtc } from "./tz.js";
import type { AircraftAvailability, AircraftPerformance, DateRange, RouteCandidate, TimeWindow } from "./types.js";

/** Generic light-single performance used when the profile has no usable aircraft. */
export const GENERIC_AIRCRAFT: AircraftPerformance = {
  tail: null,
  type: "generic C172-class",
  cruiseKtas: 110,
  fuelBurnGph: 9,
  usableFuelGal: 53,
};

export interface PlanningDeps {
  profile: Profile;
  providers: Providers;
  weather: AviationWeatherClient;
}

export interface PlanDayInput {
  /** Local calendar date to plan, YYYY-MM-DD (profile time zone). */
  date: string;
  timeOfDay?: TimeOfDay;
  /** Runway heading (degrees magnetic) for the crosswind check at home. */
  runwayHeadingDeg?: number;
  /** Ignore free windows shorter than this many hours (default 1.5). */
  minWindowHours?: number;
  /** Notes to lead the plan with (e.g. how the calendar source was chosen). */
  notes?: string[];
}

export interface PlannedWindow {
  window: TimeWindow;
  availability: AircraftAvailability | null;
  aircraft: AircraftPerformance;
  aircraftNotes: string[];
  routes: RouteCandidate[];
  notes: string[];
}

/** Conditions + personal-minimums score for one airport (used per home airport). */
export interface AirportConditions {
  airport: string;
  summary: ConditionSummary | null;
  score: ScoreResult | null;
  taf: TafSummary | null;
  notes: string[];
}

export interface DayPlan {
  date: string;
  /** Home airports from the profile; index 0 is the primary field. */
  homeAirports: string[];
  timeOfDay: TimeOfDay;
  /** One entry per home airport, in profile order (scored against the minimums). */
  conditions: AirportConditions[];
  windows: PlannedWindow[];
  notes: string[];
}

export async function planDay(input: PlanDayInput, deps: PlanningDeps): Promise<DayPlan> {
  const { profile, providers, weather } = deps;
  const timeOfDay: TimeOfDay = input.timeOfDay ?? "day";
  const notes: string[] = [...(input.notes ?? [])];

  const range = dayRangeInZone(input.date, profile.preferences.timezone);
  let windows: TimeWindow[] = [];
  try {
    windows = await providers.calendar.getFreeWindows(range, { minDurationHours: input.minWindowHours ?? 1.5 });
  } catch (err) {
    notes.push(`Calendar lookup failed (${providers.calendar.name}): ${(err as Error).message}`);
  }
  if (windows.length === 0) notes.push(`No free windows on ${input.date} from ${providers.calendar.name}.`);
  // Daylight is informational (day / night / mixed at the home airports); windows are never filtered by it.
  windows = tagWindowsWithDaylight(windows, profile.homeAirports, profile.preferences.timezone);

  // Score current conditions at EVERY home airport (index 0 = primary field).
  const conditions = await Promise.all(
    profile.homeAirports.map((icao) => currentConditions(icao, timeOfDay, input.runwayHeadingDeg, profile, weather)),
  );
  const noGoHomes = conditions.filter((c) => c.score?.verdict === "no-go").map((c) => c.airport);

  const planned: PlannedWindow[] = [];
  for (const window of windows) {
    const windowNotes: string[] = [];
    let availability: AircraftAvailability | null = null;
    try {
      availability = await providers.availability.getAircraftAvailability(window);
    } catch (err) {
      windowNotes.push(`Availability lookup failed (${providers.availability.name}): ${(err as Error).message}`);
    }

    const { aircraft, notes: aircraftNotes } = resolveAircraftPerformance(profile, {
      availableTails: availability?.availableTails,
    });
    const routes = await providers.routes.planRoutes(window, aircraft, profile);
    if (noGoHomes.length > 0) {
      windowNotes.push(
        `Current conditions are below personal minimums at ${noGoHomes.join(", ")} - routes departing there are for planning only.`,
      );
    }
    planned.push({ window, availability, aircraft, aircraftNotes, routes, notes: windowNotes });
  }

  notes.push(
    "Conditions are the CURRENT METAR at each home airport; matching the TAF/forecast to each future window is not implemented yet.",
  );

  return {
    date: input.date,
    homeAirports: profile.homeAirports,
    timeOfDay,
    conditions,
    windows: planned,
    notes,
  };
}

/** Current METAR at `icao`, scored against the profile minimums (errors captured as notes). */
export async function currentConditions(
  icao: string,
  timeOfDay: TimeOfDay,
  runwayHeadingDeg: number | undefined,
  profile: Profile,
  weather: AviationWeatherClient,
): Promise<AirportConditions> {
  const airport = icao.trim().toUpperCase();
  const notes: string[] = [];
  let summary: ConditionSummary | null = null;
  let score: ScoreResult | null = null;
  let taf: TafSummary | null = null;
  try {
    const [metars, tafs] = await Promise.all([weather.getMetars([airport]), weather.getTafs([airport]).catch(() => [])]);
    const metar = metars.find((m) => m.icaoId.toUpperCase() === airport);
    if (!metar) {
      notes.push(`No METAR returned for ${airport}.`);
    } else {
      summary = summarizeMetar(metar, runwayHeadingDeg !== undefined ? { runwayHeadingDeg } : {});
      score = scoreConditions(summary, profile.minimums, { timeOfDay });
    }
    const tafRecord = tafs.find((t) => t.icaoId.toUpperCase() === airport);
    if (tafRecord) taf = summarizeTaf(tafRecord);
    else notes.push(`No TAF for ${airport} (many small airports have none - use the nearest TAF station).`);
  } catch (err) {
    notes.push(`Weather fetch failed: ${(err as Error).message}`);
  }
  return { airport, summary, score, taf, notes };
}

/**
 * Choose which aircraft performance to plan with:
 * explicit tail > (available AND checked-out in profile) > any checked-out
 * profile aircraft > generic placeholder.
 */
export function resolveAircraftPerformance(
  profile: Profile,
  opts: { tail?: string; availableTails?: string[] } = {},
): { aircraft: AircraftPerformance; notes: string[] } {
  const notes: string[] = [];
  const toPerf = (a: Profile["aircraft"][number]): AircraftPerformance => ({
    tail: a.tail,
    type: a.type,
    cruiseKtas: a.cruiseKtas,
    fuelBurnGph: a.fuelBurnGph,
    usableFuelGal: a.usableFuelGal,
  });

  if (opts.tail) {
    const wanted = opts.tail.toUpperCase();
    const match = profile.aircraft.find((a) => a.tail.toUpperCase() === wanted);
    if (match) {
      if (!match.checkedOut) notes.push(`${match.tail} is not marked checked-out in your profile.`);
      return { aircraft: toPerf(match), notes };
    }
    notes.push(`Tail ${opts.tail} is not in your profile; using generic performance.`);
    return { aircraft: { ...GENERIC_AIRCRAFT, tail: opts.tail }, notes };
  }

  const checkedOut = profile.aircraft.filter((a) => a.checkedOut);
  if (opts.availableTails) {
    const available = new Set(opts.availableTails.map((t) => t.toUpperCase()));
    const usable = checkedOut.find((a) => available.has(a.tail.toUpperCase()));
    if (usable) {
      notes.push(`Planned with ${usable.tail} (${usable.type}): available and checked-out.`);
      return { aircraft: toPerf(usable), notes };
    }
    notes.push("None of your checked-out aircraft appear available in this window.");
  }
  if (checkedOut.length > 0) {
    notes.push(`Planned with ${checkedOut[0].tail} from your profile (availability not confirmed).`);
    return { aircraft: toPerf(checkedOut[0]), notes };
  }
  notes.push("No checked-out aircraft in profile; using generic C172-class performance numbers.");
  return { aircraft: GENERIC_AIRCRAFT, notes };
}

/**
 * Midnight-to-midnight span of startDate..endDate (inclusive, YYYY-MM-DD)
 * where "midnight" is midnight in the given IANA time zone (the pilot's
 * profile zone), independent of the machine's local zone.
 */
export function dateSpanInZone(startDate: string, endDate: string, timeZone: string): DateRange {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  if (compareLocalDates(end, start) < 0) throw new Error(`endDate ${endDate} is before startDate ${startDate}`);
  return {
    start: zonedTimeToUtc(start, timeZone).toISOString(),
    end: zonedTimeToUtc(addDays(end, 1), timeZone).toISOString(),
  };
}

/** Zone-midnight range for a single YYYY-MM-DD date in the given IANA time zone. */
export function dayRangeInZone(date: string, timeZone: string): DateRange {
  return dateSpanInZone(date, date, timeZone);
}
