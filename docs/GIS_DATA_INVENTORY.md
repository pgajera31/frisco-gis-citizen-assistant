# GIS Data Inventory

All findings below come from **live ArcGIS REST queries** made on 2026-11-17. They can be regenerated at any time with:

```bash
npm run inventory          # writes docs/gis-discovery/evidence.json and summary.md
```

`evidence.json` holds, for every layer: endpoint, geometry type, feature count, all fields, capabilities, `maxRecordCount`, pagination and distinct support, last-edit date, an example query URL, and a real sample record. It also contains the data-quality analyses quoted below.

**Common properties of every layer used**
- Read-only `Query` capability. The sponsor's `DowntownProjectLayers` and `TrafficClosures` services also advertise `Create/Update/Delete`, but this project never sends those operations, and the MCP server can only issue `query` and metadata `GET`s.
- `maxRecordCount` = 2000. Pagination (`resultOffset` / `resultRecordCount`) is supported and is used by the client, which follows `exceededTransferLimit`.
- Native spatial reference is Web Mercator (3857) for ArcGIS Online layers and Texas State Plane North Central (WKID 6584, US feet) for City-server layers. All queries request `outSR=4326`, and spatial filters send `inSR=4326`, so the server reprojects everything to WGS84 and no client-side projection maths is needed.
- Supported query parameters used: `where`, `outFields`, `geometry`, `geometryType=esriGeometryPoint`, `inSR`, `spatialRel=esriSpatialRelIntersects`, `outSR`, `returnGeometry`, `returnCountOnly`, `geometryPrecision`, `resultOffset`, `resultRecordCount`, `groupByFieldsForStatistics`/`outStatistics` (discovery only), `f=json`.
- ArcGIS returns query errors as **HTTP 200 with an `error` object**. The client checks the body of every response (see `packages/mcp-server/src/arcgis/client.ts`).

Abbreviations: **AGOL** = `https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services` (City of Frisco ArcGIS Online organisation); **CITY** = `https://maps.friscotexas.gov/gis/rest/services/Public` (City-hosted ArcGIS Server, discovered through the City's public web maps).

---

## 1. Datasets used by the assistant

### 1.1 Park polygons with amenities — `ParkApp_Testing` (sponsor-provided)
| Item | Value |
|---|---|
| URL / layer | `AGOL/ParkApp_Testing/FeatureServer/0` |
| Geometry | Polygon · **82** features |
| Relevant fields | `ParkName`, `Address`, `ParkDesc`, `Website`, `AllAmenities`, and one field per amenity: `Basketball`, `Playground`, `WalkingTrail`, `DogPark`, `SplashPad`, `Pickleball`, `Tennis`, `Restrooms`, … (34 amenity fields) |
| Field semantics (verified) | Each amenity field holds the amenity's label when present (`Basketball` = "Basketball" ×35) and is empty/`None` otherwise. One record has the literal value "No". The code treats `No/None/blank` as absent. |
| Example query | `…/query?where=1=1&outFields=ParkName,Address,Basketball,Playground&returnGeometry=false&resultRecordCount=1&f=json` → `{"ParkName":"Simpson Plaza","Address":"6501 Frisco Square Blvd",…}` |
| Testing vs operational | Named "Testing", but it is the layer behind the City's public **"Parks, Trails, and Facilities"** Experience Builder app (verified in that app's web map). Treated as operational but flagged as sponsor test data. |
| Freshness | `lastEditDate` 2026-10-15 |
| Limitations | 9 records are "… (Future Site)" parks (not open). One placeholder record "Select a Park for More Info" has every amenity flagged and no geometry. No entrance locations. Name differences against the open-data park layer (see §3). |
| Handling | Future sites excluded by default (opt-in flag); placeholder skipped; distance measured to the boundary. |
| Use cases | UC1, UC2, UC3, UC4 |

### 1.2 Park amenity points — `ParkAmenities_Test` (sponsor-provided)
| Item | Value |
|---|---|
| URL / layer | `AGOL/ParkAmenities_Test/FeatureServer/0` |
| Geometry | Point · **503** features |
| Fields | `Park` (text), `Amenity` (34 values, same vocabulary as the park fields, plus "None") |
| Relationship to parks (verified) | **477** points fall inside a park polygon. For **454** of those the `Park` text matches the polygon name, and **23** do not ("Bicentennial Park" vs "Bi-Centennial Park"; points inside the overlapping "Dash's Track Disc Golf Course" polygon). Another **24** lie within ~100 ft of a park, **2** match only by name, and **0** are unmatched. |
| Conclusion | The `Park` text is **not** a reliable join key. Points are joined **spatially**: inside the polygon (to every overlapping polygon) or snapped to the nearest polygon within ~100 ft. |
| Freshness | `lastEditDate` 2026-10-16 |
| Use cases | UC3, UC4 (evidence and map markers) |

### 1.3 Zoning — `FriscoZoning_ODH` layer 1 (sponsor-provided) and City "Zoning Layer"
| Item | ODH layer | City layer |
|---|---|---|
| URL | `AGOL/FriscoZoning_ODH/FeatureServer/1` | `CITY/External_Planning_and_Zoning/MapServer/32` |
| Geometry / count | Polygon · 1,298 | Polygon · 1,298 |
| Fields | `ZONING`, `PD`, `SUP`, `ORD1`, `ORD2` | `ZONE_`, `PD`, `SUP`, `ORD1`, `ORD2`, `SYMBOL`, `ORD1Hyperlink`, `ORD2Hyperlink` |
| Category meaning | — | `SYMBOL` drives the City's official legend: 1 Agricultural, 2 Single Family, 3 Multi Family, 4 Office, 5 Retail, 6 Mixed Use, 7 Original Town Residential, 8 Information Technology, 9 Original Town Commercial, 10 Industrial, 11 OTC\*, 30 College (read from the layer's renderer). |
| Freshness | 2026-11-17 | not published by MapServer |
| Example | point-in-polygon at 6101 Frisco Square Blvd → `ZONING: "MIXED", PD: "PD-153", ORD1: "19-08-67", ORD2: "18-02-05"` | same district plus `SYMBOL: 6` (Mixed Use) and agenda.friscotexas.gov ordinance links |

Both layers are queried and cross-checked, and the answer reports whether they agree. `FriscoZoning_ODH/0 Proposed_Zoning` (27 polygons) is reported separately as **pending zoning cases**, never as current zoning. Parcels (`FriscoLandRec_ODH/1`, 73,334 polygons, `LANDUSE`, `X_REF`) identify the parcel the address sits on. **Use case:** UC5.

### 1.4 Trails — `FriscoPOI_ODH` layer 6 "Hike_Bike"
| Item | Value |
|---|---|
| URL / layer | `AGOL/FriscoPOI_ODH/FeatureServer/6` |
| Geometry | Polyline · **619** segments |
| Fields (verified values) | `Name`; `TrailType` (Local 381, Parkway 138, Bike Only 52, Regional 43, Nature 5); `WalkingLoo` (Yes 47 / No 572); `LifeCycleS` (Existing 499, Future 116, Under Construction 2, Abandoned 2); `Surface`; `BikeRouteT` ("Bike Lane" 35); `Connector`; `Owner` |
| Freshness | `lastEditDate` 2026-11-17 |
| Limitations | Segments, not whole trails, so results are grouped by `Name`. "Bike Only" segments are on-street routes (excluded from "nearby trails" by default). `Length` is text, so length is computed from geometry. |
| Use cases | UC6, UC7 (walking loops use `WalkingLoo = 'Yes'` only, never inferred from shape) |

The City also publishes `CITY/Trails_Update/MapServer/3` "Walking Loops" (35) and `CITY/FriscoData/MapServer/7` "Trails" (846) with the same schema. They were evaluated, and the open-data copy was chosen for host reliability and its published edit date.

### 1.5 Road projects — City "Active CIP" (Capital Improvement Projects)
| Item | Value |
|---|---|
| URL / layer | `CITY/FriscoData/MapServer/6` (primary; the layer behind the City's public "Active CIP Map"); mirror `CITY/External_Engineering/MapServer/28` (same schema, excludes Completed) |
| Geometry | Polyline · 158 features (mirror 106) |
| Fields | `ProjectNumber`, `Name`, `Limits`, `Type` (Road 75 / Utility 28 / Parks 55), `Subtype`, `Description`, `Status` (Construction 35, Design 30, Planning 37, On Hold 4, Completed 51), `BidDate`, `CompletionDate` ("YYYY Qn"), `OPCC` (cost), `Funding`, `WebLink` |
| Coverage | **Citywide** City capital projects |
| Freshness | MapServer publishes no edit date. The "Active CIP Map" item was modified 2026-10-31. |
| Data-quality finding | **9 of the 17** Road projects with `Status = Construction` have an estimated completion quarter already in the past (e.g. "Custer at Bighorn – 2025 Q2"). They are still reported, with an explicit warning that their status may be stale. |
| Use cases | UC8 (Status = Construction, Type = Road), UC9 (spatial distance ≤ radius; Construction + Design + Planning by default, each project labelled with its status) |

### 1.6 Speed limits — City "Speed Limits"
| Item | Value |
|---|---|
| URL / layer | `CITY/External_Engineering/MapServer/6` (primary); fallback `AGOL/FriscoTrans_ODH/FeatureServer/0` (open-data streets, `MPH` field, 16,839 segments, edited 2026-11-17) |
| Geometry | Polyline · **20,437** street segments |
| Fields | `FULL_NAME`, `ROAD_NAME`, `ROAD_SUF`, `ALIAS` (e.g. "SH 289"), **`MPH`**, `L_ADD_F/T`, `R_ADD_F/T`, `OWNER` (domain: CI City, TX TxDOT, NT NTTA, PR Private, CO County, SH Shared, OT Other), `LIFECYCLESTATUS` (domain: PROP Proposed, COMP Completed, **CONST = Constructed**, OTH, UNK) |
| Verified example | Preston Rd: 45 mph × 126 segments (addresses 2300–8999), 55 mph × 95 (9000–16999), 50 mph × 1. Owner TxDOT, alias SH 289. |
| Related | `CITY/External_Engineering/MapServer/5` School Speed Zones (285; `SCHOOL`, `TIMES_ACTIVE`, `MPH_ACTIVE`) |
| Handling | Proposed streets excluded. Segments grouped by MPH. Clarification is requested when there is more than one limit and no address. If an address is given, the nearest segment is used. |
| Use case | UC10 |

### 1.7 Supporting datasets
| Dataset | URL | Geometry · count | Used for | Freshness |
|---|---|---|---|---|
| Address Points | `AGOL/FriscoLandRec_ODH/FeatureServer/0` | Point · 71,923 (`STR_NUMBER`, `STR_NAME`, `STR_SUFFIX`, `FULL_ADDRE`) | **Primary geocoder** (exact house-number match). 6101 Frisco Square Blvd → (-96.834539, 33.150040) | 2026-11-17 |
| Parcels | `AGOL/FriscoLandRec_ODH/FeatureServer/1` | Polygon · 73,334 | Parcel under the address (zoning answer) | 2026-11-17 |
| City Boundary | `AGOL/City_of_Frisco_Boundary/FeatureServer/0` | Polygon · 9 | "Is this inside Frisco city limits?" flag | 2023-10-26 |
| Traffic Closures | `AGOL/TrafficClosures/FeatureServer/0` | Polygon · 561 (`Status` Active 1 / Removed 560; `Owner` NTTA 533, City 26) | Supporting "active closures" tool. **Never presented as construction.** | 2026-01-28 |
| Esri World Geocoder | `https://geocode.arcgis.com/…/World/GeocodeServer/findAddressCandidates` | — | Fallback for landmarks / addresses missing from City points; restricted to a Frisco bounding box, score ≥ 85, `forStorage=false` | live |
| U.S. Census Geocoder | `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` | — | Last-resort fallback (range interpolation) | live |

---

## 2. Datasets evaluated but not used

| Dataset | Finding | Decision |
|---|---|---|
| `AGOL/DowntownProjectLayers` (0 Points 15, 1 Lines 5, 2 Polygons 14) | Downtown parking and plaza features (`PointType`, `PolygonType`, `LifeCycleStatus` = "Open"). No construction status or dates. | Not road projects; not used. |
| `AGOL/DowntownConstructionDetails/2` (50 polygons) | Downtown Main St / 4th St Plaza phases with text dates. 12 have an end date and **all end dates have passed** (latest "May 2026"). Downtown only. | Not used for "currently under construction". Documented. |
| `AGOL/RoadClosures_events_…/1` (959 lines) | Special-event closures (`Responsibility` City/Venue; `reason` always null). | Event closures, not construction; not used. |
| `AGOL/FriscoPOI_ODH/0` Parks (86) | Official open-data parks with `P_TYPE` and `ACRES` but **no amenity fields**. 67 names match ParkApp exactly; the rest differ in spelling ("Wranglers Range" vs "Wranger's Range"). | ParkApp is used because amenities are required. Spelling issues noted for the City. |
| `CITY/External_Engineering/MapServer/36` Roads 5-Year CIP (36) | All attribute fields (name, status, fiscal year) are **null**. | Unusable; documented. |
| `AGOL/Trail_Markers`, `GrandParkTrailSigns` | Points for signage only. | Not trail geometry; not used. |
| Street centerline `LIFECYCLES = 'CONST'` | The domain defines CONST as **"Constructed"**, not "under construction". | Correctly **not** treated as active construction. |
| Experience Builder "Frisco Commons" (`12f59be9…`) | A Parks *Story Map* (narrative pages) that uses `External_Points_of_Interest` park layers. | Informational only. |
| Experience Builder "Parks, Trails, and Facilities" (`bf261897…`) | Web map uses **ParkApp_Testing** + **ParkAmenities_Test** + City POI MapServer. | Confirms the sponsor layers are what residents see. |
| `geo.friscotexas.gov` FriscoComposite GeocodeServer | Referenced by the City's Traffic Experience but the connection was **reset** from this environment. | Not used; City address points give the same authority. |

---

## 3. Reliability considerations (summary)

1. **Two park sources disagree on spelling** (82 vs 86 parks, 67 exact name matches). Spatial joins avoid relying on names.
2. **CIP status may lag** (9 of 17 "Construction" road projects are past their estimated completion). The assistant says so.
3. **Traffic closure "Active" depends on manual upkeep.** Only 1 of 561 is Active; time periods are free text without a year.
4. **MapServer layers don't publish edit dates.** Answers show the retrieval time instead and say that the edit date is not published.
5. **City boundary layer last edited 2023-10-26.** Used only for an informational "outside city limits" flag.
6. **Segment-level speed limits.** One road can carry several limits, and the City data may lag posted signage. TxDOT/NTTA roads are flagged.
