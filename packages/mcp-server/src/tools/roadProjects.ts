import { type EsriFeature, queryLayer, queryLayerCached, sqlString } from "../arcgis/client.js";
import type { LayerKey } from "../arcgis/layers.js";
import { distanceToGeometryMiles, esriToGeoJSON, roundMiles } from "../geo/geometry.js";
import {
  emptyMap,
  geocoderSource,
  locationFeature,
  mapFeature,
  sourcesFor,
  str,
  type ToolSuccess,
} from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

import { CIP_STATUSES, CIP_TYPES } from "../vocabulary.js";

export { CIP_STATUSES, CIP_TYPES };
export type CipStatus = (typeof CIP_STATUSES)[number];
export type CipType = (typeof CIP_TYPES)[number];

const CIP_FIELDS = [
  "OBJECTID", "ProjectNumber", "Name", "Limits", "Type", "Subtype", "Description", "Status",
  "BidDate", "CompletionDate", "OPCC", "WebLink",
];

/** Load CIP features; falls back to the mirror layer if the primary is unavailable. */
async function loadCip(where: string): Promise<{ features: EsriFeature[]; layer: LayerKey }> {
  try {
    return { features: await queryLayerCached("activeCip", { where, outFields: CIP_FIELDS, geometryPrecision: 6 }), layer: "activeCip" };
  } catch (err) {
    console.error("[road-projects] primary CIP layer failed, trying mirror", (err as Error).message);
    return { features: await queryLayerCached("activeCipMirror", { where, outFields: CIP_FIELDS, geometryPrecision: 6 }), layer: "activeCipMirror" };
  }
}

function clean(s: unknown): string | undefined {
  return str(s)?.replace(/\s+/g, " ").trim();
}

/**
 * Parse the CIP "YYYY Qn" estimate into the last day of that quarter (UTC).
 * Returns undefined for "TBD", blanks, or unrecognised text.
 */
export function quarterEnd(text: string | undefined): Date | undefined {
  const m = text?.match(/^\s*(20\d{2})\s*Q([1-4])\s*$/i);
  if (!m) return undefined;
  const year = Number(m[1]);
  const q = Number(m[2]);
  return new Date(Date.UTC(year, q * 3, 0, 23, 59, 59)); // day 0 of next quarter's first month
}

function projectRow(f: EsriFeature, now = new Date()) {
  const a = f.attributes;
  const completion = clean(a.CompletionDate);
  const end = quarterEnd(completion);
  return {
    projectNumber: clean(a.ProjectNumber) ?? null,
    name: clean(a.Name) ?? "Unnamed project",
    limits: clean(a.Limits) ?? null,
    type: clean(a.Type) ?? null,
    subtype: clean(a.Subtype) ?? null,
    description: clean(a.Description) ?? null,
    status: clean(a.Status) ?? null,
    bidDate: clean(a.BidDate) ?? null,
    estimatedCompletion: completion ?? null,
    /** True when the City's estimated completion quarter is already over (status may be stale). */
    estimatedCompletionPassed: end ? end.getTime() < now.getTime() : null,
    estimatedCost: clean(a.OPCC) ?? null,
    link: clean(a.WebLink) ?? null,
  };
}

const STATUS_NOTE =
  "'Construction' means the City's CIP data lists the project in its construction phase. Projects in Planning, Design, On Hold " +
  "or Completed are not counted as active construction. Completion dates are the City's estimates (by quarter).";

/** Use cases 8 & 9: CIP road projects, optionally near a location. */
export async function findRoadProjects(
  args: Partial<LocationInput> & {
    statuses?: CipStatus[];
    projectTypes?: CipType[];
    radiusMiles?: number;
    limit?: number;
  },
): Promise<ToolSuccess> {
  const nearMode = Boolean(args.address || (args.latitude !== undefined && args.longitude !== undefined));
  const tool = nearMode ? "find_road_projects_near" : "find_road_projects";
  const statuses = args.statuses?.length ? args.statuses : (["Construction"] as CipStatus[]);
  const types = args.projectTypes?.length ? args.projectTypes : (["Road"] as CipType[]);
  const where = `Status IN (${statuses.map(sqlString).join(",")}) AND Type IN (${types.map(sqlString).join(",")})`;

  const location = nearMode ? await resolveLocation(args as LocationInput) : undefined;
  const { features, layer } = await loadCip(where);
  const radius = args.radiusMiles ?? 1;

  let rows = features
    .map((f) => {
      const g = esriToGeoJSON(f.geometry);
      const d = location && g ? distanceToGeometryMiles(location.lon, location.lat, g) : undefined;
      return { f, g, d };
    })
    .filter((r) => r.g);
  if (location) rows = rows.filter((r) => (r.d ?? Infinity) <= radius).sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  else rows.sort((a, b) => projectRow(a.f).name.localeCompare(projectRow(b.f).name));
  const total = rows.length;
  rows = rows.slice(0, args.limit ?? 50);

  const map = emptyMap();
  if (location) map.features.push(locationFeature(location));
  for (const r of rows) {
    const p = projectRow(r.f);
    map.features.push(
      mapFeature(r.g!, {
        kind: "road-project",
        id: `cip-${r.f.attributes.OBJECTID}`,
        label: p.name,
        details: [
          p.limits ? `Limits: ${p.limits}` : "",
          p.description ?? "",
          p.status ? `Status: ${p.status}` : "",
          p.estimatedCompletion ? `Est. completion: ${p.estimatedCompletion}` : "",
        ].filter(Boolean),
        styleValue: p.status ?? "",
      }),
    );
  }

  const onlyConstruction = statuses.length === 1 && statuses[0] === "Construction";
  const statusText = onlyConstruction ? "under construction" : `(status: ${statuses.join(", ")})`;
  const typeText = types.map((t) => t.toLowerCase()).join(" / ");
  const miles = `${radius} mile${radius === 1 ? "" : "s"}`;
  const resultRows = rows.map((r) => ({ ...projectRow(r.f), ...(r.d !== undefined ? { distanceMiles: roundMiles(r.d) } : {}) }));
  const overdue = resultRows.filter((r) => r.status === "Construction" && r.estimatedCompletionPassed);
  const summary =
    (location
      ? total === 0
        ? `No City ${typeText} capital projects ${statusText} are within ${miles} of ${location.matchedAddress}.`
        : `${total} City ${typeText} capital project${total === 1 ? " is" : "s are"} within ${miles} of ${location.matchedAddress} ${statusText}.`
      : `The City's capital improvement data lists ${total} ${typeText} project${total === 1 ? "" : "s"} ${statusText}.`) +
    (overdue.length
      ? ` Note: ${overdue.length} of ${overdue.length === 1 ? "them is" : "them are"} still marked 'Construction' even though the estimated completion date has passed, so ${overdue.length === 1 ? "its" : "their"} status may be out of date.`
      : "");

  return {
    ok: true,
    tool,
    summary,
    ...(location ? { location } : {}),
    count: rows.length,
    results: resultRows,
    method:
      `Queried the City's Capital Improvement Projects (CIP) layer for Status in (${statuses.join(", ")}) and Type in (${types.join(", ")}). ` +
      (location ? `Projects are included when any part of the project line is within ${radius} straight-line miles of the location. ` : "") +
      STATUS_NOTE,
    limitations: [
      "Covers City of Frisco capital improvement projects only. TxDOT, NTTA (tollway), county, and private-developer road work is not included.",
      "This CIP service does not publish a data-last-edited timestamp; the retrieval time is shown instead.",
      ...(overdue.length
        ? [`${overdue.length} project(s) marked 'Construction' have an estimated completion quarter that has already passed (${overdue.map((o) => `${o.name}: ${o.estimatedCompletion}`).slice(0, 6).join("; ")}). The City may not have updated their status yet.`]
        : []),
    ],
    sources: [...(location ? [geocoderSource(location)] : []), ...(await sourcesFor([layer]))],
    map,
  };
}

/** Supporting info: currently active lane/traffic closures (distinct from construction projects). */
export async function findTrafficClosures(args: Partial<LocationInput> & { radiusMiles?: number }): Promise<ToolSuccess> {
  const tool = "find_traffic_closures";
  const nearMode = Boolean(args.address || (args.latitude !== undefined && args.longitude !== undefined));
  const location = nearMode ? await resolveLocation(args as LocationInput) : undefined;
  const feats = await queryLayer("trafficClosures", {
    where: "Status = 'Active'",
    outFields: ["OBJECTID", "Description", "TimePeriod", "Status", "Owner"],
    maxFeatures: 500,
  });
  const radius = args.radiusMiles ?? 2;
  let rows = feats.map((f) => {
    const g = esriToGeoJSON(f.geometry);
    return { f, g, d: location && g ? distanceToGeometryMiles(location.lon, location.lat, g) : undefined };
  });
  if (location) rows = rows.filter((r) => (r.d ?? Infinity) <= radius);
  const map = emptyMap();
  if (location) map.features.push(locationFeature(location));
  for (const r of rows) {
    if (!r.g) continue;
    map.features.push(
      mapFeature(r.g, {
        kind: "traffic-closure",
        id: `closure-${r.f.attributes.OBJECTID}`,
        label: str(r.f.attributes.Description) ?? "Traffic closure",
        details: [str(r.f.attributes.TimePeriod) ? `When: ${str(r.f.attributes.TimePeriod)}` : "", str(r.f.attributes.Owner) ? `Owner: ${str(r.f.attributes.Owner)}` : ""].filter(Boolean),
      }),
    );
  }
  return {
    ok: true,
    tool,
    summary:
      rows.length === 0
        ? `No closures are marked 'Active' in the City's traffic closure layer${location ? ` within ${radius} miles of ${location.matchedAddress}` : ""}.`
        : `${rows.length} closure${rows.length === 1 ? " is" : "s are"} marked 'Active' in the City's traffic closure layer${location ? ` within ${radius} miles of ${location.matchedAddress}` : ""}.`,
    ...(location ? { location } : {}),
    count: rows.length,
    results: rows.map((r) => ({
      description: str(r.f.attributes.Description) ?? null,
      timePeriod: str(r.f.attributes.TimePeriod) ?? null,
      owner: str(r.f.attributes.Owner) ?? null,
      ...(r.d !== undefined ? { distanceMiles: roundMiles(r.d) } : {}),
    })),
    method: "Selected closure polygons whose Status is 'Active'. A closure is a lane or road closure notice, not necessarily a construction project.",
    limitations: [
      "Most records in this layer are NTTA (tollway) closures; time periods are free text without a year, so 'Active' depends on the City keeping the Status field current.",
    ],
    sources: [...(location ? [geocoderSource(location)] : []), ...(await sourcesFor(["trafficClosures"]))],
    map,
  };
}
