import { describe, expect, it } from "vitest";
import {
  buildGarminFpl,
  candidateRouteIds,
  exportForeflight,
  foreflightMapsUrl,
  routeString,
  withForeflight,
} from "../src/foreflight.js";
import type { RouteCandidate } from "../src/types.js";

const outAndBack: RouteCandidate = {
  kind: "out-and-back",
  home: "KPAE",
  destination: { icao: "KAWO", name: "Arlington", lat: 48.16, lon: -122.16 },
  legDistanceNm: 26,
  totalDistanceNm: 52,
  estBlockTimeHours: 1.3,
  estFuelGal: 7,
  fitsWindow: true,
  margins: { spareTimeHours: 1, fuelRemainingGal: 30 },
  notes: [],
};

describe("ForeFlight deep link", () => {
  it("builds a maps/search URL from a route", () => {
    expect(foreflightMapsUrl(["KPAE", "KAWO", "KPAE"])).toBe(
      "foreflightmobile://maps/search?q=KPAE%20KAWO%20KPAE",
    );
  });

  it("normalizes identifiers", () => {
    expect(routeString([" kpae ", "s43"])).toBe("KPAE S43");
    expect(foreflightMapsUrl(["kpae"])).toBe("foreflightmobile://maps/search?q=KPAE");
  });

  it("derives the waypoint sequence from a candidate", () => {
    expect(candidateRouteIds(outAndBack)).toEqual(["KPAE", "KAWO", "KPAE"]);
    expect(
      candidateRouteIds({ ...outAndBack, kind: "local", destination: { ...outAndBack.destination, icao: "KPAE" } }),
    ).toEqual(["KPAE"]);
  });

  it("decorates a candidate with route string + link, leaving the rest intact", () => {
    const decorated = withForeflight(outAndBack);
    expect(decorated.foreflight).toEqual({
      route: "KPAE KAWO KPAE",
      openUrl: "foreflightmobile://maps/search?q=KPAE%20KAWO%20KPAE",
    });
    expect(decorated.totalDistanceNm).toBe(52);
  });
});

describe("Garmin .fpl generation", () => {
  const kpae = { identifier: "KPAE", lat: 47.9063, lon: -122.2816 };
  const kawo = { identifier: "KAWO", lat: 48.1608, lon: -122.159 };

  it("produces a v1 flight-plan with a deduped waypoint table and full route", () => {
    const xml = buildGarminFpl([kpae, kawo, kpae], { createdAt: new Date("2026-07-23T12:00:00Z") });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1"');
    expect(xml).toContain("<created>2026-07-23T12:00:00.000Z</created>");
    // KPAE flown twice but listed once in the waypoint table.
    expect(xml.match(/<identifier>KPAE<\/identifier>/g)).toHaveLength(1);
    expect(xml.match(/<waypoint-identifier>KPAE<\/waypoint-identifier>/g)).toHaveLength(2);
    expect(xml.match(/<route-point>/g)).toHaveLength(3);
    expect(xml).toContain("<lat>47.9063</lat>");
    expect(xml).toContain("<route-name>KPAE KAWO KPAE</route-name>");
  });

  it("sanitizes and clamps the route name", () => {
    const xml = buildGarminFpl([kpae], { routeName: "Sat. lunch-run <to> Arlington & back!!" });
    const name = /<route-name>(.*)<\/route-name>/.exec(xml)?.[1];
    expect(name).toBe("SAT LUNCH RUN TO ARLINGTO");
    expect(name!.length).toBeLessThanOrEqual(25);
  });

  it("rejects an empty waypoint list", () => {
    expect(() => buildGarminFpl([])).toThrow(/at least one waypoint/);
  });
});

describe("exportForeflight", () => {
  it("returns link + fpl XML without touching disk when save is false", async () => {
    const result = await exportForeflight(["KPAE", "KAWO", "KPAE"], { exportsDir: "/nonexistent", save: false });
    expect(result.route).toBe("KPAE KAWO KPAE");
    expect(result.openUrl).toBe("foreflightmobile://maps/search?q=KPAE%20KAWO%20KPAE");
    expect(result.fpl?.fileName).toBe("KPAE-KAWO-KPAE.fpl");
    expect(result.fpl?.savedTo).toBeNull();
    expect(result.fpl?.xml).toContain("FlightPlan/v1");
  });

  it("skips the .fpl (but keeps the link) when a waypoint has no coordinates", async () => {
    const result = await exportForeflight(["KPAE", "KZZZ"], { exportsDir: "/nonexistent", save: false });
    expect(result.fpl).toBeNull();
    expect(result.openUrl).toBe("foreflightmobile://maps/search?q=KPAE%20KZZZ");
    expect(result.notes.join(" ")).toMatch(/No coordinates for KZZZ/);
  });
});
