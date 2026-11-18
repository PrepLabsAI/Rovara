/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method -- the scripted broker's bodies are free-form JSON read field by field, and the fake session's methods are called through the run. */
// Lead 4 N1: the worker's side of the upkeep pause. When the gateway refuses a nightly refresh's model call with its fixed upkeep sentence, the run reports the failure word `upkeep_paused` with the reason the sentence
// names, and nothing else does: a plain model refusal stays `needs_ai_key`, a spent task budget stays `budget_used`, any other fault stays `infrastructure`. Same fake session and scripted broker as the W3b worker test.
import { describe, expect, it } from "vitest";
import { UPKEEP_PAUSE_MESSAGES, agentXError, type WikiBuildPins } from "@agentx/contracts";
import { ModelBudgetExhaustedError } from "@agentx/model-runtime";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { runWikiBuild, type WikiRunInput, type WikiRunPorts, type WikiSessionParts } from "../../packages/worker/src/wiki-build-run.js";

const API = "a".repeat(40);
const PINS: WikiBuildPins = [{ repo: "api", commit: API }];
const REPOS = [{ name: "api", path: "repo/api", resolvedCommit: API }];
const PRICE = { inputPerMTok: 3, outputPerMTok: 15 };
const LIMITS = { pages: 10, budgetCents: 1_000, wallClockMin: 60, pageReserveCents: 100 };

/** A page job as the broker's callback answers it. */
const pageJob = (id: string, ceiling = 1_000, extra: Record<string, unknown> = {}) => ({ kind: "page", page: { id, kind: "overview" }, pins: PINS, instructions: `Write ${id}.`, spendCeilingCents: ceiling, ...extra });

interface Usage { input?: number; output?: number }
type Script = (session: FakeSession, prompt: string, n: number) => Promise<void> | void;

class FakeSession implements PiSessionHandle {
  conversationId = "c"; sessionFile = "f";
  readonly listeners: Array<(event: unknown) => void> = [];
  readonly prompts: string[] = [];
  aborted = 0; disposed = 0; costDollars = 0;
  constructor(private readonly script: Script) {}
  async prompt(text: string): Promise<void> { this.prompts.push(text); await this.script(this, text, this.prompts.length); }
  async abort(): Promise<void> { this.aborted += 1; }
  getModel() { return { provider: "p", modelId: "m" }; }
  getSessionStats() { return { cost: this.costDollars } as ReturnType<PiSessionHandle["getSessionStats"]>; }
  subscribe(listener: (event: unknown) => void): () => void { this.listeners.push(listener); return () => undefined; }
  dispose(): void { this.disposed += 1; }
  emit(event: unknown): void { for (const listener of this.listeners) listener(event); }
  /** One assistant turn: turn_start, then its message with usage and text. */
  turn(text: string, usage: Usage = { input: 1_000, output: 200 }, extra: Record<string, unknown> = {}): void {
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage, ...extra } });
  }
}

interface World { bodies: Array<Record<string, any>>; sessions: FakeSession[]; parts: WikiSessionParts[]; input: WikiRunInput; progress: string[]; aborts: Array<() => Promise<void>> }

function world(jobs: unknown[], script: Script, overrides: Omit<Partial<WikiRunInput>, "ports"> & { ports?: Partial<WikiRunPorts> } = {}): World {
  const bodies: Array<Record<string, any>> = [];
  const sessions: FakeSession[] = [];
  const parts: WikiSessionParts[] = [];
  const progress: string[] = [];
  const aborts: Array<() => Promise<void>> = [];
  const queue = [...jobs];
  const ports: WikiRunPorts = {
    openSession: async (given) => { parts.push(given); const session = new FakeSession(script); sessions.push(session); return session; },
    callback: async (body) => {
      bodies.push(body as Record<string, any>);
      if ((body as { kind: string }).kind === "next") return queue.shift() ?? { kind: "end", word: "built" };
      return { pageId: "x", kept: true, claimsKept: 0, claimsDropped: 0, complete: true };
    },
    progress: async (message) => { progress.push(message); },
    register: (control) => { aborts.push(control.abort); return () => undefined; },
    repositoryReadable: async () => true,
    ...overrides.ports,
  };
  const input: WikiRunInput = { rootPath: "/work", operationId: "op-1", limits: LIMITS, pins: PINS, repositories: REPOS, price: PRICE, ...overrides, ports };
  return { bodies, sessions, parts, progress, aborts, input };
}
const answers = (w: World) => w.bodies.filter((body) => body["kind"] === "page").map((body) => body["answer"] as Record<string, unknown>);


const answerOf = (w: World) => answers(w)[0]!;

describe("the gateway's upkeep pause", () => {
  // MUTANT pause detection: the worker reads the pause from anything but the gateway's fixed sentence (or not at all, so it reports infrastructure).
  it.each([
    ["no_budget", UPKEEP_PAUSE_MESSAGES.no_budget],
    ["monthly_limit", UPKEEP_PAUSE_MESSAGES.monthly_limit],
    ["cost_too_high", UPKEEP_PAUSE_MESSAGES.cost_too_high],
  ])("a turn that failed with the %s sentence reports upkeep_paused with that reason and keeps no page", async (reason, sentence) => {
    const w = world([pageJob("overview")], (session) => session.turn("", { input: 1_000, output: 10 }, { stopReason: "error", errorMessage: `422 ${sentence}` }));
    await runWikiBuild(w.input);
    expect(answerOf(w)).toMatchObject({ failure: "upkeep_paused", pause: reason });
    expect(answerOf(w)).not.toHaveProperty("draft");
  });

  it("a prompt that throws the sentence (the call refused before any turn) reports the same", async () => {
    const w = world([pageJob("overview")], () => { throw new Error(UPKEEP_PAUSE_MESSAGES.monthly_limit); });
    await runWikiBuild(w.input);
    expect(answerOf(w)).toMatchObject({ failure: "upkeep_paused", pause: "monthly_limit" });
  });

  it("a session that cannot even open with the sentence reports it too", async () => {
    const w = world([pageJob("overview")], () => undefined, { ports: { openSession: async () => { throw new Error(UPKEEP_PAUSE_MESSAGES.no_budget); } } });
    await runWikiBuild(w.input);
    expect(answerOf(w)).toMatchObject({ failure: "upkeep_paused", pause: "no_budget" });
  });

  it("other refusals keep their own words: not allowed is needs_ai_key, a spent budget is budget_used, any other fault is infrastructure, none carries a pause", async () => {
    const notAllowed = world([pageJob("overview")], () => { throw agentXError("MODEL_NOT_ALLOWED", "no AI source serves this model"); });
    await runWikiBuild(notAllowed.input);
    expect(answerOf(notAllowed)).toMatchObject({ failure: "needs_ai_key" });
    const spent = world([pageJob("overview")], () => { throw new ModelBudgetExhaustedError("task"); });
    await runWikiBuild(spent.input);
    expect(answerOf(spent)).toMatchObject({ failure: "budget_used" });
    const other = world([pageJob("overview")], () => { throw new Error("the provider is down"); });
    await runWikiBuild(other.input);
    expect(answerOf(other)).toMatchObject({ failure: "infrastructure" });
    for (const w of [notAllowed, spent, other]) expect(answerOf(w)).not.toHaveProperty("pause");
  });

  it("words that only look like the sentence are not a pause", async () => {
    const w = world([pageJob("overview")], () => { throw new Error("upkeep_paused: nightly upkeep is paused"); });
    await runWikiBuild(w.input);
    expect(answerOf(w)).toMatchObject({ failure: "infrastructure" });
  });
});
