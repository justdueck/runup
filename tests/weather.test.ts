import { describe, expect, it } from "vitest";
import {
  ceilingFromClouds,
  crosswindComponents,
  flightCategory,
  parseFractionalNumber,
  parseVisibilitySm,
  summarizeMetar,
  summarizeTaf,
} from "../src/weather.js";
import { NodeFetcher } from "../src/http.js";
import { fixtureWeatherClient } from "./helpers.js";

describe("METAR condition summary helpers", () => {
  it("finds the lowest broken/overcast layer as the ceiling", () => {
    expect(ceilingFromClouds([{ cover: "FEW", base: 1500 }, { cover: "SCT", base: 4000 }])).toBeNull();
    expect(
      ceilingFromClouds([
        { cover: "SCT", base: 900 },
        { cover: "BKN", base: 2000 },
        { cover: "OVC", base: 5000 },
      ]),
    ).toBe(2000);
    expect(ceilingFromClouds([{ cover: "OVX", base: 200 }])).toBe(200); // vertical visibility
    expect(ceilingFromClouds([])).toBeNull();
    expect(ceilingFromClouds(null)).toBeNull();
  });

  it("parses numeric, 10+ and fractional visibilities", () => {
    expect(parseVisibilitySm(10)).toEqual({ sm: 10, greaterThan: false });
    expect(parseVisibilitySm("10+")).toEqual({ sm: 10, greaterThan: true });
    expect(parseVisibilitySm("6+")).toEqual({ sm: 6, greaterThan: true });
    expect(parseVisibilitySm("1/4")).toEqual({ sm: 0.25, greaterThan: false });
    expect(parseVisibilitySm("1 1/2")).toEqual({ sm: 1.5, greaterThan: false });
    expect(parseVisibilitySm(null)).toEqual({ sm: null, greaterThan: false });
    expect(parseFractionalNumber("garbage")).toBeNull();
  });

  it("computes crosswind and headwind components", () => {
    // Wind 040 at 10 kt on runway 36: 40 degree offset.
    const c = crosswindComponents(40, 10, 360);
    expect(c.crosswindKt).toBeCloseTo(6.4, 1);
    expect(c.headwindKt).toBeCloseTo(7.7, 1);
    // Direct crosswind from the left of runway 09.
    expect(crosswindComponents(360, 10, 90)).toEqual({ crosswindKt: 10, headwindKt: 0 });
    // Straight down the runway.
    expect(crosswindComponents(180, 12, 180)).toEqual({ crosswindKt: 0, headwindKt: 12 });
    // Tailwind shows up as negative headwind.
    expect(crosswindComponents(360, 8, 180).headwindKt).toBe(-8);
  });

  it("classifies flight category from the worse of ceiling and visibility", () => {
    expect(flightCategory(null, 10)).toBe("VFR");
    expect(flightCategory(2500, 10)).toBe("MVFR");
    expect(flightCategory(5000, 4)).toBe("MVFR");
    expect(flightCategory(800, 10)).toBe("IFR");
    expect(flightCategory(6000, 2)).toBe("IFR");
    expect(flightCategory(300, 10)).toBe("LIFR");
    expect(flightCategory(6000, 0.5)).toBe("LIFR");
  });
});

describe("summarizeMetar (fixtures)", () => {
  it("summarizes a benign VFR observation with crosswind for a runway", async () => {
    const { client } = fixtureWeatherClient();
    const [kpae] = await client.getMetars(["KPAE"]);
    const summary = summarizeMetar(kpae, { runwayHeadingDeg: 340 });
    expect(summary.station).toBe("KPAE");
    expect(summary.ceiling).toEqual({ ft: null, reported: true });
    expect(summary.visibility).toEqual({ sm: 10, greaterThan: true });
    expect(summary.wind).toMatchObject({ dirDeg: 350, speedKt: 8, gustKt: null, gustSpreadKt: 0, variable: false });
    // 10 degrees off runway 34 at 8 kt -> ~1.4 kt crosswind.
    expect(summary.crosswind.crosswindKt).toBeCloseTo(1.4, 1);
    expect(summary.flightCategory).toBe("VFR");
    expect(summary.observedAt).toBe(new Date(1784746600 * 1000).toISOString());
  });

  it("picks up low IFR: overcast 300 ft ceiling (coastal Hoquiam)", async () => {
    const { client } = fixtureWeatherClient();
    const [khqm] = await client.getMetars(["KHQM"]);
    const summary = summarizeMetar(khqm);
    expect(summary.ceiling.ft).toBe(300);
    expect(summary.visibility.sm).toBe(4);
    expect(summary.flightCategory).toBe("LIFR");
  });

  it("uses gusts for crosswind and reports gust spread (windy Ellensburg)", async () => {
    const { client } = fixtureWeatherClient();
    const [keln] = await client.getMetars(["KELN"]);
    const summary = summarizeMetar(keln, { runwayHeadingDeg: 250 });
    expect(summary.wind.gustSpreadKt).toBe(11);
    expect(summary.crosswind.crosswindKt).toBe(0); // 25017G28KT straight down runway 25
    expect(summary.notes).toContain("crosswind computed from gust value");
  });

  it("treats variable winds as worst-case crosswind and OVX as a ceiling", async () => {
    const { client } = fixtureWeatherClient();
    const [kolm, kbfi] = await Promise.all([client.getMetars(["KOLM"]), client.getMetars(["KBFI"])]).then(
      ([a, b]) => [a[0], b[0]],
    );
    const olympia = summarizeMetar(kolm, { runwayHeadingDeg: 260 });
    expect(olympia.wind.variable).toBe(true);
    expect(olympia.wind.dirDeg).toBeNull();
    expect(olympia.crosswind.crosswindKt).toBe(4);
    expect(olympia.ceiling.ft).toBe(2000);
    expect(olympia.flightCategory).toBe("MVFR");

    const boeingField = summarizeMetar(kbfi);
    expect(boeingField.ceiling.ft).toBe(200);
    expect(boeingField.visibility.sm).toBe(0.25);
    expect(boeingField.flightCategory).toBe("LIFR");
  });

  it("keeps only the most recent report per station", async () => {
    const { client, fetcher } = fixtureWeatherClient();
    const metars = await client.getMetars(["KPAE"]);
    expect(metars).toHaveLength(1);
    expect(metars[0].obsTime).toBe(1784746600);
    expect(fetcher.requestedUrls[0]).toContain("/metar?");
    expect(fetcher.requestedUrls[0]).toContain("ids=KPAE");
    expect(fetcher.requestedUrls[0]).toContain("format=json");
  });
});

describe("NodeFetcher", () => {
  it("aborts a hung request after the configured timeout with a clean error", async () => {
    // A fetch that never resolves on its own; it only rejects when the timeout aborts it.
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const fetcher = new NodeFetcher({ timeoutMs: 20, fetchImpl: hangingFetch });
    await expect(fetcher.getJson("https://example.invalid/metar?ids=KPAE")).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });

  it("parses JSON (and empty bodies) from the injected fetch", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      const body = seen.length === 1 ? '[{"icaoId":"KPAE"}]' : "";
      return new Response(body, { status: 200 });
    };
    const fetcher = new NodeFetcher({ fetchImpl: fakeFetch });
    await expect(fetcher.getJson("https://example.invalid/a")).resolves.toEqual([{ icaoId: "KPAE" }]);
    await expect(fetcher.getJson("https://example.invalid/b")).resolves.toEqual([]); // empty body -> []
    expect(seen).toHaveLength(2);
    expect(new Headers(seen[0].init?.headers).get("Accept")).toBe("application/json");
    expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal); // timeout signal is always attached
  });
});

describe("TAF summary", () => {
  it("lists forecast periods with derived ceiling and visibility", async () => {
    const { client } = fixtureWeatherClient();
    const [kbfi] = await client.getTafs(["KBFI"]);
    const summary = summarizeTaf(kbfi);
    expect(summary.station).toBe("KBFI");
    expect(summary.periods).toHaveLength(3);
    expect(summary.periods[1]).toMatchObject({ change: "FM", ceilingFt: 1200, visibilitySm: 6 });
    expect(summary.periods[0].wind).toBe("270deg 12kt");
  });
});
