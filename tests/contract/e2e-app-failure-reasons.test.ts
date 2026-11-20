import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_APPLICATION_SEND_BACK_CODES, cutEvidenceReason, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, sendBackProblems, workflowApplicationEvidenceCodes, workflowSendBackOffered, type WorkflowSnapshot } from "@agentx/contracts";
import type { DockerApplicationUnavailableReason } from "@agentx/verifier";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

// M1.4 RUN-2: every reason the app host (and the worker, and the broker's own runtime gate) can end a group with has its own fixed owner sentence, shown on the rows and in the
// Slack message; the four codes the candidate causes can be sent back to the coding agent with only the fixed code and its sentence.

/** Every host code. The `Record` makes this list a compile error to leave out a code of the host's own type. */
const HOST_CODES = Object.keys({
  "build-failed": 0, "app-unhealthy": 0, "app-exited": 0, "deadline-exceeded": 0, "executor-failed": 0, "executor-result-mismatch": 0, "mock-unavailable": 0, "seed-failed": 0,
  "login-failed": 0, "model-channel-unavailable": 0, cancelled: 0,
} satisfies Record<DockerApplicationUnavailableReason, 0>) as DockerApplicationUnavailableReason[];
const OTHER_CODES = ["evidence too large", "runtime-expired", "model-environment-unsafe", "runtime-environment-drifted"] as const;
const CANDIDATE_CODES = ["build-failed", "app-exited", "app-unhealthy", "seed-failed"] as const;

const sentenceOf = (code: string): string => E2E_OWNER_SENTENCES.groupCode[code]!;

afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------------------------
// The block reason the broker writes, and what a workflow makes of it
// ---------------------------------------------------------------------------------------------
const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-07T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
const roundId = "33333333-3333-4333-8333-333333333333";
const checkPolicy = { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
const blockedOn = (blockReason: string, extra: Record<string, unknown> = {}): WorkflowSnapshot => {
  const base = createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now });
  return WorkflowSnapshotSchema.parse({ ...base, revision: 7, stage: "VERIFY", state: "BLOCKED", artifacts: [plan], checkPolicy, candidate, blockReason,
    e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64), required: true, currentRoundId: roundId,
      currentGroupRunIds: [roundId], resultRefs: [] }, ...extra });
};
const incomplete = (...segments: string[]) => `admitted E2E evidence is incomplete or unknown (${segments.join("; ")})`;

describe("RUN-2: reading the codes out of the block reason", () => {
  it("reads one code per group, and refuses (undefined) anything that is not exactly 'group: code' for every group", () => {
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed"))).toEqual(["build-failed"]);
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed", "group-2: evidence too large"))).toEqual(["build-failed", "evidence too large"]);
    // A reason the broker cut on whole entries ends with "; …": the entries before it are read, the marker is not a code (and only a last entry may be one).
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-failed", "group-2: executor-failed", "…"))).toEqual(["build-failed", "executor-failed"]);
    for (const reason of [incomplete("…"), incomplete("…", "group-1: build-failed"), incomplete("group-1: build-failed", "…", "group-2: build-failed"), incomplete("group-1: build-failed", "x…")]) {
      expect(workflowApplicationEvidenceCodes(reason), reason).toBeUndefined();
    }
    // A code-shaped word is read as written; whether it is the candidate's is decided by the closed list, not by the shape.
    expect(workflowApplicationEvidenceCodes(incomplete("group-1: build-fail"))).toEqual(["build-fail"]);
    for (const reason of [undefined, "", "one or more admitted E2E groups failed", "admitted E2E evidence is incomplete or unknown", "admitted E2E evidence is incomplete or unknown (accepted-group-evidence-integrity)",
      incomplete("group-1: build-failed", "group-2: the group's lifecycle does not confirm a clean run"), incomplete("group-1: boom: build-failed"), incomplete("group 1: build-failed"),
      "admitted E2E evidence is incomplete or unknown (group-1: build-failed", incomplete("g: Build-Failed")]) {
      expect(workflowApplicationEvidenceCodes(reason), String(reason)).toBeUndefined();
    }
  });

  it("lists exactly build-failed, app-exited, app-unhealthy and seed-failed as the candidate's", () => {
    expect([...E2E_APPLICATION_SEND_BACK_CODES].sort()).toEqual([...CANDIDATE_CODES].sort());
  });
});

describe("RUN-2 item 2: Send back for the codes the candidate causes", () => {

  it("is not offered for an infrastructure code, a code nobody knows, a mix with one, a reason it cannot read, or a task that needs no round", () => {
    for (const code of [...HOST_CODES.filter((item) => !(CANDIDATE_CODES as readonly string[]).includes(item)), ...OTHER_CODES, "something-new"]) {
      const workflow = blockedOn(incomplete(`group-1: ${code}`));
      expect(workflowSendBackOffered(workflow), code).toBe(false);
      expect(sendBackProblems(workflow, sentenceOf), code).toEqual([]);
    }
    for (const reason of [incomplete("group-1: build-failed", "group-2: the group's lifecycle does not confirm a clean run"),
      "admitted E2E evidence is incomplete or unknown", "one or more admitted E2E groups failed: build-failed"]) {
      expect(workflowSendBackOffered(blockedOn(reason)), reason).toBe(false);
    }
    const notRequired = blockedOn(incomplete("group-1: build-failed"), { e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64),
      required: false, currentRoundId: roundId, currentGroupRunIds: [roundId], resultRefs: [] } });
    expect(workflowSendBackOffered(notRequired)).toBe(false);
  });

  it("is not offered once the task is no longer blocked at VERIFY (a stale card), and without a describer the problem carries the code alone", () => {
    const moved = WorkflowSnapshotSchema.parse({ ...blockedOn(incomplete("group-1: build-failed")), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined });
    expect(workflowSendBackOffered(moved)).toBe(false);
    expect(sendBackProblems(blockedOn(incomplete("group-1: build-failed")))).toEqual([{ source: "check", text: "the browser and API checks could not run on this change (build-failed)" }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The Slack message
// ---------------------------------------------------------------------------------------------
type Button = { action_id: string; text: { text: string }; value: string };
const buttonsOf = (blocks: Array<Record<string, unknown>>): string[] => blocks.filter((block) => block.type === "actions").flatMap((block) => (block.elements as Button[]).map((button) => button.action_id));
const messageOf = (blockReason: string) => workflowMessage({ taskId, workflow: blockedOn(blockReason) })!;
const GENERIC = "The required E2E evidence is incomplete or unavailable. Some required runtime checks may not have run. Nothing was sent to GitHub.";

describe("RUN-2: the Slack message says why, and offers Send back only where the candidate is the cause", () => {

  it("keeps the one fixed text, and no Send back, for a reason that carries no code it can read", () => {
    for (const reason of ["admitted E2E evidence is incomplete or unknown", incomplete("accepted-group-evidence-integrity"), incomplete("group-1: the group's lifecycle does not confirm a clean run"),
      incomplete("group-1: something-new")]) {
      const message = messageOf(reason);
      expect(message.text, reason).toBe(GENERIC);
      expect(buttonsOf(message.blocks), reason).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    }
  });
});

describe("review round 1: minors", () => {
  it("M-2: says how many more reasons there are instead of dropping a fourth distinct sentence silently", () => {
    const four = messageOf(incomplete("g1: build-failed", "g2: app-exited", "g3: app-unhealthy", "g4: seed-failed"));
    for (const code of ["build-failed", "app-exited", "app-unhealthy"]) expect(four.text).toContain(sentenceOf(code));
    expect(four.text).not.toContain(sentenceOf("seed-failed"));
    expect(four.text).toContain("And 1 more.");
    expect(() => new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...four })).not.toThrow();
    expect(messageOf(incomplete("g1: build-failed", "g2: app-exited", "g3: app-unhealthy")).text).not.toContain("more.");
  });

  it("M-1: a reason cut for the block is cut on whole entries and ends with a marker that is not read as a code", () => {
    const entries = Array.from({ length: 12 }, (_, index) => `group-${"x".repeat(14)}${index}: build-failed`);
    const full = incomplete(...entries);
    expect(full.length).toBeGreaterThan(240);
    const inner = entries.join("; ");
    const cut = cutEvidenceReason(inner, 240);
    expect(cut.length).toBeLessThanOrEqual(240);
    expect(cut.endsWith("; …")).toBe(true);
    expect(cut.slice(0, -3).split("; ").every((entry) => entries.includes(entry))).toBe(true);
    // The marker is not a code: the entries before it are read, and every one is the candidate's, so Send back is offered (round 2).
    expect(workflowApplicationEvidenceCodes(`admitted E2E evidence is incomplete or unknown (${cut})`)).toEqual(cut.slice(0, -3).split("; ").map(() => "build-failed"));
    // Short reasons, and a reason whose first entry alone is over the limit, are cut as they always were.
    expect(cutEvidenceReason("g: build-failed", 240)).toBe("g: build-failed");
    expect(cutEvidenceReason("y".repeat(300), 240)).toBe("y".repeat(240));
  });
});

describe("review round 2: Send back in a mixed round, and from a long reason", () => {

  it("is still not offered when no group ended with a candidate-caused code", () => {
    for (const reason of [incomplete("group-1: executor-failed", "group-2: deadline-exceeded"), incomplete("group-1: build-fail"), incomplete("group-1: login-failed")]) {
      expect(workflowSendBackOffered(blockedOn(reason)), reason).toBe(false);
      expect(sendBackProblems(blockedOn(reason), sentenceOf), reason).toEqual([]);
    }
  });

});
