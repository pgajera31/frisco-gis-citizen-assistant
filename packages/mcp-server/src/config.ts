/**
 * Runtime configuration for the MCP server. Values come from environment
 * variables (see the repository's .env.example). Everything has a safe default.
 */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const config = {
  /** Per-request timeout for ArcGIS REST calls, in milliseconds. */
  arcgisTimeoutMs: intEnv("ARCGIS_TIMEOUT_MS", 20_000, 2_000, 120_000),
  /** How long whole-layer downloads (parks, trails, CIP) are cached, in seconds. */
  cacheTtlSeconds: intEnv("GIS_CACHE_TTL_SECONDS", 900, 0, 86_400),
  /** Number of retries for transient network/5xx failures. */
  arcgisRetries: intEnv("ARCGIS_RETRIES", 2, 0, 5),
  /** Whether the Esri World Geocoder may be used when the City's address points have no match. */
  enableEsriGeocoder: process.env.ENABLE_ESRI_GEOCODER !== "0",
  /** Whether the U.S. Census geocoder may be used as a last resort. */
  enableCensusGeocoder: process.env.ENABLE_CENSUS_GEOCODER !== "0",
};
