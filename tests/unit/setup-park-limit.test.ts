// A setup run parked on a website (host) ask waits AT MOST 2 hours (DEC 254zzz428), then ENDS in the fixed words of "waiting for a website decision", keeping what it learned. The wait is ended from OUTSIDE the parked
// loop (the governor's own timer, and the loop's check of the clock); the broker's run-gone bound does NOT follow it (a polling worker is never read as gone at 2 hours); the end books the model's usage once (the run's `finally`); the ask itself stays decidable,
// so approving it later and starting the setup again works.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_HOST_WAIT_MAX_HOURS, effectiveSetupAgentLimits, type SetupAgentLimits } from "../../packages/contracts/src/index.js";
import { SETUP_AGENT_FAILURES, resultOf, setupRunGone } from "../../packages/broker/src/core/setup-agent/agent.js";
import { SETUP_HOST_WAIT_ENDED_WORDS, runSetupAgent, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";

const HOUR = 3_600_000;
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "a".repeat(40);
const ANSWER = {
  setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }],
  tests: [{ repo: "web", commands: ["npm test"], from: [{ kind: "ci", repo: "web", path: ".github/workflows/ci.yml", line: 5, quote: "run: npm test" }] }],
};
const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
const never = (): Promise<never> => new Promise<never>(() => undefined);
const HOST = "registry.acme.dev";

/** A run whose first prompt runs `npm ci`, which hits a blocked website; the broker's answer for that website is `ask.state`, and `ask.pollHangs` makes the broker's poll never answer. */
async function parkedRun(over: { limits?: Partial<SetupAgentLimits>; blocked?: string[]; stopOnAbort?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const rootPath = await mkdtemp(join(tmpdir(), "setup-park-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const ask = { state: "open" as "open" | "approved" | "refused", pollHangs: false };
  const progress: string[] = [];
  const order: string[] = [];
  const callbacks: Array<{ kind: string }> = [];
  const usage: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  let control: { abort(): Promise<void> } | undefined;
  let stopped = false;
  const listeners: Array<(event: unknown) => void> = [];
  let sessionBash: BashOperations | undefined;
  const base: BashOperations = { exec: async (_command, _cwd, opts) => { opts.onData(Buffer.from("ok\n")); await new Promise((resolve) => setTimeout(resolve, 5)); return { exitCode: 0 }; } };
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f",
    prompt: async (text?: string) => {
      prompts.push(String(text));
      if (prompts.length === 1) await sessionBash!.exec("npm ci", "/work", { onData: () => undefined });
      for (const l of listeners) l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: block(ANSWER) }], usage: { input: 1000, output: 10 } } });
    },
    steer: async () => undefined, isStreaming: () => false, abort: async () => { order.push("abort"); if (over.stopOnAbort === true && !stopped) { stopped = true; void control?.abort(); } },
    getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0.05, tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, total: 1010 } }) as never,
    subscribe: (l) => { listeners.push(l); return () => undefined; }, dispose: () => { order.push("session.dispose"); },
  };
  const network: RunNetwork = { name: "n", subnet: "172.29.9.0/24", gateway: "172.29.9.1", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => over.blocked ?? [HOST], stop: async () => { order.push("network.stop"); } };
  const ports: SetupRunPorts = {
    startNetwork: async () => network,
    createSandbox: () => ({ bashOperations: () => base, dispose: async () => { order.push("sandbox.dispose"); }, fileOpsTarget: () => ({}) }) as never,
    openSession: async (parts) => { sessionBash = parts.bashOperations; return session; },
    callback: async (body) => {
      const kind = (body as { kind: string }).kind;
      callbacks.push({ kind });
      if (kind === "poll") return ask.pollHangs ? never() : { hosts: [{ host: HOST, state: ask.state }] };
      return kind === "host" ? { outcome: "created" } : { ok: true };
    },
    progress: async (message) => { progress.push(message); },
    register: (c) => { control = c; return () => undefined; },
    checkFiles: async () => ({ ok: true }),
    beforeStart: async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set(["package.json", ".github/workflows/ci.yml"])]]) }),
    reportUsage: async (payload) => { usage.push(payload); },
    now: () => Date.now(),
    tickMs: 1_000, parkTickMs: 1_000, aliveMs: 60_000,
  };
  const input: SetupRunInput = {
    rootPath, operationId: "11111111-1111-4111-8111-111111111111", basedOnRevision: 4, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, ...over.limits }, price: { inputPerMTok: 3, outputPerMTok: 15 },
    repositories: [{ name: "web", path: "repo/web", resolvedCommit: COMMIT }], commits: [{ repository: "web", commit: COMMIT }], ports,
  };
  let done = false;
  const running = runSetupAgent(input).finally(() => { done = true; });
  return { ask, progress, order, callbacks, usage, prompts, running, isDone: () => done, control: () => control };
}
const endReports = (usage: Array<Record<string, unknown>>) => usage.filter((payload) => /SUCCEEDED|FAILED|CANCELLED/u.test(JSON.stringify(payload)));

describe("the 2-hour limit on a run parked on a website ask", () => {
  it("is 2 hours (the contract's one number)", () => {
    expect(SETUP_HOST_WAIT_MAX_HOURS).toBe(2);
  });

  it("a run parked for 2 hours ENDS with `hosts_waiting`, in the fixed words, keeping the partial proposal, with no further model call; not a minute sooner", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.progress).toContain("Rovara is waiting for an administrator to decide an address.");
    await vi.advanceTimersByTimeAsync(2 * HOUR - 60_000 - 10_000);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000 + 5_000);
    expect(t.isDone()).toBe(true);
    const result = await t.running;
    expect(result.setupRunSummary).toMatchObject({ stop: "hosts_waiting", partial: true });
    expect(JSON.stringify(result.setupProposal)).toContain("npm ci");
    expect(t.progress).toContain(SETUP_HOST_WAIT_ENDED_WORDS);
    expect(t.prompts).toHaveLength(1);
    expect(t.order).toEqual(expect.arrayContaining(["sandbox.dispose", "network.stop", "session.dispose"]));
  });

  it("the end books the model's usage ONCE (the run's finally), not once per path", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(2 * HOUR + 10_000);
    await t.running;
    expect(endReports(t.usage)).toHaveLength(1);
  });

  it("is ended from OUTSIDE the wait: a broker that never answers its poll while the run is parked does not hold the run past 2 hours", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(10_000);
    t.ask.pollHangs = true;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(t.isDone()).toBe(true);
    expect((await t.running).setupRunSummary).toMatchObject({ stop: "hosts_waiting", partial: true });
  });

  it("the website-ASK limit ends the run `hosts_waiting` too, and its words are TRUE there: the run never parked and never waited, so no wait is claimed", async () => {
    const t = await parkedRun({ limits: { hostAsks: 1 }, blocked: [HOST, "second.acme.dev"] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.isDone()).toBe(true);
    const result = await t.running;
    expect(result.setupRunSummary).toMatchObject({ stop: "hosts_waiting", partial: true });
    expect(t.progress).not.toContain("Rovara is waiting for an administrator to decide an address.");
    expect(t.progress).toContain(SETUP_HOST_WAIT_ENDED_WORDS);
    // The words say what is true of both causes: websites that are not decided yet. Neither says the run "was waiting" or "waited".
    for (const words of [SETUP_HOST_WAIT_ENDED_WORDS, SETUP_AGENT_FAILURES.hosts_waiting]) expect(words).not.toMatch(/was waiting|waited|while waiting/u);
    expect(SETUP_HOST_WAIT_ENDED_WORDS).toBe("Rovara ended the setup run: it needs addresses an administrator has not decided.");
  });

  it("a person's Stop while the run is parked shows NO website-wait line (it was stopped, not timed out)", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.progress).toContain("Rovara is waiting for an administrator to decide an address.");
    await t.control()!.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await t.running;
    expect(result.setupRunSummary.partial).toBe(true);
    expect(t.progress).not.toContain(SETUP_HOST_WAIT_ENDED_WORDS);
  });

  it("a person's Stop that lands the moment the 2 hours run out (the limit's own stop is first, the Stop second) still shows no website-wait line", async () => {
    const t = await parkedRun({ stopOnAbort: true });
    await vi.advanceTimersByTimeAsync(2 * HOUR + 10_000);
    const result = await t.running;
    expect(result.setupRunSummary.stop).toBe("hosts_waiting");
    expect(t.progress).not.toContain(SETUP_HOST_WAIT_ENDED_WORDS);
  });

  it("a website allowed before 2 hours lets the run go on: one more prompt that names the website, then its proposal (no `hosts_waiting`)", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(2 * HOUR - 5 * 60_000);
    expect(t.isDone()).toBe(false);
    t.ask.state = "approved";
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await t.running;
    expect(result.setupRunSummary.stop).toBe("proposed");
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain(`Allowed: ${HOST}`);
    expect(t.progress).not.toContain(SETUP_HOST_WAIT_ENDED_WORDS);
  });
});

describe("the broker's side of the same limit", () => {
  const limits = effectiveSetupAgentLimits(undefined);
  const startedAt = "2026-11-23T10:00:00.000Z";
  const at = (minutesAfterStart: number): number => Date.parse(startedAt) + minutesAfterStart * 60_000;
  // Controller rule: the view never calls a run gone on a clock while its worker is heard from; the 2-hour limit is the worker's recorded end. The run-gone backstop stays wall clock + 24 hours + an hour.
  const backstop = limits.wallClockMin + 24 * 60 + 60;

  it("the page and the sweep do NOT read a polling worker as gone at the 2-hour park limit (the worker ends the run itself); only the old run-gone backstop does", () => {
    const polling = (minutes: number) => setupRunGone({ startedAt, seenAt: new Date(at(minutes) - 5_000).toISOString(), now: at(minutes), limits });
    expect(polling(limits.wallClockMin + SETUP_HOST_WAIT_MAX_HOURS * 60 + 61)).toBe(false);
    expect(polling(backstop - 1)).toBe(false);
    expect(polling(backstop + 1)).toBe(true);
  });

  it("the stored end of a run that waited too long says what will show, in fixed words that name the wait and say what to do", () => {
    expect(SETUP_AGENT_FAILURES.hosts_waiting).toBe("The setup run ended: it needs addresses an administrator has not allowed yet. It waits at most 2 hours for a decision. Allow them, then run the setup again.");
  });

  it("what a run learned before the 2 hours ran out is kept in its stored end: the broker reads the worker's partial proposal and summary again and stores them with the stop `hosts_waiting`", async () => {
    const t = await parkedRun();
    await vi.advanceTimersByTimeAsync(2 * HOUR + 10_000);
    const worker = await t.running;
    const task = { startingRevision: 4, preparedBase: [{ repositoryId: "web", baseCommitSha: COMMIT }] } as never;
    const stored = resultOf(task, { kind: "task" }, { status: "SUCCEEDED", result: worker, error: undefined, repositories: { names: ["web"], urls: {} } });
    expect(stored).toMatchObject({ stop: "hosts_waiting", summary: { stop: "hosts_waiting", partial: true } });
    expect(JSON.stringify(stored)).toContain("npm ci");
    // With nothing readable to keep, the end still says which limit it was, in the fixed words.
    const bare = resultOf(task, { kind: "task" }, { status: "SUCCEEDED", result: { workflowMode: "SETUP_AGENT", setupRunSummary: worker.setupRunSummary }, error: undefined, repositories: { names: ["web"], urls: {} } });
    expect(bare).toMatchObject({ status: "failed", stop: "hosts_waiting", failure: SETUP_AGENT_FAILURES.hosts_waiting });
  });
});
