import { type EsriFeature, queryLayer, sanitizeSqlText, sqlString } from "../arcgis/client.js";
import type { LayerKey } from "../arcgis/layers.js";
import { parseStreetName } from "../geo/address.js";
import { distanceToGeometryMiles, esriToGeoJSON, lineLengthMiles, roundMiles } from "../geo/geometry.js";
import {
  emptyMap,
  geocoderSource,
  locationFeature,
  mapFeature,
  sourcesFor,
  str,
  type ToolSuccess,
  UserFacingError,
} from "./common.js";
import { resolveLocation } from "./location.js";

/** OWNER coded-value domain from the City speed-limit layer. */
const OWNER_NAMES: Record<string, string> = {
  CI: "City of Frisco", CO: "County", PR: "Private", OT: "Other", SH: "Shared", TX: "TxDOT", NT: "NTTA",
};

/** Field-name differences between the City layer and the open-data mirror. */
const FIELD_MAP: Record<"speedLimits" | "speedLimitsMirror", { lifecycle: string; fields: string[] }> = {
  speedLimits: {
    lifecycle: "LIFECYCLESTATUS",
    fields: ["OBJECTID", "FULL_NAME", "ROAD_NAME", "ROAD_SUF", "DIR", "ALIAS", "MPH", "L_ADD_F", "L_ADD_T", "R_ADD_F", "R_ADD_T", "OWNER", "LIFECYCLESTATUS"],
  },
  speedLimitsMirror: {
    lifecycle: "LIFECYCLES",
    fields: ["OBJECTID", "FULL_NAME", "ROAD_NAME", "ROAD_SUF", "DIR", "ALIAS", "MPH", "L_ADD_F", "L_ADD_T", "R_ADD_F", "R_ADD_T", "OWNER", "LIFECYCLES"],
  },
};

/** Common highway names → the ALIAS values used in the street data. */
function aliasCandidates(raw: string): string[] {
  const m = raw.toUpperCase().match(/\b(?:SH|STATE HIGHWAY|HIGHWAY|HWY|TX|FM|US)\s*-?\s*(\d{2,4})\b/);
  if (!m) return [];
  const n = m[1];
  return [`SH ${n}`, `FM ${n}`, `US ${n}`];
}

async function queryStreets(where: string): Promise<{ feats: EsriFeature[]; layer: LayerKey }> {
  try {
    const f = FIELD_MAP.speedLimits;
    return {
      feats: await queryLayer("speedLimits", { where: `(${where}) AND (${f.lifecycle} IS NULL OR ${f.lifecycle} <> 'PROP')`, outFields: f.fields, maxFeatures: 1500 }),
      layer: "speedLimits",
    };
  } catch (err) {
    console.error("[speed-limit] City layer failed, using open-data mirror", (err as Error).message);
    const f = FIELD_MAP.speedLimitsMirror;
    return {
      feats: await queryLayer("speedLimitsMirror", { where: `(${where}) AND (${f.lifecycle} IS NULL OR ${f.lifecycle} <> 'PROP')`, outFields: f.fields, maxFeatures: 1500 }),
      layer: "speedLimitsMirror",
    };
  }
}

function addressRange(feats: EsriFeature[]): string | null {
  const nums = feats
    .flatMap((f) => [f.attributes.L_ADD_F, f.attributes.L_ADD_T, f.attributes.R_ADD_F, f.attributes.R_ADD_T])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  return `${Math.min(...nums)}–${Math.max(...nums)}`;
}

/** Use case 10: posted speed limit(s) on a named street, optionally at a specific address. */
export async function getSpeedLimit(args: { streetName: string; nearAddress?: string }): Promise<ToolSuccess> {
  const tool = "get_speed_limit";
  const parsed = parseStreetName(args.streetName);
  if (!parsed) throw new UserFacingError("STREET_REQUIRED", "Please tell me which street you mean.");
  const name = sanitizeSqlText(parsed.name);
  const aliases = aliasCandidates(args.streetName);

  let where = `ROAD_NAME = ${sqlString(name)}` + (parsed.suffix ? ` AND ROAD_SUF = ${sqlString(parsed.suffix)}` : "");
  if (aliases.length) where = `(${where}) OR ALIAS IN (${aliases.map(sqlString).join(",")})`;
  let { feats, layer } = await queryStreets(where);

  // If the suffix guess was wrong ("Preston Street"), retry on the name alone.
  if (feats.length === 0 && parsed.suffix) ({ feats, layer } = await queryStreets(`ROAD_NAME = ${sqlString(name)}`));

  if (feats.length === 0) {
    const similar = await queryStreets(`FULL_NAME LIKE ${sqlString(`%${name}%`)}`);
    const options = [...new Set(similar.feats.map((f) => str(f.attributes.FULL_NAME)).filter(Boolean) as string[])].slice(0, 8);
    if (options.length === 0) {
      throw new UserFacingError("STREET_NOT_FOUND", `I couldn't find a street called "${args.streetName.slice(0, 80)}" in Frisco's street data.`);
    }
    return {
      ok: true,
      tool,
      summary: `There is no street named exactly "${args.streetName}". Did you mean one of: ${options.join(", ")}?`,
      count: 0,
      results: [],
      needsClarification: { reason: "No exact street-name match.", options },
      method: "Searched street centerlines by name.",
      limitations: [],
      sources: await sourcesFor([layer]),
      map: emptyMap(),
    };
  }

  // Several distinct streets can share a name (e.g. "MAIN ST" vs "MAIN ST" with directions); keep them together but report names.
  const streetNames = [...new Set(feats.map((f) => str(f.attributes.FULL_NAME)).filter(Boolean) as string[])];
  const withGeom = feats.map((f) => ({ f, g: esriToGeoJSON(f.geometry) })).filter((x) => x.g);
  const known = withGeom.filter((x) => Number(x.f.attributes.MPH) > 0);
  const unknown = withGeom.length - known.length;

  const byMph = new Map<number, typeof known>();
  for (const x of known) {
    const mph = Number(x.f.attributes.MPH);
    byMph.set(mph, [...(byMph.get(mph) ?? []), x]);
  }
  const groups = [...byMph.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([mph, xs]) => ({
      mph,
      segmentCount: xs.length,
      mappedLengthMiles: roundMiles(xs.reduce((t, x) => t + lineLengthMiles(x.g!), 0)),
      addressRange: addressRange(xs.map((x) => x.f)),
      owners: [...new Set(xs.map((x) => OWNER_NAMES[String(x.f.attributes.OWNER)] ?? String(x.f.attributes.OWNER ?? "Unknown")))],
    }));

  // School zones on this street (reduced limits at posted times).
  let schoolZones: { school: string; mph: number | null; times: string | null }[] = [];
  const schoolFeatures: ReturnType<typeof mapFeature>[] = [];
  try {
    const sz = await queryLayer("schoolZones", {
      where: parsed.suffix ? `LOCATION = ${sqlString(`${name} ${parsed.suffix}`)}` : `LOCATION LIKE ${sqlString(`${name} %`)}`,
      outFields: ["LOCATION", "SCHOOL", "TIMES_ACTIVE", "MPH_ACTIVE"],
      maxFeatures: 100,
    });
    schoolZones = sz.map((f) => ({
      school: str(f.attributes.SCHOOL) ?? "School zone",
      mph: Number(f.attributes.MPH_ACTIVE) || null,
      times: str(f.attributes.TIMES_ACTIVE) ?? null,
    }));
    for (const f of sz) {
      const g = esriToGeoJSON(f.geometry);
      if (g) schoolFeatures.push(mapFeature(g, { kind: "school-zone", id: `school-${f.attributes.OBJECTID ?? Math.random()}`, label: `School zone: ${str(f.attributes.SCHOOL) ?? ""}`, details: [`${f.attributes.MPH_ACTIVE ?? "?"} mph when active`, str(f.attributes.TIMES_ACTIVE) ?? ""].filter(Boolean) }));
    }
  } catch {
    schoolZones = [];
  }

  // Optional: pick the segment closest to a specific address.
  let atLocation: Record<string, unknown> | undefined;
  const location = args.nearAddress ? await resolveLocation({ address: args.nearAddress }) : undefined;
  if (location && known.length) {
    const nearest = known
      .map((x) => ({ x, d: distanceToGeometryMiles(location.lon, location.lat, x.g!) }))
      .sort((a, b) => a.d - b.d)[0];
    atLocation = {
      address: location.matchedAddress,
      mph: Number(nearest.x.f.attributes.MPH),
      distanceFromAddressToSegmentMiles: roundMiles(nearest.d),
      reliable: nearest.d <= 0.25,
    };
  }

  const map = emptyMap();
  if (location) map.features.push(locationFeature(location));
  for (const x of known) {
    const a = x.f.attributes;
    map.features.push(
      mapFeature(x.g!, {
        kind: "speed-segment",
        id: `seg-${a.OBJECTID}`,
        label: `${str(a.FULL_NAME) ?? name}: ${a.MPH} mph`,
        details: [addressRange([x.f]) ? `Addresses ${addressRange([x.f])}` : "", `Maintained by: ${OWNER_NAMES[String(a.OWNER)] ?? a.OWNER ?? "Unknown"}`].filter(Boolean),
        styleValue: Number(a.MPH),
      }),
    );
  }
  map.features.push(...schoolFeatures);

  const label = streetNames.length === 1 ? streetNames[0] : `${parsed.name}${parsed.suffix ? ` ${parsed.suffix}` : ""}`;
  const multiple = groups.length > 1;
  let summary: string;
  if (groups.length === 0) {
    summary = `The City's street data has ${label} but no speed limit recorded for it.`;
  } else if (atLocation && atLocation.reliable) {
    summary = `Near ${atLocation.address}, the posted speed limit on ${label} is ${atLocation.mph} mph according to the City's speed-limit data.`;
  } else if (!multiple) {
    summary = `The speed limit on ${label} is ${groups[0].mph} mph along all ${groups[0].segmentCount} mapped segments.`;
  } else {
    summary =
      `${label} has different speed limits on different segments: ` +
      groups.map((g) => `${g.mph} mph (${g.segmentCount} segment${g.segmentCount === 1 ? "" : "s"}${g.addressRange ? `, addresses ${g.addressRange}` : ""})`).join("; ") +
      ". Which part of the road do you mean?";
  }

  const maintained = [...new Set(groups.flatMap((g) => g.owners))];
  return {
    ok: true,
    tool,
    summary,
    ...(location ? { location } : {}),
    count: groups.length,
    results: [
      {
        street: label,
        matchingStreetNames: streetNames,
        speedLimitsByMph: groups,
        segmentsWithoutSpeedLimit: unknown,
        ...(atLocation ? { atAddress: atLocation } : {}),
        schoolZones,
        maintainedBy: maintained,
      },
    ],
    ...(multiple && !(atLocation && atLocation.reliable)
      ? {
          needsClarification: {
            reason: "This road has more than one posted speed limit.",
            options: groups.map((g) => `${g.mph} mph section${g.addressRange ? ` (addresses ${g.addressRange})` : ""}`),
          },
        }
      : {}),
    method:
      "Street centerline segments matching the street name were read from the City's speed-limit layer and grouped by their posted MPH value. " +
      (atLocation ? "For the given address, the segment nearest to the address point was used. " : "") +
      "Proposed (not yet built) streets are excluded.",
    limitations: [
      "Speed limits come from City GIS records; the posted sign on the road is the legal limit.",
      ...(maintained.some((o) => /TxDOT|NTTA/.test(o)) ? ["Part of this road is maintained by TxDOT/NTTA, which may set its speed limits."] : []),
      ...(schoolZones.length ? ["School zones have lower limits during posted times."] : []),
      ...(unknown ? [`${unknown} segment(s) have no speed limit recorded.`] : []),
    ],
    sources: [...(location ? [geocoderSource(location)] : []), ...(await sourcesFor([layer, ...(schoolZones.length ? (["schoolZones"] as const) : [])]))],
    map,
  };
}
