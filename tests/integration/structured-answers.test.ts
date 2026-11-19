// Structured answers (Pi feature audit, recommendation 2): the reviewers, the plan check, Understand and a design-review reviewer answer through a tool whose schema Pi checks.
// These tests run the worker's real Pi session (createDefaultPiSessionAdapter) on Pi's scripted faux model, so Pi's own argument validation, `terminate: true` and the refusal retry are the real ones.
// Offline.
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, validateToolArguments, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTENT_BLOCK_INFO_STRING, IntentAssessmentSchema, PLAN_CRITIQUE_INFO_STRING, UNDERSTAND_ARTIFACT_NAME, WorkflowReviewFindingSchema, readIntentBlock, readPlanCritique, type IntentAssessment, type WorkerInvocation,
} from "../../packages/contracts/src/index.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { ANSWER_REFUSALS_MAX, ANSWER_TEXT_FALLBACK_NOTE, STRUCTURED_ANSWERS_ENVIRONMENT, answerSchemaOf, createAnswerChannel, structuredAnswersEnabled } from "../../packages/worker/src/structured-answer.js";
import { PLAN_CRITIQUE_ANSWER_MAX_BYTES } from "../../packages/worker/src/plan-critic.js";
import { planCritiqueAnswerSpec, reviewAnswerSpec, understandAnswerSpec } from "../../packages/worker/src/structured-answer-specs.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** The worker's real Pi adapter on the faux model, with the scripted steps. */
async function realAdapter(responses: FauxResponseStep[]) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  return { faux, adapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }) };
}

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "structured-answers-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

const messageText = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part as { text?: unknown }).text).filter((text): text is string => typeof text === "string").join("") : "";
};
type Seen = { toolNames: string[]; messages: Array<{ role: string; text: string }> };
/** What the model is offered on one call: the tool names, and the conversation as role and text. */
const seenBy = (context: TranscriptContext): Seen => ({
  toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
  messages: context.messages.filter((message) => (message as { role: string }).role !== "system").map((message) => ({ role: (message as { role: string }).role, text: messageText(message) })),
});
/** A scripted model step that records what it was offered, then answers with `message`. */
function step(seen: Seen[], message: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return (context: TranscriptContext) => { seen.push(seenBy(context)); return message(); };
}
const toolUse = (name: string, args: unknown, id = `call-${randomUUID()}`) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });

const READY: IntentAssessment = { kind: "ready", path: "FULL", restatement: "Make the retry flag read the config file.", assumptions: ["The config file is config/retry.json."] };
const fenced = (info: string, value: unknown) => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\`\n`;

function taskInvocation(workflowMode: "UNDERSTAND" | "PLAN_CRITIQUE", prompt: string): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt, workflowMode },
  };
}

async function runTask(adapter: ReturnType<typeof createDefaultPiSessionAdapter>, invocation: Extract<WorkerInvocation, { kind: "task" }>, structuredAnswers?: boolean) {
  const events: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: adapter, log: () => undefined,
    eventSink: async (batch) => { events.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); },
    ...(structuredAnswers === undefined ? {} : { structuredAnswers }),
  });
  return { events, artifacts };
}

describe("the setting", () => {
  it("is on unless ROVARA_STRUCTURED_ANSWERS says 0, false or off", () => {
    expect(structuredAnswersEnabled({})).toBe(true);
    expect(structuredAnswersEnabled({ [STRUCTURED_ANSWERS_ENVIRONMENT]: "1" })).toBe(true);
    for (const value of ["0", "false", "off", " OFF "]) expect(structuredAnswersEnabled({ [STRUCTURED_ANSWERS_ENVIRONMENT]: value })).toBe(false);
  });
});

describe("Understand answers through a tool", () => {
  it("takes a schema-valid answer in one model call: the saved assessment is the contract's, and the run ends on the accepted call", async () => {
    const seen: Seen[] = [];
    const { adapter, faux } = await realAdapter([step(seen, () => toolUse("submit_understanding", { assessment: READY }))]);
    const { artifacts, events } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolNames).toContain("submit_understanding");
    // The prompt says how to deliver the answer.
    expect(seen[0]!.messages.find((message) => message.role === "user")?.text).toContain("calling the submit_understanding tool");
    // terminate: no extra model turn after the tool result (the faux model would have thrown for a missing step).
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(artifacts.filter((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)).toEqual([{ name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(READY) }]);
    expect(events.some((event) => event.type === "result" && (event.payload as { status?: string }).status === "SUCCEEDED")).toBe(true);
    // Rovara's own "answer again" text retry never ran.
    expect(events.some((event) => event.type === "progress" && (typeof (event.payload as { message?: unknown }).message === "string" ? (event.payload as { message: string }).message : "").includes("answer again"))).toBe(false);
  });

  it("has an answer Pi's schema check refuses retried by Pi in the same run, not by a text prompt", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([
      step(seen, () => toolUse("submit_understanding", { assessment: { kind: "ready", path: "SOMETIMES", restatement: "x", assumptions: [] } })),
      step(seen, () => toolUse("submit_understanding", { assessment: READY })),
    ]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(seen).toHaveLength(2);
    // The second call saw Pi's refusal as the tool's result, and no new user message.
    const second = seen[1]!.messages;
    expect(second.at(-1)?.role).toBe("toolResult");
    expect(second.at(-1)?.text).toContain("Validation failed for tool \"submit_understanding\"");
    expect(second.filter((message) => message.role === "user")).toHaveLength(1);
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });

  it("has an answer the step's own reader refuses retried by Pi too (the reader is the tool's check)", async () => {
    const seen: Seen[] = [];
    const duplicate: IntentAssessment = { kind: "questions", restatement: "Which retry flag?", questions: [
      { id: "q1", text: "Which flag?", options: [{ id: "a", label: "One" }, { id: "b", label: "Two" }] },
      { id: "q1", text: "Which file?", options: [{ id: "a", label: "One" }, { id: "b", label: "Two" }] },
    ] } as never;
    expect(readIntentBlock(fenced(INTENT_BLOCK_INFO_STRING, duplicate)).ok).toBe(false);
    const { adapter } = await realAdapter([
      step(seen, () => toolUse("submit_understanding", { assessment: duplicate })),
      step(seen, () => toolUse("submit_understanding", { assessment: READY })),
    ]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("each question id is used once");
    expect(seen[1]!.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });

  it("falls back to the text answer and its text parse when the model writes the block instead of calling the tool", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => fauxAssistantMessage(`I read the code.\n\n${fenced(INTENT_BLOCK_INFO_STRING, READY)}`))]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });

  it("keeps the text retry as the fallback when the model's text answer cannot be read", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => fauxAssistantMessage("It looks fine to me.")), step(seen, () => fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, READY)))]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("Your answer could not be read as an understanding of the request.");
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });

  it("flips back with structuredAnswers off: no answer tool, no instruction, and the text answer is read as before", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, READY)))]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."), false);
    expect(seen[0]!.toolNames).not.toContain("submit_understanding");
    expect(seen[0]!.messages.find((message) => message.role === "user")?.text).not.toContain("submit_understanding");
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });

  it("flips back from the environment: ROVARA_STRUCTURED_ANSWERS=0 offers no tool", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, READY)))]);
    const before = process.env[STRUCTURED_ANSWERS_ENVIRONMENT];
    process.env[STRUCTURED_ANSWERS_ENVIRONMENT] = "0";
    try { await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request.")); } finally { if (before === undefined) delete process.env[STRUCTURED_ANSWERS_ENVIRONMENT]; else process.env[STRUCTURED_ANSWERS_ENVIRONMENT] = before; }
    expect(seen[0]!.toolNames).not.toContain("submit_understanding");
    expect(seen[0]!.messages.find((message) => message.role === "user")?.text).not.toContain("submit_understanding");
  });

  it("tells the model to answer in plain text after ANSWER_REFUSALS_MAX refused answers in a row, and then reads that text", async () => {
    const seen: Seen[] = [];
    // Different arguments each time: three identical failing calls would also trip the task's own loop guard (tool-loop-guard.ts), which is not what this test is about.
    const { adapter } = await realAdapter([
      ...Array.from({ length: ANSWER_REFUSALS_MAX }, (_, index) => step(seen, () => toolUse("submit_understanding", { assessment: { kind: "ready", path: `attempt-${String(index)}` } }))),
      step(seen, () => fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, READY))),
    ]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(seen).toHaveLength(ANSWER_REFUSALS_MAX + 1);
    expect(seen.at(-1)!.messages.some((message) => message.role === "user" && message.text.includes(ANSWER_TEXT_FALLBACK_NOTE))).toBe(true);
    expect(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)?.content).toBe(JSON.stringify(READY));
  });
});

describe("the plan check answers through a tool", () => {
  const critique = { verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "No limit on retries." }] };

  it("uploads the accepted answer as the block the broker reads", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => toolUse("submit_plan_check", critique))]);
    const { artifacts } = await runTask(adapter, taskInvocation("PLAN_CRITIQUE", "Plan check.\n\nThe plan: ..."));
    expect(seen).toHaveLength(1);
    const uploaded = artifacts.filter((artifact) => artifact.name === "plan-critique.md");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.content).toBe(fenced(PLAN_CRITIQUE_INFO_STRING, critique).trim());
    expect(readPlanCritique(uploaded[0]!.content)).toEqual({ ok: true, verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "No limit on retries." }] });
  });

  it("refuses an answer with a verdict outside the contract's two words, and Pi retries it", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => toolUse("submit_plan_check", { verdict: "approve", points: [] })), step(seen, () => toolUse("submit_plan_check", critique))]);
    const { artifacts } = await runTask(adapter, taskInvocation("PLAN_CRITIQUE", "Plan check."));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("Validation failed for tool \"submit_plan_check\"");
    expect(readPlanCritique(artifacts.find((artifact) => artifact.name === "plan-critique.md")!.content)).toMatchObject({ ok: true, verdict: "revise" });
  });

  it("flips back: with structuredAnswers off the critic answers in text, as before", async () => {
    const seen: Seen[] = [];
    const text = `The plan is sound.\n\n${fenced(PLAN_CRITIQUE_INFO_STRING, critique)}`;
    const { adapter } = await realAdapter([step(seen, () => fauxAssistantMessage(text))]);
    const { artifacts } = await runTask(adapter, taskInvocation("PLAN_CRITIQUE", "Plan check."), false);
    expect(seen[0]!.toolNames).not.toContain("submit_plan_check");
    expect(artifacts.find((artifact) => artifact.name === "plan-critique.md")?.content).toBe(text.trim());
  });
});

describe("the reviewers answer through a tool", () => {
  async function changedRepository(rootPath: string) {
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet"); await git("config", "user.email", "r@example.invalid"); await git("config", "user.name", "R");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts"); await git("commit", "--quiet", "-m", "baseline");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    const repositories = [{ repositoryId: "payments", directory }];
    const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
    return { repositories, candidate };
  }
  const SPEC = { specPath: "specs/payments", specCommit: "a".repeat(40), truncated: false,
    requirements: [{ id: "1.1", text: "The value is 2.", kind: "requirement", path: "specs/payments/spec.md" }] } as never;
  async function review(responses: FauxResponseStep[], options: { structuredAnswers?: boolean; reviewers?: Array<"CRITIC" | "SECURITY">; reviewSpec?: boolean; second?: FauxResponseStep[] } = {}) {
    const rootPath = await mkdtemp(join(tmpdir(), "structured-review-"));
    roots.push(rootPath);
    const { repositories, candidate } = await changedRepository(rootPath);
    const { adapter, faux } = await realAdapter(responses);
    const model = { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId };
    let specResult: Parameters<NonNullable<Parameters<typeof runWorkflowReviews>[0]["onSpecReview"]>>[0] | undefined;
    let secondResult: Parameters<NonNullable<Parameters<typeof runWorkflowReviews>[0]["onSecondReview"]>>[0] | undefined;
    const second = options.second === undefined ? undefined : (await realAdapter(options.second)).adapter;
    const reports = await runWorkflowReviews({
      ruleFileBaseCommits: [], operationId: randomUUID(), rootPath, model, candidate, repositories, piAdapter: adapter,
      reviewers: options.reviewers ?? ["CRITIC"], ...(options.structuredAnswers === undefined ? {} : { structuredAnswers: options.structuredAnswers }),
      ...(options.reviewSpec === true ? { reviewSpec: SPEC, onSpecReview: (result: typeof specResult) => { specResult = result; } } : {}),
      ...(second === undefined ? {} : { secondReviewer: { candidates: [{ model, piAdapter: second }] }, onSecondReview: (result: typeof secondResult) => { secondResult = result; } }),
    });
    return { reports, faux, specResult, secondResult };
  }
  const finding = { text: "The value changes without a test.", origin: "INTRODUCED", severity: "MEDIUM", file: "app.ts", line: 1 };

  it("takes a schema-valid review in one model call, with the contract's findings", async () => {
    const seen: Seen[] = [];
    const { reports, faux } = await review([step(seen, () => toolUse("submit_review", { findings: [finding] }))]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolNames).toContain("submit_review");
    expect(seen[0]!.messages.find((message) => message.role === "user")?.text).toContain("calling the submit_review tool");
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ role: "CRITIC", status: "FINDINGS", findings: [finding] });
  });

  it("has an answer Pi's schema check refuses retried by Pi, with no text retry prompt", async () => {
    const seen: Seen[] = [];
    const { reports } = await review([
      step(seen, () => toolUse("submit_review", { findings: [{ text: "Missing origin." }] })),
      step(seen, () => toolUse("submit_review", { findings: [] })),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("Validation failed for tool \"submit_review\"");
    expect(seen[1]!.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "PASS", findings: [] });
    expect(reports[0]!.failureReason).toBeUndefined();
  });

  it("falls back to the text answer, and to the text retry when that cannot be read", async () => {
    const seen: Seen[] = [];
    const { reports } = await review([
      step(seen, () => fauxAssistantMessage("I reviewed it. All good.")),
      step(seen, () => fauxAssistantMessage(JSON.stringify({ findings: [finding] }))),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("could not be read as the required JSON object");
    expect(reports[0]).toMatchObject({ status: "FINDINGS", findings: [finding] });
  });

  it("flips back with structuredAnswers off: no tool, and the text answer is parsed as before", async () => {
    const seen: Seen[] = [];
    const { reports } = await review([step(seen, () => fauxAssistantMessage(JSON.stringify({ findings: [finding] })))], { structuredAnswers: false });
    expect(seen[0]!.toolNames).not.toContain("submit_review");
    expect(seen[0]!.messages.find((message) => message.role === "user")?.text).not.toContain("submit_review");
    expect(reports[0]).toMatchObject({ status: "FINDINGS", findings: [finding] });
  });

  // Pi converts a tool's arguments before the tool sees them ("true" or 1 become true) and drops a null optional field. A reader that approves the converted answer would accept what it refuses as text,
  // so such an answer is refused with the model's own values checked (structured-answer.ts); a null optional field means "left out", which is what a strict provider sends for it.
  const SQL = { text: "SQL injection in the handler.", origin: "INTRODUCED", severity: "HIGH" };
  for (const which of ["first", "second"] as const) {
    describe(`a converted answer from the ${which} reviewer`, () => {
      const run = async (answers: FauxResponseStep[]) => which === "first"
        ? review(answers)
        : review([toolUse("submit_review", { findings: [] })], { second: answers });
      const reportOf = (result: Awaited<ReturnType<typeof review>>) => (which === "first" ? result.reports[0] : result.secondResult?.report);
      for (const [label, bad] of [["advisory \"true\"", { ...SQL, advisory: "true" }], ["advisory 1", { ...SQL, advisory: 1 }], ["a line given as text", { ...SQL, line: "12" }]] as const) {
        it(`refuses ${label} for Pi's retry instead of reading it as the converted value`, async () => {
          const seen: Seen[] = [];
          const result = await run([step(seen, () => toolUse("submit_review", { findings: [bad] })), step(seen, () => toolUse("submit_review", { findings: [SQL] }))]);
          expect(seen).toHaveLength(2);
          expect(seen[1]!.messages.at(-1)?.role).toBe("toolResult");
          expect(seen[1]!.messages.at(-1)?.text).toContain("wrong type");
          // The answer that stood is the second, clean one: a blocking finding, not an advisory one.
          expect(reportOf(result)).toMatchObject({ status: "FINDINGS", findings: [SQL] });
          expect(reportOf(result)?.findings[0]).not.toHaveProperty("advisory");
        });
      }
      it("takes a null optional field as left out (what a strict provider sends), so the finding stays a blocking one", async () => {
        const seen: Seen[] = [];
        const result = await run([step(seen, () => toolUse("submit_review", { findings: [{ ...SQL, severity: null, file: null, line: null, advisory: null }] }))]);
        expect(seen).toHaveLength(1);
        expect(reportOf(result)).toMatchObject({ status: "FINDINGS", findings: [{ text: SQL.text, origin: "INTRODUCED" }] });
      });
    });
  }

  it("has a tool answer on the retry prompt taken, after a first answer written as text that could not be read", async () => {
    const seen: Seen[] = [];
    const { reports } = await review([step(seen, () => fauxAssistantMessage("I reviewed it. All good.")), step(seen, () => toolUse("submit_review", { findings: [finding] }))]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.messages.at(-1)?.text).toContain("could not be read as the required JSON object");
    expect(reports[0]).toMatchObject({ status: "FINDINGS", findings: [finding] });
    expect(reports[0]!.failureReason).toBeUndefined();
  });

  it("has the second reviewer answer through the tool too, and its report stay apart from the first reviewer's", async () => {
    const seen: Seen[] = [];
    const { reports, secondResult } = await review([toolUse("submit_review", { findings: [] })], { second: [step(seen, () => toolUse("submit_review", { findings: [finding] }))] });
    expect(seen[0]!.toolNames).toContain("submit_review");
    // The second reviewer is a code review only: no spec walk tool.
    expect(seen[0]!.toolNames).not.toContain("submit_spec_verdicts");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "PASS" });
    expect(secondResult?.report).toMatchObject({ status: "FINDINGS", findings: [finding] });
  });

  describe("the spec walk", () => {
    it("takes the verdicts from the tool after the code review, in a second prompt", async () => {
      const seen: Seen[] = [];
      const { reports, specResult } = await review([
        step(seen, () => toolUse("submit_review", { findings: [] })),
        step(seen, () => toolUse("submit_spec_verdicts", { specVerdicts: [{ id: "1.1", verdict: "not_met", reason: "Nothing sets it to 2." }] })),
      ], { reviewSpec: true });
      expect(seen).toHaveLength(2);
      expect(seen[0]!.toolNames).toEqual(expect.arrayContaining(["submit_review", "submit_spec_verdicts"]));
      expect(seen[1]!.messages.at(-1)?.text).toContain("calling the submit_spec_verdicts tool");
      expect(specResult).toMatchObject({ verdicts: [{ id: "1.1", verdict: "not_met", reason: "Nothing sets it to 2." }], unanswered: [] });
      expect(reports[0]).toMatchObject({ status: "FINDINGS", findings: [{ text: "Spec 1.1 is not met: Nothing sets it to 2.", origin: "INTRODUCED" }] });
    });

    it("lets the walk's own text answer win over a verdict list the model gave during the review turn", async () => {
      const seen: Seen[] = [];
      const walkText = JSON.stringify({ specVerdicts: [{ id: "1.1", verdict: "not_met", reason: "Missing." }] });
      const { reports, specResult } = await review([
        // The review turn calls both tools at once: the early verdict says not_applicable, before the requirements were asked about.
        step(seen, () => fauxAssistantMessage([
          fauxToolCall("submit_review", { findings: [] }, { id: "early-review" }),
          fauxToolCall("submit_spec_verdicts", { specVerdicts: [{ id: "1.1", verdict: "not_applicable", reason: "Early guess." }] }, { id: "early-walk" }),
        ], { stopReason: "toolUse" })),
        step(seen, () => fauxAssistantMessage(walkText)),
      ], { reviewSpec: true });
      expect(specResult).toMatchObject({ verdicts: [{ id: "1.1", verdict: "not_met", reason: "Missing." }] });
      expect(reports[0]!.findings.map((entry) => entry.text)).toEqual(["Spec 1.1 is not met: Missing."]);
    });
  });

  it("offers each reviewer its own tool in a session of its own, and none to a coding session", async () => {
    const seen: Seen[] = [];
    const { reports } = await review([step(seen, () => toolUse("submit_review", { findings: [] })), step(seen, () => toolUse("submit_review", { findings: [finding] }))], { reviewers: ["CRITIC", "SECURITY"] });
    expect(reports.map((report) => [report.role, report.status])).toEqual([["CRITIC", "PASS"], ["SECURITY", "FINDINGS"]]);
    const { adapter } = await realAdapter([]);
    await expect(createWorkspacePiSession({ rootPath: await preparedRoot(), model: FAUX_MODEL, workflowMode: "IMPLEMENT", answerTools: [createAnswerChannel(reviewAnswerSpec("CRITIC")).tool] }, adapter))
      .rejects.toThrow("answer tools are not available to a session that can run commands or change files");
  });
});

describe("providers and models without strict tool support", () => {
  const specs = { review: reviewAnswerSpec("CRITIC", { risk: true }), understand: understandAnswerSpec(), planCheck: planCritiqueAnswerSpec() };
  const toolOf = (spec: typeof specs[keyof typeof specs]) => createAnswerChannel(spec).tool as unknown as Parameters<typeof resolveJsonSchemaStrictSampling>[0];

  it("asks for strict sampling only as a preference, so a provider without strict tools gets an ordinary tool", () => {
    for (const spec of Object.values(specs)) {
      const tool = toolOf(spec);
      expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
      // A provider or model that cannot take strict tools: no strict request, and no error.
      expect(resolveJsonSchemaStrictSampling(tool, false)).toBeUndefined();
    }
  });

  it("falls back cleanly for a schema strict mode cannot hold (a union of objects), and is strict where it can be", () => {
    expect(resolveJsonSchemaStrictSampling(toolOf(specs.understand), true)).toBeUndefined();
    expect(resolveJsonSchemaStrictSampling(toolOf(specs.review), true)).toBe(true);
    expect(resolveJsonSchemaStrictSampling(toolOf(specs.planCheck), true)).toBe(true);
  });

  it("still works end to end on a model that takes ordinary tools only (the faux provider has no strict mode)", async () => {
    const seen: Seen[] = [];
    const { adapter } = await realAdapter([step(seen, () => toolUse("submit_understanding", { assessment: READY }))]);
    const { artifacts } = await runTask(adapter, taskInvocation("UNDERSTAND", "Understand the request."));
    expect(artifacts.some((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)).toBe(true);
  });
});

describe("the schemas and the contracts", () => {
  it("caps the plan check's points and their length, so the saved answer cannot outgrow its limit and lose its opening fence", () => {
    const spec = planCritiqueAnswerSpec();
    const pi = (args: unknown): unknown => validateToolArguments({ name: spec.name, description: "", parameters: spec.parameters }, { type: "toolCall", id: "1", name: spec.name, arguments: args as never });
    const point = (text: string) => ({ severity: "note", text });
    expect(() => pi({ verdict: "ok", points: Array.from({ length: 20 }, () => point("x".repeat(500))) })).not.toThrow();
    expect(() => pi({ verdict: "ok", points: Array.from({ length: 21 }, () => point("x")) })).toThrow();
    expect(() => pi({ verdict: "ok", points: [point("x".repeat(501))] })).toThrow();
    // Worst case within the schema: every character a control character, which JSON writes in six bytes.
    const worst = spec.render({ verdict: "ok", points: Array.from({ length: 20 }, () => point("\u0001".repeat(500))) });
    expect(Buffer.byteLength(worst, "utf8")).toBeLessThan(PLAN_CRITIQUE_ANSWER_MAX_BYTES);
    // And the check refuses an answer that is over the limit anyway (a schema that changed).
    expect(spec.check(spec.render({ verdict: "ok", points: [point("x".repeat(PLAN_CRITIQUE_ANSWER_MAX_BYTES))] }))).toContain("too long");
  });

  it("refuse, in the tool's check, what the step's own reader refuses, in the reader's words", () => {
    expect(reviewAnswerSpec("CRITIC").check(JSON.stringify({ findings: "x" }))).toContain("does not match the required shape");
    expect(reviewAnswerSpec("CRITIC").check("x".repeat(25_000))).toContain("too large");
    expect(reviewAnswerSpec("CRITIC").check(JSON.stringify({ findings: [] }))).toBeUndefined();
    expect(planCritiqueAnswerSpec().check(fenced(PLAN_CRITIQUE_INFO_STRING, { verdict: "approve", points: [] }))).toContain("verdict");
    expect(planCritiqueAnswerSpec().check(fenced(PLAN_CRITIQUE_INFO_STRING, { verdict: "ok", points: [] }))).toBeUndefined();
    expect(understandAnswerSpec().check(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready" }))).toContain("path");
    expect(understandAnswerSpec().check(fenced(INTENT_BLOCK_INFO_STRING, READY))).toBeUndefined();
  });

  it("are made from the contract's own schemas, so a change to a contract changes the tool", () => {
    const fromContract = (schema: Parameters<typeof answerSchemaOf>[0]) => JSON.parse(JSON.stringify(answerSchemaOf(schema))) as { properties?: Record<string, unknown> };
    const review = JSON.parse(JSON.stringify(reviewAnswerSpec("CRITIC").parameters)) as { properties: { findings: { items: unknown } } };
    expect(review.properties.findings.items).toEqual(fromContract(WorkflowReviewFindingSchema));
    const understand = JSON.parse(JSON.stringify(understandAnswerSpec().parameters)) as { properties: { assessment: unknown } };
    expect(understand.properties.assessment).toEqual(fromContract(IntentAssessmentSchema));
  });

  it("render the exact text each step's reader reads, so what is saved and what the broker reads are unchanged", () => {
    expect(readIntentBlock(understandAnswerSpec().render({ assessment: READY }))).toEqual({ ok: true, assessment: READY });
    expect(understandAnswerSpec().check(understandAnswerSpec().render({ assessment: READY }))).toBeUndefined();
    const critique = { verdict: "ok", points: [] };
    expect(readPlanCritique(planCritiqueAnswerSpec().render(critique))).toEqual({ ok: true, verdict: "ok", points: [] });
    expect(JSON.parse(reviewAnswerSpec("SECURITY").render({ findings: [] }))).toEqual({ findings: [] });
  });
});
