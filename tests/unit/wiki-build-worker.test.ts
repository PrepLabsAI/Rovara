/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- the scripted broker's bodies are free-form JSON read field by field, and the fake session's methods are called through the run. */
// Wiki W3b: the worker's wiki build run (`runWikiBuild`). A fake model session and a scripted broker stand in for the outside. What is proved here, each with a mutant listed in the PR body:
//   - the session is read-only: exactly read, grep, find, ls (no shell, no write, no network tool), in the WIKI mode that loads no repository context file;
//   - the pins: the workspace must hold exactly the commits the broker pinned, or nothing is asked of the broker;
//   - money: spend is metered, reported as a number that only goes up, and the session is stopped BEFORE a turn that could cross the job's ceiling (failure word budget_used, no page kept);
//   - fixed failure words: needs_ai_key, repo_unreadable, budget_used, infrastructure; the callback never carries a company, project or task.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_LIMIT_KINDS, WIKI_BUILD_TOOLS, agentXError, budgetExhaustedWords, type WikiBuildPins } from "@agentx/contracts";
import { ModelBudgetExhaustedError } from "@agentx/model-runtime";
import { agentStepTools } from "../../packages/worker/src/agent-step.js";
import { createWorkspacePiSession, piTaskToolCapabilities, type PiSessionAdapter, type PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { wikiSessionInputOf } from "../../packages/worker/src/wiki-build-invocation.js";
import { WIKI_TOOL_RESULT_MAX_TOKENS, assertPinsMatch, runWikiBuild, wikiDraftFromAnswer, type WikiRunInput, type WikiRunPorts, type WikiSessionParts } from "../../packages/worker/src/wiki-build-run.js";

const API = "a".repeat(40);
const WEB = "b".repeat(40);
const PINS: WikiBuildPins = [{ repo: "api", commit: API }];
const REPOS = [{ name: "api", path: "repo/api", resolvedCommit: API }];
const PRICE = { inputPerMTok: 3, outputPerMTok: 15 };
const LIMITS = { pages: 10, budgetCents: 1_000, wallClockMin: 60, pageReserveCents: 100 };
const DRAFT = { pageId: "overview", sections: [{ heading: "Start", claims: [] }] };

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
const answerText = (draft: unknown = DRAFT) => `Here is the page.\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``;

describe("the session is read-only", () => {
  // MUTANT read-only tool list: the session is given bash, write or edit (or the list is the caller's).
  it("opens every session with exactly read, grep, find and ls in the WIKI mode, sequential and output-capped", async () => {
    const w = world([pageJob("overview"), pageJob("repo-api")], (session) => session.turn(answerText()));
    await runWikiBuild(w.input);
    expect(w.parts).toHaveLength(2);
    for (const given of w.parts) {
      expect(given.workflowMode).toBe("WIKI");
      expect([...given.agentTools]).toEqual(["read", "grep", "find", "ls"]);
      expect(given.sequentialTools).toBe(true);
      expect(given.maxOutputTokens).toBeGreaterThan(0);
    }
    expect([...WIKI_BUILD_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
  });

  it("the mode's own tool surface is read-only: no shell, and asking for bash or write adds nothing", () => {
    expect(piTaskToolCapabilities("WIKI")).toEqual({ tools: ["read", "grep", "find", "ls"], customFileTools: false, shell: false });
    expect(agentStepTools("WIKI", ["read", "bash", "write", "edit", "fetch", "grep"])).toEqual({ tools: ["read", "grep"], shell: false });
    expect(agentStepTools("WIKI", WIKI_BUILD_TOOLS)).toEqual({ tools: ["read", "grep", "find", "ls"], shell: false });
  });

  it("each page gets a fresh session, disposed after the page", async () => {
    const w = world([pageJob("overview"), pageJob("repo-api")], (session) => session.turn(answerText()));
    await runWikiBuild(w.input);
    expect(new Set(w.sessions).size).toBe(2);
    expect(w.sessions.map((session) => session.disposed)).toEqual([1, 1]);
  });
});

describe("pins enforcement: the workspace is the broker's pinned commits", () => {
  // MUTANT pins enforcement: the manifest is not held to the pins (a different commit, an extra or a missing repository, a pull request head).
  it.each([
    ["another commit", [{ name: "api", path: "repo/api", resolvedCommit: WEB }], PINS],
    ["an extra repository", [{ name: "api", path: "repo/api", resolvedCommit: API }, { name: "web", path: "repo/web", resolvedCommit: WEB }], PINS],
    ["a missing repository", [{ name: "api", path: "repo/api", resolvedCommit: API }], [{ repo: "api", commit: API }, { repo: "web", commit: WEB }]],
    ["no repository", [], PINS],
    ["a pull request head", [{ name: "api", path: "repo/api", resolvedCommit: API, checkedOut: { pr: 1 } }], PINS],
    ["a commit that is not a hash", [{ name: "api", path: "repo/api", resolvedCommit: "main" }], [{ repo: "api", commit: "main" }]],
    ["a repository the pins do not name", [{ name: "other", path: "repo/other", resolvedCommit: API }], PINS],
  ])("refuses %s before the broker is asked for anything", async (_name, repositories, pins) => {
    const w = world([pageJob("overview")], (session) => session.turn(answerText()), { repositories, pins });
    await expect(runWikiBuild(w.input)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.bodies).toHaveLength(0);
    expect(w.sessions).toHaveLength(0);
    expect(() => assertPinsMatch(repositories, pins)).toThrow();
  });

  it("holds when the manifest is exactly the pins, and a model with no price does not start", async () => {
    expect(() => assertPinsMatch(REPOS, PINS)).not.toThrow();
    const w = world([pageJob("overview")], (session) => session.turn(answerText()), { price: undefined });
    await expect(runWikiBuild(w.input)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.bodies).toHaveLength(0);
  });
});

describe("the callback carries only what the run knows", () => {
  it("next names the spend only; page names the page id, the spend and the draft or the failure only", async () => {
    const w = world([pageJob("overview")], (session) => session.turn(answerText()));
    await runWikiBuild(w.input);
    expect(w.bodies.map((body) => Object.keys(body).sort())).toEqual([["kind", "spentCents"], ["answer", "kind"], ["kind", "spentCents"]]);
    expect(Object.keys(answers(w)[0]!).sort()).toEqual(["draft", "pageId", "spentCents"]);
    expect(JSON.stringify(w.bodies)).not.toMatch(/orgId|companyId|project|taskId|workspace/u);
  });

  it("ends when the broker says so, with the word, and asks again only after each answer", async () => {
    const w = world([pageJob("overview"), { kind: "end", word: "budget_used" }], (session) => session.turn(answerText()));
    const result = await runWikiBuild(w.input);
    expect(result).toMatchObject({ pagesAttempted: 1, end: "budget_used" });
    expect(w.bodies.map((body) => body["kind"])).toEqual(["next", "page", "next"]);
  });

  it("the task's instructions carry the broker's words, the repository paths and the framed notes, and nothing else", async () => {
    const w = world([pageJob("overview", 1_000, { notes: "<source-result untrusted=\"true\">src matters</source-result>" })], (session) => session.turn(answerText()));
    await runWikiBuild(w.input);
    const prompt = w.sessions[0]!.prompts[0]!;
    expect(prompt).toContain("Write overview.");
    expect(prompt).toContain("- api: repo/api");
    expect(prompt).toContain("untrusted=\"true\"");
  });
});

describe("money: metered spend, a ceiling that holds", () => {
  const big: Usage = { input: 100_000, output: 4_000 };

  it("reports the run's spend, only ever upward, across pages", async () => {
    const w = world([pageJob("overview"), pageJob("repo-api")], (session) => session.turn(answerText(), big));
    await runWikiBuild(w.input);
    const spends = w.bodies.map((body) => (body["kind"] === "next" ? body["spentCents"] : (body["answer"] as { spentCents: number }).spentCents) as number);
    // next(0), page(first page's cost), next(that), page(both pages), next(both)
    expect(spends[0]).toBe(0);
    expect(spends[1]).toBeGreaterThanOrEqual(36);
    expect(spends[2]).toBe(spends[1]);
    expect(spends[3]).toBeGreaterThanOrEqual(spends[1]! * 2 - 1);
    for (let i = 1; i < spends.length; i += 1) expect(spends[i]!).toBeGreaterThanOrEqual(spends[i - 1]!);
  });

  // MUTANT spend stop: the ceiling is not checked (or checked after the next turn, or only against the spend without the next turn's estimate).
  it("stops the session before a turn that could cross the ceiling, reports budget_used and keeps no draft", async () => {
    // One turn costs 36 cents; the next turn could cost about 46 more: with a ceiling of 60 the second turn must not start.
    const w = world([pageJob("overview", 60)], (session) => { session.turn("thinking", big); session.turn(answerText(), big); });
    await runWikiBuild(w.input);
    const [answer] = answers(w);
    expect(answer).toMatchObject({ pageId: "overview", failure: "budget_used" });
    expect(answer).not.toHaveProperty("draft");
    expect(w.sessions[0]!.aborted).toBeGreaterThanOrEqual(1);
    expect(answer!["spentCents"]).toBeGreaterThanOrEqual(36);
  });

  it("stops before the very first turn when even one turn could not fit under the ceiling", async () => {
    let turns = 0;
    const w = world([pageJob("overview", 5)], (session) => { session.emit({ type: "turn_start" }); turns += 1; });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
    expect(w.sessions[0]!.aborted).toBeGreaterThanOrEqual(1);
    expect(turns).toBe(1);
  });

  // MUTANT estimate (review M1): the next-turn estimate ignores what the tools returned, so a turn that read many big files crosses the ceiling.
  it("counts what the tools returned since the last model message in the next turn's estimate", async () => {
    const reads = (count: number): Script => (session) => {
      session.turn("reading", { input: 1_000, output: 200 });
      for (let i = 0; i < count; i += 1) { session.emit({ type: "tool_execution_start" }); session.emit({ type: "tool_execution_end" }); }
      session.emit({ type: "turn_start" });
      session.turn(answerText(), { input: 1_000, output: 200 });
    };
    // Without reads the second turn fits under the ceiling of 40 cents; six big reads put about 100k more tokens in front of it, which could cost more than is left.
    const none = world([pageJob("overview", 40)], reads(0));
    await runWikiBuild(none.input);
    expect(answers(none)[0]).toMatchObject({ draft: DRAFT });
    expect(WIKI_TOOL_RESULT_MAX_TOKENS).toBeGreaterThanOrEqual(25_600);
    const many = world([pageJob("overview", 40)], reads(6));
    await runWikiBuild(many.input);
    expect(answers(many)[0]).toMatchObject({ failure: "budget_used" });
    expect(answers(many)[0]).not.toHaveProperty("draft");
    expect(many.sessions[0]!.aborted).toBeGreaterThanOrEqual(1);
  });

  it("the reads counted are those since the last model message (a later turn starts the count again)", async () => {
    const w = world([pageJob("overview", 30)], (session) => {
      session.turn("reading", { input: 1_000, output: 200 });
      session.emit({ type: "tool_execution_end" });
      session.turn("reading again", { input: 1_000, output: 200 });
      session.emit({ type: "tool_execution_end" });
      session.emit({ type: "turn_start" });
      session.turn(answerText(), { input: 1_000, output: 200 });
    });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ draft: DRAFT });
  });

  // MUTANT (review L1): only the whole session's total is checked for unreadable usage, so a later turn with no usage adds nothing and under-reports.
  it("a LATER turn with no usage and no new cost is unreadable too, even after good turns", async () => {
    const w = world([pageJob("overview", 1_000)], (session) => { session.turn("one", { input: 1_000, output: 200 }); session.turn(answerText(), { input: 0, output: 0 }); });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
  });

  it("a ceiling with room lets the page finish and keep its draft", async () => {
    const w = world([pageJob("overview", 1_000)], (session) => session.turn(answerText(), { input: 1_000, output: 200 }));
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ draft: DRAFT });
    expect(answers(w)[0]).not.toHaveProperty("failure");
    expect(w.sessions[0]!.aborted).toBe(0);
  });

  it("a turn with no usage and no cost is unreadable, which counts as used up", async () => {
    const w = world([pageJob("overview", 1_000)], (session) => session.turn(answerText(), { input: 0, output: 0 }));
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
  });

  it("the larger of the session's reported cost and the run's own count stands", async () => {
    const w = world([pageJob("overview", 1_000)], (session) => { session.costDollars = 5; session.turn(answerText(), { input: 1_000, output: 200 }); });
    await runWikiBuild(w.input);
    expect(answers(w)[0]!["spentCents"]).toBeGreaterThanOrEqual(500);
  });

  it("the gateway's budget-exhausted marker on a turn (the project's monthly limit ran out) is the budget stop", async () => {
    for (const scope of ["project", "org", "task"] as const) {
      const w = world([pageJob("overview")], (session) => session.turn("", { input: 10, output: 1 }, { stopReason: "error", errorMessage: `AI budget exhausted (${scope})` }));
      await runWikiBuild(w.input);
      expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
    }
  });

  it("a plain error carrying any limit's own words (task, project, company month, person month, company day) is the budget stop", async () => {
    for (const limit of BUDGET_LIMIT_KINDS) {
      const w = world([pageJob("overview")], () => { throw new Error(budgetExhaustedWords(limit)); });
      await runWikiBuild(w.input);
      expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
    }
  });

  it("the budget-exhausted failure words from a refused prompt are the budget stop too", async () => {
    const w = world([pageJob("overview")], () => { throw new ModelBudgetExhaustedError("project"); });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "budget_used" });
  });
});

describe("fixed failure words", () => {
  // MUTANT: a refused model is reported as a fault (or kept as an empty page).
  it("a model the gateway will not serve ends the run needs_ai_key, whether the session opens or the prompt is refused", async () => {
    const refused = world([pageJob("overview")], () => { throw agentXError("MODEL_NOT_ALLOWED", "no AI source serves this model"); });
    await runWikiBuild(refused.input);
    expect(answers(refused)[0]).toMatchObject({ failure: "needs_ai_key" });
    const opening = world([pageJob("overview")], () => undefined, { ports: { openSession: async () => { throw agentXError("MODEL_NOT_ALLOWED", "no"); } } });
    await runWikiBuild(opening.input);
    expect(answers(opening)[0]).toMatchObject({ failure: "needs_ai_key" });
  });

  it("the gateway's model-not-allowed marker on a turn is needs_ai_key", async () => {
    const w = world([pageJob("overview")], (session) => session.turn("", { input: 10, output: 1 }, { stopReason: "error", errorMessage: "Model not allowed: Connect an AI key" }));
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "needs_ai_key" });
  });

  it("any other fault is infrastructure, and a refusal carries no words of the cause", async () => {
    const w = world([pageJob("overview")], () => { throw new Error("socket hang up sk-secret"); });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "infrastructure" });
    expect(JSON.stringify(w.bodies)).not.toContain("socket");
  });

  it("a repository that cannot be read at its folder ends the run repo_unreadable, and no session is opened for it", async () => {
    const w = world([pageJob("overview")], (session) => session.turn(answerText()), { ports: { repositoryReadable: async () => false } });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ pageId: "overview", failure: "repo_unreadable" });
    expect(w.sessions).toHaveLength(0);
  });

  it("a page that takes past the page clock is given up as infrastructure", async () => {
    const w = world([pageJob("overview")], async (session) => { await new Promise((resolve) => setTimeout(resolve, 80)); session.turn(answerText()); }, { ports: { pageTimeoutMs: 10 } });
    await runWikiBuild(w.input);
    expect(answers(w)[0]).toMatchObject({ failure: "infrastructure" });
    expect(w.sessions[0]!.aborted).toBeGreaterThanOrEqual(1);
  });

  it("a cancel aborts the session and no further answer or ask is sent", async () => {
    const w = world([pageJob("overview"), pageJob("repo-api")], async (session) => { await w.aborts[0]!(); session.turn(answerText()); });
    const result = await runWikiBuild(w.input);
    expect(w.sessions[0]!.aborted).toBeGreaterThanOrEqual(1);
    expect(w.bodies.map((body) => body["kind"])).toEqual(["next"]);
    expect(result.end).toBeUndefined();
  });
});

describe("reading the model's page", () => {
  it("takes the last fenced JSON object, else the outermost braces, else nothing", () => {
    expect(wikiDraftFromAnswer("```json\n{\"a\":1}\n```\ntext\n```\n{\"b\":2}\n```")).toEqual({ b: 2 });
    expect(wikiDraftFromAnswer("page: {\"a\": {\"b\": 1}} done")).toEqual({ a: { b: 1 } });
    expect(wikiDraftFromAnswer("```json\nnot json\n```\n{\"c\":3}")).toEqual({ c: 3 });
    expect(wikiDraftFromAnswer("nothing here")).toBeUndefined();
    expect(wikiDraftFromAnswer("[1,2,3]")).toBeUndefined();
    expect(wikiDraftFromAnswer("{broken")).toBeUndefined();
  });

  it("an unreadable answer is asked for once more; a second unreadable answer is sent with no draft", async () => {
    const once = world([pageJob("overview")], (session, _prompt, n) => session.turn(n === 1 ? "I cannot say." : answerText()));
    await runWikiBuild(once.input);
    expect(once.sessions[0]!.prompts).toHaveLength(2);
    expect(answers(once)[0]).toMatchObject({ draft: DRAFT });
    const twice = world([pageJob("overview")], (session) => session.turn("still no JSON"));
    await runWikiBuild(twice.input);
    expect(twice.sessions[0]!.prompts).toHaveLength(2);
    expect(answers(twice)[0]).not.toHaveProperty("draft");
    expect(answers(twice)[0]).not.toHaveProperty("failure");
  });
});

describe("the session the invocation opens (review L3)", () => {
  const adapterOf = (seen: Array<Record<string, unknown>>): PiSessionAdapter => ({
    create: async (input) => { seen.push(input as unknown as Record<string, unknown>); return { conversationId: "c", sessionFile: "f" } as unknown as PiSessionHandle; },
    open: async () => { throw new Error("not used"); },
  });
  const parts: WikiSessionParts = { workflowMode: "WIKI", agentTools: WIKI_BUILD_TOOLS, sequentialTools: true, maxOutputTokens: 8_192 };
  const fileTools = { kind: "sandbox" } as never;

  // MUTANT: the run's parts come before other fields, or a sandbox that exists is not used for the file tools (on a hosted worker they would run in the worker).
  it("hands the adapter the WIKI mode and the four tools, the sandbox's file tools when there is a sandbox, and no skill or source", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const root = await mkdtemp(join(tmpdir(), "wiki-invocation-"));
    await mkdir(join(root, ".agentx"), { recursive: true });
    await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ repositories: [{ name: "web", path: "repo/web" }] }));
    await createWorkspacePiSession(wikiSessionInputOf({ rootPath: root, model: { provider: "p", modelId: "m" }, conversationId: "c", fileTools }, parts), adapterOf(seen)).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ workflowMode: "WIKI", fileTools });
    expect([...(seen[0]!["agentTools"] as string[])]).toEqual(["read", "grep", "find", "ls"]);
    expect(seen[0]).not.toHaveProperty("localFileTools");
    for (const key of ["skills", "contextTools", "contextMcp", "answerTools", "agentRun", "standingInstructions"]) expect(seen[0], key).not.toHaveProperty(key);
  });

  it("uses the worker's own file tools only when there is no sandbox (the local shell, chosen explicitly)", () => {
    const input = wikiSessionInputOf({ rootPath: "/work", model: { provider: "p", modelId: "m" }, conversationId: "c", fileTools: undefined }, parts);
    expect(input).toMatchObject({ localFileTools: true, workflowMode: "WIKI" });
    expect(input).not.toHaveProperty("fileTools");
    // The run's parts always win: nothing placed before them can change the mode or the tools.
    const hostile = wikiSessionInputOf({ rootPath: "/work", model: { provider: "p", modelId: "m" }, conversationId: "c", fileTools, ...({ workflowMode: "IMPLEMENT", agentTools: ["bash"] } as object) }, parts);
    expect(hostile).toMatchObject({ workflowMode: "WIKI" });
    expect([...(hostile.agentTools ?? [])]).toEqual(["read", "grep", "find", "ls"]);
  });
});
