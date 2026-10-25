import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, type E2EReplayTrace } from "@agentx/contracts";
import { agentRunnable, downloadsOf, executorLog, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { recordingsOf, runReplayCase, type ReplayRun } from "../support/agent-replay-run.js";
import { allOutputText, observations, readReport } from "../support/e2e-executor-output.js";
import { FIXED_RUNTIME_AT } from "../support/orders-m14-agent.js";

// M1.4 Task 4.6b on this machine (tests 9, 12, 13, 14 at the executor): the real executor, the pinned CLI and a real Chromium replay the recording a candidate run left, with no model
// channel at all (there is no socket in these runs to dial).
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const runs: Array<AgentRun | ReplayRun> = [];
afterEach(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });
const plan = { runtimeAt: FIXED_RUNTIME_AT };
const sourceRun = async () => {
  const source = await runAgentCase({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }], plan });
  runs.push(source);
  expect(source.result.exitCode, executorLog(source.out)).toBe(0);
  return source;
};
const replayRun = async (...args: Parameters<typeof runReplayCase>) => { const replay = await runReplayCase(...args); runs.push(replay); return replay; };
const agentStepOf = (out: string) => (readReport(out).run.results[0]!.attempts[0]!.steps as unknown as Array<Record<string, unknown>>).find((step) => step["kind"] === "agent")!;
const agentObservation = (out: string) => observations(out).filter((item) => item.kind === "step-observation").map((item) => JSON.parse(item.content!) as { kind: string; agent?: { verdict: string; stopCode: string | null; download: string } })
  .find((item) => item.kind === "agent");
const SOURCE_CSV = "id,customer,total,state,inventory\r\na1,Ada,12.5,ready,unavailable\r\na2,Grace,23,ready,unavailable\r\n";

describe.runIf(agentRunnable)("an audit replay on this machine", () => {
  it("replays the recording of the renamed export whole: the same CSV is downloaded, the agent step is self-finalized with every action replayed, and no model was involved (test 9)", async () => {
    const source = await sourceRun();
    const traces = await recordingsOf(source);
    expect(traces).toHaveLength(1);
    const replay = await replayRun({ traces, plan });
    expect(replay.result, executorLog(replay.out)).toEqual({ exitCode: 0, reason: null });
    const downloads = downloadsOf(replay.out);
    expect(downloads).toHaveLength(1);
    // The same bytes the candidate's own run downloaded.
    expect(readFileSync(join(replay.out, "downloads", downloads[0]!), "utf8")).toBe(SOURCE_CSV);
    expect(sha(readFileSync(join(replay.out, "downloads", downloads[0]!)))).toBe(sha(readFileSync(join(source.out, "downloads", downloadsOf(source.out)[0]!))));
    const step = agentStepOf(replay.out);
    expect(step["cache"]).toMatchObject({ mode: "self-finalized", replayedActions: 1, totalActions: 1 });
    expect((step["cache"] as { replayedActions: number }).replayedActions).toBe(traces[0]!.binding.actionCount);
    // No model: the runner reports no call and no token, and records no model on the step.
    expect(step["metrics"]).toMatchObject({ modelCalls: 0, actionSteps: 1 });
    expect(step["model"]).toBeUndefined();
    expect(readReport(replay.out).run.usage).toMatchObject({ modelTokens: 0, maxModelCallsInStep: 0 });
    expect(agentObservation(replay.out)?.agent).toEqual({ verdict: "concluded", stopCode: null, download: "captured" });
    // No ledger and no capture were written (the replay port has none), and nothing the replay wrote holds the model route or a value key.
    expect(existsSync(join(replay.out, "agent"))).toBe(false);
    expect(allOutputText(replay.out)).not.toContain("rovara-scripted");
  }, 300_000);

  it("a stale replay (the candidate renamed the button) hands the step to the replay executor, which stops it: replay-needs-model, no download, no model, no receipt (test 12)", async () => {
    const source = await sourceRun();
    const replay = await replayRun({ traces: await recordingsOf(source), plan, renamed: true });
    expect(replay.result.exitCode, executorLog(replay.out)).toBe(1);
    expect(downloadsOf(replay.out)).toEqual([]);
    const step = agentStepOf(replay.out);
    expect(step["status"]).toBe("blocked");
    expect(step["cache"]).toMatchObject({ mode: "missed" });
    expect(step["metrics"]).toMatchObject({ modelCalls: 0 });
    expect(step["model"]).toBeUndefined();
    expect(agentObservation(replay.out)?.agent).toEqual({ verdict: "failed", stopCode: "replay-needs-model", download: "not-applicable" });
    expect(existsSync(join(replay.out, "agent"))).toBe(false);
  }, 300_000);

  it("a recording that holds a value the model chose is never served: the step ends typed-value-not-replayable and nothing is replayed (test 13)", async () => {
    const source = await sourceRun();
    const [recorded] = await recordingsOf(source);
    const file = JSON.parse(Buffer.from(recorded!.traceBase64, "base64").toString("utf8")) as { schemaVersion: string; keyHash: string; trace: { actions: Array<Record<string, unknown>> } };
    file.trace.actions = [{ name: "type", summary: "The type action.", target: { role: "textbox", name: "Search" }, value: `hmac-sha256:${sha("a value the model chose")}` }];
    const hidden: E2EReplayTrace = { ...recorded!, traceBase64: Buffer.from(JSON.stringify(file)).toString("base64"), binding: { ...recorded!.binding, traceSha256: sha(canonicalJson(file.trace)) } };
    const replay = await replayRun({ traces: [hidden], plan });
    expect(replay.result.exitCode, executorLog(replay.out)).toBe(1);
    expect(downloadsOf(replay.out)).toEqual([]);
    expect(agentObservation(replay.out)?.agent).toEqual({ verdict: "failed", stopCode: "typed-value-not-replayable", download: "not-applicable" });
    expect(agentStepOf(replay.out)["metrics"]).toMatchObject({ modelCalls: 0, actionSteps: 0 });
  }, 300_000);

  it("a recording edited in the executor plan (the signed admission still binds the original) is a miss: nothing is replayed (test 14)", async () => {
    const source = await sourceRun();
    const traces = await recordingsOf(source);
    const replay = await replayRun({ traces, plan, editPlan: (original) => {
      const copy = JSON.parse(JSON.stringify(original)) as { replay: { traces: Array<{ traceBase64: string }> } };
      const file = JSON.parse(Buffer.from(copy.replay.traces[0]!.traceBase64, "base64").toString("utf8")) as { trace: { endPath?: string } };
      file.trace.endPath = "/elsewhere";
      copy.replay.traces[0]!.traceBase64 = Buffer.from(JSON.stringify(file)).toString("base64");
      return copy;
    } });
    expect(replay.result.exitCode, executorLog(replay.out)).toBe(1);
    expect(downloadsOf(replay.out)).toEqual([]);
    expect(agentStepOf(replay.out)["cache"]).toMatchObject({ mode: "missed", reason: "no-entry" });
    expect(agentObservation(replay.out)?.agent?.stopCode).toBe("replay-needs-model");
  }, 300_000);
});
