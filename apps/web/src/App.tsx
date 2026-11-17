import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getHealth, resetSession, sendChat } from "./api";
import AboutDialog from "./components/AboutDialog";
import Message from "./components/Message";
import type { ChatMessage, Health, MapCollection } from "./types";

const MapView = lazy(() => import("./components/MapView"));

export const SUGGESTIONS = [
  "What is the closest park to 6101 Frisco Square Blvd?",
  "Show me parks within 2 miles of 6101 Frisco Square Blvd.",
  "Which parks in Frisco have basketball courts?",
  "Which of those parks also have playgrounds?",
  "What is the zoning at 6101 Frisco Square Blvd?",
  "What trails are near 6101 Frisco Square Blvd?",
  "Show me walking loops in Frisco.",
  "What road projects are currently under construction in Frisco?",
  "Are there any road projects near 6101 Frisco Square Blvd?",
  "What's the speed limit on Preston Road?",
];

/** Questions beyond the 10 required use cases (use cases 11–14 and the proposal's tool catalog). */
export const MORE_SUGGESTIONS = [
  "Which school district is 6101 Frisco Square Blvd in?",
  "What is the future land use for 6101 Frisco Square Blvd?",
  "What schools are near 6101 Frisco Square Blvd?",
  "Where is the nearest fire station to 6101 Frisco Square Blvd?",
  "How many parks are within 1 mile of 6101 Frisco Square Blvd?",
  "What maps does the City publish about construction?",
];

const STORE_KEY = "frisco-gis-chat";

/** Session-scoped persistence (per browser tab). Storage can be unavailable; never let that break the app. */
function loadStored(): { sessionId?: string; messages: ChatMessage[] } {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { messages: [] };
}

function save(sessionId: string | undefined, messages: ChatMessage[]) {
  try {
    // Keep map geometry only for the latest answer to stay well under storage quotas.
    const slim = messages.map((m, i) =>
      m.response && i !== messages.length - 1 ? { ...m, response: { ...m.response, map: { type: "FeatureCollection" as const, features: [] } } } : m,
    );
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ sessionId, messages: slim }));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

let idCounter = 0;
const newId = () => `${Date.now()}-${idCounter++}`;

export default function App() {
  const stored = useRef(loadStored());
  const [sessionId, setSessionId] = useState<string | undefined>(stored.current.sessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(stored.current.messages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"chat" | "map">("chat");
  const [highContrast, setHighContrast] = useState(() => {
    try {
      return localStorage.getItem("frisco-gis-contrast") === "1";
    } catch {
      return false;
    }
  });
  const [aboutOpen, setAboutOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const latestMap: MapCollection | null =
    [...messages].reverse().find((m) => m.response && m.response.map.features.length > 0)?.response?.map ?? null;

  useEffect(() => {
    getHealth()
      .then((h) => setHealth(h))
      .catch(() => setHealthError(true));
  }, []);

  useEffect(() => {
    save(sessionId, messages);
  }, [sessionId, messages]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React must not receive as a cleanup.
    if (messages.length === 0 && !loading) return;
    void listEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);
  useEffect(() => {
    document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
    try {
      localStorage.setItem("frisco-gis-contrast", highContrast ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [highContrast]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || loading) return;
      setInput("");
      setSelectedId(null);
      setMessages((m) => [...m, { id: newId(), role: "user", text: q }]);
      setLoading(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await sendChat(q, sessionId, ac.signal);
        setSessionId(res.sessionId);
        setMessages((m) => [...m, { id: newId(), role: "assistant", text: res.reply, response: res }]);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setMessages((m) => [...m, { id: newId(), role: "error", text: "The question was cancelled." }]);
        } else {
          const msg = err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
          setMessages((m) => [...m, { id: newId(), role: "error", text: msg }]);
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [loading, sessionId],
  );

  const newConversation = () => {
    abortRef.current?.abort();
    if (sessionId) void resetSession(sessionId);
    setSessionId(undefined);
    setMessages([]);
    setSelectedId(null);
    inputRef.current?.focus();
  };

  const selectOnMap = (id: string) => {
    setSelectedId(id);
    setMobileView("map");
  };

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");

  return (
    <div className="app">
      <a className="skip-link" href="#question">
        Skip to the question box
      </a>
      <div className="prototype-banner" role="note">
        <strong>University capstone prototype.</strong> Not an official City of Frisco service.
        <span className="banner-more"> Answers come from public City GIS data and may be incomplete or out of date — confirm important details with the City.</span>
      </div>
      <header className="header">
        <div className="brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="currentColor" />
            <path d="M16 6c-4.4 0-8 3.4-8 7.7C8 19.5 16 27 16 27s8-7.5 8-13.3C24 9.4 20.4 6 16 6zm0 10.6a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8z" fill="#fff" />
          </svg>
          <div>
            <h1>Frisco GIS Citizen Assistant</h1>
            <p className="tagline">Ask about parks, zoning, schools, trails, road projects, speed limits and more in plain English.</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`mode-badge ${health?.mode ?? "unknown"}`} title={health?.model ?? undefined}>
            {healthError ? "Server offline" : health ? (health.mode === "ai" ? "AI assistant" : "Offline planner mode") : "Connecting…"}
          </span>
          <button type="button" className="btn-ghost" aria-pressed={highContrast} onClick={() => setHighContrast((v) => !v)}>
            High contrast
          </button>
          <button type="button" className="btn-ghost" onClick={() => setAboutOpen(true)}>
            About<span className="banner-more"> &amp; glossary</span>
          </button>
        </div>
      </header>

      {(healthError || (health && !health.mcp.connected)) && (
        <div className="status-banner" role="alert">
          The GIS lookup service is not available right now. Questions may fail until it reconnects.
        </div>
      )}

      <nav className="mobile-tabs" aria-label="Switch between chat and map">
        <button type="button" aria-pressed={mobileView === "chat"} onClick={() => setMobileView("chat")}>
          Chat
        </button>
        <button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}>
          Map{latestMap ? ` (${latestMap.features.length})` : ""}
        </button>
      </nav>

      <main className={`layout show-${mobileView}`}>
        <section className="chat-panel" aria-label="Conversation">
          <div className="chat-scroll">
            {messages.length === 0 && (
              <div className="welcome">
                <h2>What would you like to know?</h2>
                <p>Try one of these questions, or type your own with any Frisco address.</p>
                <ul className="suggestions" aria-label="Suggested questions">
                  {SUGGESTIONS.map((s) => (
                    <li key={s}>
                      <button type="button" className="suggestion" onClick={() => void ask(s)}>
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
                <details className="more-suggestions">
                  <summary>More questions you can ask</summary>
                  <ul className="suggestions" aria-label="More suggested questions">
                    {MORE_SUGGESTIONS.map((s) => (
                      <li key={s}>
                        <button type="button" className="suggestion" onClick={() => void ask(s)}>
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            <ol className="messages" aria-live="polite" aria-relevant="additions" aria-label="Messages">
              {messages.map((m, i) => (
                <Message
                  key={m.id}
                  message={m}
                  isLatest={i === lastAssistantIndex}
                  selectedId={selectedId}
                  sessionId={sessionId}
                  onSelect={selectOnMap}
                  onPrefill={(t) => {
                    setInput(t);
                    inputRef.current?.focus();
                  }}
                />
              ))}
            </ol>
            {loading && (
              <div className="loading" role="status">
                <span className="spinner" aria-hidden="true" /> Searching City of Frisco GIS data…
                <button type="button" className="btn-link" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              </div>
            )}
            <div ref={listEnd} />
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
          >
            <label htmlFor="question" className="sr-only">
              Your question about Frisco
            </label>
            <textarea
              id="question"
              ref={inputRef}
              value={input}
              maxLength={500}
              rows={2}
              placeholder="e.g. What is the closest park to 6101 Frisco Square Blvd?"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
              aria-describedby="composer-hint"
            />
            <div className="composer-row">
              <span id="composer-hint" className="hint">
                Enter to send · Shift+Enter for a new line · {500 - input.length} characters left
              </span>
              <div className="composer-buttons">
                {messages.length > 0 && (
                  <button type="button" className="btn-ghost" onClick={newConversation}>
                    New conversation
                  </button>
                )}
                <button type="submit" className="btn-primary" disabled={loading || !input.trim()}>
                  Ask
                </button>
              </div>
            </div>
          </form>
        </section>

        <section className="map-panel" aria-label="Map of results">
          <Suspense fallback={<div className="map-loading">Loading map…</div>}>
            <MapView data={latestMap} selectedId={selectedId} onSelect={setSelectedId} />
          </Suspense>
        </section>
      </main>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
