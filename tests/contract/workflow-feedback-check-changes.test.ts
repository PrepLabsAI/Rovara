// 0.2.12 live test: an owner-approved PR feedback fix changed the sentence a task's own approved check looked for, so the
// fix failed that check. Once the owner approves a fix, its check changes replace the matching checks of the plan.
import { describe, expect, it } from "vitest";
import {
  WorkflowSnapshotSchema, WorkflowTransitionError, applyWorkflowFeedbackCheckChanges, createWorkflowSnapshot, workflowFeedbackCheckChanges,
  workflowSelectedChecks, type WorkflowCheckPolicyInput,
} from "../../packages/contracts/src/index.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-11T12:00:00.000Z";
const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
const UNIT = { id: "required-1", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } };
const SENTENCE = { id: "proposed-1", label: "Code of Conduct sentence present in README.md", command: grep("respect and kindness.") };
const LINKS = { id: "proposed-2", label: "Links still work", command: grep("CODE_OF_CONDUCT.md") };
const policy = (extra: Partial<WorkflowCheckPolicyInput> = {}): WorkflowCheckPolicyInput => ({ required: [UNIT], optional: [], selectedOptionalIds: [], proposed: [SENTENCE, LINKS], ...extra });
const replacement = { label: "Shorter sentence present in README.md", cwd: "repo/demo", executable: "grep", args: ["-q", "Be respectful and kind.", "README.md"] };
const finding = (fixProposal: Record<string, unknown>) => ({ fixProposal: { summary: "Shorten it.", fileChanges: [], tests: [], ...fixProposal } });
const workflow = (checkPolicy: WorkflowCheckPolicyInput, feedbackDecisions = 0) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId, now, checkPolicy }),
  ...(feedbackDecisions === 0 ? {} : { feedbackDecisions: Array.from({ length: feedbackDecisions }, (_, index) => ({
    schemaVersion: 1, requestId: `2222222${String(index)}-2222-4222-8222-222222222222`, workflowRevision: 1, decision: "DISMISS", actorId: ownerId, actorRole: "TASK_OWNER",
    reviewDigest: "b".repeat(64), proposalDigest: "c".repeat(64), bundleDigests: ["d".repeat(64)], selectedFindingIds: [], selectedCommentIds: [], candidates: [],
    ownerNote: "No.", at: now })) }),
});

describe("check changes of an approved PR feedback fix", () => {
  it("resolves obsolete checks by ID or label among the proposed checks the task runs, and normalizes corrected checks", () => {
    const parsed = WorkflowSnapshotSchema.parse(workflow(policy())).checkPolicy;
    expect(workflowFeedbackCheckChanges(parsed, [finding({ obsoleteChecks: ["proposed-1"], replacementChecks: [replacement] })])).toEqual({
      obsolete: [SENTENCE], added: [{ label: replacement.label, command: { cwd: replacement.cwd, executable: replacement.executable, args: replacement.args, timeoutSeconds: 600 } }],
    });
    expect(workflowFeedbackCheckChanges(parsed, [finding({ obsoleteChecks: ["code of conduct sentence present in readme.md"] })]).obsolete).toEqual([SENTENCE]);
  });

  it("never drops a required project check, a check the task does not run, or an unticked proposed check", () => {
    const unticked = WorkflowSnapshotSchema.parse(workflow(policy({ selectedProposedIds: ["proposed-2"] }))).checkPolicy;
    expect(workflowFeedbackCheckChanges(unticked, [finding({ obsoleteChecks: ["required-1", "Unit tests", "proposed-9", "proposed-1"] })]).obsolete).toEqual([]);
  });

  it("adds a corrected check once, and not when it is the same command as a check that stays", () => {
    const parsed = WorkflowSnapshotSchema.parse(workflow(policy())).checkPolicy;
    const sameAsLinks = { label: "Links", cwd: "repo/demo", executable: "grep", args: LINKS.command.args, timeoutSeconds: 30 };
    const changes = workflowFeedbackCheckChanges(parsed, [finding({ replacementChecks: [replacement, sameAsLinks] }), finding({ replacementChecks: [replacement] })]);
    expect(changes.added.map((check) => check.label)).toEqual([replacement.label]);
  });

  it("stores the updated set: the obsolete check removed, the corrected one added, the required one kept", () => {
    const current = workflow(policy(), 1);
    const next = applyWorkflowFeedbackCheckChanges(current, workflowFeedbackCheckChanges(current.checkPolicy, [finding({ obsoleteChecks: ["proposed-1"], replacementChecks: [replacement] })]));
    expect(next.revision).toBe(current.revision);
    expect(workflowSelectedChecks(next.checkPolicy).map((check) => [check.id, check.label])).toEqual([
      ["required-1", "Unit tests"], ["proposed-2", "Links still work"], ["feedback-1-1", replacement.label],
    ]);
    // A later round sees the updated set, and its own check changes get their own IDs.
    const later = workflow(next.checkPolicy!, 2);
    const again = applyWorkflowFeedbackCheckChanges(later, workflowFeedbackCheckChanges(later.checkPolicy, [finding({ obsoleteChecks: [replacement.label],
      replacementChecks: [{ ...replacement, label: "Even shorter sentence present", args: ["-q", "Be kind.", "README.md"] }] })]));
    expect(workflowSelectedChecks(again.checkPolicy).map((check) => check.id)).toEqual(["required-1", "proposed-2", "feedback-2-1"]);
  });

  it("keeps the owner's unticked checks unticked and ticks the corrected ones", () => {
    const current = workflow(policy({ selectedProposedIds: ["proposed-1"] }));
    const next = applyWorkflowFeedbackCheckChanges(current, workflowFeedbackCheckChanges(current.checkPolicy, [finding({ obsoleteChecks: ["proposed-1"], replacementChecks: [replacement] })]));
    expect(next.checkPolicy?.selectedProposedIds).toEqual(["feedback-0-1"]);
    expect(workflowSelectedChecks(next.checkPolicy).map((check) => check.id)).toEqual(["required-1", "feedback-0-1"]);
  });

  it("refuses a change that would give the task more proposed checks than it can run", () => {
    const current = workflow(policy());
    const many = Array.from({ length: 7 }, (_, index) => ({ ...replacement, args: ["-q", `Line ${String(index)}`, "README.md"] }));
    expect(() => applyWorkflowFeedbackCheckChanges(current, workflowFeedbackCheckChanges(current.checkPolicy, [finding({ replacementChecks: many })])))
      .toThrow(WorkflowTransitionError);
  });
});
