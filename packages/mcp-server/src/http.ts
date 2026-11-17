/**
 * Optional Streamable HTTP transport (stateless). Each POST /mcp gets a fresh
 * server + transport, which is the SDK's recommended stateless pattern.
 * Binds to 127.0.0.1 by default, with the SDK's DNS-rebinding protection.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { createServer, SERVER_NAME } from "./server.js";

export async function startHttp(): Promise<void> {
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MCP_HTTP_PORT ?? 8788);
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP HTTP error", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true, server: SERVER_NAME }));

  await new Promise<void>((resolve) => app.listen(port, host, () => resolve()));
  console.error(`${SERVER_NAME} listening on http://${host}:${port}/mcp`);
}
