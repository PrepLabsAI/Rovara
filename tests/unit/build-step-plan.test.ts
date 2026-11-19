// Lane L10 (review M4, L4): the tier of a plan is the planner's own reading RAISED to a floor the core computes itself, never lowered; and the coder is told the plan's decisions are settled.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPlanJson, type PlanDocument, type WorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { gradePlanRisk, planRiskFloor } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { approvedCodingPlan } from "../../packages/broker/src/core/build-step/plan-input.js";
import { planDocument } from "../support/plan-documents.js";

const structured = (plan: PlanDocument, markdown = "") => ({ format: "structured" as const, artifact: {} as never, plan, markdown });
const proved = { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], proves: { unit: ["1", "2"] } };
const claims = [{ id: "1", text: "Retry in src/retry/backoff.ts." }, { id: "2", text: "A retry is never charged twice." }];
const workflow = {} as Pick<WorkflowSnapshot, "designReview">;

describe("the tier of a plan", () => {
  it("a plan that names a plain file and proves every claim is low, as before; one that proves nothing is medium; one that names no file at all is medium", () => {
    const low = planDocument({ claims, checks: proved });
    expect(gradePlanRisk({ loaded: structured(low, "Retry in src/retry/backoff.ts."), workflow })).toBe("low");
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims }), "Retry in src/retry/backoff.ts."), workflow })).toBe("medium");
    expect(gradePlanRisk({ loaded: { format: "markdown", artifact: {} as never, markdown: "# Plan\nRetry." }, workflow })).toBe("medium");
    expect(gradePlanRisk({ loaded: undefined, workflow })).toBe("medium");
  });

  it("a plan that claims low (every claim proved, harmless files cited) cannot lower what the core reads in its text or in the request", () => {
    const claimsLow = planDocument({ claims, checks: proved });
    // The planner's evidence is plain, but the request names an infrastructure file: the floor is high.
    expect(gradePlanRisk({ loaded: structured(claimsLow, "Retry in src/retry/backoff.ts."), workflow, requestText: "Also change infra/prod/main.tf" })).toBe("high");
    // ... and so does the plan's own rendered text (a path the planner left out of its evidence).
    expect(gradePlanRisk({ loaded: structured(claimsLow, "Retry in src/retry/backoff.ts. Also migrations/0042_retry.sql"), workflow })).toBe("high");
    // A sensitive path in the planner's own claims is high without the floor too; the floor never lowers it.
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims: [{ id: "1", text: "Edit infra/iam/role.tf." }, { id: "2", text: "Never twice." }], checks: proved }), "Edit infra/iam/role.tf."), workflow })).toBe("high");
  });

  it("reads what the text and the request say, not only paths with an extension: known files, directories without an extension, and words", () => {
    expect(planRiskFloor({ texts: ["Add a stage to the Dockerfile"] })).toBe("high");
    expect(planRiskFloor({ texts: ["Edit infra/iam/policy"] })).toBe("high");
    expect(planRiskFloor({ texts: ["Change the IAM policy so the job can read the bucket"] })).toBe("high");
    expect(planRiskFloor({ texts: ["Add a column; the migration runs at deploy"] })).toBe("high");
    expect(planRiskFloor({ texts: ["Update the Jenkinsfile"] })).toBe("medium");
    expect(planRiskFloor({ texts: ["Who owns this: CODEOWNERS"] })).toBe("medium");
    expect(planRiskFloor({ texts: ["Add a target to the Makefile"] })).toBe("medium");
    expect(planRiskFloor({ texts: ["Rotate the payment secrets and the password check"] })).toBe("medium");
    // Words that only contain one are not it.
    expect(planRiskFloor({ texts: ["The author of src/retry/backoff.ts wrote a diamond pattern"] })).toBe("low");
    // The planner's own text is read the same way, and its claims of proof do not lower it.
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims, checks: proved }), "Retry in src/retry/backoff.ts and change the IAM policy"), workflow })).toBe("high");
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims, checks: proved }), "Retry in src/retry/backoff.ts"), workflow, requestText: "and add it to the Dockerfile" })).toBe("high");
  });

  it("size and cost raise it: more than 25 files is at least medium, an estimate over $25 is medium and over $100 high", () => {
    const many = Array.from({ length: 26 }, (_, index) => `src/part${String(index)}/file.ts`).join(" ");
    expect(planRiskFloor({ texts: [many] })).toBe("medium");
    expect(planRiskFloor({ texts: ["src/retry/backoff.ts"] })).toBe("low");
    expect(planRiskFloor({ texts: ["src/retry/backoff.ts"], costHighUsd: 30 })).toBe("medium");
    expect(planRiskFloor({ texts: ["src/retry/backoff.ts"], costHighUsd: 120 })).toBe("high");
    expect(gradePlanRisk({ loaded: structured(planDocument({ claims, checks: proved }), "src/retry/backoff.ts"), workflow, costHighUsd: 120 })).toBe("high");
  });
});

describe("the plan the coder is given", () => {
  const plan = planDocument({ claims, checks: proved });
  const text = canonicalPlanJson(plan);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const artifact = { id: "11111111-1111-4111-8111-111111111111", type: "plan", version: 1, sha256, producer: "agentx-worker-untrusted", objectKey: "plans/p.json", createdAt: "2026-11-09T10:00:00.000Z", format: "structured" } as unknown as WorkflowArtifact;
  const reader = { get: async (key: string) => (key === "plans/p.json" ? new TextEncoder().encode(text) : undefined) };
  const approve = (extra: object = {}) => ({ requestId: "r", workflowRevision: 1, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Approved.", artifactDigest: sha256, at: "2026-11-09T10:00:00.000Z", ...extra });

  it("is told the decisions are settled: AgentX's recommended answers by default, the owner's own when the approval carried them", async () => {
    const recommended = await approvedCodingPlan(reader, { artifacts: [artifact], decisions: [approve()] as never });
    expect(recommended.text).toContain("treat each as decided");
    const own = await approvedCodingPlan(reader, { artifacts: [artifact], decisions: [approve({ answerOverrides: [{ decisionId: "d1", optionId: "five" }] })] as never });
    expect(own.text).toContain("The owner's answers are binding");
    expect(own.notChanging).toEqual(["The refund flow stays as it is."]);
  });

  it("is refused when the stored document is not the one the approval named", async () => {
    await expect(approvedCodingPlan({ get: async () => new TextEncoder().encode(`${text} `) }, { artifacts: [artifact], decisions: [approve()] as never })).rejects.toThrow(/digest/u);
  });
});
