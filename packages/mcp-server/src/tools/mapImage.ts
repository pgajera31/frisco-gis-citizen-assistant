import * as turf from "@turf/turf";
import type { Geometry, Position } from "geojson";
import { getBinary, getJson, GisError } from "../arcgis/client.js";
import { LAYERS } from "../arcgis/layers.js";
import { emptyMap, geocoderSources, type MapFeatureCollection, type MapKind, sourcesFor, type SourceRef, type ToolSuccess, UserFacingError } from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

const PRINT_TASK = "https://utility.arcgisonline.com/arcgis/rest/services/Utilities/PrintingTools/GPServer/Export%20Web%20Map%20Task/execute";
const BASEMAP = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer";

/** City layers that can be drawn live by the print service (their own symbology). */
export const OVERLAY_LAYERS = ["parks", "trails", "zoningOdh", "activeCip", "trafficClosures", "parcels", "parkAmenities", "schoolZones"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

/** Bounds within which every coordinate must fall (Frisco plus a margin). */
const AREA = { xmin: -97.1, ymin: 32.9, xmax: -96.5, ymax: 33.4 };
const FRISCO_EXTENT = { xmin: -96.92, ymin: 33.08, xmax: -96.72, ymax: 33.24 };
const MAX_HIGHLIGHT_FEATURES = 600;
const MAX_VERTICES = 60_000;
export const IMAGE_SIZE = { width: 1000, height: 700 };

type RGBA = [number, number, number, number];
const hex = (h: string, a = 255): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

/** Speed colours identical to the web map's ramp. */
function mphHex(mph: number): string {
  if (mph <= 20) return "#1a9850";
  if (mph <= 25) return "#66bd63";
  if (mph <= 30) return "#9acd32";
  if (mph <= 35) return "#c9b800";
  if (mph <= 40) return "#f2a900";
  if (mph <= 45) return "#f46d43";
  if (mph <= 50) return "#d73027";
  if (mph <= 55) return "#a50026";
  return "#5c0018";
}
const STATUS_HEX: Record<string, string> = { Construction: "#d9480f", Design: "#e8a400", Planning: "#5c7cfa", "On Hold": "#868e96", Completed: "#2b8a3e" };

/** Esri symbol for a highlighted feature, matching the web map's styling for each kind. */
export function esriSymbol(kind: MapKind, styleValue: unknown, geomType: "point" | "line" | "polygon"): Record<string, unknown> {
  const line = (color: RGBA, width: number, style = "esriSLSSolid") => ({ type: "esriSLS", style, color, width });
  const fill = (color: RGBA, outline: Record<string, unknown>) => ({ type: "esriSFS", style: "esriSFSSolid", color, outline });
  if (geomType === "point") {
    if (kind === "search-location") return { type: "esriSMS", style: "esriSMSCircle", color: hex("#c92a2a"), size: 12, outline: { color: [255, 255, 255, 255], width: 2 } };
    if (kind === "school") return { type: "esriSMS", style: "esriSMSSquare", color: hex("#5f3dc4"), size: 10, outline: { color: [255, 255, 255, 255], width: 1.5 } };
    if (kind === "facility") return { type: "esriSMS", style: "esriSMSDiamond", color: hex("#0b7285"), size: 11, outline: { color: [255, 255, 255, 255], width: 1.5 } };
    return { type: "esriSMS", style: "esriSMSCircle", color: hex("#e67700"), size: 8, outline: { color: [255, 255, 255, 255], width: 1 } };
  }
  switch (kind) {
    case "park":
      return fill(hex("#69db7c", 110), line(hex("#2b8a3e"), 2));
    case "zoning":
      return fill(hex("#74c0fc", 70), line(hex("#1c5fa8"), 3));
    case "parcel":
      return fill([0, 0, 0, 0], line(hex("#212529"), 1.5, "esriSLSDash"));
    case "proposed-zoning":
      return fill(hex("#ffa94d", 40), line(hex("#e8590c"), 2, "esriSLSDash"));
    case "traffic-closure":
      return fill(hex("#ff6b6b", 130), line(hex("#c92a2a"), 2));
    case "search-area":
      return fill(hex("#1565b0", 25), line(hex("#1565b0"), 2, "esriSLSDash"));
    case "trail":
      return line(hex(styleValue === "walking-loop" ? "#862e9c" : styleValue === "not-open" ? "#adb5bd" : "#0b7285"), 3);
    case "road-project":
      return line(hex(STATUS_HEX[String(styleValue)] ?? "#d9480f"), 5);
    case "speed-segment":
      return line(hex(mphHex(Number(styleValue) || 0)), 4);
    case "school-zone":
      return line(hex("#fab005", 160), 7);
    case "school-district":
      return fill(hex("#b197fc", 40), line(hex("#5f3dc4"), 3));
    case "future-land-use":
      return fill(hex("#ffd43b", 70), line(hex("#e67700"), 2));
    default:
      return geomType === "polygon" ? fill(hex("#495057", 60), line(hex("#495057"), 2)) : line(hex("#495057"), 2);
  }
}

function checkPosition(p: Position): void {
  const [x, y] = p;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < AREA.xmin || x > AREA.xmax || y < AREA.ymin || y > AREA.ymax) {
    throw new UserFacingError("OUT_OF_AREA", "Map features must be in the Frisco area.");
  }
}

/** Convert one GeoJSON geometry to Esri JSON (WGS84). Polygon rings are reversed: GeoJSON exteriors are CCW, Esri's are CW. */
export function geoJsonToEsri(g: Geometry): { type: "point" | "line" | "polygon"; geometry: Record<string, unknown>; vertices: number } {
  const sr = { spatialReference: { wkid: 4326 } };
  switch (g.type) {
    case "Point":
      checkPosition(g.coordinates);
      return { type: "point", geometry: { x: g.coordinates[0], y: g.coordinates[1], ...sr }, vertices: 1 };
    case "LineString":
    case "MultiLineString": {
      const paths = g.type === "LineString" ? [g.coordinates] : g.coordinates;
      paths.flat().forEach(checkPosition);
      return { type: "line", geometry: { paths, ...sr }, vertices: paths.flat().length };
    }
    case "Polygon":
    case "MultiPolygon": {
      const rings = (g.type === "Polygon" ? g.coordinates : g.coordinates.flat()).map((r) => [...r].reverse());
      rings.flat().forEach(checkPosition);
      return { type: "polygon", geometry: { rings, ...sr }, vertices: rings.flat().length };
    }
    default:
      throw new UserFacingError("UNSUPPORTED_GEOMETRY", "Only points, lines and polygons can be drawn.");
  }
}

/** Build feature-collection layers (one per geometry type) for the highlighted features. */
export function highlightLayers(fc: MapFeatureCollection): Record<string, unknown>[] {
  if (fc.features.length > MAX_HIGHLIGHT_FEATURES) {
    throw new UserFacingError("TOO_MANY_FEATURES", `At most ${MAX_HIGHLIGHT_FEATURES} features can be drawn on a map image.`);
  }
  const groups: Record<"point" | "line" | "polygon", Record<string, unknown>[]> = { point: [], line: [], polygon: [] };
  let vertices = 0;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const e = geoJsonToEsri(f.geometry);
    vertices += e.vertices;
    if (vertices > MAX_VERTICES) throw new UserFacingError("TOO_MANY_FEATURES", "These results are too detailed to render as a map image.");
    groups[e.type].push({ geometry: e.geometry, symbol: esriSymbol(f.properties.kind, f.properties.styleValue, e.type) });
  }
  const esriType = { point: "esriGeometryPoint", line: "esriGeometryPolyline", polygon: "esriGeometryPolygon" } as const;
  // Draw polygons first, then lines, then points (so markers stay on top).
  return (["polygon", "line", "point"] as const)
    .filter((t) => groups[t].length)
    .map((t) => ({
      id: `results-${t}`,
      opacity: 1,
      featureCollection: {
        layers: [{ layerDefinition: { name: `results-${t}`, geometryType: esriType[t], fields: [] }, featureSet: { geometryType: esriType[t], features: groups[t] } }],
      },
    }));
}

/** Caption drawn into every image so a saved copy still says what it is and where the data came from. */
export function captionLayer(e: { xmin: number; ymin: number; xmax: number; ymax: number }): Record<string, unknown> {
  const date = new Date().toISOString().slice(0, 10);
  return {
    id: "caption",
    opacity: 1,
    featureCollection: {
      layers: [
        {
          layerDefinition: { name: "caption", geometryType: "esriGeometryPoint", fields: [] },
          featureSet: {
            geometryType: "esriGeometryPoint",
            features: [
              {
                // The print service centres text on its anchor, so anchor at the top centre.
                geometry: { x: (e.xmin + e.xmax) / 2, y: e.ymax - (e.ymax - e.ymin) * 0.025, spatialReference: { wkid: 4326 } },
                symbol: {
                  type: "esriTS",
                  color: [8, 53, 94, 255],
                  haloColor: [255, 255, 255, 255],
                  haloSize: 2,
                  horizontalAlignment: "center",
                  verticalAlignment: "middle",
                  font: { family: "Arial", size: 10, weight: "bold" },
                  text: `Capstone prototype, not an official City map  |  Data: City of Frisco GIS  |  ${date}`,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function padExtent(e: { xmin: number; ymin: number; xmax: number; ymax: number }, frac = 0.08) {
  const dx = Math.max(e.xmax - e.xmin, 0.004) * frac;
  const dy = Math.max(e.ymax - e.ymin, 0.003) * frac;
  return { xmin: e.xmin - dx, ymin: e.ymin - dy, xmax: e.xmax + dx, ymax: e.ymax + dy };
}

/**
 * Proposal tools "Get Map Image" / "Execute GP Task": render a static PNG through Esri's public
 * Export Web Map geoprocessing service (basemap + optional live City layers + highlighted results).
 */
export async function getMapImage(
  args: Partial<LocationInput> & {
    radiusMiles?: number;
    bbox?: { xmin: number; ymin: number; xmax: number; ymax: number };
    overlayLayers?: OverlayLayer[];
    highlight?: MapFeatureCollection;
    includeImageData?: boolean;
  },
): Promise<ToolSuccess> {
  const tool = "get_map_image";
  const overlays = [...new Set(args.overlayLayers ?? [])];
  const highlight = args.highlight ?? emptyMap();
  if (!overlays.length && !highlight.features.length && !args.address && args.latitude === undefined) {
    throw new UserFacingError("NOTHING_TO_DRAW", "Choose a location, one or more City layers, or results to draw on the map.");
  }

  let location;
  let extent: { xmin: number; ymin: number; xmax: number; ymax: number };
  if (args.bbox) {
    const b = args.bbox;
    [[b.xmin, b.ymin], [b.xmax, b.ymax]].forEach(checkPosition);
    if (b.xmax <= b.xmin || b.ymax <= b.ymin) throw new UserFacingError("BAD_EXTENT", "The map extent is invalid.");
    extent = b;
  } else if (args.address || (args.latitude !== undefined && args.longitude !== undefined)) {
    location = await resolveLocation(args as LocationInput);
    const [xmin, ymin, xmax, ymax] = turf.bbox(turf.circle([location.lon, location.lat], args.radiusMiles ?? 0.75, { units: "miles", steps: 32 }));
    extent = { xmin, ymin, xmax, ymax };
  } else if (highlight.features.length) {
    const [xmin, ymin, xmax, ymax] = turf.bbox(highlight as never);
    extent = padExtent({ xmin, ymin, xmax, ymax });
  } else {
    extent = FRISCO_EXTENT;
  }

  const drawn: MapFeatureCollection = { type: "FeatureCollection", features: [...highlight.features] };
  if (location) {
    drawn.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [location.lon, location.lat] },
      properties: { kind: "search-location", id: "search-location", label: location.matchedAddress },
    });
  }

  const webMap = {
    mapOptions: { extent: { ...extent, spatialReference: { wkid: 4326 } } },
    operationalLayers: [
      { id: "basemap", url: BASEMAP, opacity: 1, visibility: true },
      ...overlays.map((k) => ({ id: k, title: LAYERS[k].title, url: LAYERS[k].url, opacity: 0.85, visibility: true })),
      ...highlightLayers(drawn),
      captionLayer(extent),
    ],
    exportOptions: { outputSize: [IMAGE_SIZE.width, IMAGE_SIZE.height], dpi: 96 },
  };

  const body = await getJson(PRINT_TASK, {
    f: "json",
    Web_Map_as_JSON: JSON.stringify(webMap),
    Format: "PNG32",
    Layout_Template: "MAP_ONLY",
  });
  const out = (body.results as { value?: { url?: string } }[] | undefined)?.[0]?.value?.url;
  if (!out) throw new GisError("BAD_RESPONSE", "The map service did not return an image.", JSON.stringify(body).slice(0, 300));

  let image: ToolSuccess["image"];
  if (args.includeImageData) {
    const { bytes, contentType } = await getBinary(out); // also re-checks the URL against the allowlist
    if (!/^image\/png/i.test(contentType)) throw new GisError("BAD_RESPONSE", "The map service returned something other than an image.", contentType);
    image = { data: bytes.toString("base64"), mimeType: "image/png" };
  }

  const printSource: SourceRef = {
    layer: "Esri Export Web Map Task (print service) with World Street Map basemap",
    url: "https://utility.arcgisonline.com/arcgis/rest/services/Utilities/PrintingTools/GPServer/Export%20Web%20Map%20Task",
    publisher: "Esri",
    retrievedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    tool,
    summary:
      `Rendered a ${IMAGE_SIZE.width}×${IMAGE_SIZE.height} map image` +
      (location ? ` around ${location.matchedAddress}` : "") +
      (overlays.length ? ` showing ${overlays.map((k) => LAYERS[k].title.split(" (")[0]).join(", ")}` : "") +
      (highlight.features.length ? ` with ${highlight.features.length} highlighted result feature${highlight.features.length === 1 ? "" : "s"}` : "") +
      ".",
    ...(location ? { location } : {}),
    count: 1,
    results: [
      {
        imageUrl: out,
        format: "PNG",
        width: IMAGE_SIZE.width,
        height: IMAGE_SIZE.height,
        extent,
        overlayLayers: overlays,
        highlightedFeatures: highlight.features.length,
      },
    ],
    method:
      "The map was rendered by Esri's public Export Web Map geoprocessing task: an Esri World Street Map basemap" +
      (overlays.length ? ", the selected City of Frisco layers drawn live from their services with the City's own symbols" : "") +
      (highlight.features.length || location ? ", and the result features drawn in the same colours as the web map" : "") +
      ".",
    limitations: ["The image link is temporary (Esri deletes print outputs after a short time). Download the image to keep it."],
    sources: [...(location ? await geocoderSources(location) : []), ...(overlays.length ? await sourcesFor(overlays) : []), printSource],
    map: emptyMap(),
    ...(image ? { image } : {}),
  };
}
