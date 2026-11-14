// Browser proof of the independent form: no model calls or external services.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";
import { createLocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { proposeEvalSpendApproval, readEvalSpendItem } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { fakeWorld } from "../support/local-pages-fakes.js";

it.skipIf(!existsSync(chromium.executablePath()))("shows the eval estimate before the browser submits its independent approval", async () => {
  const deps = { store: new MemoryDocumentStore(), companyId: "org_aaaaaaaaaaaaaaaaaaaa" };
  await proposeEvalSpendApproval(deps, "demo", { selection: "evals/demo", inputs: { evalSetHash: "a".repeat(64), judgePin: "b".repeat(64), modelVersion: "v1", model: "model", catalogRowId: "model", commandFingerprint: "c".repeat(64), settingsFingerprint: "d".repeat(64) }, estimate: { calls: 300, costMicros: 3_000_000 } });
  const evalSpend = (await readEvalSpendItem(deps, "demo"))!;
  const world = fakeWorld();
  world.data.getSetupPage = async () => ({ project: "demo", revision: 1, status: "none", limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, items: [], verified: false, journal: [], hostAsks: [], approvedHosts: [], check: { status: "unchecked" }, evalSpend });
  let submitted: unknown;
  world.actions.setupDecideEval = async input => { submitted = input; return { ok: true, message: "Eval spend approved." }; };
  const server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.goto(server.link("/setup/demo"));
    expect(await page.getByText("Run the eval health check: about 300 calls, about $3.000000", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Approve these commands" }).count()).toBe(0);
    expect(submitted).toBeUndefined();
    const screenshotDirectory = process.env["F3E_SCREENSHOT_DIR"];
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, "eval-spend-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, "eval-spend-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Approve eval spend", exact: true }).click();
    await page.waitForURL(/n=setupdone/u);
    expect(submitted).toMatchObject({ project: "demo", decision: "approve", approval: { kind: "setup-eval-spend", artifactDigest: evalSpend.approval!.artifactDigest } });
    expect(world.actions.calls).toEqual([]);
  } finally { await browser?.close(); await server.close(); }
});
