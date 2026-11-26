// The setup run never hangs on its model (setup-run-hang, prod P1): a provider error that the session's retries could not cure ends the run with words; a model call that never answers is ended by the
// stall bound; a session that never confirms its abort is no longer waited for (the wall clock, a person's Stop and the stall all end the run); a command that runs long is not a stall.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, StandInWriterInputSchema, standInWriterCeilingCents, type SetupAgentLimits } from "../../packages/contracts/src/index.js";
import { runStandInWriter, standInCeilingPrice } from "../../packages/worker/src/standin-writer.js";
import { runSetupAgent, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import { SETUP_HANG_WORDS, createSetupWatchdog } from "../../packages/worker/src/setup-agent-watchdog.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "a".repeat(40);
const ANSWER = {
  setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }],
  tests: [{ repo: "web", commands: ["npm test"], from: [{ kind: "ci", repo: "web", path: ".github/workflows/ci.yml", line: 5, quote: "run: npm test" }] }],
};
const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
const never = (): Promise<never> => new Promise<never>(() => undefined);
const turnEnd = (message: Record<string, unknown>) => ({ type: "message_end", message: { role: "assistant", usage: { input: 1000 }, ...message } });

interface Rig { input: SetupRunInput; progress: string[]; order: string[]; control: () => { abort(): Promise<void> } | undefined }

/** `prompt` is what the fake session does on each prompt; `abort` what it does when asked to stop. */
async function rig(options: { prompt: (emit: (event: unknown) => void, bash: BashOperations, n: number) => Promise<void>; abort?: () => Promise<void>; ports?: Partial<SetupRunPorts>; limits?: Partial<SetupAgentLimits> }): Promise<Rig> {
  const rootPath = await mkdtemp(join(tmpdir(), "setup-hang-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const progress: string[] = [];
  const order: string[] = [];
  let control: { abort(): Promise<void> } | undefined;
  let prompts = 0;
  const listeners: Array<(event: unknown) => void> = [];
  const emit = (event: unknown): void => { for (const listener of listeners) listener(event); };
  let bash: BashOperations | undefined;
  const base: BashOperations = { exec: async (_command, _cwd, opts) => { opts.onData(Buffer.from("ok\n")); await new Promise((resolve) => setTimeout(resolve, 5)); return { exitCode: 0 }; } };
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f", prompt: async () => { prompts += 1; await options.prompt(emit, bash!, prompts); },
    steer: async () => undefined, isStreaming: () => true, abort: async () => { order.push("abort"); await options.abort?.(); },
    getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0.05, tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, total: 1010 } }) as never, subscribe: (listener) => { listeners.push(listener); return () => undefined; }, dispose: () => { order.push("session.dispose"); },
  };
  const network: RunNetwork = { name: "n", subnet: "172.29.9.0/24", gateway: "172.29.9.1", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => [], stop: async () => { order.push("network.stop"); } };
  const ports: SetupRunPorts = {
    startNetwork: async () => network,
    createSandbox: () => ({ bashOperations: () => base, dispose: async () => { order.push("sandbox.dispose"); }, fileOpsTarget: () => ({}) }) as never,
    openSession: async (parts) => { bash = parts.bashOperations; return session; },
    callback: async (body) => ((body as { kind: string }).kind === "poll" ? { hosts: [] } : { ok: true }),
    progress: async (message) => { progress.push(message); },
    register: (c) => { control = c; return () => undefined; },
    checkFiles: async () => ({ ok: true }),
    beforeStart: async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set(["package.json", ".github/workflows/ci.yml"])]]) }),
    tickMs: 5, parkTickMs: 5, aliveMs: 1000,
    ...options.ports,
  };
  const input: SetupRunInput = {
    rootPath, operationId: "11111111-1111-4111-8111-111111111111", basedOnRevision: 4, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, ...options.limits }, price: { inputPerMTok: 3, outputPerMTok: 15 },
    repositories: [{ name: "web", path: "repo/web", resolvedCommit: COMMIT }], commits: [{ repository: "web", commit: COMMIT }], ports,
  };
  return { input, progress, order, control: () => control };
}

describe("a provider error in a turn", () => {
  it("ends the run with the model-failed words when the session's retries could not cure it (never a silent end)", async () => {
    const t = await rig({ prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed" })); } });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
    expect(result.setupProposal).toBeUndefined();
    expect(t.progress).toContain(SETUP_HANG_WORDS.modelFailed);
    expect(t.order).toContain("sandbox.dispose");
    expect(t.order).toContain("network.stop");
  });
  it("books the session's usage ONCE, in the end report, and names the session FAILED (the merged spend + hang lanes)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = await rig({
      prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed", usage: { input: 1000, output: 10 } })); },
      ports: { reportUsage: async (payload) => { sent.push(payload); } },
    });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("infrastructure");
    expect(t.progress).toContain(SETUP_HANG_WORDS.modelFailed);
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent.at(-1))).toContain("FAILED");
    expect(JSON.stringify(sent.at(-1))).not.toContain("SUCCEEDED");
  });
  it("is not a failure when the session's own retry then answered: the run goes on to its proposal", async () => {
    const t = await rig({ prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed" })); emit(turnEnd({ stopReason: "stop", content: [{ type: "text", text: block(ANSWER) }] })); } });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("proposed");
    expect(t.progress).not.toContain(SETUP_HANG_WORDS.modelFailed);
  });
});

describe("a model call that never answers", () => {
  it("is ended by the stall bound even when the session never returns and never confirms its abort", async () => {
    const t = await rig({ prompt: never, abort: never, ports: { modelStallMs: 60, stallTickMs: 10, abortConfirmMs: 40 } });
    const started = Date.now();
    const result = await runSetupAgent(t.input);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
    expect(t.progress).toContain(SETUP_HANG_WORDS.stalled);
    expect(t.order).toContain("sandbox.dispose");
    expect(t.order).toContain("network.stop");
    expect(t.order).toContain("session.dispose");
  });
  it("is ended when the error was the last thing it said (a retry that never started)", async () => {
    const t = await rig({ prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed" })); emit({ type: "auto_retry_start", attempt: 1 }); await never(); }, abort: never, ports: { modelStallMs: 60, stallTickMs: 10, abortConfirmMs: 40 } });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("infrastructure");
    expect(t.progress).toContain(SETUP_HANG_WORDS.stalled);
  });
  it("is ended at the wall clock, whatever the session does: the limit's own word, and the abort that is not confirmed is not waited for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const t = await rig({ prompt: never, abort: never, limits: { wallClockMin: 1 }, ports: { tickMs: 1_000, modelStallMs: 3_600_000, abortConfirmMs: 30_000 } });
    t.input.ports.now = () => Date.now();
    const running = runSetupAgent(t.input);
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    await vi.advanceTimersByTimeAsync(30_000 + 1_000);
    const result = await running;
    expect(result.setupRunSummary).toMatchObject({ stop: "time_used", partial: true });
    expect(t.progress).toContain(SETUP_HANG_WORDS.notStopped);
    expect(t.order).toContain("sandbox.dispose");
  });
  it("a person's Stop returns within the abort wait even when the session never confirms its abort", async () => {
    const t = await rig({ prompt: never, abort: never, ports: { modelStallMs: 3_600_000, abortConfirmMs: 50 } });
    const running = runSetupAgent(t.input);
    await vi.waitFor(() => { expect(t.control()).toBeDefined(); });
    const asked = Date.now();
    await t.control()!.abort();
    expect(Date.now() - asked).toBeLessThan(3_000);
    const result = await running;
    expect(result.setupRunSummary.partial).toBe(true);
  });
});

describe("the watchdog's stall bound", () => {
  const make = (clock: { at: number }, stalls: { n: number }) => createSetupWatchdog({ now: () => clock.at, stallMs: 100, tickMs: 10, abortConfirmMs: 50, onStall: () => { stalls.n += 1; } });
  it("is not a stall while a command runs, nor while events keep coming, nor while no prompt is in flight", async () => {
    const clock = { at: 1_000 };
    const stalls = { n: 0 };
    const dog = make(clock, stalls);
    try {
      // No prompt in flight: silence is not a stall.
      clock.at += 500;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(stalls.n).toBe(0);
      const running = dog.prompt(() => new Promise<void>(() => undefined));
      running.catch(() => undefined);
      // A command runs for a long time with no model event: not a stall.
      dog.observe({ type: "tool_execution_start" });
      clock.at += 500;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(stalls.n).toBe(0);
      // The command ended; events then stop for longer than the bound: a stall, once.
      dog.observe({ type: "tool_execution_end" });
      clock.at += 150;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(stalls.n).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(stalls.n).toBe(1);
      expect(dog.stalled()).toBe(true);
    } finally { dog.dispose(); }
  });
  it("gives up on a prompt only after the stop was noted and the confirm wait passed; a prompt that returns first is done", async () => {
    const clock = { at: 0 };
    const dog = make(clock, { n: 0 });
    try {
      expect(await dog.prompt(async () => undefined)).toBe("done");
      const hung = dog.prompt(() => new Promise<void>(() => undefined));
      const raced = await Promise.race([hung, new Promise((resolve) => setTimeout(() => { resolve("waiting"); }, 80))]);
      expect(raced).toBe("waiting");
      dog.noteStop();
      expect(await hung).toBe("abandoned");
    } finally { dog.dispose(); }
  });
  it("passes on the prompt's own failure, and ignores the late failure of one it gave up on", async () => {
    const dog = make({ at: 0 }, { n: 0 });
    try {
      await expect(dog.prompt(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      let fail: (error: Error) => void = () => undefined;
      const hung = dog.prompt(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
      dog.noteStop();
      expect(await hung).toBe("abandoned");
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally { dog.dispose(); }
  });
});

describe("review (lead 4 Opus): the prod hang shape at the shipped bounds", () => {
  it("a provider error, a retry that never starts its stream, a session that never confirms its abort: the run ends after the 300 s stall and the 30 s abort wait, not before and not later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // No modelStallMs / abortConfirmMs / stallTickMs: the shipped constants are what is tested.
    const t = await rig({
      prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed" })); emit({ type: "auto_retry_start", attempt: 1 }); await never(); },
      abort: never, ports: { tickMs: 1_000, parkTickMs: 1_000, aliveMs: 1_000 },
    });
    t.input.ports.now = () => Date.now();
    let done = false;
    const running = runSetupAgent(t.input).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(290_000);
    expect(done).toBe(false);
    // The stall is seen within one 5 s tick of 300 s; the abort is then waited for 30 s, so the run is still waiting at 320 s ...
    await vi.advanceTimersByTimeAsync(30_000);
    expect(done).toBe(false);
    expect(t.order).toContain("abort");
    // ... and has ended by 340 s, with the stall's words.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(done).toBe(true);
    expect(t.progress).toContain(SETUP_HANG_WORDS.stalled);
    const result = await running;
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
    expect(t.order).toContain("sandbox.dispose");
    expect(t.order).toContain("network.stop");
    expect(t.order).toContain("session.dispose");
  });
});

describe("review (lead 4 Opus): the stand-in writer's cut-off is bounded", () => {
  it("a writer call past its time limit whose abort never confirms still returns, 30 s later, with the whole ceiling counted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let aborts = 0;
    const session: PiSessionHandle = {
      conversationId: "w", sessionFile: "w", prompt: never, steer: async () => undefined, isStreaming: () => true,
      abort: async () => { aborts += 1; await never(); }, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0 }) as never,
      subscribe: () => () => undefined, dispose: () => undefined,
    };
    const request = StandInWriterInputSchema.parse({ tables: [{ name: "creators", rows: 1, columns: [{ name: "id", kind: "integer", key: true, writable: false }, { name: "bio", kind: "text", key: false, writable: true, maxChars: 120 }] }], operations: [] });
    const price = { inputPerMTok: 3, outputPerMTok: 15 };
    let done = false;
    const running = runStandInWriter({ input: request, price, remainingCents: 400, openSession: async () => session, timeoutMs: 1_000 }).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_000 + 29_000);
    expect(aborts).toBe(1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(true);
    expect(await running).toMatchObject({ status: "skipped", reason: "failed", spendCents: standInWriterCeilingCents(standInCeilingPrice(price)) });
  });
});

describe("review (lead 4 Opus): prod run 3, a provider error with no retry while a website ask is open", () => {
  const PARKED = "Rovara is waiting for an administrator to decide an address.";
  /** The agent runs a command that hits a blocked website (the ask is then open with an administrator), and its turn then ends as `last` says. */
  async function hostRig(last: Record<string, unknown>) {
    const asks: string[] = [];
    const t = await rig({
      prompt: async (emit, bash) => {
        emit({ type: "tool_execution_start" });
        await bash.exec("npm ci", "/", { onData: () => undefined, timeout: 60 });
        emit({ type: "tool_execution_end" });
        emit(turnEnd(last));
      },
      ports: {
        startNetwork: async () => ({ name: "n", subnet: "172.29.9.0/24", gateway: "172.29.9.1", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => ["registry.example.com"], stop: async () => undefined }),
        callback: async (body) => {
          const kind = (body as { kind: string }).kind;
          if (kind === "host") { asks.push((body as { host: string }).host); return { outcome: "created" }; }
          return kind === "poll" ? { hosts: asks.map((host) => ({ host, state: "open" })) } : { ok: true };
        },
        modelStallMs: 3_600_000,
      },
    });
    return { ...t, asks };
  }
  it("control: a clean last turn with an open ask parks the run (so the case below is the parking it must not do)", async () => {
    const t = await hostRig({ stopReason: "stop", content: [{ type: "text", text: "waiting for a website" }] });
    const running = runSetupAgent(t.input);
    await vi.waitFor(() => { expect(t.progress).toContain(PARKED); }, { timeout: 5_000 });
    expect(t.asks).toEqual(["registry.example.com"]);
    await t.control()!.abort();
    await running;
  });
  it("an error turn the session did not retry ends the run infrastructure with the model-failed words; it never parks on the open ask", async () => {
    const t = await hostRig({ stopReason: "error", content: [], errorMessage: "provider_error" });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
    expect(t.progress).toContain(SETUP_HANG_WORDS.modelFailed);
    expect(t.progress).not.toContain(PARKED);
  });
});

describe("merge review (Sonnet): every hang end books the session's usage exactly once, in the finally", () => {
  const outcomesOf = (sent: Array<Record<string, unknown>>) => sent.map((x) => x["outcome"]);
  it("stall end: one report, FAILED", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = await rig({ prompt: never, abort: never, ports: { modelStallMs: 60, stallTickMs: 10, abortConfirmMs: 40, reportUsage: async (payload) => { sent.push(payload); } } });
    await runSetupAgent(t.input);
    expect(outcomesOf(sent)).toEqual(["FAILED"]);
  });
  it("stall end after an errored turn with a retry that never starts: one report, FAILED", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = await rig({ prompt: async (emit) => { emit(turnEnd({ stopReason: "error", content: [], errorMessage: "Model source request failed" })); emit({ type: "auto_retry_start", attempt: 1 }); await never(); }, abort: never, ports: { modelStallMs: 60, stallTickMs: 10, abortConfirmMs: 40, reportUsage: async (payload) => { sent.push(payload); } } });
    await runSetupAgent(t.input);
    expect(outcomesOf(sent).filter((o) => o !== undefined)).toEqual(["FAILED"]);
  });
  it("wall-clock end with an unconfirmed abort: one report, SUCCEEDED (a limit is not a model failure)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const sent: Array<Record<string, unknown>> = [];
    const t = await rig({ prompt: never, abort: never, limits: { wallClockMin: 1 }, ports: { tickMs: 1_000, modelStallMs: 3_600_000, abortConfirmMs: 30_000, reportUsage: async (payload) => { sent.push(payload); } } });
    t.input.ports.now = () => Date.now();
    const running = runSetupAgent(t.input);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await running;
    expect(outcomesOf(sent)).toEqual(["SUCCEEDED"]);
  });
  it("a person's Stop with an unconfirmed abort: one report, CANCELLED", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = await rig({ prompt: never, abort: never, ports: { modelStallMs: 3_600_000, abortConfirmMs: 50, reportUsage: async (payload) => { sent.push(payload); } } });
    const running = runSetupAgent(t.input);
    await vi.waitFor(() => { expect(t.control()).toBeDefined(); });
    await t.control()!.abort();
    await running;
    expect(outcomesOf(sent)).toEqual(["CANCELLED"]);
  });
});
