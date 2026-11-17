import type { Geometry } from "geojson";
import { queryLayerCached } from "../arcgis/client.js";
import { distanceToGeometryMiles, esriToGeoJSON, lineLengthMiles, roundMiles } from "../geo/geometry.js";
import {
  emptyMap,
  geocoderSource,
  locationFeature,
  mapFeature,
  sourcesFor,
  str,
  type ToolSuccess,
  UserFacingError,
} from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

import { TRAIL_TYPES } from "../vocabulary.js";

export { TRAIL_TYPES };
export const TRAIL_STATUSES = ["Existing", "Under Construction", "Future", "Abandoned"] as const;

interface TrailSegment {
  id: number;
  name?: string;
  trailType?: string;
  bikeRoute?: string;
  surface?: string;
  width?: string;
  owner?: string;
  walkingLoop: boolean;
  connector: boolean;
  status?: string;
  geometry: Geometry;
  lengthMiles: number;
}

async function loadTrails(): Promise<TrailSegment[]> {
  const feats = await queryLayerCached("trails", {
    outFields: ["OBJECTID", "Name", "TrailType", "BikeRouteT", "Surface", "Width", "Owner", "WalkingLoo", "Connector", "LifeCycleS"],
    geometryPrecision: 6,
  });
  const out: TrailSegment[] = [];
  for (const f of feats) {
    const g = esriToGeoJSON(f.geometry);
    if (!g) continue;
    const a = f.attributes;
    out.push({
      id: Number(a.OBJECTID),
      name: str(a.Name),
      trailType: str(a.TrailType),
      bikeRoute: str(a.BikeRouteT),
      surface: str(a.Surface),
      width: str(a.Width),
      owner: str(a.Owner),
      walkingLoop: str(a.WalkingLoo)?.toLowerCase() === "yes",
      connector: str(a.Connector)?.toLowerCase() === "yes",
      status: str(a.LifeCycleS),
      geometry: g,
      lengthMiles: lineLengthMiles(g),
    });
  }
  return out;
}

interface TrailGroup {
  name: string;
  segments: TrailSegment[];
  nearestMiles?: number;
}

/** Group segments by trail name (unnamed segments each stay separate). */
function groupByName(segs: TrailSegment[]): TrailGroup[] {
  const groups = new Map<string, TrailGroup>();
  for (const s of segs) {
    const key = s.name ? s.name.toLowerCase() : `__unnamed_${s.id}`;
    const g = groups.get(key) ?? { name: s.name ?? "Unnamed trail segment", segments: [] };
    g.segments.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function groupResult(g: TrailGroup) {
  return {
    name: g.name,
    trailTypes: distinct(g.segments.map((s) => s.trailType)),
    surfaces: distinct(g.segments.map((s) => s.surface)),
    statuses: distinct(g.segments.map((s) => s.status)),
    isWalkingLoop: g.segments.some((s) => s.walkingLoop),
    hasBikeLane: g.segments.some((s) => /bike lane/i.test(s.bikeRoute ?? "")),
    segmentCount: g.segments.length,
    mappedLengthMiles: roundMiles(g.segments.reduce((t, s) => t + s.lengthMiles, 0)),
    ...(g.nearestMiles !== undefined ? { distanceMiles: roundMiles(g.nearestMiles) } : {}),
  };
}

function trailFeatures(groups: TrailGroup[]) {
  return groups.flatMap((g) =>
    g.segments.map((s) =>
      mapFeature(s.geometry, {
        kind: "trail",
        id: `trail-${s.id}`,
        label: g.name,
        details: [
          s.trailType ? `Type: ${s.trailType}` : "",
          s.surface ? `Surface: ${s.surface}` : "",
          s.walkingLoop ? "Walking loop: Yes" : "",
          s.status ? `Status: ${s.status}` : "",
        ].filter(Boolean),
        styleValue: s.walkingLoop ? "walking-loop" : s.status === "Existing" ? (s.trailType ?? "trail") : "not-open",
      }),
    ),
  );
}

const TRAIL_LIMITATIONS = [
  "Trail lines come from the City's Hike & Bike Trails open-data layer. Mapped length is measured from the line geometry and may differ from posted lengths.",
  "Only trails with status 'Existing' are included unless you ask for planned or under-construction trails.",
];

function statusFilter(includeNotOpen?: boolean) {
  return (s: TrailSegment) => (includeNotOpen ? s.status !== "Abandoned" : s.status === "Existing");
}

/** Use case 6: trails near a location. */
export async function findTrailsNear(
  args: LocationInput & { radiusMiles?: number; includeNotOpen?: boolean; includeBikeOnly?: boolean; limit?: number },
): Promise<ToolSuccess> {
  const tool = "find_nearby_trails";
  const radius = args.radiusMiles ?? 1;
  const location = await resolveLocation(args);
  const segs = (await loadTrails()).filter(statusFilter(args.includeNotOpen));
  const within = segs
    .map((s) => ({ s, d: distanceToGeometryMiles(location.lon, location.lat, s.geometry) }))
    .filter((x) => x.d <= radius);
  // "Bike Only" segments are on-street bike routes, not walkable trails; excluded unless requested.
  const near = args.includeBikeOnly ? within : within.filter((x) => x.s.trailType !== "Bike Only");
  const bikeOnlyExcluded = groupByName(within.filter((x) => x.s.trailType === "Bike Only").map((x) => x.s)).length;
  const groups = groupByName(near.map((x) => x.s));
  for (const g of groups) g.nearestMiles = Math.min(...near.filter((x) => g.segments.includes(x.s)).map((x) => x.d));
  groups.sort((a, b) => (a.nearestMiles ?? 0) - (b.nearestMiles ?? 0));
  const shown = groups.slice(0, args.limit ?? 15);

  const map = emptyMap();
  map.features.push(locationFeature(location), ...trailFeatures(shown));
  const named = shown.filter((g) => !g.name.startsWith("Unnamed"));
  return {
    ok: true,
    tool,
    summary:
      shown.length === 0
        ? `No mapped trails are within ${radius} mile${radius === 1 ? "" : "s"} of ${location.matchedAddress}.`
        : `${groups.length} trail${groups.length === 1 ? " is" : "s are"} within ${radius} mile${radius === 1 ? "" : "s"} of ${location.matchedAddress}` +
          (named.length ? `; the closest named trail is ${named[0].name} (${roundMiles(named[0].nearestMiles ?? 0)} mi).` : "."),
    location,
    count: shown.length,
    results: shown.map(groupResult),
    method:
      `Each trail segment's straight-line distance from the location to the nearest point on the trail line was computed; ` +
      `segments within ${radius} miles were grouped by trail name, and each trail's distance is that of its closest segment.`,
    limitations: [
      ...TRAIL_LIMITATIONS,
      ...(!args.includeBikeOnly && bikeOnlyExcluded
        ? [`${bikeOnlyExcluded} on-street "Bike Only" route(s) nearby were left out; ask for bike routes to include them.`]
        : []),
    ],
    sources: [geocoderSource(location), ...(await sourcesFor(["trails"]))],
    map,
  };
}

/** Use case 7: trails by classification (walking loops, regional, nature…) and/or name. */
export async function searchTrails(args: {
  walkingLoopsOnly?: boolean;
  trailType?: string;
  nameContains?: string;
  bikeLanesOnly?: boolean;
  includeNotOpen?: boolean;
  limit?: number;
}): Promise<ToolSuccess> {
  const tool = "search_trails";
  let trailType: string | undefined;
  if (args.trailType) {
    trailType = TRAIL_TYPES.find((t) => t.toLowerCase() === args.trailType!.toLowerCase().trim());
    if (!trailType) {
      throw new UserFacingError("UNKNOWN_TRAIL_TYPE", `Trail types in the City data are: ${TRAIL_TYPES.join(", ")}.`);
    }
  }
  if (!args.walkingLoopsOnly && !trailType && !args.nameContains && !args.bikeLanesOnly) {
    throw new UserFacingError("FILTER_REQUIRED", "Please choose a trail type, walking loops, bike lanes, or a trail name to search for.");
  }
  const nameQ = args.nameContains?.toLowerCase().trim();
  const segs = (await loadTrails())
    .filter(statusFilter(args.includeNotOpen))
    .filter((s) => (args.walkingLoopsOnly ? s.walkingLoop : true))
    .filter((s) => (trailType ? s.trailType === trailType : true))
    .filter((s) => (args.bikeLanesOnly ? /bike lane/i.test(s.bikeRoute ?? "") : true))
    .filter((s) => (nameQ ? (s.name ?? "").toLowerCase().includes(nameQ) : true));
  const groups = groupByName(segs).sort((a, b) => a.name.localeCompare(b.name));
  const shown = groups.slice(0, args.limit ?? 60);

  const what = [
    args.walkingLoopsOnly ? "walking loops" : "",
    trailType ? `${trailType} trails` : "",
    args.bikeLanesOnly ? "bike lanes" : "",
    nameQ ? `trails named like "${args.nameContains}"` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const map = emptyMap();
  map.features.push(...trailFeatures(shown));
  return {
    ok: true,
    tool,
    summary:
      groups.length === 0
        ? `No ${what} were found in the City trail data.`
        : `Found ${groups.length} ${what} in Frisco${groups.length > shown.length ? ` (showing ${shown.length})` : ""}.`,
    count: shown.length,
    results: shown.map(groupResult),
    method:
      (args.walkingLoopsOnly
        ? "Walking loops are trail segments whose 'WalkingLoo' (Walking Loop) attribute is 'Yes' in the City data; no loop is inferred from shape alone. "
        : "") +
      (trailType ? `Trail type uses the City's 'TrailType' attribute (${TRAIL_TYPES.join(", ")}). ` : "") +
      "Segments are grouped by trail name.",
    limitations: TRAIL_LIMITATIONS,
    sources: await sourcesFor(["trails"]),
    map,
  };
}
