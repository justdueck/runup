/**
 * Bundled airport sample loader.
 *
 * TODO: replace src/data/airports.json with real FAA airport data (the NASR
 * subscription's APT records, or a filtered regional extract) and add runway
 * headings so crosswind can be evaluated per runway automatically.
 */
import airportData from "./airports.json" with { type: "json" };
import type { Airport } from "../types.js";

export const bundledAirports: Airport[] = airportData.airports;

export function findAirport(icao: string, airports: Airport[] = bundledAirports): Airport | undefined {
  const wanted = icao.trim().toUpperCase();
  return airports.find((a) => a.icao.toUpperCase() === wanted);
}
