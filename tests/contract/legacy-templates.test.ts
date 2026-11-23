import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";
import { withoutWebhookSecretLane } from "../support/webhook-secret-template.js";
import { withoutStuckStoppingAlarm } from "../support/stuck-stopping-alarm-template.js";

skipLambdaBundling();
const LEGACY = { alarmName: "AgentXSessionStuckStopping", namespace: "AgentX" };

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    if (stack.stackName === "AgentXControlPlane") {
      it("removing only Batch F additions preserves code/next's AgentXControlPlane template", () => {
        const beforeBatchF = withoutWebhookSecretLane(withoutBatchFAdditions(withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY)));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("a2098ca531ef21213fc6d3a6fa57f7a330475d9181de891a288b6c608085d6a6");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource).
      const template = stack.stackName === "AgentXControlPlane" ? withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY) : normalizedTemplate(stack);
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("c56e0bf3d053743471b5545f1b78a0487030335cb9dcb977095dd162686b8e7e");
        // Webhook lane W3 adds the webhook secret slot, its throttle and one alarm (tests/support/webhook-secret-template.ts pins them); the historical snapshot is of the rest.
        expect(withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(template))).toMatchSnapshot();
      } else expect(template).toMatchSnapshot();
    }, 120_000);
  }
});
