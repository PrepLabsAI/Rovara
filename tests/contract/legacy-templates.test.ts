import { withoutCloseRetention } from "../support/close-retention-template.js";
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
        const beforeBatchF = withoutBatchFAdditions(withoutCloseRetention(normalizedTemplate(stack)));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("a2098ca531ef21213fc6d3a6fa57f7a330475d9181de891a288b6c608085d6a6");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      let template = normalizedTemplate(stack);
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        // DEC331: pin the full synth, then assert/subtract only the approved retention delta.
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("83cf0ecd2621687a4d4b3640faa932739b3b165b86e065d8a9a18b2979a6ea39");
        template = withoutCloseRetention(template);
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("3eb5d65c642a0b53a3ec5f8e0a7abfa9bbacde9e31b7eb0f4acaf40b4b6005f2");
        expect(withoutBrokerMemberConditionCheck(template)).toMatchSnapshot();
      } else expect(template).toMatchSnapshot();
    }, 120_000);
  }
});
