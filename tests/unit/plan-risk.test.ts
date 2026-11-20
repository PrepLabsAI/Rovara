// Decision journey slice 2 (review fixes): the coding plan card's facts are read from the plan, never assumed. A plan that names no file is "unread" (at least medium, no "0 files" chip); paths named
// anywhere in its text count; a Markdown or unreadable plan is unread. Known limit: "a check proves this claim" is the plan's own assertion (the merge card is the backstop).
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { planFactsOf, planRiskOf } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { cardOfItem, type DecisionItem } from "../../packages/broker/src/core/decisions/project.js";
import { planDocument } from "../support/plan-documents.js";

const structured = (plan: PlanDocument) => ({ format: "structured" as const, artifact: {} as never, plan, markdown: "" });
const proved = { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], proves: { unit: ["1", "2"] } };

describe("plan facts", () => {
  it("a structured plan that names no file anywhere is unread: at least medium, and its card shows no files or proof chip", () => {
    const plan = planDocument({ claims: [{ id: "1", text: "Payments that time out are retried." }, { id: "2", text: "A payment is never charged twice." }], risks: ["A slow gateway."], checks: proved });
    const facts = planFactsOf(structured(plan));
    expect(facts).toEqual({ files: [], untestedClaims: 0, unread: true });
    expect(planRiskOf(facts, 1)).toBe("medium");
    const item: DecisionItem = { kind: "approve_plan", subjectId: "t1", project: "p", title: "Retry", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: "/app/projects/p", path: "quick", files: facts.files, claims: 2, untestedClaims: 0, unread: true };
    const card = cardOfItem(item)!.card;
    expect(card.risk).toBe("medium");
    expect(card.evidence.map((chip) => chip.label)).not.toContain("Files");
    expect(card.evidence.map((chip) => chip.label)).not.toContain("Planned proof");
  });
  it("the design under review's cited files count", () => {
    const plan = planDocument({ claims: [{ id: "1", text: "Retry." }, { id: "2", text: "Never twice." }], checks: proved });
    const workflow = { designReview: { rounds: [{ findings: [{ citations: [{ kind: "code", path: "migrations/0042_retry.sql" }] }] }] } } as never;
    const facts = planFactsOf(structured(plan), workflow);
    expect(facts.files).toEqual(["migrations/0042_retry.sql"]);
    expect(planRiskOf(facts, 1)).toBe("high");
  });
});
