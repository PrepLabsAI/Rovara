// Decisions D2: the document-store form of the decision store keeps the evidence-opened record per person, card, tab and digest, and writes a decision once per request id.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { documentDecisionStore, DECISION_EVIDENCE_OPEN_TTL_MS } from "../../packages/broker/src/core/decisions/store.js";

describe("documentDecisionStore", () => {
  const who = { orgId: "org1", developerId: "dev1" };
  it("remembers the opened digest for this person, card and tab only", async () => {
    const store = documentDecisionStore({ store: new MemoryDocumentStore(), now: () => Date.parse("2026-10-30T10:00:00.000Z") });
    const memory = new MemoryDocumentStore();
    const now = Date.parse("2026-10-30T10:00:00.000Z");
    const decisions = documentDecisionStore({ store: memory, now: () => now });
    await decisions.recordEvidenceOpened({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1", "2026-10-30T10:00:00.000Z");
    expect(await decisions.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1")).toBe("2026-10-30T10:00:00.000Z");
    expect(await decisions.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d2")).toBeUndefined();
    expect(await decisions.evidenceOpenedAt({ ...who, cardId: "approve_plan:a" }, "d1")).toBeUndefined();
    expect(await decisions.evidenceOpenedAt({ orgId: "org1", developerId: "dev2", cardId: "approve_plan:a", tab: "design" }, "d1")).toBeUndefined();
    const expired = documentDecisionStore({ store: memory, now: () => now + DECISION_EVIDENCE_OPEN_TTL_MS + 1 });
    expect(await expired.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1")).toBeUndefined();
    void store;
  });
  it("finds a decision by request id for the same person only", async () => {
    const store = documentDecisionStore({ store: new MemoryDocumentStore(), now: () => 1_000_000 });
    const record = { ...who, cardId: "approve_design:d", kind: "approve_design" as const, risk: "low" as const, outcome: "approved" as const, tab: "design" as const, requestId: "r9", createdAt: "2026-10-30T10:00:00.000Z", decidedAt: "2026-10-30T10:01:00.000Z" };
    await store.recordDecision(record);
    expect(await store.findDecision(who, "r9")).toMatchObject({ cardId: "approve_design:d", kind: "approve_design", outcome: "approved", tab: "design" });
    expect(await store.findDecision({ orgId: "org1", developerId: "dev2" }, "r9")).toBeUndefined();
    expect(await store.findDecision(who, "nope")).toBeUndefined();
  });
});
