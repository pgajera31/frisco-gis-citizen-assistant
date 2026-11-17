/**
 * LIVE END-TO-END PIPELINE tests (run with LIVE_GIS=1):
 *
 *   HTTP API (supertest) → backend → GisMcpClient (official MCP SDK, stdio)
 *   → real MCP server subprocess → City of Frisco ArcGIS REST services
 *
 * Part 1 runs all 10 use cases in ONE session in offline-planner mode
 * (including the "which of those" follow-up).
 * Part 2 runs AI mode with a SCRIPTED model standing in for Claude (no API key
 * is available in CI), proving the AI orchestration path — tool selection →
 * MCP call → live GIS → tool_result → answer — works with real data.
 * Results are written to docs/test-results/backend-live-results.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { REPO_ROOT } from "../src/config.js";
import { GisMcpClient } from "../src/mcp/client.js";
import { msg, ScriptedModel, text, toolUse } from "./helpers.js";

const LIVE = process.env.LIVE_GIS === "1";
const A = "6101 Frisco Square Blvd";
const transcript: unknown[] = [];

describe.skipIf(!LIVE)("LIVE pipeline: API → MCP client → MCP server → ArcGIS", () => {
  let mcp: GisMcpClient;
  beforeAll(async () => {
    // Run the MCP server from TypeScript sources through tsx (no build needed for tests).
    mcp = new GisMcpClient(process.execPath, [
      path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts"),
    ]);
    await mcp.listTools();
  });
  afterAll(async () => {
    await mcp?.close();
    const out = path.join(REPO_ROOT, "docs", "test-results");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "backend-live-results.json"), JSON.stringify({ runAt: new Date().toISOString(), transcript }, null, 2));
  });

  it("health shows the MCP server connected with its discovered tools", async () => {
    const res = await request(createApp({ mcp, mode: "offline" })).get("/api/health");
    expect(res.body.mcp).toMatchObject({ connected: true, toolCount: 16, transport: "stdio" });
  });

  describe("Part 1 — offline planner mode, one conversation", () => {
    let app: ReturnType<typeof createApp>;
    let sessionId: string | undefined;
    beforeAll(() => {
      app = createApp({ mcp, mode: "offline", rateLimitPerMinute: 1000 });
    });
    const ask = async (id: string, message: string) => {
      const res = await request(app).post("/api/chat").send({ message, sessionId });
      expect(res.status).toBe(200);
      sessionId = res.body.sessionId;
      transcript.push({
        id,
        mode: res.body.mode,
        question: message,
        toolCalls: res.body.toolCalls.map((t: { tool: string; arguments: unknown; ok: boolean; durationMs: number }) => ({ tool: t.tool, arguments: t.arguments, ok: t.ok, durationMs: t.durationMs })),
        reply: res.body.reply,
        mapFeatures: res.body.map.features.length,
        sources: res.body.sources.map((s: { layer: string; lastEdited?: string }) => `${s.layer}${s.lastEdited ? ` (last edited ${s.lastEdited.slice(0, 10)})` : ""}`),
      });
      return res.body;
    };

    it("UC1", async () => {
      const b = await ask("UC1", `What is the closest park to ${A}?`);
      expect(b.toolCalls[0]).toMatchObject({ tool: "find_nearest_parks", ok: true });
      expect(b.map.features.length).toBeGreaterThan(1);
      expect(b.sources.length).toBeGreaterThan(0);
    });
    it("UC2", async () => {
      const b = await ask("UC2", `Show me parks within 2 miles of ${A}.`);
      expect(b.toolCalls[0]).toMatchObject({ tool: "find_parks_within_radius", ok: true });
      expect(b.toolCalls[0].arguments.radius_miles).toBe(2);
    });
    it("UC3", async () => {
      const b = await ask("UC3", "Which parks in Frisco have basketball courts?");
      expect(b.toolCalls[0]).toMatchObject({ tool: "search_parks_by_amenity", ok: true });
    });
    it("UC4 (follow-up uses the previous results)", async () => {
      const b = await ask("UC4", "Which of those parks also have playgrounds?");
      expect(b.toolCalls[0].tool).toBe("search_parks_by_amenity");
      expect(b.toolCalls[0].arguments.restrict_to_park_ids.length).toBeGreaterThan(5);
      expect(b.toolCalls[0].arguments.amenities).toEqual(["Basketball", "Playground"]);
      expect(b.reply).toMatch(/previous results/);
    });
    it("UC5", async () => {
      const b = await ask("UC5", `What is the zoning at ${A}?`);
      expect(b.toolCalls[0]).toMatchObject({ tool: "lookup_zoning", ok: true });
      expect(b.reply).toMatch(/zoning district/i);
      expect(b.reply).toMatch(/not a legal determination/);
    });
    it("UC6", async () => {
      const b = await ask("UC6", `What trails are near ${A}?`);
      expect(b.toolCalls[0]).toMatchObject({ tool: "find_nearby_trails", ok: true });
    });
    it("UC7", async () => {
      const b = await ask("UC7", "Show me walking loops in Frisco.");
      expect(b.toolCalls[0]).toMatchObject({ tool: "search_trails", ok: true });
    });
    it("UC8", async () => {
      const b = await ask("UC8", "What road projects are currently under construction in Frisco?");
      expect(b.toolCalls[0]).toMatchObject({ tool: "find_road_projects", ok: true });
    });
    it("UC9", async () => {
      const b = await ask("UC9", `Are there any road projects near ${A}?`);
      expect(b.toolCalls[0]).toMatchObject({ tool: "find_road_projects_near", ok: true });
    });
    it("UC10", async () => {
      const b = await ask("UC10", "What's the speed limit on Preston Road?");
      expect(b.toolCalls[0]).toMatchObject({ tool: "get_speed_limit", ok: true });
      expect(b.clarification?.options.length).toBeGreaterThan(1);
    });
    it("PNG map image of the latest answer (via MCP get_map_image → Esri print service)", async () => {
      await ask("IMG", "What is the closest park to 6101 Frisco Square Blvd?");
      const res = await request(app)
        .post("/api/map-image")
        .send({ sessionId })
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect((res.body as Buffer).subarray(1, 4).toString()).toBe("PNG");
      expect((res.body as Buffer).length).toBeGreaterThan(50_000);
    });
    it("NEG invalid address", async () => {
      const b = await ask("NEG1", "What is the zoning at 99999 Nonexistent Imaginary Ln?");
      expect(b.toolCalls[0].ok).toBe(false);
      expect(b.reply).toMatch(/couldn't find/);
    });
  });

  describe("Part 2 — AI mode with a scripted model through the real MCP server and live GIS", () => {
    it("UC1 then UC4-style follow-up: model-selected tools run against live data", async () => {
      let parkIds: number[] = [];
      const model = new ScriptedModel([
        // Turn 1: the 'model' asks for amenity search.
        () => msg([toolUse("t1", "search_parks_by_amenity", { amenities: ["Basketball"] })], "tool_use"),
        (req) => {
          // The real tool_result from live GIS arrives here; extract park ids like Claude would.
          const block = (req.messages.at(-1)!.content as { content: string }[])[0];
          const data = JSON.parse(block.content);
          parkIds = data.results.map((r: { parkId: number }) => r.parkId);
          return msg([text(`${data.count} parks have basketball courts.`)], "end_turn");
        },
        // Turn 2: follow-up restricted to the previous ids.
        () => msg([toolUse("t2", "search_parks_by_amenity", { amenities: ["Basketball", "Playground"], match: "all", restrict_to_park_ids: parkIds })], "tool_use"),
        (req) => {
          const data = JSON.parse((req.messages.at(-1)!.content as { content: string }[])[0].content);
          return msg([text(`${data.count} of those also have playgrounds.`)], "end_turn");
        },
      ]);
      const app = createApp({ mcp, mode: "ai", messagesApi: model, rateLimitPerMinute: 1000 });
      const r1 = await request(app).post("/api/chat").send({ message: "Which parks in Frisco have basketball courts?" });
      expect(r1.body.mode).toBe("ai");
      expect(r1.body.toolCalls[0]).toMatchObject({ tool: "search_parks_by_amenity", ok: true });
      expect(parkIds.length).toBeGreaterThan(5);
      const r2 = await request(app).post("/api/chat").send({ message: "Which of those also have playgrounds?", sessionId: r1.body.sessionId });
      expect(r2.body.toolCalls[0].arguments.restrict_to_park_ids).toEqual(parkIds);
      expect(r2.body.reply).toMatch(/^\d+ of those also have playgrounds\.$/);
      expect(r2.body.map.features.length).toBeGreaterThan(0);
      transcript.push({ id: "AI-scripted", mode: "ai (scripted model)", replies: [r1.body.reply, r2.body.reply], tools: [r1.body.toolCalls, r2.body.toolCalls] });
    });
  });
});
