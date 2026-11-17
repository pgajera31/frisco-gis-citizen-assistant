# Security & Privacy

## Controls implemented

| Area | Control | Where | Verified by |
|---|---|---|---|
| Authorized data only | All GIS URLs come from a fixed registry. The HTTP client rejects any URL not under an approved HTTPS prefix: the City's AGOL org, the City ArcGIS Server `Public/` folder, the Esri World Geocoder, and the Census geocoder. | `arcgis/layers.ts`, `arcgis/client.ts#assertApprovedUrl` | `mocked.reliability.test.ts` › endpoint allowlist (other hosts, http, other AGOL orgs, non-Public folders, `file://`) |
| No arbitrary URLs | No tool accepts a URL, `where` clause, SQL or endpoint parameter. | `server.ts` schemas | `mcp.integration.test.ts` › "does not offer any write/delete or arbitrary-URL tool" |
| Read-only | Only `query` and metadata `GET`s are ever issued. Tools are annotated `readOnlyHint` / non-destructive. | client, server | MCP integration tests |
| Input validation | zod schemas on every MCP tool (types, ranges, lengths, enums). The API validates `message` (1–500 chars, control characters stripped) and the JSON body size (10 kB). | `server.ts`, `app.ts` | MCP schema tests; API validation tests |
| SQL injection | Free text is reduced to `[A-Za-z0-9 .-'&/]` (≤80 chars) and embedded only in escaped single-quoted literals. Enum values come from fixed lists. | `sanitizeSqlText`, `sqlString` | SQL safety tests |
| Excessive queries | Radius caps (≤10 mi parks, ≤5 mi trails/projects); `maxFeatures` caps with `TOO_MANY_RESULTS`; page-count cap; result caching; per-call timeouts; 6 tool rounds max per question. | client, tools, orchestrator | reliability tests, tool-round-limit test |
| Rate limiting | 30 chat requests/minute/IP (configurable); one in-flight question per session (HTTP 409). | `app.ts` | rate-limit test |
| Prompt injection | System prompt treats resident text and tool output as data. Tool output is passed **only** inside `tool_result` blocks, never in the system prompt. The model has no tools beyond the read-only GIS set, so an injected instruction cannot reach other systems. The offline planner never executes instructions. | `prompt.ts`, `claude.ts`, `offline.ts` | prompt-injection tests (API + planner) |
| Credentials | `ANTHROPIC_API_KEY` is read only by the backend from the environment or `.env` (git-ignored). It is **not forwarded** to the MCP server process, which receives an allowlisted environment. No secrets exist in frontend code. `.env.example` has no values. | `config.ts`, `mcp/client.ts` | credential-exposure test (health, tools and chat responses never contain the key) |
| Error hygiene | Users see friendly messages and error codes; internal URLs and stack traces are logged server-side only. Express default error pages are replaced. | `toFailure`, `app.ts` | "never exposes internal details" test, malformed-JSON test |
| Browser hardening | helmet CSP (`default-src 'self'`, `frame-ancestors 'none'`, tiles allowed only from Esri/OSM), `nosniff`, no `x-powered-by`. CORS reflected only for configured dev origins. Map popups are built with `textContent` (no HTML injection). Markdown rendering disallows raw HTML. | `app.ts`, `MapView.tsx`, `Message.tsx` | security-header tests |
| Session ids | Server-issued random UUIDs only; unknown or invalid ids get a new session. | `sessions.ts` | session-id test |
| Privacy | No accounts, no cookies, no analytics. Conversations live in server memory for 30 idle minutes (max 2,000 sessions) and in the browser's `sessionStorage` for the tab. Logs record message length, not content. Geocoding sends only the typed address, to public geocoders, with `forStorage=false`. | `sessions.ts`, `App.tsx`, `app.ts` | code review |

## Remaining limitations and recommendations

1. **No authentication.** This is acceptable for a public read-only prototype (out of scope in the proposal). A production service would add bot protection and an API gateway.
2. **In-memory sessions and rate limits** reset on restart and don't scale horizontally. Use Redis or similar for multi-instance deployments.
3. **Rate limiting is per IP**, which is weak behind shared NAT. Add per-session quotas and a cost budget on AI calls.
4. **Prompt injection cannot be fully eliminated.** The blast radius is limited to read-only public data, but a crafted question could still make the model give a misleading answer. Keep tool sets read-only and keep the source disclosure in the UI.
5. **Third-party geocoders** receive the address a resident types. A production deployment could use the City's own geocoder (the `geo.friscotexas.gov` FriscoComposite service was unreachable from the development environment).
6. **Dependency risk.** On 2026-11-17, `npm audit --omit=dev` reported **0 vulnerabilities** in runtime dependencies. The full `npm audit` reports 6 "high" advisories, all from one `picomatch` ReDoS issue (GHSA-fc5q-39xc-vjpf) reached only through build/test tooling (Vite, Vitest, tinyglobby). These run on developer machines and do not ship in the production bundle or server. npm's suggested fix is a breaking downgrade of Vitest, so it was not applied. Upgrade once patched releases are available, and enable Dependabot.
7. **The Streamable HTTP MCP endpoint has no authentication.** It binds to `127.0.0.1` by default with DNS-rebinding protection. Do not expose it publicly without adding auth (MCP authorization spec / OAuth).
8. **Content Security Policy allows `'unsafe-inline'` styles**, which Leaflet needs for positioning. Scripts remain `'self'` only.
