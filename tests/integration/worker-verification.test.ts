// Spec 051 Task 4 (FR-006, FR-007, SC-001): AgentX reruns the checks when the agent finishes, gives it exactly one
// extra try on a regression, and puts its report in the task result. Every task runs runTaskInvocation on the worker's
// real Pi session (createDefaultPiSessionAdapter) on the faux model, so the real extension and Pi's real
// agent_before_settle hook run. Only the check runners are fakes, except where a test says otherwise. Offline.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import type { BashOperations, InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  agentxPreambleSha256,
  AGENTX_PREAMBLE_VERSION,
  CheckReportSchema,
  createCandidateManifest,
  lastAssistantResponse,
  type CheckReport,
  type ProjectCommand,
  type WorkerInvocation,
  type WorkflowFeedbackBundle,
  type WorkflowFeedbackBundleRef,
  WorkflowFeedbackBundleSchema,
} from "../../packages/contracts/src/index.js";
import type { WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { createDefaultPiSessionAdapter, type PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation, type TaskInvocationResult } from "../../packages/worker/src/run-task.js";
import { projectCheckKey } from "../../packages/worker/src/verification/check-history.js";
import { createCheckRunners, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { runWorkflowFeedbackReview } from "../../packages/worker/src/verification/review.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { CHECKS_MESSAGE_TYPE, checksArtifactContent, compactCheckReport } from "../../packages/worker/src/verification/extension.js";
import { AgentFilesRestoreError, type OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const bash = (command: string, id: string) => toolUse(fauxToolCall("bash", { command }, { id }));
const write = (path: string, content: string, id: string) => toolUse(fauxToolCall("write", { path, content }, { id }));
const DONE = "AgentX result: done";

/** A workspace root with a preparation manifest, as the worker prepares one; `prepared` readiness passed there. */
async function workspaceRoot(prepared: ProjectCommand[] = []): Promise<string> {
  const rootPath = await createFixtureDirectory("agentx-verification-");
  await mkdir(join(rootPath, ".agentx"));
  await mkdir(join(rootPath, "app"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "verify", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], readinessCommandKeys: prepared.map(projectCheckKey), creationIdentity: "fixture", complete: true,
    updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

/** The agent's shell: runs nothing, prints per command, exits with the scripted code (exit 0 by default). */
function scriptedShell(script: Record<string, { exitCode: number; output: string }> = {}, onExec?: (command: string) => Promise<void> | void) {
  const commands: string[] = [];
  const operations: BashOperations = {
    exec: async (command, _cwd, options) => {
      commands.push(command);
      await onExec?.(command);
      const result = script[command] ?? { exitCode: 0, output: "ok\n" };
      options.onData(Buffer.from(result.output));
      return { exitCode: result.exitCode };
    },
  };
  return { commands, operations };
}

type AgentResult = { exitCode: number | null; timedOut: boolean; output: string };
type ProjectResult = { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string };

/** Fake runners: each round's result in order; the last repeats. Every call is recorded. */
function fakeRunners(options: { agent?: AgentResult[]; project?: ProjectResult[] } = {}) {
  const agentCalls: string[] = [];
  const projectCalls: ProjectCommand[] = [];
  const runners: CheckRunners = {
    async runAgentCommand(replay) {
      agentCalls.push(replay);
      const results = options.agent ?? [{ exitCode: 0, timedOut: false, output: "passed\n" }];
      return results[Math.min(agentCalls.length - 1, results.length - 1)]!;
    },
    async runProjectCommand(command) {
      projectCalls.push(command);
      const results = options.project ?? [{ exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "" }];
      return results[Math.min(projectCalls.length - 1, results.length - 1)]!;
    },
  };
  return { runners, agentCalls, projectCalls };
}

function budgetSequence(budgets: number[]): () => number {
  let round = 0;
  return () => budgets[Math.min(round++, budgets.length - 1)]!;
}

/** One model request: the conversation the model was given, without the system message. */
type Request = Array<{ role: string; content: unknown }>;

async function runTask(options: {
  steps: FauxResponseStep[];
  readiness?: ProjectCommand[];
  prepared?: ProjectCommand[];
  runners?: CheckRunners;
  shell?: ReturnType<typeof scriptedShell>;
  cancellation?: WorkerCancellationController;
  operationId?: string;
  rootPath?: string;
  /** Extensions loaded after AgentX's own, as a later handler on the same hook. */
  extraExtensions?: InlineExtension[];
  /** Each round's check budget, in order; the last repeats. Default: production's. */
  budgets?: number[];
  /** An artifact name whose upload fails, so the task throws after the agent finished. */
  failArtifact?: string;
  /** D-16: the original code AgentX measures before results on. Default: none (the fixture has no repositories). */
  originalCode?: OriginalCode;
}) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  const requests: Request[] = [];
  faux.setResponses(options.steps.map((step): FauxResponseStep => async (context: TranscriptContext, ...rest) => {
    requests.push(JSON.parse(JSON.stringify(context.messages.filter((message) => (message as { role: string }).role !== "system"))) as Request);
    return typeof step === "function" ? step(context, ...rest) : step;
  }));
  const base = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const shell = options.shell ?? scriptedShell();
  // Keeps run-task's own extensionFactories (the verification extension); only the shell is swapped.
  const piAdapter: PiSessionAdapter = { create: (input) => base.create({
    ...input, bashOperations: shell.operations, extensionFactories: [...(input.extensionFactories ?? []), ...(options.extraExtensions ?? [])],
  }) };
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, kind: "task", operationId: options.operationId ?? randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "fix it", ...(options.readiness === undefined ? {} : { readiness: options.readiness }) },
  };
  const rootPath = options.rootPath ?? await workspaceRoot(options.prepared ?? options.readiness ?? []);
  const events: WorkerEvent[] = [];
  const artifacts: WorkerArtifact[] = [];
  const started = performance.now();
  let result: TaskInvocationResult | undefined;
  let failure: unknown;
  try {
    result = await runTaskInvocation(invocation, {
      rootPath, model: FAUX_MODEL, piAdapter,
      ...(options.runners === undefined ? {} : { checkRunners: options.runners }),
      ...(options.budgets === undefined ? {} : { checkBudgetMs: budgetSequence(options.budgets) }),
      ...(options.cancellation === undefined ? {} : { cancellationController: options.cancellation }),
      ...(options.originalCode === undefined ? {} : { originalCode: options.originalCode }),
      eventSink: async (batch) => { events.push(...batch); },
      artifactSink: async (artifact) => {
        if (artifact.name === options.failArtifact) throw new Error(`upload of ${artifact.name} failed`);
        artifacts.push(artifact);
      },
    });
  } catch (error) {
    failure = error;
  }
  const checksArtifact = artifacts.find((artifact) => artifact.name === "checks.json");
  const report = checksArtifact === undefined ? undefined : CheckReportSchema.parse(JSON.parse(checksArtifact.content));
  const resultEvent = events.find((event) => event.type === "result");
  return { result, failure, events, artifacts, report, resultEvent, requests, rootPath, elapsed: performance.now() - started, invocation };
}

/** The user-role messages the model was given that carry AgentX's checks (a custom message reaches it as a user message). */
function checksMessages(request: Request): string[] {
  return request.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return [];
    const text = (message.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");
    return text.includes("AgentX reran the checks") ? [text] : [];
  });
}

const failedRun = (output: string): AgentResult => ({ exitCode: 1, timedOut: false, output });
const passedRun: AgentResult = { exitCode: 0, timedOut: false, output: "1 passed\n" };
const lint: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 };

async function feedbackReviewFixture() {
  const rootPath = await createFixtureDirectory("agentx-feedback-review-");
  const repository = join(rootPath, "app");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "src.ts"), "export function parse(input: string) { return input.trim(); }\n");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=AgentX Test", "-c", "user.email=test@example.invalid", "add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=AgentX Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const repositories = [{ repositoryId: "app", directory: repository }];
  const candidate = await readCandidateRepositories(repositories);
  const body = "Handle empty input before trimming.";
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const bundle: WorkflowFeedbackBundle = {
    schemaVersion: 1, taskId: randomUUID(), repositoryId: "app", number: 42,
    headSha: candidate[0]!.commitSha, candidateDigest: createCandidateManifest(candidate).digest,
    commentSetDigest: "a".repeat(64), producer: "agentx-github-reconciler", version: "1", recordedAt: new Date().toISOString(),
    comments: [{ id: "review-comment-1", threadId: "thread-1", kind: "REVIEW_COMMENT", url: "https://github.com/acme/app/pull/42#discussion_r1",
      author: "reviewer", updatedAt: new Date().toISOString(), bodyDigest, bodyBytes: Buffer.byteLength(body), path: "src.ts", line: 1, body }],
    sourceDeliveryIds: ["delivery-1"],
  };
  const normalized = WorkflowFeedbackBundleSchema.parse({ ...bundle, commentSetDigest: createHash("sha256").update(JSON.stringify(bundle.comments), "utf8").digest("hex") });
  Object.assign(bundle, normalized);
  const bytes = JSON.stringify(bundle);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { sourceDeliveryIds: _deliveryIds, comments, ...metadata } = bundle;
  const bundleRef: WorkflowFeedbackBundleRef = {
    ...metadata, sha256, objectKey: `feedback/${sha256}.json`,
    comments: comments.map(({ body: _body, ...comment }) => comment),
  };
  return { rootPath, repositories, candidate, bundle, bundleRef, bytes, taskId: bundle.taskId };
}

function feedbackReviewerAdapter(response: string, beforePrompt?: () => Promise<void> | void): PiSessionAdapter {
  return {
    async create(input) {
      let notify: ((event: unknown) => void) | undefined;
      return {
        conversationId: randomUUID(), sessionFile: join(input.sessionDirectory, "feedback-review.json"),
        async prompt(_prompt) {
          await beforePrompt?.();
          notify?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: response }] } });
        }, async abort() {},
        getModel: () => ({ provider: "test-provider", modelId: "read-only-critic-v1" }),
        getSessionStats: () => ({ totalMessages: 2, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }),
        subscribe(listener) { notify = listener; return () => { notify = undefined; }; },
        dispose() {},
      };
    },
  };
}

describe("AI-generated PR feedback advisory", () => {
  it("reviews every supplied bundle comment on the exact candidate in a read-only session and persists a digested report", async () => {
    const fixture = await feedbackReviewFixture();
    const finding = {
      id: "finding-1", bundleDigest: fixture.bundleRef.sha256, commentIds: ["review-comment-1"],
      priority: "MUST_FIX", assessment: "ACTIONABLE", recommended: true,
      evidence: [{ source: "candidate", reference: "app/src.ts:1" }],
      rationale: "The implementation calls trim without handling an empty value as requested.",
      confidence: { level: "HIGH", reason: "The comment and implementation identify the same missing behavior." },
      proposedDisposition: "IMPLEMENT",
    };
    const capturedArtifacts: WorkerArtifact[] = [];
    let sessionMode: string | undefined;
    const base = feedbackReviewerAdapter(JSON.stringify({ findings: [finding] }));
    const adapter: PiSessionAdapter = {
      create: async (input) => { sessionMode = input.workflowMode; return base.create(input); },
    };
    const review = await runWorkflowFeedbackReview({
      operationId: randomUUID(), taskId: fixture.taskId, workflowRevision: 7,
      taskRequirements: "Return a safe result for empty input.",
      rootPath: fixture.rootPath, model: FAUX_MODEL, candidate: fixture.candidate, repositories: fixture.repositories,
      bundles: [{ ref: fixture.bundleRef, bytes: fixture.bytes }], piAdapter: adapter,
      artifactSink: async (artifact) => { capturedArtifacts.push(artifact); },
    });
    expect(sessionMode).toBe("REVIEW");
    expect(review.report.status).toBe("COMPLETE");
    expect(review.report).toMatchObject({ workflowRevision: 7, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY" });
    expect(review.report).not.toHaveProperty("reviewerId");
    expect(review.report).not.toHaveProperty("readOnly");
    expect(review.report.findings).toHaveLength(1);
    expect(review.report.findings[0]?.commentIds).toEqual(["review-comment-1"]);
    expect(review.report.bundleDigests).toEqual([fixture.bundleRef.sha256]);
    expect(review.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capturedArtifacts.some((artifact) => artifact.name === review.artifactName
      && createHash("sha256").update(artifact.content, "utf8").digest("hex") === review.outputDigest)).toBe(true);
  });
});

describe("AgentX checks the agent's work when it finishes (spec 051 Task 4)", () => {
  it("1. pass: the agent's pytest failed before its edit and the rerun passes; verified, no extra try, one request after the edit", async () => {
    const shell = scriptedShell({ pytest: { exitCode: 1, output: "1 failed\nCommand exited with code 1" } });
    const fake = fakeRunners({ agent: [passedRun] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "fixed\n", "c2"), fauxAssistantMessage(`Fixed it.\n${DONE}`)],
      runners: fake.runners, shell,
    });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "verified", source: "agent_commands", extraTry: "not_needed", agentClaim: "success" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ id: "agent:0", label: "pytest", before: "failed", after: "passed", class: "fixed" })]);
    expect(fake.agentCalls).toEqual(["pytest"]);
    // Three requests: the pytest call, the edit, and exactly one after the edit.
    expect(run.requests).toHaveLength(3);
    expect(run.requests.flatMap(checksMessages)).toEqual([]);
  });

  it("2. regression fixed: the extra turn gets the failing output as a user message, and the second rerun passes", async () => {
    const shell = scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } });
    const fake = fakeRunners({ agent: [failedRun("FAILED tests/test_a.py::test_b - AssertionError: 2 != 3\n1 failed, 2 passed"), passedRun] });
    const run = await runTask({
      steps: [
        bash("pytest", "c1"), write("src.py", "broken\n", "c2"), fauxAssistantMessage(`Done.\n${DONE}`),
        write("src.py", "fixed\n", "c3"), fauxAssistantMessage(`Fixed the regression.\n${DONE}`),
      ],
      runners: fake.runners, shell,
    });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "verified", extraTry: "given", agentClaim: "success" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ before: "passed", after: "passed", class: "passing" })]);
    // Exactly two settle rounds.
    expect(fake.agentCalls).toEqual(["pytest", "pytest"]);
    expect(run.requests).toHaveLength(5);
    const feedback = checksMessages(run.requests[3]!);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toContain("Check: pytest");
    expect(feedback[0]).toContain("Before your change: passed. Now: failed. This is a regression.");
    expect(feedback[0]).toContain("AssertionError: 2 != 3");
    // Before the extra try the model never saw it.
    expect(run.requests.slice(0, 3).flatMap(checksMessages)).toEqual([]);
    // The custom message is in the transcript, hidden from display.
    const [sessionFile] = (await readdir(join(run.rootPath, "agent-sessions"))).filter((name) => name.endsWith(".jsonl"));
    const transcript = (await readFile(join(run.rootPath, "agent-sessions", sessionFile!), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; display?: boolean });
    expect(transcript.filter((entry) => entry.type === "custom_message")).toEqual([expect.objectContaining({ customType: CHECKS_MESSAGE_TYPE, display: false })]);
  });

  it("3. regression remains: both reruns fail; regression, extra try given, and no third request", async () => {
    const shell = scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } });
    const fake = fakeRunners({ agent: [failedRun("1 failed")] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "broken\n", "c2"), fauxAssistantMessage("Done."), fauxAssistantMessage("I could not fix it.\nAgentX result: not done")],
      runners: fake.runners, shell,
    });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given", agentClaim: "failure" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ before: "passed", after: "failed", class: "regression" })]);
    expect(fake.agentCalls).toHaveLength(2);
    expect(run.requests).toHaveLength(4);
  });

  it("4. claim: the extra turn's final line says done while a project check's regression remains (Review Focus 4)", async () => {
    const fake = fakeRunners({ project: [{ exitCode: 1, timedOut: false, stdout: "", stderr: "lint: 2 errors" }] });
    const run = await runTask({
      steps: [write("src.py", "broken\n", "c1"), fauxAssistantMessage("First account.\nAgentX result: not done"), fauxAssistantMessage(`All good now.\n${DONE}`)],
      readiness: [lint], runners: fake.runners,
    });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "regression", source: "project", extraTry: "given", agentClaim: "success" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ id: "readiness:0", label: "npm run lint (in app)", before: "passed", after: "failed", class: "regression" })]);
    expect(fake.projectCalls).toHaveLength(2);
    // The agent's account (what Slack shows) is the extra turn's own message, the one the claim was read from.
    expect(lastAssistantResponse(run.events)).toBe(`All good now.\n${DONE}`);
  });

  it("5. a model error on the last turn: not_verified/error, and no checks ran (Review Focus 3)", async () => {
    const shell = scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } });
    const fake = fakeRunners();
    const run = await runTask({
      steps: [bash("pytest", "c1"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" })],
      runners: fake.runners, shell,
    });
    expect(String(run.failure)).toContain("model down");
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "error", checks: [], extraTry: "not_needed" });
    expect(fake.agentCalls).toEqual([]);
    expect(fake.projectCalls).toEqual([]);
  });

  it("6. a cancel during a check stops the real check within 10 s, and the report is not_verified/stopped (Review Focus 1)", async () => {
    const cancellation = new WorkerCancellationController();
    const operationId = randomUUID();
    const sleeper: ProjectCommand = { cwd: "app", executable: "sleep", args: ["30"], timeoutSeconds: 120 };
    const rootPath = await workspaceRoot([sleeper]);
    const real = createCheckRunners({ rootPath });
    let cancelledAt = 0;
    let checkEndedAt = 0;
    const runners: CheckRunners = {
      runAgentCommand: (replay, timeoutMs, signal) => real.runAgentCommand(replay, timeoutMs, signal),
      async runProjectCommand(command, signal) {
        // The check is running: cancel the task as a member would.
        setTimeout(() => { cancelledAt = performance.now(); void cancellation.cancel(operationId); }, 200);
        try {
          return await real.runProjectCommand(command, signal);
        } finally {
          checkEndedAt = performance.now();
        }
      },
    };
    const run = await runTask({
      steps: [fauxAssistantMessage(`Done.\n${DONE}`)], readiness: [sleeper], runners, cancellation, operationId, rootPath,
    });
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(cancelledAt).toBeGreaterThan(0);
    expect(checkEndedAt - cancelledAt).toBeLessThan(10_000);
    expect(run.elapsed).toBeLessThan(10_000);
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "stopped", source: "project" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ id: "readiness:0", after: "not_run", class: "not_rerun" })]);
  }, 20_000);

  it("6b. a cancel during the agent's turn (Pi skips the hook, P-4): run-task reports not_verified/stopped itself", async () => {
    const cancellation = new WorkerCancellationController();
    const operationId = randomUUID();
    const shell = scriptedShell({}, async (command) => {
      if (command !== "sleep 5") return;
      void cancellation.cancel(operationId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const fake = fakeRunners();
    const run = await runTask({ steps: [bash("sleep 5", "c1"), fauxAssistantMessage("Done.")], runners: fake.runners, shell, cancellation, operationId });
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "stopped", checks: [] });
    expect(fake.agentCalls).toEqual([]);
  });

  it("7. no checks: no readiness and no test command; not_verified/no_checks with source none", async () => {
    const fake = fakeRunners();
    const run = await runTask({ steps: [bash("ls", "c1"), fauxAssistantMessage(`Looked around.\n${DONE}`)], runners: fake.runners });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "no_checks", source: "none", checks: [], agentClaim: "success" });
    expect(fake.agentCalls).toEqual([]);
  });

  it("7b. every check left unrun by the budget is not_verified/stopped, never no_checks, so Slack gives no readiness advice (Minor 6)", async () => {
    const fake = fakeRunners();
    const run = await runTask({ steps: [fauxAssistantMessage("Done.")], readiness: [lint], runners: fake.runners, budgets: [1] });
    expect(fake.projectCalls).toEqual([]);
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "stopped", source: "project" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ class: "not_rerun" })]);
  });

  it("8. an old broker sends no readiness: the agent's own test commands are the checks (Review Focus 5)", async () => {
    const fake = fakeRunners({ agent: [passedRun] });
    const run = await runTask({
      // The workspace was prepared with readiness, but this payload carries none.
      steps: [bash("npm test", "c1"), fauxAssistantMessage("Done.")], prepared: [lint], runners: fake.runners,
    });
    expect(run.invocation.payload.readiness).toBeUndefined();
    expect(run.report).toMatchObject({ status: "verified", source: "agent_commands", agentClaim: "none" });
    expect(fake.agentCalls).toEqual(["npm test"]);
    expect(fake.projectCalls).toEqual([]);
  });

  it("9. the result event, the task result and checks.json carry the report, with the preamble's version and hash", async () => {
    const fake = fakeRunners({ agent: [passedRun] });
    const run = await runTask({ steps: [bash("pytest -k a", "c1"), fauxAssistantMessage(`Done.\n${DONE}`)], runners: fake.runners });
    expect(run.failure).toBeUndefined();
    expect(run.report).toMatchObject({ status: "verified", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256() });
    const fromEvent = CheckReportSchema.parse((run.resultEvent!.payload as { checks: unknown }).checks);
    expect(fromEvent).toEqual(run.report);
    expect(run.result!.checks).toEqual(run.report);
    expect(run.result!.checks.preambleSha256).toBe(agentxPreambleSha256());
  });
});

describe("the check history across tasks (spec 051 Rulings L and M)", () => {
  it("L: the agent rewrites .agentx/last-checks.json mid-task, and its regression is still reported", async () => {
    const key = projectCheckKey(lint);
    const fake = fakeRunners({ project: [{ exitCode: 1, timedOut: false, stdout: "lint failed", stderr: "" }] });
    const other = "e".repeat(64);
    const forged = JSON.stringify({ schemaVersion: 1, outcomes: { [key]: "failed", [other]: "passed" } });
    const run = await runTask({
      steps: [write(".agentx/last-checks.json", forged, "c1"), fauxAssistantMessage("Done."), fauxAssistantMessage("Still done.")],
      readiness: [lint], runners: fake.runners,
    });
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given" });
    expect(run.report!.checks[0]).toMatchObject({ before: "passed", after: "failed", class: "regression" });
    // The final round's outcome is merged over the snapshot, not over what the agent wrote.
    expect(JSON.parse(await readFile(join(run.rootPath, ".agentx/last-checks.json"), "utf8"))).toEqual({ schemaVersion: 1, outcomes: { [key]: "failed" } });
  });

  it("M: the final round's outcome is the next task's before, and only the final round's", async () => {
    const key = projectCheckKey(lint);
    const rootPath = await workspaceRoot([lint]);
    // Task 1: the first round fails, the extra turn fixes it. Only the final passed is recorded.
    const first = await runTask({
      steps: [write("src.py", "x\n", "c1"), fauxAssistantMessage("Done."), fauxAssistantMessage("Fixed.")],
      readiness: [lint], rootPath,
      runners: fakeRunners({ project: [{ exitCode: 1, timedOut: false, stdout: "", stderr: "bad" }, { exitCode: 0, timedOut: false, stdout: "", stderr: "" }] }).runners,
    });
    expect(first.report).toMatchObject({ status: "verified", extraTry: "given" });
    expect((JSON.parse(await readFile(join(rootPath, ".agentx/last-checks.json"), "utf8")) as { outcomes: unknown }).outcomes).toEqual({ [key]: "passed" });
    // Task 2 leaves it failing: a regression, recorded as failed.
    const second = await runTask({
      steps: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [lint], rootPath,
      runners: fakeRunners({ project: [{ exitCode: 1, timedOut: false, stdout: "", stderr: "bad" }] }).runners,
    });
    expect(second.report).toMatchObject({ status: "regression" });
    // Task 3: still failing is not this task's regression.
    const third = await runTask({
      steps: [fauxAssistantMessage("Done.")], readiness: [lint], rootPath,
      runners: fakeRunners({ project: [{ exitCode: 1, timedOut: false, stdout: "", stderr: "bad" }] }).runners,
    });
    expect(third.report).toMatchObject({ status: "verified", extraTry: "not_needed" });
    expect(third.report!.checks[0]).toMatchObject({ before: "failed", after: "failed", class: "already_failing" });
  });

  it("M: a history the worker can neither restore nor remove is a redacted diagnostic, and never fails the task (Ruling O)", async (context) => {
    // chmod does not stop root.
    if (process.getuid?.() === 0) context.skip();
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const rootPath = await workspaceRoot([lint]);
    // The agent leaves a directory the worker cannot empty where the history goes (after the snapshot).
    const locked = join(rootPath, ".agentx/last-checks.json", awsKey);
    const shell = scriptedShell({}, async (command) => {
      if (command !== "block") return;
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, "stale"), "x");
      await chmod(locked, 0o500);
    });
    try {
      const run = await runTask({
        steps: [bash("block", "c1"), fauxAssistantMessage("Done.")], readiness: [lint], rootPath, shell,
        runners: fakeRunners().runners,
      });
      expect(run.failure).toBeUndefined();
      expect(run.report).toMatchObject({ status: "verified" });
      const progress = run.events.flatMap((event) => {
        const message = event.type === "progress" ? (event.payload as { message?: unknown }).message : undefined;
        return typeof message === "string" ? [message] : [];
      });
      const diagnostic = progress.find((message) => message.includes("could neither restore nor remove"));
      expect(diagnostic).toBeDefined();
      expect(diagnostic).not.toContain(awsKey);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("the report as the task result carries it", () => {
  it("cuts outputs and labels so 64 checks stay far below DynamoDB's 400 KB item limit; a small report is unchanged", () => {
    const entry = { id: "agent:0", label: "x".repeat(8_192), source: "agent_commands", before: "passed", after: "failed", class: "regression", output: "line\n".repeat(13_000), durationMs: 1 } as const;
    const report: CheckReport = {
      status: "regression", source: "agent_commands", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
      checks: Array.from({ length: 64 }, (_, index) => ({ ...entry, id: `agent:${index}` })), extraTry: "given", agentClaim: "success",
    };
    const compact = compactCheckReport(report);
    expect(CheckReportSchema.parse(compact).checks).toHaveLength(64);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(200 * 1024);
    const small = { ...report, checks: [{ ...entry, label: "pytest", output: "1 failed" }] };
    expect(compactCheckReport(small)).toEqual(small);
  });
});

describe("an extra try with no second settle (Ruling N)", () => {
  it("reports the first round's regression, extraTry given, when Pi cannot run the extra turn", async () => {
    // A later handler drops AgentX's message and keeps continue: Pi has no runnable context and settles.
    const stub: InlineExtension = { name: "agentx-test-stub", factory: (pi) => { pi.on("agent_before_settle", () => ({ entries: [] })); } };
    const fake = fakeRunners({ agent: [failedRun("1 failed")] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "broken\n", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)],
      runners: fake.runners, shell: scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } }), extraExtensions: [stub],
    });
    expect(run.failure).toBeUndefined();
    expect(fake.agentCalls).toEqual(["pytest"]);
    expect(run.requests).toHaveLength(3);
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given", agentClaim: "success" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ before: "passed", after: "failed", class: "regression" })]);
    expect(run.result!.checks).toEqual(run.report);
  });

  it("is stopped when the signal aborted during the extra turn", async () => {
    const cancellation = new WorkerCancellationController();
    const operationId = randomUUID();
    const shell = scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } }, async (command) => {
      if (command !== "sleep 5") return;
      void cancellation.cancel(operationId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const fake = fakeRunners({ agent: [failedRun("1 failed")] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "broken\n", "c2"), fauxAssistantMessage("Done."), bash("sleep 5", "c3"), fauxAssistantMessage("Fixed.")],
      runners: fake.runners, shell, cancellation, operationId,
    });
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(fake.agentCalls).toEqual(["pytest"]);
    // Ruling Y: a stop does not verify the regression AgentX found, so it stands, and the failure carries it to the broker.
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given", source: "agent_commands" });
    expect(run.report!.checks).toEqual([expect.objectContaining({ class: "regression" })]);
    expect(CheckReportSchema.parse((run.failure as { checks?: unknown }).checks)).toMatchObject({ status: "regression" });
  });
});

/** The history file as the next task reads it, parsed; undefined when it is not a usable file. */
async function historyOutcomes(rootPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (JSON.parse(await readFile(join(rootPath, ".agentx/last-checks.json"), "utf8")) as { outcomes: Record<string, unknown> }).outcomes;
  } catch {
    return undefined;
  }
}

describe("AgentX restores the check history on every ending (Ruling O, I-1)", () => {
  const key = projectCheckKey(lint);
  const other = "e".repeat(64);
  const seeded = { [key]: "passed", [other]: "failed" };
  const fail: ProjectResult = { exitCode: 1, timedOut: false, stdout: "", stderr: "lint failed" };

  /** A prepared workspace whose history the agent replaces with a non-empty directory when it runs `tamper`. */
  async function tamperedWorkspace(cancel?: () => void) {
    const rootPath = await workspaceRoot([lint]);
    const path = join(rootPath, ".agentx/last-checks.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, outcomes: seeded }));
    const shell = scriptedShell({}, async (command) => {
      if (command !== "tamper") return;
      await rm(path, { force: true });
      await mkdir(join(path, "planted"), { recursive: true });
      cancel?.();
      if (cancel !== undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    });
    return { rootPath, shell };
  }

  it.each([
    ["verified", { readiness: [lint], runs: undefined, final: fauxAssistantMessage("Done."), expected: { [key]: "passed", [other]: "failed" } }],
    ["regression", { readiness: [lint], runs: [fail], final: fauxAssistantMessage("Done."), expected: { [key]: "failed", [other]: "failed" } }],
    ["not_verified, an old broker with no readiness", { readiness: undefined, runs: undefined, final: fauxAssistantMessage("Done."), expected: seeded }],
    ["a model error", { readiness: [lint], runs: undefined, final: fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" }), expected: seeded }],
  ] as const)("restores it after %s", async (_name, scenario) => {
    const { rootPath, shell } = await tamperedWorkspace();
    await runTask({
      steps: [bash("tamper", "c1"), scenario.final, fauxAssistantMessage("Still done.")],
      ...(scenario.readiness === undefined ? {} : { readiness: [...scenario.readiness] }),
      rootPath, shell, runners: fakeRunners(scenario.runs === undefined ? {} : { project: [...scenario.runs] }).runners,
    });
    expect(await historyOutcomes(rootPath)).toEqual(scenario.expected);
  });

  it("restores it after a cancel", async () => {
    const cancellation = new WorkerCancellationController();
    const operationId = randomUUID();
    const { rootPath, shell } = await tamperedWorkspace(() => { void cancellation.cancel(operationId); });
    const run = await runTask({ steps: [bash("tamper", "c1"), fauxAssistantMessage("Done.")], readiness: [lint], rootPath, shell, cancellation, operationId, runners: fakeRunners().runners });
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(await historyOutcomes(rootPath)).toEqual(seeded);
  });

  it("restores it, with the final round's outcomes, when the task throws after the agent finished", async () => {
    const { rootPath, shell } = await tamperedWorkspace();
    const run = await runTask({
      steps: [bash("tamper", "c1"), fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [lint], rootPath, shell,
      runners: fakeRunners({ project: [fail] }).runners, failArtifact: "workspace.diff",
    });
    expect(String(run.failure)).toContain("upload of workspace.diff failed");
    expect(await historyOutcomes(rootPath)).toEqual({ [key]: "failed", [other]: "failed" });
  });

  it("keeps the next task's regression a regression after the agent planted a directory in a task that ended in a model error", async () => {
    const { rootPath, shell } = await tamperedWorkspace();
    await runTask({ steps: [bash("tamper", "c1"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" })], readiness: [lint], rootPath, shell, runners: fakeRunners().runners });
    const next = await runTask({ steps: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [lint], rootPath, runners: fakeRunners({ project: [fail] }).runners });
    expect(next.report).toMatchObject({ status: "regression" });
    expect(next.report!.checks[0]).toMatchObject({ before: "passed", after: "failed", class: "regression" });
  });

  it("keeps the next task's regression a regression after the agent wrote garbage in a task with no checks", async () => {
    const rootPath = await workspaceRoot([lint]);
    await runTask({ steps: [write(".agentx/last-checks.json", "not json", "c1"), fauxAssistantMessage("Done.")], rootPath, runners: fakeRunners().runners });
    const next = await runTask({ steps: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [lint], rootPath, runners: fakeRunners({ project: [fail] }).runners });
    expect(next.report).toMatchObject({ status: "regression" });
  });
});

describe("an unusable history path the worker cannot remove (Ruling P, I-4)", () => {
  it("task 1's agent leaves a locked directory at the history path; task 2's broken prepared check is a regression", async (context) => {
    // chmod does not stop root.
    if (process.getuid?.() === 0) context.skip();
    const rootPath = await workspaceRoot([lint]);
    const locked = join(rootPath, ".agentx/last-checks.json/locked");
    const shell = scriptedShell({}, async (command) => {
      if (command !== "lock") return;
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, "stale"), "x");
      await chmod(locked, 0o500);
    });
    try {
      const first = await runTask({ steps: [bash("lock", "c1"), fauxAssistantMessage("Done.")], readiness: [lint], rootPath, shell, runners: fakeRunners().runners });
      expect(first.report).toMatchObject({ status: "verified" });
      const fail: ProjectResult = { exitCode: 1, timedOut: false, stdout: "", stderr: "lint failed" };
      const second = await runTask({
        steps: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [lint], rootPath,
        runners: fakeRunners({ project: [fail] }).runners,
      });
      expect(second.report).toMatchObject({ status: "regression" });
      expect(second.report!.checks[0]).toMatchObject({ before: "passed", after: "failed", class: "regression" });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("the round after the extra try (Ruling O)", () => {
  it("I-2: a round-1 regression that round 2's budget leaves unrun stays a regression", async () => {
    const quick: ProjectCommand = { cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 };
    let quickRuns = 0;
    let lintRuns = 0;
    const runners: CheckRunners = {
      runAgentCommand: () => Promise.reject(new Error("not used")),
      async runProjectCommand(command) {
        if (command.args[0] === "test") {
          quickRuns += 1;
          // Round 2's budget is 1.5 s: after this, too little is left to start the lint check.
          if (quickRuns === 2) await new Promise((resolve) => setTimeout(resolve, 1_100));
          return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
        }
        lintRuns += 1;
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "lint failed" };
      },
    };
    const run = await runTask({
      steps: [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")], readiness: [quick, lint], runners, budgets: [60_000, 1_500],
    });
    expect(lintRuns).toBe(1);
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given" });
    expect(run.report!.checks).toEqual([
      expect.objectContaining({ id: "readiness:0", class: "passing" }),
      expect.objectContaining({ id: "readiness:1", before: "passed", after: "failed", class: "regression" }),
    ]);
  });

  it("I-3: a verified settle, a continuation queued by another extension, then a regression with no second settle, reports the regression", async () => {
    let settles = 0;
    const stub: InlineExtension = {
      name: "agentx-test-stub",
      factory: (pi) => {
        pi.on("agent_before_settle", (event) => {
          settles += 1;
          // First settle: another extension asks for one more turn. Second: it drops AgentX's message (unrunnable).
          if (settles === 1) return { entries: [...event.entries, { type: "custom_message", customType: "agentx_test", content: "One more thing.", display: false }], continue: true };
          return { entries: [] };
        });
      },
    };
    const fake = fakeRunners({ agent: [passedRun, failedRun("1 failed")] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "x\n", "c2"), fauxAssistantMessage("Done."), fauxAssistantMessage("Also done.")],
      runners: fake.runners, shell: scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } }), extraExtensions: [stub],
    });
    expect(fake.agentCalls).toHaveLength(2);
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given" });
  });

  it("M-2 (Ruling Y): a model error on the extra turn keeps the first round's regression, and the failure carries it", async () => {
    const fake = fakeRunners({ agent: [failedRun("1 failed")] });
    const run = await runTask({
      steps: [bash("pytest", "c1"), write("src.py", "x\n", "c2"), fauxAssistantMessage("Done."), fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" })],
      runners: fake.runners, shell: scriptedShell({ pytest: { exitCode: 0, output: "3 passed\n" } }),
    });
    expect(fake.agentCalls).toHaveLength(1);
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given", source: "agent_commands" });
    expect(run.report).not.toHaveProperty("notVerifiedReason");
    expect(run.report!.checks).toEqual([expect.objectContaining({ class: "regression" })]);
    // The task ends FAILED, and its error carries the report so the broker can keep the regression standing.
    expect(run.failure).toBeInstanceOf(Error);
    expect((run.failure as { checks?: unknown }).checks).toEqual(compactCheckReport(run.report!));
  });

  it("a task that fails with no regression carries no report on its error", async () => {
    const run = await runTask({
      steps: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" })],
    });
    expect(run.failure).toBeInstanceOf(Error);
    expect(run.failure).not.toHaveProperty("checks");
  });
});

describe("the report's size limits (M-4, M-5)", () => {
  const entry = { id: "agent:0", label: "x", source: "agent_commands", before: "passed", after: "failed", class: "regression", output: "", durationMs: 1 } as const;
  const report = (label: string, output: string): CheckReport => ({
    status: "regression", source: "agent_commands", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
    checks: Array.from({ length: 64 }, (_, index) => ({ ...entry, id: `agent:${index}`, label, output })), extraTry: "given", agentClaim: "success",
  });

  it("cuts labels by bytes: 64 checks of three-byte labels stay below 160 KB in the task result", () => {
    const compact = compactCheckReport(report("\u20ac".repeat(8_192), "\u20ac".repeat(20_000)));
    expect(CheckReportSchema.parse(compact).checks).toHaveLength(64);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(160 * 1024);
  });

  it("keeps checks.json below the 5 MB artifact limit, even when escaping grows the output", () => {
    const content = checksArtifactContent(report("x".repeat(8_192), "\u001b".repeat(65_536)));
    expect(Buffer.byteLength(content)).toBeLessThan(4_500_000);
    expect(CheckReportSchema.parse(JSON.parse(content)).checks).toHaveLength(64);
    const small = report("pytest", "1 failed");
    expect(JSON.parse(checksArtifactContent(small))).toEqual(small);
  });
});

describe("AgentX measures the before result on the original code (spec 051 D-16, #290)", () => {
  /** An original code that only says when it is shown; the runner answers by it. Real Git is in worker-original-code.test.ts. */
  function fakeOriginalCode(failure?: Error) {
    const state = { showing: false, runs: 0 };
    const originalCode: OriginalCode = {
      async run(work) {
        state.runs += 1;
        if (failure !== undefined) throw failure;
        state.showing = true;
        try { return await work(); } finally { state.showing = false; }
      },
    };
    return { originalCode, state };
  }
  /** A runner whose result depends on whether the original code is shown. */
  function byCode(state: { showing: boolean }, onOriginal: AgentResult, onAgent: AgentResult) {
    const calls: Array<{ replay: string; original: boolean }> = [];
    const runners: CheckRunners = {
      async runAgentCommand(replay) { calls.push({ replay, original: state.showing }); return state.showing ? onOriginal : onAgent; },
      async runProjectCommand() { throw new Error("no readiness"); },
    };
    return { runners, calls };
  }
  const progress = (events: WorkerEvent[]) => events.flatMap((event) => (event.type === "progress" ? [String((event.payload as { message?: unknown }).message)] : []));

  it("catches a regression when the agent edited before its first test run, and gives the extra try", async () => {
    const { originalCode, state } = fakeOriginalCode();
    const { runners, calls } = byCode(state, passedRun, failedRun("1 failed\n"));
    const run = await runTask({
      steps: [write("src.py", "changed\n", "c1"), bash("pytest -k x 2>&1 | tail -20", "c2"), fauxAssistantMessage(`Done.\n${DONE}`), fauxAssistantMessage("It checks the old behaviour.\nAgentX result: not done")],
      runners, originalCode,
    });
    expect(run.failure).toBeUndefined();
    expect(calls[0]).toEqual({ replay: "pytest -k x", original: true });
    expect(calls.slice(1).every((call) => !call.original)).toBe(true);
    expect(run.report).toMatchObject({ status: "regression", extraTry: "given" });
    expect(run.report!.checks[0]).toMatchObject({ before: "passed", after: "failed", class: "regression" });
    // Measured once: the extra try's round reuses it.
    expect(state.runs).toBe(1);
    const feedback = checksMessages(run.requests.at(-1)!).join("\n");
    expect(feedback).toContain("checks the old behaviour the task asked you to change, it is not a regression");
    // D-18: the message never invites the agent to edit the test.
    expect(feedback).toContain("leave the test as it is and name it in your final message");
    expect(feedback).toContain("Never edit or delete a test to make it pass");
    expect(feedback).not.toContain("update the test");
  });

  it("counts a test that also fails on the original code as already failing, not the agent's regression", async () => {
    const { originalCode, state } = fakeOriginalCode();
    const { runners } = byCode(state, failedRun("X11 connection broke\n"), failedRun("X11 connection broke\n"));
    const run = await runTask({ steps: [write("src.py", "changed\n", "c1"), bash("pytest", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)], runners, originalCode });
    expect(run.report).toMatchObject({ status: "verified", extraTry: "not_needed" });
    expect(run.report!.checks[0]).toMatchObject({ before: "failed", after: "failed", class: "already_failing" });
  });

  it("does not run the original code when the agent's own run before its edit is the before result", async () => {
    const { originalCode, state } = fakeOriginalCode();
    const { runners } = byCode(state, passedRun, passedRun);
    const shell = scriptedShell({ pytest: { exitCode: 0, output: "1 passed\n" } });
    const run = await runTask({ steps: [bash("pytest", "c1"), write("src.py", "changed\n", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)], runners, originalCode, shell });
    expect(state.runs).toBe(0);
    expect(run.report!.checks[0]).toMatchObject({ before: "passed", after: "passed", class: "passing" });
  });

  /**
   * Feature: AgentX checks the agent's test commands (spec 051, #299)
   * Scenario: a test run inside a chain is rerun, with its before measured on the original code
   *   Given the agent runs `go build ./... && go test ./x 2>&1 | tail -20` before any edit, and its run exits 0
   *   And `go test ./x` fails on the original code and passes on the agent's
   *   When the agent finishes
   *   Then AgentX reruns `go test ./x`, measures its before on the original code rather than taking the chain's exit code,
   *   And reports the test as fixed
   * Requirement: docs/specs/issue-299/requirements.md#requirement-2-tests-inside-chains (2.1, 2.3; 5.2)
   */
  it("reruns a test the agent ran inside a chain, with its before measured on the original code (#299)", async () => {
    const { originalCode, state } = fakeOriginalCode();
    const { runners, calls } = byCode(state, failedRun("1 failed\n"), passedRun);
    const shell = scriptedShell();
    const run = await runTask({
      steps: [bash("go build ./... && go test ./x 2>&1 | tail -20", "c1"), write("x.go", "changed\n", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)],
      runners, originalCode, shell,
    });
    expect(run.failure).toBeUndefined();
    expect(shell.commands).toEqual(["go build ./... && go test ./x 2>&1 | tail -20"]);
    expect(calls[0]).toEqual({ replay: "go test ./x", original: true });
    expect(state.runs).toBe(1);
    expect(run.report).toMatchObject({ status: "verified", source: "agent_commands" });
    expect(run.report!.checks).toHaveLength(1);
    expect(run.report!.checks[0]).toMatchObject({ label: "go test ./x", before: "failed", after: "passed", class: "fixed" });
  });

  it("reports when the original code cannot be shown, and goes on without a before result", async () => {
    const { originalCode } = fakeOriginalCode(new Error("bad object 1234"));
    const { runners } = byCode({ showing: false }, passedRun, failedRun("1 failed\n"));
    const run = await runTask({ steps: [write("src.py", "changed\n", "c1"), bash("pytest", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)], runners, originalCode });
    expect(run.failure).toBeUndefined();
    expect(run.report!.checks[0]).toMatchObject({ before: "unknown", after: "failed", class: "failing_no_before" });
    expect(progress(run.events).some((message) => message.includes("could not run the agent's test commands on the original code"))).toBe(true);
  });

  it("reports an error, naming where the agent's files are kept, when they cannot be restored", async () => {
    const { originalCode } = fakeOriginalCode(new AgentFilesRestoreError("AgentX could not restore the agent's files; they are kept under refs/agentx/agent-files."));
    const { runners } = byCode({ showing: false }, passedRun, passedRun);
    const run = await runTask({ steps: [write("src.py", "changed\n", "c1"), bash("pytest", "c2"), fauxAssistantMessage(`Done.\n${DONE}`)], runners, originalCode });
    expect(run.report).toMatchObject({ status: "not_verified", notVerifiedReason: "error" });
    expect(progress(run.events).some((message) => message.includes("refs/agentx/agent-files"))).toBe(true);
  });
});
