/** MOCKED tests for use cases 11–14 (school district, future land use, schools, facilities). No network. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetchImplementation } from "../src/arcgis/client.js";
import { config } from "../src/config.js";
import { facilityCategory, findNearbyFacilities, findNearbySchools, lookupFutureLandUse, lookupSchoolDistrict, schoolLevel } from "../src/tools/places.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const square = (x: number, y: number, d = 0.01) => ({ rings: [[[x - d, y - d], [x - d, y + d], [x + d, y + d], [x + d, y - d], [x - d, y - d]]] });
const P = { latitude: 33.15, longitude: -96.83 };

beforeEach(() => {
  config.arcgisRetries = 0;
  config.cacheTtlSeconds = 0;
});
afterEach(() => setFetchImplementation(null));

/** Route fake responses by layer path; anything else (metadata, boundary) returns empty. */
function route(map: Record<string, unknown[]>) {
  setFetchImplementation(async (u) => {
    for (const [frag, features] of Object.entries(map)) if (u.includes(frag) && u.includes("/query")) return json({ features });
    return json({ features: [] });
  });
}

describe("schoolLevel / facilityCategory", () => {
  it("uses the verified SUBTYPE codes first, then the name", () => {
    expect(schoolLevel("Anything", 2)).toBe("elementary");
    expect(schoolLevel("Anything", 4)).toBe("high");
    expect(schoolLevel("University of North Texas", 7)).toBe("college");
    expect(schoolLevel("Founders Classical Academy High", 8)).toBe("high");
    expect(schoolLevel("Starwood Academy", 8)).toBeNull();
  });
  it.each([
    ["Fire Station 4", "fire station"],
    ["Central Fire Station and Safety Town", "fire station"],
    ["Police Headquarters", "police"],
    ["Frisco Public Library", "library"],
    ["George A. Purefoy Municipal Center", "city hall"],
    ["Frisco Athletic Center", "recreation"],
    ["Parks and Recreation - Administration", "other"],
    ["US Post Office", "post office"],
  ])("%s → %s", (name, cat) => {
    expect(facilityCategory(name)).toBe(cat);
  });
});

describe("lookup_school_district", () => {
  it("names the district and states that attendance zones are not included", async () => {
    route({ "FriscoZoning_ODH/FeatureServer/7": [{ attributes: { NAME: "FRISCO" }, geometry: square(-96.83, 33.15, 0.05) }] });
    const r = await lookupSchoolDistrict(P);
    expect(r.summary).toMatch(/is in Frisco ISD\./);
    expect(r.limitations[0]).toMatch(/attendance zone/i);
  });
  it("reports a boundary when two districts touch the point", async () => {
    route({ "FriscoZoning_ODH/FeatureServer/7": [{ attributes: { NAME: "FRISCO" } }, { attributes: { NAME: "PROSPER" } }] });
    const r = await lookupSchoolDistrict(P);
    expect(r.summary).toMatch(/boundary of Frisco ISD and Prosper ISD/);
  });
});

describe("lookup_future_land_use", () => {
  it("reports the 2025 description, never the legacy FLU_CD code", async () => {
    route({ "FLU2025_Layers/FeatureServer/1": [{ attributes: { FLU_CD: "BP", FLU_Desc: "Park", FLU_YR: 2025, hyperlink: "https://evil.example/x" }, geometry: square(-96.83, 33.15) }] });
    const r = await lookupFutureLandUse(P);
    expect(r.summary).toContain('"Park"');
    expect(JSON.stringify(r.results)).not.toContain("BP");
    expect(r.results[0].planDocument).toBeNull(); // only City document links are passed through
    expect(r.limitations[0]).toMatch(/not zoning/);
  });
});

describe("find_nearby_schools", () => {
  it("excludes district support facilities and proposed schools by default", async () => {
    route({
      "FriscoPOI_ODH/FeatureServer/4": [
        { attributes: { OBJECTID: 1, NAME: "Real Elementary School", TYPE: "PUB", DISTRICT: "FISD", LIFECYCLES: "COMP", SUBTYPE: 2 }, geometry: { x: -96.831, y: 33.15 } },
        { attributes: { OBJECTID: 2, NAME: "FISD Transportation", TYPE: "PUB", DISTRICT: "FISD", LIFECYCLES: "COMP", SUBTYPE: 5 }, geometry: { x: -96.831, y: 33.151 } },
        { attributes: { OBJECTID: 3, NAME: "Proposed Middle School", TYPE: "PUB", DISTRICT: "FISD", LIFECYCLES: "PROP", SUBTYPE: 3 }, geometry: { x: -96.832, y: 33.15 } },
      ],
    });
    const r = await findNearbySchools(P);
    expect(r.results.map((x) => x.name)).toEqual(["Real Elementary School"]);
    expect(r.results[0]).toMatchObject({ type: "Public", district: "Frisco ISD", level: "elementary" });
    const all = await findNearbySchools({ ...P, includeDistrictFacilities: true, includeProposed: true });
    expect(all.count).toBe(3);
  });
});

describe("find_nearby_facilities", () => {
  const facilities = [
    { attributes: { OBJECTID: 1, NAME: "Fire Station 9", ADDRESS: "1 A St" }, geometry: { x: -96.9, y: 33.2 } },
    { attributes: { OBJECTID: 2, NAME: "Fire Station 4", ADDRESS: "2 B St" }, geometry: { x: -96.831, y: 33.15 } },
    { attributes: { OBJECTID: 3, NAME: "Fire Training Bldg", ADDRESS: "3 C St" }, geometry: { x: -96.8301, y: 33.15 } },
  ];
  it("returns the nearest facility of the requested category", async () => {
    route({ "FriscoPOI_ODH/FeatureServer/1": facilities });
    const r = await findNearbyFacilities({ ...P, category: "fire station" });
    expect(r.results.map((x) => x.name)).toEqual(["Fire Station 4", "Fire Station 9"]);
    expect(r.limitations.join(" ")).toMatch(/911/);
  });
  it("hides non-public training buildings from general searches", async () => {
    route({ "FriscoPOI_ODH/FeatureServer/1": facilities });
    const r = await findNearbyFacilities(P);
    expect(r.results.map((x) => x.name)).not.toContain("Fire Training Bldg");
  });
  it("fails clearly for a category with no locations", async () => {
    route({ "FriscoPOI_ODH/FeatureServer/1": facilities });
    await expect(findNearbyFacilities({ ...P, category: "library" })).rejects.toMatchObject({ code: "NO_FACILITY" });
  });
});
