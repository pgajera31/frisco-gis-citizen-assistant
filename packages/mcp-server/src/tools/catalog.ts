import { getLayerMetadata } from "../arcgis/client.js";
import { LAYERS, type LayerKey } from "../arcgis/layers.js";
import { emptyMap, type ToolSuccess, UserFacingError } from "./common.js";

/** Lists every approved data layer and, optionally, live metadata for one. */
export async function describeDataSources(args: { layerKey?: string }): Promise<ToolSuccess> {
  const tool = "describe_data_sources";
  if (args.layerKey) {
    if (!(args.layerKey in LAYERS)) {
      throw new UserFacingError("UNKNOWN_LAYER", `Unknown layer key. Valid keys: ${Object.keys(LAYERS).join(", ")}.`);
    }
    const key = args.layerKey as LayerKey;
    const def = LAYERS[key];
    const meta = await getLayerMetadata(key);
    return {
      ok: true,
      tool,
      summary: `${def.title}: ${meta.geometryType ?? "table"} layer with ${meta.fields.length} fields${meta.lastEditDate ? `, last edited ${meta.lastEditDate.slice(0, 10)}` : ""}.`,
      count: 1,
      results: [{ key, title: def.title, url: def.url, publisher: def.publisher, notes: def.notes, ...meta }],
      method: "Read live from the layer's ArcGIS REST metadata endpoint.",
      limitations: [],
      sources: [{ layer: def.title, url: def.url, publisher: def.publisher, lastEdited: meta.lastEditDate, retrievedAt: new Date().toISOString() }],
      map: emptyMap(),
    };
  }
  const rows = Object.values(LAYERS).map((d) => ({ key: d.key, title: d.title, url: d.url, publisher: d.publisher, geometry: d.geometry, notes: d.notes }));
  return {
    ok: true,
    tool,
    summary: `This assistant uses ${rows.length} approved, public, read-only GIS layers.`,
    count: rows.length,
    results: rows,
    method: "Static registry of approved layers (see docs/GIS_DATA_INVENTORY.md).",
    limitations: [],
    sources: [],
    map: emptyMap(),
  };
}
