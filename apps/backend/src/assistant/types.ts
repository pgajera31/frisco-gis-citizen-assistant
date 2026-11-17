import type { GisToolResult } from "../mcp/client.js";

export interface ToolCallTrace {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  summary?: string;
  errorCode?: string;
}

export interface SourceCitation {
  layer: string;
  url: string;
  publisher: string;
  lastEdited?: string;
  retrievedAt: string;
}

export interface ChatTurnResult {
  reply: string;
  mode: "ai" | "offline";
  toolCalls: ToolCallTrace[];
  /** GeoJSON returned by the tools in this turn, for the map. */
  map: { type: "FeatureCollection"; features: unknown[] };
  sources: SourceCitation[];
  /** "How this was derived" notes from each successful tool. */
  methods: string[];
  limitations: string[];
  clarification?: { reason: string; options: string[] };
  /** Tabular results per successful tool call (for CSV export in the UI). */
  tables: { tool: string; rows: Record<string, unknown>[] }[];
}

/** Accumulates tool results over one user turn. */
export class TurnCollector {
  readonly toolCalls: ToolCallTrace[] = [];
  readonly results: GisToolResult[] = [];

  record(tool: string, args: Record<string, unknown>, result: GisToolResult, durationMs: number): void {
    this.results.push(result);
    this.toolCalls.push({
      tool,
      arguments: args,
      ok: result.ok,
      durationMs,
      summary: result.ok ? result.summary : result.error?.message,
      errorCode: result.ok ? undefined : result.error?.code,
    });
  }

  finish(reply: string, mode: "ai" | "offline"): ChatTurnResult {
    const ok = this.results.filter((r) => r.ok);
    const features = ok.flatMap((r) => r.map?.features ?? []);
    // De-duplicate features by kind+id (e.g. the search location from several tools).
    const seen = new Set<string>();
    const unique = features.filter((f) => {
      const p = (f as { properties?: { kind?: string; id?: string } }).properties;
      const key = `${p?.kind}|${p?.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const sourceMap = new Map<string, SourceCitation>();
    for (const r of ok) {
      for (const s of r.sources ?? []) {
        if (s.url && !sourceMap.has(s.url)) {
          sourceMap.set(s.url, { layer: s.layer, url: s.url, publisher: s.publisher, lastEdited: s.lastEdited, retrievedAt: s.retrievedAt });
        }
      }
    }
    const clarification = ok.map((r) => r.needsClarification).find(Boolean);
    return {
      reply,
      mode,
      toolCalls: this.toolCalls,
      map: { type: "FeatureCollection", features: unique },
      sources: [...sourceMap.values()],
      methods: [...new Set(ok.map((r) => r.method).filter((m): m is string => Boolean(m)))],
      limitations: [...new Set(ok.flatMap((r) => r.limitations ?? []))],
      ...(clarification ? { clarification } : {}),
      tables: ok.filter((r) => (r.results ?? []).length > 0).map((r) => ({ tool: r.tool, rows: (r.results ?? []).slice(0, 500) })),
    };
  }
}

/**
 * Compact representation of a tool result for the language model: no map
 * geometry, results capped, long strings trimmed. Keeps token use bounded.
 */
export function compactForModel(result: GisToolResult): string {
  if (!result.ok) return JSON.stringify({ ok: false, error: result.error, suggestions: result.suggestions });
  const { map, results, sources, ...rest } = result;
  const trimmed = (results ?? []).slice(0, 25).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v])),
  );
  return JSON.stringify({
    ...rest,
    results: trimmed,
    ...(results && results.length > 25 ? { resultsOmitted: results.length - 25 } : {}),
    sources: (sources ?? []).map((s) => ({ layer: s.layer, lastEdited: s.lastEdited })),
    mapFeatureCount: map?.features.length ?? 0,
  });
}
