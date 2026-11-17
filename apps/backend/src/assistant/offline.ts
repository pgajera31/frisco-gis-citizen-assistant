/**
 * Offline planner — used ONLY when no AI model is configured (or the AI provider
 * is unavailable). It recognises the supported question patterns with regular
 * expressions and vocabulary from the City data, calls the same MCP tools the
 * AI would, and formats the structured results into a plain answer.
 *
 * It is deliberately transparent and limited: it is a fallback so the full
 * Web → Backend → MCP client → MCP server → ArcGIS pipeline can be demonstrated
 * and tested without an AI key. It is not a substitute for the language model.
 */
import { AMENITIES, normalizeText, TRAIL_TYPES } from "@frisco-gis/mcp-server/vocabulary";
import type { GisMcpClient, GisToolResult } from "../mcp/client.js";
import type { OfflineContext, Session } from "../sessions.js";
import { type ChatTurnResult, TurnCollector } from "./types.js";

export interface PlannedCall {
  tool: string;
  args: Record<string, unknown>;
}

export type Plan = { kind: "call"; call: PlannedCall; intent: string } | { kind: "reply"; text: string; intent: string };

const SUFFIX = "st|street|rd|road|blvd|boulevard|dr|drive|ln|lane|pkwy|parkway|ave|avenue|ct|court|way|trl|trail|cir|circle|pl|place|tollway|plz|plaza|sq|square|loop|xing|crossing|cv|cove|ter|terrace|pass|run|path|row|hwy|highway|bnd|bend|rdg|ridge|trce|trace";
const ADDRESS_RE = new RegExp(`\\b(\\d{1,6}(?!\\s*(?:mi|miles?)\\b)\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9.'&-]+(?:\\s+[A-Za-z0-9.'&-]+){0,4}?\\s+(?:${SUFFIX})\\b(?:\\s+(?:${SUFFIX})\\b)?\\.?)(?:\\s*,?\\s*(?:frisco)?\\s*,?\\s*(?:tx|texas)?\\s*(?:75\\d{3})?)?`, "i");
const PLACE_AFTER_PREP_RE = /\b(?:near|of|at|to|around|from|by)\s+(?!me\b|those\b|them\b|these\b|there\b)([A-Za-z0-9][A-Za-z0-9 .,'&-]{2,80}?)\s*[?.!]*$/i;

const HELP =
  "I can answer questions about Frisco's public GIS data. Try one of these:\n" +
  "- What is the closest park to 6101 Frisco Square Blvd?\n" +
  "- Show me parks within 2 miles of 6101 Frisco Square Blvd.\n" +
  "- Which parks in Frisco have basketball courts? (then: Which of those also have playgrounds?)\n" +
  "- What is the zoning at 6101 Frisco Square Blvd?\n" +
  "- What trails are near 6101 Frisco Square Blvd? / Show me walking loops in Frisco.\n" +
  "- What road projects are currently under construction in Frisco? / Are there any road projects near 6101 Frisco Square Blvd?\n" +
  "- What's the speed limit on Preston Road?";

/** Remove distance phrases ("within 2 miles of") so their numbers are not mistaken for house numbers. */
function withoutDistances(text: string): string {
  return text.replace(/\b(?:within|in|inside)?\s*(?:a\s+)?(?:\d+(?:\.\d+)?|half(?: a)?|one|two|three|four|five)\s*-?\s*(?:miles?|mi)\b(?:\s+(?:radius|of|from|around))*/gi, " ");
}

export function extractAddress(text: string): string | undefined {
  const m = withoutDistances(text).match(ADDRESS_RE);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  return undefined;
}

function extractPlace(text: string): string | undefined {
  const addr = extractAddress(text);
  if (addr) return addr;
  const m = withoutDistances(text)
    .replace(/\s+in\s+frisco(?:,?\s*(?:tx|texas))?\s*([?.!]*)\s*$/i, ", Frisco$1")
    .match(PLACE_AFTER_PREP_RE);
  if (!m) return undefined;
  const place = m[1].replace(/\s*,?\s*(frisco)?\s*,?\s*(tx|texas)?\s*$/i, "").trim();
  // Reject generic phrases that are not places.
  if (!place || /^(frisco|the city|town|downtown frisco|here|my house|home)$/i.test(place)) return undefined;
  return /frisco/i.test(m[1]) ? `${place}, Frisco, TX` : place;
}

function extractRadius(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?|half(?: a)?|one|two|three|four|five)\s*(?:-|\s)?\s*(?:miles?|mi)\b/i);
  if (!m) return undefined;
  const words: Record<string, number> = { half: 0.5, "half a": 0.5, one: 1, two: 2, three: 3, four: 4, five: 5 };
  const v = words[m[1].toLowerCase()] ?? Number.parseFloat(m[1]);
  return Number.isFinite(v) ? Math.min(10, Math.max(0.1, v)) : undefined;
}

/** Amenities mentioned in the text, longest phrases first, using the City data's vocabulary. */
export function extractAmenities(text: string): string[] {
  const t = ` ${normalizeText(text)} `;
  const found: { label: string; len: number; idx: number }[] = [];
  for (const a of AMENITIES) {
    for (const phrase of [a.label, ...a.synonyms]) {
      const p = normalizeText(phrase);
      if (!p || p.length < 3) continue;
      for (const variant of [p, `${p}s`]) {
        const idx = t.indexOf(` ${variant} `);
        if (idx >= 0) found.push({ label: a.label, len: variant.length, idx });
      }
    }
  }
  // Prefer the longest match at each position, and drop generic matches covered by a longer one.
  found.sort((x, y) => y.len - x.len);
  const taken: { start: number; end: number }[] = [];
  const labels: string[] = [];
  for (const f of found) {
    const span = { start: f.idx, end: f.idx + f.len };
    if (taken.some((s) => span.start < s.end && s.start < span.end)) continue;
    taken.push(span);
    if (!labels.includes(f.label)) labels.push(f.label);
  }
  return labels;
}

function extractStreet(text: string): { street?: string; near?: string } {
  const m = text.match(/\b(?:on|for|of|along|down)\s+(?:the\s+)?([A-Za-z0-9 .'-]+?)(?:\s+(?:near|at|by|around)\s+(.+?))?\s*(?:in frisco)?\s*[?.!]*$/i);
  if (!m) return {};
  const street = m[1].replace(/\s+(speed limits?|mph|limits?)\s*$/i, "").trim();
  if (!street || /^(frisco|my street|the road)$/i.test(street)) return {};
  return { street, near: m[2] ? extractAddress(m[2]) ?? m[2].trim() : undefined };
}

const CATALOG_STOPWORDS = new Set([
  "what", "which", "list", "find", "show", "are", "there", "does", "the", "city", "frisco", "publish", "published", "have", "has",
  "any", "about", "for", "with", "you", "maps", "map", "apps", "app", "application", "applications", "dashboards", "dashboard",
  "datasets", "dataset", "data", "sets", "set", "story", "storymaps", "storymap", "web", "available", "gis", "online", "public", "and", "of",
]);

/** Words in a "how many …" question → countable layer key (most specific first). */
const COUNT_LAYER_WORDS: [RegExp, string][] = [
  [/\b(park )?amenit(y|ies)\b/, "parkAmenities"],
  [/\bparks?\b/, "parks"],
  [/\btrails?\b/, "trails"],
  [/\b(road |capital |construction )?projects?\b|\bcip\b/, "activeCip"],
  [/\bclosures?\b/, "trafficClosures"],
  [/\bschool zones?\b/, "schoolZones"],
  [/\b(addresses|homes|houses|address points)\b/, "addressPoints"],
  [/\b(parcels?|lots|properties)\b/, "parcels"],
];

/** Facility words → find_nearby_facilities category ("" = any public facility). */
const FACILITY_WORDS: [RegExp, string][] = [
  [/\bfire ?(station|house|department)s?\b/, "fire station"],
  [/\bpolice( station| department| headquarters)?\b/, "police"],
  [/\blibrar(y|ies)\b/, "library"],
  [/\bpost offices?\b/, "post office"],
  [/\b(city hall|municipal center|municipal court)\b/, "city hall"],
  [/\b(rec(reation)? centers?|athletic center)\b/, "recreation"],
  [/\bpublic facilit(y|ies)\b|\bcity facilit(y|ies)\b/, ""],
];

const FOLLOW_UP_RE = /\b(those|these|them|ones|that list|of the(?:se|m))\b/i;

/** Decide which MCP tool (if any) answers the message. Pure function → unit-testable. */
export function planOffline(text: string, ctx: OfflineContext): Plan {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (/^(hi|hello|hey|help|what can you do)\b/.test(lower) && t.length < 40) return { kind: "reply", text: HELP, intent: "help" };

  // Catalog search: "What maps does the City publish about construction?"
  if (/\b(maps?|apps?|applications?|dashboards?|datasets?|data sets?|story ?maps?|web maps?)\b/.test(lower) && /\b(what|which|list|find|are there|does|do you have|show)\b/.test(lower) && !/\b(speed|zon(e|ed|ing)|closest|nearest|within)\b/.test(lower)) {
    const topic = lower
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !CATALOG_STOPWORDS.has(w))
      .join(" ");
    const itemTypes = [
      ...(/\bstory ?maps?\b/.test(lower) ? ["StoryMap"] : []),
      ...(/\bdashboards?\b/.test(lower) ? ["Dashboard"] : []),
      ...(/\b(apps?|applications?)\b/.test(lower) ? ["Web Experience", "Web Mapping Application"] : []),
    ];
    return {
      kind: "call",
      intent: "catalog",
      call: { tool: "search_gis_catalog", args: { query: topic || "frisco", ...(itemTypes.length ? { item_types: itemTypes } : {}) } },
    };
  }

  // Buffer/count: "How many parks are within 1 mile of …?"
  if (/\bhow many\b/.test(lower)) {
    const layer = COUNT_LAYER_WORDS.find(([re]) => re.test(lower))?.[1];
    const addr = extractPlace(t);
    if (layer && addr) {
      return {
        kind: "call",
        intent: "count",
        call: { tool: "count_features_within_radius", args: { address: addr, layer, radius_miles: Math.min(extractRadius(t) ?? 1, 5) } },
      };
    }
  }

  // 10. Speed limits
  if (/\b(speed limit|speed limits|how fast|mph|speed)\b/.test(lower)) {
    const { street, near } = extractStreet(t);
    if (!street) return { kind: "reply", text: "Which street do you want the speed limit for? For example: “What's the speed limit on Preston Road?”", intent: "speed_limit" };
    return { kind: "call", intent: "speed_limit", call: { tool: "get_speed_limit", args: { street_name: street, ...(near ? { near_address: near } : {}) } } };
  }

  // 11. School district (before zoning/schools: "school district" is not a list of schools)
  if (/\bschool district\b|\bisd\b|\bwhich district\b/.test(lower)) {
    const addr = extractPlace(t) ?? (/\b(there|that address|same address|it)\b/.test(lower) ? ctx.lastAddress : undefined);
    if (!addr) return { kind: "reply", intent: "school_district", text: "Which address should I check? For example: “Which school district is 6101 Frisco Square Blvd in?”" };
    return { kind: "call", intent: "school_district", call: { tool: "lookup_school_district", args: { address: addr } } };
  }

  // 12. Future land use (long-range plan, not zoning)
  if (/\bfuture land ?use\b|\bland ?use plan\b|\bcomprehensive plan\b|\bplanned (?:to be|for)\b/.test(lower)) {
    const addr = extractPlace(t) ?? (/\b(there|that address|same address|it)\b/.test(lower) ? ctx.lastAddress : undefined);
    if (!addr) return { kind: "reply", intent: "future_land_use", text: "Which address should I check? For example: “What is the future land use for 6101 Frisco Square Blvd?”" };
    return { kind: "call", intent: "future_land_use", call: { tool: "lookup_future_land_use", args: { address: addr } } };
  }

  // 14. Public facilities
  const facility = FACILITY_WORDS.find(([re]) => re.test(lower))?.[1];
  if (facility !== undefined) {
    const addr = extractPlace(t) ?? ctx.lastAddress;
    if (!addr) return { kind: "reply", intent: "facilities", text: "What address should I search from? For example: “Where is the nearest fire station to 6101 Frisco Square Blvd?”" };
    return { kind: "call", intent: "facilities", call: { tool: "find_nearby_facilities", args: { address: addr, ...(facility ? { category: facility } : {}) } } };
  }

  // 13. Schools near an address
  if (/\b(schools?|universit(y|ies)|colleges?)\b/.test(lower) && !/\bschool zones?\b/.test(lower)) {
    const addr = extractPlace(t);
    if (addr) {
      const level = /\belementary\b/.test(lower) ? "elementary" : /\b(middle|intermediate)\b/.test(lower) ? "middle" : /\bhigh school/.test(lower) ? "high" : /\b(college|universit)/.test(lower) ? "college" : undefined;
      const type = /\bprivate\b/.test(lower) ? "Private" : /\bcharter\b/.test(lower) ? "Charter" : /\bpublic\b/.test(lower) ? "Public" : undefined;
      const radius = extractRadius(t);
      return {
        kind: "call",
        intent: "schools",
        call: { tool: "find_nearby_schools", args: { address: addr, ...(level ? { level } : {}), ...(type ? { school_type: type } : {}), ...(radius ? { radius_miles: Math.min(radius, 5) } : {}) } },
      };
    }
  }

  // 5. Zoning
  if (/\bzon(e|ed|ing)\b/.test(lower)) {
    const addr = extractPlace(t) ?? (/\b(there|that address|same address|it)\b/.test(lower) ? ctx.lastAddress : undefined);
    if (!addr) return { kind: "reply", text: "Which address would you like the zoning for? For example: “What is the zoning at 6101 Frisco Square Blvd?”", intent: "zoning" };
    return { kind: "call", intent: "zoning", call: { tool: "lookup_zoning", args: { address: addr } } };
  }

  // Traffic closures (supporting info)
  if (/\b(closures?|closed lanes?|lane closures?|road closed)\b/.test(lower)) {
    const addr = extractAddress(t);
    return { kind: "call", intent: "closures", call: { tool: "find_traffic_closures", args: addr ? { address: addr } : {} } };
  }

  // 8 & 9. Road projects / construction
  if (/\b(road|street|roadway|traffic)\s*(projects?|work|construction|improvements?)\b|\bconstruction\b|\bcip\b|\bcapital (improvement )?projects?\b|\broadwork\b|\bwidening\b/.test(lower)) {
    const statuses = new Set<string>();
    if (/\b(construction|currently|now|active|under way|underway)\b/.test(lower)) statuses.add("Construction");
    if (/\b(planned|upcoming|future|design)\b/.test(lower)) ["Design", "Planning"].forEach((s) => statuses.add(s));
    if (/\b(completed|finished|done)\b/.test(lower)) statuses.add("Completed");
    const addr = extractPlace(t);
    const radius = extractRadius(t);
    if (addr) {
      return {
        kind: "call",
        intent: "road_projects_near",
        call: {
          tool: "find_road_projects_near",
          args: { address: addr, ...(radius ? { radius_miles: Math.min(radius, 5) } : {}), ...(statuses.size ? { statuses: [...statuses] } : {}) },
        },
      };
    }
    return { kind: "call", intent: "road_projects", call: { tool: "find_road_projects", args: { statuses: statuses.size ? [...statuses] : ["Construction"] } } };
  }

  const mentionsPark = /\bparks?\b|\bplaygrounds?\b|\bamenit(y|ies)\b/.test(lower);
  const amenities = extractAmenities(t);

  // 6 & 7. Trails (unless the question is about parks that have trails)
  if (!mentionsPark && /\b(trails?|loops?|paths?|hik(e|ing)|bike lanes?|greenbelt)\b/.test(lower)) {
    const addr = extractPlace(t);
    const radius = extractRadius(t);
    if (addr && !/\bloops?\b/.test(lower)) {
      return { kind: "call", intent: "trails_near", call: { tool: "find_nearby_trails", args: { address: addr, ...(radius ? { radius_miles: Math.min(radius, 5) } : {}) } } };
    }
    const type = TRAIL_TYPES.find((ty) => new RegExp(`\\b${ty.toLowerCase()}\\b`).test(lower));
    const args: Record<string, unknown> = {};
    if (/\b(walking )?loops?\b/.test(lower)) args.walking_loops_only = true;
    if (type && type !== "Bike Only") args.trail_type = type;
    if (/\bbike lanes?\b/.test(lower)) args.bike_lanes_only = true;
    if (Object.keys(args).length === 0) {
      if (addr) return { kind: "call", intent: "trails_near", call: { tool: "find_nearby_trails", args: { address: addr } } };
      return {
        kind: "reply",
        intent: "trails",
        text: "I can find trails near an address, or list walking loops and trail types (Regional, Parkway, Local, Nature). For example: “What trails are near 6101 Frisco Square Blvd?” or “Show me walking loops in Frisco.”",
      };
    }
    return { kind: "call", intent: "trail_search", call: { tool: "search_trails", args } };
  }

  // 4. Follow-up filter on the previous park list
  if (FOLLOW_UP_RE.test(lower) && ctx.lastParkIds?.length && (amenities.length || mentionsPark)) {
    if (!amenities.length) return { kind: "reply", intent: "park_follow_up", text: "Which amenity should I filter those parks by (for example playgrounds, restrooms, or a dog park)?" };
    const all = [...new Set([...(ctx.lastAmenities ?? []), ...amenities])].slice(0, 5);
    return {
      kind: "call",
      intent: "park_follow_up",
      call: { tool: "search_parks_by_amenity", args: { amenities: all, match: "all", restrict_to_park_ids: ctx.lastParkIds.slice(0, 100) } },
    };
  }

  // 1–3. Parks
  if (mentionsPark || amenities.length) {
    const addr = extractPlace(t);
    const radius = extractRadius(t);
    const amenArgs = amenities.length ? { amenities: amenities.slice(0, 5) } : {};
    if (addr && radius !== undefined) {
      return { kind: "call", intent: "parks_radius", call: { tool: "find_parks_within_radius", args: { address: addr, radius_miles: radius, ...amenArgs } } };
    }
    if (addr) {
      const many = /\bparks\b/.test(lower) && !/\b(closest|nearest)\s+park\b/.test(lower);
      return { kind: "call", intent: "parks_nearest", call: { tool: "find_nearest_parks", args: { address: addr, limit: many ? 5 : 3, ...amenArgs } } };
    }
    if (amenities.length) {
      return { kind: "call", intent: "parks_amenity", call: { tool: "search_parks_by_amenity", args: { amenities: amenities.slice(0, 5), match: "all" } } };
    }
    if (/\b(closest|nearest|near me|nearby)\b/.test(lower)) {
      return { kind: "reply", intent: "parks_nearest", text: "What address should I search from? For example: “What is the closest park to 6101 Frisco Square Blvd?”" };
    }
  }

  return {
    kind: "reply",
    intent: "unsupported",
    text: "I'm not sure how to answer that from Frisco's GIS data. " + HELP.slice(HELP.indexOf("Try")),
  };
}

// ---------------- formatting ----------------

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function list(rows: Row[], fmt: (r: Row) => string, max = 12): string {
  const lines = rows.slice(0, max).map((r) => `- ${fmt(r)}`);
  if (rows.length > max) lines.push(`- …and ${rows.length - max} more (see the map).`);
  return lines.join("\n");
}

export function formatResult(result: GisToolResult): string {
  if (!result.ok) {
    const sug = result.suggestions?.length ? `\n\n${result.suggestions.map((x) => `- ${x}`).join("\n")}` : "";
    return `${result.error?.message ?? "Something went wrong."}${sug}`;
  }
  const rows = result.results ?? [];
  let body = "";
  switch (result.tool) {
    case "find_nearest_parks":
    case "find_parks_within_radius":
      body = list(rows, (r) => `**${s(r.name)}** — ${s(r.distanceToBoundaryMiles)} mi to the park boundary${r.address ? ` (${s(r.address)})` : ""}`);
      break;
    case "search_parks_by_amenity":
      body = list(rows, (r) => `**${s(r.name)}**${r.address ? ` — ${s(r.address)}` : ""}`, 15);
      break;
    case "lookup_zoning": {
      const z = rows[0];
      if (z) {
        const parts = [
          `- **Zoning district:** ${s(z.zoningDistrict)}${z.cityZoningCategory ? ` (${s(z.cityZoningCategory)})` : ""}`,
          z.plannedDevelopment ? `- **Planned Development:** ${s(z.plannedDevelopment)}` : "",
          (z.ordinances as string[] | undefined)?.length ? `- **Ordinances:** ${(z.ordinances as string[]).join(", ")}` : "",
          z.specificUsePermit ? `- **Specific Use Permit:** ${s(z.specificUsePermit)}` : "",
          `- ${s(z.crossCheck)}`,
          ...((z.pendingZoningCases as Row[] | undefined) ?? []).map((c) => `- **Pending zoning case ${s(c.caseNumber)}:** ${s(c.description || c.name)} (${s(c.status)})`),
        ];
        body = parts.filter(Boolean).join("\n") + "\n\nThis is the zoning shown in the City's GIS data, not a legal determination of permitted uses. Contact the City of Frisco Planning Department to confirm.";
      }
      break;
    }
    case "find_nearby_trails":
      body = list(rows, (r) => `**${s(r.name)}** — ${s(r.distanceMiles)} mi away; ${(r.trailTypes as string[]).join("/")} trail${r.isWalkingLoop ? ", walking loop" : ""}`);
      break;
    case "search_trails":
      body = list(rows, (r) => `**${s(r.name)}** — about ${s(r.mappedLengthMiles)} mi mapped; ${(r.surfaces as string[]).join("/") || "surface not recorded"}`, 40);
      break;
    case "find_road_projects":
    case "find_road_projects_near":
      body = list(
        rows,
        (r) =>
          `**${s(r.name)}**${r.limits && r.limits !== r.name ? ` (${s(r.limits)})` : ""} — ${s(r.description) || s(r.subtype)}; status: ${s(r.status)}` +
          `${r.estimatedCompletion ? `; est. completion ${s(r.estimatedCompletion)}` : ""}${r.estimatedCompletionPassed && r.status === "Construction" ? " ⚠️ date has passed" : ""}` +
          `${r.distanceMiles !== undefined ? `; ${s(r.distanceMiles)} mi away` : ""}`,
        20,
      );
      break;
    case "find_traffic_closures":
      body = list(rows, (r) => `${s(r.description)}${r.timePeriod ? ` — ${s(r.timePeriod)}` : ""}`);
      break;
    case "lookup_school_district":
      body = result.limitations?.[0] ?? "";
      break;
    case "lookup_future_land_use":
      body = [
        ...rows.map((r) => (r.planDocument ? `- [${s(r.planYear)} Comprehensive Plan document](${s(r.planDocument)})` : "")).filter(Boolean),
        result.limitations?.[0] ?? "",
      ].join("\n\n");
      break;
    case "find_nearby_schools":
      body = list(rows, (r) => `**${s(r.name)}** — ${s(r.distanceMiles)} mi; ${[r.level, r.type, r.district].filter(Boolean).join(", ")}`, 12) + `\n\n${result.limitations?.[0] ?? ""}`;
      break;
    case "find_nearby_facilities":
      body = list(rows, (r) => `**${s(r.name)}** — ${s(r.distanceMiles)} mi${r.address ? ` (${s(r.address)})` : ""}`);
      break;
    case "search_gis_catalog":
      body = list(rows, (r) => `[${s(r.title)}](${s(r.itemPage)}) — ${s(r.type)}${r.lastModified ? `, updated ${s(r.lastModified)}` : ""}`, 10);
      break;
    case "get_map_image":
      body = rows[0] ? `[Open the map image](${s(rows[0].imageUrl)}) (temporary link).` : "";
      break;
    case "get_speed_limit": {
      const z = rows[0];
      const groups = (z?.speedLimitsByMph as Row[] | undefined) ?? [];
      if (groups.length > 1 || !result.needsClarification) {
        body = list(groups, (g) => `**${s(g.mph)} mph** — ${s(g.segmentCount)} segment(s)${g.addressRange ? `, addresses ${s(g.addressRange)}` : ""}; maintained by ${(g.owners as string[]).join(", ")}`);
      }
      const zones = (z?.schoolZones as Row[] | undefined) ?? [];
      if (zones.length) body += `\n\nSchool zones on this street: ${zones.map((x) => `${s(x.school)} (${s(x.mph)} mph, ${s(x.times)})`).join("; ")}.`;
      break;
    }
    default:
      body = "";
  }
  const clar = result.needsClarification && result.tool !== "get_speed_limit"
    ? `\n\n${result.needsClarification.reason} Options: ${result.needsClarification.options.join("; ")}.`
    : "";
  return [result.summary, body].filter(Boolean).join("\n\n") + clar;
}

function updateContext(ctx: OfflineContext, result: GisToolResult, call: PlannedCall): void {
  if (!result.ok) return;
  if (result.location?.matchedAddress) ctx.lastAddress = String(call.args.address ?? result.location.matchedAddress);
  if (["find_nearest_parks", "find_parks_within_radius", "search_parks_by_amenity"].includes(result.tool)) {
    const rows = result.results ?? [];
    ctx.lastParkIds = rows.map((r) => Number(r.parkId)).filter((n) => Number.isFinite(n));
    ctx.lastParkNames = rows.map((r) => String(r.name));
    ctx.lastAmenities = (call.args.amenities as string[] | undefined) ?? [];
  }
  if (result.tool === "get_speed_limit") ctx.lastStreet = String(call.args.street_name);
}

export async function runOfflineTurn(mcp: GisMcpClient, session: Session, text: string, note?: string): Promise<ChatTurnResult> {
  const plan = planOffline(text, session.offline);
  const collector = new TurnCollector();
  let reply: string;
  if (plan.kind === "reply") {
    reply = plan.text;
  } else {
    const started = Date.now();
    const result = await mcp.callTool(plan.call.tool, plan.call.args);
    collector.record(plan.call.tool, plan.call.args, result, Date.now() - started);
    updateContext(session.offline, result, plan.call);
    reply = formatResult(result);
  }
  session.turns++;
  return collector.finish(note ? `${note}\n\n${reply}` : reply, "offline");
}
