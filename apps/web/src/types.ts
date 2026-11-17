import type { Feature, FeatureCollection, Geometry } from "geojson";

export type MapKind =
  | "search-location"
  | "park"
  | "amenity"
  | "trail"
  | "zoning"
  | "parcel"
  | "proposed-zoning"
  | "road-project"
  | "traffic-closure"
  | "speed-segment"
  | "school-zone"
  | "search-area"
  | "school-district"
  | "future-land-use"
  | "school"
  | "facility";

export interface MapFeatureProps {
  kind: MapKind;
  id: string;
  label: string;
  details?: string[];
  styleValue?: string | number;
}

export type MapFeature = Feature<Geometry, MapFeatureProps>;
export type MapCollection = FeatureCollection<Geometry, MapFeatureProps>;

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

export interface ChatResponse {
  sessionId: string;
  reply: string;
  mode: "ai" | "offline";
  toolCalls: ToolCallTrace[];
  map: MapCollection;
  sources: SourceCitation[];
  methods: string[];
  limitations: string[];
  clarification?: { reason: string; options: string[] };
  tables?: { tool: string; rows: Record<string, unknown>[] }[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  response?: ChatResponse;
}

export interface Health {
  status: "ok" | "degraded";
  mode: "ai" | "offline";
  model: string | null;
  mcp: { connected: boolean; toolCount: number; transport: string };
}
