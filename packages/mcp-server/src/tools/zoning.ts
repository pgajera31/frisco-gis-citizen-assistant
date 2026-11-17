import { queryLayer } from "../arcgis/client.js";
import { esriToGeoJSON } from "../geo/geometry.js";
import {
  emptyMap,
  geocoderSource,
  locationFeature,
  mapFeature,
  type SourceRef,
  sourcesFor,
  str,
  type ToolSuccess,
} from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

/**
 * Zoning categories exactly as labelled in the legend (renderer) of the City's
 * own "Zoning Layer" (External_Planning_and_Zoning/MapServer/32, field SYMBOL).
 * These are the City's published category names, not our interpretation.
 */
export const CITY_ZONING_CATEGORIES: Record<string, string> = {
  "1": "Agricultural",
  "2": "Single Family",
  "3": "Multi Family",
  "4": "Office",
  "5": "Retail",
  "6": "Mixed Use",
  "7": "Original Town Residential",
  "8": "Information Technology",
  "9": "Original Town Commercial",
  "10": "Industrial",
  "11": "OTC*",
  "30": "College",
};

const ZONING_DISCLAIMER =
  "This is the zoning district shown in the City's GIS data. It is not a legal determination: permitted uses, setbacks and " +
  "other rules come from the City's Zoning Ordinance and any Planned Development (PD) or Specific Use Permit (SUP) ordinance, " +
  "and should be confirmed with the City of Frisco Planning Department.";

export async function lookupZoning(input: LocationInput): Promise<ToolSuccess> {
  const tool = "lookup_zoning";
  const location = await resolveLocation(input);
  const point = { lon: location.lon, lat: location.lat };

  // Query both zoning sources plus parcel and pending cases in parallel; tolerate partial failure.
  const [cityRes, odhRes, parcelRes, proposedRes] = await Promise.allSettled([
    queryLayer("zoningCity", { point, outFields: ["ZONE_", "PD", "SUP", "ORD1", "ORD2", "SYMBOL", "ORD1Hyperlink", "ORD2Hyperlink"], maxFeatures: 20 }),
    queryLayer("zoningOdh", { point, outFields: ["ZONING", "PD", "SUP", "ORD1", "ORD2"], maxFeatures: 20 }),
    queryLayer("parcels", { point, outFields: ["X_REF", "LANDUSE", "LIFECYCLES"], maxFeatures: 10 }),
    queryLayer("proposedZoning", { point, outFields: ["PROJECT_NO", "PROJECT_NA", "DESCRIPTIO", "Status", "Applied_Da", "Type", "Hyperlink"], maxFeatures: 10 }),
  ]);

  if (cityRes.status === "rejected" && odhRes.status === "rejected") throw cityRes.reason;

  const city = cityRes.status === "fulfilled" ? cityRes.value : [];
  const odh = odhRes.status === "fulfilled" ? odhRes.value : [];
  const parcels = parcelRes.status === "fulfilled" ? parcelRes.value : [];
  const proposed = proposedRes.status === "fulfilled" ? proposedRes.value : [];

  const primary = city[0] ?? odh[0];
  const map = emptyMap();
  map.features.push(locationFeature(location));
  const limitations: string[] = [ZONING_DISCLAIMER];
  const usedLayers: Parameters<typeof sourcesFor>[0] = [];

  if (!primary) {
    return {
      ok: true,
      tool,
      summary: `No zoning polygon contains ${location.matchedAddress}. It may be outside Frisco's zoning jurisdiction (for example in the ETJ or another city).`,
      location,
      count: 0,
      results: [],
      method: "Point-in-polygon test of the address location against the City's zoning polygons.",
      limitations: [...limitations, ...(location.inFriscoCityLimits === false ? ["The location appears to be outside Frisco city limits."] : [])],
      sources: [geocoderSource(location), ...(await sourcesFor(["zoningCity", "zoningOdh"]))],
      map,
    };
  }

  const a = primary.attributes;
  const zoneCode = str(a.ZONE_) ?? str(a.ZONING) ?? "Unknown";
  const category = str(a.SYMBOL) ? CITY_ZONING_CATEGORIES[String(a.SYMBOL)] : undefined;
  const pd = str(a.PD);
  const sup = str(a.SUP);
  const hasSup = Boolean(sup && !/^SUP0*$/i.test(sup));
  const ordinances = [str(a.ORD1), str(a.ORD2)].filter(Boolean) as string[];
  const ordinanceLinks = [str(a.ORD1Hyperlink), str(a.ORD2Hyperlink)].filter((u): u is string => Boolean(u && /^https:\/\/agenda\.friscotexas\.gov\//i.test(u)));

  if (city[0]) usedLayers.push("zoningCity");
  if (odh[0]) usedLayers.push("zoningOdh");

  // Cross-check the two zoning layers.
  const odhCode = odh[0] ? str(odh[0].attributes.ZONING) : undefined;
  const crossCheck =
    city[0] && odh[0]
      ? odhCode === zoneCode
        ? "The City-hosted zoning layer and the open-data zoning layer agree."
        : `The two zoning layers disagree (City layer: ${zoneCode}; open-data layer: ${odhCode}). Please confirm with the Planning Department.`
      : "Only one zoning layer could be checked.";
  if (city.length > 1 || odh.length > 1) {
    limitations.push("The location touches more than one zoning polygon (it may be on a zoning boundary).");
  }

  const zoningGeom = esriToGeoJSON(primary.geometry);
  if (zoningGeom) {
    map.features.push(
      mapFeature(zoningGeom, {
        kind: "zoning",
        id: "zoning-primary",
        label: `Zoning: ${zoneCode}${pd ? ` (${pd})` : ""}`,
        details: [category ? `Category: ${category}` : "", ordinances.length ? `Ordinances: ${ordinances.join(", ")}` : ""].filter(Boolean),
        styleValue: category ?? zoneCode,
      }),
    );
  }

  const parcel = parcels[0];
  if (parcel) {
    usedLayers.push("parcels");
    const pg = esriToGeoJSON(parcel.geometry);
    if (pg) {
      map.features.push(
        mapFeature(pg, {
          kind: "parcel",
          id: "parcel",
          label: "Parcel at this address",
          details: [str(parcel.attributes.LANDUSE) ? `Land-use code: ${str(parcel.attributes.LANDUSE)}` : ""].filter(Boolean),
        }),
      );
    }
  }

  const pending = proposed.map((f) => ({
    caseNumber: str(f.attributes.PROJECT_NO) ?? null,
    name: str(f.attributes.PROJECT_NA) ?? null,
    description: str(f.attributes.DESCRIPTIO) ?? null,
    status: str(f.attributes.Status) ?? null,
    applied: str(f.attributes.Applied_Da) ?? null,
    link: str(f.attributes.Hyperlink) ?? null,
  }));
  if (pending.length) {
    usedLayers.push("proposedZoning");
    for (const f of proposed) {
      const g = esriToGeoJSON(f.geometry);
      if (g) map.features.push(mapFeature(g, { kind: "proposed-zoning", id: `proposed-${str(f.attributes.PROJECT_NO)}`, label: `Pending zoning case ${str(f.attributes.PROJECT_NO) ?? ""}`, details: [str(f.attributes.DESCRIPTIO) ?? ""] }));
    }
  }

  const sources: SourceRef[] = [geocoderSource(location), ...(await sourcesFor(usedLayers))];
  const pdText = pd ? `, within Planned Development ${pd}` : "";
  return {
    ok: true,
    tool,
    summary:
      `${location.matchedAddress} is in zoning district ${zoneCode}` +
      (category ? ` (City zoning category: ${category})` : "") +
      `${pdText}.` +
      (pending.length ? ` There ${pending.length === 1 ? "is 1 pending zoning case" : `are ${pending.length} pending zoning cases`} covering this location.` : ""),
    location,
    count: 1,
    results: [
      {
        zoningDistrict: zoneCode,
        cityZoningCategory: category ?? null,
        plannedDevelopment: pd ?? null,
        specificUsePermit: hasSup ? sup : null,
        ordinances,
        ordinanceLinks,
        crossCheck,
        parcel: parcel
          ? { reference: str(parcel.attributes.X_REF) ?? null, landUseCode: str(parcel.attributes.LANDUSE) ?? null }
          : null,
        pendingZoningCases: pending,
      },
    ],
    method:
      "The address was converted to a map point, then a point-in-polygon query found the zoning polygon containing that point " +
      "in the City-hosted zoning layer; the open-data zoning layer was checked as well. The category name is the City's own map-legend label.",
    limitations,
    sources,
    map,
  };
}
