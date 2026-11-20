// DEC 253q: the setup page's eval panel: the four states (not discovered, waiting for confirmation, confirmed, re-approve needed), the Confirm form (bound to the report digest the page
// showed) and the no-budget reason on an install with no eval cap. Repository text is shown as text. The browser test drives the real local pages server with a fake action.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { describe, expect, it } from "vitest";
import { evalCommandFingerprintOf, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import { createLocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { renderSetupPage } from "../../packages/broker/src/core/local-pages/setup-page.js";
import type { SetupPageView } from "../../packages/broker/src/core/local-pages/views.js";
import { EVAL_NO_CAP_MESSAGE, setupEvalDiscoveryView } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { fakeWorld } from "../support/local-pages-fakes.js";

const command = { executable: "node", args: ["evals/run.js"], cwd: "." };
const report = { cwd: ".", argument: "rovara-measures.json" };
const REPORT: SetupEvalDiscoveryReport = { schemaVersion: 1, suites: [{
  selection: "evals/<b>demo</b>", repository: "web", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }, { id: "q2", category: "safety", path: "evals/demo/q2.txt" }],
  command, report, commandFingerprint: evalCommandFingerprintOf(command, report), judge: { kind: "model", model: "gemini-2.5-pro", version: "gemini-2.5-pro-002", scoringPath: "evals/demo/judge.md" },
  subsetSupported: true, catalogRowId: "gemini", model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", image: `registry.example/worker@sha256:${"e".repeat(64)}`, route: "gateway",
  maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10_000,
}] };
const DIGEST = "d".repeat(64);
const discovery = (state: "reported" | "confirmed") => ({ taskId: "task_1", reportDigest: DIGEST, state, report: REPORT, ...(state === "confirmed" ? { confirmedSelection: "evals/<b>demo</b>" } : {}) });
const page = (over: Partial<SetupPageView> = {}): SetupPageView => ({ project: "demo", revision: 1, status: "ready", limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, items: [], verified: false, journal: [], hostAsks: [], approvedHosts: [], check: { status: "unchecked" }, ...over });
const context = { base: "/local", nonce: "nonce", sessionId: "session", formToken: () => "token" };

describe("the eval panel's states", () => {
  it("not discovered, waiting, confirmed and re-approve needed (mutant: the state rule)", () => {
    expect(setupEvalDiscoveryView(undefined, undefined, undefined)).toBeUndefined();
    expect(setupEvalDiscoveryView(discovery("reported"), undefined, undefined)!.state).toBe("waiting");
    expect(setupEvalDiscoveryView(discovery("reported"), "approved", undefined)!.state).toBe("waiting");
    expect(setupEvalDiscoveryView(discovery("confirmed"), "waiting", undefined)!.state).toBe("confirmed");
    expect(setupEvalDiscoveryView(discovery("confirmed"), "approved", undefined)!.state).toBe("confirmed");
    for (const spend of ["rejected", "approval needs renewing", undefined] as const) expect(setupEvalDiscoveryView(discovery("confirmed"), spend, undefined)!.state).toBe("reapprove");
  });
  it("renders each state's words; Confirm only while waiting and only on an install that has an eval budget (mutant: the cannotConfirm gate)", () => {
    expect(renderSetupPage(context, page())).toContain("Not discovered");
    expect(renderSetupPage(context, page())).not.toContain("no eval budget");
    expect(renderSetupPage(context, page({ evalNoBudget: EVAL_NO_CAP_MESSAGE }))).toContain("This install has no eval budget");
    const waiting = renderSetupPage(context, page({ evalDiscovery: setupEvalDiscoveryView(discovery("reported"), undefined, undefined)! }));
    expect(waiting).toContain("Waiting for confirmation");
    expect(waiting).toContain("Confirm this eval");
    expect(waiting).toContain(`/local/setup/demo/eval-confirm`);
    expect(waiting).toContain(`name="reportDigest" value="${DIGEST}"`);
    const noBudget = renderSetupPage(context, page({ evalDiscovery: setupEvalDiscoveryView(discovery("reported"), undefined, EVAL_NO_CAP_MESSAGE)! }));
    expect(noBudget).toContain("This install has no eval budget");
    expect(noBudget).not.toContain("Confirm this eval");
    const confirmed = renderSetupPage(context, page({ evalDiscovery: setupEvalDiscoveryView(discovery("confirmed"), "approved", undefined)! }));
    expect(confirmed).toContain("Confirmed:");
    expect(confirmed).not.toContain("Confirm this eval");
    const again = renderSetupPage(context, page({ evalDiscovery: setupEvalDiscoveryView(discovery("confirmed"), "rejected", undefined)! }));
    expect(again).toContain("Re-approve needed");
    expect(again).not.toContain("Confirm this eval");
  });
});

it.skipIf(!existsSync(chromium.executablePath()))("browser: the owner reads the discovered eval and confirms it; a stale form token is refused before the action", async () => {
  const world = fakeWorld();
  world.data.getSetupPage = async () => page({ evalDiscovery: setupEvalDiscoveryView(discovery("reported"), undefined, undefined)! });
  const submitted: unknown[] = [];
  world.actions.setupEvalConfirm = async (input) => { submitted.push(input); return { ok: true, message: "The eval is confirmed." }; };
  const server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await tab.goto(server.link("/setup/demo"));
    expect(await tab.getByText("Waiting for confirmation", { exact: false }).isVisible()).toBe(true);
    expect(await tab.getByText("evals/<b>demo</b>", { exact: true }).first().isVisible()).toBe(true);
    // A form whose digest was changed after the page signed it is refused (the token binds the digest).
    // A form whose digest, suite or files were changed after the page signed it is refused (mutants: each part of the token's binding).
    for (const tamper of [
      `document.querySelector("input[name=reportDigest]").value = "${"0".repeat(64)}"`,
      `document.querySelector("input[name=selection]").value = "evals/other"`,
      `document.querySelector("input[name=path]").remove()`,
      `document.querySelector("input[name=taskId]").value = "task_2"`,
    ]) {
      await tab.goto(server.link("/setup/demo"));
      await tab.evaluate(tamper);
      await tab.getByRole("button", { name: "Confirm this eval" }).click();
      await tab.waitForURL(/n=form/u);
    }
    // A form whose shape is wrong never reaches the token check or the action.
    for (const tamper of [`document.querySelector("input[name=reportDigest]").value = "not-a-digest"`, `document.querySelectorAll("input[name=path]").forEach((e) => e.remove())`]) {
      await tab.goto(server.link("/setup/demo"));
      await tab.evaluate(tamper);
      await tab.getByRole("button", { name: "Confirm this eval" }).click();
      await tab.waitForURL(/n=invalid/u);
    }
    expect(submitted).toEqual([]);
    await tab.goto(server.link("/setup/demo"));
    await tab.getByRole("button", { name: "Confirm this eval" }).click();
    await tab.waitForURL(/n=setupdone/u);
    expect(submitted).toEqual([{ project: "demo", taskId: "task_1", reportDigest: DIGEST, selection: "evals/<b>demo</b>", paths: ["evals/demo/q1.txt", "evals/demo/q2.txt"] }]);
    await tab.setViewportSize({ width: 390, height: 844 });
    expect(await tab.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
  } finally { await browser?.close(); await server.close(); }
});
