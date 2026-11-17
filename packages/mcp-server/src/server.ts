import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LAYERS } from "./arcgis/layers.js";
import { geocoderSources, locationFeature, toFailure, type ToolResult, UserFacingError } from "./tools/common.js";
import { describeDataSources } from "./tools/catalog.js";
import { geocode } from "./tools/geocode.js";
import { AMENITY_LABELS, findParksNear, getParkDetails, searchParksByAmenity } from "./tools/parks.js";
import { CIP_STATUSES, CIP_TYPES, findRoadProjects, findTrafficClosures } from "./tools/roadProjects.js";
import { getSpeedLimit } from "./tools/speedLimits.js";
import { findTrailsNear, searchTrails, TRAIL_TYPES } from "./tools/trails.js";
import { lookupZoning } from "./tools/zoning.js";
import { CATALOG_ITEM_TYPES, searchGisCatalog } from "./tools/catalogSearch.js";
import { COUNTABLE_LAYERS, type CountableLayer, countFeaturesWithinRadius } from "./tools/countNear.js";
import { getMapImage, OVERLAY_LAYERS, type OverlayLayer } from "./tools/mapImage.js";
import {
  FACILITY_CATEGORIES,
  type FacilityCategory,
  findNearbyFacilities,
  findNearbySchools,
  lookupFutureLandUse,
  lookupSchoolDistrict,
  SCHOOL_LEVELS,
} from "./tools/places.js";

export const SERVER_NAME = "frisco-gis-mcp";
export const SERVER_VERSION = "0.1.0";

// ---- shared input fragments (validated by the MCP SDK before handlers run) ----
const address = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .describe("Street address or landmark in Frisco, TX, e.g. '6101 Frisco Square Blvd'.");
const latitude = z.number().min(32.9).max(33.4).describe("Latitude (WGS84). Must be in the Frisco area.");
const longitude = z.number().min(-97.1).max(-96.5).describe("Longitude (WGS84). Must be in the Frisco area.");
const amenityList = z
  .array(z.string().trim().min(2).max(40))
  .min(1)
  .max(5)
  .describe(`Park amenities. Valid values (synonyms like 'basketball courts' are accepted): ${AMENITY_LABELS.join(", ")}.`);

/** Loose output schema: every tool returns a ToolResult (see tools/common.ts). */
const outputSchema = z.looseObject({
  ok: z.boolean(),
  tool: z.string(),
  summary: z.string().optional(),
  count: z.number().optional(),
  results: z.array(z.record(z.string(), z.unknown())).optional(),
  method: z.string().optional(),
  limitations: z.array(z.string()).optional(),
  sources: z.array(z.record(z.string(), z.unknown())).optional(),
  map: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * Text content returned alongside structuredContent. Geometry is omitted (it
 * can be very large and is only useful to map renderers, which read structuredContent).
 */
function textFor(result: ToolResult): string {
  if (!result.ok) return JSON.stringify(result);
  const { map, image: _image, ...rest } = result;
  return JSON.stringify({ ...rest, mapFeatureCount: map.features.length });
}

function wrap<A>(tool: string, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A) => {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await fn(args);
    } catch (err) {
      result = toFailure(tool, err);
    }
    // Observability: one structured log line per invocation (stderr; stdout is the MCP channel).
    console.error(JSON.stringify({ evt: "tool", tool, ok: result.ok, ms: Date.now() - started, ...(result.ok ? { count: result.count } : { code: result.error.code }) }));
    // A rendered image travels as MCP image content (for clients that display it), never in structuredContent.
    const image = result.ok ? result.image : undefined;
    const structured = result.ok && result.image ? { ...result, image: undefined } : result;
    return {
      content: [
        { type: "text" as const, text: textFor(result) },
        ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
      ],
      structuredContent: JSON.parse(JSON.stringify(structured)) as Record<string, unknown>,
      isError: !result.ok,
    };
  };
}

/** Requires either an address or a full lat/lon pair. */
function needLocation(a: { address?: string; latitude?: number; longitude?: number }) {
  if (a.address || (a.latitude !== undefined && a.longitude !== undefined)) return;
  throw new UserFacingError("LOCATION_REQUIRED", "Please give an address in Frisco (or latitude and longitude) to search from.");
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only tools over the City of Frisco's public ArcGIS layers. Every tool result includes `summary`, `results`, " +
        "`method` (how it was derived), `limitations`, and `sources` (layer name, URL, last-edited time). Always cite sources, " +
        "never invent GIS facts, and ask a clarifying question when `needsClarification` is present.",
    },
  );

  server.registerTool(
    "geocode_address",
    {
      title: "Geocode a Frisco address",
      description:
        "Convert an address or landmark into coordinates. Tries the City of Frisco address points first, then Esri and U.S. Census geocoders limited to the Frisco area.",
      inputSchema: { address },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("geocode_address", async ({ address: a }: { address: string }) => {
      const { best, alternatives } = await geocode(a);
      return {
        ok: true,
        tool: "geocode_address",
        summary: `"${a}" matched ${best.matchedAddress} (${best.source}).${best.inFriscoCityLimits === false ? " This location is outside Frisco city limits." : ""}`,
        location: best,
        count: 1 + alternatives.length,
        results: [best, ...alternatives].map((c) => ({ ...c })),
        method: "Geocoder priority: City address points → Esri World Geocoder → U.S. Census geocoder.",
        limitations: [],
        sources: await geocoderSources(best),
        map: { type: "FeatureCollection", features: [locationFeature(best)] },
      };
    }),
  );

  server.registerTool(
    "find_nearest_parks",
    {
      title: "Find the nearest parks",
      description:
        "Find the park(s) closest to an address, ranked by straight-line distance to the park boundary. Optionally require amenities.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        limit: z.number().int().min(1).max(10).default(3).describe("How many parks to return (default 3)."),
        amenities: amenityList.optional(),
        include_future_sites: z.boolean().default(false).describe("Include parks the City lists as '(Future Site)' (not yet open)."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_nearest_parks", async (a: { address?: string; latitude?: number; longitude?: number; limit?: number; amenities?: string[]; include_future_sites?: boolean }) => {
      needLocation(a);
      return findParksNear({ ...a, includeFutureSites: a.include_future_sites }, "find_nearest_parks");
    }),
  );

  server.registerTool(
    "find_parks_within_radius",
    {
      title: "Find parks within a distance",
      description: "List parks with any part of their boundary within N miles (straight line) of an address. Optionally require amenities.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(10).describe("Search radius in miles (0.1–10)."),
        amenities: amenityList.optional(),
        include_future_sites: z.boolean().default(false).describe("Include parks the City lists as '(Future Site)' (not yet open)."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_parks_within_radius", async (a: { address?: string; latitude?: number; longitude?: number; radius_miles: number; amenities?: string[]; include_future_sites?: boolean }) => {
      needLocation(a);
      return findParksNear({ ...a, radiusMiles: a.radius_miles, includeFutureSites: a.include_future_sites }, "find_parks_within_radius");
    }),
  );

  server.registerTool(
    "search_parks_by_amenity",
    {
      title: "Search parks by amenity",
      description:
        "Find Frisco parks that have the given amenities (e.g. Basketball, Playground). For follow-up questions about earlier results " +
        "('which of those also have…'), pass the earlier parks' ids in restrict_to_park_ids and include ALL amenities that apply.",
      inputSchema: {
        amenities: amenityList,
        match: z.enum(["all", "any"]).default("all").describe("'all' = every amenity required; 'any' = at least one."),
        restrict_to_park_ids: z.array(z.number().int().positive()).max(100).optional().describe("Limit to these parkId values from a previous result."),
        restrict_to_park_names: z.array(z.string().max(80)).max(100).optional().describe("Limit to these park names from a previous result."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("search_parks_by_amenity", (a: { amenities: string[]; match?: "all" | "any"; restrict_to_park_ids?: number[]; restrict_to_park_names?: string[] }) =>
      searchParksByAmenity({ amenities: a.amenities, match: a.match, restrictToParkIds: a.restrict_to_park_ids, restrictToParkNames: a.restrict_to_park_names }),
    ),
  );

  server.registerTool(
    "get_park_details",
    {
      title: "Get park details",
      description: "Look up a park by name and return its address, description, amenities and mapped amenity points.",
      inputSchema: { park_name: z.string().trim().min(2).max(80) },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("get_park_details", (a: { park_name: string }) => getParkDetails({ parkName: a.park_name })),
  );

  server.registerTool(
    "lookup_zoning",
    {
      title: "Look up zoning at an address",
      description:
        "Return the zoning district (and Planned Development / ordinances, parcel, and pending zoning cases) for the location of an address. Does not interpret permitted uses.",
      inputSchema: { address: address.optional(), latitude: latitude.optional(), longitude: longitude.optional() },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("lookup_zoning", async (a: { address?: string; latitude?: number; longitude?: number }) => {
      needLocation(a);
      return lookupZoning(a);
    }),
  );

  server.registerTool(
    "find_nearby_trails",
    {
      title: "Find trails near an address",
      description: "List City hike & bike trails within a radius of an address, nearest first.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(5).default(1).describe("Search radius in miles (default 1)."),
        include_not_open: z.boolean().default(false).describe("Also include 'Future' and 'Under Construction' trails."),
        include_bike_only: z.boolean().default(false).describe("Also include on-street 'Bike Only' routes."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_nearby_trails", async (a: { address?: string; latitude?: number; longitude?: number; radius_miles?: number; include_not_open?: boolean; include_bike_only?: boolean }) => {
      needLocation(a);
      return findTrailsNear({ ...a, radiusMiles: a.radius_miles, includeNotOpen: a.include_not_open, includeBikeOnly: a.include_bike_only });
    }),
  );

  server.registerTool(
    "search_trails",
    {
      title: "Search trails by type",
      description:
        `Find trails citywide by classification: walking loops (City 'Walking Loop' attribute), trail type (${TRAIL_TYPES.join(", ")}), on-street bike lanes, or name.`,
      inputSchema: {
        walking_loops_only: z.boolean().default(false),
        trail_type: z.enum(TRAIL_TYPES).optional(),
        bike_lanes_only: z.boolean().default(false),
        name_contains: z.string().trim().min(2).max(60).optional(),
        include_not_open: z.boolean().default(false),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("search_trails", (a: { walking_loops_only?: boolean; trail_type?: string; bike_lanes_only?: boolean; name_contains?: string; include_not_open?: boolean }) =>
      searchTrails({
        walkingLoopsOnly: a.walking_loops_only,
        trailType: a.trail_type,
        bikeLanesOnly: a.bike_lanes_only,
        nameContains: a.name_contains,
        includeNotOpen: a.include_not_open,
      }),
    ),
  );

  server.registerTool(
    "find_road_projects",
    {
      title: "Find City road projects",
      description:
        "Citywide list of City of Frisco Capital Improvement Projects by status (default: Construction) and type (default: Road).",
      inputSchema: {
        statuses: z.array(z.enum(CIP_STATUSES)).min(1).max(5).default(["Construction"]),
        project_types: z.array(z.enum(CIP_TYPES)).min(1).max(3).default(["Road"]),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_road_projects", (a: { statuses?: (typeof CIP_STATUSES)[number][]; project_types?: (typeof CIP_TYPES)[number][] }) =>
      findRoadProjects({ statuses: a.statuses, projectTypes: a.project_types }),
    ),
  );

  server.registerTool(
    "find_road_projects_near",
    {
      title: "Find road projects near an address",
      description:
        "City Capital Improvement Projects whose project line is within a radius of an address. Defaults to Road projects in Construction, Design, or Planning so residents see upcoming work too; status is reported per project.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(5).default(1),
        statuses: z.array(z.enum(CIP_STATUSES)).min(1).max(5).default(["Construction", "Design", "Planning"]),
        project_types: z.array(z.enum(CIP_TYPES)).min(1).max(3).default(["Road"]),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap(
      "find_road_projects_near",
      async (a: { address?: string; latitude?: number; longitude?: number; radius_miles?: number; statuses?: (typeof CIP_STATUSES)[number][]; project_types?: (typeof CIP_TYPES)[number][] }) => {
        needLocation(a);
        return findRoadProjects({ ...a, radiusMiles: a.radius_miles, statuses: a.statuses, projectTypes: a.project_types });
      },
    ),
  );

  server.registerTool(
    "find_traffic_closures",
    {
      title: "Find active traffic closures",
      description: "Lane/road closures currently marked 'Active' (mostly NTTA tollway work). Supporting information only; not construction projects.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(10).default(2),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_traffic_closures", (a: { address?: string; latitude?: number; longitude?: number; radius_miles?: number }) =>
      findTrafficClosures({ ...a, radiusMiles: a.radius_miles }),
    ),
  );

  server.registerTool(
    "get_speed_limit",
    {
      title: "Get a street's speed limit",
      description:
        "Posted speed limit(s) for a street from City GIS data, grouped by segment. If the road has several limits and no address is given, the result asks for clarification.",
      inputSchema: {
        street_name: z.string().trim().min(2).max(80).describe("Street name, e.g. 'Preston Road' or 'SH 289'."),
        near_address: address.optional().describe("Optional address on/near the street to pick the right segment."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("get_speed_limit", (a: { street_name: string; near_address?: string }) => getSpeedLimit({ streetName: a.street_name, nearAddress: a.near_address })),
  );

  server.registerTool(
    "describe_data_sources",
    {
      title: "Describe GIS data sources",
      description: "List the approved GIS layers this assistant uses, or live metadata (fields, last edit) for one layer.",
      inputSchema: { layer_key: z.enum(Object.keys(LAYERS) as [string, ...string[]]).optional() },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("describe_data_sources", (a: { layer_key?: string }) => describeDataSources({ layerKey: a.layer_key })),
  );

  server.registerTool(
    "search_gis_catalog",
    {
      title: "Search the City's public GIS catalog",
      description:
        "Search the City of Frisco's PUBLIC ArcGIS Online items (maps, apps, dashboards, services) by keyword. Returns titles, types, descriptions and links. Use it when a resident asks what maps or datasets exist.",
      inputSchema: {
        query: z.string().trim().min(2).max(80).describe("Keywords, e.g. 'parks', 'construction', 'trash pickup'."),
        item_types: z.array(z.enum(CATALOG_ITEM_TYPES)).max(7).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("search_gis_catalog", (a: { query: string; item_types?: (typeof CATALOG_ITEM_TYPES)[number][]; limit?: number }) =>
      searchGisCatalog({ query: a.query, itemTypes: a.item_types, limit: a.limit }),
    ),
  );

  server.registerTool(
    "count_features_within_radius",
    {
      title: "Count features within a distance (buffer)",
      description:
        `Count how many features of one City layer are within N miles of an address (server-side buffer). Layers: ${Object.entries(COUNTABLE_LAYERS)
          .map(([k, v]) => `${k} = ${v.filterNote}`)
          .join("; ")}.`,
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        layer: z.enum(Object.keys(COUNTABLE_LAYERS) as [CountableLayer, ...CountableLayer[]]),
        radius_miles: z.number().min(0.1).max(5),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("count_features_within_radius", async (a: { address?: string; latitude?: number; longitude?: number; layer: CountableLayer; radius_miles: number }) => {
      needLocation(a);
      return countFeaturesWithinRadius({ ...a, radiusMiles: a.radius_miles });
    }),
  );

  const kinds = [
    "search-location", "park", "amenity", "trail", "zoning", "parcel", "proposed-zoning",
    "road-project", "traffic-closure", "speed-segment", "school-zone", "search-area",
    "school-district", "future-land-use", "school", "facility",
  ] as const;
  const highlightSchema = z.object({
    type: z.literal("FeatureCollection"),
    features: z
      .array(
        z.object({
          type: z.literal("Feature"),
          geometry: z.object({
            type: z.enum(["Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]),
            coordinates: z.array(z.any()),
          }),
          properties: z.looseObject({
            kind: z.enum(kinds),
            id: z.string().max(80),
            label: z.string().max(200),
            styleValue: z.union([z.string().max(40), z.number()]).optional(),
          }),
        }),
      )
      .max(600),
  });

  server.registerTool(
    "get_map_image",
    {
      title: "Render a static map image",
      description:
        "Render a PNG map (1000×700) with Esri's public print geoprocessing service: World Street Map basemap, optional live City layers, and optional highlighted result features (GeoJSON from other tools' `map`). Give an address (plus radius), a bbox, or features. Returns a temporary image URL; set include_image_data to also receive the PNG.",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(5).default(0.75).describe("Map extent around the location."),
        bbox: z
          .object({ xmin: z.number(), ymin: z.number(), xmax: z.number(), ymax: z.number() })
          .optional()
          .describe("Explicit WGS84 extent in the Frisco area."),
        overlay_layers: z.array(z.enum(OVERLAY_LAYERS)).max(4).optional().describe("City layers drawn live with their own symbols."),
        highlight: highlightSchema.optional().describe("Result features to draw (the `map` returned by other tools)."),
        include_image_data: z.boolean().default(false).describe("Also return the PNG as MCP image content."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap(
      "get_map_image",
      (a: {
        address?: string;
        latitude?: number;
        longitude?: number;
        radius_miles?: number;
        bbox?: { xmin: number; ymin: number; xmax: number; ymax: number };
        overlay_layers?: OverlayLayer[];
        highlight?: unknown;
        include_image_data?: boolean;
      }) =>
        getMapImage({
          address: a.address,
          latitude: a.latitude,
          longitude: a.longitude,
          radiusMiles: a.radius_miles,
          bbox: a.bbox,
          overlayLayers: a.overlay_layers,
          highlight: a.highlight as never,
          includeImageData: a.include_image_data,
        }),
    ),
  );

  server.registerTool(
    "lookup_school_district",
    {
      title: "Look up the school district for an address",
      description: "Which Independent School District (ISD) an address is in. District only: attendance zones (which campus) are not in City data.",
      inputSchema: { address: address.optional(), latitude: latitude.optional(), longitude: longitude.optional() },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("lookup_school_district", async (a: { address?: string; latitude?: number; longitude?: number }) => {
      needLocation(a);
      return lookupSchoolDistrict(a);
    }),
  );

  server.registerTool(
    "lookup_future_land_use",
    {
      title: "Look up the future land use plan for an address",
      description: "The 2025 Comprehensive Plan future land use category for an address (a long-range planning guide, not zoning).",
      inputSchema: { address: address.optional(), latitude: latitude.optional(), longitude: longitude.optional() },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("lookup_future_land_use", async (a: { address?: string; latitude?: number; longitude?: number }) => {
      needLocation(a);
      return lookupFutureLandUse(a);
    }),
  );

  server.registerTool(
    "find_nearby_schools",
    {
      title: "Find schools near an address",
      description: "Schools within a radius of an address, nearest first, with type (Public/Private/Charter), district and level (from the school name).",
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radius_miles: z.number().min(0.1).max(5).default(2),
        school_type: z.enum(["Public", "Private", "Charter"]).optional(),
        level: z.enum(SCHOOL_LEVELS).optional(),
        include_proposed: z.boolean().default(false),
        include_district_facilities: z.boolean().default(false).describe("Also include district offices, transportation, stadiums, etc."),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap(
      "find_nearby_schools",
      async (a: { address?: string; latitude?: number; longitude?: number; radius_miles?: number; school_type?: "Public" | "Private" | "Charter"; level?: (typeof SCHOOL_LEVELS)[number]; include_proposed?: boolean; include_district_facilities?: boolean }) => {
        needLocation(a);
        return findNearbySchools({
          ...a,
          radiusMiles: a.radius_miles,
          schoolType: a.school_type,
          level: a.level,
          includeProposed: a.include_proposed,
          includeDistrictFacilities: a.include_district_facilities,
        });
      },
    ),
  );

  server.registerTool(
    "find_nearby_facilities",
    {
      title: "Find the nearest public facilities",
      description: `Nearest City public facilities to an address, optionally of one category: ${FACILITY_CATEGORIES.join(", ")}.`,
      inputSchema: {
        address: address.optional(),
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        category: z.enum(FACILITY_CATEGORIES).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      },
      outputSchema,
      annotations: READ_ONLY,
    },
    wrap("find_nearby_facilities", async (a: { address?: string; latitude?: number; longitude?: number; category?: FacilityCategory; limit?: number }) => {
      needLocation(a);
      return findNearbyFacilities(a);
    }),
  );

  return server;
}
