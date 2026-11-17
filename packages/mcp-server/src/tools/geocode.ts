import { getJson, queryLayer, queryLayerCached, sanitizeSqlText, sqlString } from "../arcgis/client.js";
import { config } from "../config.js";
import { formatParsedAddress, parseAddress } from "../geo/address.js";
import { esriToGeoJSON, pointInGeometry } from "../geo/geometry.js";
import { type GeocodedLocation, UserFacingError } from "./common.js";

/** Rough bounding box around Frisco and its ETJ used to reject far-away fallback matches. */
const FRISCO_BBOX = { xmin: -96.95, ymin: 33.05, xmax: -96.68, ymax: 33.27 };

function inBbox(lon: number, lat: number): boolean {
  return lon >= FRISCO_BBOX.xmin && lon <= FRISCO_BBOX.xmax && lat >= FRISCO_BBOX.ymin && lat <= FRISCO_BBOX.ymax;
}

/** True/false when the city boundary layer answers, null if it could not be checked. */
export async function isInFriscoCityLimits(lon: number, lat: number): Promise<boolean | null> {
  try {
    const polys = await queryLayerCached("cityBoundary", { returnGeometry: true, outFields: ["OBJECTID"], geometryPrecision: 6 });
    for (const f of polys) {
      const g = esriToGeoJSON(f.geometry);
      if (g && pointInGeometry(lon, lat, g)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/** Look the address up in the City's authoritative address-point layer. */
async function cityAddressLookup(input: string): Promise<GeocodedLocation[]> {
  const parsed = parseAddress(input);
  if (!parsed || parsed.number === undefined) return [];
  const name = sanitizeSqlText(parsed.name);
  if (!name) return [];
  const where = `STR_NUMBER = ${parsed.number} AND STR_NAME LIKE ${sqlString(`${name}%`)}`;
  const feats = await queryLayer("addressPoints", {
    where,
    outFields: ["FULL_ADDRE", "STR_NAME", "STR_SUFFIX", "STR_DIRECT", "STR_SUB_NU"],
    maxFeatures: 200,
  });
  const scored = feats
    .filter((f) => f.geometry && typeof f.geometry.x === "number")
    .map((f) => {
      const a = f.attributes;
      let score = 80;
      if (String(a.STR_NAME ?? "").trim() === parsed.name) score += 10;
      if (parsed.suffix && String(a.STR_SUFFIX ?? "").trim() === parsed.suffix) score += 8;
      if (parsed.suffix && a.STR_SUFFIX && String(a.STR_SUFFIX).trim() !== parsed.suffix) score -= 30;
      if (parsed.direction && String(a.STR_DIRECT ?? "").trim() === parsed.direction) score += 2;
      return {
        input,
        matchedAddress: `${String(a.FULL_ADDRE ?? formatParsedAddress(parsed)).trim()}, Frisco, TX`,
        lon: f.geometry!.x!,
        lat: f.geometry!.y!,
        source: "City of Frisco Address Points" as const,
        score,
        inFriscoCityLimits: true,
      };
    })
    .filter((c) => c.score >= 60)
    .sort((a, b) => b.score - a.score);
  // De-duplicate identical addresses (sub-units share coordinates closely).
  const seen = new Set<string>();
  return scored.filter((c) => (seen.has(c.matchedAddress) ? false : (seen.add(c.matchedAddress), true)));
}

async function esriWorldLookup(input: string): Promise<GeocodedLocation[]> {
  const single = /frisco/i.test(input) ? input : `${input}, Frisco, TX`;
  const body = await getJson("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates", {
    f: "json",
    SingleLine: single.slice(0, 200),
    maxLocations: "5",
    outFields: "Match_addr,Addr_type",
    location: "-96.8236,33.1507",
    searchExtent: JSON.stringify({ ...FRISCO_BBOX, spatialReference: { wkid: 4326 } }),
    forStorage: "false",
  });
  const cands = (body.candidates as { address: string; score: number; location: { x: number; y: number } }[]) ?? [];
  return cands
    .filter((c) => c.score >= 85 && inBbox(c.location.x, c.location.y))
    .map((c) => ({
      input,
      matchedAddress: c.address,
      lon: c.location.x,
      lat: c.location.y,
      source: "Esri World Geocoder" as const,
      score: c.score,
      inFriscoCityLimits: null,
    }));
}

async function censusLookup(input: string): Promise<GeocodedLocation[]> {
  const single = /frisco/i.test(input) ? input : `${input}, Frisco, TX`;
  const body = await getJson("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress", {
    address: single.slice(0, 200),
    benchmark: "Public_AR_Current",
    format: "json",
  });
  const matches =
    ((body.result as { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] })
      ?.addressMatches ?? []);
  return matches
    .filter((m) => inBbox(m.coordinates.x, m.coordinates.y))
    .map((m) => ({
      input,
      matchedAddress: m.matchedAddress,
      lon: m.coordinates.x,
      lat: m.coordinates.y,
      source: "U.S. Census Geocoder" as const,
      inFriscoCityLimits: null,
    }));
}

/**
 * Resolve a free-text address to coordinates. Order:
 *  1. City of Frisco Address Points (authoritative, exact house-number match)
 *  2. Esri World Geocoder (handles landmarks/business names; restricted to the Frisco area)
 *  3. U.S. Census geocoder (address-range interpolation)
 * Throws a UserFacingError when nothing in or near Frisco matches.
 */
export async function geocode(input: string): Promise<{ best: GeocodedLocation; alternatives: GeocodedLocation[] }> {
  const trimmed = input.trim();
  let candidates = await cityAddressLookup(trimmed);
  if (candidates.length === 0 && config.enableEsriGeocoder) {
    try {
      candidates = await esriWorldLookup(trimmed);
    } catch (err) {
      console.error("[geocode] Esri fallback failed", (err as Error).message);
    }
  }
  if (candidates.length === 0 && config.enableCensusGeocoder) {
    try {
      candidates = await censusLookup(trimmed);
    } catch (err) {
      console.error("[geocode] Census fallback failed", (err as Error).message);
    }
  }
  if (candidates.length === 0) {
    throw new UserFacingError(
      "ADDRESS_NOT_FOUND",
      `I couldn't find "${trimmed.slice(0, 120)}" in or near Frisco. Please check the street number and name.`,
      ["Include the house number and street, e.g. '6101 Frisco Square Blvd'.", "Try a nearby intersection or landmark."],
    );
  }
  const best = candidates[0];
  if (best.inFriscoCityLimits === null) best.inFriscoCityLimits = await isInFriscoCityLimits(best.lon, best.lat);
  return { best, alternatives: candidates.slice(1, 4) };
}
