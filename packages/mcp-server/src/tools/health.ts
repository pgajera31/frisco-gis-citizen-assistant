/**
 * Proposal risk mitigation "Data changes or downtime → graceful fallbacks; status banner":
 * probe every approved layer and report which resident questions are affected.
 */
import { probeService } from "../arcgis/client.js";
import { LAYERS, type LayerKey } from "../arcgis/layers.js";
import { emptyMap, type ToolSuccess } from "./common.js";

/** What residents lose when a layer is down, and which layer (if any) backs it up. */
export const LAYER_IMPACT: Record<LayerKey, { affects: string; backup?: LayerKey }> = {
  addressPoints: { affects: "address lookups (other geocoders are used instead)" },
  parcels: { affects: "the parcel shown with zoning answers" },
  cityBoundary: { affects: "the 'inside city limits' check" },
  parks: { affects: "park searches" },
  parkAmenities: { affects: "park amenity locations" },
  zoningOdh: { affects: "zoning cross-checks", backup: "zoningCity" },
  proposedZoning: { affects: "pending zoning cases" },
  zoningCity: { affects: "zoning categories and ordinance links", backup: "zoningOdh" },
  trails: { affects: "trail and walking-loop searches" },
  activeCip: { affects: "road project searches", backup: "activeCipMirror" },
  activeCipMirror: { affects: "the backup road project layer" },
  trafficClosures: { affects: "traffic closure information" },
  speedLimits: { affects: "speed limit answers", backup: "speedLimitsMirror" },
  speedLimitsMirror: { affects: "the backup street layer" },
  schoolZones: { affects: "school zone details in speed limit answers" },
  isdBoundaries: { affects: "school district answers" },
  futureLandUse: { affects: "future land use answers" },
  schools: { affects: "nearby school searches" },
  publicFacilities: { affects: "public facility searches" },
};

let cache: { at: number; result: ToolSuccess } | undefined;
const CACHE_MS = 120_000;

export function clearHealthCache(): void {
  cache = undefined;
}

export async function checkDataSourcesHealth(args: { fresh?: boolean } = {}): Promise<ToolSuccess> {
  if (!args.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const keys = Object.keys(LAYERS) as LayerKey[];
  const probes = await Promise.all(keys.map(async (k) => ({ key: k, ...(await probeService(LAYERS[k].url)) })));
  const up = new Set(probes.filter((p) => p.ok).map((p) => p.key));
  const rows = probes.map((p) => {
    const impact = LAYER_IMPACT[p.key];
    const coveredByBackup = !p.ok && impact.backup !== undefined && up.has(impact.backup);
    return {
      layerKey: p.key,
      layer: LAYERS[p.key].title,
      status: p.ok ? "ok" : coveredByBackup ? "down (backup in use)" : "down",
      responseMs: p.ms,
      ...(p.ok ? {} : { error: p.code, affects: impact.affects }),
    };
  });
  const down = rows.filter((r) => r.status === "down");
  const backedUp = rows.filter((r) => r.status === "down (backup in use)");
  const result: ToolSuccess = {
    ok: true,
    tool: "check_data_sources_health",
    summary:
      down.length === 0 && backedUp.length === 0
        ? `All ${rows.length} City data services are responding.`
        : `${down.length + backedUp.length} of ${rows.length} City data services are not responding` +
          (down.length ? `; affected: ${[...new Set(down.map((r) => r.affects))].join(", ")}` : "") +
          (backedUp.length ? `${down.length ? ";" : ""} backups are covering ${backedUp.length}` : "") +
          ".",
    count: rows.length,
    results: rows,
    method: "Each approved layer's metadata endpoint was requested once (8-second timeout, no retries). Results are cached for 2 minutes.",
    limitations: ["A responding service can still return outdated data; see each answer's last-updated dates."],
    sources: [],
    map: emptyMap(),
  };
  cache = { at: Date.now(), result };
  return result;
}
