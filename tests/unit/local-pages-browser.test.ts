// Lane L8: the pages in a real Chromium. The unit tests set the Origin header by hand; a browser decides what to send for a form post, and a page policy
// that makes it send `Origin: null` would refuse every approval. Skipped where no Chromium is installed.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { TASK, fakeWorld, type FakeWorld } from "../support/local-pages-fakes.js";

const haveChromium = existsSync(chromium.executablePath());
let browser: Browser | undefined;
let server: LocalPagesServer;
let world: FakeWorld;

beforeEach(async () => {
  world = fakeWorld();
  server = await createLocalPagesServer({ data: world.data, actions: world.actions });
});
afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await server.close();
});

describe.skipIf(!haveChromium)("a person using the pages in Chromium", () => {
  it("approves a plan, asks for changes, comments, rejects a design and retires a lesson, each with the browser's own form post", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();

    await page.goto(server.link(`/plan/${TASK}`));
    await page.getByRole("button", { name: "Approve this plan" }).click();
    await page.waitForURL(/n=approved/);
    expect(world.actions.calls.map((call) => call.name)).toEqual(["decidePlan"]);
    expect(await page.textContent("body")).toContain("Approved.");

    await page.fill("textarea[name=note]", "Cap the wait.");
    await page.getByRole("button", { name: "Ask for changes" }).click();
    await page.waitForURL(/n=changes/);

    await page.fill("textarea[name=text]", "Why three tries?");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.waitForURL(/n=commented/);

    await page.goto(server.link(`/design/${TASK}`));
    await page.fill("textarea[name=note]", "Too cramped.");
    await page.getByRole("button", { name: "Reject it" }).click();
    await page.waitForURL(/n=rejected/);

    await page.goto(server.link("/lessons"));
    await page.getByRole("button", { name: "Retire" }).first().click();
    await page.waitForURL(/n=lesson/);

    expect(world.actions.calls.map((call) => call.name)).toEqual(["decidePlan", "decidePlan", "addComment", "decideDesign", "lessonAction"]);
  });

  it("shows the design mockup image on the page, and runs no script", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const violations: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
    await page.goto(server.link(`/design/${TASK}`));
    await page.waitForLoadState("load");
    expect(await page.locator("img").count()).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
