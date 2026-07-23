/**
 * ForeFlight handoff helpers.
 *
 * Two ways to move a runup route into ForeFlight:
 *
 * 1. Deep link — ForeFlight registers the `foreflightmobile://` URL scheme on
 *    iOS. `foreflightmobile://maps/search?q=KPAE KAWO KPAE` opens the route in
 *    the Maps view on any device with ForeFlight installed; ForeFlight
 *    resolves the identifiers against its own nav database, so the link works
 *    even for airports runup does not know coordinates for.
 *
 * 2. Garmin flight-plan file (.fpl) — ForeFlight's documented import format.
 *    AirDrop/email the file to the device (or open it from the Files app) and
 *    choose "Open in ForeFlight" to save it as a flight plan. The Garmin
 *    schema requires coordinates per waypoint, so .fpl export only covers
 *    airports present in the bundled sample.
 *
 * RouteCandidate stays vendor-free: candidates are decorated with a handoff
 * block at the tool-output boundary via {@link withForeflight}.
 */
import path from "node:path";
import { findAirport } from "./data/airports.js";
import type { Airport, RouteCandidate } from "./types.js";
import { writeFileAtomic } from "./util.js";

/** One-tap ForeFlight handoff attached to route candidates in tool output. */
export interface ForeflightHandoff {
  /** Space-separated identifiers, e.g. "KPAE KAWO KPAE". */
  route: string;
  /** Opens the route in ForeFlight's Maps view on a device with ForeFlight installed. */
  openUrl: string;
}

export type RouteCandidateWithForeflight = RouteCandidate & { foreflight: ForeflightHandoff };

/** Normalize identifiers the way the rest of the server does (trim + uppercase). */
export function normalizeRouteIds(ids: string[]): string[] {
  return ids.map((id) => id.trim().toUpperCase()).filter((id) => id.length > 0);
}

/** Space-separated route string, e.g. "KPAE KAWO KPAE". */
export function routeString(ids: string[]): string {
  return normalizeRouteIds(ids).join(" ");
}

/** Deep link that opens the route in ForeFlight's Maps view on the device. */
export function foreflightMapsUrl(ids: string[]): string {
  return `foreflightmobile://maps/search?q=${encodeURIComponent(routeString(ids))}`;
}

/** The waypoint sequence a candidate flies: out-and-back = home > dest > home; local = home only. */
export function candidateRouteIds(candidate: Pick<RouteCandidate, "kind" | "home" | "destination">): string[] {
  return candidate.kind === "out-and-back"
    ? [candidate.home, candidate.destination.icao, candidate.home]
    : [candidate.home];
}

/** Decorate a provider-produced candidate with its ForeFlight handoff block. */
export function withForeflight(candidate: RouteCandidate): RouteCandidateWithForeflight {
  const ids = candidateRouteIds(candidate);
  return { ...candidate, foreflight: { route: routeString(ids), openUrl: foreflightMapsUrl(ids) } };
}

/** A waypoint with the coordinates the Garmin .fpl schema requires. */
export interface FplWaypoint {
  /** ICAO/FAA identifier, e.g. "KPAE". */
  identifier: string;
  lat: number;
  lon: number;
}

/**
 * Build a Garmin FlightPlan v1 (.fpl) document for an airport-to-airport
 * route. Waypoints repeat in the route (out-and-back) but appear once in the
 * waypoint table, per the schema.
 */
export function buildGarminFpl(
  waypoints: FplWaypoint[],
  opts: { routeName?: string; createdAt?: Date } = {},
): string {
  if (waypoints.length === 0) throw new Error("a flight plan needs at least one waypoint");
  const points = waypoints.map((w) => ({ ...w, identifier: w.identifier.trim().toUpperCase() }));
  const name = fplRouteName(opts.routeName ?? points.map((p) => p.identifier).join(" "));
  const created = (opts.createdAt ?? new Date()).toISOString();

  const seen = new Set<string>();
  const table = points
    .filter((p) => !seen.has(p.identifier) && seen.add(p.identifier))
    .map(
      (p) => `    <waypoint>
      <identifier>${escapeXml(p.identifier)}</identifier>
      <type>AIRPORT</type>
      <lat>${p.lat}</lat>
      <lon>${p.lon}</lon>
    </waypoint>`,
    );

  const routePoints = points.map(
    (p) => `    <route-point>
      <waypoint-identifier>${escapeXml(p.identifier)}</waypoint-identifier>
      <waypoint-type>AIRPORT</waypoint-type>
    </route-point>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">
  <created>${created}</created>
  <waypoint-table>
${table.join("\n")}
  </waypoint-table>
  <route>
    <route-name>${escapeXml(name)}</route-name>
    <flight-plan-index>1</flight-plan-index>
${routePoints.join("\n")}
  </route>
</flight-plan>
`;
}

export interface ForeflightExport {
  route: string;
  waypoints: string[];
  openUrl: string;
  fpl: { fileName: string; xml: string; savedTo: string | null } | null;
  notes: string[];
}

export interface ForeflightExportOptions {
  /** Directory to write the .fpl file into (created if missing). */
  exportsDir: string;
  routeName?: string;
  /** Write the .fpl to disk (default true). */
  save?: boolean;
  /** Airport lookup for coordinates (defaults to the bundled sample). */
  resolve?: (id: string) => Airport | undefined;
}

/**
 * Full ForeFlight handoff for a waypoint sequence: the deep link always, plus
 * a Garmin .fpl (written to `exportsDir` unless `save` is false) when every
 * waypoint resolves to coordinates.
 */
export async function exportForeflight(route: string[], opts: ForeflightExportOptions): Promise<ForeflightExport> {
  const resolve = opts.resolve ?? findAirport;
  const ids = normalizeRouteIds(route);
  const notes = [
    "On the device running ForeFlight, tap openUrl to open this route in the Maps view.",
    "In ForeFlight, use Send To > Flights (or save the route) - ForeFlight sync then makes it available on your other devices, e.g. plan on the iPhone and fly it from the iPad.",
  ];

  const resolved = ids.map((id) => ({ id, airport: resolve(id) }));
  const unknown = resolved.filter((r) => !r.airport).map((r) => r.id);
  let fpl: ForeflightExport["fpl"] = null;
  if (unknown.length > 0) {
    notes.push(
      `No coordinates for ${unknown.join(", ")} in the bundled airport sample, so no .fpl file was generated. ` +
        "The deep link still works: ForeFlight resolves identifiers against its own database.",
    );
  } else {
    const waypoints = resolved.map((r) => ({ identifier: r.id, lat: r.airport!.lat, lon: r.airport!.lon }));
    const xml = buildGarminFpl(waypoints, opts.routeName ? { routeName: opts.routeName } : {});
    const fileName = `${ids.join("-")}.fpl`;
    let savedTo: string | null = null;
    if (opts.save !== false) {
      try {
        const target = path.join(opts.exportsDir, fileName);
        await writeFileAtomic(target, xml);
        savedTo = target;
        notes.push(
          `Wrote ${target}. To import instead of using the link: get the file onto the iPad/iPhone ` +
            "(AirDrop, email, or iCloud Drive) and open it with ForeFlight.",
        );
      } catch (err) {
        notes.push(`Could not write the .fpl file (${(err as Error).message}); the XML is included in this result.`);
      }
    }
    fpl = { fileName, xml, savedTo };
  }

  return { route: routeString(ids), waypoints: ids, openUrl: foreflightMapsUrl(ids), fpl, notes };
}

/** Garmin route names are short uppercase alphanumerics/spaces; clamp accordingly. */
function fplRouteName(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "RUNUP ROUTE").slice(0, 25).trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
