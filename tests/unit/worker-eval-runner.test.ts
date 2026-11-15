// The glue between the sandbox exec and the metered stage: the eval process's model traffic reaches the stage's `call` and
// nothing else, a failed call is a refusal the client can read, and the exec's answer is checked at runtime.
import { describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_SCHEMES, type EvalMeterCall, type ModelEgressEvent } from "@agentx/contracts";
import { createEvalRunner, modelEgressFromEvalCall, type EvalSandboxExec } from "../../packages/worker/src/verification/eval-runner.js";
import { answer, frame } from "../support/eval-model-access.js";

const scope = {} as never;
const collect = async (iter: AsyncIterable<ModelEgressEvent>) => { const out: ModelEgressEvent[] = []; for await (const e of iter) out.push(e); return out; };
const okCall = (): EvalMeterCall => ({ class: "ok", calls: 1, costMicros: 10, events: answer() });
const location = { root: "/r", cwd: ".", argument: "report.json", notBeforeMs: 5 };
const base = "a".repeat(40);

describe("modelEgressFromEvalCall", () => {
  it("lists every credential scheme so the bridge refuses no row by name", () => {
    expect(modelEgressFromEvalCall(async () => okCall()).capabilities.schemes).toEqual([...MODEL_EGRESS_SCHEMES]);
  });
  it("replays the stage's own events, in order, for a good call", async () => {
    const f = frame("hi"); const seen: unknown[] = [];
    const egress = modelEgressFromEvalCall(async x => { seen.push(x); return okCall(); });
    expect(await collect(egress.forward(scope, f))).toEqual(answer());
    expect(seen).toEqual([f]);
  });
  it("answers a failed call with a readable refusal and never throws or repeats the cause", async () => {
    const egress = modelEgressFromEvalCall(async () => { throw new Error("key-CANARY provider words"); });
    const events = await collect(egress.forward(scope, frame()));
    expect(events.map(e => e.kind)).toEqual(["head", "chunk", "settle"]);
    expect(events[0]).toMatchObject({ kind: "head", status: 503 });
    expect((events[0] as unknown as { headers: Array<[string, string]> }).headers).toContainEqual([MODEL_EGRESS_REFUSAL_HEADER, "not_allowed"]);
    expect(events[2]).toMatchObject({ kind: "settle", status: 503, class: "refused", refusal: "not_allowed", costMicros: 0, estimated: false });
    expect(JSON.stringify(events)).not.toContain("CANARY");
  });
  it("treats a good-looking result with no events as a refusal", async () => {
    const events = await collect(modelEgressFromEvalCall(async () => ({ class: "ok", calls: 1, costMicros: 1 })).forward(scope, frame()));
    expect(events[2]).toMatchObject({ kind: "settle", class: "refused" });
  });
  it("makes no call once its signal has aborted", async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const events = await collect(modelEgressFromEvalCall(async () => { calls++; return okCall(); }).forward(scope, frame(), { signal: controller.signal }));
    expect(calls).toBe(0); expect(events[2]).toMatchObject({ kind: "settle", class: "refused" });
  });
});

describe("createEvalRunner", () => {
  const request = (over: Record<string, unknown> = {}) => ({ side: "new" as const, ids: ["q1", "q2"], runs: 1 as const, call: async () => okCall(), signal: new AbortController().signal, ...over });
  const exec = (run: EvalSandboxExec["run"]): EvalSandboxExec => ({ run });

  it("hands the exec the side, the ids and an egress that charges the stage's call", async () => {
    const charged: unknown[] = []; let seen: Parameters<EvalSandboxExec["run"]>[0] | undefined;
    const runner = createEvalRunner(exec(async r => { seen = r; await collect(r.egress.forward(r.scope, frame("q"))); return { report: location, changedPromptCalls: 2 }; }));
    const result = await runner(request({ call: async (f: unknown) => { charged.push(f); return okCall(); } }));
    expect(seen).toMatchObject({ side: "new", ids: ["q1", "q2"], runs: 1 });
    expect(charged).toHaveLength(1);
    expect(result).toMatchObject({ report: location, changedPromptCalls: 2 });
  });
  it("reports every case as run when the exec finished (a failed call stops the stage before this)", async () => {
    const result = await createEvalRunner(exec(async () => ({ report: location, changedPromptCalls: 1 })))(request({ ids: ["a", "b", "c"], runs: 3 }));
    expect(result.facts).toEqual({ total: 9, run: 9, notRun: 0, byClass: {}, overrunStop: false });
  });
  it("keeps a genuine base-checkout attestation on the old side and drops it on the new side", async () => {
    const attestation = attestRovaraOnlyBaseCheckout({ baseCommit: base });
    const runner = createEvalRunner(exec(async () => ({ report: location, changedPromptCalls: 1, attestation })));
    expect((await runner(request({ side: "old" }))).attestation).toBe(attestation);
    expect((await runner(request({ side: "new" }))).attestation).toBeUndefined();
  });
  it("does not accept a plain object as an attestation", async () => {
    const runner = createEvalRunner(exec(async () => ({ report: location, changedPromptCalls: 1, attestation: { checkout: "rovara_only", workingSandboxPaused: true, baseCommit: base } as never })));
    expect((await runner(request({ side: "old" }))).attestation).toBeUndefined();
  });
  it("never starts the exec on a signal that already aborted", async () => {
    let started = false; const controller = new AbortController(); controller.abort();
    await expect(createEvalRunner(exec(async () => { started = true; return { report: location, changedPromptCalls: 1 }; }))(request({ signal: controller.signal }))).rejects.toThrow("eval stage stopped");
    expect(started).toBe(false);
  });
  it("turns an exec failure into one fixed error with no cause text", async () => {
    const error = await createEvalRunner(exec(async () => { throw new Error("docker stderr with key-CANARY"); }))(request()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("eval run failed"); expect(JSON.stringify(error)).not.toContain("CANARY");
  });
  it.each([
    ["no report", { changedPromptCalls: 1 }], ["a report without a root", { report: { ...location, root: undefined }, changedPromptCalls: 1 }],
    ["a report with a non-text argument", { report: { ...location, argument: 7 }, changedPromptCalls: 1 }],
    ["a negative changed-call count", { report: location, changedPromptCalls: -1 }], ["a fractional changed-call count", { report: location, changedPromptCalls: 1.5 }],
    ["a missing changed-call count", { report: location }], ["a null result", null],
  ])("refuses %s as unreadable", async (_name, result) => {
    await expect(createEvalRunner(exec(async () => result as never))(request())).rejects.toThrow("eval run unreadable");
  });
  it.each([[0], [1_001]])("refuses %i question ids before the exec starts", async count => {
    let started = false;
    await expect(createEvalRunner(exec(async () => { started = true; return { report: location, changedPromptCalls: 1 }; }))(request({ ids: Array.from({ length: count }, (_, i) => `q${i}`) }))).rejects.toThrow("eval run unreadable");
    expect(started).toBe(false);
  });
  it("is given its own copy of the ids", async () => {
    const ids = ["q1"]; let given: readonly string[] = [];
    await createEvalRunner(exec(async r => { given = r.ids; return { report: location, changedPromptCalls: 1 }; }))(request({ ids }));
    ids.push("q2"); expect(given).toEqual(["q1"]);
  });
  it("hands no reservation to the exec: only the egress path is open", async () => {
    let keys: string[] = [];
    await createEvalRunner(exec(async r => { keys = Object.keys(r).sort(); return { report: location, changedPromptCalls: 1 }; }))(request());
    expect(keys).toEqual(["egress", "ids", "runs", "scope", "side", "signal"]);
  });
});
