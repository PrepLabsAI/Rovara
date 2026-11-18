// A decision on a task's document puts its entry in the task log in the SAME transaction as the decision: what was decided on (the plan's code), who decided, and where from. The surface is the method the proof came
// through, never a field of the request; a task of no company writes no entry.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, TaskLogEntrySchema, createWorkflowSnapshot, submitWorkflowArtifact, type JsonValue, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { createWorkflowDocumentSubject, workflowTaskKey } from "../../../packages/broker/src/core/decisions/workflow-subject.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const PLAN = "b".repeat(64);

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: PLAN, producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "markdown" },
  });
}

async function decide(outcome: "approve" | "request_changes" | "reject", method?: string, org: OrgId | null = IMPLICIT_COMPANY_ID) {
  const workflow = waiting();
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workflowTaskKey(TASK), ...(org === null ? {} : { orgId: org }), project: "web", workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low" });
  const loaded = (await subject.load(IMPLICIT_COMPANY_ID, TASK))!;
  const attempt = {
    companyId: IMPLICIT_COMPANY_ID, kind: subject.kind, subjectId: TASK, requestId: "11111111-1111-4111-8111-111111111111", outcome, seen: { revision: workflow.revision, artifactDigest: PLAN }, reason: "Please change it.",
    credentials: method === undefined ? [] : [{ method, token: "t" }],
  };
  return subject.apply(loaded, attempt, [{ ...localOwnerPrincipal({ companyId: IMPLICIT_COMPANY_ID }), displayName: "Ana Ruiz" }], "2026-11-09T10:05:00.000Z");
}

const logRows = (applied: Awaited<ReturnType<typeof decide>>) => (applied.extra ?? []).flatMap((item) => (item.kind === "put" && String(item.item.sk).startsWith("TASKLOG#") ? [item.item] : []));

describe("a decision is in the task log, in its own transaction", () => {
  it("records an approval: the plan, its code, who, where, in one row beside the decision", async () => {
    const applied = await decide("approve");
    const rows = logRows(applied);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pk: `DEVTASK#${TASK}`, entityType: "TASK_LOG", orgId: IMPLICIT_COMPANY_ID, taskId: TASK });
    const entry = TaskLogEntrySchema.parse(rows[0]!["entry"]);
    expect(entry).toMatchObject({ kind: "approval", what: "plan", outcome: "approved", code: "bbbbbbbb", by: "Ana Ruiz", surface: "web", at: "2026-11-09T10:05:00.000Z" });
    // It is a step of the decision's transaction: it never names the task's own key.
    expect((applied.extra ?? []).some((item) => item.kind === "put" && item.item.sk === "META")).toBe(false);
  });

  it("takes the surface from the method the proof came through: a chat press is Slack, a code host's comment is GitHub", async () => {
    expect(TaskLogEntrySchema.parse(logRows(await decide("approve", "chat-slack"))[0]!["entry"])).toMatchObject({ surface: "slack" });
    expect(TaskLogEntrySchema.parse(logRows(await decide("request_changes", "code-host-comment"))[0]!["entry"])).toMatchObject({ surface: "github", outcome: "changes_requested" });
    expect(TaskLogEntrySchema.parse(logRows(await decide("reject", "local-session"))[0]!["entry"])).toMatchObject({ surface: "web", outcome: "rejected" });
  });

  it("is the same entry for the same request id, so a repeat of the decision does not add one", async () => {
    const first = TaskLogEntrySchema.parse(logRows(await decide("approve"))[0]!["entry"]);
    const second = TaskLogEntrySchema.parse(logRows(await decide("approve"))[0]!["entry"]);
    expect(second.key).toBe(first.key);
  });

  it("writes none for a task that names no company", async () => {
    expect(logRows(await decide("approve", undefined, null))).toEqual([]);
  });
});
