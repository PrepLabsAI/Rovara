
import { describe, expect, it } from "vitest";
import { type PlanDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { gradePlanRisk, planRiskFloor } from "../../packages/broker/src/core/decisions/plan-risk.js";
import { planDocument } from "../support/plan-documents.js";

const structured = (plan: PlanDocument, markdown = "") => ({ format: "structured" as const, artifact: {} as never, plan, markdown });
const proved = { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], proves: { unit: ["1", "2"] } };
const claims = [{ id: "1", text: "Retry in src/retry/backoff.ts." }, { id: "2", text: "A retry is never charged twice." }];
const workflow = {} as Pick<WorkflowSnapshot, "designReview">;

describe("the tier of a plan", () => {

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
});
