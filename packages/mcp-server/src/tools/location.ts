import { type GeocodedLocation, UserFacingError } from "./common.js";
import { geocode, isInFriscoCityLimits } from "./geocode.js";

export interface LocationInput {
  address?: string;
  latitude?: number;
  longitude?: number;
}

/** Resolve either an address or a coordinate pair into a GeocodedLocation. */
export async function resolveLocation(input: LocationInput): Promise<GeocodedLocation> {
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    return {
      input: `${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}`,
      matchedAddress: `Map point (${input.latitude.toFixed(5)}, ${input.longitude.toFixed(5)})`,
      lat: input.latitude,
      lon: input.longitude,
      source: "Coordinates supplied by user",
      inFriscoCityLimits: await isInFriscoCityLimits(input.longitude, input.latitude),
    };
  }
  if (input.address && input.address.trim()) return (await geocode(input.address)).best;
  throw new UserFacingError("LOCATION_REQUIRED", "Please give me an address in Frisco (or a point on the map) to search from.");
}
