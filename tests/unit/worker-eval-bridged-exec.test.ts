// The eval's sandbox exec over the real F1-c bridge, with a FAKE fresh sandbox that speaks to the bridge's socket as the helper would. No Docker, no network, no model.
// Rules: one bridge per run in a private folder; the egress is the stage's call; the token is made for this run, forwarding only, and gone when the run ends; the folder and
// socket are removed however the run ends; the changed prompt is counted by the worker's own classifier, never on the sandbox's word.
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, type ModelEgress, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressScope } from "@agentx/contracts";
import { createBridgedEvalExec as create, EVAL_BRIDGE_CALLS_MAX, type FreshEvalSandbox, type FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import type { EvalSandboxRequest } from "../../packages/worker/src/verification/eval-runner.js";
import { answer, classAnswer, frame } from "../support/eval-model-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const makeRoot = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), "eb-")); roots.push(root); return root; };
const location = { root: "/r", cwd: ".", argument: "report.json", notBeforeMs: 1 };
const scope = Object.freeze({}) as unknown as ModelEgressScope;
const createBridgedEvalExec = (o: Omit<Parameters<typeof create>[0], "modelAllowed"> & { modelAllowed?: Parameters<typeof create>[0]["modelAllowed"] }) => create({ modelAllowed: () => true, ...o });
const send = (run: FreshEvalSandboxRun, f: ModelEgressFrame, token = run.model.token) => collectModelBridge({ socketPath: run.model.socketPath, mode: "real", token, frame: { ...f } });

interface Egress { readonly egress: ModelEgress; readonly seen: ModelEgressFrame[]; readonly scopes: ModelEgressScope[] }
function egressOf(script: (f: ModelEgressFrame, index: number) => readonly ModelEgressEvent[] = () => answer()): Egress {
  const seen: ModelEgressFrame[] = []; const scopes: ModelEgressScope[] = [];
  return { seen, scopes, egress: { capabilities: { schemes: [] }, async *forward(s, f) { scopes.push(s); seen.push(f); yield* script(f, seen.length - 1); } } };
}
const request = (e: Egress, over: Partial<EvalSandboxRequest> = {}): EvalSandboxRequest => ({ side: "new", ids: ["q1"], runs: 1, egress: e.egress, scope, signal: new AbortController().signal, ...over });
function sandboxOf(run: (input: FreshEvalSandboxRun) => Promise<unknown>, available = true): FreshEvalSandbox & { inputs: FreshEvalSandboxRun[] } {
  const inputs: FreshEvalSandboxRun[] = [];
  return { inputs, available: () => available, run: async (input) => { inputs.push(input); return (await run(input)) as never; } };
}
const ok = (input: FreshEvalSandboxRun) => Promise.resolve({ report: location, ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: "a".repeat(40) }) } : {}) });

describe("one bridge per run", () => {
  it("hands the sandbox a socket and a token, and every call it sends is the stage's egress, once, under the stage's scope", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => { const answered = await send(input, frame("one")); expect(answered.status).toBe(200); expect(answered.settle).toMatchObject({ class: "ok", costMicros: 10 }); return ok(input); });
    const result = await createBridgedEvalExec({ sandbox, runDir: root }).run(request(e));
    expect(result).toEqual({ report: location, changedPromptCalls: 0 });
    expect(e.seen).toHaveLength(1); expect(e.scopes).toEqual([scope]);
    expect(Object.keys(sandbox.inputs[0]!).sort()).toEqual(["ids", "model", "runs", "side", "signal"]);
    expect(Object.keys(sandbox.inputs[0]!.model).sort()).toEqual(["socketPath", "token"]);
  });
  it("makes the folder private and the socket mode 0600 while the run is open; both are gone when it ends", async () => {
    const root = await makeRoot(); let folder = ""; let socketMode = 0; let folderMode = 0;
    const sandbox = sandboxOf(async (input) => {
      folder = join(input.model.socketPath, "..");
      socketMode = statSync(input.model.socketPath).mode & 0o777; folderMode = statSync(folder).mode & 0o777;
      expect(folder.startsWith(root)).toBe(true);
      return ok(input);
    });
    await createBridgedEvalExec({ sandbox, runDir: root }).run(request(egressOf()));
    expect(socketMode).toBe(0o600); expect(folderMode).toBe(0o700);
    expect(existsSync(folder)).toBe(false); expect(await readdir(root)).toEqual([]);
  });
  it("two runs never share a folder, a socket or a token", async () => {
    const root = await makeRoot(); const sandbox = sandboxOf(async (input) => { await new Promise((resolve) => setTimeout(resolve, 20)); return ok(input); });
    const exec = createBridgedEvalExec({ sandbox, runDir: root });
    await Promise.all([exec.run(request(egressOf())), exec.run(request(egressOf(), { side: "old" }))]);
    expect(new Set(sandbox.inputs.map((i) => i.model.socketPath)).size).toBe(2);
    expect(new Set(sandbox.inputs.map((i) => i.model.token)).size).toBe(2);
  });
});

describe("the token", () => {
  it("is for this run only: a forged token and no token are refused and reach no egress", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => {
      const forged = await send(input, frame("x"), "f".repeat(32));
      expect(forged.status).toBe(403); expect(forged.settle).toMatchObject({ refusal: "not_allowed" });
      const none = await collectModelBridge({ socketPath: input.model.socketPath, mode: "real", frame: { ...frame("x") } });
      expect(none.status).toBe(403); expect(none.settle).toMatchObject({ refusal: "not_allowed" });
      return ok(input);
    });
    // the bridge's own refusals never reached the stage, so the run is failed (Not run), whatever the sandbox wrote
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run(request(e))).rejects.toThrow();
    expect(e.seen).toEqual([]);
  });
  it("is a forwarding token of the check round only: replay mode and a no-token real call never reach the egress", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => {
      const replay = await collectModelBridge({ socketPath: input.model.socketPath, mode: "replay", frame: { ...frame("x") } });
      expect(replay.settle?.class).not.toBe("ok");
      return ok(input);
    });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run(request(e))).rejects.toThrow();
    expect(e.seen).toEqual([]);
  });
  it("stops working when the run ends, whether it ended well or the sandbox threw, and the socket is gone", async () => {
    const root = await makeRoot(); let kept: FreshEvalSandboxRun | undefined;
    const exec = createBridgedEvalExec({ sandbox: sandboxOf(async (input) => { kept = input; return ok(input); }), runDir: root });
    await exec.run(request(egressOf()));
    await expect(send(kept!, frame("late"))).rejects.toThrow();
    const failing = createBridgedEvalExec({ sandbox: sandboxOf(async (input) => { kept = input; throw new Error("boom"); }), runDir: root });
    await expect(failing.run(request(egressOf()))).rejects.toThrow();
    await expect(send(kept!, frame("late"))).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it("a sandbox that returns with a call still open fails the run, the call is cut off at once, and nothing more reaches the egress", async () => {
    const root = await makeRoot(); let release: () => void = () => undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: ModelEgressFrame[] = []; let client: Promise<unknown> = Promise.resolve();
    const slow: ModelEgress = { capabilities: { schemes: [] }, async *forward(_s, f, options) { seen.push(f); await Promise.race([gate, new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()))]); yield* answer(); } };
    const sandbox = sandboxOf(async (input) => { client = send(input, frame("hang")).catch(() => "cut"); await new Promise((resolve) => setTimeout(resolve, 50)); return ok(input); });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run({ ...request(egressOf()), egress: slow })).rejects.toThrow();
    // closing the bridge cut the client's call: it ends without anyone releasing the egress
    const ended = await Promise.race([client.then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))]);
    expect(ended).toBe("ended");
    release();
    expect(seen).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("refusals before anything starts", () => {
  it("no fresh sandbox, a relative folder, an aborted signal and a sandbox with no run all throw before a folder or a socket exists", async () => {
    const root = await makeRoot(); const e = egressOf();
    await expect(createBridgedEvalExec({ sandbox: sandboxOf(ok, false), runDir: root }).run(request(e))).rejects.toThrow();
    await expect(createBridgedEvalExec({ sandbox: sandboxOf(ok), runDir: "relative/dir" }).run(request(e))).rejects.toThrow();
    const stop = new AbortController(); stop.abort();
    await expect(createBridgedEvalExec({ sandbox: sandboxOf(ok), runDir: root }).run(request(e, { signal: stop.signal }))).rejects.toThrow();
    await expect(createBridgedEvalExec({ sandbox: {} as never, runDir: root }).run(request(e))).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it("a folder path too long for a socket is a refusal, with the folder removed", async () => {
    const root = await makeRoot();
    const long = join(root, "x".repeat(90)); const { mkdir } = await import("node:fs/promises"); await mkdir(long);
    await expect(createBridgedEvalExec({ sandbox: sandboxOf(ok), runDir: long }).run(request(egressOf()))).rejects.toThrow();
    expect(await readdir(long)).toEqual([]);
  });
});

describe("the changed prompt is the worker's own count", () => {
  const calls = async (sandboxCalls: number, classifier: ((f: ModelEgressFrame) => boolean) | undefined, script?: (f: ModelEgressFrame, i: number) => readonly ModelEgressEvent[]) => {
    const root = await makeRoot();
    const sandbox = sandboxOf(async (input) => { for (let i = 0; i < sandboxCalls; i++) await send(input, frame(`call-${String(i)}`)); return ok(input); });
    return createBridgedEvalExec({ sandbox, runDir: root, ...(classifier === undefined ? {} : { changedPrompt: classifier }) }).run(request(egressOf(script)));
  };
  it("counts only the settled-ok calls the classifier names", async () => {
    const named = (f: ModelEgressFrame) => new TextDecoder().decode(f.body).endsWith("1") || new TextDecoder().decode(f.body).endsWith("2");
    expect((await calls(4, named)).changedPromptCalls).toBe(2);
    // call-2 fails (provider error): it is not an exercised prompt
    expect((await calls(4, named, (_f, i) => (i === 2 ? classAnswer("provider_error", 502) : answer()))).changedPromptCalls).toBe(1);
  });
  it("is 0 with no classifier, and a classifier that throws or answers a non-true value counts nothing", async () => {
    expect((await calls(3, undefined)).changedPromptCalls).toBe(0);
    expect((await calls(3, () => { throw new Error("x"); })).changedPromptCalls).toBe(0);
    expect((await calls(3, (() => "yes") as never)).changedPromptCalls).toBe(0);
  });
  it("the sandbox cannot raise it: its own result field is ignored", async () => {
    const root = await makeRoot();
    const sandbox = sandboxOf(async (input) => ({ ...(await ok(input)), changedPromptCalls: 99 }));
    expect((await createBridgedEvalExec({ sandbox, runDir: root, changedPrompt: () => true }).run(request(egressOf()))).changedPromptCalls).toBe(0);
  });
});

describe("the result", () => {
  it("carries the attestation for the old side only, never for the new side", async () => {
    const root = await makeRoot(); const attestation = attestRovaraOnlyBaseCheckout({ baseCommit: "a".repeat(40) });
    const both = sandboxOf(async () => ({ report: location, attestation }));
    const exec = createBridgedEvalExec({ sandbox: both, runDir: root });
    expect((await exec.run(request(egressOf(), { side: "old" }))).attestation).toBe(attestation);
    expect(await exec.run(request(egressOf(), { side: "new" }))).not.toHaveProperty("attestation");
  });
});

describe("what the stage cannot see", () => {
  it("more calls open at once than the bridge's old default of four are queued by the stage, not refused: all answered, the run is clean", async () => {
    const root = await makeRoot(); const seen: ModelEgressFrame[] = [];
    const slow: ModelEgress = { capabilities: { schemes: [] }, async *forward(_s, f) { seen.push(f); await new Promise((resolve) => setTimeout(resolve, 30)); yield* answer(); } };
    const sandbox = sandboxOf(async (input) => { const all = await Promise.all(Array.from({ length: 12 }, (_, i) => send(input, frame(`p${String(i)}`)))); expect(all.map((a) => a.status)).toEqual(Array(12).fill(200)); return ok(input); });
    await createBridgedEvalExec({ sandbox, runDir: root }).run({ ...request(egressOf()), egress: slow });
    expect(seen).toHaveLength(12);
  });
  it("the model is the worker's pin: a frame it does not name never reaches the stage, the sandbox sees a failure, and the run is Not run", async () => {
    const root = await makeRoot(); const e = egressOf(); let status = 0;
    const sandbox = sandboxOf(async (input) => { status = (await send(input, frame("x"))).status!; return ok(input); });
    await expect(createBridgedEvalExec({ sandbox, runDir: root, modelAllowed: () => false }).run(request(e))).rejects.toThrow();
    expect(status).not.toBe(200); expect(e.seen).toEqual([]);
  });
  it("a pin that throws or answers a non-true value allows nothing; no pin at all is a refusal before anything starts", async () => {
    const root = await makeRoot(); const e = egressOf();
    for (const pin of [() => { throw new Error("x"); }, (() => "yes") as never]) {
      await expect(createBridgedEvalExec({ sandbox: sandboxOf(async (input) => { await send(input, frame("x")); return ok(input); }), runDir: root, modelAllowed: pin }).run(request(e))).rejects.toThrow();
    }
    await expect(create({ sandbox: sandboxOf(ok), runDir: root } as never).run(request(e))).rejects.toThrow();
    expect(e.seen).toEqual([]); expect(await readdir(root)).toEqual([]);
  });
  it("a call that fails at the stage (its own refusal) is the stage's to mark, and does not fail the run by itself", async () => {
    const root = await makeRoot();
    const sandbox = sandboxOf(async (input) => { await send(input, frame("x")); return ok(input); });
    await createBridgedEvalExec({ sandbox, runDir: root }).run(request(egressOf(() => classAnswer("rate_limit", 429))));
  });
});

describe("limits", () => {
  it("the bridge's own call limit is far above the default of 200, so the stage's hold is the line that decides", async () => {
    expect(EVAL_BRIDGE_CALLS_MAX).toBeGreaterThanOrEqual(2000);
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => { for (let i = 0; i < 210; i += 1) expect((await send(input, frame(`c${String(i)}`))).status).toBe(200); return ok(input); });
    await createBridgedEvalExec({ sandbox, runDir: root }).run(request(e));
    expect(e.seen).toHaveLength(210);
  });
  it("a row that is not a plain catalog word is refused by the bridge and reaches no egress", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => { const refused = await send(input, { ...frame("x"), row: "Bad Row!" }); expect(refused.status).not.toBe(200); return ok(input); });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run(request(e))).rejects.toThrow();
    expect(e.seen).toEqual([]);
  });
});
