import { useState } from "react";
import Markdown from "react-markdown";
import { ApiError, downloadMapImage, saveBlob } from "../api";
import { hasTables, responseToCsv } from "../csv";
import type { ChatMessage, MapFeature } from "../types";

const TOOL_NAMES: Record<string, string> = {
  geocode_address: "Address lookup",
  find_nearest_parks: "Nearest parks",
  find_parks_within_radius: "Parks within a distance",
  search_parks_by_amenity: "Parks by amenity",
  get_park_details: "Park details",
  lookup_zoning: "Zoning lookup",
  find_nearby_trails: "Nearby trails",
  search_trails: "Trail search",
  find_road_projects: "Road projects",
  find_road_projects_near: "Road projects near an address",
  find_traffic_closures: "Traffic closures",
  get_speed_limit: "Speed limit lookup",
  search_gis_catalog: "City GIS catalog search",
  count_features_within_radius: "Count within a distance",
  get_map_image: "Map image rendering",
  describe_data_sources: "Data source catalog",
};

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface Props {
  message: ChatMessage;
  isLatest: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPrefill: (q: string) => void;
  sessionId?: string;
}

function Downloads({ message, isLatest, sessionId }: { message: ChatMessage; isLatest: boolean; sessionId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = message.response!;
  const stamp = new Date().toISOString().slice(0, 10);
  const canCsv = hasTables(r);
  const canPng = isLatest && Boolean(sessionId) && r.map.features.length > 0;
  if (!canCsv && !canPng) return null;
  return (
    <div className="downloads" role="group" aria-label="Download this answer">
      {canCsv && (
        <button
          type="button"
          className="btn-ghost btn-small"
          onClick={() => saveBlob(new Blob([responseToCsv(r)], { type: "text/csv;charset=utf-8" }), `frisco-gis-results-${stamp}.csv`)}
        >
          Download results (CSV)
        </button>
      )}
      {canPng && (
        <button
          type="button"
          className="btn-ghost btn-small"
          disabled={busy}
          aria-busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              saveBlob(await downloadMapImage(sessionId!), `frisco-gis-map-${stamp}.png`);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "The map image could not be created.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Rendering map image…" : "Download map image (PNG)"}
        </button>
      )}
      {error && (
        <span className="download-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default function Message({ message, isLatest, selectedId, onSelect, onPrefill, sessionId }: Props) {
  if (message.role === "user") {
    return (
      <li className="msg msg-user">
        <span className="sr-only">You asked: </span>
        {message.text}
      </li>
    );
  }
  if (message.role === "error") {
    return (
      <li className="msg msg-error" role="alert">
        <strong>Sorry — </strong>
        {message.text}
      </li>
    );
  }
  const r = message.response;
  const selectable = (r?.map.features ?? []).filter(
    (f: MapFeature) => !["search-location", "amenity", "school-zone", "search-area"].includes(f.properties.kind),
  );
  // One chip per label (a trail or road can have many segments).
  const chips: MapFeature[] = [];
  const seen = new Set<string>();
  for (const f of selectable) {
    if (seen.has(f.properties.label)) continue;
    seen.add(f.properties.label);
    chips.push(f);
  }

  return (
    <li className="msg msg-assistant">
      <span className="sr-only">Assistant: </span>
      <div className="msg-body">
        <Markdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {message.text}
        </Markdown>
      </div>

      {r?.clarification && isLatest && (
        <div className="clarify" role="group" aria-label="Choose an option to add it to your reply">
          {r.clarification.options.slice(0, 6).map((o) => (
            <button key={o} type="button" className="chip" onClick={() => onPrefill(o)}>
              {o}
            </button>
          ))}
        </div>
      )}

      {r && <Downloads message={message} isLatest={isLatest} sessionId={sessionId} />}

      {chips.length > 0 && isLatest && (
        <div className="result-chips" role="group" aria-label="Show a result on the map">
          <span className="chips-label">On the map:</span>
          {chips.slice(0, 24).map((f) => (
            <button
              key={f.properties.id}
              type="button"
              className={`chip chip-result${selectedId === f.properties.id ? " active" : ""}`}
              aria-pressed={selectedId === f.properties.id}
              onClick={() => onSelect(f.properties.id)}
            >
              {f.properties.label}
            </button>
          ))}
          {chips.length > 24 && <span className="chips-more">+{chips.length - 24} more on the map</span>}
        </div>
      )}

      {r && (r.sources.length > 0 || r.methods.length > 0 || r.toolCalls.length > 0) && (
        <details className="provenance">
          <summary>Sources &amp; how this was answered</summary>
          {r.sources.length > 0 && (
            <>
              <h4>Data sources</h4>
              <ul className="sources">
                {r.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.layer}
                    </a>
                    <div className="source-meta">
                      {s.publisher}
                      {fmtDate(s.lastEdited) ? ` · data last updated ${fmtDate(s.lastEdited)}` : " · last-update date not published"}
                      {` · retrieved ${fmtDate(s.retrievedAt)}`}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.methods.length > 0 && (
            <>
              <h4>How it was derived</h4>
              {r.methods.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </>
          )}
          {r.limitations.length > 0 && (
            <>
              <h4>Limitations</h4>
              <ul>
                {r.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          )}
          {r.toolCalls.length > 0 && (
            <>
              <h4>GIS tools used (via MCP)</h4>
              <ol className="trace">
                {r.toolCalls.map((t, i) => (
                  <li key={i}>
                    <code>{t.tool}</code> — {TOOL_NAMES[t.tool] ?? t.tool} · {t.ok ? "succeeded" : `failed (${t.errorCode})`} · {(t.durationMs / 1000).toFixed(1)}s
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="mode-note">
            Answered by {r.mode === "ai" ? "the AI assistant (Claude) using MCP GIS tools" : "the offline planner (no AI model configured) using MCP GIS tools"}.
          </p>
        </details>
      )}
    </li>
  );
}
