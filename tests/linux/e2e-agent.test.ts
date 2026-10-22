import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { e2eAgentValueKeyId, parseVerifiedE2EAgentActionLedger } from "@agentx/contracts";
import { allOutputText, caseStatuses, observations, readReport } from "../support/e2e-executor-output.js";
import { removeAgentProbeDirs, runAgentProbe, whyAgent, type AgentProbeRun } from "../support/linux-agent.js";
import { AGENT_GOAL } from "../support/orders-m14-agent.js";

// Task 4.3b, test cases 5 to 10 on a real Docker host: the production host runs the m14 orders app (its export buttons are "Download orders", test id `download-orders`, and a decoy
// "Download invoices") and the real executor image with real Chromium, and the worker's real model session answers from the scripted double. It runs only in CI's `linux-runtime` job
// (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE); everywhere else it skips. The same cases run on a developer's machine, without the containers, in
// tests/unit/e2e-executor-agent-run.test.ts. What a case does to the verdict is Task 4.4's: the assertions here are about what the executor leaves.
const outOf = (r: AgentProbeRun) => { if (r.outDir === null) throw new Error(`the run was unavailable: ${whyAgent(r)}`); return r.outDir; };
const downloads = (out: string) => observations(out).filter((item) => item.kind === "download");
const stepObservation = (out: string) => observations(out).filter((item) => item.kind === "step-observation").map((item) => JSON.parse(item.content!) as { kind: string; agent?: { verdict: string; stopCode: string | null; download: string } }).find((item) => item.kind === "agent");
const capture = (out: string) => observations(out).filter((item) => item.kind === "case-capture").map((item) => JSON.parse(item.content!) as { assertions: Array<{ outcome: string; reason: string }> })[0]!;
const REPEATS = Number(process.env.ROVARA_AGENT_REPEATS ?? "20");
const CONCURRENT = 3;

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the agent step on a real Docker host", () => {
  afterAll(removeAgentProbeDirs, 120_000);

  function expectRenamedExport(r: AgentProbeRun) {
    expect(r.run.unavailableReason, whyAgent(r)).toBeNull();
    expect(r.exitCode, whyAgent(r)).toBe(0);
    const out = outOf(r);
    // Exactly one download is captured as evidence, and it is the orders file.
    expect(downloads(out), whyAgent(r)).toHaveLength(1);
    expect(downloads(out)[0]!.mediaType).toBe("text/csv");
    const ledger = r.readLedger();
    expect(ledger, whyAgent(r)).not.toBeNull();
    expect(ledger!.valueKeyId).toBe(e2eAgentValueKeyId(r.valueKey!));
    const step = ledger!.steps[0]!;
    expect(step, whyAgent(r)).toMatchObject({ stepIndex: 1, verdict: "concluded", stopCode: null });
    // The ledger shows one ok tap on the renamed button, found by its test id.
    expect(step.actions.map((action) => [action.tool, action.outcome, action.node?.testId ?? null])).toEqual([["tap", "ok", "download-orders"]]);
    expect(step.actions[0]!.node).toMatchObject({ role: "button", name: "Download orders" });
    expect(step.receiptIds).toEqual(r.receipts.map((receipt) => receipt.receiptId));
    expect(r.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "ok"]);
    expect(parseVerifiedE2EAgentActionLedger(ledger, { goals: new Map([[1, AGENT_GOAL]]), valueKey: r.valueKey!, runId: r.fixture.plan.runId, caseId: r.caseId }).ok).toBe(true);
    expect(stepObservation(out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "captured" });
    expect(caseStatuses(out, r.fixture), whyAgent(r)).toEqual({ "agent-export": "passed" });
    expect(readReport(out).run.project.configDigest).toBe(r.fixture.compiled.shards[0]!.expectedConfigDigest);
    expect(r.closes).toBe(1);
  }

  it("renamed export: 'Export the orders as a CSV file' taps 'Download orders'; one download is captured and the ledger shows one ok tap on download-orders", async () => {
    const r = await runAgentProbe({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] });
    expectRenamedExport(r);
    // Task 4.6a: the passed step leaves exactly one cleaned recording, and the host uploads it with the group's evidence, bound to the ledger it verified.
    const traceDir = join(outOf(r), "agent", "traces");
    expect(readdirSync(traceDir), whyAgent(r)).toHaveLength(1);
    const bytes = readFileSync(join(traceDir, readdirSync(traceDir)[0]!));
    console.log(`E2E_AGENT_TRACE_BYTES ${String(bytes.byteLength)}`);
    const inputs = await r.host.readCollectionInputs(AbortSignal.timeout(30_000));
    const traces = (inputs as { agentModel?: { traces?: Array<{ stepIndex: number; traceBase64: string; binding: { actionCount: number } }> } }).agentModel?.traces;
    expect(traces, whyAgent(r)).toHaveLength(1);
    expect(traces![0]).toMatchObject({ stepIndex: 1, binding: { actionCount: 1 } });
    expect(Buffer.from(traces![0]!.traceBase64, "base64").equals(bytes)).toBe(true);
    // Judged by the host's own credential predicate over every byte of the run's out directory, and by the plain text: the value key and the account credentials are in no file.
    expect(r.credentialsLeaked).toBe(false);
    const everything = allOutputText(outOf(r));
    expect(everything).not.toContain(r.valueKey!);
    for (const account of r.fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
  }, 400_000);

  it(`renamed export, ${String(REPEATS)} times in a row: the same ledger and one download every time (the double is deterministic; Chromium's timing is what this watches)`, async () => {
    for (let start = 0; start < REPEATS; start += CONCURRENT) {
      const batch = await Promise.all(Array.from({ length: Math.min(CONCURRENT, REPEATS - start) }, () => runAgentProbe({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] })));
      for (const r of batch) expectRenamedExport(r);
    }
  }, 2_400_000);

  it("a model that is done without acting gives no download, and the executor records agent-no-download", async () => {
    const r = await runAgentProbe({ script: [{ kind: "done" }] });
    expect(r.exitCode, whyAgent(r)).toBe(1);
    const out = outOf(r);
    expect(downloads(out)).toHaveLength(0);
    expect(stepObservation(out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "agent-no-download" });
    expect(capture(out).assertions[0]).toMatchObject({ outcome: "unavailable", reason: "agent-no-download" });
    expect(r.readLedger()!.steps[0]).toMatchObject({ verdict: "concluded", actions: [] });
  }, 400_000);

  it("a decoy: tapping 'Download invoices' downloads the invoices file, so the csv assertion observes bytes that do not match", async () => {
    const r = await runAgentProbe({ script: [{ kind: "tap", name: /Download invoices/ }, { kind: "done" }] });
    expect(r.exitCode, whyAgent(r)).toBe(1);
    const out = outOf(r);
    expect(downloads(out)).toHaveLength(1);
    const files = readdirSync(join(out, "downloads"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(out, "downloads", files[0]!), "utf8")).toMatch(/^invoice,customer,amount,status\r\n/);
    expect(capture(out).assertions[0]).toMatchObject({ outcome: "failed" });
    expect(r.readLedger()!.steps[0]!.actions[0]).toMatchObject({ node: { name: "Download invoices", testId: "download-invoices" }, outcome: "ok" });
  }, 400_000);

  it("a provider outage: the receipt is provider-error, the step fails with MODEL_PROVIDER_FAILED and the ledger verdict is failed", async () => {
    const r = await runAgentProbe({ script: [{ kind: "fail", message: "provider down" }] });
    expect(r.exitCode, whyAgent(r)).toBe(1);
    expect(r.receipts.map((receipt) => receipt.outcome)).toEqual(["provider-error"]);
    expect(r.readLedger()!.steps[0]).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", actions: [], receiptIds: [r.receipts[0]!.receiptId] });
    expect(JSON.stringify(readReport(outOf(r)))).toContain("MODEL_PROVIDER_FAILED");
  }, 400_000);

  it("a second download in the step records ambiguous-download", async () => {
    const r = await runAgentProbe({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "tap", name: /Download invoices/ }, { kind: "done" }] });
    expect(r.exitCode, whyAgent(r)).toBe(1);
    const out = outOf(r);
    expect(stepObservation(out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "ambiguous-download" });
    expect(capture(out).assertions[0]).toMatchObject({ outcome: "unavailable", reason: "ambiguous-download" });
    expect(downloads(out)).toHaveLength(0);
  }, 400_000);

  it("(l) sends the model requests within the channel's input bound on this fixture, and prints the sizes the seam ruling records", async () => {
    const r = await runAgentProbe({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] });
    expect(r.exitCode, whyAgent(r)).toBe(0);
    console.log(`E2E_AGENT_REQUEST_BYTES ${JSON.stringify(r.requestBytes)}`);
    expect(r.requestBytes.length).toBe(2);
    for (const bytes of r.requestBytes) expect(bytes).toBeLessThanOrEqual(32_000 - 1024);
  }, 400_000);
});
