import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (apps/backend/{src,dist} → ../../..). */
export const REPO_ROOT = path.resolve(here, "..", "..", "..");

// Load the repository-level .env if present (never committed).
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type AssistantMode = "ai" | "offline";

function resolveMode(): AssistantMode {
  const requested = (process.env.ASSISTANT_MODE ?? "auto").toLowerCase();
  if (requested === "offline") return "offline";
  if (requested === "ai") return "ai";
  return process.env.ANTHROPIC_API_KEY ? "ai" : "offline";
}

function defaultMcpCommand(): { command: string; args: string[] } {
  if (process.env.MCP_SERVER_COMMAND) {
    return {
      command: process.env.MCP_SERVER_COMMAND,
      args: (process.env.MCP_SERVER_ARGS ?? "").split(" ").filter(Boolean),
    };
  }
  const built = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "index.js");
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  // Fall back to running TypeScript sources through tsx (development).
  const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return { command: process.execPath, args: [tsx, path.join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts")] };
}

export const config = {
  port: int("PORT", 8787),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", 30),
  sessionTtlMinutes: int("SESSION_TTL_MINUTES", 30),
  maxMessageChars: 500,
  mode: resolveMode(),
  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  claudeEffort: (process.env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  /** Upper bound on model ↔ tool round trips for one user message. */
  maxToolRounds: int("MAX_TOOL_ROUNDS", 6),
  mcp: defaultMcpCommand(),
  mcpCallTimeoutMs: int("MCP_CALL_TIMEOUT_MS", 60_000),
  webDist: path.join(REPO_ROOT, "apps", "web", "dist"),
};
