#!/usr/bin/env node
/**
 * Entry point for the Frisco GIS MCP server.
 *
 *   node dist/index.js            → stdio transport (used by the backend and by desktop MCP clients)
 *   node dist/index.js --http     → Streamable HTTP transport on MCP_HTTP_PORT (default 8788), path /mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main() {
  if (process.argv.includes("--http")) {
    const { startHttp } = await import("./http.js");
    await startHttp();
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error("Fatal MCP server error", err);
  process.exit(1);
});
