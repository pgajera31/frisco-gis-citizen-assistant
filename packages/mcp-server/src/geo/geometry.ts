import * as turf from "@turf/turf";
import type { Feature, Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import type { EsriGeometry } from "../arcgis/client.js";

export const METERS_PER_MILE = 1609.344;

/** Signed ring area (shoelace). Negative = clockwise in a y-up (lon/lat) frame. */
function ringSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function closeRing(ring: number[][]): Position[] {
  const r = ring.map((p) => [p[0], p[1]]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]]);
  return r;
}

/**
 * Convert an Esri JSON geometry (already in WGS84) to GeoJSON.
 * Polygons: Esri outer rings are clockwise and holes counter-clockwise; each hole
 * is assigned to the outer ring that contains it, producing a MultiPolygon when needed.
 */
export function esriToGeoJSON(g: EsriGeometry | undefined): Geometry | null {
  if (!g) return null;
  if (typeof g.x === "number" && typeof g.y === "number") {
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
    return { type: "Point", coordinates: [g.x, g.y] } satisfies Point;
  }
  if (Array.isArray(g.paths)) {
    const paths = g.paths.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => p.map((c) => [c[0], c[1]]));
    if (paths.length === 0) return null;
    if (paths.length === 1) return { type: "LineString", coordinates: paths[0] } satisfies LineString;
    return { type: "MultiLineString", coordinates: paths } satisfies MultiLineString;
  }
  if (Array.isArray(g.rings)) {
    const rings = g.rings.filter((r) => Array.isArray(r) && r.length >= 3).map(closeRing);
    if (rings.length === 0) return null;
    const outers: Position[][][] = [];
    const holes: Position[][] = [];
    for (const r of rings) {
      // Esri: clockwise (negative signed area) = exterior.
      if (ringSignedArea(r) <= 0) outers.push([r.slice().reverse()]); // GeoJSON exterior is CCW
      else holes.push(r.slice().reverse());
    }
    if (outers.length === 0) {
      // Malformed winding: treat every ring as an exterior rather than dropping data.
      for (const h of holes) outers.push([h.slice().reverse()]);
      holes.length = 0;
    }
    for (const h of holes) {
      const probe = turf.point(h[0]);
      const owner = outers.find((poly) => turf.booleanPointInPolygon(probe, turf.polygon([poly[0]])));
      (owner ?? outers[0]).push(h);
    }
    if (outers.length === 1) return { type: "Polygon", coordinates: outers[0] } satisfies Polygon;
    return { type: "MultiPolygon", coordinates: outers } satisfies MultiPolygon;
  }
  return null;
}

/**
 * Shortest straight-line (geodesic) distance in miles from a point to a geometry.
 * Returns 0 when the point lies inside a polygon.
 */
export function distanceToGeometryMiles(lon: number, lat: number, geom: Geometry): number {
  const pt = turf.point([lon, lat]);
  switch (geom.type) {
    case "Point":
      return turf.distance(pt, turf.point(geom.coordinates), { units: "miles" });
    case "LineString":
      return turf.pointToLineDistance(pt, turf.lineString(geom.coordinates), { units: "miles" });
    case "MultiLineString":
      return Math.min(
        ...geom.coordinates.map((c) => turf.pointToLineDistance(pt, turf.lineString(c), { units: "miles" })),
      );
    case "Polygon":
    case "MultiPolygon": {
      const feature = turf.feature(geom) as Feature<Polygon | MultiPolygon>;
      if (turf.booleanPointInPolygon(pt, feature)) return 0;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      let best = Infinity;
      for (const poly of polys) {
        for (const ring of poly) {
          if (ring.length < 2) continue;
          best = Math.min(best, turf.pointToLineDistance(pt, turf.lineString(ring), { units: "miles" }));
        }
      }
      return best;
    }
    default:
      return Infinity;
  }
}

/** Geodesic distance from a point to a geometry's centroid, in miles. */
export function distanceToCentroidMiles(lon: number, lat: number, geom: Geometry): number {
  const c = turf.centroid(turf.feature(geom));
  return turf.distance(turf.point([lon, lat]), c, { units: "miles" });
}

/** Representative point for labelling: centroid, or a point guaranteed on the feature for lines/polygons. */
export function labelPoint(geom: Geometry): [number, number] {
  if (geom.type === "Point") return [geom.coordinates[0], geom.coordinates[1]];
  const f = turf.feature(geom);
  const c = geom.type === "Polygon" || geom.type === "MultiPolygon" ? turf.pointOnFeature(f) : turf.centroid(f);
  return [c.geometry.coordinates[0], c.geometry.coordinates[1]];
}

/** Geodesic length of a line geometry in miles. */
export function lineLengthMiles(geom: Geometry): number {
  if (geom.type !== "LineString" && geom.type !== "MultiLineString") return 0;
  return turf.length(turf.feature(geom), { units: "miles" });
}

export function pointInGeometry(lon: number, lat: number, geom: Geometry): boolean {
  if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") return false;
  return turf.booleanPointInPolygon(turf.point([lon, lat]), turf.feature(geom) as Feature<Polygon | MultiPolygon>);
}

/** Rounds to 2 decimals for user-facing distances (≈ 50 ft). */
export function roundMiles(m: number): number {
  return Math.round(m * 100) / 100;
}
