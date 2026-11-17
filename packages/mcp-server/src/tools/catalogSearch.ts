import { getJson } from "../arcgis/client.js";
import { emptyMap, type ToolSuccess, UserFacingError } from "./common.js";

/** ArcGIS Online item types residents are likely to find useful. */
export const CATALOG_ITEM_TYPES = [
  "Web Map",
  "Feature Service",
  "Map Service",
  "Web Experience",
  "Web Mapping Application",
  "Dashboard",
  "StoryMap",
] as const;

/** The City's ArcGIS Online organisation account that owns its public items. */
const CITY_OWNER = "FriscoTexas";

/** Keep only characters that cannot change the meaning of the Lucene-style search query. */
export function sanitizeSearchText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 '&]/g, " ")
    .replace(/\b(AND|OR|NOT|TO)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

interface PortalItem {
  id: string;
  title: string;
  type: string;
  snippet?: string | null;
  owner: string;
  modified?: number;
  url?: string | null;
  access?: string;
}

/** Proposal tool "Search Portal Content": search the City's PUBLIC ArcGIS Online items. */
export async function searchGisCatalog(args: { query: string; itemTypes?: (typeof CATALOG_ITEM_TYPES)[number][]; limit?: number }): Promise<ToolSuccess> {
  const tool = "search_gis_catalog";
  const text = sanitizeSearchText(args.query);
  if (!text) throw new UserFacingError("QUERY_REQUIRED", "Please give a few words to search for, such as 'parks' or 'construction'.");
  const typeClause = args.itemTypes?.length ? ` AND (${args.itemTypes.map((t) => `type:"${t}"`).join(" OR ")})` : "";
  // Owner and access are fixed server-side: callers cannot search other organisations or private content.
  const q = `(${text}) AND owner:${CITY_OWNER} AND access:public${typeClause}`;
  const body = await getJson("https://www.arcgis.com/sharing/rest/search", {
    f: "json",
    q,
    num: String(Math.min(args.limit ?? 10, 20)),
    sortField: "modified",
    sortOrder: "desc",
  });
  const items = ((body.results as PortalItem[]) ?? []).filter((i) => i.owner === CITY_OWNER && (i.access ?? "public") === "public");
  const total = typeof body.total === "number" ? body.total : items.length;
  return {
    ok: true,
    tool,
    summary:
      items.length === 0
        ? `No public City of Frisco GIS items match "${text}".`
        : `${total} public City of Frisco GIS item${total === 1 ? "" : "s"} match "${text}"${total > items.length ? ` (showing the ${items.length} most recently updated)` : ""}.`,
    count: items.length,
    results: items.map((i) => ({
      title: i.title,
      type: i.type,
      description: i.snippet ?? null,
      lastModified: typeof i.modified === "number" ? new Date(i.modified).toISOString().slice(0, 10) : null,
      itemPage: `https://www.arcgis.com/home/item.html?id=${encodeURIComponent(i.id)}`,
      serviceOrAppUrl: i.url && /^https:\/\//i.test(i.url) ? i.url : null,
    })),
    method:
      `Searched ArcGIS Online for public items owned by the City's "${CITY_OWNER}" account matching the keywords` +
      (args.itemTypes?.length ? ` and item types ${args.itemTypes.join(", ")}` : "") +
      ", sorted by most recently modified.",
    limitations: [
      "Lists published maps, apps and services. It does not answer questions about the data inside them.",
      "Item descriptions are written by the City and may be brief or out of date.",
    ],
    sources: [
      {
        layer: "ArcGIS Online item search (owner: FriscoTexas, public items only)",
        url: "https://www.arcgis.com/sharing/rest/search",
        publisher: "Esri ArcGIS Online / City of Frisco",
        retrievedAt: new Date().toISOString(),
      },
    ],
    map: emptyMap(),
  };
}
