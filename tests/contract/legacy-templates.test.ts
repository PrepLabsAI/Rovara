import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";

skipLambdaBundling();

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    if (stack.stackName === "AgentXControlPlane") {
      it("removing only Batch F additions preserves code/next's AgentXControlPlane template", () => {
        const beforeBatchF = withoutBatchFAdditions(normalizedTemplate(stack));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("a2098ca531ef21213fc6d3a6fa57f7a330475d9181de891a288b6c608085d6a6");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("3eb5d65c642a0b53a3ec5f8e0a7abfa9bbacde9e31b7eb0f4acaf40b4b6005f2");
        expect(withoutBrokerMemberConditionCheck(template)).toMatchSnapshot();
      } else expect(template).toMatchSnapshot();
    }, 120_000);
  }
});
