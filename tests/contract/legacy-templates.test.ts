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
import { withoutDispatcherLessonsPeople } from "../support/dispatcher-lessons-people-template.js";
import { withoutRetainPolicies } from "../support/retain-policies-template.js";
import { withoutWorkerCallbackAlarm } from "../support/worker-callback-alarm-template.js";
import { withoutWorkerEcrScope } from "../support/worker-ecr-scope-template.js";
import { withoutPublicApiUrl } from "../support/public-api-url-template.js";
import { withoutLinearWebhookRoute } from "../support/linear-webhook-route-template.js";
import { withoutCoreOutboxStreamRelay } from "../support/core-outbox-stream-relay-template.js";
import { withoutMachineGone } from "../support/machine-gone-template.js";
import { withTaskPeopleInvitationSwitches } from "../support/task-people-invitations-template.js";
import { withoutCanarySession } from "../support/canary-session-template.js";

skipLambdaBundling();
// CODE-PUBLIC-URL (2026-11-24): the legacy control plane's external URL bases that now go through the public address helper, counted so a URL that bypasses the helper moves it.
const PUBLIC_API_SITES = 21;
const LEGACY = { alarmName: "AgentXSessionStuckStopping", namespace: "AgentX" };

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
// DEC 254zzz443 (owner-approved, a security hardening): the legacy runtime roles gain a deny-only permissions boundary. The historical snapshots and the pre-Batch F pin stay as
// recorded: tests/support/legacy-runtime-boundary-template.ts asserts the addition's shape (one policy per stack, a PermissionsBoundary on every runtime role, nothing else) and takes it
// out; each changed stack's full template has its own new pin below, and legacy-runtime-boundary.test.ts proves the policy.
const BOUNDED_STACK_PINS: Record<string, string> = {
  // APIGW-ACCESS-LOGS (2026-11-24): re-pinned for exactly the access log group and the `$default` stage AccessLogSettings. Rule D: with those two taken out (withoutApiAccessLog) the old pin
  // b13a2af732a856782254d2cb8b285f9b86f87836c440f2568517b2c0aba0bbae holds (the test below checks it).
  // CODE-PUBLIC-URL (2026-11-24): the control plane is re-pinned for exactly the PublicApiUrl parameter and condition, each external URL base becoming Fn::If [HasPublicApiUrl, PublicApiUrl, the API's own host]
  // (resolved equal while the parameter is empty) and the broker's packed public host. Rule D: with those taken out (withoutPublicApiUrl) the pin recorded just before it holds (BOUNDED_STACK_PINS_BEFORE_PUBLIC_API,
  // the RETAIN pin below; the test below checks it). The foundation is unchanged (its firewall is off, so it has no PublicApiUrl).
  // LESSONS-PORT-FIX (DEC 254zzz473, rebased onto train 29 without turn-on): re-pinned for exactly the dispatcher's DEVELOPER_SIGNIN_TABLE_NAME variable and its DispatcherLessonsPeople policy. Rule D: with those
  // taken out (withoutDispatcherLessonsPeople) train 29's pin 9ae50c5be067ff3179bb07052e406d7997d042c2f4cab9bee8775c247a2175e6 holds (the test below checks it).
  // RETAIN (arch ruling 2026-11-24): re-pinned for exactly DeletionPolicy and UpdateReplacePolicy Retain on the control plane's five keys, channel state table and adapter secret, and on the foundation's two NAT
  // addresses. Rule D: with those taken out (withoutRetainPolicies) the pins below (BOUNDED_STACK_PINS_BEFORE_RETAIN, lessons-port's 48396a55... and the unchanged foundation pin) hold (the test below checks it).
  // F1 L1a-1 (2026-11-25): re-pinned for exactly the deletion of the two dead invitation parameters (TaskPeoplePublicInvitationsEnabled, TaskPeoplePrivateInvitationsEnabled) and their two packed
  // broker settings (tu, tv). Rule D: with those put back (withTaskPeopleInvitationSwitches) the pin recorded just before it, d3e0ac0cd15b05f0c196a50833d05099b57fa50f155e300ac621f69b55b0f7ff, holds
  // (BOUNDED_STACK_PINS_BEFORE_INVITATION_SWITCHES_DELETED; the test below checks it). The foundation never had them: its pin is unchanged.
  // D1-2 (owner DEC 254zzz511/519, 2026-11-25): every control-plane pin in this file (the full pins and each pin of the ladder below them) is re-pinned for exactly the removal of the old workflow
  // engine's three recovery schedules (GithubWebhookRecoverySchedule, WorkflowMergeRecoverySchedule, WorkflowDispatchRecoverySchedule), their two Scheduler roles and the roles' two DefaultPolicies.
  // A synth of this tree against code/next 5c44e8fca differs in exactly those seven AgentXControlPlane resources (removed, nothing added or modified; every other stack identical), and the snapshot
  // lost exactly those seven blocks. The foundation and Slack orchestrator pins are unchanged.
  AgentXControlPlane: "e4ccc198d14e2b46ba57f0789f52a8a4597c6c5098412ece4b0fcd48d70a3646",
  AgentXProductionFoundation: "37cec1f7637591a8315345f8e5fe75bacf0f43e475e66837da41d805e743fd28",
  AgentXSlackOrchestrator: "9ed4e1e13eeb3ecf860e61d9f2c9b332901f36190e0685fa695a390335420bf5",
};
// The pins recorded just before RETAIN (code/next 0074f4139): holding after exactly the nine policies are put back is the proof RETAIN changed nothing else.
// The control plane's pin recorded just before CODE-PUBLIC-URL (code/next f70b51001, the RETAIN pin above): holding after exactly the public API URL additions are taken out is the proof it changed nothing else.
const BOUNDED_STACK_PINS_BEFORE_INVITATION_SWITCHES_DELETED: Record<string, string> = {
  AgentXControlPlane: "d3e0ac0cd15b05f0c196a50833d05099b57fa50f155e300ac621f69b55b0f7ff",
};
const BOUNDED_STACK_PINS_BEFORE_PUBLIC_API: Record<string, string> = {
  AgentXControlPlane: "7e27a1682c8d7f189945ea6852ae8aa72eed3df148e89276bff58f156c24816f",
};
const BOUNDED_STACK_PINS_BEFORE_RETAIN: Record<string, string> = {
  AgentXControlPlane: "48396a55be1da2cfcbfcb44ee0a131120ba3e0c04470377e89fb2c77b3ff056b",
  AgentXProductionFoundation: "e7c873b146a748408b545e42d2f17596c04ad229271ed7776312d312eca9ca63",
};
// Worker ECR scope lane (2026-11-23): the Foundation pin moved only by the worker role's ECR statements (narrowed read, new Deny). The pin recorded before the lane (Fix A's) is kept
// below and re-derived in the test: Foundation minus exactly those two statement changes hashes to it.
const FOUNDATION_PIN_BEFORE_WORKER_ECR_SCOPE = "979226446fd4f97a824d983d189e9b4125e468dedc1fbfcbf540c24386b98abc";
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    if (stack.stackName === "AgentXControlPlane") {
      it("removing only Batch F additions preserves code/next's AgentXControlPlane template", () => {
        // F1 L1a-1: the two deleted invitation switches are put back innermost (Rule D, tests/support/task-people-invitations-template.ts), so this older pin holds as recorded.
        // DEC 254zzz488: the Linear webhook route (asserted and taken out, outermost) is the only change to the pins below besides the public-URL, lessons and RETAIN additions.
        const beforeBatchF = withoutLinearWebhookRoute(withoutWebhookSecretLane(withoutBatchFAdditions(withoutLegacyRuntimeBoundary(withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(withoutApiAccessLog(withoutPublicApiUrl(withoutDispatcherLessonsPeople(withoutRetainPolicies(withoutMachineGone(withTaskPeopleInvitationSwitches(withoutCoreOutboxStreamRelay(withoutCanarySession(normalizedTemplate(stack))))))), { named: false, sites: PUBLIC_API_SITES })), LEGACY))))));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("7dc7c0826f8f71826e5a18aea9138a3657f6423b3766f401553480ff6ba61b1f");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource). DEC 254zzz488: so is the Linear webhook route.
      const withCanary = stack.stackName === "AgentXControlPlane" ? withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(normalizedTemplate(stack), LEGACY)) : normalizedTemplate(stack);
      // CANARY-SESSION (Rule D): the control plane's full pin with the canary session function in (its four empty placement parameters, condition, template rule, function, role policy, invoke permission, metric filters,
      // alarms, output and the token key's conditional deny list) is below; with exactly those taken out (withoutCanarySession, asserted field by field in tests/support/canary-session-template.ts) the machine-gone pin after it holds, and so does everything after that.
      if (stack.stackName === "AgentXControlPlane") expect(createHash("sha256").update(JSON.stringify(withCanary)).digest("hex"), "AgentXControlPlane with the canary session function").toBe("dcd28ab8fba11b514ecf19d747125c9bcb7df4bb7ea3b45170acd052ce185518");
      const withMachineGone = stack.stackName === "AgentXControlPlane" ? withoutCanarySession(structuredClone(withCanary)) : withCanary;
      // WORKER-DELIVERY-IDENTITY (2026-11-25), Rule D: the control plane's pin (the line above) is taken with the instance state-change handler, its rule and the dispatcher's one Describe statement
      // in; with exactly those taken out (withoutMachineGone, tests/support/machine-gone-template.ts, which asserts they are exactly that) the relay pin recorded before it (9426578d..., the full control plane with the outbox stream relay setting) holds, and with the relay setting out the Linear pin aa5f9189... holds.
      // F1 L1a-1 (2026-11-25): that full pin moved too, for exactly the two deleted invitation parameters and their two packed settings (tu, tv). Rule D: with them put back (withTaskPeopleInvitationSwitches) the pin recorded
      // before it, 8383e122..., holds (the second line).
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withMachineGone)).digest("hex"), "AgentXControlPlane with the Linear webhook route, the guard and the machine-gone additions").toBe("a6c7de13f2fdc174983b1b5c13991ae60149536e3ca939ab7da5477d7e0907a8");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(withMachineGone)))).digest("hex"), "with the machine-gone additions and the two deleted invitation switches put back").toBe("8383e12288f961b6992d2b7ec5f9176ec8795fec30debb38e7c56c7203a5a257");
      }
      const withRelay = stack.stackName === "AgentXControlPlane" ? withoutMachineGone(structuredClone(withMachineGone)) : withMachineGone;
      // CORE-RUN-STOP-RELAY (G1, 2026-11-25): the control plane's full pin with the packed `rl=on` (broker and dispatcher) in is below; Rule D: with exactly that taken out (withoutCoreOutboxStreamRelay,
      // tests/support/core-outbox-stream-relay-template.ts) the Linear pin after it holds, and so does everything after that.
      // F1 L1a-1 (2026-11-25): that full pin moved too, for exactly the two deleted invitation parameters and their two packed settings (tu, tv). Rule D: with them put back (withTaskPeopleInvitationSwitches) the pin recorded
      // before it, 9426578d..., holds (the second line).
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withRelay)).digest("hex"), "AgentXControlPlane with the outbox stream relay setting").toBe("a2f867ca0edf69608b75739083dc8788bb9172c2d5c38b2c6f69fc679ccf94ed");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(withRelay)))).digest("hex"), "with the outbox stream relay setting and the two deleted invitation switches put back").toBe("9426578d48bbf6aac1fec0528d12081cae7eff963a85589e63de3036f1998375");
      }
      const withLinearWebhook = stack.stackName === "AgentXControlPlane" ? withoutCoreOutboxStreamRelay(structuredClone(withRelay)) : withRelay;
      // LINEAR-WEBHOOKS (DEC 254zzz488) + guard, rebased onto the public-URL pin (Rule D): the control plane's full pin with the Linear route, its throttle and its alarm in is below; with exactly those taken out
      // (withoutLinearWebhookRoute, asserted field by field in tests/support/linear-webhook-route-template.ts) the public-URL pin in BOUNDED_STACK_PINS holds, and so does everything after it.
      // F1 L1a-1 (2026-11-25): this full pin moved for exactly the deletion of the two dead invitation parameters and their two packed broker settings (tu, tv). Rule D: with them put back
      // (withTaskPeopleInvitationSwitches) the pin recorded before it, aa5f9189..., holds.
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withLinearWebhook)).digest("hex"), "AgentXControlPlane with the Linear webhook route and guard").toBe("c1599ff2afe2367663309732141886412179aabb06cac6dbbd341a78435bf7a7");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(withLinearWebhook))).digest("hex"), "with the two deleted invitation switches put back").toBe("aa5f91898202a0662df4e60b1c81cb2d9e16753ef113100220ce5517269ab9a9");
      }
      const template = stack.stackName === "AgentXControlPlane" ? withoutLinearWebhookRoute(structuredClone(withLinearWebhook)) : withLinearWebhook;
      const pin = BOUNDED_STACK_PINS[stack.stackName];
      if (pin !== undefined) expect(createHash("sha256").update(JSON.stringify(template)).digest("hex"), `${stack.stackName} with the runtime boundary`).toBe(pin);
      else expect(JSON.stringify(template)).not.toContain("PermissionsBoundary");
      // F1 L1a-1, Rule D: with the two deleted invitation switches put back the pin recorded before the deletion holds (the control plane only).
      const withInvitationSwitches = stack.stackName === "AgentXControlPlane" ? withTaskPeopleInvitationSwitches(template) : template;
      const beforeInvitationsPin = BOUNDED_STACK_PINS_BEFORE_INVITATION_SWITCHES_DELETED[stack.stackName];
      if (beforeInvitationsPin !== undefined) expect(createHash("sha256").update(JSON.stringify(withInvitationSwitches)).digest("hex"), `${stack.stackName} with the two deleted invitation switches put back`).toBe(beforeInvitationsPin);
      // CODE-PUBLIC-URL, Rule D: with exactly the public API URL additions taken out the pin recorded before it holds (the control plane only: the legacy foundation has no firewall, so no PublicApiUrl).
      const beforePublicApi = stack.stackName === "AgentXControlPlane" ? withoutPublicApiUrl(structuredClone(withInvitationSwitches), { named: false, sites: PUBLIC_API_SITES }) : withInvitationSwitches;
      const beforePublicApiPin = BOUNDED_STACK_PINS_BEFORE_PUBLIC_API[stack.stackName];
      if (beforePublicApiPin !== undefined) expect(createHash("sha256").update(JSON.stringify(beforePublicApi)).digest("hex"), `${stack.stackName} minus only the public API URL`).toBe(beforePublicApiPin);
      else expect(JSON.stringify(template)).not.toContain("PublicApiUrl");
      // RETAIN, Rule D: with exactly the nine policies put back the pin recorded before RETAIN holds, for the two stacks that hold any of them.
      const beforeRetain = BOUNDED_STACK_PINS_BEFORE_RETAIN[stack.stackName];
      if (beforeRetain !== undefined) expect(createHash("sha256").update(JSON.stringify(withoutRetainPolicies(structuredClone(beforePublicApi)))).digest("hex"), `${stack.stackName} minus only the RETAIN policies`).toBe(beforeRetain);
      if (stack.stackName === "AgentXControlPlane") expect(createHash("sha256").update(JSON.stringify(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi))))).digest("hex"), "AgentXControlPlane minus only the dispatcher lessons people grant").toBe("9ae50c5be067ff3179bb07052e406d7997d042c2f4cab9bee8775c247a2175e6");
      if (stack.stackName === "AgentXProductionFoundation") {
        expect(createHash("sha256").update(JSON.stringify(withoutWorkerEcrScope(withoutRetainPolicies(structuredClone(beforePublicApi))))).digest("hex"), "Foundation minus only the worker ECR lane's statements").toBe(FOUNDATION_PIN_BEFORE_WORKER_ECR_SCOPE);
      }
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new template,
      // assert the exact broker-only addition, and retain the entire historical snapshot.
      if (stack.stackName === "AgentXControlPlane") {
        // APIGW-ACCESS-LOGS (2026-11-24): the access log group and the stage setting are asserted and taken out first, so the recorded pin and snapshot below still hold. The full-template pin above
        // (BOUNDED_STACK_PINS) is the one that moved.
        // RETAIN (Rule D): the recorded pins are taken after the nine policies are put back (withoutRetainPolicies, innermost); the snapshot below keeps them (it records Retain on the nine).
        const beforeAccessLog = withoutApiAccessLog(withoutDispatcherLessonsPeople(structuredClone(beforePublicApi)));
        expect(createHash("sha256").update(JSON.stringify(withoutApiAccessLog(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi)))))).digest("hex"), "AgentXControlPlane minus only the access log").toBe("b13a2af732a856782254d2cb8b285f9b86f87836c440f2568517b2c0aba0bbae");
        const withoutBoundary = withoutLegacyRuntimeBoundary(beforeAccessLog);
        expect(createHash("sha256").update(JSON.stringify(withoutLegacyRuntimeBoundary(withoutApiAccessLog(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi))))))).digest("hex")).toBe("fc60f31f926de4011221b11b06deb9c2dc84be720a7f4814aeee7d405c7ee175");
        // Webhook lane W3 adds the webhook secret slot, its throttle and one alarm (tests/support/webhook-secret-template.ts pins them); the historical snapshot is of the rest.
        expect(withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(withoutBoundary))).toMatchSnapshot();
      } else expect(withoutLegacyRuntimeBoundary(template)).toMatchSnapshot();
    }, 120_000);
  }
});
