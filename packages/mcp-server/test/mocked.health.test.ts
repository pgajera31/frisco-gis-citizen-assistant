/** MOCKED tests for per-service health checks (proposal: status banner for downtime). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeService, setFetchImplementation } from "../src/arcgis/client.js";
import { checkDataSourcesHealth, clearHealthCache } from "../src/tools/health.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => clearHealthCache());
afterEach(() => setFetchImplementation(null));

describe("probeService", () => {
  const url = "https://services6.arcgis.com/OGXLcOSnuy0GwFwi/ArcGIS/rest/services/ParkApp_Testing/FeatureServer/0";
  it("treats an ArcGIS error body (HTTP 200) as down", async () => {
    setFetchImplementation(async () => json({ error: { code: 500, message: "boom" } }));
    expect(await probeService(url)).toMatchObject({ ok: false, code: "ARCGIS_ERROR" });
  });
  it("times out quickly without retries", async () => {
    let calls = 0;
    setFetchImplementation((_u, init) => {
      calls++;
      return new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
    });
    const r = await probeService(url, 50);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(calls).toBe(1);
  });
  it("refuses unapproved URLs", async () => {
    await expect(probeService("https://evil.example.com/x")).rejects.toMatchObject({ code: "ENDPOINT_NOT_APPROVED" });
  });
});

describe("checkDataSourcesHealth", () => {
  it("reports down layers with their impact, and layers covered by a working backup", async () => {
    setFetchImplementation(async (u) => {
      if (u.includes("ParkApp_Testing")) return json({}, 503); // parks: no backup
      if (u.includes("FriscoData/MapServer/6")) return json({ error: { code: 400 } }); // CIP: mirror is up
      return json({ name: "ok" });
    });
    const r = await checkDataSourcesHealth({ fresh: true });
    const byKey = Object.fromEntries(r.results.map((x) => [x.layerKey, x]));
    expect(byKey.parks).toMatchObject({ status: "down", error: "HTTP_ERROR", affects: "park searches" });
    expect(byKey.activeCip.status).toBe("down (backup in use)");
    expect(byKey.trails.status).toBe("ok");
    expect(r.summary).toMatch(/2 of \d+ City data services are not responding; affected: park searches; backups are covering 1\./);
  });
  it("caches results for two minutes unless fresh is requested", async () => {
    let calls = 0;
    setFetchImplementation(async () => {
      calls++;
      return json({ name: "ok" });
    });
    await checkDataSourcesHealth();
    const first = calls;
    await checkDataSourcesHealth();
    expect(calls).toBe(first);
    await checkDataSourcesHealth({ fresh: true });
    expect(calls).toBe(first * 2);
  });
});
