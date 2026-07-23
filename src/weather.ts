/**
 * Aviation weather via the aviationweather.gov Data API
 * (https://aviationweather.gov/data/api/).
 *
 * The HTTP layer is behind {@link HttpJsonFetcher} so tests use recorded
 * fixtures and never touch the network.
 *
 * NOTE: the field names below follow the documented METAR/TAF JSON output
 * (icaoId, wdir, wspd, wgst, visib, clouds[], rawOb, fltCat, fcsts[] ...).
 * The parser is intentionally tolerant (loose objects, optional/nullable
 * fields) because the live schema has drifted before; validate against a
 * real response on first run and record fresh fixtures.
 */
import { z } from "zod";
import { round1 } from "./util.js";

export const AWC_BASE_URL = "https://aviationweather.gov/api/data";
const USER_AGENT = "runup/0.1 (personal flight planning tool)";

/** Default per-request timeout for aviationweather.gov (ms). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Minimal JSON GET abstraction so tests can inject fixtures. */
export interface HttpJsonFetcher {
  getJson(url: string): Promise<unknown>;
}

export interface NodeFetcherOptions {
  /** Abort the request after this many milliseconds (default {@link DEFAULT_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests); defaults to Node's global fetch. */
  fetchImpl?: typeof fetch;
}

/** Default fetcher using Node's global fetch, with a request timeout. */
export class NodeFetcher implements HttpJsonFetcher {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NodeFetcherOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async getJson(url: string): Promise<unknown> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`aviationweather.gov request failed: ${res.status} ${res.statusText} for ${url}`);
      }
      const text = await res.text();
      // The API returns an empty body (not "[]") when no reports match.
      return text.trim().length === 0 ? [] : JSON.parse(text);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new Error(`aviationweather.gov request timed out after ${this.timeoutMs} ms for ${url}`);
      }
      throw err;
    }
  }
}

/** True for the abort raised by an expired AbortSignal.timeout() (or an aborted request). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// --- Schemas (tolerant) ----------------------------------------------------

export const CloudLayerSchema = z.looseObject({
  cover: z.string(),
  base: z.number().nullish(),
});
export type CloudLayer = z.infer<typeof CloudLayerSchema>;

export const MetarSchema = z.looseObject({
  icaoId: z.string(),
  reportTime: z.string().nullish(),
  obsTime: z.number().nullish(),
  temp: z.number().nullish(),
  dewp: z.number().nullish(),
  /** Degrees true, or the string "VRB" for variable winds. */
  wdir: z.union([z.number(), z.string()]).nullish(),
  wspd: z.number().nullish(),
  wgst: z.number().nullish(),
  /** Statute miles as a number, or a string such as "10+". */
  visib: z.union([z.number(), z.string()]).nullish(),
  altim: z.number().nullish(),
  wxString: z.string().nullish(),
  rawOb: z.string().nullish(),
  clouds: z.array(CloudLayerSchema).nullish(),
  fltCat: z.string().nullish(),
  name: z.string().nullish(),
});
export type Metar = z.infer<typeof MetarSchema>;

export const TafForecastSchema = z.looseObject({
  timeFrom: z.number().nullish(),
  timeTo: z.number().nullish(),
  fcstChange: z.string().nullish(),
  probability: z.number().nullish(),
  wdir: z.union([z.number(), z.string()]).nullish(),
  wspd: z.number().nullish(),
  wgst: z.number().nullish(),
  visib: z.union([z.number(), z.string()]).nullish(),
  clouds: z.array(CloudLayerSchema).nullish(),
});
export type TafForecast = z.infer<typeof TafForecastSchema>;

export const TafSchema = z.looseObject({
  icaoId: z.string(),
  rawTAF: z.string().nullish(),
  issueTime: z.string().nullish(),
  validTimeFrom: z.number().nullish(),
  validTimeTo: z.number().nullish(),
  fcsts: z.array(TafForecastSchema).nullish(),
  name: z.string().nullish(),
});
export type Taf = z.infer<typeof TafSchema>;

// --- Client ------------------------------------------------------------------

export class AviationWeatherClient {
  constructor(
    private readonly fetcher: HttpJsonFetcher = new NodeFetcher(),
    private readonly baseUrl: string = AWC_BASE_URL,
  ) {}

  metarUrl(ids: string[], hours = 2): string {
    const params = new URLSearchParams({ ids: ids.join(","), format: "json", hours: String(hours) });
    return `${this.baseUrl}/metar?${params.toString()}`;
  }

  tafUrl(ids: string[]): string {
    const params = new URLSearchParams({ ids: ids.join(","), format: "json" });
    return `${this.baseUrl}/taf?${params.toString()}`;
  }

  /** Latest METAR per station for the given airport identifiers. */
  async getMetars(ids: string[], hours = 2): Promise<Metar[]> {
    if (ids.length === 0) return [];
    const data = await this.fetcher.getJson(this.metarUrl(ids, hours));
    const parsed = z.array(MetarSchema).parse(data);
    return latestPerStation(parsed);
  }

  /** Current TAFs for the given airport identifiers (stations without TAF are simply absent). */
  async getTafs(ids: string[]): Promise<Taf[]> {
    if (ids.length === 0) return [];
    const data = await this.fetcher.getJson(this.tafUrl(ids));
    return z.array(TafSchema).parse(data);
  }
}

/** Keep only the most recent report per station (API may return several hours). */
function latestPerStation(metars: Metar[]): Metar[] {
  const byStation = new Map<string, Metar>();
  for (const m of metars) {
    const prev = byStation.get(m.icaoId);
    if (!prev || (m.obsTime ?? 0) > (prev.obsTime ?? 0)) byStation.set(m.icaoId, m);
  }
  return [...byStation.values()];
}

// --- Condition summary -------------------------------------------------------

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export interface ConditionSummary {
  station: string;
  /** ISO timestamp of the observation when derivable, else null. */
  observedAt: string | null;
  raw: string | null;
  wind: {
    /** Degrees true; null when calm or variable. */
    dirDeg: number | null;
    variable: boolean;
    speedKt: number;
    gustKt: number | null;
    /** gustKt - speedKt (0 when no gust reported). */
    gustSpreadKt: number;
  };
  visibility: {
    /** Statute miles; null if not reported. */
    sm: number | null;
    /** True for "10+" style values (greater than or equal to sm). */
    greaterThan: boolean;
  };
  ceiling: {
    /** Lowest BKN/OVC/vertical-visibility base in ft AGL; null = no ceiling. */
    ft: number | null;
    /** False when the report carried no sky-condition data at all. */
    reported: boolean;
  };
  crosswind: {
    runwayHeadingDeg: number | null;
    /** Absolute crosswind component in kt; null when it cannot be computed. */
    crosswindKt: number | null;
    /** Positive = headwind, negative = tailwind, in kt. */
    headwindKt: number | null;
  };
  flightCategory: FlightCategory;
  notes: string[];
}

const CEILING_COVERS = new Set(["BKN", "OVC", "OVX", "VV"]);

/** Lowest broken/overcast (or vertical visibility) layer, in ft AGL; null when no ceiling. */
export function ceilingFromClouds(clouds: CloudLayer[] | null | undefined): number | null {
  if (!clouds || clouds.length === 0) return null;
  let ceiling: number | null = null;
  for (const layer of clouds) {
    if (!CEILING_COVERS.has(layer.cover.toUpperCase())) continue;
    if (typeof layer.base !== "number") continue;
    ceiling = ceiling === null ? layer.base : Math.min(ceiling, layer.base);
  }
  return ceiling;
}

/** Parse the API's visibility field ("10+", 6, "1/2", "1 1/2" ...). */
export function parseVisibilitySm(visib: number | string | null | undefined): { sm: number | null; greaterThan: boolean } {
  if (visib === null || visib === undefined) return { sm: null, greaterThan: false };
  if (typeof visib === "number") return { sm: visib, greaterThan: false };
  const trimmed = visib.trim().toUpperCase().replace(/SM$/, "");
  const greaterThan = trimmed.endsWith("+") || trimmed.startsWith("P");
  const numeric = trimmed.replace(/^P/, "").replace(/\+$/, "").trim();
  const sm = parseFractionalNumber(numeric);
  return { sm, greaterThan: sm !== null && greaterThan };
}

/** "1 1/2" -> 1.5, "3/4" -> 0.75, "6" -> 6. Returns null when unparseable. */
export function parseFractionalNumber(text: string): number | null {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  let total = 0;
  for (const part of parts) {
    const frac = /^(\d+)\/(\d+)$/.exec(part);
    if (frac) {
      const denominator = Number(frac[2]);
      if (denominator === 0) return null;
      total += Number(frac[1]) / denominator;
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return total;
}

/**
 * Crosswind/headwind components (kt) for a wind FROM `windDirDeg` at
 * `windKt` on a runway with heading `runwayHeadingDeg` (both in the same
 * reference - note METAR winds are true and runways magnetic; the small
 * variation error is acceptable for personal-minimums screening).
 */
export function crosswindComponents(
  windDirDeg: number,
  windKt: number,
  runwayHeadingDeg: number,
): { crosswindKt: number; headwindKt: number } {
  const angle = (((windDirDeg - runwayHeadingDeg) % 360) + 360) % 360;
  const rad = (angle * Math.PI) / 180;
  const crosswindKt = Math.abs(windKt * Math.sin(rad));
  const headwindKt = windKt * Math.cos(rad);
  return {
    crosswindKt: round1(crosswindKt),
    headwindKt: round1(headwindKt),
  };
}

/** Standard AWC flight-category buckets from ceiling (ft, null = none) and visibility (SM). */
export function flightCategory(ceilingFt: number | null, visSm: number | null): FlightCategory {
  const rank: Record<FlightCategory, number> = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };
  const fromCeiling: FlightCategory =
    ceilingFt === null ? "VFR" : ceilingFt < 500 ? "LIFR" : ceilingFt < 1000 ? "IFR" : ceilingFt <= 3000 ? "MVFR" : "VFR";
  const fromVis: FlightCategory =
    visSm === null ? "VFR" : visSm < 1 ? "LIFR" : visSm < 3 ? "IFR" : visSm <= 5 ? "MVFR" : "VFR";
  return rank[fromCeiling] <= rank[fromVis] ? fromCeiling : fromVis;
}

/**
 * Reduce a METAR to the handful of numbers the minimums scorer needs.
 * Pass `runwayHeadingDeg` to also compute the crosswind component.
 */
export function summarizeMetar(metar: Metar, opts: { runwayHeadingDeg?: number } = {}): ConditionSummary {
  const notes: string[] = [];

  const variable = typeof metar.wdir === "string" && metar.wdir.toUpperCase() === "VRB";
  const dirDeg = typeof metar.wdir === "number" ? metar.wdir : null;
  const speedKt = metar.wspd ?? 0;
  const gustKt = metar.wgst ?? null;
  const gustSpreadKt = gustKt !== null ? Math.max(0, gustKt - speedKt) : 0;
  if (metar.wspd === null || metar.wspd === undefined) notes.push("wind speed not reported; assumed calm");

  const visibility = parseVisibilitySm(metar.visib);
  if (visibility.sm === null) notes.push("visibility not reported");

  const skyReported = Array.isArray(metar.clouds) && metar.clouds.length > 0;
  if (!skyReported) notes.push("sky condition not reported (treat ceiling as unknown, not clear)");
  const ceilingFt = ceilingFromClouds(metar.clouds);

  const runwayHeadingDeg = opts.runwayHeadingDeg ?? null;
  let crosswindKt: number | null = null;
  let headwindKt: number | null = null;
  if (runwayHeadingDeg !== null) {
    if (variable) {
      // Direction unknown: worst case the whole steady wind is crosswind.
      crosswindKt = speedKt;
      headwindKt = 0;
      notes.push("variable wind direction: crosswind assumed worst-case (full steady wind)");
    } else if (dirDeg !== null) {
      // Use the gust when present - that is what will move the airplane on rollout.
      const c = crosswindComponents(dirDeg, gustKt ?? speedKt, runwayHeadingDeg);
      crosswindKt = c.crosswindKt;
      headwindKt = c.headwindKt;
      if (gustKt !== null) notes.push("crosswind computed from gust value");
    } else if (speedKt > 0) {
      notes.push("wind direction missing; crosswind not computed");
    } else {
      crosswindKt = 0;
      headwindKt = 0;
    }
  }

  return {
    station: metar.icaoId,
    observedAt: metar.obsTime ? new Date(metar.obsTime * 1000).toISOString() : null,
    raw: metar.rawOb ?? null,
    wind: { dirDeg, variable, speedKt, gustKt, gustSpreadKt },
    visibility,
    ceiling: { ft: ceilingFt, reported: skyReported },
    crosswind: { runwayHeadingDeg, crosswindKt, headwindKt },
    flightCategory: flightCategory(ceilingFt, visibility.sm),
    notes,
  };
}

/** Compact, model-friendly view of a TAF (raw text plus forecast change groups). */
export interface TafSummary {
  station: string;
  raw: string | null;
  validFrom: string | null;
  validTo: string | null;
  periods: Array<{
    from: string | null;
    to: string | null;
    change: string | null;
    wind: string;
    visibilitySm: number | null;
    ceilingFt: number | null;
  }>;
}

export function summarizeTaf(taf: Taf): TafSummary {
  const iso = (epoch: number | null | undefined): string | null =>
    typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : null;
  return {
    station: taf.icaoId,
    raw: taf.rawTAF ?? null,
    validFrom: iso(taf.validTimeFrom),
    validTo: iso(taf.validTimeTo),
    periods: (taf.fcsts ?? []).map((f) => ({
      from: iso(f.timeFrom),
      to: iso(f.timeTo),
      change: f.fcstChange ?? null,
      wind: `${f.wdir ?? "?"}${typeof f.wdir === "number" ? "deg" : ""} ${f.wspd ?? "?"}kt${f.wgst ? ` G${f.wgst}` : ""}`,
      visibilitySm: parseVisibilitySm(f.visib).sm,
      ceilingFt: ceilingFromClouds(f.clouds),
    })),
  };
}
