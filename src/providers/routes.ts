/**
 * Route planning.
 *
 * NaiveRoutePlanner proposes out-and-back candidates from the bundled
 * airports sample whose round trip (great-circle, at the aircraft's cruise
 * speed, plus fixed allowances) fits inside the free window with fuel to
 * spare. It is deliberately simple: no wind, no terrain, no airspace, no
 * runway/performance checks - just enough to have something to react to.
 */
import { bundledAirports, findAirport } from "../data/airports.js";
import { greatCircleNm } from "../geo.js";
import type { Profile } from "../profile.js";
import type { AircraftPerformance, Airport, RouteCandidate, TimeWindow } from "../types.js";
import { round1, round2 } from "../util.js";
import type { RoutePlanner } from "./types.js";

/** Fixed planning allowances (hours). Personal-conservative, tune later. */
export const PLANNING_ALLOWANCES = {
  taxiAndClimbHours: 0.3,
  groundStopHours: 0.5,
  fuelReserveHours: 1.0,
  windowBufferHours: 0.25,
} as const;

export class NaiveRoutePlanner implements RoutePlanner {
  readonly name = "naive-great-circle-planner";

  constructor(private readonly airports: Airport[] = bundledAirports) {}

  async planRoutes(
    window: TimeWindow,
    aircraft: AircraftPerformance,
    profile: Profile,
    opts: { maxCandidates?: number } = {},
  ): Promise<RouteCandidate[]> {
    const maxCandidates = opts.maxCandidates ?? 5;

    // Plan out-and-backs departing EVERY home airport in the profile (order =
    // profile order, primary first) and pool the candidates.
    // TODO: once we know which field the aircraft is actually at (scheduler
    // integration), plan only from that airport and balance candidates per home
    // instead of pooling; today the pool can be dominated by one field.
    const homes = profile.homeAirports.map((id) => {
      const icao = id.trim().toUpperCase();
      return { id: icao, airport: findAirport(icao, this.airports) };
    });
    const knownHomes = homes.filter((h): h is { id: string; airport: Airport } => h.airport !== undefined);
    const unknownHomes = homes.filter((h) => h.airport === undefined);

    const unknownNote = (id: string): string =>
      `Home airport ${id} is not in the bundled airports sample; only a local flight can be proposed.`;

    if (knownHomes.length === 0) {
      return unknownHomes.map((h) => localPracticeCandidate(h.id, null, window, [unknownNote(h.id)]));
    }

    const outAndBacks = knownHomes.flatMap(({ airport: home }) =>
      this.airports
        .filter((a) => a.icao !== home.icao)
        .map((dest) => scoreOutAndBack(home, dest, window, aircraft, profile))
        .filter((c) => c.totalDistanceNm <= profile.preferences.maxDistanceNm),
    );

    const fitting = outAndBacks
      .filter((c) => c.fitsWindow)
      // Best use of the window first: longest block time that still fits.
      .sort((a, b) => b.estBlockTimeHours - a.estBlockTimeHours);

    const results: RouteCandidate[] = fitting.slice(0, maxCandidates);
    if (results.length === 0) {
      // Nothing fits: show the closest few so the reason is visible.
      results.push(
        ...outAndBacks.sort((a, b) => a.totalDistanceNm - b.totalDistanceNm).slice(0, 3),
      );
    }
    // One local-practice option per home field (plus a note-only entry for
    // any home airport that is missing from the bundled sample).
    for (const { airport: home } of knownHomes) {
      results.push(localPracticeCandidate(home.icao, home, window));
    }
    for (const { id } of unknownHomes) {
      results.push(localPracticeCandidate(id, null, window, [unknownNote(id)]));
    }
    return results;
  }
}

function scoreOutAndBack(
  home: Airport,
  dest: Airport,
  window: TimeWindow,
  aircraft: AircraftPerformance,
  profile: Profile,
): RouteCandidate {
  const { taxiAndClimbHours, groundStopHours, fuelReserveHours, windowBufferHours } = PLANNING_ALLOWANCES;
  const legDistanceNm = greatCircleNm(home.lat, home.lon, dest.lat, dest.lon);
  const totalDistanceNm = 2 * legDistanceNm;
  const enrouteHours = totalDistanceNm / aircraft.cruiseKtas;
  const estBlockTimeHours = enrouteHours + taxiAndClimbHours + groundStopHours;
  const estFuelGal = (enrouteHours + taxiAndClimbHours) * aircraft.fuelBurnGph;
  const fuelRemainingGal = aircraft.usableFuelGal - estFuelGal - fuelReserveHours * aircraft.fuelBurnGph;
  const spareTimeHours = window.durationHours - estBlockTimeHours;
  const fitsWindow = spareTimeHours >= windowBufferHours && fuelRemainingGal >= 0;

  const notes: string[] = [];
  if (spareTimeHours < windowBufferHours) {
    notes.push(`needs ${round2(estBlockTimeHours + windowBufferHours)} h but window is ${window.durationHours} h`);
  }
  if (fuelRemainingGal < 0) notes.push("insufficient fuel with personal reserve");
  if (dest.note) notes.push(dest.note);
  const overBudget = estimateCostUsd(estBlockTimeHours) > profile.preferences.budgetPerFlightUsd;
  if (overBudget) notes.push("likely over per-flight budget (placeholder hourly rate)");

  return {
    kind: "out-and-back",
    home: home.icao,
    destination: { icao: dest.icao, name: dest.name, lat: dest.lat, lon: dest.lon, ...(dest.note ? { note: dest.note } : {}) },
    legDistanceNm: round1(legDistanceNm),
    totalDistanceNm: round1(totalDistanceNm),
    estBlockTimeHours: round2(estBlockTimeHours),
    estFuelGal: round1(estFuelGal),
    fitsWindow,
    margins: { spareTimeHours: round2(spareTimeHours), fuelRemainingGal: round1(fuelRemainingGal) },
    notes,
  };
}

function localPracticeCandidate(
  homeIcao: string,
  home: Airport | null,
  window: TimeWindow,
  extraNotes: string[] = [],
): RouteCandidate {
  const flightHours = Math.max(0, Math.min(window.durationHours - PLANNING_ALLOWANCES.windowBufferHours, 1.5));
  return {
    kind: "local",
    home: homeIcao,
    destination: {
      icao: homeIcao,
      name: home?.name ?? "home field",
      lat: home?.lat ?? 0,
      lon: home?.lon ?? 0,
    },
    legDistanceNm: 0,
    totalDistanceNm: 0,
    estBlockTimeHours: round2(flightHours),
    estFuelGal: 0,
    fitsWindow: flightHours >= 0.5,
    margins: { spareTimeHours: round2(window.durationHours - flightHours), fuelRemainingGal: 0 },
    notes: ["local pattern work / practice area", ...extraNotes],
  };
}

/** Placeholder wet-rate cost model. TODO: read the school's rate per tail. */
export function estimateCostUsd(blockHours: number, wetRatePerHourUsd = 180): number {
  return Math.round(blockHours * wetRatePerHourUsd);
}
