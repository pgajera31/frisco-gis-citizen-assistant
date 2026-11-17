/**
 * BROWSER END-TO-END tests (Playwright, Chromium) against the running app:
 * web UI → backend API → MCP client → MCP server → live ArcGIS services.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const shots = "docs/screenshots";

/** Let map zoom animations and tiles settle before a screenshot. */
async function snap(page: Page, name: string) {
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${shots}/${name}` });
}

async function ask(page: Page, question: string) {
  const before = await page.locator(".msg-assistant, .msg-error").count();
  await page.getByLabel("Your question about Frisco").fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".msg-assistant, .msg-error")).toHaveCount(before + 1);
  return page.locator(".msg-assistant, .msg-error").last();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
});

test("home page identifies itself as a capstone prototype and offers suggestions", async ({ page }) => {
  await expect(page.getByRole("note").filter({ hasText: "University capstone prototype" })).toBeVisible();
  await expect(page.getByText("Not an official City of Frisco service")).toBeVisible();
  await expect(page.getByRole("list", { name: "Suggested questions" }).getByRole("button")).toHaveCount(10);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await snap(page, "01-home-desktop.png");
});

test("UC1 nearest park: answer, map polygons, search marker and sources", async ({ page }) => {
  await page.getByRole("button", { name: "What is the closest park to 6101 Frisco Square Blvd?" }).click();
  const answer = page.locator(".msg-assistant").last();
  await expect(answer).toContainText("closest park");
  await expect(answer).toContainText("mi to the park boundary");
  await expect(page.locator(".leaflet-overlay-pane path.leaflet-interactive").first()).toBeVisible();
  await expect(page.locator(".legend")).toContainText("Park boundary");
  await expect(page.locator(".legend")).toContainText("Searched location");
  await answer.getByText("Sources & how this was answered").click();
  await expect(answer.locator(".sources a").first()).toHaveAttribute("href", /arcgis/);
  await expect(answer).toContainText("NEAREST EDGE");
  await expect(answer).toContainText("find_nearest_parks");
  await snap(page, "02-nearest-park.png");
});

test("UC3 → UC4 follow-up narrows the previous park list", async ({ page }) => {
  const first = await ask(page, "Which parks in Frisco have basketball courts?");
  const n1 = Number((await first.innerText()).match(/(\d+) parks? in Frisco have Basketball/)?.[1]);
  expect(n1).toBeGreaterThan(5);
  const second = await ask(page, "Which of those parks also have playgrounds?");
  await expect(second).toContainText("from the previous results");
  const n2 = Number((await second.innerText()).match(/(\d+) parks? ha(?:s|ve) Basketball and Playground/)?.[1]);
  expect(n2).toBeLessThanOrEqual(n1);
  await snap(page, "03-follow-up.png");
});

test("selecting a result chip highlights it on the map and opens its popup", async ({ page }) => {
  await ask(page, "What is the closest park to 6101 Frisco Square Blvd?");
  const chip = page.locator(".chip-result").first();
  const label = (await chip.innerText()).trim();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".leaflet-popup-content")).toContainText(label);
});

test("UC5 zoning, UC7 walking loops, UC8 construction, UC10 speed limit", async ({ page }) => {
  const z = await ask(page, "What is the zoning at 6101 Frisco Square Blvd?");
  await expect(z).toContainText("Zoning district");
  await expect(z).toContainText("not a legal determination");
  await snap(page, "04-zoning.png");

  const w = await ask(page, "Show me walking loops in Frisco.");
  await expect(w).toContainText("walking loops");
  await snap(page, "05-walking-loops.png");

  const c = await ask(page, "What road projects are currently under construction in Frisco?");
  await expect(c).toContainText("under construction");
  await expect(page.locator(".legend")).toContainText("Project: Construction");
  await snap(page, "06-road-construction.png");

  const s = await ask(page, "What's the speed limit on Preston Road?");
  await expect(s).toContainText("mph");
  await expect(s.locator(".clarify .chip").first()).toBeVisible();
  await s.locator(".clarify .chip").first().click();
  await expect(page.getByLabel("Your question about Frisco")).toHaveValue(/mph section/);
  await snap(page, "07-speed-limit.png");
});

test("invalid address shows a clear message, not a fabricated answer", async ({ page }) => {
  const a = await ask(page, "What is the closest park to 99999 Nonexistent Imaginary Ln?");
  await expect(a).toContainText("couldn't find");
});

test("keyboard only: skip link, typing and Enter to send", async ({ page }) => {
  // Start from a known state, then Tab until focus enters the document (headless Chromium may
  // spend one or more Tabs on browser chrome). The first element reached must be the skip link.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)) break;
  }
  await expect(page.getByRole("link", { name: "Skip to the question box" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator("#question").focus();
  await page.keyboard.type("What trails are near 6101 Frisco Square Blvd?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg-assistant").last()).toContainText("trail");
  await expect(page.locator("#question")).toBeFocused();
});

test("high-contrast toggle and about/glossary dialog", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "High contrast" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await page.getByRole("button", { name: /About/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Glossary");
  await snap(page, "08-about-high-contrast.png");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("accessibility: no serious or critical axe violations (home and an answer)", async ({ page }) => {
  const home = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude(".leaflet-container").analyze();
  const serious = (r: typeof home) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious(home), JSON.stringify(serious(home).map((v) => [v.id, v.nodes.map((n) => n.target)]), null, 1)).toEqual([]);
  await ask(page, "What is the zoning at 6101 Frisco Square Blvd?");
  const answer = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude(".leaflet-container").analyze();
  expect(serious(answer), JSON.stringify(serious(answer).map((v) => [v.id, v.nodes.map((n) => n.target)]), null, 1)).toEqual([]);
});

test("@mobile layout: chat/map tabs and no horizontal overflow", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await snap(page, "09-mobile-home.png");
  await page.getByRole("button", { name: "What trails are near 6101 Frisco Square Blvd?" }).click();
  await expect(page.locator(".msg-assistant").last()).toContainText("trail");
  await snap(page, "10-mobile-answer.png");
  await page.getByRole("button", { name: /^Map/ }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await page.waitForTimeout(1500);
  await snap(page, "11-mobile-map.png");
});
