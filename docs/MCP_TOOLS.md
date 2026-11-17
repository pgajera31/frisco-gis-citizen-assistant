# MCP Tool Catalog — `frisco-gis-mcp` v0.1.0

Transport: **stdio** (default; `node packages/mcp-server/dist/index.js`) or **Streamable HTTP** (`--http`, `POST http://127.0.0.1:8788/mcp`).
All tools are annotated `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
Inputs are validated by zod schemas before a handler runs; invalid input returns `isError: true`.

## Common output (`structuredContent`)

```ts
{
  ok: true,
  tool: string,
  summary: string,                 // one-sentence plain-language answer
  location?: { input, matchedAddress, lat, lon, source, inFriscoCityLimits },
  count: number,
  results: object[],               // tool-specific rows (below)
  needsClarification?: { reason: string, options: string[] },
  method: string,                  // how the answer was derived
  limitations: string[],
  sources: { layer, url, publisher, lastEdited?, retrievedAt, notes? }[],
  map: GeoJSON FeatureCollection   // properties: { kind, id, label, details[], styleValue? }
}
// failure:
{ ok: false, tool, error: { code, message }, suggestions?: string[] }
```

The `content[0].text` copy is the same JSON **without** map geometry (for model context efficiency).

Error codes: `ADDRESS_NOT_FOUND`, `LOCATION_REQUIRED`, `UNKNOWN_AMENITY`, `UNKNOWN_TRAIL_TYPE`, `FILTER_REQUIRED`, `STREET_NOT_FOUND`, `PARK_NOT_FOUND`, `TIMEOUT`, `NETWORK`, `HTTP_ERROR`, `ARCGIS_ERROR`, `BAD_RESPONSE`, `TOO_MANY_RESULTS`, `ENDPOINT_NOT_APPROVED`, `INTERNAL`.

## Location input (shared)
`address` (string, 3–200 chars) **or** `latitude` (32.9–33.4) + `longitude` (−97.1 to −96.5).

## Tools

| Tool | Use case | Inputs | Result rows |
|---|---|---|---|
| `geocode_address` | — | `address` | best match plus up to 3 alternatives: `matchedAddress, lat, lon, source, score, inFriscoCityLimits` |
| `find_nearest_parks` | UC1 | location, `limit` 1–10 (default 3), `amenities?` (≤5), `include_future_sites` (default false) | `parkId, name, address, amenities[], website, distanceToBoundaryMiles, distanceToCenterMiles, locationIsInsidePark, amenityEvidence?` |
| `find_parks_within_radius` | UC2 | location, `radius_miles` 0.1–10, `amenities?`, `include_future_sites` | as above, every park with any part within the radius |
| `search_parks_by_amenity` | UC3, UC4 | `amenities` (1–5, synonyms OK), `match` all/any, `restrict_to_park_ids?`, `restrict_to_park_names?` | `parkId, name, address, amenities[], website, amenityEvidence[{amenity, parkAttribute, amenityPoints}]` |
| `get_park_details` | — | `park_name` | park info plus mapped amenity points; clarification if several match |
| `lookup_zoning` | UC5 | location | `zoningDistrict, cityZoningCategory, plannedDevelopment, specificUsePermit, ordinances[], ordinanceLinks[], crossCheck, parcel{reference, landUseCode}, pendingZoningCases[]` |
| `find_nearby_trails` | UC6 | location, `radius_miles` 0.1–5 (default 1), `include_not_open`, `include_bike_only` | per trail name: `trailTypes[], surfaces[], statuses[], isWalkingLoop, hasBikeLane, segmentCount, mappedLengthMiles, distanceMiles` |
| `search_trails` | UC7 | `walking_loops_only`, `trail_type` (Regional, Parkway, Local, Nature, Bike Only), `bike_lanes_only`, `name_contains`, `include_not_open` | per trail name (as above, without distance) |
| `find_road_projects` | UC8 | `statuses` (default `["Construction"]`), `project_types` (default `["Road"]`) | `projectNumber, name, limits, type, subtype, description, status, bidDate, estimatedCompletion, estimatedCompletionPassed, estimatedCost, link` |
| `find_road_projects_near` | UC9 | location, `radius_miles` 0.1–5 (default 1), `statuses` (default Construction/Design/Planning), `project_types` | as above plus `distanceMiles` |
| `find_traffic_closures` | supporting | location?, `radius_miles` (default 2) | `description, timePeriod, owner, distanceMiles?` (Status = Active only) |
| `get_speed_limit` | UC10 | `street_name` (2–80), `near_address?` | `street, matchingStreetNames[], speedLimitsByMph[{mph, segmentCount, mappedLengthMiles, addressRange, owners[]}], segmentsWithoutSpeedLimit, atAddress?, schoolZones[], maintainedBy[]`. Asks for clarification when several limits apply. |
| `describe_data_sources` | transparency | `layer_key?` | approved layer registry, or live metadata for one layer |

## Adding a tool or dataset

1. Verify the layer with `npm run inventory` (add it to `CANDIDATES` in `scripts/gis-discovery.ts` first).
2. Add it to `LAYERS` in `packages/mcp-server/src/arcgis/layers.ts`. If the host is new, also add it to `APPROVED_SERVICE_PREFIXES` and to the environment's network allowlist.
3. Implement the tool in `src/tools/` returning `ToolSuccess` (always set `method`, `limitations`, `sources`, `map`).
4. Register it in `src/server.ts` with a zod input schema and `READ_ONLY` annotations.
5. Add mocked tests and a live test in `test/mcp.integration.test.ts`. The backend discovers the tool automatically through `tools/list`.
