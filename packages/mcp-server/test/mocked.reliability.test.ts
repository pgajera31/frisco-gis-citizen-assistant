/**
 * MOCKED tests: ArcGIS client reliability and tool behaviour using a fake fetch.
 * No network. Covers endpoint allowlisting, ArcGIS errors inside HTTP 200,
 * timeouts, retries, pagination, malformed responses and SQL escaping.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertApprovedUrl,
  getJson,
  GisError,
  queryLayer,
  sanitizeSqlText,
  setFetchImplementation,
  sqlString,
} from "../src/arcgis/client.js";
import { config } from "../src/config.js";
import { toFailure } from "../src/tools/common.js";
import { getSpeedLimit } from "../src/tools/speedLimits.js";
import { searchParksByAmenity } from "../src/tools/parks.js";
import { findRoadProjects } from "../src/tools/roadProjects.js";

const AGOL = "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  config.arcgisRetries = 1;
  config.arcgisTimeoutMs = 200;
  config.cacheTtlSeconds = 0;
});
afterEach(() => setFetchImplementation(null));

describe("endpoint allowlist", () => {
  it("accepts approved City / Esri / Census endpoints", () => {
    expect(() => assertApprovedUrl(`${AGOL}/ParkApp_Testing/FeatureServer/0/query`)).not.toThrow();
    expect(() => assertApprovedUrl("https://maps.friscotexas.gov/gis/rest/services/Public/FriscoData/MapServer/6")).not.toThrow();
    expect(() => assertApprovedUrl("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates")).not.toThrow();
  });
  it.each([
    "https://evil.example.com/arcgis/rest/services",
    "http://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/x", // not https
    "https://services6.arcgis.com/SOMEOTHERORG/ArcGIS/rest/services/x", // other ArcGIS org
    "https://maps.friscotexas.gov/gis/rest/services/Internal/Secret/MapServer", // non-public folder
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertApprovedUrl(url)).toThrow(GisError);
  });
  it("refuses to fetch an unapproved URL (fetch never called)", async () => {
    setFetchImplementation(async (u) => {
      calls.push(u);
      return json({});
    });
    await expect(getJson("https://evil.example.com/x", {})).rejects.toMatchObject({ code: "ENDPOINT_NOT_APPROVED" });
    expect(calls).toHaveLength(0);
  });
});

describe("ArcGIS response handling", () => {
  it("treats an ArcGIS error object in an HTTP 200 body as a failure", async () => {
    setFetchImplementation(async () => json({ error: { code: 400, message: "Invalid query", details: ["'Foo' not found"] } }));
    await expect(queryLayer("parks", {})).rejects.toMatchObject({ code: "ARCGIS_ERROR" });
  });

  it("retries transient 5xx responses and then succeeds", async () => {
    let n = 0;
    setFetchImplementation(async () => (++n === 1 ? json({}, 503) : json({ features: [{ attributes: { OBJECTID: 1 } }] })));
    const feats = await queryLayer("parks", { returnGeometry: false });
    expect(feats).toHaveLength(1);
    expect(n).toBe(2);
  });

  it("reports a timeout when the service does not answer", async () => {
    setFetchImplementation(
      (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    await expect(queryLayer("parks", {})).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("reports a network failure", async () => {
    setFetchImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(queryLayer("parks", {})).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("rejects non-JSON and featureless bodies", async () => {
    setFetchImplementation(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(queryLayer("parks", {})).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    setFetchImplementation(async () => json({ notFeatures: true }));
    await expect(queryLayer("parks", {})).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("follows exceededTransferLimit pagination", async () => {
    setFetchImplementation(async (u) => {
      calls.push(u);
      const offset = Number(new URL(u).searchParams.get("resultOffset"));
      if (offset === 0) return json({ features: Array.from({ length: 3 }, (_, i) => ({ attributes: { OBJECTID: i } })), exceededTransferLimit: true });
      return json({ features: [{ attributes: { OBJECTID: 99 } }] });
    });
    const feats = await queryLayer("parks", { returnGeometry: false });
    expect(feats).toHaveLength(4);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]).searchParams.get("resultOffset")).toBe("3");
  });

  it("caps oversized result sets", async () => {
    setFetchImplementation(async () => json({ features: Array.from({ length: 20 }, (_, i) => ({ attributes: { OBJECTID: i } })) }));
    await expect(queryLayer("parks", { maxFeatures: 10 })).rejects.toMatchObject({ code: "TOO_MANY_RESULTS" });
  });

  it("never exposes internal details in tool failures", () => {
    const f = toFailure("x", new GisError("ARCGIS_ERROR", "The City GIS service reported an error for this query.", "https://internal/secret stack"));
    expect(JSON.stringify(f)).not.toContain("internal/secret");
  });
});

describe("SQL safety", () => {
  it("escapes quotes in string literals", () => {
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
  });
  it("strips SQL metacharacters and wildcards from free text", () => {
    expect(sanitizeSqlText("PRESTON'; DROP TABLE x;--%_")).toBe("PRESTON' DROP TABLE x --");
    expect(sanitizeSqlText("a".repeat(200))).toHaveLength(80);
  });
  it("sends an escaped, sanitized where clause for speed-limit lookups", async () => {
    setFetchImplementation(async (u) => {
      calls.push(decodeURIComponent(u));
      return json({ features: [] });
    });
    await getSpeedLimit({ streetName: "Pres'ton%; DELETE Road" }).catch(() => undefined);
    const where = calls.map((c) => new URL(c).searchParams.get("where") ?? "").join(" | ");
    expect(where).not.toContain("%;");
    expect(where).not.toMatch(/;\s*DELETE/);
    // The free text is reduced to a safe literal; no stray quote can terminate the string early.
    expect(where).toContain("ROAD_NAME = 'PRES TON DELETE'");
    expect(where.match(/'/g)!.length % 2).toBe(0);
  });
});

describe("tool logic with fixture data", () => {
  const seg = (id: number, mph: number, from: number, x: number) => ({
    attributes: { OBJECTID: id, FULL_NAME: "PRESTON RD", ROAD_NAME: "PRESTON", ROAD_SUF: "RD", MPH: mph, L_ADD_F: from, L_ADD_T: from + 98, R_ADD_F: from + 1, R_ADD_T: from + 99, OWNER: "TX", LIFECYCLESTATUS: "COMP" },
    geometry: { paths: [[[x, 33.1], [x, 33.11]]] },
  });

  it("asks for clarification when a road has several speed limits", async () => {
    setFetchImplementation(async (u) => {
      if (u.includes("/External_Engineering/MapServer/6/query")) return json({ features: [seg(1, 45, 3000, -96.8), seg(2, 45, 3100, -96.8), seg(3, 55, 9000, -96.8)] });
      return json({ features: [] }); // school zones etc.
    });
    const r = await getSpeedLimit({ streetName: "Preston Road" });
    expect(r.needsClarification?.options).toHaveLength(2);
    expect((r.results[0].speedLimitsByMph as { mph: number }[]).map((g) => g.mph)).toEqual([45, 55]);
    expect(r.summary).toMatch(/different speed limits/);
  });

  it("states a single speed limit without clarification", async () => {
    setFetchImplementation(async (u) =>
      u.includes("/External_Engineering/MapServer/6/query") ? json({ features: [seg(1, 30, 100, -96.8), seg(2, 30, 200, -96.8)] }) : json({ features: [] }),
    );
    const r = await getSpeedLimit({ streetName: "Preston Rd" });
    expect(r.needsClarification).toBeUndefined();
    expect(r.summary).toContain("30 mph");
  });

  it("falls back to the open-data street layer if the City speed layer fails", async () => {
    setFetchImplementation(async (u) => {
      if (u.includes("maps.friscotexas.gov") && u.includes("MapServer/6/query")) return json({}, 503);
      if (u.includes("FriscoTrans_ODH/FeatureServer/0/query")) return json({ features: [seg(1, 40, 100, -96.8)] });
      return json({ features: [] });
    });
    const r = await getSpeedLimit({ streetName: "Preston Rd" });
    expect(r.summary).toContain("40 mph");
    expect(r.sources.some((s) => s.layer.includes("FriscoTrans_ODH"))).toBe(true);
  });

  it("filters CIP projects by status in the query and flags overdue completion dates", async () => {
    setFetchImplementation(async (u) => {
      calls.push(decodeURIComponent(u));
      return json({
        features: [
          { attributes: { OBJECTID: 1, Name: "Old Rd", Status: "Construction", Type: "Road", CompletionDate: "2020 Q1" }, geometry: { paths: [[[-96.8, 33.1], [-96.79, 33.1]]] } },
          { attributes: { OBJECTID: 2, Name: "New Rd", Status: "Construction", Type: "Road", CompletionDate: "2099 Q4" }, geometry: { paths: [[[-96.8, 33.1], [-96.79, 33.1]]] } },
        ],
      });
    });
    const r = await findRoadProjects({});
    const where = new URL(calls[0]).searchParams.get("where");
    expect(where).toBe("Status IN ('Construction') AND Type IN ('Road')");
    const old = r.results.find((x) => x.name === "Old Rd");
    expect(old?.estimatedCompletionPassed).toBe(true);
    expect(r.limitations.join(" ")).toMatch(/estimated completion quarter that has already passed/);
  });

  it("rejects amenities the park data does not track", async () => {
    await expect(searchParksByAmenity({ amenities: ["zipline"] })).rejects.toMatchObject({ code: "UNKNOWN_AMENITY" });
  });

  it("matches amenity points to parks spatially, not by name", async () => {
    const parkPoly = { rings: [[[-96.83, 33.15], [-96.83, 33.16], [-96.82, 33.16], [-96.82, 33.15], [-96.83, 33.15]]] };
    setFetchImplementation(async (u) => {
      if (u.includes("ParkApp_Testing/FeatureServer/0/query")) {
        return json({ features: [{ attributes: { OBJECTID: 7, ParkName: "Test Park", Basketball: "None", Playground: "Playground" }, geometry: parkPoly }] });
      }
      if (u.includes("ParkAmenities_Test/FeatureServer/0/query")) {
        // Point's "Park" text deliberately disagrees with the polygon's name; location decides.
        return json({ features: [{ attributes: { FID: 1, Park: "Some Other Name", Amenity: "Basketball" }, geometry: { x: -96.825, y: 33.155 } }] });
      }
      return json({ features: [] }); // metadata etc.
    });
    const r = await searchParksByAmenity({ amenities: ["basketball"] });
    expect(r.count).toBe(1);
    expect(r.results[0].amenityEvidence).toEqual([{ amenity: "Basketball", parkAttribute: false, amenityPoints: 1 }]);
    expect(r.limitations.join(" ")).toMatch(/not listed on the park record/);
  });

  it("assigns an amenity point to every overlapping park polygon and skips future/placeholder parks", async () => {
    const big = { rings: [[[-96.84, 33.14], [-96.84, 33.17], [-96.81, 33.17], [-96.81, 33.14], [-96.84, 33.14]]] };
    const inner = { rings: [[[-96.83, 33.15], [-96.83, 33.16], [-96.82, 33.16], [-96.82, 33.15], [-96.83, 33.15]]] };
    const far = { rings: [[[-96.70, 33.20], [-96.70, 33.21], [-96.69, 33.21], [-96.69, 33.20], [-96.70, 33.20]]] };
    setFetchImplementation(async (u) => {
      if (u.includes("ParkApp_Testing/FeatureServer/0/query")) {
        return json({
          features: [
            { attributes: { OBJECTID: 1, ParkName: "Community Park" }, geometry: big },
            { attributes: { OBJECTID: 2, ParkName: "Disc Golf Course" }, geometry: inner },
            { attributes: { OBJECTID: 3, ParkName: "Someday Park (Future Site)", DiscGolf: "Disc Golf" }, geometry: far },
            { attributes: { OBJECTID: 4, ParkName: "Select a Park for More Info", DiscGolf: "Disc Golf" }, geometry: far },
          ],
        });
      }
      if (u.includes("ParkAmenities_Test/FeatureServer/0/query")) {
        return json({ features: [{ attributes: { FID: 9, Park: "Community Park", Amenity: "Disc Golf" }, geometry: { x: -96.825, y: 33.155 } }] });
      }
      return json({ features: [] });
    });
    const r = await searchParksByAmenity({ amenities: ["disc golf"] });
    expect(r.results.map((x) => x.name).sort()).toEqual(["Community Park", "Disc Golf Course"]);
  });
});
