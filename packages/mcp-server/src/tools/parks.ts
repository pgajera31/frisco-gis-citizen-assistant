import type { Geometry } from "geojson";
import { queryLayerCached } from "../arcgis/client.js";
import {
  distanceToCentroidMiles,
  distanceToGeometryMiles,
  esriToGeoJSON,
  pointInGeometry,
  roundMiles,
} from "../geo/geometry.js";
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
import { AMENITIES, AMENITY_LABELS, normalizeAmenity, normalizeText as norm } from "../vocabulary.js";

export { AMENITIES, AMENITY_LABELS, normalizeAmenity };

export function normalizeAmenities(inputs: string[]): (typeof AMENITIES)[number][] {
  const out: (typeof AMENITIES)[number][] = [];
  const unknown: string[] = [];
  for (const raw of inputs) {
    const a = normalizeAmenity(raw);
    if (a) {
      if (!out.includes(a)) out.push(a);
    } else unknown.push(raw);
  }
  if (unknown.length) {
    throw new UserFacingError(
      "UNKNOWN_AMENITY",
      `The park data does not track "${unknown.join('", "')}". Tracked amenities are: ${AMENITY_LABELS.join(", ")}.`,
    );
  }
  return out;
}

function truthyAmenityValue(v: unknown): boolean {
  const s = str(v);
  if (!s) return false;
  return !/^(no|none|n|0|false|null)$/i.test(s);
}

export interface Park {
  id: number;
  name: string;
  address?: string;
  description?: string;
  website?: string;
  /** Amenities flagged on the park polygon's own attribute fields. */
  attributeAmenities: string[];
  geometry: Geometry;
}

export interface AmenityPoint {
  id: number;
  parkNameField?: string;
  amenity: string;
  geometry: Geometry;
  /** Park polygon this point falls inside (or within 100 ft of), if any. */
  parkId?: number;
}

const PARK_FIELDS = ["OBJECTID", "ParkName", "Address", "ParkDesc", "Website", "AllAmenities", ...AMENITIES.map((a) => a.field)];

export async function loadParks(): Promise<Park[]> {
  const feats = await queryLayerCached("parks", { outFields: PARK_FIELDS, geometryPrecision: 6 });
  const parks: Park[] = [];
  for (const f of feats) {
    const geometry = esriToGeoJSON(f.geometry);
    const name = str(f.attributes.ParkName);
    if (!geometry || !name) continue; // skip records without usable geometry or name
    parks.push({
      id: Number(f.attributes.OBJECTID),
      name,
      address: str(f.attributes.Address),
      description: str(f.attributes.ParkDesc),
      website: str(f.attributes.Website),
      attributeAmenities: AMENITIES.filter((a) => truthyAmenityValue(f.attributes[a.field])).map((a) => a.label),
      geometry,
    });
  }
  return parks;
}

/** Tolerance for amenity points digitized just outside a park boundary (≈100 ft). */
const AMENITY_SNAP_MILES = 0.02;

export async function loadAmenityPoints(parks: Park[]): Promise<AmenityPoint[]> {
  const feats = await queryLayerCached("parkAmenities", { outFields: ["FID", "Park", "Amenity"], geometryPrecision: 6 });
  const out: AmenityPoint[] = [];
  for (const f of feats) {
    const geometry = esriToGeoJSON(f.geometry);
    const amenity = str(f.attributes.Amenity);
    if (!geometry || geometry.type !== "Point" || !amenity || /^none$/i.test(amenity)) continue;
    const [lon, lat] = geometry.coordinates;
    let parkId: number | undefined = parks.find((p) => pointInGeometry(lon, lat, p.geometry))?.id;
    if (parkId === undefined) {
      let best = Infinity;
      for (const p of parks) {
        const d = distanceToGeometryMiles(lon, lat, p.geometry);
        if (d < best && d <= AMENITY_SNAP_MILES) {
          best = d;
          parkId = p.id;
        }
      }
    }
    out.push({ id: Number(f.attributes.FID), parkNameField: str(f.attributes.Park), amenity, geometry, parkId });
  }
  return out;
}

interface AmenityEvidence {
  amenity: string;
  parkAttribute: boolean;
  amenityPoints: number;
}

function evidenceFor(park: Park, amenityLabel: string, points: AmenityPoint[]): AmenityEvidence {
  return {
    amenity: amenityLabel,
    parkAttribute: park.attributeAmenities.includes(amenityLabel),
    amenityPoints: points.filter((p) => p.parkId === park.id && norm(p.amenity) === norm(amenityLabel)).length,
  };
}

function hasAmenity(e: AmenityEvidence): boolean {
  return e.parkAttribute || e.amenityPoints > 0;
}

function parkPopup(p: Park, extra: string[] = []): string[] {
  return [
    ...(p.address ? [`Address: ${p.address}`] : []),
    ...extra,
    ...(p.attributeAmenities.length ? [`Amenities: ${p.attributeAmenities.join(", ")}`] : []),
  ];
}

function parkSummary(p: Park) {
  return {
    parkId: p.id,
    name: p.name,
    address: p.address ?? null,
    amenities: p.attributeAmenities,
    website: p.website ?? null,
  };
}

const DISTANCE_METHOD =
  "Distance is the straight-line (as-the-crow-flies) geodesic distance from the searched location to the NEAREST EDGE " +
  "of each park's boundary polygon (0 miles if the location is inside the park). It is not walking or driving distance, " +
  "and it is not measured to a park entrance, because the park data does not include entrance locations. " +
  "The distance to each park's center (centroid) is also reported for comparison.";

const PARK_LIMITATIONS = [
  "Park polygons and amenity flags come from the sponsor-provided ParkApp_Testing layer; amenities can change faster than the data is updated.",
  "Distances are straight-line, not travel distance along streets or trails.",
];

async function amenityFilter(amenities?: string[]) {
  return amenities && amenities.length ? normalizeAmenities(amenities) : [];
}

function amenityMapFeatures(points: AmenityPoint[], parkIds: Set<number>, labels: string[]) {
  const wanted = new Set(labels.map(norm));
  return points
    .filter((p) => p.parkId !== undefined && parkIds.has(p.parkId) && wanted.has(norm(p.amenity)))
    .map((p) =>
      mapFeature(p.geometry, { kind: "amenity", id: `amenity-${p.id}`, label: p.amenity, details: p.parkNameField ? [`Park: ${p.parkNameField}`] : [] }),
    );
}

/** Use cases 1 & 2: nearest parks and parks within a radius. */
export async function findParksNear(
  loc: LocationInput & { radiusMiles?: number; limit?: number; amenities?: string[] },
  tool: string,
): Promise<ToolSuccess> {
  const required = await amenityFilter(loc.amenities);
  const location = await resolveLocation(loc);
  const parks = await loadParks();
  const points = required.length ? await loadAmenityPoints(parks) : [];

  let ranked = parks
    .map((p) => ({
      park: p,
      edge: distanceToGeometryMiles(location.lon, location.lat, p.geometry),
      center: distanceToCentroidMiles(location.lon, location.lat, p.geometry),
      evidence: required.map((a) => evidenceFor(p, a.label, points)),
    }))
    .filter((r) => r.evidence.every(hasAmenity))
    .sort((a, b) => a.edge - b.edge);

  if (loc.radiusMiles !== undefined) ranked = ranked.filter((r) => r.edge <= loc.radiusMiles!);
  const limit = loc.limit ?? (loc.radiusMiles !== undefined ? 50 : 3);
  const totalMatches = ranked.length;
  ranked = ranked.slice(0, limit);

  const results = ranked.map((r) => ({
    ...parkSummary(r.park),
    distanceToBoundaryMiles: roundMiles(r.edge),
    distanceToCenterMiles: roundMiles(r.center),
    locationIsInsidePark: r.edge === 0,
    ...(required.length ? { amenityEvidence: r.evidence } : {}),
  }));

  const filterText = required.length ? ` with ${required.map((a) => a.label).join(" and ")}` : "";
  let summary: string;
  if (loc.radiusMiles !== undefined) {
    summary =
      totalMatches === 0
        ? `No parks${filterText} have any part within ${loc.radiusMiles} miles of ${location.matchedAddress}.`
        : `${totalMatches} park${totalMatches === 1 ? "" : "s"}${filterText} ha${totalMatches === 1 ? "s" : "ve"} part of the park within ${loc.radiusMiles} miles of ${location.matchedAddress}` +
          (totalMatches > results.length ? ` (showing the closest ${results.length}).` : ".");
  } else if (results.length === 0) {
    summary = `No parks${filterText} were found in the park data.`;
  } else {
    const first = results[0];
    summary = `The closest park${filterText} to ${location.matchedAddress} is ${first.name}, ${first.distanceToBoundaryMiles} miles to the nearest park boundary` +
      (first.locationIsInsidePark ? " (the location is inside the park)." : ".");
  }

  const ids = new Set(ranked.map((r) => r.park.id));
  const map = emptyMap();
  map.features.push(locationFeature(location));
  for (const r of ranked) {
    map.features.push(
      mapFeature(r.park.geometry, {
        kind: "park",
        id: `park-${r.park.id}`,
        label: r.park.name,
        details: parkPopup(r.park, [`Distance to boundary: ${roundMiles(r.edge)} mi`]),
      }),
    );
  }
  map.features.push(...amenityMapFeatures(points, ids, required.map((a) => a.label)));

  return {
    ok: true,
    tool,
    summary,
    location,
    count: results.length,
    results,
    method:
      (loc.radiusMiles !== undefined
        ? `A park is included when any part of its boundary is within ${loc.radiusMiles} straight-line miles of the location. `
        : "") +
      DISTANCE_METHOD +
      (required.length
        ? " Amenity matches use the park layer's amenity fields and/or amenity points located inside the park polygon."
        : ""),
    limitations: [
      ...PARK_LIMITATIONS,
      ...(location.inFriscoCityLimits === false ? ["The searched location appears to be outside Frisco city limits."] : []),
    ],
    sources: [geocoderSource(location), ...(await sourcesFor(required.length ? ["parks", "parkAmenities"] : ["parks"]))],
    map,
  };
}

/** Use cases 3 & 4: parks having one or more amenities, optionally restricted to an earlier result set. */
export async function searchParksByAmenity(args: {
  amenities: string[];
  match?: "all" | "any";
  restrictToParkIds?: number[];
  restrictToParkNames?: string[];
}): Promise<ToolSuccess> {
  const tool = "search_parks_by_amenity";
  const required = normalizeAmenities(args.amenities);
  if (required.length === 0) throw new UserFacingError("AMENITY_REQUIRED", "Please name at least one park amenity.");
  const match = args.match ?? "all";
  const parks = await loadParks();
  const points = await loadAmenityPoints(parks);

  let pool = parks;
  const restricted = Boolean(args.restrictToParkIds?.length || args.restrictToParkNames?.length);
  if (restricted) {
    const ids = new Set(args.restrictToParkIds ?? []);
    const names = new Set((args.restrictToParkNames ?? []).map(norm));
    pool = parks.filter((p) => ids.has(p.id) || names.has(norm(p.name)));
  }

  const rows = pool
    .map((p) => ({ park: p, evidence: required.map((a) => evidenceFor(p, a.label, points)) }))
    .filter((r) => (match === "all" ? r.evidence.every(hasAmenity) : r.evidence.some(hasAmenity)))
    .sort((a, b) => a.park.name.localeCompare(b.park.name));

  const conflicts = rows.flatMap((r) =>
    r.evidence
      .filter((e) => e.parkAttribute !== e.amenityPoints > 0)
      .map((e) => `${r.park.name}: ${e.amenity} is ${e.parkAttribute ? "listed on the park record but has no mapped amenity point" : "mapped as a point inside the park but not listed on the park record"}`),
  );

  const labels = required.map((a) => a.label);
  const joiner = match === "all" ? " and " : " or ";
  const scope = restricted ? `Of the ${pool.length} parks from the previous results, ` : "";
  const summary =
    rows.length === 0
      ? `${scope}no parks${restricted ? "" : " in Frisco"} have ${labels.join(joiner)} according to the park data.`
      : `${scope}${rows.length} park${rows.length === 1 ? "" : "s"}${restricted ? "" : " in Frisco"} ha${rows.length === 1 ? "s" : "ve"} ${labels.join(joiner)}.`;

  const ids = new Set(rows.map((r) => r.park.id));
  const map = emptyMap();
  for (const r of rows) {
    map.features.push(
      mapFeature(r.park.geometry, { kind: "park", id: `park-${r.park.id}`, label: r.park.name, details: parkPopup(r.park) }),
    );
  }
  map.features.push(...amenityMapFeatures(points, ids, labels));

  return {
    ok: true,
    tool,
    summary,
    count: rows.length,
    results: rows.map((r) => ({ ...parkSummary(r.park), amenityEvidence: r.evidence })),
    method:
      `A park matches an amenity when the park record's "${required.map((a) => a.field).join('", "')}" field is set, or when an amenity ` +
      "point of that type lies inside the park boundary (within ~100 ft). Amenity points are matched to parks by location, not by name. " +
      (match === "all" ? "Parks must have every requested amenity." : "Parks need at least one of the requested amenities.") +
      (restricted ? " The search was limited to the parks from the previous answer." : ""),
    limitations: [
      ...PARK_LIMITATIONS,
      ...(conflicts.length ? [`Data disagreements to be aware of: ${conflicts.slice(0, 5).join("; ")}${conflicts.length > 5 ? "; …" : ""}.`] : []),
    ],
    sources: await sourcesFor(["parks", "parkAmenities"]),
    map,
  };
}

/** Park lookup by (approximate) name, for "tell me about X park". */
export async function getParkDetails(args: { parkName: string }): Promise<ToolSuccess> {
  const tool = "get_park_details";
  const parks = await loadParks();
  const q = norm(args.parkName).replace(/\bpark\b/g, "").trim();
  if (!q) throw new UserFacingError("PARK_NAME_REQUIRED", "Please tell me which park you mean.");
  const matches = parks.filter((p) => norm(p.name).includes(q));
  if (matches.length === 0) {
    throw new UserFacingError("PARK_NOT_FOUND", `I couldn't find a park named "${args.parkName.slice(0, 80)}" in the park data.`);
  }
  const points = await loadAmenityPoints(parks);
  const top = matches.slice(0, 5);
  const map = emptyMap();
  for (const p of top) {
    map.features.push(mapFeature(p.geometry, { kind: "park", id: `park-${p.id}`, label: p.name, details: parkPopup(p) }));
    for (const a of points.filter((x) => x.parkId === p.id)) {
      map.features.push(mapFeature(a.geometry, { kind: "amenity", id: `amenity-${a.id}`, label: a.amenity, details: [`Park: ${p.name}`] }));
    }
  }
  return {
    ok: true,
    tool,
    summary:
      matches.length === 1
        ? `Found ${matches[0].name}.`
        : `${matches.length} parks match "${args.parkName}": ${top.map((p) => p.name).join(", ")}.`,
    count: top.length,
    results: top.map((p) => ({
      ...parkSummary(p),
      description: p.description ?? null,
      mappedAmenityPoints: [...new Set(points.filter((x) => x.parkId === p.id).map((x) => x.amenity))],
    })),
    ...(matches.length > 1 ? { needsClarification: { reason: "Several parks match that name.", options: top.map((p) => p.name) } } : {}),
    method: "Park names were matched case-insensitively against the ParkName field.",
    limitations: PARK_LIMITATIONS.slice(0, 1),
    sources: await sourcesFor(["parks", "parkAmenities"]),
    map,
  };
}
