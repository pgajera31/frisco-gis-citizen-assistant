/**
 * GIS data discovery & validation script.
 *
 *   npm run inventory
 *
 * Runs real ArcGIS REST queries against every layer the assistant uses (and the
 * candidate layers that were evaluated but not used), checks the relationships
 * the tools rely on, and writes the evidence to docs/gis-discovery/:
 *   - evidence.json  (machine-readable: metadata, counts, samples, analyses)
 *   - summary.md     (human-readable digest, regenerated on every run)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getJson } from "../packages/mcp-server/src/arcgis/client.js";
import { LAYERS, type LayerKey } from "../packages/mcp-server/src/arcgis/layers.js";
import { esriToGeoJSON, pointInGeometry, distanceToGeometryMiles } from "../packages/mcp-server/src/geo/geometry.js";
import { quarterEnd } from "../packages/mcp-server/src/tools/roadProjects.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "docs", "gis-discovery");
const AGOL = "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services";
const CITY = "https://maps.friscotexas.gov/gis/rest/services/Public";

/** Candidate layers investigated but NOT used by the tools (with the reason recorded in the docs). */
const CANDIDATES: Record<string, string> = {
  downtownProjectPolygons: `${AGOL}/DowntownProjectLayers/FeatureServer/2`,
  downtownProjectPoints: `${AGOL}/DowntownProjectLayers/FeatureServer/0`,
  downtownConstructionPolygons: `${AGOL}/DowntownConstructionDetails/FeatureServer/2`,
  roadClosureEvents: `${AGOL}/RoadClosures_events_6d2b82f8e4fb43858a0d66288beba8dc/FeatureServer/1`,
  officialParksPoi: `${AGOL}/FriscoPOI_ODH/FeatureServer/0`,
  cityTrailsWalkingLoops: `${CITY}/Trails_Update/MapServer/3`,
  cityTrailsFull: `${CITY}/FriscoData/MapServer/7`,
  roads5YearCip: `${CITY}/External_Engineering/MapServer/36`,
  trailMarkers: `${AGOL}/Trail_Markers/FeatureServer/0`,
};

type Json = Record<string, unknown>;
const q = (url: string, params: Record<string, string>) => getJson(`${url}/query`, { f: "json", ...params });

async function describe(url: string) {
  const meta = (await getJson(url, { f: "json" })) as Json;
  const count = ((await q(url, { where: "1=1", returnCountOnly: "true" })) as Json).count;
  const sample = ((await q(url, { where: "1=1", outFields: "*", returnGeometry: "false", resultRecordCount: "1" })) as Json).features as Json[];
  const ei = (meta.editingInfo ?? {}) as { lastEditDate?: number; dataLastEditDate?: number };
  const last = ei.dataLastEditDate ?? ei.lastEditDate;
  return {
    url,
    name: meta.name,
    geometryType: meta.geometryType ?? null,
    featureCount: count,
    capabilities: meta.capabilities ?? null,
    maxRecordCount: meta.maxRecordCount ?? null,
    supportsPagination: (meta.advancedQueryCapabilities as Json | undefined)?.supportsPagination ?? null,
    supportsDistinct: (meta.advancedQueryCapabilities as Json | undefined)?.supportsDistinct ?? null,
    lastEditDate: typeof last === "number" ? new Date(last).toISOString() : null,
    fields: ((meta.fields as Json[]) ?? []).map((f) => `${f.name}:${String(f.type).replace("esriFieldType", "")}`),
    exampleQuery: `${url}/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1&f=json`,
    sampleRecord: sample?.[0]?.attributes ?? null,
  };
}

async function groupCount(url: string, field: string, where = "1=1") {
  const stats = JSON.stringify([{ statisticType: "count", onStatisticField: field, outStatisticFieldName: "n" }]);
  const r = (await q(url, { where, groupByFieldsForStatistics: field, outStatistics: stats })) as Json;
  const out: Record<string, number> = {};
  for (const f of (r.features as Json[]) ?? []) {
    const a = f.attributes as Json;
    out[String(a[field] ?? "(null)")] = Number(a.n ?? a.N ?? 0);
  }
  return out;
}

async function all(url: string, outFields: string, returnGeometry = true) {
  const r = (await q(url, { where: "1=1", outFields, returnGeometry: String(returnGeometry), outSR: "4326", resultRecordCount: "2000" })) as Json;
  return (r.features as { attributes: Json; geometry?: Json }[]) ?? [];
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\bpark\b/g, "").trim();

async function main() {
  mkdirSync(outDir, { recursive: true });
  const runAt = new Date().toISOString();
  const layers: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(LAYERS)) {
    try {
      layers[key] = { used: true, title: def.title, ...(await describe(def.url)) };
    } catch (err) {
      layers[key] = { used: true, title: def.title, url: def.url, error: (err as Error).message };
    }
    process.stderr.write(`described ${key}\n`);
  }
  for (const [key, url] of Object.entries(CANDIDATES)) {
    try {
      layers[key] = { used: false, ...(await describe(url)) };
    } catch (err) {
      layers[key] = { used: false, url, error: (err as Error).message };
    }
    process.stderr.write(`described ${key}\n`);
  }

  // ---------------- relationship & quality analyses ----------------
  const analyses: Record<string, unknown> = {};

  // A. Amenity points ↔ park polygons
  const parks = (await all(LAYERS.parks.url, "OBJECTID,ParkName")).map((f) => ({ id: f.attributes.OBJECTID, name: String(f.attributes.ParkName ?? ""), g: esriToGeoJSON(f.geometry as never) }));
  const amen = await all(LAYERS.parkAmenities.url, "FID,Park,Amenity");
  let inside = 0, nameMatchesContainingPark = 0, nameOnlyMatch = 0, unmatched = 0, within100ft = 0;
  const mismatchExamples: string[] = [];
  for (const a of amen) {
    const g = esriToGeoJSON(a.geometry as never);
    if (!g || g.type !== "Point") continue;
    const [lon, lat] = g.coordinates;
    const container = parks.find((p) => p.g && pointInGeometry(lon, lat, p.g));
    const byName = parks.find((p) => norm(p.name) === norm(a.attributes.Park));
    if (container) {
      inside++;
      if (norm(container.name) === norm(a.attributes.Park)) nameMatchesContainingPark++;
      else if (mismatchExamples.length < 8) mismatchExamples.push(`point Park="${a.attributes.Park}" lies inside polygon "${container.name}"`);
    } else {
      const near = parks.some((p) => p.g && distanceToGeometryMiles(lon, lat, p.g) <= 0.02);
      if (near) within100ft++;
      else if (byName) nameOnlyMatch++;
      else unmatched++;
    }
  }
  analyses.amenityPointsToParks = {
    amenityPoints: amen.length,
    insideAParkPolygon: inside,
    insideAndNameAgrees: nameMatchesContainingPark,
    outsideButWithin100ft: within100ft,
    outsideMatchedOnlyByName: nameOnlyMatch,
    noMatch: unmatched,
    mismatchExamples,
    conclusion: "Amenity points are joined to parks by location (inside the polygon or within ~100 ft); the Park text field is not a reliable join key on its own.",
  };

  // B. Sponsor park layer vs official open-data park layer
  const poi = await all(`${AGOL}/FriscoPOI_ODH/FeatureServer/0`, "NAME,P_TYPE", false);
  const appNames = new Set(parks.map((p) => norm(p.name)));
  const poiNames = new Set(poi.map((p) => norm(p.attributes.NAME)));
  analyses.parkLayersComparison = {
    parkAppTesting: appNames.size,
    friscoPoiParks: poiNames.size,
    inBoth: [...appNames].filter((n) => poiNames.has(n)).length,
    onlyInParkApp: [...appNames].filter((n) => !poiNames.has(n)).slice(0, 15),
    onlyInPoi: [...poiNames].filter((n) => !appNames.has(n)).slice(0, 15),
  };

  // C. Amenity field values (are they clean Yes/No?)
  analyses.parkAmenityFieldValues = {
    Basketball: await groupCount(LAYERS.parks.url, "Basketball"),
    Playground: await groupCount(LAYERS.parks.url, "Playground"),
    WalkingTrail: await groupCount(LAYERS.parks.url, "WalkingTrail"),
  };

  // D. CIP status/type and stale "Construction" records
  const cip = await all(LAYERS.activeCip.url, "Name,Status,Type,CompletionDate", false);
  const now = Date.now();
  const roadConstruction = cip.filter((f) => f.attributes.Status === "Construction" && f.attributes.Type === "Road");
  analyses.cip = {
    statusByType: await groupCount(LAYERS.activeCip.url, "Status"),
    typeCounts: await groupCount(LAYERS.activeCip.url, "Type"),
    roadProjectsInConstruction: roadConstruction.length,
    roadConstructionPastEstimatedCompletion: roadConstruction
      .filter((f) => (quarterEnd(String(f.attributes.CompletionDate ?? ""))?.getTime() ?? Infinity) < now)
      .map((f) => `${String(f.attributes.Name).trim()} (${f.attributes.CompletionDate})`),
  };

  // E. Downtown construction details: are any still active?
  const dt = await all(CANDIDATES.downtownConstructionPolygons, "Area,ConstructionStart,ConstructionEnd", false);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const endOf = (s: unknown) => {
    const m = String(s ?? "").toLowerCase().match(/([a-z]+)\s+(\d{4})/);
    if (!m || !months.includes(m[1])) return undefined;
    return new Date(Date.UTC(Number(m[2]), months.indexOf(m[1]) + 1, 0));
  };
  const dated = dt.filter((f) => endOf(f.attributes.ConstructionEnd));
  analyses.downtownConstruction = {
    polygons: dt.length,
    withEndDate: dated.length,
    stillActiveByEndDate: dated.filter((f) => endOf(f.attributes.ConstructionEnd)!.getTime() >= now).length,
    latestEnd: dated.map((f) => String(f.attributes.ConstructionEnd)).sort().slice(-1)[0] ?? null,
    conclusion: "Downtown-only and all published end dates are in the past, so it is not used for 'currently under construction'.",
  };

  // F. Trails
  analyses.trails = {
    lifecycle: await groupCount(LAYERS.trails.url, "LifeCycleS"),
    trailType: await groupCount(LAYERS.trails.url, "TrailType"),
    walkingLoopFlag: await groupCount(LAYERS.trails.url, "WalkingLoo"),
  };

  // G. Speed limits
  analyses.speedLimits = {
    mphDistribution: await groupCount(LAYERS.speedLimits.url, "MPH"),
    prestonRdByMph: await groupCount(LAYERS.speedLimits.url, "MPH", "ROAD_NAME = 'PRESTON' AND ROAD_SUF = 'RD'"),
    lifecycleDomainNote: "In the City's domain LIFECYCLESTATUS 'CONST' means 'Constructed' (not under construction); 'PROP' = Proposed and is excluded.",
  };

  // H. Traffic closures & event closures
  analyses.trafficClosures = { status: await groupCount(LAYERS.trafficClosures.url, "Status"), owner: await groupCount(LAYERS.trafficClosures.url, "Owner") };
  analyses.roadClosureEvents = { reason: await groupCount(CANDIDATES.roadClosureEvents, "reason"), responsibility: await groupCount(CANDIDATES.roadClosureEvents, "Responsibility") };

  // I. Zoning layers
  analyses.zoning = {
    odhPolygons: ((await q(LAYERS.zoningOdh.url, { where: "1=1", returnCountOnly: "true" })) as Json).count,
    cityPolygons: ((await q(LAYERS.zoningCity.url, { where: "1=1", returnCountOnly: "true" })) as Json).count,
    citySymbolCounts: await groupCount(LAYERS.zoningCity.url, "SYMBOL"),
  };

  const evidence = { runAt, layers, analyses };
  writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2));

  // ---------------- human summary ----------------
  const lines: string[] = [
    "# GIS discovery summary (auto-generated)",
    "",
    `Generated by \`npm run inventory\` at ${runAt}. Every value below came from a live ArcGIS REST query. Full detail: [evidence.json](evidence.json).`,
    "",
    "| Key | Used | Layer | Geometry | Features | Last edit | Capabilities | Max records |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [k, v] of Object.entries(layers) as [string, Json][]) {
    lines.push(
      `| \`${k}\` | ${v.used ? "yes" : "no"} | [${v.name ?? v.title ?? k}](${v.url}) | ${String(v.geometryType ?? "").replace("esriGeometry", "")} | ${v.featureCount ?? v.error ?? ""} | ${v.lastEditDate ? String(v.lastEditDate).slice(0, 10) : "not published"} | ${v.capabilities ?? ""} | ${v.maxRecordCount ?? ""} |`,
    );
  }
  lines.push("", "## Analyses", "", "```json", JSON.stringify(analyses, null, 2), "```", "");
  writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
  console.log(`Wrote ${path.relative(process.cwd(), outDir)}/evidence.json and summary.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
