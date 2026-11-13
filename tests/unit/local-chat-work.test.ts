// What `rovara up` does with what a chat adapter hands it after the sink's checks: a start runs only for the owner, and a decision reaches the gate only for the owner and only as a credential of the chat's own method that names
// the account that pressed. The flow and the gate are stubs; the store is the memory one.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type ChannelDecision, type OrgId } from "@rovara-code/contracts";
import type { ApprovalCard } from "../../packages/core/src/core/channel/index.js";
import type { DecisionAttempt } from "../../packages/core/src/core/decisions/approval-gate.js";
import { developerIdOf } from "../../packages/core/src/core/sessions/create.js";
import { createLocalChat } from "../../packages/core/src/local/app/chat.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const owner = localOwnerPrincipal();
const OWNER_ID = developerIdOf(owner);
const STRANGER = "c".repeat(64);
const CONVERSATION = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };

function make() {
  const started: unknown[] = [];
  const attempts: DecisionAttempt[] = [];
  const chat = createLocalChat({
    registry: { get: () => undefined, names: () => [] }, store: new MemoryDocumentStore(), companyId: ORG, owner, now: () => Date.parse("2026-11-10T10:00:00.000Z"),
    flow: { start: async (_caller: unknown, body: unknown) => { started.push(body); return { task: { taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6" }, duplicate: false }; } } as never,
    gate: { decide: async (attempt: DecisionAttempt) => { attempts.push(attempt); return { status: "refused" as const, reason: "method_not_allowed" as const, detail: "x" }; } },
  });
  return { chat, started, attempts };
}
const card: ApprovalCard = {
  requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", channel: "examplechat", kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: "d".repeat(64),
  conversation: CONVERSATION, offered: ["APPROVE"], sentAt: "2026-11-10T10:00:00.000Z", expiresAt: 4_000_000_000,
};
const decision: ChannelDecision = {
  version: 1, channel: "examplechat", eventId: "d1", conversation: CONVERSATION, actor: { channel: "examplechat", tenant: "team1", userId: "user1" }, requestId: card.requestId, expectedRevision: 3,
  artifactDigest: card.artifactDigest, decision: "APPROVE", reason: "pressed", receivedAt: "2026-11-10T10:00:00.000Z",
};
const message = { version: 2 as const, channel: "examplechat", eventId: "m1", conversation: CONVERSATION, actor: decision.actor, text: "add a retry", receivedAt: "2026-11-10T10:00:00.000Z" };

describe("what rovara up does with what a chat adapter hands it", () => {
  it("starts work only for the owner: a link to anyone else starts nothing", async () => {
    const { chat, started } = make();
    await chat.work("examplechat").message({ orgId: ORG, message, projectName: "web", personId: STRANGER });
    expect(started).toEqual([]);
    await chat.work("examplechat").message({ orgId: ORG, message, projectName: "web", personId: OWNER_ID });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ project: "web", instructions: "add a retry", workflow: true });
  });

  it("decides only for the owner, and only as the chat's own method, naming the account that pressed", async () => {
    const { chat, attempts } = make();
    const work = chat.work("examplechat");
    expect(await work.decide({ orgId: ORG, card, decision, personId: STRANGER, projectName: "web" })).toEqual({ status: "refused", reason: "invalid" });
    expect(attempts).toEqual([]);
    expect(await work.decide({ orgId: ORG, card, decision: { ...decision, decision: "SKIP" }, personId: OWNER_ID, projectName: "web" })).toEqual({ status: "refused", reason: "invalid" });
    expect(attempts).toEqual([]);
    expect(await work.decide({ orgId: ORG, card, decision, personId: OWNER_ID, projectName: "web" })).toEqual({ status: "refused", reason: "method_not_allowed" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      kind: "workflow-document", subjectId: "task-1", outcome: "approve", seen: { revision: 3, artifactDigest: card.artifactDigest },
    });
    expect(attempts[0]!.credentials).toHaveLength(1);
    expect(attempts[0]!.credentials[0]).toMatchObject({ method: "chat-examplechat", claimedAccount: { provider: "examplechat", tenant: "team1", accountId: "user1" } });
    expect(attempts[0]!.credentials[0]!.token).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("presents the same proof when the same account presses the same card again (so the gate answers the repeat), and another proof for another account or card", async () => {
    const { chat, attempts } = make();
    const work = chat.work("examplechat");
    await work.decide({ orgId: ORG, card, decision, personId: OWNER_ID, projectName: "web" });
    await work.decide({ orgId: ORG, card, decision: { ...decision, eventId: "d2" }, personId: OWNER_ID, projectName: "web" });
    await work.decide({ orgId: ORG, card, decision: { ...decision, eventId: "d3", actor: { ...decision.actor, userId: "user2" } }, personId: OWNER_ID, projectName: "web" });
    await work.decide({ orgId: ORG, card: { ...card, requestId: "4f2504e0-4f89-41d3-9a0c-0305e82c3301" }, decision, personId: OWNER_ID, projectName: "web" });
    const tokens = attempts.map((attempt) => attempt.credentials[0]!.token);
    expect(tokens[0]).toBe(tokens[1]);
    expect(new Set(tokens).size).toBe(3);
  });
});
