import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AviationWeatherClient, type HttpJsonFetcher } from "../src/weather.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function loadFixture<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), "utf8")) as T;
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
