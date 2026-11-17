import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";

/** Structured result a GIS tool returns (mirrors ToolResult in the MCP server). */
export interface GisToolResult {
  ok: boolean;
  tool: string;
  summary?: string;
  location?: { matchedAddress: string; lat: number; lon: number; source: string; inFriscoCityLimits: boolean | null };
  count?: number;
  results?: Record<string, unknown>[];
  needsClarification?: { reason: string; options: string[] };
  method?: string;
  limitations?: string[];
  sources?: { layer: string; url: string; publisher: string; lastEdited?: string; retrievedAt: string; notes?: string }[];
  map?: { type: "FeatureCollection"; features: unknown[] };
  error?: { code: string; message: string };
  suggestions?: string[];
  /** Image content returned alongside the structured result (get_map_image). */
  image?: { data: string; mimeType: string };
}

/**
 * Environment variables forwarded to the MCP server process. The default MCP
 * environment is minimal (PATH, HOME…); we add only GIS settings and network
 * proxy settings. Secrets such as ANTHROPIC_API_KEY are deliberately NOT passed.
 */
const FORWARDED_ENV = [
  /^ARCGIS_/, /^GIS_/, /^ENABLE_(ESRI|CENSUS)_GEOCODER$/, /^(HTTPS?|NO)_PROXY$/i, /^NODE_USE_ENV_PROXY$/, /^NODE_EXTRA_CA_CERTS$/,
];

function serverEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && FORWARDED_ENV.some((re) => re.test(k))) env[k] = v;
  }
  return env;
}

export class McpUnavailableError extends Error {
  constructor(message = "The GIS tool server is unavailable.") {
    super(message);
    this.name = "McpUnavailableError";
  }
}

/**
 * Thin wrapper over the official MCP SDK Client using the stdio transport.
 * Reconnects lazily if the server process exits.
 */
export class GisMcpClient {
  private client?: Client;
  private connecting?: Promise<Client>;
  private tools: Tool[] = [];
  public lastError?: string;

  constructor(private readonly command = config.mcp.command, private readonly args = config.mcp.args) {}

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        env: serverEnv(),
        stderr: "inherit", // MCP server logs (one JSON line per tool call) appear in the backend log
      });
      const client = new Client({ name: "frisco-gis-backend", version: "0.1.0" });
      transport.onclose = () => {
        this.client = undefined;
        this.tools = [];
      };
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        this.tools = listed.tools;
        this.client = client;
        this.lastError = undefined;
        return client;
      } catch (err) {
        this.lastError = (err as Error).message;
        await transport.close().catch(() => undefined);
        throw new McpUnavailableError();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Tools discovered from the server via tools/list. */
  async listTools(): Promise<Tool[]> {
    await this.connect();
    return this.tools;
  }

  get connected(): boolean {
    return Boolean(this.client);
  }

  /** Invoke a tool and return its structured result. Never throws for tool-level errors. */
  async callTool(name: string, args: Record<string, unknown>): Promise<GisToolResult> {
    const client = await this.connect();
    if (!this.tools.some((t) => t.name === name)) {
      return { ok: false, tool: name, error: { code: "UNKNOWN_TOOL", message: `There is no GIS tool named ${name}.` } };
    }
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: config.mcpCallTimeoutMs });
      const structured = res.structuredContent as GisToolResult | undefined;
      if (structured && typeof structured.ok === "boolean") {
        const img = Array.isArray(res.content)
          ? (res.content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === "image" && c.data && c.mimeType)
          : undefined;
        return img ? { ...structured, image: { data: img.data!, mimeType: img.mimeType! } } : structured;
      }
      // Input-validation failures from the SDK come back as isError text content without structuredContent.
      const text = Array.isArray(res.content)
        ? res.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join(" ")
        : "";
      return {
        ok: false,
        tool: name,
        error: { code: res.isError ? "INVALID_ARGUMENTS" : "BAD_TOOL_RESPONSE", message: text.slice(0, 500) || "The tool returned no result." },
      };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/closed|not connected|EPIPE/i.test(msg)) {
        this.client = undefined;
        throw new McpUnavailableError();
      }
      return { ok: false, tool: name, error: { code: "TOOL_CALL_FAILED", message: /timed? ?out/i.test(msg) ? "The GIS lookup timed out." : "The GIS lookup failed." } };
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}
