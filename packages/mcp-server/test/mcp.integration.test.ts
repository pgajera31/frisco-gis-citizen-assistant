/**
 * MCP INTEGRATION tests: spawn the real MCP server over the stdio transport and
 * talk to it with the official MCP SDK client (tools/list, tools/call).
 *
 * The "live" block additionally queries the City of Frisco's real ArcGIS
 * services for all 10 citizen use cases; run it with LIVE_GIS=1. Observed
 * results are written to docs/test-results/mcp-live-results.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const LIVE = process.env.LIVE_GIS === "1";

let client: Client;

function passEnv(): Record<string, string> {
  const env = { ...getDefaultEnvironment() };
  for (const k of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(pkgRoot, "src", "index.ts")],
    env: passEnv(),
    stderr: "ignore",
  });
  client = new Client({ name: "integration-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

type Structured = {
  ok: boolean;
  summary?: string;
  count?: number;
  results?: Record<string, unknown>[];
  needsClarification?: { options: string[] };
  sources?: { layer: string; url: string; lastEdited?: string }[];
  map?: { features: { properties: { kind: string } }[] };
  method?: string;
  error?: { code: string; message: string };
};

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return { res, s: res.structuredContent as Structured };
}

describe("MCP protocol (stdio)", () => {
  it("advertises the server and its instructions", () => {
    expect(client.getServerVersion()?.name).toBe("frisco-gis-mcp");
    expect(client.getInstructions()).toMatch(/Read-only/);
  });

  it("lists the GIS tools with schemas and read-only annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "count_features_within_radius", "describe_data_sources", "find_nearby_trails", "find_nearest_parks", "find_parks_within_radius",
        "find_road_projects", "find_road_projects_near", "find_traffic_closures", "geocode_address", "get_map_image", "get_park_details",
        "get_speed_limit", "lookup_zoning", "search_gis_catalog", "search_parks_by_amenity", "search_trails",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeDefined();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("rejects arguments that violate the input schema (radius too large)", async () => {
    const res = await client.callTool({ name: "find_parks_within_radius", arguments: { address: "6101 Frisco Square Blvd", radius_miles: 500 } });
    expect(res.isError).toBe(true);
  });

  it("rejects wrong argument types and oversized strings", async () => {
    expect((await client.callTool({ name: "lookup_zoning", arguments: { address: 12345 } })).isError).toBe(true);
    expect((await client.callTool({ name: "lookup_zoning", arguments: { address: "x".repeat(500) } })).isError).toBe(true);
    expect((await client.callTool({ name: "find_road_projects", arguments: { statuses: ["Demolished"] } })).isError).toBe(true);
  });

  it("rejects malformed map-image highlights and unknown countable layers", async () => {
    const bad = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-96.8, 33.1] }, properties: { kind: "<script>", id: "x", label: "x" } }] };
    expect((await client.callTool({ name: "get_map_image", arguments: { highlight: bad } })).isError).toBe(true);
    expect((await client.callTool({ name: "count_features_within_radius", arguments: { address: "6101 Frisco Square Blvd", layer: "secret_layer", radius_miles: 1 } })).isError).toBe(true);
  });

  it("returns a structured, user-safe error when no location is given", async () => {
    const { res, s } = await call("find_nearest_parks", {});
    expect(res.isError).toBe(true);
    expect(s.error?.code).toBe("LOCATION_REQUIRED");
  });

  it("does not offer any write/delete or arbitrary-URL tool", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema.properties as object) ?? {});
      expect(props.some((p) => /url|endpoint|where|sql/i.test(p))).toBe(false);
    }
  });

  it("lists the approved data sources without network access", async () => {
    const { s } = await call("describe_data_sources", {});
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThanOrEqual(10);
  });
});

// ------------------------------------------------------------------------------------------
// LIVE: real City of Frisco ArcGIS services through MCP
// ------------------------------------------------------------------------------------------
const ADDRESS = "6101 Frisco Square Blvd";
const observed: Record<string, unknown> = {};

function record(id: string, question: string, tool: string, args: unknown, s: Structured) {
  observed[id] = {
    question,
    tool,
    args,
    ok: s.ok,
    summary: s.summary ?? s.error?.message,
    count: s.count,
    firstResults: (s.results ?? []).slice(0, 3),
    needsClarification: s.needsClarification ?? null,
    sources: (s.sources ?? []).map((x) => ({ layer: x.layer, lastEdited: x.lastEdited ?? null })),
    mapFeatures: s.map?.features.length ?? 0,
  };
}

describe.skipIf(!LIVE)("LIVE GIS use cases via MCP", () => {
  afterAll(() => {
    const out = path.join(repoRoot, "docs", "test-results");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "mcp-live-results.json"), JSON.stringify({ runAt: new Date().toISOString(), observed }, null, 2));
  });

  it("UC1 nearest park to an address (boundary distance)", async () => {
    const args = { address: ADDRESS, limit: 3 };
    const { s } = await call("find_nearest_parks", args);
    record("UC1", "What is the closest park to 6101 Frisco Square Blvd?", "find_nearest_parks", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBe(3);
    const d = s.results!.map((r) => Number(r.distanceToBoundaryMiles));
    expect(d[0]).toBeLessThan(1);
    expect([...d].sort((a, b) => a - b)).toEqual(d); // sorted nearest first
    expect(s.method).toMatch(/NEAREST EDGE/);
    expect(s.map!.features.some((f) => f.properties.kind === "search-location")).toBe(true);
    expect(s.sources!.some((x) => x.layer.includes("ParkApp_Testing"))).toBe(true);
  });

  it("UC2 parks within a radius (and a different radius/address)", async () => {
    const args = { address: ADDRESS, radius_miles: 2 };
    const { s } = await call("find_parks_within_radius", args);
    record("UC2", "Show me parks within 2 miles of 6101 Frisco Square Blvd.", "find_parks_within_radius", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThan(3);
    for (const r of s.results!) expect(Number(r.distanceToBoundaryMiles)).toBeLessThanOrEqual(2);
    const half = await call("find_parks_within_radius", { address: "8000 McKinney Rd", radius_miles: 0.5 });
    expect(half.s.ok).toBe(true);
    expect(half.s.count!).toBeLessThan(s.count!);
  });

  let basketballIds: number[] = [];
  it("UC3 parks by amenity (basketball)", async () => {
    const args = { amenities: ["basketball courts"] };
    const { s } = await call("search_parks_by_amenity", args);
    record("UC3", "Which parks in Frisco have basketball courts?", "search_parks_by_amenity", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThan(5);
    basketballIds = s.results!.map((r) => Number(r.parkId));
  });

  it("UC4 follow-up filter restricted to the previous results", async () => {
    const args = { amenities: ["Basketball", "Playground"], match: "all", restrict_to_park_ids: basketballIds };
    const { s } = await call("search_parks_by_amenity", args);
    record("UC4", "Which of those parks also have playgrounds?", "search_parks_by_amenity", { ...args, restrict_to_park_ids: `[${basketballIds.length} ids]` }, s);
    expect(s.ok).toBe(true);
    expect(s.count!).toBeLessThanOrEqual(basketballIds.length);
    for (const r of s.results!) expect(basketballIds).toContain(Number(r.parkId));
    expect(s.summary).toMatch(/previous results/);
  });

  it("UC5 zoning at an address (point-in-polygon, cross-checked)", async () => {
    const args = { address: ADDRESS };
    const { s } = await call("lookup_zoning", args);
    record("UC5", "What is the zoning at 6101 Frisco Square Blvd?", "lookup_zoning", args, s);
    expect(s.ok).toBe(true);
    expect(String(s.results![0].zoningDistrict)).not.toBe("");
    expect(String(s.results![0].crossCheck)).toMatch(/agree|disagree|Only one/);
    expect(s.map!.features.some((f) => f.properties.kind === "zoning")).toBe(true);
  });

  it("UC6 trails near an address", async () => {
    const args = { address: ADDRESS, radius_miles: 1 };
    const { s } = await call("find_nearby_trails", args);
    record("UC6", "What trails are near 6101 Frisco Square Blvd?", "find_nearby_trails", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThan(0);
    for (const r of s.results!) expect(Number(r.distanceMiles)).toBeLessThanOrEqual(1);
    expect(s.map!.features.some((f) => f.properties.kind === "trail")).toBe(true);
  });

  it("UC7 walking loops (verified attribute only)", async () => {
    const args = { walking_loops_only: true };
    const { s } = await call("search_trails", args);
    record("UC7", "Show me walking loops in Frisco.", "search_trails", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThan(10);
    for (const r of s.results!) expect(r.isWalkingLoop).toBe(true);
  });

  it("UC8 road projects currently under construction (status = Construction only)", async () => {
    const args = {};
    const { s } = await call("find_road_projects", args);
    record("UC8", "What road projects are currently under construction in Frisco?", "find_road_projects", args, s);
    expect(s.ok).toBe(true);
    for (const r of s.results!) {
      expect(r.status).toBe("Construction");
      expect(r.type).toBe("Road");
    }
  });

  it("UC9 road projects near an address", async () => {
    const args = { address: ADDRESS, radius_miles: 1 };
    const { s } = await call("find_road_projects_near", args);
    record("UC9", "Are there any road projects near 6101 Frisco Square Blvd?", "find_road_projects_near", args, s);
    expect(s.ok).toBe(true);
    for (const r of s.results!) expect(Number(r.distanceMiles)).toBeLessThanOrEqual(1);
  });

  it("UC10 speed limit on Preston Road asks which segment", async () => {
    const args = { street_name: "Preston Road" };
    const { s } = await call("get_speed_limit", args);
    record("UC10", "What's the speed limit on Preston Road?", "get_speed_limit", args, s);
    expect(s.ok).toBe(true);
    const groups = s.results![0].speedLimitsByMph as { mph: number }[];
    expect(groups.length).toBeGreaterThan(1);
    expect(s.needsClarification?.options.length).toBe(groups.length);
  });

  it("UC10b speed limit resolved for a specific address", async () => {
    const args = { street_name: "Preston Rd", near_address: "8750 Preston Rd" };
    const { s } = await call("get_speed_limit", args);
    record("UC10b", "What's the speed limit on Preston Road near 8750 Preston Rd?", "get_speed_limit", args, s);
    expect(s.ok).toBe(true);
    expect(s.summary).toMatch(/\d+ mph/);
  });

  it("TOOL search_gis_catalog finds the City's public construction maps", async () => {
    const args = { query: "construction" };
    const { s } = await call("search_gis_catalog", args);
    record("CAT1", "What maps does the City publish about construction?", "search_gis_catalog", args, s);
    expect(s.ok).toBe(true);
    expect(s.count).toBeGreaterThan(0);
    for (const r of s.results!) expect(String(r.itemPage)).toMatch(/^https:\/\/www\.arcgis\.com\/home\/item\.html\?id=/);
  });

  it("TOOL count_features_within_radius agrees with the geodesic park search", async () => {
    const args = { address: ADDRESS, layer: "parks", radius_miles: 2 };
    const { s } = await call("count_features_within_radius", args);
    record("CNT1", "How many parks are within 2 miles of 6101 Frisco Square Blvd?", "count_features_within_radius", args, s);
    expect(s.ok).toBe(true);
    const radius = await call("find_parks_within_radius", { address: ADDRESS, radius_miles: 2 });
    expect(s.results![0].count).toBe(radius.s.count); // server buffer == local geodesic (future sites excluded in both)
  });

  it("TOOL get_map_image renders a PNG through the print GP service and returns it as MCP image content", async () => {
    const parks = await call("find_nearest_parks", { address: ADDRESS, limit: 3 });
    const args = { highlight: parks.s.map, overlay_layers: ["trails"], include_image_data: true };
    const { res, s } = await call("get_map_image", args);
    record("IMG1", "Map image of the nearest-park result", "get_map_image", { highlight: `${parks.s.map!.features.length} features`, overlay_layers: ["trails"] }, s);
    expect(s.ok).toBe(true);
    expect(String(s.results![0].imageUrl)).toMatch(/^https:\/\/utility\.arcgisonline\.com\//);
    const img = (res.content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === "image");
    expect(img?.mimeType).toBe("image/png");
    expect(Buffer.from(img!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(JSON.stringify(res.structuredContent)).not.toContain(img!.data!.slice(0, 50)); // image not duplicated in structured data
  });

  it("invalid address returns a clear, non-fabricated failure", async () => {
    const args = { address: "99999 Nonexistent Imaginary Ln" };
    const { s } = await call("lookup_zoning", args);
    record("NEG1", "What is the zoning at 99999 Nonexistent Imaginary Ln?", "lookup_zoning", args, s);
    expect(s.ok).toBe(false);
    expect(s.error?.code).toBe("ADDRESS_NOT_FOUND");
  });

  it("unknown street returns suggestions instead of a made-up speed limit", async () => {
    const args = { street_name: "Zzyzx Boulevard" };
    const { s } = await call("get_speed_limit", args);
    record("NEG2", "What's the speed limit on Zzyzx Boulevard?", "get_speed_limit", args, s);
    expect(s.ok === false || s.count === 0).toBe(true);
  });
});
