/**
 * Use cases 11–14 (beyond the 10 required): school district, future land use,
 * nearby schools, and nearby public facilities.
 */
import { queryLayer, queryLayerCached } from "../arcgis/client.js";
import { distanceToGeometryMiles, esriToGeoJSON, roundMiles } from "../geo/geometry.js";
import {
  emptyMap,
  geocoderSources,
  locationFeature,
  mapFeature,
  sourcesFor,
  str,
  type ToolSuccess,
  UserFacingError,
} from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bIsd\b/, "ISD");

// ---------------------------------------------------------------- UC11: school district

export async function lookupSchoolDistrict(input: LocationInput): Promise<ToolSuccess> {
  const tool = "lookup_school_district";
  const location = await resolveLocation(input);
  const feats = await queryLayer("isdBoundaries", { point: { lon: location.lon, lat: location.lat }, outFields: ["NAME"], maxFeatures: 5 });
  const map = emptyMap();
  map.features.push(locationFeature(location));
  const names = [...new Set(feats.map((f) => str(f.attributes.NAME)).filter((n): n is string => Boolean(n)))].map((n) => `${titleCase(n)} ISD`);
  for (const f of feats) {
    const g = esriToGeoJSON(f.geometry);
    if (g) map.features.push(mapFeature(g, { kind: "school-district", id: `isd-${str(f.attributes.NAME)}`, label: `${titleCase(String(f.attributes.NAME))} ISD` }));
  }
  const summary =
    names.length === 0
      ? `${location.matchedAddress} is not inside any school district boundary in the City's data.`
      : names.length === 1
        ? `${location.matchedAddress} is in ${names[0]}.`
        : `${location.matchedAddress} sits on the boundary of ${names.join(" and ")}.`;
  return {
    ok: true,
    tool,
    summary,
    location,
    count: names.length,
    results: names.map((n) => ({ schoolDistrict: n })),
    method: "Point-in-polygon test of the address location against the City's Independent School District (ISD) boundary layer.",
    limitations: [
      "This identifies the school DISTRICT only. Which elementary, middle or high school serves an address (attendance zone) is set by the district and is not in City GIS data. Check the district's school-finder.",
      ...(names.length > 1 ? ["The location is on a district boundary; confirm with the school districts."] : []),
    ],
    sources: [...(await geocoderSources(location)), ...(await sourcesFor(["isdBoundaries"]))],
    map,
  };
}

// ---------------------------------------------------------------- UC12: future land use

export async function lookupFutureLandUse(input: LocationInput): Promise<ToolSuccess> {
  const tool = "lookup_future_land_use";
  const location = await resolveLocation(input);
  const feats = await queryLayer("futureLandUse", {
    point: { lon: location.lon, lat: location.lat },
    outFields: ["FLU_Desc", "district", "FLU_YR", "hyperlink", "acres"],
    maxFeatures: 5,
  });
  const map = emptyMap();
  map.features.push(locationFeature(location));
  const rows = feats.map((f) => ({
    futureLandUse: str(f.attributes.FLU_Desc) ?? "Not specified",
    planYear: Number(f.attributes.FLU_YR) || null,
    district: str(f.attributes.district) ?? null,
    areaAcres: typeof f.attributes.acres === "number" ? Math.round(f.attributes.acres * 10) / 10 : null,
    planDocument: (() => {
      const u = str(f.attributes.hyperlink);
      return u && /^https:\/\/(agenda|www)\.friscotexas\.gov\//i.test(u) ? u : null;
    })(),
  }));
  feats.forEach((f, i) => {
    const g = esriToGeoJSON(f.geometry);
    if (g) map.features.push(mapFeature(g, { kind: "future-land-use", id: `flu-${i}`, label: `Future land use: ${rows[i].futureLandUse}`, details: rows[i].planYear ? [`${rows[i].planYear} Comprehensive Plan`] : [] }));
  });
  const categories = [...new Set(rows.map((r) => r.futureLandUse))];
  return {
    ok: true,
    tool,
    summary:
      rows.length === 0
        ? `The 2025 Future Land Use Plan has no category for ${location.matchedAddress} (it may be outside the plan area).`
        : `The City's 2025 Future Land Use Plan designates ${location.matchedAddress} as "${categories.join('" / "')}".`,
    location,
    count: rows.length,
    results: rows,
    method:
      "Point-in-polygon test against the 2025 Comprehensive Plan future land use layer. The category is the plan's 2025 description (FLU_Desc). " +
      "The layer's FLU_CD code column still holds legacy 2015 codes that often disagree with the 2025 category, so it is not used.",
    limitations: [
      "Future land use is a long-range planning guide, not zoning. What is allowed on a property today is set by its zoning (ask for the zoning at the address).",
    ],
    sources: [...(await geocoderSources(location)), ...(await sourcesFor(["futureLandUse"]))],
    map,
  };
}

// ---------------------------------------------------------------- UC13: nearby schools

const SCHOOL_TYPES: Record<string, string> = { PUB: "Public", PRI: "Private", CHAR: "Charter" };
const DISTRICT_NAMES: Record<string, string> = { FISD: "Frisco ISD", PISD: "Plano ISD", LISD: "Lewisville ISD" };
export const SCHOOL_LEVELS = ["elementary", "middle", "high", "college"] as const;

/**
 * SUBTYPE codes have no published domain, but every record was checked (2026-11-17):
 * 2 = 54 elementary, 3 = 23 middle/intermediate, 4 = 17 high, 5 = 20 district support
 * facilities (admin, transportation, natatorium, stadium…), 7 = 4 colleges/universities,
 * 8/9 = mixed private/charter campuses whose level is read from the name.
 */
const SUBTYPE_LEVEL: Record<number, (typeof SCHOOL_LEVELS)[number]> = { 2: "elementary", 3: "middle", 4: "high", 7: "college" };
export const DISTRICT_FACILITY_SUBTYPE = 5;

export function schoolLevel(name: string, subtype?: number): string | null {
  if (subtype !== undefined && SUBTYPE_LEVEL[subtype]) return SUBTYPE_LEVEL[subtype];
  if (/elementary|primary/i.test(name)) return "elementary";
  if (/middle|intermediate|junior high/i.test(name)) return "middle";
  if (/\bhigh school\b|\bhigh\b|upper school|secondary/i.test(name)) return "high";
  if (/university|college/i.test(name)) return "college";
  return null;
}

export async function findNearbySchools(
  args: LocationInput & {
    radiusMiles?: number;
    schoolType?: "Public" | "Private" | "Charter";
    level?: (typeof SCHOOL_LEVELS)[number];
    includeProposed?: boolean;
    includeDistrictFacilities?: boolean;
  },
): Promise<ToolSuccess> {
  const tool = "find_nearby_schools";
  const location = await resolveLocation(args);
  const radius = args.radiusMiles ?? 2;
  const feats = await queryLayerCached("schools", { outFields: ["OBJECTID", "NAME", "ADDRESS", "TYPE", "DISTRICT", "LIFECYCLES", "SUBTYPE"], geometryPrecision: 6 });
  const rows = feats
    .map((f) => {
      const g = esriToGeoJSON(f.geometry);
      const a = f.attributes;
      const name = str(a.NAME) ?? "Unnamed school";
      return {
        g,
        id: Number(a.OBJECTID),
        name,
        address: str(a.ADDRESS) ?? null,
        type: SCHOOL_TYPES[String(a.TYPE ?? "").trim()] ?? null,
        district: DISTRICT_NAMES[String(a.DISTRICT ?? "").trim()] ?? (str(a.DISTRICT) ?? null),
        level: schoolLevel(name, Number(a.SUBTYPE)),
        districtFacility: Number(a.SUBTYPE) === DISTRICT_FACILITY_SUBTYPE,
        proposed: String(a.LIFECYCLES ?? "").trim() === "PROP",
        d: g ? distanceToGeometryMiles(location.lon, location.lat, g) : Infinity,
      };
    })
    .filter((r) => r.g && r.d <= radius)
    .filter((r) => (args.includeProposed ? true : !r.proposed))
    .filter((r) => (args.includeDistrictFacilities ? true : !r.districtFacility))
    .filter((r) => (args.schoolType ? r.type === args.schoolType : true))
    .filter((r) => (args.level ? r.level === args.level : true))
    .sort((a, b) => a.d - b.d)
    .slice(0, 25);

  const map = emptyMap();
  map.features.push(locationFeature(location));
  for (const r of rows) {
    map.features.push(
      mapFeature(r.g!, {
        kind: "school",
        id: `school-${r.id}`,
        label: r.name,
        details: [r.address ? `Address: ${r.address}` : "", [r.type, r.district].filter(Boolean).join(" · "), `${roundMiles(r.d)} mi away`, r.proposed ? "Proposed (not yet built)" : ""].filter(Boolean),
      }),
    );
  }
  const what = [args.level, args.schoolType?.toLowerCase(), "schools"].filter(Boolean).join(" ");
  return {
    ok: true,
    tool,
    summary:
      rows.length === 0
        ? `No ${what} are within ${radius} miles of ${location.matchedAddress} in the City's school data.`
        : `${rows.length} ${what} ${rows.length === 1 ? "is" : "are"} within ${radius} miles of ${location.matchedAddress}; the closest is ${rows[0].name} (${roundMiles(rows[0].d)} mi).`,
    location,
    count: rows.length,
    results: rows.map((r) => ({ name: r.name, address: r.address, type: r.type, district: r.district, level: r.level, proposed: r.proposed, distanceMiles: roundMiles(r.d) })),
    method:
      "Straight-line distance from the address to each school point in the City's school layer. Type comes from the TYPE code (PUB/PRI/CHAR). " +
      "Level comes from the layer's SUBTYPE code, which has no published meaning but was verified record by record (2 elementary, 3 middle, 4 high, 7 college; " +
      "5 = district support facilities such as administration and transportation, excluded unless requested); otherwise from the school's name.",
    limitations: [
      "Being near a school does not mean it is the assigned school; attendance zones are set by each district and are not in City GIS data.",
      "Proposed schools and district support facilities (offices, transportation, stadiums) are excluded unless requested.",
    ],
    sources: [...(await geocoderSources(location)), ...(await sourcesFor(["schools"]))],
    map,
  };
}

// ---------------------------------------------------------------- UC14: public facilities

export const FACILITY_CATEGORIES = ["fire station", "police", "library", "post office", "city hall", "recreation", "public works", "other"] as const;
export type FacilityCategory = (typeof FACILITY_CATEGORIES)[number];

/** Category from the facility name (the layer has no category field). */
export function facilityCategory(name: string): FacilityCategory {
  if (/fire station/i.test(name)) return "fire station";
  if (/police/i.test(name)) return "police";
  if (/library/i.test(name)) return "library";
  if (/post office/i.test(name)) return "post office";
  if (/municipal center|municipal court|city hall/i.test(name)) return "city hall";
  if (/administration/i.test(name)) return "other";
  if (/athletic center|recreation|grove at frisco commons|discovery center|heritage center/i.test(name)) return "recreation";
  if (/public works|environmental collection/i.test(name)) return "public works";
  return "other";
}

export async function findNearbyFacilities(args: LocationInput & { category?: FacilityCategory; limit?: number }): Promise<ToolSuccess> {
  const tool = "find_nearby_facilities";
  const location = await resolveLocation(args);
  const feats = await queryLayerCached("publicFacilities", { outFields: ["OBJECTID", "NAME", "ADDRESS", "OWNER"], geometryPrecision: 6 });
  const all = feats.map((f) => {
    const g = esriToGeoJSON(f.geometry);
    const name = str(f.attributes.NAME) ?? "Facility";
    return { g, id: Number(f.attributes.OBJECTID), name, address: str(f.attributes.ADDRESS) ?? null, category: facilityCategory(name), d: g ? distanceToGeometryMiles(location.lon, location.lat, g) : Infinity };
  });
  // Training buildings and fleet shops are not public-facing, so they are only shown in "other".
  const rows = all
    .filter((r) => r.g)
    .filter((r) => (args.category ? r.category === args.category : !/training|fleet maintenance/i.test(r.name)))
    .sort((a, b) => a.d - b.d)
    .slice(0, args.limit ?? 5);
  if (args.category && rows.length === 0) {
    throw new UserFacingError("NO_FACILITY", `The City's public facility data has no "${args.category}" locations.`);
  }
  const map = emptyMap();
  map.features.push(locationFeature(location));
  for (const r of rows) {
    map.features.push(mapFeature(r.g!, { kind: "facility", id: `facility-${r.id}`, label: r.name, details: [r.address ? `Address: ${r.address}` : "", `Type: ${r.category}`, `${roundMiles(r.d)} mi away`].filter(Boolean) }));
  }
  const what = args.category ?? "public facility";
  return {
    ok: true,
    tool,
    summary: `The closest ${what} to ${location.matchedAddress} is ${rows[0].name}${rows[0].address ? ` (${rows[0].address})` : ""}, ${roundMiles(rows[0].d)} miles away.`,
    location,
    count: rows.length,
    results: rows.map((r) => ({ name: r.name, address: r.address, category: r.category, distanceMiles: roundMiles(r.d) })),
    method:
      "Straight-line distance from the address to each point in the City's public facilities layer. The layer has no category field, so the category " +
      "is taken from the facility's name (e.g. names containing 'Fire Station').",
    limitations: [
      "Straight-line distance, not driving distance. For emergencies always call 911; the nearest station is not necessarily the one that responds.",
      "Opening hours and services are not in the GIS data.",
    ],
    sources: [...(await geocoderSources(location)), ...(await sourcesFor(["publicFacilities"]))],
    map,
  };
}
