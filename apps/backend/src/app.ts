import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { AiUnavailableError, ClaudeAssistant, type MessagesApi } from "./assistant/claude.js";
import { runOfflineTurn } from "./assistant/offline.js";
import { type AssistantMode, config } from "./config.js";
import { type GisMcpClient, McpUnavailableError } from "./mcp/client.js";
import { deleteSession, getOrCreateSession, sessionCount } from "./sessions.js";

export interface AppOptions {
  mcp: GisMcpClient;
  mode?: AssistantMode;
  /** Inject a scripted model for tests. */
  messagesApi?: MessagesApi;
  rateLimitPerMinute?: number;
}

const ChatBody = z.object({
  sessionId: z.string().max(64).optional(),
  message: z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(1, "Please type a question.").max(config.maxMessageChars, `Please keep questions under ${config.maxMessageChars} characters.`)),
});

export function createApp(opts: AppOptions) {
  const mode = opts.mode ?? config.mode;
  const claude = mode === "ai" ? new ClaudeAssistant(opts.mcp, opts.messagesApi) : undefined;
  const busy = new Set<string>();
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https://server.arcgisonline.com", "https://services.arcgisonline.com", "https://*.tile.openstreetmap.org"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: "10kb" }));

  // CORS only for the configured dev origins (the production build is same-origin).
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  const chatLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.rateLimitPerMinute ?? config.rateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many questions in a short time. Please wait a minute and try again." } },
  });

  app.get("/api/health", async (_req, res) => {
    let toolCount = 0;
    try {
      toolCount = (await opts.mcp.listTools()).length;
    } catch {
      toolCount = 0;
    }
    res.json({
      status: opts.mcp.connected ? "ok" : "degraded",
      mode,
      model: mode === "ai" ? config.claudeModel : null,
      mcp: { connected: opts.mcp.connected, toolCount, transport: "stdio" },
      sessions: sessionCount(),
    });
  });

  app.get("/api/tools", async (_req, res) => {
    try {
      const tools = await opts.mcp.listTools();
      res.json({ tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description })) });
    } catch {
      res.status(503).json({ error: { code: "MCP_UNAVAILABLE", message: "The GIS tool server is unavailable." } });
    }
  });

  app.post("/api/chat", chatLimiter, async (req: Request, res: Response) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
    }
    const session = getOrCreateSession(parsed.data.sessionId);
    if (busy.has(session.id)) {
      return void res.status(409).json({ error: { code: "BUSY", message: "Still working on your previous question." } });
    }
    busy.add(session.id);
    const started = Date.now();
    try {
      let result;
      if (claude) {
        try {
          result = await claude.runTurn(session, parsed.data.message);
        } catch (err) {
          if (!(err instanceof AiUnavailableError)) throw err;
          console.error(`[chat] AI unavailable (${err.reason}); using offline planner`);
          result = await runOfflineTurn(
            opts.mcp,
            session,
            parsed.data.message,
            "_The AI service is unavailable right now, so this answer comes from the basic offline planner._",
          );
        }
      } else {
        result = await runOfflineTurn(opts.mcp, session, parsed.data.message);
      }
      console.error(JSON.stringify({ evt: "chat", mode: result.mode, ms: Date.now() - started, tools: result.toolCalls.map((t) => `${t.tool}:${t.ok ? "ok" : t.errorCode}`), chars: parsed.data.message.length }));
      res.json({ sessionId: session.id, ...result });
    } catch (err) {
      if (err instanceof McpUnavailableError) {
        return void res.status(503).json({ sessionId: session.id, error: { code: "MCP_UNAVAILABLE", message: "The GIS lookup service is temporarily unavailable. Please try again shortly." } });
      }
      console.error("[chat] unexpected error", err);
      res.status(500).json({ sessionId: session.id, error: { code: "INTERNAL", message: "Something went wrong while answering. Please try again." } });
    } finally {
      busy.delete(session.id);
    }
  });

  app.delete("/api/session/:id", (req, res) => {
    deleteSession(String(req.params.id));
    res.status(204).end();
  });

  app.use("/api", (_req, res) => void res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown API route." } }));

  // Serve the built web app (production / preview).
  if (existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(config.webDist, "index.html")));
  }

  // Final error handler: never leak stack traces.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error("[http] error", err);
    res.status(status).json({ error: { code: status === 400 ? "INVALID_INPUT" : "INTERNAL", message: status === 400 ? "Malformed request." : "Unexpected server error." } });
  });

  return app;
}
