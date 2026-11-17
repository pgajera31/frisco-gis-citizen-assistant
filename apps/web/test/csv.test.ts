/** UNIT tests for CSV export (escaping, flattening, spreadsheet formula-injection guard). */
import { describe, expect, it } from "vitest";
import { csvEscape, responseToCsv } from "../src/csv";
import type { ChatResponse } from "../src/types";

describe("csvEscape", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape('Park "A", North')).toBe('"Park ""A"", North"');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
  it("neutralises spreadsheet formulas", () => {
    expect(csvEscape("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  it("flattens arrays and objects", () => {
    expect(csvEscape(["Basketball", "Playground"])).toBe("Basketball; Playground");
    expect(csvEscape({ reference: "C1", landUseCode: null })).toBe('"reference: C1, landUseCode: "');
  });
});

describe("responseToCsv", () => {
  it("writes one row per result with sources and retrieval time", () => {
    const r = {
      sessionId: "s",
      reply: "",
      mode: "offline",
      toolCalls: [],
      map: { type: "FeatureCollection", features: [] },
      methods: [],
      limitations: [],
      sources: [{ layer: "Parks", url: "u", publisher: "p", lastEdited: "2026-10-15T00:00:00Z", retrievedAt: "2026-11-17T00:00:00Z" }],
      tables: [{ tool: "find_nearest_parks", rows: [{ name: "Simpson Plaza", distanceToBoundaryMiles: 0.04 }] }],
    } as ChatResponse;
    const lines = responseToCsv(r).replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("tool,name,distanceToBoundaryMiles,data_sources,retrieved_at");
    expect(lines[1]).toBe("find_nearest_parks,Simpson Plaza,0.04,Parks (updated 2026-10-15),2026-11-17T00:00:00Z");
  });
});
