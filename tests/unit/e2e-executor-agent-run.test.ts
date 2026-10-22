import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseVerifiedE2EAgentActionLedger, e2eAgentValueKeyId } from "@agentx/contracts";
import { agentRunnable, downloadsOf, executorLog, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { AGENT_GOAL, sha256Hex } from "../support/orders-m14-agent.js";
import { allOutputText, caseStatuses, observations, readReport } from "../support/e2e-executor-output.js";

// Task 4.3b, test cases 5 to 10 on this machine: the real executor, the pinned CLI, a real Chromium, the m14 orders app and the worker's real model proxy answering from the scripted
// double. The Linux tests run the same cases through the production Docker host (tests/linux/e2e-agent.test.ts).
const runs: AgentRun[] = [];
afterEach(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });
const run = async (...args: Parameters<typeof runAgentCase>) => { const result = await runAgentCase(...args); runs.push(result); return result; };

const agentStepObservation = (out: string) => observations(out).filter((item) => item.kind === "step-observation").map((item) => JSON.parse(item.content!) as { kind: string; agent?: { verdict: string; stopCode: string | null; download: string } })
  .find((item) => item.kind === "agent");
const caseCaptures = (out: string) => observations(out).filter((item) => item.kind === "case-capture").map((item) => JSON.parse(item.content!) as { terminal: { kind: string }; assertions: Array<{ outcome: string; reason: string }>; steps: Array<{ kind: string; outcome: string }> });
const caseCapture = (out: string) => observations(out).filter((item) => item.kind === "case-capture").map((item) => JSON.parse(item.content!) as { assertions: Array<{ outcome: string; reason: string }>; steps: Array<{ kind: string; outcome: string }> })[0];

describe.runIf(agentRunnable)("the agent step end to end, on this machine", () => {
  it("renamed export: the goal 'Export the orders as a CSV file' taps 'Download orders'; one download is captured, the ledger shows one ok tap on download-orders, and the config digest is the compiler's", async () => {
    const r = await run({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] });
    expect(r.result, executorLog(r.out)).toEqual({ exitCode: 0, reason: null });
    const downloads = downloadsOf(r.out);
    expect(downloads).toHaveLength(1);
    expect(readFileSync(join(r.out, "downloads", downloads[0]!), "utf8")).toBe("id,customer,total,state,inventory\r\na1,Ada,12.5,ready,unavailable\r\na2,Grace,23,ready,unavailable\r\n");
    const ledger = r.readLedger()!;
    expect(ledger).toMatchObject({ runId: r.fixture.plan.runId, caseId: r.caseId, valueKeyId: e2eAgentValueKeyId(r.valueKey) });
    expect(ledger.steps).toHaveLength(1);
    const [step] = ledger.steps;
    expect(step).toMatchObject({ stepIndex: 1, verdict: "concluded", stopCode: null });
    expect(step!.actions).toHaveLength(1);
    expect(step!.actions[0]).toMatchObject({ tool: "tap", outcome: "ok", node: { role: "button", name: "Download orders", testId: "download-orders" }, valueDigest: null, url: null });
    // The worker's receipts and the ledger agree, and the ledger passes the verified parse the broker will use.
    expect(r.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "ok"]);
    expect(step!.receiptIds).toEqual(r.receipts.map((receipt) => receipt.receiptId));
    expect(parseVerifiedE2EAgentActionLedger(ledger, { goals: new Map([[1, AGENT_GOAL]]), valueKey: r.valueKey, runId: r.fixture.plan.runId, caseId: r.caseId }).ok).toBe(true);
    expect(agentStepObservation(r.out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "captured" });
    // The report's config digest is the one the compiler (and the broker) computed for this group: model groups moved, and the executor, store and ceiling are in it.
    expect(readReport(r.out).run.project.configDigest).toBe(r.fixture.compiled.shards[0]!.expectedConfigDigest);
    // Nothing the worker or the executor keeps a secret in is in the output: no value key, no account credential.
    const everything = allOutputText(r.out);
    expect(everything).not.toContain(r.valueKey);
    for (const account of r.fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
  }, 300_000);

  it("the report's agent step agrees with the ledger and the receipts (metrics, the one engine event with no node id), and the capture store is not fed: a known gap of Ruling M4-A", async () => {
    const r = await run({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(0);
    const raw = JSON.parse(readFileSync(join(r.out, "report.json"), "utf8")) as { run: { results: Array<{ attempts: Array<{ steps: Array<Record<string, unknown>> }> }> } };
    const step = raw.run.results[0]!.attempts[0]!.steps.find((item) => item["kind"] === "agent")!;
    // What Task 4.4 holds the ledger and the receipts to: one call per ok receipt, one action per ledger action.
    expect(step["metrics"]).toMatchObject({ modelCalls: r.receipts.filter((receipt) => receipt.outcome === "ok").length, actionSteps: r.readLedger()!.steps[0]!.actions.length });
    expect(step["model"]).toMatchObject({ provider: "agentx-e2e", model: "rovara-scripted/v1", adapterVersion: "executor/rovara-e2e-agent@1" });
    expect((step["events"] as Array<{ kind: string; detail?: string }>).filter((event) => event.kind === "engine").map((event) => event.detail)).toEqual(['tap button "Download orders"']);
    // KNOWN GAP (Ruling M4-A): the pinned runner writes a recording only when a deterministic verification step that STARTS AFTER the agent step passed, and Rovara's approved assertions
    // are nested steps that open first and wrap the whole case (`runInsideAssertionSteps`), so none does: the recording is "unconfirmed", nothing reaches the store and no
    // agent/traces file exists. Task 4.6 (replay) must make the assertion steps start after the agent step; when it does, this expectation changes to a kept recording.
    expect(step["cache"]).toMatchObject({ mode: "missed", write: "unconfirmed" });
    expect(existsSync(join(r.out, "agent", "traces"))).toBe(false);
  }, 300_000);

  it("a model that is done without acting leaves no download: the executor records agent-no-download on the step and on the unavailable csv assertion", async () => {
    const r = await run({ script: [{ kind: "done" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(1);
    expect(downloadsOf(r.out)).toEqual([]);
    expect(agentStepObservation(r.out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "agent-no-download" });
    expect(caseCapture(r.out)!.assertions[0]).toMatchObject({ outcome: "unavailable", reason: "agent-no-download" });
    expect(r.readLedger()!.steps[0]).toMatchObject({ verdict: "concluded", actions: [] });
  }, 300_000);

  it("a decoy: tapping 'Download invoices' downloads the invoices file, so the csv assertion observes bytes that do not match", async () => {
    const r = await run({ script: [{ kind: "tap", name: /Download invoices/ }, { kind: "done" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(1);
    const downloads = downloadsOf(r.out);
    expect(downloads).toHaveLength(1);
    expect(readFileSync(join(r.out, "downloads", downloads[0]!), "utf8")).toMatch(/^invoice,customer,amount,status\r\n/);
    expect(caseCapture(r.out)!.assertions[0]).toMatchObject({ outcome: "failed" });
    expect(r.readLedger()!.steps[0]!.actions[0]).toMatchObject({ node: { name: "Download invoices", testId: "download-invoices" }, outcome: "ok" });
  }, 300_000);

  it("a provider outage: the step fails with MODEL_PROVIDER_FAILED, the receipt is provider-error and the ledger verdict is failed", async () => {
    const r = await run({ script: [{ kind: "fail", message: "provider down" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(1);
    expect(r.receipts.map((receipt) => receipt.outcome)).toEqual(["provider-error"]);
    const step = r.readLedger()!.steps[0]!;
    expect(step).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", actions: [], receiptIds: [r.receipts[0]!.receiptId] });
    const report = readReport(r.out);
    const failedStep = JSON.stringify(report).includes("MODEL_PROVIDER_FAILED");
    expect(failedStep).toBe(true);
    expect(downloadsOf(r.out)).toEqual([]);
  }, 300_000);

  it("a step that failed never lets the case go on to pass: with an assertion the page would satisfy anyway (no csv), the case still fails; its capture says the step stopped and observes nothing", async () => {
    const r = await run({ script: [{ kind: "fail", message: "provider down" }], plan: { assertions: [{ kind: "visible", testId: "identity", equals: true }] } });
    expect(r.result.exitCode, executorLog(r.out)).toBe(1);
    expect(caseStatuses(r.out, r.fixture)).toEqual({ "agent-export": "failed" });
    // Task 4.4a: the case's capture is written (the collector then names why the case is UNKNOWN), with the stopped step as it ended and every assertion unavailable: the page, which the
    // step left half-way, is not observed, so the satisfiable `visible` assertion is not evaluated.
    const captures = caseCaptures(r.out);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ terminal: { kind: "unavailable" }, steps: [{ kind: "navigate", outcome: "completed" }, { kind: "agent", outcome: "unavailable" }],
      assertions: [{ outcome: "unavailable", reason: "agent-step-did-not-conclude" }] });
    expect(r.readLedger()!.steps[0]).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED" });
  }, 300_000);

  it("a second download in the step records ambiguous-download and gives the csv assertion nothing to read", async () => {
    const r = await run({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "tap", name: /Download invoices/ }, { kind: "done" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(1);
    expect(agentStepObservation(r.out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "ambiguous-download" });
    expect(caseCapture(r.out)!.assertions[0]).toMatchObject({ outcome: "unavailable", reason: "ambiguous-download" });
    expect(downloadsOf(r.out)).toEqual([]);
    expect(r.readLedger()!.steps[0]!.actions).toHaveLength(2);
  }, 300_000);

  it("(l) keeps every request the model is sent within the channel's input bound, and the measured sizes are recorded", async () => {
    const r = await run({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] });
    expect(r.result.exitCode, executorLog(r.out)).toBe(0);
    console.log(`E2E_AGENT_REQUEST_BYTES ${JSON.stringify(r.requestBytes)} SCREEN_BYTES ${JSON.stringify(r.screenBytes)}`);
    expect(r.requestBytes.length).toBe(2);
    expect(r.screenBytes.every((bytes) => bytes > 100)).toBe(true);
    // The worker refuses a request whose size plus 1024 passes the 32000-token input ceiling, read as bytes; this fixture is far inside it at every turn.
    for (const bytes of r.requestBytes) expect(bytes).toBeLessThanOrEqual(32_000 - 1024);
    for (const bytes of r.screenBytes) expect(bytes).toBeLessThanOrEqual(32_000 - 1024);
  }, 300_000);
});
void sha256Hex;
