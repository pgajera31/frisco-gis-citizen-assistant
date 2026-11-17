import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MessagesApi } from "../src/assistant/claude.js";
import type { GisMcpClient, GisToolResult } from "../src/mcp/client.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** A fake MCP client used by MOCKED backend tests (no subprocess, no network). */
export class FakeMcp {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  connected = true;
  failWith?: Error;
  constructor(public handler: (name: string, args: Record<string, unknown>) => GisToolResult = defaultResult) {}
  async listTools(): Promise<Tool[]> {
    if (this.failWith) throw this.failWith;
    return [
      { name: "find_nearest_parks", description: "Nearest parks", inputSchema: { type: "object", properties: { address: { type: "string" } } } },
      { name: "search_parks_by_amenity", description: "Parks by amenity", inputSchema: { type: "object", properties: { amenities: { type: "array" } } } },
      { name: "get_speed_limit", description: "Speed limit", inputSchema: { type: "object", properties: { street_name: { type: "string" } } } },
    ];
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<GisToolResult> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ name, args });
    return this.handler(name, args);
  }
  async close() {}
  asClient(): GisMcpClient {
    return this as unknown as GisMcpClient;
  }
}

export function defaultResult(name: string): GisToolResult {
  return {
    ok: true,
    tool: name,
    summary: `${name} summary`,
    count: 1,
    results: [{ parkId: 7, name: "Test Park", distanceToBoundaryMiles: 0.1 }],
    method: "test method",
    limitations: ["test limitation"],
    sources: [{ layer: "Test Layer", url: "https://example.test/layer", publisher: "Test", retrievedAt: new Date().toISOString() }],
    map: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-96.8, 33.1] }, properties: { kind: "park", id: "park-7", label: "Test Park" } }] },
  };
}

/** Build a model response. */
export function msg(content: BetaMessage["content"], stop: BetaMessage["stop_reason"]): BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

export const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: "tool_use", id, name, input }) as unknown as BetaMessage["content"][number];
export const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as BetaMessage["content"][number];
export const thinking = () => ({ type: "thinking", thinking: "", signature: "sig" }) as unknown as BetaMessage["content"][number];

/** A scripted stand-in for the Claude Messages API that records every request. */
export class ScriptedModel implements MessagesApi {
  requests: CreateParams[] = [];
  constructor(private script: ((req: CreateParams, n: number) => BetaMessage | Promise<BetaMessage>)[]) {}
  async create(params: CreateParams): Promise<BetaMessage> {
    // Deep-copy so later mutations by the orchestrator don't change what we recorded.
    this.requests.push(JSON.parse(JSON.stringify(params)));
    const step = this.script[this.requests.length - 1];
    if (!step) throw new Error("Scripted model ran out of steps");
    return step(params, this.requests.length - 1);
  }
}
