/**
 * Scenario benchmark (proposal "Evaluation & Testing Plan → Scenario Tests":
 * run 10–15 citizen prompts end-to-end; measure accuracy and time-to-answer).
 *
 *   npm start                          # backend (any mode: offline planner or AI)
 *   npm run benchmark                  # writes docs/SCENARIO_BENCHMARK.md and docs/test-results/scenario-benchmark.json
 *
 * Env: BENCH_URL (default http://127.0.0.1:8787), BENCH_RUNS (default 2: a cold and a warm pass).
 * Start the backend with RATE_LIMIT_PER_MINUTE=500 so the benchmark is not rate-limited.
 *
 * "Accurate" requires BOTH the expected MCP tool to be called successfully AND the answer to contain a key fact
 * verified independently against the live City data on 2026-11-17 (see each scenario's `fact`). Facts can change
 * when the City updates its data; re-verify them before comparing runs months apart.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BASE = process.env.BENCH_URL ?? "http://127.0.0.1:8787";
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? 2));
const A = "6101 Frisco Square Blvd";

interface Scenario {
  uc: string;
  question: string;
  tool: string;
  /** Key fact the reply must contain (verified against live data). */
  fact: RegExp;
  /** Run in the same session as the previous scenario (follow-up questions). */
  followUp?: boolean;
}

const SCENARIOS: Scenario[] = [
  { uc: "UC1", question: `What is the closest park to ${A}?`, tool: "find_nearest_parks", fact: /Simpson Plaza/ },
  { uc: "UC1", question: `nearest park to ${A}`, tool: "find_nearest_parks", fact: /Simpson Plaza/ },
  { uc: "UC1", question: `I live at ${A}. Where's the nearest park?`, tool: "find_nearest_parks", fact: /Simpson Plaza/ },
  { uc: "UC2", question: `Show me parks within 2 miles of ${A}.`, tool: "find_parks_within_radius", fact: /\b19 parks\b/ },
  { uc: "UC2", question: `any parks within half a mile of ${A}?`, tool: "find_parks_within_radius", fact: /\b6 parks have part of the park within 0\.5 miles/ },
  { uc: "UC3", question: "Which parks in Frisco have basketball courts?", tool: "search_parks_by_amenity", fact: /\b35 parks\b/ },
  { uc: "UC4", question: "Which of those parks also have playgrounds?", tool: "search_parks_by_amenity", fact: /previous results.*\b34 parks\b|\b34\b.*previous/s, followUp: true },
  { uc: "UC3", question: "parks with a splash pad and restrooms", tool: "search_parks_by_amenity", fact: /\d+ parks? in Frisco ha(s|ve) Splash Pad and Restrooms/ },
  { uc: "UC5", question: `What is the zoning at ${A}?`, tool: "lookup_zoning", fact: /MIXED[\s\S]*PD-153/ },
  { uc: "UC5", question: `how is ${A} zoned`, tool: "lookup_zoning", fact: /MIXED[\s\S]*PD-153/ },
  { uc: "UC6", question: `What trails are near ${A}?`, tool: "find_nearby_trails", fact: /Gallegos Park Walking Loop/ },
  { uc: "UC6", question: `hiking trails close to ${A}`, tool: "find_nearby_trails", fact: /Gallegos Park Walking Loop/ },
  { uc: "UC7", question: "Show me walking loops in Frisco.", tool: "search_trails", fact: /\b36 walking loops\b/ },
  { uc: "UC7", question: "list the nature trails", tool: "search_trails", fact: /\b4 Nature trails\b/ },
  { uc: "UC8", question: "What road projects are currently under construction in Frisco?", tool: "find_road_projects", fact: /\b17 road projects under construction/ },
  { uc: "UC8", question: "is there any road construction going on?", tool: "find_road_projects", fact: /\b17 road projects under construction/ },
  { uc: "UC9", question: `Are there any road projects near ${A}?`, tool: "find_road_projects_near", fact: /\b5 City road capital projects are within 1 mile/ },
  { uc: "UC9", question: `road work near ${A}`, tool: "find_road_projects_near", fact: /\b5 City road capital projects are within 1 mile/ },
  { uc: "UC10", question: "What's the speed limit on Preston Road?", tool: "get_speed_limit", fact: /45 mph[\s\S]*55 mph/ },
  { uc: "UC10", question: "how fast can I drive on Preston Rd", tool: "get_speed_limit", fact: /45 mph[\s\S]*55 mph/ },
  { uc: "UC10", question: "What's the speed limit on Preston Road near 8750 Preston Rd?", tool: "get_speed_limit", fact: /\b45 mph\b/ },
  { uc: "UC11", question: `Which school district is ${A} in?`, tool: "lookup_school_district", fact: /Frisco ISD/ },
  { uc: "UC11", question: "what ISD serves 8750 Preston Rd", tool: "lookup_school_district", fact: /Frisco ISD/ },
  { uc: "UC12", question: `What is the future land use for ${A}?`, tool: "lookup_future_land_use", fact: /Town Center/ },
  { uc: "UC12", question: `what is ${A} planned for in the comprehensive plan`, tool: "lookup_future_land_use", fact: /Town Center/ },
  { uc: "UC13", question: `What schools are near ${A}?`, tool: "find_nearby_schools", fact: /Benton A\. Staley Middle School/ },
  { uc: "UC13", question: `high schools within 3 miles of ${A}`, tool: "find_nearby_schools", fact: /high schools are within 3 miles/ },
  { uc: "UC14", question: `Where is the nearest fire station to ${A}?`, tool: "find_nearby_facilities", fact: /Fire Station 4/ },
  { uc: "UC14", question: "closest library to 8000 McKinney Rd", tool: "find_nearby_facilities", fact: /Frisco Public Library \(8000 Dallas Pkwy\), 1\.37 miles/ },
  { uc: "EXTRA", question: `How many parks are within 1 mile of ${A}?`, tool: "count_features_within_radius", fact: /\b7 parks within 1 mile/ },
  { uc: "EXTRA", question: "What maps does the City publish about construction?", tool: "search_gis_catalog", fact: /Construction & Development/ },
];

interface Outcome {
  uc: string;
  question: string;
  run: number;
  ms: number;
  status: number;
  mode?: string;
  toolsCalled: string[];
  toolOk: boolean;
  factOk: boolean;
  accurate: boolean;
  mapFeatures: number;
  error?: string;
}

async function ask(message: string, sessionId?: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, sessionId }) });
  const body = (await res.json()) as Record<string, unknown>;
  return { ms: Math.round(performance.now() - t0), status: res.status, body };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as { mode: string; model: string | null; mcp: { toolCount: number } };
  const outcomes: Outcome[] = [];
  for (let run = 1; run <= RUNS; run++) {
    let sessionId: string | undefined;
    for (const sc of SCENARIOS) {
      if (!sc.followUp) sessionId = undefined;
      const { ms, status, body } = await ask(sc.question, sessionId);
      sessionId = body.sessionId as string | undefined;
      const calls = (body.toolCalls as { tool: string; ok: boolean }[] | undefined) ?? [];
      const reply = String(body.reply ?? "");
      const toolOk = calls.some((c) => c.tool === sc.tool && c.ok);
      const factOk = sc.fact.test(reply);
      outcomes.push({
        uc: sc.uc,
        question: sc.question,
        run,
        ms,
        status,
        mode: body.mode as string | undefined,
        toolsCalled: calls.map((c) => c.tool),
        toolOk,
        factOk,
        accurate: status === 200 && toolOk && factOk,
        mapFeatures: ((body.map as { features?: unknown[] } | undefined)?.features ?? []).length,
        ...(status !== 200 ? { error: JSON.stringify(body.error ?? body).slice(0, 200) } : {}),
      });
      process.stderr.write(`${run} ${sc.uc} ${ms}ms ${toolOk && factOk ? "ok" : "MISS"}  ${sc.question}\n`);
    }
  }

  const byRun = (r: number) => outcomes.filter((o) => o.run === r);
  const summary = {
    runAt: new Date().toISOString(),
    baseUrl: BASE,
    mode: health.mode,
    model: health.model,
    mcpTools: health.mcp.toolCount,
    scenarios: SCENARIOS.length,
    runs: RUNS,
    accuracy: outcomes.filter((o) => o.accurate).length / outcomes.length,
    toolSelectionAccuracy: outcomes.filter((o) => o.toolOk).length / outcomes.length,
    latencyMs: Object.fromEntries(
      Array.from({ length: RUNS }, (_, i) => i + 1).map((r) => {
        const xs = byRun(r).map((o) => o.ms);
        return [r === 1 ? "cold" : `warm${RUNS > 2 ? r - 1 : ""}`, { p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) }];
      }),
    ),
  };
  mkdirSync(path.join(root, "docs", "test-results"), { recursive: true });
  writeFileSync(path.join(root, "docs", "test-results", "scenario-benchmark.json"), JSON.stringify({ summary, outcomes }, null, 2));

  const rows = SCENARIOS.map((sc, i) => {
    const os = outcomes.filter((_, j) => j % SCENARIOS.length === i);
    return `| ${sc.uc} | ${sc.question.replace(/\|/g, "\\|")} | \`${sc.tool}\` | ${os.every((o) => o.accurate) ? "✅" : "❌"} | ${os.map((o) => o.ms).join(" / ")} |`;
  });
  const lat = summary.latencyMs as Record<string, { p50: number; p95: number; max: number }>;
  const md = [
    "# Scenario Benchmark: accuracy and time-to-answer",
    "",
    "Proposal evaluation plan: *“Scenario Tests: Run 10–15 citizen prompts end-to-end; measure accuracy and time-to-answer.”* Generated by `npm run benchmark`.",
    "",
    `- **Run:** ${summary.runAt} against \`${BASE}\` in **${summary.mode === "ai" ? `AI mode (${summary.model})` : "offline-planner mode (no AI key configured)"}**, ${summary.mcpTools} MCP tools, live City GIS services.`,
    `- **Scenarios:** ${SCENARIOS.length} questions (the 14 use cases plus alternative phrasings and two catalog-tool questions), ${RUNS} passes (first pass with cold caches).`,
    `- **Accuracy:** ${(summary.accuracy * 100).toFixed(1)}% (${outcomes.filter((o) => o.accurate).length}/${outcomes.length}). An answer counts as accurate only if the expected MCP tool succeeded **and** the reply contains the key fact verified against live City data.`,
    `- **Tool selection:** ${(summary.toolSelectionAccuracy * 100).toFixed(1)}%.`,
    `- **Time to answer (HTTP round trip):** ${Object.entries(lat).map(([k, v]) => `${k} p50 ${v.p50} ms, p95 ${v.p95} ms, max ${v.max} ms`).join("; ")}.`,
    "- **Steps to an answer and map:** 1. Clicking a suggested question, or typing one question and pressing Enter, returns the answer, the map and the sources (proposal success criterion: ≤ 3 steps).",
    "",
    "| Use case | Question | Expected tool | Accurate (all runs) | Time per run (ms) |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    summary.mode === "ai"
      ? "AI-mode latency includes model calls; tool selection is Claude's."
      : "Offline-planner mode: tool selection here is the rule-based fallback. With `ANTHROPIC_API_KEY` set, re-run this script to measure Claude's tool selection and end-to-end latency (expect additional model time per tool round).",
    "",
    "Key facts were verified against the live services on 2026-11-17 (e.g. Simpson Plaza 0.04 mi; MIXED / PD-153; Frisco ISD; Town Center; Fire Station 4 at 0.9 mi). City data updates can legitimately change them.",
    "",
  ].join("\n");
  writeFileSync(path.join(root, "docs", "SCENARIO_BENCHMARK.md"), md);
  console.log(`accuracy ${(summary.accuracy * 100).toFixed(1)}%, tool selection ${(summary.toolSelectionAccuracy * 100).toFixed(1)}%, latency ${JSON.stringify(summary.latencyMs)}`);
  if (summary.accuracy < 1) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
