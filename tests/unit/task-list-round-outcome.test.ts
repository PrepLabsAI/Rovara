// The task list's detail (`GET /v1/dev/tasks?detail=1`) carries Understand's current round and the workflow's outcome, so the web Work list can answer Understand's questions inline.
// This file pins the contract: the row schema and `understandRoundOf` (what counts as the current round, and which questions are answered).
import { describe, expect, it } from "vitest";
import { DeveloperTaskDetailedListResponseSchema, DeveloperTaskListDetailSchema, DeveloperTaskListRoundSchema, IntentQuestionSchema, WorkflowSnapshotSchema, understandRoundOf, type WorkflowIntent } from "@agentx/contracts";

const ACTOR = "a".repeat(64);
type Asked = { id: string; text: string; options?: Array<{ id: string; label: string }>; recommended?: string };
const Q1: Asked = { id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a" };
const Q2: Asked = { id: "q2", text: "Should it need a token?" };
const intent = (over: Partial<WorkflowIntent> & { assessment?: WorkflowIntent["assessment"] }): WorkflowIntent => ({ rounds: 1, pathFrom: "understand", answers: [], ...over });
const questions = (...asked: Asked[]): WorkflowIntent["assessment"] => ({ kind: "questions", restatement: "Add a health endpoint.", questions: asked });
const answered = (round: number, ...ids: string[]) => ({ round, by: { actorId: ACTOR, name: "Maya" }, source: "app" as const, answers: ids.map((questionId) => ({ questionId, text: "yes" })), at: "2026-11-15T00:00:00.000Z" });

describe("understandRoundOf: the current Understand round of a workflow, as a list row says it", () => {
  it("is the waiting round's questions as asked (ids, texts, options, the recommended one) with answered false", () => {
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: intent({ assessment: questions(Q1, Q2) }) })).toEqual({
      round: 1,
      questions: [{ id: "q1", text: "Which path?", options: [{ id: "a", label: "/health" }, { id: "b", label: "/healthz" }], recommended: "a", answered: false }, { id: "q2", text: "Should it need a token?", answered: false }],
    });
  });

  it("marks a question answered only by the CURRENT round's answers, never an earlier round's", () => {
    const both = intent({ rounds: 2, assessment: questions(Q1, Q2), answers: [answered(1, "q1", "q2")] });
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: both })?.questions.map((question) => question.answered)).toEqual([false, false]);
    const some = intent({ rounds: 2, assessment: questions(Q1, Q2), answers: [answered(1, "q1", "q2"), answered(2, "q2")] });
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: some })).toMatchObject({ round: 2, questions: [{ id: "q1", answered: false }, { id: "q2", answered: true }] });
    const all = intent({ assessment: questions(Q1, Q2), answers: [answered(1, "q1", "q2")] });
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: all })?.questions.every((question) => question.answered)).toBe(true);
  });

  it("is no round for any other stage, a ready or answer assessment, no assessment, no intent or no workflow", () => {
    const asked = intent({ assessment: questions(Q1) });
    for (const stage of ["PLAN", "PLAN_REVIEW", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW", "CLOSED", "MERGED"]) expect(understandRoundOf({ stage, intent: asked }), stage).toBeUndefined();
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: intent({ assessment: { kind: "ready", path: "QUICK", restatement: "r", assumptions: [] } }) })).toBeUndefined();
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: intent({ assessment: { kind: "answer", restatement: "r", answer: "a", sources: [] } }) })).toBeUndefined();
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: intent({}) })).toBeUndefined();
    expect(understandRoundOf({ stage: "UNDERSTAND", intent: intent({ rounds: 0, assessment: questions(Q1) }) })).toBeUndefined();
    expect(understandRoundOf({ stage: "UNDERSTAND" })).toBeUndefined();
    expect(understandRoundOf(undefined)).toBeUndefined();
  });

  it("builds only rounds the row's schema holds, from questions the workflow's own schema holds", () => {
    const round = understandRoundOf({ stage: "UNDERSTAND", intent: intent({ rounds: 2, assessment: questions(Q1, Q2) }) });
    expect(DeveloperTaskListRoundSchema.safeParse(round).success).toBe(true);
    for (const question of [Q1, Q2]) expect(IntentQuestionSchema.safeParse(question).success).toBe(true);
    // The row's schema is as tight as the question's: a longer text, a fifth option, a made-up id, a fourth question, round 0 or 3 and a missing `answered` are all refused.
    const good = { round: 1, questions: [{ id: "q1", text: "t", answered: false }] };
    expect(DeveloperTaskListRoundSchema.safeParse(good).success).toBe(true);
    const bad: unknown[] = [
      { ...good, round: 0 }, { ...good, round: 3 }, { ...good, questions: [] },
      { ...good, questions: [{ id: "q4", text: "t", answered: false }] }, { ...good, questions: [{ id: "q1", text: "x".repeat(301), answered: false }] },
      { ...good, questions: [{ id: "q1", text: "t" }] }, { ...good, questions: Array.from({ length: 4 }, (_, index) => ({ id: `q${String((index % 3) + 1)}`, text: "t", answered: false })) },
      { ...good, questions: [{ id: "q1", text: "t", answered: false, options: [{ id: "a", label: "x" }] }] },
      { ...good, questions: [{ id: "q1", text: "t", answered: false, options: ["a", "b", "c", "d", "a"].map((id) => ({ id, label: "x" })) }] },
      { ...good, questions: [{ id: "q1", text: "t", answered: false, extra: 1 }] }, { ...good, extra: 1 }, { ...good, questions: [{ id: "q1", text: "t", answered: false, recommended: "z" }] },
    ];
    for (const value of bad) expect(DeveloperTaskListRoundSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe("the list detail's round and outcome fields", () => {
  const row = { taskId: "11111111-1111-4111-8111-111111111111", title: "t", project: "p", status: "RUNNING", shared: false, createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" };
  const round = { round: 1, questions: [{ id: "q1", text: "Which path?", answered: false }] };

  it("both are optional and strict, and `outcome` is exactly the workflow's own outcomes", () => {
    expect(DeveloperTaskListDetailSchema.parse({})).toEqual({});
    expect(DeveloperTaskListDetailSchema.parse({ round, outcome: "ANSWERED" })).toEqual({ round, outcome: "ANSWERED" });
    const outcomes = WorkflowSnapshotSchema.shape.outcome.unwrap().options;
    expect([...outcomes].sort()).toEqual(["ANSWERED", "CHANGES_REQUESTED", "CLOSED", "MERGED", "PASSED", "REJECTED", "SKIPPED"]);
    for (const outcome of outcomes) expect(DeveloperTaskListDetailSchema.safeParse({ outcome }).success, outcome).toBe(true);
    for (const outcome of ["creator_removed", "merged", "", 1, null]) expect(DeveloperTaskListDetailSchema.safeParse({ outcome }).success, String(outcome)).toBe(false);
    expect(DeveloperTaskListDetailSchema.safeParse({ round: { ...round, extra: 1 } }).success).toBe(false);
    expect(DeveloperTaskListDetailSchema.safeParse({ round: null }).success).toBe(false);
  });

  it("a detailed list row keeps them, and the list response refuses a malformed one", () => {
    const parsed = DeveloperTaskDetailedListResponseSchema.parse({ tasks: [{ ...row, round, outcome: "CLOSED" }] });
    expect(parsed.tasks[0]).toMatchObject({ round, outcome: "CLOSED" });
    expect(DeveloperTaskDetailedListResponseSchema.safeParse({ tasks: [{ ...row, round: { round: 0, questions: [] } }] }).success).toBe(false);
    expect(DeveloperTaskDetailedListResponseSchema.safeParse({ tasks: [{ ...row, outcome: "creator_removed" }] }).success).toBe(false);
  });
});
