// REDACT-BLOCK-REASON (Opus review F2): the Slack words for a block reason redact the E2E plan-correction reasons (which carry the broker's ApplicationPlanDefect message, a line that can quote the plan)
// like the CI-fix and branch-sync reasons; the broker's own fixed sentence for the plan reference reads as before.
import { describe, expect, it } from "vitest";
import { BRANCH_CONFLICT_ASK_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX } from "@agentx/contracts";
import { plainBlockReason } from "../../packages/broker/src/developer/workflow-messages.js";
import { E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON } from "../../packages/broker/src/developer/task-records.js";
import { ApplicationPlanDefect } from "../../packages/broker/src/e2e/application-dispatch-check.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const quoted = (): string => `step 2 calls https://x-access-token:${token()}@api.example.test/v1 with password Tr0ub4dor&3`;

describe("plainBlockReason", () => {
  it("redacts the ApplicationPlanDefect message of an E2E plan-not-approvable reason", () => {
    const reason = new ApplicationPlanDefect(quoted()).message;
    expect(reason.startsWith(WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX)).toBe(true);
    const shown = plainBlockReason(reason);
    expect(shown).toContain("The approved browser and API plan can no longer run as written");
    expect(shown).toContain("[REDACTED]");
    expect(shown).not.toContain(token());
    expect(shown).not.toContain("Tr0ub4dor");
  });
  it("keeps the fixed plan-reference sentence, and the ordinary plan defect, as they read", () => {
    expect(plainBlockReason(E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON)).toContain("references a source operation that does not match the protected candidate");
    expect(plainBlockReason(E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON)).not.toContain("[REDACTED]");
    expect(plainBlockReason(new ApplicationPlanDefect("step 2 has no expected result").message)).toContain("step 2 has no expected result");
  });
  it("still redacts the CI-fix and branch reasons it redacted", () => {
    const shown = plainBlockReason(`${BRANCH_CONFLICT_ASK_PREFIX}${quoted()}`);
    expect(shown).not.toContain(token());
  });
});
