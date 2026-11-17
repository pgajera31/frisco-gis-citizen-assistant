import type { Feature, FeatureCollection, Geometry } from "geojson";
import { getLayerMetadata, GisError } from "../arcgis/client.js";
import { LAYERS, type LayerKey } from "../arcgis/layers.js";

/** A citation for one GIS layer used to produce an answer. */
export interface SourceRef {
  layer: string;
  url: string;
  publisher: string;
  /** ISO timestamp of the layer's last data edit, when the service publishes one. */
  lastEdited?: string;
  /** When this server retrieved the data. */
  retrievedAt: string;
  notes?: string;
}

/** Feature kinds understood by the web map for styling. */
export type MapKind =
  | "search-location"
  | "park"
  | "amenity"
  | "trail"
  | "zoning"
  | "parcel"
  | "proposed-zoning"
  | "road-project"
  | "traffic-closure"
  | "speed-segment"
  | "school-zone"
  | "search-area"
  | "school-district"
  | "future-land-use"
  | "school"
  | "facility";

export interface MapFeatureProps {
  kind: MapKind;
  id: string;
  label: string;
  /** Short HTML-free popup lines. */
  details?: string[];
  /** Optional numeric/class value for styling (e.g. MPH). */
  styleValue?: string | number;
}

export type MapFeatureCollection = FeatureCollection<Geometry, MapFeatureProps>;

export interface GeocodedLocation {
  input: string;
  matchedAddress: string;
  lon: number;
  lat: number;
  /** Which geocoder produced the match. */
  source: "City of Frisco Address Points" | "Esri World Geocoder" | "U.S. Census Geocoder" | "Coordinates supplied by user";
  score?: number;
  inFriscoCityLimits: boolean | null;
}

export interface ToolSuccess {
  ok: true;
  tool: string;
  summary: string;
  location?: GeocodedLocation;
  count: number;
  results: Record<string, unknown>[];
  /** Set when the assistant must ask the resident a clarifying question. */
  needsClarification?: { reason: string; options: string[] };
  /** Plain-language explanation of how the answer was derived. */
  method: string;
  limitations: string[];
  sources: SourceRef[];
  map: MapFeatureCollection;
  /** Optional rendered image; the MCP layer sends it as `image` content, not in structuredContent. */
  image?: { data: string; mimeType: string };
}

export interface ToolFailure {
  ok: false;
  tool: string;
  error: { code: string; message: string };
  suggestions?: string[];
}

export type ToolResult = ToolSuccess | ToolFailure;

export function mapFeature(geometry: Geometry, props: MapFeatureProps): Feature<Geometry, MapFeatureProps> {
  return { type: "Feature", geometry, properties: props };
}

export function emptyMap(): MapFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function locationFeature(loc: GeocodedLocation): Feature<Geometry, MapFeatureProps> {
  return mapFeature(
    { type: "Point", coordinates: [loc.lon, loc.lat] },
    {
      kind: "search-location",
      id: "search-location",
      label: loc.matchedAddress,
      details: [`Matched by: ${loc.source}`],
    },
  );
}

/** Build citations for the given layers, including last-edit dates when available. */
export async function sourcesFor(keys: LayerKey[]): Promise<SourceRef[]> {
  const retrievedAt = new Date().toISOString();
  const unique = [...new Set(keys)];
  return Promise.all(
    unique.map(async (k) => {
      const def = LAYERS[k];
      let lastEdited: string | undefined;
      if (def.reportsLastEdit) {
        try {
          lastEdited = (await getLayerMetadata(k)).lastEditDate;
        } catch {
          lastEdited = undefined; // metadata is best-effort; never fail an answer over it
        }
      }
      return { layer: def.title, url: def.url, publisher: def.publisher, lastEdited, retrievedAt, notes: def.notes };
    }),
  );
}

/** Citation for whichever geocoder resolved the location (with last-edit date for City address points). */
export async function geocoderSources(loc: GeocodedLocation): Promise<SourceRef[]> {
  if (loc.source === "City of Frisco Address Points") return sourcesFor(["addressPoints"]);
  return [geocoderSource(loc)];
}

export function geocoderSource(loc: GeocodedLocation): SourceRef {
  const retrievedAt = new Date().toISOString();
  switch (loc.source) {
    case "City of Frisco Address Points":
      return {
        layer: LAYERS.addressPoints.title,
        url: LAYERS.addressPoints.url,
        publisher: LAYERS.addressPoints.publisher,
        retrievedAt,
      };
    case "Coordinates supplied by user":
      return {
        layer: "Coordinates supplied by the user (no geocoding)",
        url: "",
        publisher: "User input",
        retrievedAt,
      };
    case "Esri World Geocoder":
      return {
        layer: "ArcGIS World Geocoding Service (fallback)",
        url: "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer",
        publisher: "Esri",
        retrievedAt,
        notes: "Used only because the address was not found in the City's address points.",
      };
    default:
      return {
        layer: "U.S. Census Bureau Geocoder (fallback)",
        url: "https://geocoding.geo.census.gov/geocoder/",
        publisher: "U.S. Census Bureau",
        retrievedAt,
        notes: "Address-range interpolation; position can be off by a few hundred feet.",
      };
  }
}

/** Convert any thrown error into a safe ToolFailure (no stack traces or internal URLs). */
export function toFailure(tool: string, err: unknown): ToolFailure {
  if (err instanceof GisError) {
    if (err.detail) console.error(`[${tool}] ${err.code}: ${err.detail}`);
    return { ok: false, tool, error: { code: err.code, message: err.message } };
  }
  if (err instanceof UserFacingError) {
    return { ok: false, tool, error: { code: err.code, message: err.message }, suggestions: err.suggestions };
  }
  console.error(`[${tool}] unexpected error`, err);
  return { ok: false, tool, error: { code: "INTERNAL", message: "Something went wrong while looking that up." } };
}

/** An expected, explainable failure (e.g. address not found). */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestions?: string[],
  ) {
    super(message);
  }
}

export function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}
