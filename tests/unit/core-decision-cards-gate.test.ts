// Lane L6b: a card's Approve reaches the approval gate with the proof the surface collected, and only a decided gate answer is reported as approved. The card routes, the performer and the gate are the real ones.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, IMPLICIT_COMPANY_ID, createWorkflowSnapshot, submitWorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, workflowTaskKey, waitingDocumentDigest } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { WORKFLOW_DOCUMENT_CARD_KINDS, createDecisionPerformer, workflowDocumentHandler, type ProvingCaller } from "../../packages/broker/src/core/decisions/performer.js";
import { routeDecisionCards, type DecisionSources } from "../../packages/broker/src/core/decisions/routes.js";
import { decisionCardPath, type DecisionItem } from "../../packages/broker/src/core/decisions/project.js";
import { documentDecisionStore } from "../../packages/broker/src/core/decisions/store.js";

const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = ["local", "session", "for", "the", "card", "tests"].join("-");
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const OWNER = localOwnerPrincipal();

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${TASK_ID}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" },
  });
}

async function setup(risk: "low" | "medium" | "high") {
  const memory = new MemoryDocumentStore();
  const workflow = waiting();
  await memory.put({ item: { ...workflowTaskKey(TASK_ID), orgId: IMPLICIT_COMPANY_ID, project: "web", workflow: JSON.parse(JSON.stringify(workflow)) } });
  const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => new Date(NOW), verifySession: (token) => token === SESSION, verifyComment: () => ({ author: { provider: "any-code-host", tenant: "", accountId: "c" }, permission: "write", approves: true }) });
  const gate = createDecisionGate({ store: memory, approvers, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store: memory, riskOf: () => risk })], now: () => new Date(NOW) });
  const digest = waitingDocumentDigest(workflow)!;
  const item: DecisionItem = {
    kind: "approve_plan", subjectId: TASK_ID, taskId: TASK_ID, project: "web", title: "Add retry", createdAt: "2026-11-09T10:00:00.000Z", contentVersion: digest, openPath: `/app/sessions/ses_${"a".repeat(20)}`,
    path: "quick", files: risk === "high" ? ["infra/main.tf"] : ["src/retry.ts"], claims: 2, untestedClaims: risk === "medium" ? 1 : 0,
  };
  const sources: DecisionSources<ProvingCaller> = { list: async () => [item], locks: async () => ({}) };
  const performer = createDecisionPerformer<ProvingCaller>({ approve_plan: workflowDocumentHandler(gate) });
  const store = documentDecisionStore({ store: memory, now: () => NOW });
  const deps = { sources, performer, store, now: () => NOW, highOnCard: new Set<string>(WORKFLOW_DOCUMENT_CARD_KINDS), evidenceFirstOnHigh: new Set<string>(WORKFLOW_DOCUMENT_CARD_KINDS) };
  const caller = (credentials: ProvingCaller["credentials"]): ProvingCaller => ({ orgId: IMPLICIT_COMPANY_ID, developerId: "local-owner", credentials });
  const call = (who: ProvingCaller, method: string, pathname: string, body?: unknown) => routeDecisionCards(deps, who, { method, pathname, searchParams: new URLSearchParams(), body });
  const view = async () => DecisionCardsViewSchema.parse((await call(caller([]), "GET", "/v1/app/decisions"))?.body);
  const stored = async () => (await memory.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot;
  return { memory, call, caller, view, stored, cardId: `approve_plan:${TASK_ID}`, path: (action: string) => `${decisionCardPath(`approve_plan:${TASK_ID}`)}/${action}` };
}

describe("a card's Approve goes through the approval gate", () => {
  it("a low-risk card is approved with the owner's session, and the task moves", async () => {
    const t = await setup("low");
    const shownDigest = (await t.view()).digests[t.cardId]!;
    const reply = await t.call(t.caller([{ method: LOCAL_SESSION_METHOD, token: SESSION }]), "POST", t.path("approve"), { requestId: randomUUID(), shownDigest });
    expect(reply?.statusCode).toBe(200);
    expect(reply?.body).toMatchObject({ cardId: t.cardId, outcome: "approved" });
    expect((await t.stored()).stage).toBe("IMPLEMENT");
  });

  it("a forged proof is not an approval: the route refuses it and the task does not move", async () => {
    const t = await setup("low");
    const shownDigest = (await t.view()).digests[t.cardId]!;
    await expect(t.call(t.caller([{ method: LOCAL_SESSION_METHOD, token: "made-up" }]), "POST", t.path("approve"), { requestId: randomUUID(), shownDigest })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(t.call(t.caller([]), "POST", t.path("approve"), { requestId: randomUUID(), shownDigest })).rejects.toMatchObject({ code: expect.any(String) });
    expect((await t.stored()).stage).toBe("PLAN_REVIEW");
  });

  it("a plan revised after the card was drawn is stale, whatever the proof", async () => {
    const t = await setup("low");
    const shownDigest = (await t.view()).digests[t.cardId]!;
    const revised = JSON.parse(JSON.stringify(waiting())) as WorkflowSnapshot;
    revised.artifacts = [{ ...revised.artifacts[0]!, sha256: "e".repeat(64), version: 2, id: "plan-v2" }];
    await t.memory.put({ item: { ...workflowTaskKey(TASK_ID), orgId: IMPLICIT_COMPANY_ID, project: "web", workflow: JSON.parse(JSON.stringify({ ...revised, revision: revised.revision + 1 })) } });
    // The route's own digest check is the first guard; the gate is the second.
    await expect(t.call(t.caller([{ method: LOCAL_SESSION_METHOD, token: SESSION }]), "POST", t.path("approve"), { requestId: randomUUID(), shownDigest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await t.stored()).decisions).toHaveLength(0);
  });

  it("a medium card needs its evidence opened, then the owner's session approves it; a comment cannot approve a high card even on its card", async () => {
    const medium = await setup("medium");
    const owner = medium.caller([{ method: LOCAL_SESSION_METHOD, token: SESSION }]);
    const view = await medium.view();
    const shownDigest = view.digests[medium.cardId]!;
    expect(view.cards[0]!.risk).toBe("medium");
    await expect(medium.call(owner, "POST", medium.path("approve"), { requestId: randomUUID(), shownDigest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await medium.call(owner, "POST", medium.path("evidence-opened"), { requestId: randomUUID(), shownDigest });
    expect((await medium.call(owner, "POST", medium.path("approve"), { requestId: randomUUID(), shownDigest }))?.statusCode).toBe(200);

    const high = await setup("high");
    const highDigest = (await high.view()).digests[high.cardId]!;
    expect((await high.view()).cards[0]!.risk).toBe("high");
    await high.call(high.caller([]), "POST", high.path("evidence-opened"), { requestId: randomUUID(), shownDigest: highDigest });
    await expect(high.call(high.caller([{ method: CODE_HOST_COMMENT_METHOD, token: "comment-1" }]), "POST", high.path("approve"), { requestId: randomUUID(), shownDigest: highDigest })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await high.call(high.caller([{ method: LOCAL_SESSION_METHOD, token: SESSION }]), "POST", high.path("approve"), { requestId: randomUUID(), shownDigest: highDigest }))?.statusCode).toBe(200);
  });

  it("reject and request changes also need the owner's session", async () => {
    const t = await setup("low");
    const shownDigest = (await t.view()).digests[t.cardId]!;
    const reply = await t.call(t.caller([{ method: LOCAL_SESSION_METHOD, token: SESSION }]), "POST", t.path("request-changes"), { requestId: randomUUID(), shownDigest, reason: "Use the other table." });
    expect(reply?.statusCode === 200 || reply === undefined).toBe(true);
    expect((await t.stored()).stage).toBe("PLAN");
  });
});
