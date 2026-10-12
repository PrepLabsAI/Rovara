// A plan decision that carries the owner's answers and the comments they included: what is recorded, and what a replay is.
import { describe, expect, it } from "vitest";
import {
  WorkflowDecisionSchema, WorkflowTransitionError, createWorkflowSnapshot, decideWorkflow, submitWorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { reorderMaps } from "../support/fake-dynamodb.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const actor = { actorId: ownerId, role: "TASK_OWNER" as const };
const plan = {
  id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner",
  objectKey: `tasks/${taskId}/plan-v1.json`, createdAt: "2026-10-11T10:00:00.000Z", format: "structured" as const,
};
const decisions = [
  { id: "d1", optionIds: ["above", "below"], recommended: "below" },
  { id: "d2", optionIds: ["yes", "no"], recommended: "yes" },
];
const commentIds = ["6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11", "0d6a4c2b-91f3-4e57-8a2c-7b5e1f9d3a40"];

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-11T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: plan, now: "2026-10-11T10:00:00.000Z" });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: waiting().revision, decision: "APPROVE", artifactDigest: plan.sha256,
  reason: "Approved on the task page.",
  answers: [{ decisionId: "d1", optionId: "above", opened: true }, { decisionId: "d2", optionId: "yes", opened: false }],
  includedCommentIds: commentIds,
  ...overrides,
});
const options = { now: "2026-10-11T10:05:00.000Z", allowedSkipStages: [], decisions, via: "PAGE" as const };
const markdownOptions = { now: options.now, allowedSkipStages: [], via: "PAGE" as const };

describe("decideWorkflow with the owner's answers", () => {
  it("an answer for every decision is required and must name an option", () => {
    const refuse = (patch: Record<string, unknown>, opts: Record<string, unknown> = options) => expect(() => decideWorkflow(waiting(), request(patch), actor, opts as typeof options)).toThrow(WorkflowTransitionError);
    refuse({ answers: [{ decisionId: "d1", optionId: "above", opened: true }] });
    refuse({ answers: [{ decisionId: "d1", optionId: "sideways", opened: true }, { decisionId: "d2", optionId: "yes", opened: false }] });
    refuse({ answers: [{ decisionId: "d1", optionId: "above", opened: true }, { decisionId: "d2", optionId: "yes", opened: false }, { decisionId: "d3", optionId: "yes", opened: false }] });
    refuse({ answers: [{ decisionId: "d1", optionId: "above", opened: true }, { decisionId: "d1", optionId: "below", opened: true }] });
    refuse({}, markdownOptions);
    refuse({ includedCommentIds: [commentIds[0], commentIds[0]] });
    refuse({ includedCommentIds: Array.from({ length: 26 }, (_, index) => `6c1f5d7e-4ab0-4d43-9c55-${String(index).padStart(12, "0")}`) });
    // A plan with no decisions takes an empty answer list, and a Markdown document (no decisions known) an empty one too.
    expect(decideWorkflow(waiting(), request({ answers: [] }), actor, { ...options, decisions: [] }).stage).toBe("IMPLEMENT");
    expect(decideWorkflow(waiting(), request({ answers: [] }), actor, markdownOptions).stage).toBe("IMPLEMENT");
  });

  it("a stale decision with answers is refused as stale, before its answers are checked", () => {
    const stale = () => decideWorkflow(waiting(), request({ expectedRevision: waiting().revision + 5 }), actor, markdownOptions);
    expect(stale).toThrow("workflow revision is stale");
    const wrong = () => decideWorkflow(waiting(), request({ expectedRevision: waiting().revision + 5, answers: [{ decisionId: "d1", optionId: "sideways", opened: true }] }), actor, options);
    expect(wrong).toThrow("workflow revision is stale");
  });

  it("only answers that differ from AgentX's are recorded", () => {
    const decided = decideWorkflow(waiting(), request({
      answers: [{ decisionId: "d2", optionId: "no", opened: true }, { decisionId: "d1", optionId: "above", opened: true }],
    }), actor, options);
    const decision = decided.decisions.at(-1)!;
    expect(decision.answerOverrides).toEqual([{ decisionId: "d1", optionId: "above" }, { decisionId: "d2", optionId: "no" }]);
    expect(decision.commentsIncluded).toBe(2);
    expect(decision.via).toBe("PAGE");
    const recommended = decideWorkflow(waiting(), request({
      answers: [{ decisionId: "d1", optionId: "below", opened: true }, { decisionId: "d2", optionId: "yes", opened: false }], includedCommentIds: [],
    }), actor, options).decisions.at(-1)!;
    expect(recommended.answerOverrides).toBeUndefined();
    expect(recommended.commentsIncluded).toBeUndefined();
  });

  it("a replay with answers in another order is the same decision", () => {
    const decided = decideWorkflow(waiting(), request(), actor, options);
    const stored = reorderMaps(decided) as WorkflowSnapshot;
    const replay = request({
      answers: [{ opened: false, optionId: "yes", decisionId: "d2" }, { opened: true, optionId: "above", decisionId: "d1" }],
      includedCommentIds: [...commentIds].reverse(),
    });
    expect(decideWorkflow(stored, replay, actor, options)).toEqual(stored);
  });

  it("a replay with a different answer is refused", () => {
    const decided = decideWorkflow(waiting(), request(), actor, options);
    expect(() => decideWorkflow(decided, request({ answers: [{ decisionId: "d1", optionId: "below", opened: true }, { decisionId: "d2", optionId: "yes", opened: false }] }), actor, options))
      .toThrow(/already used/);
    expect(() => decideWorkflow(decided, request({ includedCommentIds: [commentIds[0]] }), actor, options)).toThrow(/already used/);
  });

  it("a decision without answers reads exactly as before", () => {
    const plain: Record<string, unknown> = request();
    delete plain.answers;
    delete plain.includedCommentIds;
    const decided = decideWorkflow(waiting(), plain, actor, { now: options.now, allowedSkipStages: [] });
    const decision = decided.decisions.at(-1)!;
    expect(Object.keys(decision).sort()).toEqual(["actorId", "actorRole", "artifactDigest", "at", "decision", "reason", "requestId", "workflowRevision"]);
    expect(decideWorkflow(decided, plain, actor, { now: options.now, allowedSkipStages: [] })).toEqual(decided);
    // A decision recorded before this change still reads.
    expect(WorkflowDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("binds a graph approval to its exact graph digest, plan artifact, revision, actor and run", () => {
    const graphDigest = "c".repeat(64);
    const refuse = (patch: Record<string, unknown>, optionDigest?: string) => expect(() => decideWorkflow(
      waiting(), request(patch), actor,
      { ...markdownOptions, ...(optionDigest === undefined ? {} : { workBreakdownDigest: optionDigest }) },
    )).toThrow(WorkflowTransitionError);
    refuse({}, graphDigest);
    refuse({ workBreakdownDigest: "d".repeat(64) }, graphDigest);
    refuse({ workBreakdownDigest: graphDigest }, undefined);
    refuse({ decision: "REQUEST_CHANGES", workBreakdownDigest: graphDigest }, graphDigest);

    const approval = decideWorkflow(waiting(), request({ workBreakdownDigest: graphDigest }), actor, { ...options, workBreakdownDigest: graphDigest });
    const binding = approval.workflowDependenciesApproval;
    expect(binding).toMatchObject({
      artifactDigest: plan.sha256, graphDigest, workflowRevision: waiting().revision, actorId: actor.actorId,
    });
    expect(binding?.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(approval.decisions.at(-1)?.workBreakdownDigest).toBe(graphDigest);
    expect(decideWorkflow(approval, request({ workBreakdownDigest: graphDigest }), actor, { ...options, workBreakdownDigest: graphDigest })).toEqual(approval);
    expect(() => decideWorkflow(approval, request({ workBreakdownDigest: "d".repeat(64) }), actor, { ...options, workBreakdownDigest: "d".repeat(64) })).toThrow(/already used/);
  });
});
