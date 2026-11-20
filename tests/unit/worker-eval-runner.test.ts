// The glue between the sandbox exec and the metered stage: the eval process's model traffic reaches the stage's `call` and
// nothing else, a failed call is a refusal the client can read, and the exec's answer is checked at runtime.
import { describe, expect, it } from "vitest";
import { type EvalMeterCall, type ModelEgressEvent } from "@agentx/contracts";
import { createEvalRunner, modelEgressFromEvalCall, type EvalSandboxExec } from "../../packages/worker/src/verification/eval-runner.js";
import { answer, frame } from "../support/eval-model-access.js";

const scope = {} as never;
const collect = async (iter: AsyncIterable<ModelEgressEvent>) => { const out: ModelEgressEvent[] = []; for await (const e of iter) out.push(e); return out; };
const okCall = (): EvalMeterCall => ({ class: "ok", calls: 1, costMicros: 10, events: answer() });
const location = { root: "/r", cwd: ".", argument: "report.json", notBeforeMs: 5 };

describe("modelEgressFromEvalCall", () => {
  it("makes no call once its signal has aborted", async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const events = await collect(modelEgressFromEvalCall(async () => { calls++; return okCall(); }).forward(scope, frame(), { signal: controller.signal }));
    expect(calls).toBe(0); expect(events[2]).toMatchObject({ kind: "settle", class: "refused" });
  });
});

describe("createEvalRunner", () => {
  const request = (over: Record<string, unknown> = {}) => ({ side: "new" as const, ids: ["q1", "q2"], runs: 1 as const, call: async () => okCall(), signal: new AbortController().signal, ...over });
  const exec = (run: EvalSandboxExec["run"]): EvalSandboxExec => ({ run });

  it("never starts the exec on a signal that already aborted", async () => {
    let started = false; const controller = new AbortController(); controller.abort();
    await expect(createEvalRunner(exec(async () => { started = true; return { report: location, changedPromptCalls: 1 }; }))(request({ signal: controller.signal }))).rejects.toThrow("eval stage stopped");
    expect(started).toBe(false);
  });
  it.each([0])("refuses %j runs before the exec starts", async runs => {
    let started = false;
    await expect(createEvalRunner(exec(async () => { started = true; return { report: location, changedPromptCalls: 1 }; }))(request({ runs }))).rejects.toThrow("eval run unreadable");
    expect(started).toBe(false);
  });
  it.each([
    ["no report", { changedPromptCalls: 1 }],
  ])("refuses %s as unreadable", async (_name, result) => {
    await expect(createEvalRunner(exec(async () => result as never))(request())).rejects.toThrow("eval run unreadable");
  });
  it.each([[0]])("refuses %i question ids before the exec starts", async count => {
    let started = false;
    await expect(createEvalRunner(exec(async () => { started = true; return { report: location, changedPromptCalls: 1 }; }))(request({ ids: Array.from({ length: count }, (_, i) => `q${i}`) }))).rejects.toThrow("eval run unreadable");
    expect(started).toBe(false);
  });
});
