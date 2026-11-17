/**
 * Build a CSV file from the tool result tables of one answer. Nested values are
 * flattened to readable text, and cells that a spreadsheet would treat as a
 * formula (=, +, -, @, tab, CR) are prefixed with an apostrophe.
 */
import type { ChatResponse } from "./types";

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join("; ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${cellText(x)}`)
      .join(", ");
  }
  return String(v);
}

export function csvEscape(v: unknown): string {
  let s = cellText(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function hasTables(r?: ChatResponse): boolean {
  return Boolean(r?.tables?.some((t) => t.rows.length));
}

export function responseToCsv(r: ChatResponse): string {
  const rows = (r.tables ?? []).flatMap((t) => t.rows.map((row) => ({ tool: t.tool, ...row })));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const sources = r.sources.map((s) => `${s.layer}${s.lastEdited ? ` (updated ${s.lastEdited.slice(0, 10)})` : ""}`).join(" | ");
  const retrieved = r.sources[0]?.retrievedAt ?? new Date().toISOString();
  const header = [...columns, "data_sources", "retrieved_at"];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) lines.push([...columns.map((c) => csvEscape((row as Record<string, unknown>)[c])), csvEscape(sources), csvEscape(retrieved)].join(","));
  // Excel opens UTF-8 correctly with a BOM.
  return `﻿${lines.join("\r\n")}\r\n`;
}
