import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type E2EReplayTrace } from "@agentx/contracts";
import { agentRunnable, downloadsOf, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { recordingsOf, runReplayCase, type ReplayRun } from "../support/agent-replay-run.js";
import { asLinuxRun, assembleAgentRun, assembleReplayRun, collectAssembled, firstCase, type AssembledRun } from "../support/agent-collection.js";
import { FIXED_RUNTIME_AT } from "../support/orders-m14-agent.js";

// M1.4 Task 4.6b: the collector reads an audit replay from the runner's account of it. A step is whole only when the runner replayed it in full from the recording it is bound to; any
// other end of an AI navigation step is UNKNOWN with a fixed code; a model call or token anywhere is UNKNOWN `replay-model-called`. The real executor, a real Chromium and the real
// collector, on this machine.
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const plan = { runtimeAt: FIXED_RUNTIME_AT };

describe.runIf(agentRunnable)("the collector reads an audit replay (Task 4.6b)", () => {
  const cleanups: Array<AgentRun | ReplayRun> = [];
  let source: AgentRun; let traces: E2EReplayTrace[]; let whole: ReplayRun; let stale: ReplayRun; let hidden: ReplayRun;
  beforeAll(async () => {
    source = await runAgentCase({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }], plan });
    cleanups.push(source);
    traces = await recordingsOf(source);
    whole = await runReplayCase({ traces, plan }); cleanups.push(whole);
    stale = await runReplayCase({ traces, plan, renamed: true }); cleanups.push(stale);
    const file = JSON.parse(Buffer.from(traces[0]!.traceBase64, "base64").toString("utf8")) as { trace: { actions: unknown[] } };
    file.trace.actions = [{ name: "type", summary: "The type action.", target: { role: "textbox", name: "Search" }, value: `hmac-sha256:${sha("a value the model chose")}` }];
    hidden = await runReplayCase({ traces: [{ ...traces[0]!, traceBase64: Buffer.from(JSON.stringify(file)).toString("base64"), binding: { ...traces[0]!.binding, traceSha256: sha(canonicalJson((file as { trace: unknown }).trace)) } }], plan });
    cleanups.push(hidden);
  }, 900_000);
  afterAll(async () => { await Promise.all(cleanups.splice(0).map((run) => run.cleanup())); });
  const readBack = async (run: ReplayRun) => asLinuxRun(await assembleReplayRun(run));
  /** The run as the Linux executor leaves it, with its raw report edited and the digests the process record keeps of it recomputed (nothing else touched). */
  const withReport = (a: AssembledRun, edit: (report: { run: { usage: Record<string, number>; results: Array<{ attempts: Array<{ steps: Array<Record<string, unknown>> }> }> } }) => void): AssembledRun => {
    const shards = a.actual.shards.map((shard) => {
      const report = JSON.parse(Buffer.from(shard.rawReportBytes).toString("utf8")) as Parameters<typeof edit>[0];
      edit(report);
      const bytes = Buffer.from(JSON.stringify(report));
      return { ...shard, rawReportBytes: bytes, runProcess: { ...shard.runProcess, stdoutSha256: sha(bytes), stdoutBytes: bytes.byteLength } };
    });
    return { ...a, actual: { ...a.actual, shards } };
  };
  const qualificationOf = (a: AssembledRun) => collectAssembled(a).qualification!;

  it("a replay that ran whole is PASS: the agent step is whole (every recorded action replayed), the CSV is the source round's, no model, no receipt", async () => {
    const a = await readBack(whole);
    const collected = collectAssembled(a);
    expect(collected.unavailableReason).toBeNull();
    expect(collected.qualification?.status).toBe("PASS");
    expect(firstCase(collected)?.status).toBe("passed");
    expect(collected.qualification?.result?.modelReceiptIds).toEqual([]);
    const facts = collected.qualification!.caseFacts!;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ caseId: whole.caseId, agentSteps: [{ stepIndex: 1, whole: true, replayedActions: 1, totalActions: 1, stopCode: null }] });
    // The same bytes the candidate's own run downloaded: the CSV hash of the replay is the hash of the file the source round saved, and is the source collection's.
    const sourceFile = readFileSync(join(source.out, "downloads", downloadsOf(source.out)[0]!));
    expect(facts[0]!.csvSha256).toBe(sha(sourceFile));
    const sourceFacts = collectAssembled(asLinuxRun(await assembleAgentRun(source))).qualification!.caseFacts!;
    expect(sourceFacts[0]).toMatchObject({ caseId: source.caseId, csvSha256: sha(sourceFile), agentSteps: [] });
  });

  it("a stale replay is UNKNOWN replay-needs-model: the step was handed to the replay executor and stopped, so nothing was replayed whole and no download was observed", async () => {
    const collected = collectAssembled(await readBack(stale));
    expect(collected.qualification?.status).toBe("UNKNOWN");
    expect(firstCase(collected)).toMatchObject({ status: "unavailable", reason: "replay-needs-model" });
    expect(collected.qualification!.caseFacts![0]).toMatchObject({ csvSha256: null, agentSteps: [{ stepIndex: 1, whole: false, stopCode: "replay-needs-model" }] });
  });

  it("a recording with a hidden value is UNKNOWN typed-value-not-replayable, not replay-needs-model", async () => {
    const collected = collectAssembled(await readBack(hidden));
    expect(collected.qualification?.status).toBe("UNKNOWN");
    expect(firstCase(collected)).toMatchObject({ status: "unavailable", reason: "typed-value-not-replayable" });
    expect(collected.qualification!.caseFacts![0]!.agentSteps).toMatchObject([{ whole: false, stopCode: "typed-value-not-replayable" }]);
  });

  it("test 15: a replay whose report shows a model call, model tokens or a model on a step is UNKNOWN replay-model-called, each on its own", async () => {
    const a = await readBack(whole);
    const edits: Array<[string, Parameters<typeof withReport>[1]]> = [
      ["a model call in the step's metrics", (report) => { (report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!["metrics"] as Record<string, number>)["modelCalls"] = 1; }],
      ["model tokens in the run's usage", (report) => { report.run.usage["modelTokens"] = 12; }],
      ["a model on the step", (report) => { report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!["model"] = { provider: "agentx-e2e", model: "x", endpoint: "x", adapterVersion: "x", policyVersion: "x", calls: 0, tokenAccounting: "provider", peakTokensPerCall: 0, inputTokens: 0, outputTokens: 0 }; }],
    ];
    for (const [label, edit] of edits) {
      const q = qualificationOf(withReport(a, edit));
      expect(q.status, label).toBe("UNKNOWN");
      expect(q.reason, label).toMatch(/^replay-model-called/);
    }
    // Control: the same run unedited is PASS, so each UNKNOWN above is its own edit.
    expect(qualificationOf(a).status).toBe("PASS");
  });

  it("test 15b: model evidence (receipts, ledgers) with a replay is UNKNOWN replay-model-called", async () => {
    const a = await readBack(whole);
    // The evidence a real round with a model produced (receipts, a ledger, the run's key): valid in itself, and it cannot belong to a replay.
    const modelEvidence = (await assembleAgentRun(source)).agentModel;
    expect(modelEvidence.receipts.length).toBeGreaterThan(0);
    const collected = collectAssembled(a, { ...a.inputs, agentModel: modelEvidence });
    expect(collected.qualification?.status).toBe("UNKNOWN");
    expect(collected.unavailableReason).toMatch(/^replay-model-called/);
    // Control: the same inputs without it are PASS.
    expect(collectAssembled(a).qualification?.status).toBe("PASS");
  });

  it("a step that is self-finalized but not in full (fewer actions replayed than recorded), or for another action count than its binding, is not whole", async () => {
    const a = await readBack(whole);
    const fewer = qualificationOf(withReport(a, (report) => { const cache = report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!["cache"] as Record<string, number>; cache["replayedActions"] = 0; }));
    expect(fewer.status).toBe("UNKNOWN");
    expect(fewer.result!.cases[0]!.reason).toBe("replay-needs-model");
    const longer = qualificationOf(withReport(a, (report) => { const cache = report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!["cache"] as Record<string, number>; cache["replayedActions"] = 2; cache["totalActions"] = 2; }));
    expect(longer.status).toBe("UNKNOWN");
    expect(longer.result!.cases[0]!.reason).toBe("replay-needs-model");
    // Another cache entry than the one the step is bound to is not it either.
    const other = qualificationOf(withReport(a, (report) => { (report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!["cache"] as Record<string, unknown>)["entry"] = sha("another entry"); }));
    expect(other.status).toBe("UNKNOWN");
  });

  it("a candidate round is read exactly as before: a cached step is still refused there (the replay allowance is the oracle's, never the report's)", async () => {
    // The source round's report with its agent step shown as replayed: in a candidate round (no `replay` in the oracle) any replayed step is refused, as before this task.
    const a = asLinuxRun(await assembleAgentRun(source));
    const edited = withReport(a, (report) => { (report.run.results[0]!.attempts[0]!.steps.find((step) => step["kind"] === "agent")!)["cache"] = { mode: "self-finalized", replayedActions: 1, totalActions: 1, entry: "e".repeat(64) }; });
    const collected = collectAssembled(edited);
    expect(collected.qualification?.status).toBe("UNKNOWN");
    // Refused for the reason it always was: the report is cached.
    expect(collected.unavailableReason).toMatch(/flaky, incomplete, cached/);
    // Control: the same run unedited is PASS.
    expect(collectAssembled(a).qualification?.status).toBe("PASS");
  });
});
