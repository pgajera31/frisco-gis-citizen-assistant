import Anthropic from "@anthropic-ai/sdk";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import type { GisMcpClient } from "../mcp/client.js";
import type { Session } from "../sessions.js";
import { buildSystemPrompt } from "./prompt.js";
import { type ChatTurnResult, compactForModel, TurnCollector } from "./types.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Minimal surface of the Anthropic client we use; lets tests inject a scripted model. */
export interface MessagesApi {
  create(params: CreateParams): Promise<BetaMessage>;
}

export class AiUnavailableError extends Error {
  constructor(public readonly reason: "auth" | "rate_limit" | "connection" | "server" | "refusal" | "other", message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** Convert MCP tool definitions (from tools/list) into Claude tool definitions. Sorted for a stable prefix. */
export function mcpToolsToClaude(tools: McpTool[]): BetaTool[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: [t.title, t.description].filter(Boolean).join(" — ").slice(0, 1000),
      input_schema: t.inputSchema as BetaTool["input_schema"],
    }));
}

const HISTORY_SOFT_LIMIT = 40;
const HISTORY_KEEP = 24;

function stripThinking(messages: BetaMessageParam[]): BetaMessageParam[] {
  return messages.map((m): BetaMessageParam => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    // Thinking blocks only appear in assistant turns.
    return { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") };
  });
}

/** A user message that starts a turn (plain text, not a tool_result reply). */
function isTurnStart(m: BetaMessageParam): boolean {
  return m.role === "user" && (typeof m.content === "string" || m.content.every((b) => b.type === "text"));
}

/**
 * Keep long sessions bounded without editing the middle of the history:
 * strip ALL thinking blocks (allowed), then drop the oldest whole turns.
 */
export function trimHistory(history: BetaMessageParam[]): BetaMessageParam[] {
  if (history.length <= HISTORY_SOFT_LIMIT) return history;
  const stripped = stripThinking(history);
  let start = stripped.length - HISTORY_KEEP;
  while (start < stripped.length && !isTurnStart(stripped[start])) start++;
  return stripped.slice(start);
}

function textOf(msg: BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function classify(err: unknown): AiUnavailableError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiUnavailableError("auth", "The AI provider rejected the configured credentials.");
  }
  if (err instanceof Anthropic.RateLimitError) return new AiUnavailableError("rate_limit", "The AI provider is rate-limiting requests.");
  if (err instanceof Anthropic.APIConnectionError) return new AiUnavailableError("connection", "The AI provider could not be reached.");
  if (err instanceof Anthropic.InternalServerError) return new AiUnavailableError("server", "The AI provider had a temporary error.");
  return new AiUnavailableError("other", "The AI provider returned an error.");
}

export class ClaudeAssistant {
  private readonly api: MessagesApi;

  constructor(private readonly mcp: GisMcpClient, api?: MessagesApi) {
    this.api = api ?? new Anthropic({ maxRetries: 2, timeout: 120_000 }).beta.messages;
  }

  private request(system: string, tools: BetaTool[], messages: BetaMessageParam[], noTools = false): CreateParams {
    return {
      model: config.claudeModel,
      max_tokens: 16_000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      ...(noTools ? { tool_choice: { type: "none" as const } } : {}),
      messages,
      output_config: { effort: config.claudeEffort },
      // Server-side fallback when a safety classifier declines (routes by refusal category).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  }

  private async create(params: CreateParams): Promise<BetaMessage> {
    try {
      return await this.api.create(params);
    } catch (err) {
      // History-editing check: strip thinking blocks once and retry (one-time recovery).
      if (err instanceof Anthropic.BadRequestError && /signature|thinking/i.test(err.message)) {
        return this.api.create({ ...params, messages: stripThinking(params.messages) });
      }
      throw classify(err);
    }
  }

  /** Run one user turn: model ↔ MCP tool loop until the model produces an answer. */
  async runTurn(session: Session, userText: string): Promise<ChatTurnResult> {
    session.systemPrompt ??= buildSystemPrompt(new Date().toISOString().slice(0, 10));
    const tools = mcpToolsToClaude(await this.mcp.listTools());
    const collector = new TurnCollector();

    // Work on a copy; commit to the session only when the turn completes.
    const messages: BetaMessageParam[] = [...trimHistory(session.history), { role: "user", content: userText }];
    let reply = "";

    for (let round = 0; ; round++) {
      const outOfRounds = round >= config.maxToolRounds;
      const resp = await this.create(this.request(session.systemPrompt, tools, messages, outOfRounds));

      if (resp.stop_reason === "refusal") {
        reply = "I'm not able to help with that request. I can answer questions about Frisco parks, zoning, trails, road projects, and speed limits.";
        messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
        break;
      }
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason === "pause_turn") continue;

      const toolUses = resp.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (resp.stop_reason === "tool_use" && toolUses.length && !outOfRounds) {
        // Execute all requested tools concurrently, then return every result in one user message.
        const results: BetaToolResultBlockParam[] = await Promise.all(
          toolUses.map(async (tu) => {
            const args = (tu.input && typeof tu.input === "object" ? tu.input : {}) as Record<string, unknown>;
            const started = Date.now();
            const result = await this.mcp.callTool(tu.name, args);
            collector.record(tu.name, args, result, Date.now() - started);
            return { type: "tool_result" as const, tool_use_id: tu.id, content: compactForModel(result), is_error: !result.ok };
          }),
        );
        messages.push({ role: "user", content: results });
        continue;
      }

      if (toolUses.length) {
        // Never leave a tool_use without its tool_result in the stored history.
        messages.push({
          role: "user",
          content: toolUses.map((tu) => ({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: "Not executed: the tool-call limit for this question was reached.",
            is_error: true,
          })),
        });
      }
      reply = textOf(resp);
      if (resp.stop_reason === "max_tokens") reply += "\n\n_(The answer was cut off. Please ask a narrower question.)_";
      if (!reply) reply = "I wasn't able to put together an answer from the GIS data. Could you rephrase the question?";
      break;
    }

    session.history = messages;
    session.turns++;
    return collector.finish(reply, "ai");
  }
}
