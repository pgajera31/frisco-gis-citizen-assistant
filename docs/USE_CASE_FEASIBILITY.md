# Use-Case Feasibility Matrix

Classification rules: **Fully supported** = verified data answers the question as asked. **Partially supported** = answerable with a documented caveat that limits completeness or certainty. **Blocked** = verified data is missing or insufficient.

| # | Use case | Status | Data (see GIS_DATA_INVENTORY.md) | Evidence | Caveats |
|---|---|---|---|---|---|
| 1 | Find the nearest park | **Fully supported** | ParkApp_Testing polygons + City Address Points | Live: "closest park to 6101 Frisco Square Blvd is Simpson Plaza, 0.04 mi to the boundary" (MCP + API + browser tests) | Straight-line distance to the park **boundary**; no entrance data exists. Future sites excluded. |
| 2 | Parks within a radius | **Fully supported** | Same | Live: 19 parks within 2 mi of 6101 Frisco Square Blvd; fewer within 0.5 mi of 8000 McKinney Rd | A park counts if any part of its boundary is within the radius (stated in every answer). Radius limited to 0.1–10 mi. |
| 3 | Parks by amenity | **Fully supported** | ParkApp amenity fields + ParkAmenities_Test points (spatial join) | Live: 35 parks with Basketball | 34 amenity types; synonyms accepted. Disagreements between the park record and the points are reported. |
| 4 | Follow-up filtering | **Fully supported** | Same + session context | Live: "Of the 35 parks from the previous results, 34 have Basketball and Playground". The AI path is tested with a scripted model against live data. | Works in AI mode (conversation history) and offline mode (stored park IDs). |
| 5 | Property zoning | **Fully supported** | City Zoning Layer (category + ordinance links) cross-checked with FriscoZoning_ODH; parcels; pending cases | Live: 6101 Frisco Square Blvd → MIXED (Mixed Use), PD-153, ordinances 19-08-67 / 18-02-05; both layers agree | Reports the district, not permitted uses. A legal-determination disclaimer is always shown. |
| 6 | Nearby trails | **Fully supported** | FriscoPOI_ODH Hike_Bike | Live: 5 trails within 1 mi; closest named: Gallegos Park Walking Loop (0.37 mi) | Only "Existing" trails by default. On-street "Bike Only" routes excluded unless requested. |
| 7 | Trails by type (walking loops) | **Fully supported** | `WalkingLoo = 'Yes'`, `TrailType` | Live: 36 walking loops (47 segments) | Walking loops come only from the City attribute; nothing is inferred from shape. |
| 8 | Active road construction | **Partially supported** | City Active CIP (Status = Construction, Type = Road) | Live: 17 road projects under construction | Covers **City** CIP only (not TxDOT/NTTA/developer work). **9 of the 17 are past their estimated completion**, so their status may be stale; the assistant flags each one. The layer has no last-edit timestamp. |
| 9 | Road projects near an address | **Partially supported** | Same, spatial distance | Live: 5 projects within 1 mi of 6101 Frisco Square Blvd (Planning/Design/Construction, each labelled) | Same coverage and freshness caveats as UC8. Distance is to the project line. |
| 10 | Street speed limits | **Fully supported** | City Speed Limits (segment MPH) + School Speed Zones | Live: Preston Rd → 45 / 55 / 50 mph segments, so the assistant asks which stretch. Near 8750 Preston Rd → 45 mph. | GIS records, not legal signage. TxDOT-maintained segments flagged. School-zone limits listed. |

**Result: 8 fully supported, 2 partially supported, 0 blocked.** No use case relies on fabricated or simulated data.

## Additional use cases 11–14

The proposal asks for 10–15 curated use cases across Planning & Zoning, Public Works, Parks, Transportation and Community Engagement. Four more were added, each backed by a layer verified the same way as the first ten.

| # | Use case | Status | Data | Evidence (live, 2026-11-17) | Caveats |
|---|---|---|---|---|---|
| 11 | Which school district is my address in? | **Fully supported** | FriscoZoning_ODH/7 ISD boundaries (13 districts) | 6101 Frisco Square Blvd → **Frisco ISD** | District only. Attendance zones (which campus) are set by each district and are not in City data; every answer says so. |
| 12 | What is the future land use plan for my address? | **Fully supported** | FLU2025_Layers/1 (2025 Comprehensive Plan, 514 polygons) | → **Town Center** (2025 plan, adoption document linked) | A planning guide, not zoning. The layer's `FLU_CD` codes are legacy 2015 values that contradict the 2025 categories, so only `FLU_Desc` is used. |
| 13 | What schools are near my address? | **Fully supported** | FriscoPOI_ODH/4 Schools (122) | 17 schools within 2 mi; closest Benton A. Staley Middle School 0.77 mi | Nearest ≠ assigned. District support facilities (subtype 5) and proposed schools excluded by default. |
| 14 | Where is the nearest fire station / library / police / post office? | **Fully supported** | FriscoPOI_ODH/1 Public Facilities (38) | Fire Station 4, 0.9 mi; Frisco Public Library, 0.38 mi | Category inferred from facility name (the layer has no category field). Straight-line distance. For emergencies call 911. |

## Considered and rejected

| Candidate | Reason |
|---|---|
| City events (`SpecialEvents_active_approved_public_…`, 14 records) | Contains internal operational entries ("Extra Duty Traffic Control"), a placeholder ("Event Name Here"), and **organisers' personal names, e-mails and phone numbers**. It is unsuitable for a public assistant on both data-quality and privacy grounds. |
| `FriscoEvents/0` | One stale record (last edited 2023) with no event name. |
| Future Land Use 2015 (`FriscoZoning_ODH/3`) | Superseded by the 2025 plan. |

## Earlier classification considered and revised

The sponsor-listed sources alone (`DowntownProjectLayers`, `DowntownConstructionDetails`, `TrafficClosures`) would have made UC8/UC9 **blocked**:
- The downtown layers cover one area, and every published end date has passed.
- Traffic closures are not construction projects.

Researching the City's public web maps found the **citywide Active CIP layer**, which moved UC8/UC9 to *partially supported*.

Similarly, the sponsor's `FriscoTrans_ODH` streets layer does contain `MPH`, and the City's dedicated **Speed Limits** layer confirmed it. That made UC10 fully supported.
