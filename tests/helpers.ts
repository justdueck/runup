import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AviationWeatherClient } from "../src/weather.js";
import type { HttpJsonFetcher, HttpTextFetcher } from "../src/http.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function loadFixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

/** Read a text fixture (e.g. an .ics calendar) from tests/fixtures. */
export async function loadTextFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURE_DIR, name), "utf8");
}

/** Serves recorded fixtures instead of hitting aviationweather.gov, filtered by ?ids=. */
export class FixtureFetcher implements HttpJsonFetcher {
  readonly requestedUrls: string[] = [];

  async getJson(url: string): Promise<unknown> {
    this.requestedUrls.push(url);
    const u = new URL(url);
    const ids = (u.searchParams.get("ids") ?? "").split(",").map((s) => s.toUpperCase());
    const file = u.pathname.endsWith("/metar")
      ? "metar-puget-sound.json"
      : u.pathname.endsWith("/taf")
        ? "taf-puget-sound.json"
        : null;
    if (!file) throw new Error(`FixtureFetcher: unexpected URL ${url}`);
    const records = await loadFixture<Array<{ icaoId: string }>>(file);
    return records.filter((r) => ids.includes(r.icaoId.toUpperCase()));
  }
}

export function fixtureWeatherClient(): { client: AviationWeatherClient; fetcher: FixtureFetcher } {
  const fetcher = new FixtureFetcher();
  return { client: new AviationWeatherClient(fetcher), fetcher };
}

/**
 * In-memory ICS "server" (secret iCal URL -> ICS text) for the calendar
 * provider: never touches the network, and records which URLs were fetched.
 */
export class MemoryIcsFetcher implements HttpTextFetcher {
  readonly requestedUrls: string[] = [];

  constructor(private readonly bodies: Record<string, string>) {}

  async getText(url: string): Promise<string> {
    this.requestedUrls.push(url);
    const body = this.bodies[url];
    if (body === undefined) throw new Error("MemoryIcsFetcher: unexpected calendar URL in test");
    return body;
  }
}
