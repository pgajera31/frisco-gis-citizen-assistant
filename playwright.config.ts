import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests. They run against the production build served by the
 * backend (offline-planner mode unless ANTHROPIC_API_KEY is set) with the real
 * MCP server and live City of Frisco GIS services.
 *
 *   npm run build && npm run test:e2e
 */
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "docs/test-results/e2e-results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "off",
    launchOptions: proxy ? { proxy } : {},
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } }, grepInvert: /@mobile/ },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: "node apps/backend/dist/index.js",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
    env: { PORT: "8787", RATE_LIMIT_PER_MINUTE: "500" },
  },
});
