import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";
import { withoutLegacyRuntimeBoundary } from "../support/legacy-runtime-boundary-template.js";
import { withoutWebhookSecretLane } from "../support/webhook-secret-template.js";
import { withoutStuckStoppingAlarm } from "../support/stuck-stopping-alarm-template.js";

skipLambdaBundling();
const LEGACY = { alarmName: "AgentXSessionStuckStopping", namespace: "AgentX" };

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
// DEC 254zzz443 (owner-approved, a security hardening): the legacy runtime roles gain a deny-only permissions boundary. The historical snapshots and the pre-Batch F pin stay as
// recorded: tests/support/legacy-runtime-boundary-template.ts asserts the addition's shape (one policy per stack, a PermissionsBoundary on every runtime role, nothing else) and takes it
// out; each changed stack's full template has its own new pin below, and legacy-runtime-boundary.test.ts proves the policy.
const BOUNDED_STACK_PINS: Record<string, string> = {
  AgentXControlPlane: "4ab39f2edce8a0d23cd306aabeed2077129c21879caeda1f9ba37f255d59740a",
  AgentXProductionFoundation: "979226446fd4f97a824d983d189e9b4125e468dedc1fbfcbf540c24386b98abc",
  AgentXSlackOrchestrator: "1b511b1013eb0c7692c3f99802062f6aa6152ad040d53f873305112be71c35ad",
};
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    if (stack.stackName === "AgentXControlPlane") {
      it("removing only Batch F additions preserves code/next's AgentXControlPlane template", () => {
        const beforeBatchF = withoutWebhookSecretLane(withoutBatchFAdditions(withoutLegacyRuntimeBoundary(withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY))));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("a2098ca531ef21213fc6d3a6fa57f7a330475d9181de891a288b6c608085d6a6");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource).
      const template = stack.stackName === "AgentXControlPlane" ? withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY) : normalizedTemplate(stack);
      const pin = BOUNDED_STACK_PINS[stack.stackName];
      if (pin !== undefined) expect(createHash("sha256").update(JSON.stringify(template)).digest("hex"), `${stack.stackName} with the runtime boundary`).toBe(pin);
      else expect(JSON.stringify(template)).not.toContain("PermissionsBoundary");
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        const withoutBoundary = withoutLegacyRuntimeBoundary(template);
        expect(createHash("sha256").update(JSON.stringify(withoutBoundary)).digest("hex")).toBe("c56e0bf3d053743471b5545f1b78a0487030335cb9dcb977095dd162686b8e7e");
        // Webhook lane W3 adds the webhook secret slot, its throttle and one alarm (tests/support/webhook-secret-template.ts pins them); the historical snapshot is of the rest.
        expect(withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(withoutBoundary))).toMatchSnapshot();
      } else expect(withoutLegacyRuntimeBoundary(template)).toMatchSnapshot();
    }, 120_000);
  }
});
