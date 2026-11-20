import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, type ModelEgress, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressScope } from "@agentx/contracts";
import { bridgeMadeEnd, createBridgedEvalExec as create, EVAL_BRIDGE_CALLS_MAX, type FreshEvalSandbox, type FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { MODEL_BRIDGE_DROP_REASONS } from "../../packages/worker/src/model-bridge.js";
import { collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import type { EvalSandboxRequest } from "../../packages/worker/src/verification/eval-runner.js";
import { answer, frame } from "../support/eval-model-access.js";

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

describe("the token", () => {
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
    // an EXISTING folder named relatively is refused too (the guard, not a missing folder, is what stops it)
    await expect(createBridgedEvalExec({ sandbox: sandboxOf(ok), runDir: relative(process.cwd(), root) }).run(request(e))).rejects.toThrow();
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
  it("counts unknown classifications as changed; only an explicit false proves unchanged", async () => {
    expect((await calls(3, undefined)).changedPromptCalls).toBe(3);
    expect((await calls(3, () => { throw new Error("x"); })).changedPromptCalls).toBe(3);
    expect((await calls(3, (() => "yes") as never)).changedPromptCalls).toBe(3);
    expect((await calls(3, () => false)).changedPromptCalls).toBe(0);
  });
});

describe("what the stage cannot see", () => {
  it("a pin that throws or answers a non-true value allows nothing; no pin at all is a refusal before anything starts", async () => {
    const root = await makeRoot(); const e = egressOf();
    for (const pin of [() => { throw new Error("x"); }, (() => "yes") as never]) {
      await expect(createBridgedEvalExec({ sandbox: sandboxOf(async (input) => { await send(input, frame("x")); return ok(input); }), runDir: root, modelAllowed: pin }).run(request(e))).rejects.toThrow();
    }
    await expect(create({ sandbox: sandboxOf(ok), runDir: root } as never).run(request(e))).rejects.toThrow();
    expect(e.seen).toEqual([]); expect(await readdir(root)).toEqual([]);
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

describe("a drop the bridge makes itself fails the run (EVAL-WIRE-BRIDGE-UNLOGGED-DROPS)", () => {
  const rawTo = (socketPath: string, write: (socket: net.Socket) => void): Promise<void> => new Promise((resolve) => {
    const socket = net.connect(socketPath); socket.on("connect", () => write(socket)); socket.on("close", () => resolve()); socket.on("error", () => undefined);
  });
  it("a request that is not POST /call", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => {
      const status = await new Promise<number>((resolve) => { const r = http.request({ socketPath: input.model.socketPath, method: "GET", path: "/other" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.on("error", () => resolve(0)); r.end(); });
      expect(status).toBe(404);
      return ok(input);
    });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run(request(e))).rejects.toThrow("eval run not clean");
    expect(e.seen).toEqual([]);
  });
  it("a body that goes away before it is whole", async () => {
    const root = await makeRoot(); const e = egressOf();
    const sandbox = sandboxOf(async (input) => {
      await rawTo(input.model.socketPath, (s) => s.write("POST /call HTTP/1.1\r\nhost: b\r\nx-rovara-mode: real\r\ncontent-length: 100000\r\n\r\n{", () => setTimeout(() => s.destroy(), 50)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return ok(input);
    });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run(request(e))).rejects.toThrow("eval run not clean");
  });
  it("an answer the bridge cut (the stage's stream faulted after its head)", async () => {
    const root = await makeRoot();
    const faulty: ModelEgress = { capabilities: { schemes: [] }, async *forward() { yield { kind: "head", status: 200, headers: [["content-type", "application/json"]] }; throw new Error("reset"); } };
    const sandbox = sandboxOf(async (input) => { const answered = await send(input, frame("x")); expect(answered.cut).toBe("fault"); return ok(input); });
    await expect(createBridgedEvalExec({ sandbox, runDir: root }).run({ ...request(egressOf()), egress: faulty })).rejects.toThrow("eval run not clean");
  });
  it("names exactly the bridge-made ends, in fixed words", () => {
    expect(bridgeMadeEnd({ event: "dropped", reason: "gone" })).toBe(true);
    expect(bridgeMadeEnd({ event: "refused", class: "refused" })).toBe(true);
    expect(bridgeMadeEnd({ event: "answer", class: "refused" })).toBe(true);
    expect(bridgeMadeEnd({ event: "call", class: "ok", reason: "time" })).toBe(true);
    expect(bridgeMadeEnd({ event: "call", class: "ok", status: 200 })).toBe(false);
    expect(bridgeMadeEnd({ event: "call", class: "rate_limit", status: 429 })).toBe(false);
    for (const reason of MODEL_BRIDGE_DROP_REASONS) expect(bridgeMadeEnd({ event: "dropped", reason })).toBe(true);
  });
});
