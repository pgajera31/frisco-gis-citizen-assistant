# Test Report

**Run date:** 2026-11-17 · **Environment:** Linux container, Node 22, Chromium (Playwright 1.63) · **GIS:** live City of Frisco services · **AI model:** *not available* (no Claude API key in the development environment; see "AI coverage" below).

Raw evidence (committed):
- `docs/test-results/vitest-mcp-server.{log,json}`, `vitest-backend.{log,json}`, `vitest-web.{log,json}` — verbose + JSON reports
- `docs/test-results/mcp-live-results.json` — observed live answers for every use case via MCP
- `docs/test-results/backend-live-results.json` — full HTTP → MCP → ArcGIS transcript (incl. AI-mode run with scripted model)
- `docs/test-results/e2e.log`, `e2e-results.json` — browser E2E results
- `docs/screenshots/*.png` — screenshots captured by the E2E run

## Summary

| Suite | Type | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| `packages/mcp-server/test/unit.address-geometry.test.ts` | Unit | 27 | 27 | 0 | 0 |
| `packages/mcp-server/test/mocked.reliability.test.ts` | Mocked (fake fetch) | 26 | 26 | 0 | 0 |
| `packages/mcp-server/test/mocked.catalog-count-image.test.ts` | Mocked (catalog search, buffer/count, map image) | 11 | 11 | 0 | 0 |
| `packages/mcp-server/test/mcp.integration.test.ts` — protocol | MCP integration (real server over stdio) | 8 | 8 | 0 | 0 |
| `packages/mcp-server/test/mcp.integration.test.ts` — live | **Live GIS** via MCP | 16 | 16 | 0 | 0 |
| `apps/backend/test/unit.planner.test.ts` | Unit | 51 | 51 | 0 | 0 |
| `apps/backend/test/mocked.claude-loop.test.ts` | Mocked (scripted model + fake MCP) | 11 | 11 | 0 | 0 |
| `apps/backend/test/mocked.api-security.test.ts` | Mocked (supertest + fake MCP) | 22 | 22 | 0 | 0 |
| `apps/backend/test/live.e2e-pipeline.test.ts` | **Live** HTTP → MCP client → MCP server → ArcGIS (offline + AI-scripted + PNG) | 14 | 14 | 0 | 0 |
| `apps/web/test/mapStyles.test.ts`, `csv.test.ts` | Unit | 8 | 8 | 0 | 0 |
| `e2e/app.spec.ts` | **Browser E2E** (Chromium desktop + mobile, live stack, axe) | 11 | 11 | 0 | 0 |
| **Total** | | **205** | **205** | **0** | **0** |

Commands: `LIVE_GIS=1 npm test` (all Vitest suites, live tests enabled) and `npm run build && npm run test:e2e`. Without `LIVE_GIS=1` the 30 live tests are skipped and everything else runs offline. The same offline run was reproduced from a clean clone with `npm ci` (as CI does).

### Defects found by testing and fixed
| Found by | Defect | Fix |
|---|---|---|
| Live smoke run | "Bike Only" on-street segments crowded "nearby trails" | Excluded by default; count reported; opt-in flag |
| Live smoke run | CIP projects marked "Construction" whose completion quarter had passed were presented as definitely active | `estimatedCompletionPassed` flag + warning in summary and limitations |
| Live API run | Offline address parser truncated "Frisco Square **Blvd**" and read "2 miles" as a house number | Two-token suffix support; distance phrases removed before parsing |
| Browser run | Answers never rendered: an effect returned the Promise from `scrollIntoView()` (newer Chromium) | Effect bodies wrapped in braces |
| Browser run | Mobile map fitted while hidden → wrong zoom; 50/55 mph same color | Refit when map becomes visible; distinct color per limit |
| API test | Missing `message` returned a technical Zod error | Friendly validation messages |
| Discovery script | Amenity points inside overlapping park polygons credited to one park only; "(Future Site)" parks and a UI placeholder record could be returned | Multi-park assignment; future sites excluded by default; placeholder skipped |
| Live results review | City address-point citation lacked a last-edited date | Geocoder citations now include layer freshness |
| E2E | Flaky skip-link focus test (headless focus starts in browser chrome) | Deterministic focus setup |
| Clean-clone CI simulation | `npm run typecheck` / `npm test` failed on a fresh checkout because the backend imports the MCP server package's compiled output | Root `pretypecheck`, `pretest` and `predev` scripts build the MCP server package first |
| Live map-image review | The caption drawn into map images was clipped (the print service ignores left alignment) | Caption anchored at the top centre and shortened |

## Per-use-case results

All rows use **live GIS data**. "Mode" indicates which assistant path produced the answer in the API/browser tests.

| ID | Citizen question | GIS source | Expected behavior | Actual result (observed 2026-11-17) | Status | Errors | Known limitations | Live/mocked |
|---|---|---|---|---|---|---|---|---|
| UC1 | What is the closest park to 6101 Frisco Square Blvd? | ParkApp_Testing; City Address Points | Geocode via City points; rank parks by distance to boundary; map park + location; cite sources | "Closest park … is **Simpson Plaza, 0.04 miles** to the nearest park boundary" (then Jimmy & Clara Jones Park 0.08 mi, Frisco Heritage Center 0.2 mi); 4 map features; sources incl. ParkApp (edited 2026-10-15) | **Pass** (MCP, API, browser) | — | Straight-line to boundary; no entrance data | Live |
| UC2 | Show me parks within 2 miles of 6101 Frisco Square Blvd. | same | All parks with any part within 2 mi | **19 parks**; every distance ≤ 2 mi; 0.5 mi around 8000 McKinney Rd returns fewer | **Pass** (MCP, API) | — | Future sites excluded (noted) | Live |
| UC3 | Which parks in Frisco have basketball courts? | ParkApp + ParkAmenities_Test | Parks whose record or contained amenity points show Basketball | **35 parks**; amenity evidence per park; 64 map features | **Pass** (MCP, API, browser) | — | Data disagreements listed when present | Live |
| UC4 | Which of those parks also have playgrounds? | same + session | Filter previous 35 only; require both amenities | "**Of the 35 parks from the previous results, 34** parks have Basketball and Playground"; all ids ⊆ previous ids | **Pass** (MCP, API offline, API AI-scripted, browser) | — | — | Live |
| UC5 | What is the zoning at 6101 Frisco Square Blvd? | City Zoning Layer; FriscoZoning_ODH; Parcels | Point-in-polygon; district + plain category; PD/ordinances; disclaimer | **MIXED (Mixed Use), PD-153, ordinances 19-08-67, 18-02-05**; "both layers agree"; parcel + zoning polygon on map | **Pass** (MCP, API, browser) | — | Not a legal determination | Live |
| UC6 | What trails are near 6101 Frisco Square Blvd? | FriscoPOI_ODH Hike_Bike | Trails within 1 mi, nearest first, geometry on map | **5 trails**; closest named **Gallegos Park Walking Loop 0.37 mi**; all ≤ 1 mi | **Pass** (MCP, API, browser-mobile) | — | Existing trails only by default | Live |
| UC7 | Show me walking loops in Frisco. | same | Only `WalkingLoo = Yes` | **36 walking loops** (47 segments), all `isWalkingLoop = true` | **Pass** (MCP, API, browser) | — | — | Live |
| UC8 | What road projects are currently under construction in Frisco? | City Active CIP | Only Status = Construction, Type = Road | **17 road projects**; all status Construction; **9 flagged** as past estimated completion | **Pass** (behavior) / data partially reliable | — | City CIP only; stale statuses possible; no edit timestamp | Live |
| UC9 | Are there any road projects near 6101 Frisco Square Blvd? | City Active CIP | Projects within 1 mi, status shown | **5 projects** within 1 mi (e.g. Ash St Reconstruction – Planning – 0.32 mi) | **Pass** (MCP, API) | — | Same as UC8 | Live |
| UC10 | What's the speed limit on Preston Road? | City Speed Limits; School Zones | Verified MPH; ask which segment when several | "PRESTON RD has different speed limits: **45 mph** (126 segments, 2300–8999); **55 mph** (95, 9000–16999); 50 mph (1). Which part…?" + clarification options; school zone listed | **Pass** (MCP, API, browser) | — | GIS record vs posted signage; TxDOT road | Live |
| UC10b | …near 8750 Preston Rd? | same + Esri geocoder | Pick segment nearest the address | "**45 mph**" (Esri geocoder cited, since the address isn't in City points) | **Pass** (MCP) | — | — | Live |
| NEG1 | Zoning at 99999 Nonexistent Imaginary Ln | geocoders | Clear failure, no fabrication | `ADDRESS_NOT_FOUND` → "I couldn't find … in or near Frisco" | **Pass** | — | — | Live |
| NEG2 | Speed limit on Zzyzx Boulevard | Speed Limits | No made-up limit | No match / suggestions only | **Pass** | — | — | Live |

### Proposal tool-catalog tools (added after the 10 use cases)

| ID | Question / action | Source | Expected | Actual (2026-11-17) | Status | Live/mocked |
|---|---|---|---|---|---|---|
| CAT1 | What maps does the City publish about construction? | ArcGIS Online item search | Only public FriscoTexas items | 10 items, e.g. "Construction & Development App", "Construction & Development Map", "Traffic Experience" | **Pass** (MCP, planner) | Live + mocked (operator injection) |
| CNT1 | How many parks are within 2 miles of 6101 Frisco Square Blvd? | ParkApp_Testing (server buffer) | Equals the geodesic radius search | Count equals `find_parks_within_radius` (19, future sites excluded) | **Pass** (MCP) | Live + mocked |
| IMG1 | Map image of an answer | Esri Export Web Map task | PNG with result features, returned as MCP image content | 1000×700 PNG with the nearest-park polygons, address marker and caption; also downloaded via the web UI (`docs/screenshots/12-downloaded-map-image.png`) | **Pass** (MCP, API, browser) | Live + mocked (allowlist bypass refused) |
| CSV | Download results (CSV) | — | One row per result, sources and retrieval time, formula-safe | CSV contains "Simpson Plaza" and a `data_sources` column | **Pass** (browser, unit) | Live + unit |

## Category coverage

**Functional:** GIS requests and pagination (mocked + live); every MCP tool (live); MCP client connect/discover/call (MCP integration + backend live); geocoding incl. fallbacks (live UC10b); spatial searches (UC1/2/6/9); amenity filtering (UC3/4, spatial-join fixture test); zoning (UC5); trails (UC6/7); road projects (UC8/9); speed limits (UC10, fixture clarification test); map visualization (browser: polygons, markers, legend, popups, result selection).

**Conversational:** follow-ups (UC4 offline + AI-scripted); context reuse ("zoning there"); ambiguous requests (Preston Rd clarification; "nearest park?" without address asks for one); unsupported questions (weather, poems → help text); 51 phrasing-variation and planner unit tests.

**Reliability:** invalid addresses (NEG1); missing records/empty results (NEG2, zero-result summaries); service timeouts, network failures, 5xx with retry, ArcGIS error-in-200, non-JSON bodies, oversized results (mocked); AI provider failure → offline fallback (mocked API); MCP connection failure → 503 (mocked API); City speed layer outage → open-data fallback (mocked).

**Usability & accessibility (browser):** desktop layout; mobile layout (no horizontal overflow, chat/map tabs); keyboard-only flow (skip link, Enter to send, focus return); high-contrast mode; glossary dialog; axe-core WCAG 2 A/AA scan with **no serious or critical violations** (home and answer states; map canvas excluded); clear error message for invalid address.

**Security:** invalid tool arguments (MCP schema tests); unauthorized endpoints (allowlist tests); excessive query sizes (radius caps, body-size 413, TOO_MANY_RESULTS); prompt injection (planner + API + tool-output isolation); credential exposure (API never returns the key; key not forwarded to MCP server); rate limiting (429); security headers.

## AI coverage — what was and was not tested

| Aspect | Tested? | How |
|---|---|---|
| Claude request construction (model, MCP-derived tools, effort, fallbacks, system prompt) | Yes — mocked | scripted model records requests |
| Tool-use loop: tool_use → MCP → tool_result, parallel calls, errors, refusal, round limit, append-only history | Yes — mocked | `mocked.claude-loop.test.ts` |
| AI path against **real MCP server + live GIS** | Yes — scripted model | `live.e2e-pipeline.test.ts` Part 2 |
| **Real Claude model choosing tools and wording answers** | **No — blocked** | No Anthropic API key could be provided to this cloud environment. Set `ANTHROPIC_API_KEY` and run the app (header badge shows "AI assistant") to verify. |

The offline planner (rule-based) provided the live end-to-end answers above. It is a documented fallback, not a replacement for the AI model.
