/** UNIT tests: address parsing, geometry conversion and distance maths, vocabulary. No network. */
import { describe, expect, it } from "vitest";
import { parseAddress, parseStreetName } from "../src/geo/address.js";
import { distanceToGeometryMiles, esriToGeoJSON, lineLengthMiles } from "../src/geo/geometry.js";
import { quarterEnd } from "../src/tools/roadProjects.js";
import { normalizeAmenity } from "../src/vocabulary.js";

describe("parseAddress", () => {
  it.each([
    ["6101 Frisco Square Blvd", { number: 6101, name: "FRISCO SQUARE", suffix: "BLVD" }],
    ["6101 Frisco Square Boulevard, Frisco, TX 75034", { number: 6101, name: "FRISCO SQUARE", suffix: "BLVD" }],
    ["6101 frisco square blvd frisco tx", { number: 6101, name: "FRISCO SQUARE", suffix: "BLVD" }],
    ["8000 McKinney Rd.", { number: 8000, name: "MCKINNEY", suffix: "RD" }],
    ["123 N. County Rd", { number: 123, direction: "N", name: "COUNTY", suffix: "RD" }],
    ["5700 Norfolk Lane Apt 4", { number: 5700, name: "NORFOLK", suffix: "LN", unit: "4" }],
  ])("parses %s", (input, expected) => {
    expect(parseAddress(input)).toMatchObject(expected);
  });

  it("keeps FRISCO when it is part of the street name", () => {
    expect(parseAddress("6101 Frisco Square Blvd")?.name).toBe("FRISCO SQUARE");
  });

  it("returns null for empty input", () => {
    expect(parseAddress("   ")).toBeNull();
  });

  it("parses street names for speed-limit lookups", () => {
    expect(parseStreetName("Preston Road")).toEqual({ name: "PRESTON", suffix: "RD", direction: undefined });
    expect(parseStreetName("main st.")).toMatchObject({ name: "MAIN", suffix: "ST" });
    expect(parseStreetName("Dallas Parkway")).toMatchObject({ name: "DALLAS", suffix: "PKWY" });
  });
});

describe("esriToGeoJSON", () => {
  it("converts points", () => {
    expect(esriToGeoJSON({ x: -96.8, y: 33.1 })).toEqual({ type: "Point", coordinates: [-96.8, 33.1] });
  });

  it("converts single and multi-part polylines", () => {
    expect(esriToGeoJSON({ paths: [[[0, 0], [1, 1]]] })?.type).toBe("LineString");
    expect(esriToGeoJSON({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] })?.type).toBe("MultiLineString");
  });

  it("assigns a counter-clockwise ring as a hole of the clockwise exterior ring", () => {
    // Esri exterior = clockwise, hole = counter-clockwise.
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const g = esriToGeoJSON({ rings: [outer, hole] });
    expect(g?.type).toBe("Polygon");
    expect((g as { coordinates: number[][][] }).coordinates).toHaveLength(2);
  });

  it("produces a MultiPolygon for two exterior rings", () => {
    const a = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
    const b = [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]];
    expect(esriToGeoJSON({ rings: [a, b] })?.type).toBe("MultiPolygon");
  });

  it("returns null for empty or invalid geometry", () => {
    expect(esriToGeoJSON(undefined)).toBeNull();
    expect(esriToGeoJSON({ paths: [] })).toBeNull();
    expect(esriToGeoJSON({ x: Number.NaN, y: 1 })).toBeNull();
  });
});

describe("distances", () => {
  // A ~0.01° square near Frisco.
  const square = esriToGeoJSON({ rings: [[[-96.83, 33.15], [-96.83, 33.16], [-96.82, 33.16], [-96.82, 33.15], [-96.83, 33.15]]] })!;

  it("is zero inside a polygon", () => {
    expect(distanceToGeometryMiles(-96.825, 33.155, square)).toBe(0);
  });

  it("measures to the nearest polygon edge, not the centroid", () => {
    // 0.01° of longitude at 33.15°N ≈ 0.578 mi; point is 0.01° west of the west edge.
    const d = distanceToGeometryMiles(-96.84, 33.155, square);
    expect(d).toBeGreaterThan(0.55);
    expect(d).toBeLessThan(0.61);
  });

  it("measures line length geodesically", () => {
    // 0.1° of latitude ≈ 6.9 miles.
    const len = lineLengthMiles({ type: "LineString", coordinates: [[-96.8, 33.1], [-96.8, 33.2]] });
    expect(len).toBeGreaterThan(6.8);
    expect(len).toBeLessThan(7.0);
  });
});

describe("CIP completion quarters", () => {
  it("parses YYYY Qn as the end of that quarter", () => {
    expect(quarterEnd("2025 Q2")?.toISOString().slice(0, 10)).toBe("2025-06-30");
    expect(quarterEnd("2026 Q4")?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });
  it("ignores TBD and blanks", () => {
    expect(quarterEnd("TBD")).toBeUndefined();
    expect(quarterEnd(undefined)).toBeUndefined();
  });
});

describe("amenity vocabulary", () => {
  it.each([
    ["basketball courts", "Basketball"],
    ["Playgrounds", "Playground"],
    ["splash pad", "Splash Pad"],
    ["off-leash", "Dog Park"],
    ["bathrooms", "Restrooms"],
    ["Pickleball", "Pickleball"],
    ["practice & game fields", "Practice & Game Fields"],
  ])("maps %s → %s", (input, label) => {
    expect(normalizeAmenity(input)?.label).toBe(label);
  });
  it("returns null for things the data does not track", () => {
    expect(normalizeAmenity("zipline")).toBeNull();
  });
});
