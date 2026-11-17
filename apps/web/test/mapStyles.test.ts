/** UNIT tests for map styling helpers (no browser). */
import { describe, expect, it } from "vitest";
import { featureStyle, KIND_LABELS, mphColor } from "../src/mapStyles";

describe("mphColor", () => {
  it("gives each common posted limit a distinct color", () => {
    const limits = [20, 25, 30, 35, 40, 45, 50, 55, 60];
    expect(new Set(limits.map(mphColor)).size).toBe(limits.length);
  });
});

describe("featureStyle", () => {
  it("styles construction projects differently from planned ones", () => {
    const c = featureStyle({ kind: "road-project", id: "1", label: "x", styleValue: "Construction" }, false);
    const p = featureStyle({ kind: "road-project", id: "2", label: "y", styleValue: "Planning" }, false);
    expect(c.color).not.toBe(p.color);
  });
  it("thickens the selected feature", () => {
    const a = featureStyle({ kind: "trail", id: "1", label: "x" }, false);
    const b = featureStyle({ kind: "trail", id: "1", label: "x" }, true);
    expect(Number(b.weight)).toBeGreaterThan(Number(a.weight));
  });
  it("has a human label for every feature kind", () => {
    for (const label of Object.values(KIND_LABELS)) expect(label.length).toBeGreaterThan(3);
  });
});
