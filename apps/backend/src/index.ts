import { createApp } from "./app.js";
import { config } from "./config.js";
import { GisMcpClient } from "./mcp/client.js";

async function main() {
  const mcp = new GisMcpClient();
  try {
    const tools = await mcp.listTools();
    console.error(`[backend] MCP server connected over stdio; discovered ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    console.error("[backend] MCP server failed to start; will retry on first request.", (err as Error).message);
  }
  const app = createApp({ mcp });
  const server = app.listen(config.port, () => {
    console.error(`[backend] listening on http://localhost:${config.port} (assistant mode: ${config.mode}${config.mode === "ai" ? `, model ${config.claudeModel}` : ""})`);
    if (config.mode === "offline") {
      console.error("[backend] No ANTHROPIC_API_KEY set: running the offline planner. Set ANTHROPIC_API_KEY in .env to enable the AI assistant.");
    }
  });
  const shutdown = async () => {
    server.close();
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
