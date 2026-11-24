import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";
import { withoutLegacyRuntimeBoundary } from "../support/legacy-runtime-boundary-template.js";
import { withoutWebhookSecretLane } from "../support/webhook-secret-template.js";
import { withoutStuckStoppingAlarm } from "../support/stuck-stopping-alarm-template.js";
import { withoutApiAccessLog } from "../support/api-access-log-template.js";
import { withoutWorkerCallbackAlarm } from "../support/worker-callback-alarm-template.js";
import { withoutWorkerEcrScope } from "../support/worker-ecr-scope-template.js";

skipLambdaBundling();
const LEGACY = { alarmName: "AgentXSessionStuckStopping", namespace: "AgentX" };

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
// DEC 254zzz443 (owner-approved, a security hardening): the legacy runtime roles gain a deny-only permissions boundary. The historical snapshots and the pre-Batch F pin stay as
// recorded: tests/support/legacy-runtime-boundary-template.ts asserts the addition's shape (one policy per stack, a PermissionsBoundary on every runtime role, nothing else) and takes it
// out; each changed stack's full template has its own new pin below, and legacy-runtime-boundary.test.ts proves the policy.
const BOUNDED_STACK_PINS: Record<string, string> = {
  // APIGW-ACCESS-LOGS (2026-11-24): re-pinned for exactly the access log group and the `$default` stage AccessLogSettings. Rule D: with those two taken out (withoutApiAccessLog) the old pin
  // e623671f730a3b4a00ee53aca931ded20fda388090c2bb8ff8d2afe412625645 holds (the test below checks it).
  AgentXControlPlane: "64f6489a43149d8df42cd1205aaf5466d91a83d478d1ae6a3fca89f8a1e444da",
  AgentXProductionFoundation: "37cec1f7637591a8315345f8e5fe75bacf0f43e475e66837da41d805e743fd28",
  AgentXSlackOrchestrator: "9ed4e1e13eeb3ecf860e61d9f2c9b332901f36190e0685fa695a390335420bf5",
};
// Worker ECR scope lane (2026-11-23): the Foundation pin moved only by the worker role's ECR statements (narrowed read, new Deny). The pin recorded before the lane (Fix A's) is kept
// below and re-derived in the test: Foundation minus exactly those two statement changes hashes to it.
const FOUNDATION_PIN_BEFORE_WORKER_ECR_SCOPE = "e4f84f8cac2629506942d62e456e6fe7c8dd928de9b83bdc071bcdde254cbdea";
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    if (stack.stackName === "AgentXControlPlane") {
      it("removing only Batch F additions preserves code/next's AgentXControlPlane template", () => {
        const beforeBatchF = withoutWebhookSecretLane(withoutBatchFAdditions(withoutLegacyRuntimeBoundary(withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(withoutApiAccessLog(normalizedTemplate(stack)), LEGACY)))));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("bc89083677893f1c0c06a1c6ad4050367d0b7165020f88882d5d7764b04adc12");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource).
      const template = stack.stackName === "AgentXControlPlane" ? withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY)) : normalizedTemplate(stack);
      const pin = BOUNDED_STACK_PINS[stack.stackName];
      if (pin !== undefined) expect(createHash("sha256").update(JSON.stringify(template)).digest("hex"), `${stack.stackName} with the runtime boundary`).toBe(pin);
      else expect(JSON.stringify(template)).not.toContain("PermissionsBoundary");
      if (stack.stackName === "AgentXProductionFoundation") {
        expect(createHash("sha256").update(JSON.stringify(withoutWorkerEcrScope(template))).digest("hex"), "Foundation minus only the worker ECR lane's statements").toBe(FOUNDATION_PIN_BEFORE_WORKER_ECR_SCOPE);
      }
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        // APIGW-ACCESS-LOGS (2026-11-24): the access log group and the stage setting are asserted and taken out first, so the recorded pin and snapshot below still hold. The full-template pin above
        // (BOUNDED_STACK_PINS) is the one that moved.
        const beforeAccessLog = withoutApiAccessLog(structuredClone(template));
        expect(createHash("sha256").update(JSON.stringify(beforeAccessLog)).digest("hex"), "AgentXControlPlane minus only the access log").toBe("e623671f730a3b4a00ee53aca931ded20fda388090c2bb8ff8d2afe412625645");
        const withoutBoundary = withoutLegacyRuntimeBoundary(beforeAccessLog);
        expect(createHash("sha256").update(JSON.stringify(withoutBoundary)).digest("hex")).toBe("29a3b2e4d4f0a76f9507a9876bff5e454b6132de60b7e3e5e6f235ef24001d74");
        // Webhook lane W3 adds the webhook secret slot, its throttle and one alarm (tests/support/webhook-secret-template.ts pins them); the historical snapshot is of the rest.
        expect(withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(withoutBoundary))).toMatchSnapshot();
      } else expect(withoutLegacyRuntimeBoundary(template)).toMatchSnapshot();
    }, 120_000);
  }
});
