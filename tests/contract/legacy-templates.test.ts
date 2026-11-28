import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { withoutInstallCompanyOutput } from "../support/install-company-output-template.js";
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
  // 40082278dc51ffcdab47c7f0eb7a5aa25b06b0aac26ee1ce25fe855aad3fcc9c holds (the test below checks it).
  // CODE-PUBLIC-URL (2026-11-24): the control plane is re-pinned for exactly the PublicApiUrl parameter and condition, each external URL base becoming Fn::If [HasPublicApiUrl, PublicApiUrl, the API's own host]
  // (resolved equal while the parameter is empty) and the broker's packed public host. Rule D: with those taken out (withoutPublicApiUrl) the pin recorded just before it holds (BOUNDED_STACK_PINS_BEFORE_PUBLIC_API,
  // the RETAIN pin below; the test below checks it). The foundation is unchanged (its firewall is off, so it has no PublicApiUrl).
  // LESSONS-PORT-FIX (DEC 254zzz473, rebased onto train 29 without turn-on): re-pinned for exactly the dispatcher's DEVELOPER_SIGNIN_TABLE_NAME variable and its DispatcherLessonsPeople policy. Rule D: with those
  // taken out (withoutDispatcherLessonsPeople) train 29's pin e77bda1aed9a481802568f1c4d67eae73bdc1d7f85fff30d4af2220511b815cb holds (the test below checks it).
  // RETAIN (arch ruling 2026-11-24): re-pinned for exactly DeletionPolicy and UpdateReplacePolicy Retain on the control plane's five keys, channel state table and adapter secret, and on the foundation's two NAT
  // addresses. Rule D: with those taken out (withoutRetainPolicies) the pins below (BOUNDED_STACK_PINS_BEFORE_RETAIN, lessons-port's 04fde51d... and the unchanged foundation pin) hold (the test below checks it).
  // F1 L1a-1 (2026-11-25): re-pinned for exactly the deletion of the two dead invitation parameters (TaskPeoplePublicInvitationsEnabled, TaskPeoplePrivateInvitationsEnabled) and their two packed
  // broker settings (tu, tv). Rule D: with those put back (withTaskPeopleInvitationSwitches) the pin recorded just before it, 4a4191be7d18ca8264c8f00ee2fab1ae205c49d528b3605682572afdd6016cbd, holds
  // (BOUNDED_STACK_PINS_BEFORE_INVITATION_SWITCHES_DELETED; the test below checks it). The foundation never had them: its pin is unchanged.
  // D1-2 (owner DEC 254zzz511/519, 2026-11-25): every control-plane pin in this file (the full pins and each pin of the ladder below them) is re-pinned for exactly the removal of the old workflow
  // engine's three recovery schedules (GithubWebhookRecoverySchedule, WorkflowMergeRecoverySchedule, WorkflowDispatchRecoverySchedule), their two Scheduler roles and the roles' two DefaultPolicies.
  // A synth of this tree against code/next 5c44e8fca differs in exactly those seven AgentXControlPlane resources (removed, nothing added or modified; every other stack identical), and the snapshot
  // lost exactly those seven blocks. The foundation and Slack orchestrator pins are unchanged.
  AgentXControlPlane: "455ec6d79b217fb2b7fd55685dc9f00c0e2ba80733834b3fd20e04f654269ec2",
  AgentXProductionFoundation: "37cec1f7637591a8315345f8e5fe75bacf0f43e475e66837da41d805e743fd28",
  AgentXSlackOrchestrator: "545e3b68922c2d3b56fea735de57ba6bf3f879f02227ed3c9fc82fd274729230",
};
// The pins recorded just before RETAIN (code/next 0074f4139): holding after exactly the nine policies are put back is the proof RETAIN changed nothing else.
// The control plane's pin recorded just before CODE-PUBLIC-URL (code/next f70b51001, the RETAIN pin above): holding after exactly the public API URL additions are taken out is the proof it changed nothing else.
const BOUNDED_STACK_PINS_BEFORE_INVITATION_SWITCHES_DELETED: Record<string, string> = {
  AgentXControlPlane: "4a4191be7d18ca8264c8f00ee2fab1ae205c49d528b3605682572afdd6016cbd",
};
const BOUNDED_STACK_PINS_BEFORE_PUBLIC_API: Record<string, string> = {
  AgentXControlPlane: "087ce6ad0d8514cb9df45a0d030a7765ef82ded7c8b182a2982b7467a3e2a623",
};
const BOUNDED_STACK_PINS_BEFORE_RETAIN: Record<string, string> = {
  AgentXControlPlane: "04fde51d0885ae0c1394b2e936397a45bc316b73af78dbf20f4bb0d2d38d02bd",
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
        const beforeBatchF = withoutLinearWebhookRoute(withoutWebhookSecretLane(withoutBatchFAdditions(withoutLegacyRuntimeBoundary(withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(withoutApiAccessLog(withoutPublicApiUrl(withoutDispatcherLessonsPeople(withoutRetainPolicies(withoutMachineGone(withTaskPeopleInvitationSwitches(withoutCoreOutboxStreamRelay(withoutCanarySession(withoutInstallCompanyOutput(stack.stackName, normalizedTemplate(stack)))))))), { named: false, sites: PUBLIC_API_SITES })), LEGACY))))));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("2e4f4f9d632f856e9bf5cb127751c7dab7a7d328467e937585a93c6823022e79");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource). DEC 254zzz488: so is the Linear webhook route.
      const withCanary = stack.stackName === "AgentXControlPlane" ? withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(withoutInstallCompanyOutput(stack.stackName, normalizedTemplate(stack)), LEGACY)) : withoutInstallCompanyOutput(stack.stackName, normalizedTemplate(stack));
      // CANARY-SESSION (Rule D): the control plane's full pin with the canary session function in (its four empty placement parameters, condition, template rule, function, role policy, invoke permission, metric filters,
      // alarms, output and the token key's conditional deny list) is below; with exactly those taken out (withoutCanarySession, asserted field by field in tests/support/canary-session-template.ts) the machine-gone pin after it holds, and so does everything after that.
      if (stack.stackName === "AgentXControlPlane") expect(createHash("sha256").update(JSON.stringify(withCanary)).digest("hex"), "AgentXControlPlane with the canary session function").toBe("2ff78636f2deb8fad5bcb79d923d132b737a47817c1d61091c4cf7e62ee950d6");
      const withMachineGone = stack.stackName === "AgentXControlPlane" ? withoutCanarySession(structuredClone(withCanary)) : withCanary;
      // WORKER-DELIVERY-IDENTITY (2026-11-25), Rule D: the control plane's pin (the line above) is taken with the instance state-change handler, its rule and the dispatcher's one Describe statement
      // in; with exactly those taken out (withoutMachineGone, tests/support/machine-gone-template.ts, which asserts they are exactly that) the relay pin recorded before it (2606a006..., the full control plane with the outbox stream relay setting) holds, and with the relay setting out the Linear pin 0340c5f1... holds.
      // F1 L1a-1 (2026-11-25): that full pin moved too, for exactly the two deleted invitation parameters and their two packed settings (tu, tv). Rule D: with them put back (withTaskPeopleInvitationSwitches) the pin recorded
      // before it, 0716b42b..., holds (the second line).
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withMachineGone)).digest("hex"), "AgentXControlPlane with the Linear webhook route, the guard and the machine-gone additions").toBe("f81c8d5ab8ed00bdaedb3d1f43fc76ef29148af32ce1478c8c17f35e18fd8591");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(withMachineGone)))).digest("hex"), "with the machine-gone additions and the two deleted invitation switches put back").toBe("0716b42bfd6fdb8cdcf8f08f54032657c527f159f916d47a5799f63eb6265eb1");
      }
      const withRelay = stack.stackName === "AgentXControlPlane" ? withoutMachineGone(structuredClone(withMachineGone)) : withMachineGone;
      // CORE-RUN-STOP-RELAY (G1, 2026-11-25): the control plane's full pin with the packed `rl=on` (broker and dispatcher) in is below; Rule D: with exactly that taken out (withoutCoreOutboxStreamRelay,
      // tests/support/core-outbox-stream-relay-template.ts) the Linear pin after it holds, and so does everything after that.
      // F1 L1a-1 (2026-11-25): that full pin moved too, for exactly the two deleted invitation parameters and their two packed settings (tu, tv). Rule D: with them put back (withTaskPeopleInvitationSwitches) the pin recorded
      // before it, 2606a006..., holds (the second line).
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withRelay)).digest("hex"), "AgentXControlPlane with the outbox stream relay setting").toBe("842653869d5fd93b6b1c161276bfeb0cd0ee09ed1004e5314468eaa431659db6");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(withRelay)))).digest("hex"), "with the outbox stream relay setting and the two deleted invitation switches put back").toBe("2606a006280c84d75c9bbc878c9bea315792c5c33626c61a9b178bdcf26b99f0");
      }
      const withLinearWebhook = stack.stackName === "AgentXControlPlane" ? withoutCoreOutboxStreamRelay(structuredClone(withRelay)) : withRelay;
      // LINEAR-WEBHOOKS (DEC 254zzz488) + guard, rebased onto the public-URL pin (Rule D): the control plane's full pin with the Linear route, its throttle and its alarm in is below; with exactly those taken out
      // (withoutLinearWebhookRoute, asserted field by field in tests/support/linear-webhook-route-template.ts) the public-URL pin in BOUNDED_STACK_PINS holds, and so does everything after it.
      // F1 L1a-1 (2026-11-25): this full pin moved for exactly the deletion of the two dead invitation parameters and their two packed broker settings (tu, tv). Rule D: with them put back
      // (withTaskPeopleInvitationSwitches) the pin recorded before it, 0340c5f1..., holds.
      if (stack.stackName === "AgentXControlPlane") {
        expect(createHash("sha256").update(JSON.stringify(withLinearWebhook)).digest("hex"), "AgentXControlPlane with the Linear webhook route and guard").toBe("e874ce2f4ed44be6edd8da82b5caaa12e68d517f9367698e3852f5277855671c");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(withLinearWebhook))).digest("hex"), "with the two deleted invitation switches put back").toBe("0340c5f1f41022a993df114cb1d37ceb3b191e0975d32bbfc0bb4536cb4dd294");
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
      if (stack.stackName === "AgentXControlPlane") expect(createHash("sha256").update(JSON.stringify(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi))))).digest("hex"), "AgentXControlPlane minus only the dispatcher lessons people grant").toBe("e77bda1aed9a481802568f1c4d67eae73bdc1d7f85fff30d4af2220511b815cb");
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
        expect(createHash("sha256").update(JSON.stringify(withoutApiAccessLog(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi)))))).digest("hex"), "AgentXControlPlane minus only the access log").toBe("40082278dc51ffcdab47c7f0eb7a5aa25b06b0aac26ee1ce25fe855aad3fcc9c");
        const withoutBoundary = withoutLegacyRuntimeBoundary(beforeAccessLog);
        expect(createHash("sha256").update(JSON.stringify(withoutLegacyRuntimeBoundary(withoutApiAccessLog(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi))))))).digest("hex")).toBe("8251372761121b3cb0b56f8079181ea226cf0b58497cd452256dcbbbedff6855");
        // Webhook lane W3 adds the webhook secret slot, its throttle and one alarm (tests/support/webhook-secret-template.ts pins them); the historical snapshot is of the rest.
        expect(withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(withoutBoundary))).toMatchSnapshot();
      } else expect(withoutLegacyRuntimeBoundary(template)).toMatchSnapshot();
    }, 120_000);
  }
});
