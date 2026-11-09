// SR-1, the worker side of the second review: the reviewer runs INSIDE the review operation, after the normal reviews, on its own model, in a bounded loop of at most 3 tries (the same model once more, then the next
// candidate). Its report is handed back separately (`onSecondReview`) and is never one of the returned reports, so it cannot be mistaken for the first review's.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { SECOND_REVIEWER_FEATURE, SecondReviewerSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, nextSecondReviewModel, secondReviewTryOutcome, type SecondReviewResult } from "../../packages/contracts/src/index.js";
import { WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE } from "../../packages/contracts/src/index.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { secondReviewerRuntimes } from "../../packages/worker/src/task-model.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";

const execFile = promisify(execFileCallback);
const now = "2026-11-02T12:00:00.000Z";
const OPERATION = "11111111-1111-4111-8111-111111111111";

async function repository() {
  const rootPath = await mkdtemp(join(tmpdir(), "rovara-second-review-"));
  const directory = join(rootPath, "repo", "payments");
  await mkdir(directory, { recursive: true });
  const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.email", "review@example.invalid");
  await git("config", "user.name", "Review Test");
  await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
  await git("add", "app.ts");
  await git("commit", "--quiet", "-m", "baseline");
  const baseCommitSha = await git("rev-parse", "HEAD");
  await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
  const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
  const repositories = [{ repositoryId: "payments", directory }];
  const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha }]);
  return { rootPath, repositories, candidate };
}

/**
 * A model: `script` is its answers in order ("throw" = the session fails); `prompts` counts what it was asked.
 * `delayMs` is a real wait. With `fakeClock` (the test has installed vi.useFakeTimers) the delay is instead virtual time that the model itself moves by `delayMs`, and a "hang" moves the clock to the next timer
 * (the review's own limit), so how much of a budget a try used does not depend on how busy the machine is. `hold` is awaited before the model answers; `onPrompt` runs when it is asked.
 */
function model(id: string, script: string[], prompts: string[], options: { delayMs?: number; fakeClock?: boolean; hold?: Promise<unknown>; onPrompt?: () => void } = {}): { model: { provider: string; modelId: string }; piAdapter: PiSessionAdapter } {
  let next = 0;
  return {
    model: { provider: "test", modelId: id },
    piAdapter: {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        return {
          conversationId: input.conversationId ?? "review-session", sessionFile,
          async prompt(text) {
            prompts.push(`${id}:${text.includes("Review role: CODE") ? "CODE" : text.includes("Review role: SECURITY") ? "SECURITY" : "RETRY"}`);
            options.onPrompt?.();
            const answer = script[Math.min(next, script.length - 1)]!;
            next += 1;
            if (options.delayMs !== undefined) {
              if (options.fakeClock === true) await vi.advanceTimersByTimeAsync(options.delayMs);
              else await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            }
            if (options.hold !== undefined) await options.hold;
            if (answer === "hang") {
              if (options.fakeClock === true) await vi.advanceTimersToNextTimerAsync();
              await new Promise(() => undefined);
            }
            if (answer === "throw") throw new Error("the session failed");
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
          },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: id }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    },
  };
}

const PASS = '{"findings":[]}';
const FINDING = '{"findings":[{"text":"off by one in the loop bound","origin":"INTRODUCED"}]}';

async function run(options: { first: ReturnType<typeof model>; candidates?: Array<ReturnType<typeof model>>; reviewers?: Array<"CRITIC" | "SECURITY">; timeoutMs?: number; context?: "change_only" | "same_as_first"; sources?: unknown; learnedBlock?: string; tools?: string[]; skills?: unknown[] }) {
  const { rootPath, repositories, candidate } = await repository();
  let second: SecondReviewResult | undefined;
  const started = Date.now();
  try {
    const reports = await runWorkflowReviews({
      ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: options.first.model, candidate, repositories, piAdapter: options.first.piAdapter, now: () => now,
      ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sources === undefined ? {} : { sources: options.sources as never }), ...(options.learnedBlock === undefined ? {} : { learnedBlock: options.learnedBlock }), ...(options.tools === undefined ? {} : { tools: options.tools }), ...(options.skills === undefined ? {} : { skills: options.skills as never }),
      ...(options.candidates === undefined ? {} : { secondReviewer: { candidates: options.candidates, ...(options.context === undefined ? {} : { context: options.context }) }, onSecondReview: (result: SecondReviewResult) => { second = result; } }),
    });
    return { reports, second, elapsed: Date.now() - started };
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

describe("the second reviewer inside the review operation", () => {
  it("runs beside the normal reviews, on its own model, and its report is returned beside them, never among them", async () => {
    const prompts: string[] = [];
    const first = model("first-v1", [PASS], prompts);
    const a = model("second-a", [FINDING], prompts);
    const { reports, second } = await run({ first, candidates: [a] });
    expect(reports.map((report) => report.role)).toEqual(["CRITIC", "SECURITY"]);
    expect(reports.every((report) => report.version === "first-v1")).toBe(true);
    expect(second).toMatchObject({ tries: 1, report: { role: "CRITIC", provider: "test", version: "second-a", status: "FINDINGS", operationId: OPERATION } });
    // The first model answered the two normal reviews, then the second model the extra one: its own model, after.
    expect(prompts.filter((entry) => entry.startsWith("first-v1:"))).toEqual(["first-v1:CODE", "first-v1:SECURITY"]);
    expect(prompts.filter((entry) => entry.startsWith("second-a:"))).toEqual(["second-a:CODE"]);
  });

  it("retries the same model once, then moves to the next candidate; three tries in all", async () => {
    const prompts: string[] = [];
    const a = model("second-a", ["throw"], prompts);
    const b = model("second-b", [PASS], prompts);
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [a, b] });
    const order = prompts.filter((entry) => entry.startsWith("second-"));
    expect(order).toEqual(["second-a:CODE", "second-a:CODE", "second-b:CODE"]);
    expect(second).toMatchObject({ tries: 3, report: { version: "second-b", status: "PASS" } });
  });

  it("the injected-diff attack: every try fails, so the loop stops at three tries, the answer is 'no answer', and the first reviews are untouched", async () => {
    const prompts: string[] = [];
    const a = model("second-a", ["throw"], prompts);
    const b = model("second-b", ["throw"], prompts);
    const { reports, second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [a, b] });
    expect(prompts.filter((entry) => entry.startsWith("second-"))).toHaveLength(3);
    expect(second?.tries).toBe(3);
    expect(second?.report).toMatchObject({ status: "UNKNOWN", failureReason: "SESSION_FAILED" });
    expect(secondReviewTryOutcome(second?.report)).toBe("no-answer");
    expect(reports.map((report) => report.status)).toEqual(["PASS", "PASS"]);
  });

  it("stops at the first answer (a model that answers is not asked again)", async () => {
    const prompts: string[] = [];
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [model("second-a", [PASS], prompts), model("second-b", [PASS], prompts)] });
    expect(second?.tries).toBe(1);
    expect(prompts.some((entry) => entry.startsWith("second-b:"))).toBe(false);
  });

  it("asks for nothing when the invocation names no second reviewer (cr off: the review is exactly as before)", async () => {
    const prompts: string[] = [];
    const { reports, second } = await run({ first: model("first-v1", [PASS], prompts) });
    expect(second).toBeUndefined();
    expect(prompts).toEqual(["first-v1:CODE", "first-v1:SECURITY"]);
    expect(reports).toHaveLength(2);
  });

  it("is not run when the step asks for no code review", async () => {
    const prompts: string[] = [];
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [model("second-a", [PASS], prompts)], reviewers: ["SECURITY"] });
    expect(second).toBeUndefined();
    expect(prompts.some((entry) => entry.startsWith("second-a:"))).toBe(false);
  });
});

describe("the second reviewer takes no extra wall time (M1)", () => {
  it("runs beside the normal reviews, so a review with a second reviewer is about as long as one without", async () => {
    // Not measured in wall time (that moved with the machine's load). The first model holds its first review until the second reviewer has made all three of its failing tries. Run beside the normal reviews the
    // second reviewer finishes while the first review is held, so the hold ends because of it; run after them it could not even start, and the hold would only end at the safety limit.
    const together: string[] = [];
    let releaseHold!: (by: "second reviewer") => void;
    const held = new Promise<"second reviewer">((resolve) => { releaseHold = resolve; });
    let safety: ReturnType<typeof setTimeout> | undefined;
    const holdEndedBy = Promise.race([held, new Promise<"safety limit">((resolve) => { safety = setTimeout(() => resolve("safety limit"), 20_000); })]);
    const onSecondPrompt = () => { if (together.filter((entry) => entry.startsWith("second-")).length >= 3) releaseHold("second reviewer"); };
    const first = model("first-v1", [PASS], together, { hold: holdEndedBy });
    const candidates = [model("second-a", ["throw"], together, { onPrompt: onSecondPrompt }), model("second-b", ["throw"], together, { onPrompt: onSecondPrompt })];
    try {
      const { second } = await run({ first, candidates });
      expect(second?.tries).toBe(3);
      expect(await holdEndedBy).toBe("second reviewer");
    } finally {
      clearTimeout(safety);
    }
    // And the order shows it: the second reviewer was already asking before the second of the normal reviews began.
    expect(together.indexOf("second-a:CODE")).toBeLessThan(together.indexOf("first-v1:SECURITY"));
  }, 60_000);

  it("all of its tries share ONE budget of one reviewer's time limit, so a hanging model ends the loop at that limit", async () => {
    const prompts: string[] = [];
    const first = model("first-v1", [PASS], prompts);
    const candidates = [model("second-a", ["hang"], prompts), model("second-b", ["hang"], prompts)];
    const { second } = await run({ first, candidates, timeoutMs: 400 });
    // Three tries at 400 ms each would be 1200 ms; the shared budget ends the loop after the first one.
    expect(second?.tries).toBe(1);
    expect(second?.report).toMatchObject({ status: "UNKNOWN", failureReason: "TIMEOUT" });
  });

  it("a try that would run past the shared budget is cut at what is left of it, not given a fresh limit", async () => {
    const prompts: string[] = [];
    // The first try fails after 600 ms; the second hangs. With a shared budget of 1500 ms the second is cut at what is left (900 ms); with a fresh limit it would run 1500 ms more (2100 ms in all).
    // The clock is virtual (only the model moves it), so real work on a busy machine cannot use up the budget and the elapsed time is exact.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const slow = model("second-a", ["throw", "hang"], prompts, { delayMs: 600, fakeClock: true });
      const { second, elapsed } = await run({ first: model("first-v1", [PASS], prompts), candidates: [slow], timeoutMs: 1500 });
      expect(second?.tries).toBe(2);
      expect(second?.report).toMatchObject({ status: "UNKNOWN", failureReason: "TIMEOUT" });
      expect(elapsed).toBe(1500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sees only the change by default: no source tools and no lessons (owner decision, option C); same_as_first gives it what the first reviewer has", async () => {
    const seen: string[] = [];
    const sources = { tools: [{ name: "lookup_ticket" }], note: "SOURCES-NOTE", labels: [{ label: "Jira" }] };
    const track = (id: string) => {
      const m = model(id, [PASS], seen);
      const inner = m.piAdapter.create.bind(m.piAdapter);
      m.piAdapter.create = async (input) => { seen.push(`${id}:tools=${String((input as unknown as { contextTools?: unknown[] }).contextTools?.length ?? 0)}`); const session = await inner(input); const prompt = session.prompt.bind(session); session.prompt = async (text) => { seen.push(`${id}:lessons=${String(text.includes("LESSON-BLOCK"))}`); return prompt(text); }; return session; };
      return m;
    };
    await run({ first: track("first-v1"), candidates: [track("second-a")], sources, learnedBlock: "LESSON-BLOCK" });
    expect(seen).toContain("first-v1:tools=1");
    expect(seen).toContain("first-v1:lessons=true");
    expect(seen).toContain("second-a:tools=0");
    expect(seen).toContain("second-a:lessons=false");
    seen.length = 0;
    await run({ first: track("first-v1"), candidates: [track("second-a")], sources, learnedBlock: "LESSON-BLOCK", context: "change_only" });
    expect(seen).toContain("second-a:tools=0");
    seen.length = 0;
    await run({ first: track("first-v1"), candidates: [track("second-a")], sources, learnedBlock: "LESSON-BLOCK", context: "same_as_first" });
    expect(seen).toContain("second-a:tools=1");
    expect(seen).toContain("second-a:lessons=true");
  });
});

describe("the second reviewer stops with the run (N3, N2)", () => {
  it("when a first review throws (base rule files that cannot be verified), the second reviewer's model call is stopped before the run ends", async () => {
    const prompts: string[] = [];
    let open = 0;
    let started = 0;
    // The first review's session fails only once the second reviewer is asking its model (not after a fixed wait, which a busy machine can outrun).
    let asking!: () => void;
    const askingModel = new Promise<void>((resolve) => { asking = resolve; });
    const hanging = model("second-a", ["hang"], prompts, { onPrompt: () => asking() });
    const inner = hanging.piAdapter.create.bind(hanging.piAdapter);
    hanging.piAdapter.create = async (input) => {
      const session = await inner(input);
      open += 1; started += 1;
      const dispose = session.dispose.bind(session);
      session.dispose = () => { open -= 1; dispose(); };
      return session;
    };
    const broken: ReturnType<typeof model> = { model: { provider: "test", modelId: "first-v1" }, piAdapter: { async create() { await Promise.race([askingModel, new Promise((resolve) => setTimeout(resolve, 30_000))]); throw new Error(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE); } } };
    await expect(run({ first: broken, candidates: [hanging] })).rejects.toThrow(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE);
    for (let waited = 0; open > 0 && waited < 30_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    // It had started (so the stop is what ended it, not its own limit of minutes), and its session is closed.
    expect(started).toBe(1);
    expect(open).toBe(0);
  }, 60_000);

  it("the step's tool list still narrows the second reviewer's tools when it sees only the change; the sources, lessons, step instructions and skills are what it drops", async () => {
    const seen: Array<{ who: string; tools: unknown; skills: unknown }> = [];
    const track = (id: string) => {
      const m = model(id, [PASS], []);
      const inner = m.piAdapter.create.bind(m.piAdapter);
      m.piAdapter.create = async (input) => { seen.push({ who: id, tools: (input as { agentTools?: unknown }).agentTools, skills: (input as { skills?: unknown }).skills }); return inner(input); };
      return m;
    };
    const base = { sources: undefined, learnedBlock: undefined };
    void base;
    await run({ first: track("first-v1"), candidates: [track("second-a")], tools: ["read", "grep"], skills: [{ name: "s", content: "x" }] });
    expect(seen.find((entry) => entry.who === "second-a")).toMatchObject({ tools: ["read", "grep"], skills: undefined });
    expect(seen.find((entry) => entry.who === "first-v1")).toMatchObject({ tools: ["read", "grep"] });
  });
});

describe("the tries, as a rule", () => {
  const A = { provider: "p", modelId: "a" };
  const B = { provider: "p", modelId: "b" };

  it("same model once more, then the next candidate, at most three in all", () => {
    expect(nextSecondReviewModel([A, B], [])).toEqual(A);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }])).toEqual(A);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }, { model: A, outcome: "no-answer" }])).toEqual(B);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }, { model: A, outcome: "no-answer" }, { model: B, outcome: "no-answer" }])).toBeUndefined();
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "answered" }])).toBeUndefined();
  });

  it("a model the account cannot use is left out at once", () => {
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "unusable" }])).toEqual(B);
    expect(nextSecondReviewModel([A], [{ model: A, outcome: "unusable" }])).toBeUndefined();
  });

  it("a context-length rejection is no answer, never an unusable model", () => {
    const rejected = { status: "UNKNOWN", modelFailure: "the model call failed: request-rejected ValidationException HTTP 400" };
    expect(secondReviewTryOutcome(rejected)).toBe("no-answer");
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: secondReviewTryOutcome(rejected) }])).toEqual(A);
    expect(secondReviewTryOutcome({ status: "UNKNOWN", modelFailure: "the model call failed: model-not-found" })).toBe("unusable");
    expect(secondReviewTryOutcome({ status: "PASS" })).toBe("answered");
  });
});

describe("the field and the feature", () => {
  it("is a worker feature that the contracts list and this worker implements", () => {
    expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain(SECOND_REVIEWER_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES as readonly string[]).toContain(SECOND_REVIEWER_FEATURE);
  });

  it("is a review-only, code-review-only field with one or two names", () => {
    const candidate = { model: { provider: "openrouter", modelId: "openai/gpt-5.5" }, modelRoute: { alias: "org-x", api: "openai-responses", catalog: "openai/gpt-5.5" } };
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate] }).success).toBe(true);
    expect(SecondReviewerSchema.safeParse({ candidates: [] }).success).toBe(false);
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate, candidate, candidate] }).success).toBe(false);
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate], extra: 1 }).success).toBe(false);
    const base = { protocolVersion: 1, kind: "task", operationId: OPERATION, workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const task = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ ...base, payload: { prompt: "x", conversationId: "33333333-3333-4333-8333-333333333333", conversationStarted: false, ...payload } });
    expect(task({ workflowMode: "REVIEW", workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(true);
    expect(task({ workflowMode: "IMPLEMENT", workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(false);
    expect(task({ workflowMode: "REVIEW", workflowReviewers: ["SECURITY"], workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(false);
  });

  it("each candidate is called through its own route; a routed candidate on a worker with no proxy is left out, not run on the task's model", () => {
    const payload = { workflowSecondReviewer: { candidates: [
      { model: { provider: "openrouter", modelId: "openai/gpt-5.5" }, modelRoute: { alias: "org-x", api: "openai-responses" as const, catalog: "openai/gpt-5.5" } },
      { model: { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" } },
    ] } };
    const proxy = { baseUrl: "http://proxy.invalid", source: async () => ({ apiKey: "k", expiresAt: 1 }) } as never;
    const withProxy = secondReviewerRuntimes(payload, proxy, {});
    expect(withProxy).toHaveLength(2);
    expect(withProxy![0]!.model.modelId).toBe("org-x");
    expect(secondReviewerRuntimes(payload, undefined, { AGENTX_MODEL_PROVIDER: "x", AGENTX_MODEL_ID: "y" })!.map((entry) => entry.model.modelId)).toEqual(["us.amazon.nova-pro-v1:0"]);
    expect(secondReviewerRuntimes({}, proxy, {})).toBeUndefined();
  });
});
