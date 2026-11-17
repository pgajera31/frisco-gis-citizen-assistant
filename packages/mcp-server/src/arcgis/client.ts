import { config } from "../config.js";
import { APPROVED_SERVICE_PREFIXES, LAYERS, type LayerKey } from "./layers.js";

/** Error raised for any GIS failure. `code` is safe to show to users; `detail` is for logs only. */
export class GisError extends Error {
  constructor(
    public readonly code:
      | "ENDPOINT_NOT_APPROVED"
      | "TIMEOUT"
      | "NETWORK"
      | "HTTP_ERROR"
      | "ARCGIS_ERROR"
      | "BAD_RESPONSE"
      | "TOO_MANY_RESULTS",
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "GisError";
  }
}

export interface EsriGeometry {
  x?: number;
  y?: number;
  paths?: number[][][];
  rings?: number[][][];
}

export interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: EsriGeometry;
}

export interface QueryParams {
  where?: string;
  outFields?: string[] | "*";
  returnGeometry?: boolean;
  /** Point geometry in WGS84 for spatial filters. */
  point?: { lon: number; lat: number };
  /** Optional buffer distance around `point`, in statute miles. */
  distanceMiles?: number;
  spatialRel?: "esriSpatialRelIntersects" | "esriSpatialRelWithin" | "esriSpatialRelContains";
  orderByFields?: string;
  /** Safety cap on the number of features returned across pages. */
  maxFeatures?: number;
  /** Coordinate precision for returned geometry (6 decimals ~ 0.1 m). */
  geometryPrecision?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Test hook: replace the fetch implementation (used by mocked reliability tests). */
export function setFetchImplementation(f: FetchLike | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
  clearCache();
}

const cache = new Map<string, { expires: number; value: unknown }>();
export function clearCache(): void {
  cache.clear();
}

/** Throws unless the URL starts with one of the approved service prefixes. */
export function assertApprovedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GisError("ENDPOINT_NOT_APPROVED", "Invalid GIS URL.", url);
  }
  if (parsed.protocol !== "https:") {
    throw new GisError("ENDPOINT_NOT_APPROVED", "Only HTTPS GIS endpoints are allowed.", url);
  }
  // Compare case-insensitively on the path because ArcGIS paths are case-insensitive ("ArcGIS" vs "arcgis").
  const normalized = `${parsed.origin}${parsed.pathname}`.toLowerCase();
  const ok = APPROVED_SERVICE_PREFIXES.some((p) => normalized.startsWith(p.toLowerCase()));
  if (!ok) {
    throw new GisError("ENDPOINT_NOT_APPROVED", "This GIS endpoint is not on the approved list.", url);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a JSON document from an approved endpoint with timeout + retries.
 * Validates that the body is JSON and surfaces ArcGIS `{error: {...}}` objects,
 * which ArcGIS returns with HTTP 200.
 */
export async function getJson(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  assertApprovedUrl(url);
  const qs = new URLSearchParams(params).toString();
  // Long spatial queries are sent as POST form bodies to avoid URL-length limits.
  const usePost = qs.length > 1800;
  const fullUrl = usePost ? url : `${url}?${qs}`;

  let lastError: GisError | undefined;
  for (let attempt = 0; attempt <= config.arcgisRetries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.arcgisTimeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(fullUrl, {
        method: usePost ? "POST" : "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(usePost ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: usePost ? qs : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as Error)?.name === "AbortError";
      lastError = aborted
        ? new GisError("TIMEOUT", "The City GIS service took too long to respond.", url)
        : new GisError("NETWORK", "The City GIS service could not be reached.", `${url}: ${(err as Error)?.message}`);
      continue; // transient → retry
    }
    clearTimeout(timer);

    if (res.status >= 500 || res.status === 429) {
      lastError = new GisError("HTTP_ERROR", "The City GIS service is temporarily unavailable.", `${url}: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      throw new GisError("HTTP_ERROR", "The City GIS service rejected the request.", `${url}: HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new GisError("BAD_RESPONSE", "The City GIS service returned an unreadable response.", url);
    }
    if (!body || typeof body !== "object") {
      throw new GisError("BAD_RESPONSE", "The City GIS service returned an unexpected response.", url);
    }
    const errObj = (body as { error?: { code?: number; message?: string; details?: unknown } }).error;
    if (errObj) {
      // ArcGIS reports query errors inside an HTTP 200 body.
      const transient = errObj.code !== undefined && errObj.code >= 500;
      lastError = new GisError(
        "ARCGIS_ERROR",
        "The City GIS service reported an error for this query.",
        `${url}: ${errObj.code} ${errObj.message} ${JSON.stringify(errObj.details ?? "")}`,
      );
      if (transient) continue;
      throw lastError;
    }
    return body as Record<string, unknown>;
  }
  throw lastError ?? new GisError("NETWORK", "The City GIS service could not be reached.", url);
}

function buildQueryParams(q: QueryParams, offset: number, pageSize: number): Record<string, string> {
  const p: Record<string, string> = {
    f: "json",
    where: q.where ?? "1=1",
    outFields: q.outFields === "*" || !q.outFields ? "*" : q.outFields.join(","),
    returnGeometry: String(q.returnGeometry ?? true),
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
  };
  if (q.returnGeometry !== false) p.geometryPrecision = String(q.geometryPrecision ?? 6);
  if (q.point) {
    p.geometry = JSON.stringify({ x: q.point.lon, y: q.point.lat, spatialReference: { wkid: 4326 } });
    p.geometryType = "esriGeometryPoint";
    p.inSR = "4326";
    p.spatialRel = q.spatialRel ?? "esriSpatialRelIntersects";
    if (q.distanceMiles !== undefined) {
      p.distance = String(q.distanceMiles);
      p.units = "esriSRUnit_StatuteMile";
    }
  }
  if (q.orderByFields) p.orderByFields = q.orderByFields;
  return p;
}

/**
 * Query a registered layer, following `exceededTransferLimit` pagination until
 * all features are retrieved or `maxFeatures` is hit.
 */
export async function queryLayer(layer: LayerKey, q: QueryParams = {}): Promise<EsriFeature[]> {
  const def = LAYERS[layer];
  const maxFeatures = q.maxFeatures ?? 5000;
  const pageSize = 1000;
  const out: EsriFeature[] = [];
  let offset = 0;
  // Hard stop on page count protects against a service that never clears exceededTransferLimit.
  for (let page = 0; page < 25; page++) {
    const body = await getJson(`${def.url}/query`, buildQueryParams(q, offset, pageSize));
    const feats = body.features;
    if (!Array.isArray(feats)) {
      throw new GisError("BAD_RESPONSE", "The City GIS service returned no feature list.", `${def.url}: ${Object.keys(body)}`);
    }
    for (const f of feats) {
      if (f && typeof f === "object" && "attributes" in f) out.push(f as EsriFeature);
    }
    if (out.length > maxFeatures) {
      throw new GisError("TOO_MANY_RESULTS", "That search matched too many features; please narrow it.", def.url);
    }
    if (!body.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  return out;
}

/** Cached whole-layer (or filtered) fetch for small, frequently used layers. */
export async function queryLayerCached(layer: LayerKey, q: QueryParams = {}): Promise<EsriFeature[]> {
  const key = `${layer}|${JSON.stringify(q)}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as EsriFeature[];
  const value = await queryLayer(layer, q);
  if (config.cacheTtlSeconds > 0) cache.set(key, { value, expires: Date.now() + config.cacheTtlSeconds * 1000 });
  return value;
}

export interface LayerMetadata {
  name: string;
  geometryType?: string;
  lastEditDate?: string;
  maxRecordCount?: number;
  capabilities?: string;
  fields: { name: string; type: string; alias?: string }[];
}

/** Layer metadata (fields, capabilities, last-edit timestamp when published). Cached. */
export async function getLayerMetadata(layer: LayerKey): Promise<LayerMetadata> {
  const key = `meta|${layer}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as LayerMetadata;
  const body = await getJson(LAYERS[layer].url, { f: "json" });
  const ei = (body.editingInfo ?? {}) as { lastEditDate?: number; dataLastEditDate?: number };
  const ts = ei.dataLastEditDate ?? ei.lastEditDate;
  const value: LayerMetadata = {
    name: String(body.name ?? layer),
    geometryType: body.geometryType as string | undefined,
    lastEditDate: typeof ts === "number" ? new Date(ts).toISOString() : undefined,
    maxRecordCount: body.maxRecordCount as number | undefined,
    capabilities: body.capabilities as string | undefined,
    fields: ((body.fields as { name: string; type: string; alias?: string }[]) ?? []).map((f) => ({
      name: f.name,
      type: String(f.type).replace("esriFieldType", ""),
      alias: f.alias,
    })),
  };
  cache.set(key, { value, expires: Date.now() + Math.max(config.cacheTtlSeconds, 60) * 1000 });
  return value;
}

/** Escape a value for use inside a single-quoted ArcGIS SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Restrict free text used in SQL LIKE / equality clauses to a conservative
 * character set (letters, digits, space, period, hyphen, apostrophe, ampersand, slash).
 */
export function sanitizeSqlText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 .\-'&/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
