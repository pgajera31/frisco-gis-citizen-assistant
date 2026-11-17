#!/usr/bin/env node
/**
 * Development launcher: starts the backend (which spawns the MCP server over
 * stdio) and the Vite dev server together. Ctrl+C stops both.
 *
 *   npm run dev   →  web UI on http://localhost:5173 (proxying /api to :8787)
 */
import { spawn } from "node:child_process";

const procs = [
  ["backend", ["run", "dev", "-w", "apps/backend"]],
  ["web", ["run", "dev", "-w", "apps/web"]],
].map(([name, args]) => {
  const p = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = (line) => `[${name}] ${line}`;
  for (const stream of [p.stdout, p.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => chunk.split("\n").filter(Boolean).forEach((l) => console.log(tag(l))));
  }
  p.on("exit", (code) => {
    console.log(tag(`exited with code ${code}`));
    shutdown();
  });
  return p;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (!p.killed) p.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
