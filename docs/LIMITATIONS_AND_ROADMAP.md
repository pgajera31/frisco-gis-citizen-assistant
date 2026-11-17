# Known Limitations & Recommended Improvements

## Known limitations

### Not verified in this build
- **Live Claude answers were not tested.** The cloud development environment could not be given an Anthropic API key. The AI orchestration is covered by mocked tests and by a scripted-model run against the real MCP server and live GIS data, but real model tool selection and answer wording still need to be checked with a key (see README › AI provider).
- No formal usability study with 6–8 non-GIS residents (proposal evaluation plan). Only automated accessibility and keyboard checks were run.

### Data
- **Road projects (UC8/9)** cover City of Frisco capital projects only; TxDOT, NTTA, county and private-development work is absent. 9 of 17 "Construction" road projects are past their estimated completion, so statuses may be stale. The CIP service does not publish a last-edit timestamp.
- **Park data** is the sponsor's `ParkApp_Testing` layer: no entrance points, so distances go to the park boundary. 9 future sites are excluded by default. Spelling differs from the open-data park layer.
- **Speed limits** come from GIS records, not signage. Several roads are TxDOT/NTTA-maintained, and school zones apply only at posted times.
- **Zoning** answers report the district and ordinances only. No permitted-use interpretation is attempted, by design.
- **City MapServer layers** (zoning category, CIP, speed limits) publish no edit dates. Answers show retrieval time instead.
- The City's own composite geocoder (`geo.friscotexas.gov`) was unreachable from the development environment. Esri and Census are used as fallbacks after the City's address points.

### Application
- Offline-planner mode understands the 10 supported question types and many variations, but not open-ended phrasing. The AI mode is the intended experience.
- Sessions and rate-limit counters are in memory, so a restart clears conversations.
- Map shows only the latest answer's features. There is no layer toggling or basemap switching.
- Map images depend on Esri's public print service (`utility.arcgisonline.com`). Its output links are temporary, and the image has a caption but no legend.
- English only.

## Before production

1. Run and evaluate the AI mode with a real key (accuracy and time-to-answer on the 10 to 15 scenario prompts), and tune the prompt and effort.
2. Confirm the data stewards for each layer with City GIS. Promote `ParkApp_Testing` / `ParkAmenities_Test` to named production layers, and fix the stale CIP statuses and park-name spellings.
3. Use the City's composite geocoder (or a City-hosted locator) to avoid sending addresses to third parties.
4. Move to shared session and rate-limit storage (Redis), add AI cost budgets, structured logging and monitoring, plus a status banner fed by layer health checks.
5. Add authentication to the HTTP MCP endpoint if it is exposed, and put the API behind a gateway with WAF/bot protection.
6. Run an accessibility audit with assistive-technology users, a usability study with residents, and a content review of glossary and disclaimers with City Communications.
7. CI exists (`.github/workflows/ci.yml`: offline gate on PRs, nightly live and browser runs). Next: make the live job a required check once the City confirms service SLAs, and add a nightly `npm run inventory` diff to flag schema changes.

## Future enhancements (aligned with the proposal)
- Walk-time to amenities (needs a routable sidewalk/trail network).
- Additional MCP tools: school zones by school, ISD boundaries, future land use, trash pickup or other public services, public facilities and events.
- Multilingual answers (Spanish first) and voice input.
- Admin console for the tool catalog and usage analytics.
