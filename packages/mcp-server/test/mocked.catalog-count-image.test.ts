/**
 * MOCKED tests for the proposal's tool-catalog tools: portal content search,
 * buffer/count, and static map image (print GP task). No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetchImplementation } from "../src/arcgis/client.js";
import { config } from "../src/config.js";
import { sanitizeSearchText, searchGisCatalog } from "../src/tools/catalogSearch.js";
import { COUNTABLE_LAYERS, countFeaturesWithinRadius } from "../src/tools/countNear.js";
import { esriSymbol, geoJsonToEsri, getMapImage, highlightLayers } from "../src/tools/mapImage.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { url: string; body?: string }[] = [];
const params = (i: number) => {
  const c = calls[i];
  return new URLSearchParams(c.body ?? new URL(c.url).search);
};

beforeEach(() => {
  calls = [];
  config.arcgisRetries = 0;
  config.cacheTtlSeconds = 0;
});
afterEach(() => setFetchImplementation(null));

describe("search_gis_catalog", () => {
  it("strips search operators and always restricts to the City's public items", async () => {
    setFetchImplementation(async (u, init) => {
      calls.push({ url: u, body: init?.body as string | undefined });
      return json({ total: 2, results: [
        { id: "a1", title: "Parks Map", type: "Web Map", owner: "FriscoTexas", access: "public", modified: 1790000000000, url: null },
        { id: "zz", title: "Someone else's map", type: "Web Map", owner: "attacker", access: "public" },
      ] });
    });
    const r = await searchGisCatalog({ query: 'parks) OR owner:attacker OR (access:private "x"', itemTypes: ["Web Map"] });
    const q = params(0).get("q")!;
    expect(q).toBe('(parks owner attacker access private x) AND owner:FriscoTexas AND access:public AND (type:"Web Map")');
    expect(r.results.map((x) => x.title)).toEqual(["Parks Map"]); // foreign-owner rows dropped defensively
    expect(r.results[0].itemPage).toBe("https://www.arcgis.com/home/item.html?id=a1");
  });
  it("sanitizes boolean keywords", () => {
    expect(sanitizeSearchText("trails AND NOT closures")).toBe("trails closures");
  });
  it("requires real keywords", async () => {
    await expect(searchGisCatalog({ query: "()" })).rejects.toMatchObject({ code: "QUERY_REQUIRED" });
  });
});

describe("count_features_within_radius", () => {
  it("uses a server-side distance buffer with the layer's FIXED filter", async () => {
    setFetchImplementation(async (u) => {
      calls.push({ url: u });
      if (u.includes("/query")) return json({ count: 7 });
      return json({ editingInfo: { lastEditDate: 1790000000000 } });
    });
    const r = await countFeaturesWithinRadius({ latitude: 33.15, longitude: -96.83, layer: "parks", radiusMiles: 1 });
    const q = calls.map((c) => new URL(c.url)).find((u) => u.pathname.includes("ParkApp_Testing") && u.pathname.endsWith("/query"))!;
    expect(q.searchParams.get("where")).toBe(COUNTABLE_LAYERS.parks.where);
    expect(q.searchParams.get("distance")).toBe("1");
    expect(q.searchParams.get("units")).toBe("esriSRUnit_StatuteMile");
    expect(q.searchParams.get("returnCountOnly")).toBe("true");
    expect(r.summary).toMatch(/There are 7 parks within 1 mile/);
    expect(r.map.features.map((f) => f.properties.kind)).toEqual(["search-area", "search-location"]);
  });
});

describe("get_map_image helpers", () => {
  it("converts GeoJSON to Esri JSON and reverses polygon ring order", () => {
    const poly = geoJsonToEsri({ type: "Polygon", coordinates: [[[-96.8, 33.1], [-96.79, 33.1], [-96.79, 33.11], [-96.8, 33.1]]] });
    expect(poly.type).toBe("polygon");
    expect((poly.geometry.rings as number[][][])[0][0]).toEqual([-96.8, 33.1]);
    expect((poly.geometry.rings as number[][][])[0][1]).toEqual([-96.79, 33.11]);
    expect(geoJsonToEsri({ type: "MultiLineString", coordinates: [[[-96.8, 33.1], [-96.79, 33.1]]] }).type).toBe("line");
  });
  it("rejects coordinates outside the Frisco area", () => {
    expect(() => geoJsonToEsri({ type: "Point", coordinates: [2.35, 48.85] })).toThrow(/Frisco area/);
  });
  it("symbolizes speed segments with the web map's colour ramp", () => {
    expect((esriSymbol("speed-segment", 55, "line") as { color: number[] }).color).toEqual([165, 0, 38, 255]);
  });
  it("caps the number of highlighted features", () => {
    const f = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [-96.8, 33.1] }, properties: { kind: "amenity" as const, id: "x", label: "x" } };
    expect(() => highlightLayers({ type: "FeatureCollection", features: Array(601).fill(f) })).toThrow(/At most 600/);
  });
});

describe("get_map_image", () => {
  const fc = {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [[-96.8, 33.1], [-96.8, 33.12]] }, properties: { kind: "speed-segment" as const, id: "s1", label: "45 mph", styleValue: 45 } }],
  };

  it("sends a web map with the basemap, overlays and highlighted features to the print task and downloads the PNG", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    setFetchImplementation(async (u, init) => {
      calls.push({ url: u, body: init?.body as string | undefined });
      if (u.includes("Export%20Web%20Map%20Task/execute")) {
        return json({ results: [{ value: { url: "https://utility.arcgisonline.com/arcgis/rest/directories/arcgisoutput/Utilities/PrintingTools_GPServer/x.png" } }] });
      }
      if (u.endsWith("x.png")) return new Response(png, { headers: { "Content-Type": "image/png" } });
      return json({ editingInfo: {} });
    });
    const r = await getMapImage({ highlight: fc, overlayLayers: ["activeCip"], includeImageData: true });
    const printCall = calls.findIndex((c) => c.url.includes("execute"));
    const webMap = JSON.parse(params(printCall).get("Web_Map_as_JSON")!);
    expect(webMap.operationalLayers[0].url).toContain("World_Street_Map");
    expect(webMap.operationalLayers[1].url).toContain("FriscoData/MapServer/6");
    expect(webMap.operationalLayers[2].featureCollection.layers[0].featureSet.features[0].geometry.paths).toHaveLength(1);
    expect(params(printCall).get("Layout_Template")).toBe("MAP_ONLY");
    expect(r.image?.mimeType).toBe("image/png");
    expect(Buffer.from(r.image!.data, "base64")).toEqual(png);
    expect(r.results[0]).toMatchObject({ width: 1000, height: 700, highlightedFeatures: 1 });
  });

  it("refuses to download an output URL that is not on the allowlist", async () => {
    setFetchImplementation(async (u) => {
      calls.push({ url: u });
      if (u.includes("execute")) return json({ results: [{ value: { url: "https://evil.example.com/steal.png" } }] });
      return json({});
    });
    await expect(getMapImage({ highlight: fc, includeImageData: true })).rejects.toMatchObject({ code: "ENDPOINT_NOT_APPROVED" });
    expect(calls.some((c) => c.url.includes("evil.example.com"))).toBe(false);
  });

  it("requires something to draw", async () => {
    await expect(getMapImage({})).rejects.toMatchObject({ code: "NOTHING_TO_DRAW" });
  });
});
