import * as turf from "@turf/turf";
import { countWithinRadius } from "../arcgis/client.js";
import { LAYERS } from "../arcgis/layers.js";
import { emptyMap, geocoderSources, locationFeature, mapFeature, sourcesFor, type ToolSuccess } from "./common.js";
import { type LocationInput, resolveLocation } from "./location.js";

/**
 * Layers that may be counted, each with a FIXED filter chosen so the count means
 * what a resident expects. Callers choose a key; they never supply SQL.
 */
export const COUNTABLE_LAYERS = {
  parks: { where: "ParkName NOT LIKE '%(Future Site)%' AND ParkName NOT LIKE 'Select a Park%'", noun: "parks", filterNote: "open parks (future sites excluded)" },
  parkAmenities: { where: "Amenity <> 'None'", noun: "park amenity locations", filterNote: "mapped park amenity points" },
  trails: { where: "LifeCycleS = 'Existing'", noun: "existing trail segments", filterNote: "trail segments with status Existing" },
  activeCip: { where: "Status IN ('Construction','Design','Planning')", noun: "City capital projects", filterNote: "CIP projects in Construction, Design or Planning" },
  trafficClosures: { where: "Status = 'Active'", noun: "active traffic closures", filterNote: "closures with Status = Active" },
  addressPoints: { where: "1=1", noun: "address points", filterNote: "all City address points" },
  parcels: { where: "1=1", noun: "parcels", filterNote: "all parcels" },
  schoolZones: { where: "1=1", noun: "school speed zones", filterNote: "all school speed zones" },
} as const;
export type CountableLayer = keyof typeof COUNTABLE_LAYERS;

/** Proposal tool "buffer/count": how many features of a layer lie within N miles of a location. */
export async function countFeaturesWithinRadius(args: LocationInput & { layer: CountableLayer; radiusMiles: number }): Promise<ToolSuccess> {
  const tool = "count_features_within_radius";
  const spec = COUNTABLE_LAYERS[args.layer];
  const location = await resolveLocation(args);
  const count = await countWithinRadius(args.layer, { lon: location.lon, lat: location.lat }, args.radiusMiles, spec.where);

  const circle = turf.circle([location.lon, location.lat], args.radiusMiles, { units: "miles", steps: 96 });
  const map = emptyMap();
  map.features.push(
    mapFeature(circle.geometry, {
      kind: "search-area",
      id: "search-area",
      label: `${args.radiusMiles}-mile search area`,
      details: [`${count} ${spec.noun}`],
    }),
    locationFeature(location),
  );
  const miles = `${args.radiusMiles} mile${args.radiusMiles === 1 ? "" : "s"}`;
  return {
    ok: true,
    tool,
    summary: `There ${count === 1 ? "is" : "are"} ${count.toLocaleString("en-US")} ${spec.noun} within ${miles} of ${location.matchedAddress}.`,
    location,
    count: 1,
    results: [{ layer: LAYERS[args.layer].title, layerKey: args.layer, radiusMiles: args.radiusMiles, count, counted: spec.filterNote }],
    method:
      `The City GIS service counted the features of "${LAYERS[args.layer].title}" (${spec.filterNote}) that touch a circle of ${miles} ` +
      "around the location (an ArcGIS server-side distance buffer). A feature counts if any part of it is inside the circle. " +
      "These buffer counts were cross-checked against the assistant's own geodesic distance calculations and matched exactly.",
    limitations: ["A count does not list the features; ask a follow-up question to see them on the map."],
    sources: [...(await geocoderSources(location)), ...(await sourcesFor([args.layer]))],
    map,
  };
}
