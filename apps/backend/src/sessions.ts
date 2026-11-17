import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/** Context the offline planner keeps for follow-up questions ("which of those…"). */
export interface OfflineContext {
  lastParkIds?: number[];
  lastParkNames?: string[];
  lastAmenities?: string[];
  lastAddress?: string;
  lastStreet?: string;
}

export interface Session {
  id: string;
  createdAt: number;
  lastActive: number;
  /** System prompt fixed at session start (kept byte-stable for prompt caching / thinking-block validity). */
  systemPrompt?: string;
  /** Append-only Claude conversation history (AI mode). */
  history: Anthropic.Beta.Messages.BetaMessageParam[];
  offline: OfflineContext;
  turns: number;
  /** GeoJSON of the latest answer (used to render a downloadable map image). */
  lastMap?: { type: "FeatureCollection"; features: unknown[] };
}

const MAX_SESSIONS = 2000;
const sessions = new Map<string, Session>();

/** Session ids are random UUIDs issued by the server; anything else is rejected. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function evictExpired(now = Date.now()): void {
  const ttl = config.sessionTtlMinutes * 60_000;
  for (const [id, s] of sessions) if (now - s.lastActive > ttl) sessions.delete(id);
  // Bound memory: drop the least recently active sessions if over the cap.
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastActive - b.lastActive).slice(0, sessions.size - MAX_SESSIONS);
    for (const s of oldest) sessions.delete(s.id);
  }
}

/** Returns the existing session for a valid id, or a new one. Sessions hold no personal data beyond the chat itself. */
export function getOrCreateSession(id?: string): Session {
  evictExpired();
  if (id && UUID_RE.test(id)) {
    const existing = sessions.get(id);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }
  }
  const s: Session = { id: randomUUID(), createdAt: Date.now(), lastActive: Date.now(), history: [], offline: {}, turns: 0 };
  sessions.set(s.id, s);
  return s;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

export function sessionCount(): number {
  return sessions.size;
}
