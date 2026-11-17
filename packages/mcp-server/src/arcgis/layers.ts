/**
 * Registry of the ONLY GIS layers this MCP server is allowed to query.
 *
 * Every ArcGIS request made by the server is built from an entry in this file;
 * the HTTP client additionally refuses any URL whose origin + path prefix is not
 * listed in APPROVED_SERVICE_PREFIXES. Tools never accept URLs from callers.
 *
 * Each entry was verified with live REST queries during the GIS data discovery
 * phase (see docs/GIS_DATA_INVENTORY.md for evidence and limitations).
 */

const AGOL = "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services";
const CITY = "https://maps.friscotexas.gov/gis/rest/services/Public";

export interface LayerDef {
  key: string;
  /** Human-readable layer name used in source citations. */
  title: string;
  /** Full layer endpoint (…/FeatureServer/<id> or …/MapServer/<id>). */
  url: string;
  publisher: string;
  geometry: "point" | "polyline" | "polygon";
  /** Notes shown in citations / docs about how authoritative the layer is. */
  notes: string;
  /** Whether the service publishes an editingInfo.lastEditDate we can report. */
  reportsLastEdit: boolean;
}

export const LAYERS = {
  addressPoints: {
    key: "addressPoints",
    title: "City of Frisco Address Points (FriscoLandRec_ODH, layer 0)",
    url: `${AGOL}/FriscoLandRec_ODH/FeatureServer/0`,
    publisher: "City of Frisco GIS (ArcGIS Online open data)",
    geometry: "point",
    notes: "Authoritative City address points (~72,000). Used first for geocoding.",
    reportsLastEdit: true,
  },
  parcels: {
    key: "parcels",
    title: "City of Frisco Parcels (FriscoLandRec_ODH, layer 1)",
    url: `${AGOL}/FriscoLandRec_ODH/FeatureServer/1`,
    publisher: "City of Frisco GIS (ArcGIS Online open data)",
    geometry: "polygon",
    notes: "Parcel polygons with land-use code. Used to confirm the parcel an address sits on.",
    reportsLastEdit: true,
  },
  cityBoundary: {
    key: "cityBoundary",
    title: "City of Frisco Boundary (City_of_Frisco_Boundary, layer 0)",
    url: `${AGOL}/City_of_Frisco_Boundary/FeatureServer/0`,
    publisher: "City of Frisco GIS (ArcGIS Online open data)",
    geometry: "polygon",
    notes: "Used only to tell residents whether a location is inside Frisco city limits.",
    reportsLastEdit: true,
  },
  parks: {
    key: "parks",
    title: "Frisco Parks with Amenities (ParkApp_Testing, layer 0)",
    url: `${AGOL}/ParkApp_Testing/FeatureServer/0`,
    publisher: "City of Frisco Parks & Recreation / GIS (sponsor-provided)",
    geometry: "polygon",
    notes:
      "Sponsor-provided park polygons with per-amenity fields. Named 'Testing', but it is the layer the City's public " +
      "'Parks, Trails, and Facilities' web app uses. 82 parks.",
    reportsLastEdit: true,
  },
  parkAmenities: {
    key: "parkAmenities",
    title: "Frisco Park Amenity Locations (ParkAmenities_Test, layer 0)",
    url: `${AGOL}/ParkAmenities_Test/FeatureServer/0`,
    publisher: "City of Frisco Parks & Recreation / GIS (sponsor-provided)",
    geometry: "point",
    notes: "Amenity points (Park, Amenity). Joined to park polygons spatially, not only by name.",
    reportsLastEdit: true,
  },
  zoningOdh: {
    key: "zoningOdh",
    title: "Frisco Zoning (FriscoZoning_ODH, layer 1)",
    url: `${AGOL}/FriscoZoning_ODH/FeatureServer/1`,
    publisher: "City of Frisco Planning / GIS (ArcGIS Online open data)",
    geometry: "polygon",
    notes: "Zoning polygons: ZONING, PD, SUP, ORD1, ORD2.",
    reportsLastEdit: true,
  },
  proposedZoning: {
    key: "proposedZoning",
    title: "Frisco Proposed Zoning Cases (FriscoZoning_ODH, layer 0)",
    url: `${AGOL}/FriscoZoning_ODH/FeatureServer/0`,
    publisher: "City of Frisco Planning / GIS (ArcGIS Online open data)",
    geometry: "polygon",
    notes: "Pending zoning applications. Reported as 'pending', never as current zoning.",
    reportsLastEdit: true,
  },
  zoningCity: {
    key: "zoningCity",
    title: "Zoning Layer (City of Frisco External_Planning_and_Zoning, layer 32)",
    url: `${CITY}/External_Planning_and_Zoning/MapServer/32`,
    publisher: "City of Frisco Planning / GIS (City ArcGIS Server)",
    geometry: "polygon",
    notes: "City-hosted zoning layer. Its SYMBOL field drives the official map legend category and it links ordinances.",
    reportsLastEdit: false,
  },
  trails: {
    key: "trails",
    title: "Frisco Hike & Bike Trails (FriscoPOI_ODH, layer 6)",
    url: `${AGOL}/FriscoPOI_ODH/FeatureServer/6`,
    publisher: "City of Frisco Parks / GIS (ArcGIS Online open data)",
    geometry: "polyline",
    notes: "Trail centerlines with TrailType, WalkingLoo (walking loop Yes/No), Surface, LifeCycleS.",
    reportsLastEdit: true,
  },
  activeCip: {
    key: "activeCip",
    title: "Active Capital Improvement Projects (City of Frisco FriscoData, layer 6)",
    url: `${CITY}/FriscoData/MapServer/6`,
    publisher: "City of Frisco Engineering (City ArcGIS Server)",
    geometry: "polyline",
    notes:
      "Citywide CIP project lines with Status (Planning, Design, Construction, On Hold, Completed) and Type (Road, Utility, Parks). " +
      "This is the layer behind the City's public 'Active CIP Map'.",
    reportsLastEdit: false,
  },
  activeCipMirror: {
    key: "activeCipMirror",
    title: "Active CIP (City of Frisco External_Engineering, layer 28)",
    url: `${CITY}/External_Engineering/MapServer/28`,
    publisher: "City of Frisco Engineering (City ArcGIS Server)",
    geometry: "polyline",
    notes: "Same schema as FriscoData/6 without completed projects. Used as a fallback.",
    reportsLastEdit: false,
  },
  trafficClosures: {
    key: "trafficClosures",
    title: "Traffic Closures (TrafficClosures, layer 0)",
    url: `${AGOL}/TrafficClosures/FeatureServer/0`,
    publisher: "City of Frisco Traffic (ArcGIS Online)",
    geometry: "polygon",
    notes: "Lane-closure polygons, mostly NTTA tollway work. A closure is NOT the same as a construction project.",
    reportsLastEdit: true,
  },
  speedLimits: {
    key: "speedLimits",
    title: "Speed Limits (City of Frisco External_Engineering, layer 6)",
    url: `${CITY}/External_Engineering/MapServer/6`,
    publisher: "City of Frisco Engineering / Traffic (City ArcGIS Server)",
    geometry: "polyline",
    notes: "Street centerline segments with posted MPH. Different segments of one road can differ.",
    reportsLastEdit: false,
  },
  speedLimitsMirror: {
    key: "speedLimitsMirror",
    title: "Streets (FriscoTrans_ODH, layer 0)",
    url: `${AGOL}/FriscoTrans_ODH/FeatureServer/0`,
    publisher: "City of Frisco GIS (ArcGIS Online open data)",
    geometry: "polyline",
    notes: "Open-data street centerlines with an MPH field. Used if the City speed-limit layer is unreachable.",
    reportsLastEdit: true,
  },
  schoolZones: {
    key: "schoolZones",
    title: "School Speed Zones (City of Frisco External_Engineering, layer 5)",
    url: `${CITY}/External_Engineering/MapServer/5`,
    publisher: "City of Frisco Engineering / Traffic (City ArcGIS Server)",
    geometry: "polyline",
    notes: "Reduced school-zone limits with active times.",
    reportsLastEdit: false,
  },
} as const satisfies Record<string, LayerDef>;

export type LayerKey = keyof typeof LAYERS;

/** Origins + path prefixes the HTTP client is allowed to contact. */
export const APPROVED_SERVICE_PREFIXES: readonly string[] = [
  `${AGOL}/`,
  `${CITY}/`,
  "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/",
  "https://geocoding.geo.census.gov/geocoder/",
  // ArcGIS Online item search (queries are always restricted to owner:FriscoTexas, public items).
  "https://www.arcgis.com/sharing/rest/search",
  // Esri's public printing service (Export Web Map GP task) and its output directory, for static map images.
  "https://utility.arcgisonline.com/arcgis/rest/services/Utilities/PrintingTools/GPServer/",
  "https://utility.arcgisonline.com/arcgis/rest/directories/arcgisoutput/",
];

/** Human-facing link for a layer (the REST endpoint itself is browsable). */
export function layerLink(key: LayerKey): string {
  return LAYERS[key].url;
}
