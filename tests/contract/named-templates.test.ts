import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { withoutCoreEngine } from "../support/core-engine-template.js";
import { removePackedPieces, unpackedBrokerVariables, withoutBrokerNamesParameter } from "../support/broker-environment-template.js";
import { withoutBrokerSlackPoster } from "../support/broker-slack-poster-template.js";
import { withoutSavedEnvAccess, withoutSavedEnvImages } from "../support/saved-env-images-template.js";
import { withoutSavedEnvSwitch } from "../support/saved-env-switch-template.js";
import { withoutChatGptKeyDeny } from "../support/chatgpt-key-deny-template.js";
import { withoutWorkerSandboxEgress } from "../support/worker-sandbox-egress-template.js";
import { withoutCompanyImportReads } from "../support/company-import-reads-template.js";
import { withoutNatEgressAddresses, withoutNatEgressControlPlane } from "../support/egress-addresses-template.js";
import { withoutGithubSignIn } from "../support/github-signin-template.js";
import { withoutDnsFirewall, withoutDnsFirewallAccess, withoutGatewayAccess, withoutSwitchoverControlPlaneParity } from "../support/switchover-parity-template.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { withoutSlackCompanyMode, withoutSlackCompanyService } from "../support/slack-company-template.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";
import { withoutWebhookSecretLane } from "../support/webhook-secret-template.js";
import { withoutLinearWebhookGuard } from "../support/linear-webhook-route-template.js";
import { withoutStuckStoppingAlarm } from "../support/stuck-stopping-alarm-template.js";
import { withoutApiAccessLog } from "../support/api-access-log-template.js";
import { withoutDispatcherLessonsPeople } from "../support/dispatcher-lessons-people-template.js";
import { withoutMachineGone } from "../support/machine-gone-template.js";
import { withoutRetainPolicies } from "../support/retain-policies-template.js";
import { withoutWorkerCallbackAlarm } from "../support/worker-callback-alarm-template.js";
import { withoutPublicApiAllowDomain, withoutPublicApiUrl } from "../support/public-api-url-template.js";
import { withoutCoreOutboxStreamRelay } from "../support/core-outbox-stream-relay-template.js";
import { withTaskPeopleInvitationSwitches } from "../support/task-people-invitations-template.js";
import { withoutCognitoWriteAttributes } from "../support/cognito-write-attributes-template.js";

skipLambdaBundling();
// CODE-PUBLIC-URL (2026-11-24): the named control plane's external URL bases that now go through the public address helper (the sign-in issuer and its two function variables, CONTROL_PLANE_URL for the notifier,
// the session steps and the broker, the channel adapters' variables, and the outputs an operator copies), counted so a URL that bypasses the helper moves it.
const PUBLIC_API_SITES = 23;
const STAGING = { alarmName: "agentx-staging-SessionStuckStopping", namespace: "AgentX/staging", env: "staging" };

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string };

/**
 * Issue 46 adds one resource to a named control plane, and nothing else: the dispatch
 * dead-letter alarm. It is checked here to be exactly this, then taken out, so the rest of the
 * template must still match the recorded snapshot.
 */
function withoutDispatchDeadLettersAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const alarms = Object.keys(resources).filter((id) => id.startsWith("DispatchDeadLettersAlarm"));
  expect(alarms).toHaveLength(1);
  const queueId = Object.keys(resources).find((id) => id.startsWith("DispatchDeadLetterQueue") && resources[id]!.Type === "AWS::SQS::Queue");
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(queueId).toBeDefined();
  expect(topicId).toBeDefined();
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "A worker dispatch job exhausted its receives and is in the dispatch dead-letter queue. Check the dispatcher logs for its operation ID, then redrive or purge the queue.",
      AlarmName: "agentx-staging-DispatchDeadLetters",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      EvaluationPeriods: 1,
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      Period: 300,
      Statistic: "Maximum",
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Issue 173 adds the reconciler backstop to a named control plane, and nothing else: three
 * environment variables, two statements and one alarm. Each is checked strictly to be exactly
 * this, then taken out, so the rest of the template must still match the recorded snapshot.
 */
function withoutUnwaitedTaskBackstop(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const reconcilerEntry = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function");
  expect(reconcilerEntry).toBeDefined();
  const reconciler = reconcilerEntry![1];
  const variables = (reconciler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const threadsId = Object.keys(resources).find((id) => id.startsWith("SlackThreads") && resources[id]!.Type === "AWS::DynamoDB::Table")!;
  const slackSecretId = Object.keys(resources).find((id) => id.startsWith("SlackSecret") && resources[id]!.Type === "AWS::SecretsManager::Secret")!;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(threadsId).toBeDefined();
  expect(slackSecretId).toBeDefined();
  expect(topicId).toBeDefined();
  const added = { SLACK_THREADS_TABLE_NAME: { Ref: threadsId }, SLACK_SECRET_ARN: { Ref: slackSecretId }, CALLBACK_SIGNING_KEY_SECRET_ID: "agentx/staging/callback-key" };
  expect(Object.fromEntries(Object.keys(added).map((name) => [name, variables[name]]))).toStrictEqual(added);
  for (const name of Object.keys(added)) delete variables[name];
  const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const policies = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy"
    && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId));
  const sids = new Set(["ReadThreadWaiters", "PostUnwaitedTaskNote"]);
  const removed: Statement[] = [];
  for (const policy of policies) {
    const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
    removed.push(...document.Statement.filter((statement) => sids.has(statement.Sid ?? "")));
    document.Statement = document.Statement.filter((statement) => !sids.has(statement.Sid ?? ""));
  }
  expect(removed).toStrictEqual([
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "activeTurn"] },
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        Null: { "dynamodb:Attributes": "false" },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [threadsId, "Arn"] },
      Sid: "ReadThreadWaiters",
    },
    { Action: "secretsmanager:GetSecretValue", Effect: "Allow", Resource: { Ref: slackSecretId }, Sid: "PostUnwaitedTaskNote" },
  ]);
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsUnwaitedTaskFailuresAlarm"));
  expect(alarms).toHaveLength(1);
  const failures = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 600, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler could not check or cancel Slack tasks idle over 24 hours with nobody waiting, on two runs in a row. Check the reconciler's logs for unwaited_task.cancel_failed, unwaited_task.read_failed and reconciler.unwaited_task_sweep_failed.",
      AlarmName: "agentx-staging-UnwaitedTaskFailures",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 2,
      Metrics: [
        { Expression: "FILL(cancels, 0) + FILL(reads, 0)", Id: "expr_1", Label: "Unwaited task cancel and read failures", ReturnData: true },
        failures("cancels", "ReconcilerUnwaitedTaskFailures"),
        failures("reads", "ReconcilerUnwaitedTaskReadFailures"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Issue 195 adds the StuckCancels alarm to a named control plane, and nothing else: its retry runs in
 * the reconciler's own process with #173's signing key, so no grant and no environment variable. The
 * alarm is checked here to be exactly this, then taken out, so the rest of the template must still
 * match the recorded snapshot.
 */
function withoutStuckCancelAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(topicId).toBeDefined();
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsStuckCancelsAlarm"));
  expect(alarms).toHaveLength(1);
  const stat = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 900, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler found a task whose cancel never reached its worker, and queued the cancel again or ended the task (or failed to). Check the reconciler's logs for stuck_cancel events: a retried cancel that finishes, or an ended task, needs no action; repeated ones point at a dispatch or worker fault.",
      AlarmName: "agentx-staging-StuckCancels",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      Metrics: [
        { Expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0) + FILL(unretried, 0)", Id: "expr_1", Label: "Stuck cancels retried, ended, failed or unretried", ReturnData: true },
        stat("retries", "ReconcilerStuckCancelRetries"),
        stat("ended", "ReconcilerStuckCancelsEnded"),
        stat("interrupted", "ReconcilerStuckCancelsInterrupted"),
        stat("failures", "ReconcilerStuckCancelFailures"),
        stat("unretried", "ReconcilerStuckCancelsUnretried"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Task People adds three false-default controls and passes their exact references to the Broker
 * and DeveloperTaskNotifier. Verify those additions in full, remove only them, and keep the rest
 * of the named-environment snapshot comparison strict.
 */
function withoutTaskPeopleControls(template: unknown): unknown {
  const synthesized = template as {
    Parameters: Record<string, unknown>;
    Resources: Record<string, Resource>;
  };
  const parameters = synthesized.Parameters;
  const expectedParameters = {
    TaskPeopleChangesEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people role changes are enabled in this environment",
      Type: "String",
    },
  };
  // F1 L1a-1 deleted the two invitation switches: the template declares neither (and so packs neither).
  expect(parameters).not.toHaveProperty("TaskPeoplePublicInvitationsEnabled");
  expect(parameters).not.toHaveProperty("TaskPeoplePrivateInvitationsEnabled");
  for (const [name, expected] of Object.entries(expectedParameters)) {
    expect(parameters[name]).toStrictEqual(expected);
    delete parameters[name];
  }

  const functions = Object.entries(synthesized.Resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
  const variablesFor = (resource: Resource): Record<string, unknown> =>
    (resource.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const brokerFunctions = functions.filter(([id]) => id.startsWith("Broker"));
  expect(brokerFunctions).toHaveLength(1);
  const brokerEnvironmentNames = [
    "AGENTX_TASK_PEOPLE_CHANGES_ENABLED",
  ];
  const brokerVariables = variablesFor(brokerFunctions[0]![1]);
  const expectedBrokerReferences = {
    AGENTX_TASK_PEOPLE_CHANGES_ENABLED: { Ref: "TaskPeopleChangesEnabled" },
  };
  // ENV-ROOM: the named Broker gets it as a piece of AGENTX_SETTINGS (code tc; the two invitation switches' codes tu and tv are retired).
  const unpacked = unpackedBrokerVariables(brokerVariables);
  expect(Object.fromEntries(brokerEnvironmentNames.map((name) => [name, unpacked[name]]))).toStrictEqual(expectedBrokerReferences);
  for (const name of brokerEnvironmentNames) expect(brokerVariables).not.toHaveProperty(name);
  removePackedPieces(brokerVariables, "AGENTX_SETTINGS", ["tc"]);
  expect(JSON.stringify(brokerVariables.AGENTX_SETTINGS)).not.toMatch(/"t[uv]="/u);

  const notifierFunctions = functions.filter(([id]) => id.startsWith("DeveloperTaskNotifier"));
  expect(notifierFunctions).toHaveLength(1);
  const notifierVariables = variablesFor(notifierFunctions[0]![1]);
  expect(notifierVariables.AGENTX_TASK_PEOPLE_CHANGES_ENABLED).toStrictEqual({ Ref: "TaskPeopleChangesEnabled" });
  delete notifierVariables.AGENTX_TASK_PEOPLE_CHANGES_ENABLED;
  return template;
}

function withoutHostedContextRoutes(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const model = resources.ModelAccessRoute!;
  for (const [id, path] of [["ContextToolsListRoute", "/v1/internal/context-tools"], ["DesignReviewPacketRoute", "/v1/internal/design-review/packet"]]) {
    expect(resources[id!]).toStrictEqual({ ...model, Properties: { ...model.Properties, RouteKey: `GET ${path}` } });
    expect(resources[id!]!.Properties.AuthorizationType).toBe("NONE");
    expect(resources[id!]!.Properties).not.toHaveProperty("AuthorizerId");
    delete resources[id!];
  }
  return template;
}

// SIGNIN-AUDIT (#1188, DEC 254zzz202): the sign-in role's one conditional State PutItem on the AUDIT key family, checked exactly and taken out.
function withoutSigninAuditWriter(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const found: Array<{ statements: unknown[]; at: number }> = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const statements = ((resource.Properties.PolicyDocument as { Statement: unknown[] }).Statement);
    statements.forEach((statement, at) => {
      const s = statement as { Action?: unknown; Condition?: unknown };
      if (s.Action === "dynamodb:PutItem" && JSON.stringify(s.Condition ?? {}).includes("#AUDIT")) found.push({ statements, at });
    });
  }
  expect(found).toHaveLength(1);
  const { statements, at } = found[0]!;
  expect(statements[at]).toStrictEqual({
    Action: "dynamodb:PutItem",
    Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#AUDIT"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    Effect: "Allow",
    Resource: { "Fn::GetAtt": [expect.stringMatching(/^State[0-9A-F]{8}$/u), "Arn"] },
  });
  statements.splice(at, 1);
  return template;
}

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 4a605fd (re-recorded there when mainline merged in), so a named environment's templates must stay
// as they were, apart from issue 46's dispatch dead-letter alarm, issue 173's reconciler backstop,
// issue 195's stuck-cancel alarm, the false-default Task People controls and the staging switch-over parity additions (DNS firewall, evidence expiry, broker
// names; tests/support/switchover-parity-template.ts), each checked and taken out.
// Batch F adds only Outputs.ModelRunPriceVersion; the invariant below retains code/next's full pin.
// The separate proof removes it; existing snapshots retain the capability output.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  it("pins L1a's broker core dispatch queue references", () => {
    const stack = stacks.find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
    const template = normalizedTemplate(stack) as { Resources: Record<string, Resource> };
    const broker = Object.entries(template.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")![1];
    const variables = (broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect({ CORE_DISPATCH_QUEUE_URL: variables.CORE_DISPATCH_QUEUE_URL, CORE_DISPATCH_DEAD_LETTER_URL: variables.CORE_DISPATCH_DEAD_LETTER_URL }).toMatchSnapshot();
  });
  for (const stack of stacks) {
    // Issue #1554: agentx-staging-gateway is a new self-hosted stack tested by self-hosted-model-gateway.test.ts (not in mainline 4a605fd).
    if (stack.stackName === "agentx-staging-gateway") continue;
    if (stack.stackName === "agentx-staging-control-plane") {
      it("removing only Batch F additions preserves code/next's agentx-staging-control-plane template", () => {
        // F1 L1a-1: the two deleted invitation switches are put back innermost (Rule D, tests/support/task-people-invitations-template.ts), so this older pin holds as recorded.
        // Linear webhook guard: the Linear route's throttle and alarm are asserted and taken out too (outermost), so this recorded pin still holds.
        const beforeBatchF = withoutLinearWebhookGuard(withoutWebhookSecretLane(withoutBatchFAdditions(withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(withoutApiAccessLog(withoutPublicApiUrl(withoutDispatcherLessonsPeople(withoutRetainPolicies(withoutMachineGone(withTaskPeopleInvitationSwitches(withoutCoreOutboxStreamRelay(normalizedTemplate(stack)))), "named")), { named: true, sites: PUBLIC_API_SITES }), { env: "staging" }), STAGING)))));
        // D1-2 (declared change set, D1-PLAN section 8, rebased onto train 90): every pin below moved for exactly the removal of the three recovery Schedules, the two Scheduler roles and their policies (and, in the named template, the PlanEvidence function, its log group, role and policy); the removed resources were in every older state these pins describe.
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("e9e3bb2f879909dcac49c02f22a5d668625f55b052d54c121cb67fd83301d17c");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource).
      let template = stack.stackName === "agentx-staging-control-plane" ? withoutWorkerCallbackAlarm(withoutStuckStoppingAlarm(normalizedTemplate(stack), STAGING)) : normalizedTemplate(stack);
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new full synth
      // before the existing normalizers, then preserve every old policy/snapshot assertion.
      if (stack.stackName === "agentx-staging-control-plane") {
        // APIGW-ACCESS-LOGS (2026-11-24): re-pinned for exactly the access log group and the `$default` stage AccessLogSettings. Rule D: with those two taken out the old pin
        // 743944b8bdce7b8b477f0996164b304b1fae4573c1c5ee853689f334092a8dc0 holds (checked on the next line).
        // LESSONS-PORT-FIX (DEC 254zzz473, rebased onto train 29 without turn-on): re-pinned for exactly the dispatcher's DEVELOPER_SIGNIN_TABLE_NAME variable and its DispatcherLessonsPeople policy. Rule D: with those
        // taken out (withoutDispatcherLessonsPeople) train 29's pin fd51c6081b26c4f8401cfa4b4a69c58d8bfa588000856cd4387cd9f753f64ff3 holds (checked on the next line).
        // CODE-PUBLIC-URL (2026-11-24): re-pinned for exactly the PublicApiUrl parameter and condition, each external URL base becoming Fn::If [HasPublicApiUrl, PublicApiUrl, the API's own host] (resolved equal while
        // the parameter is empty), the broker's packed public host and the new LinearWebhookUrl output. Rule D: with those taken out (withoutPublicApiUrl, tests/support/public-api-url-template.ts) lessons-port's and RETAIN's
        // pins below hold as recorded (checked on the lines after the next).
        // LINEAR-WEBHOOK-GUARD (2026-11-24, rebased onto the public-URL pin): re-pinned for exactly the Linear route's stage throttle (one RouteSettings entry), its stage dependency and one alarm. Rule D: with those
        // taken out (withoutLinearWebhookGuard, asserted field by field in tests/support/linear-webhook-route-template.ts) the public-URL pin 74e8f0a3e94b69a322a78fb6c1c4e2952689f71f5af7c5bc6c0da4b4e9a38a69 holds (checked on the lines after the next).
        // WORKER-DELIVERY-IDENTITY (2026-11-25, rebased onto the relay pin): re-pinned for exactly the instance state-change handler, its rule and the dispatcher's one Describe statement (outermost). Rule D: with those
        // taken out (withoutMachineGone, tests/support/machine-gone-template.ts) the relay pin 2402650b841b5fcbf04e0d3a24922cb97d2315b2554f02c9aa42b01298a97b97 holds as recorded (checked on the next lines).
        // F1 L1a-1 (2026-11-25): this full pin moved for exactly the deletion of the two dead invitation parameters and their two packed broker settings (tu, tv). Rule D: with those put back (withTaskPeopleInvitationSwitches) the pin recorded before, d4df1277..., holds (the second line).
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("be33e14984e423bf2007645d56a4e48de716a5c5c044bdde97f7e6df40ca6f83");
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(template)))).digest("hex"), "with the two deleted invitation switches put back").toBe("4ce732d7e2bd3292b0acac25f705b329049cc1453d36f496ecca383e7874a3cb");
        const withRelayOnly = withoutMachineGone(structuredClone(template));
        expect(createHash("sha256").update(JSON.stringify(withRelayOnly)).digest("hex"), "minus only the machine-gone additions, without the two deleted invitation switches").toBe("c15a53ce0434707844443041c8fc18ca1ff29a0b6293cb925f598b5fc3ded87b");
        // CORE-RUN-STOP-RELAY (G1, 2026-11-25): re-pinned for exactly the packed setting `rl=on` on the broker and the dispatcher. Rule D: with it taken out (withoutCoreOutboxStreamRelay,
        // tests/support/core-outbox-stream-relay-template.ts) the Linear guard pin 87099caf363dc23f4f027639bbe2dd925bcde8ca85b9b3cfb0dc984051058e96 holds (checked on the next lines).
        // F1 L1a-1 (2026-11-25): re-pinned again for exactly the deletion of the two dead invitation parameters and their two packed broker settings (tu, tv). Rule D: with those put back
        // (withTaskPeopleInvitationSwitches) the previous pin 2402650b841b5fcbf04e0d3a24922cb97d2315b2554f02c9aa42b01298a97b97 holds (the second line), with the relay taken out too the pin 830e2fa7... holds, and so does every older pin below.
        expect(createHash("sha256").update(JSON.stringify(withTaskPeopleInvitationSwitches(structuredClone(withRelayOnly)))).digest("hex"), "with the two deleted invitation switches put back").toBe("2402650b841b5fcbf04e0d3a24922cb97d2315b2554f02c9aa42b01298a97b97");
        const beforeRelay = withTaskPeopleInvitationSwitches(withoutCoreOutboxStreamRelay(structuredClone(withRelayOnly)));
        expect(createHash("sha256").update(JSON.stringify(beforeRelay)).digest("hex"), "minus only the outbox stream relay setting").toBe("87099caf363dc23f4f027639bbe2dd925bcde8ca85b9b3cfb0dc984051058e96");
        const withoutGuard = withoutLinearWebhookGuard(structuredClone(beforeRelay));
        expect(createHash("sha256").update(JSON.stringify(withoutGuard)).digest("hex"), "minus only the Linear webhook guard").toBe("bea7d88fa4bc83e994ace89f62b629af5c8151b8393cd1d39f2779ecfe185ce1");
        const beforePublicApi = withoutPublicApiUrl(structuredClone(withoutGuard), { named: true, sites: PUBLIC_API_SITES });
        expect(createHash("sha256").update(JSON.stringify(beforePublicApi)).digest("hex"), "minus only the public API URL").toBe("895ce94bc8367a889b891392cede18d1d5aed0adac123f8f93b6d63d84eb4906");
        // RETAIN (arch ruling 2026-11-24): re-pinned for exactly DeletionPolicy RetainExceptOnCreate and UpdateReplacePolicy Retain on the control plane's five keys, channel state table and adapter secret.
        // Rule D: with those put back (withoutRetainPolicies) lessons-port's pin 84cf00fb44b4dd7506c666288d3c2ae1a03308c0c9353518f474bc246f8847fa holds (checked on the next line).
        expect(createHash("sha256").update(JSON.stringify(withoutRetainPolicies(structuredClone(beforePublicApi), "named"))).digest("hex"), "minus only the RETAIN policies").toBe("84cf00fb44b4dd7506c666288d3c2ae1a03308c0c9353518f474bc246f8847fa");
        expect(createHash("sha256").update(JSON.stringify(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi), "named")))).digest("hex"), "minus only the dispatcher lessons people grant").toBe("fd51c6081b26c4f8401cfa4b4a69c58d8bfa588000856cd4387cd9f753f64ff3");
        expect(createHash("sha256").update(JSON.stringify(withoutApiAccessLog(withoutDispatcherLessonsPeople(withoutRetainPolicies(structuredClone(beforePublicApi), "named")), { env: "staging" }))).digest("hex"), "minus only the access log").toBe("743944b8bdce7b8b477f0996164b304b1fae4573c1c5ee853689f334092a8dc0");
        // Webhook lane W3: the webhook secret slot, its throttle and one alarm, pinned exactly in tests/support/webhook-secret-template.ts, then removed.
        // APIGW-ACCESS-LOGS (2026-11-24): the full-template pin above moved; the access log group and the stage setting are asserted and taken out, so every pin and snapshot below still holds.
        // F1 L1a-1: the snapshot below is of the template as it is now, without the two deleted invitation switches (the strippers after this read the broker's packed settings with today's table), so the
        // same strippers (the machine-gone additions and the relay setting out first, as on code/next) are applied to `template` itself rather than to the put-back copy the pins above were taken from.
        const currentBeforePublicApi = withoutPublicApiUrl(structuredClone(withoutLinearWebhookGuard(withoutCoreOutboxStreamRelay(structuredClone(withRelayOnly)))), { named: true, sites: PUBLIC_API_SITES });
        template = withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(withoutApiAccessLog(withoutDispatcherLessonsPeople(currentBeforePublicApi), { env: "staging" })));
      }
      // COGNITO-WRITE-ATTRIBUTES (2026-11-25): the identity stack's client WriteAttributes and the pool's UserAttributeUpdateSettings are asserted exactly and taken out, so the recorded snapshot holds.
      if (stack.stackName === "agentx-staging-identity") template = withoutCognitoWriteAttributes(structuredClone(template));
      // CODE-PUBLIC-URL (rev 9.2): the foundation's firewall gains one allow-list entry (and its parameter); taken out, the recorded snapshot holds.
      if (stack.stackName === "agentx-staging-foundation") template = withoutPublicApiAllowDomain(structuredClone(template));
      const parity = stack.stackName === "agentx-staging-foundation" ? withoutNatEgressAddresses(withoutDnsFirewall(template))
        : stack.stackName === "agentx-staging-access" ? withoutSavedEnvAccess(withoutDnsFirewallAccess(withoutGatewayAccess(template, "staging")), "staging")
        // ENV-ROOM 2 (2026-11-17): the broker's names parameter is checked and the names put back in its environment first, as the rest was recorded.
        : stack.stackName === "agentx-staging-control-plane" ? withoutWorkerSandboxEgress(withoutNatEgressControlPlane(withoutGithubSignIn(withoutSwitchoverControlPlaneParity(withoutBrokerNamesParameter(withoutCompanyImportReads(withoutSlackCompanyMode(withoutChatGptKeyDeny(withoutBrokerSlackPoster(withoutSavedEnvSwitch(withoutSavedEnvImages(template, "staging")), "staging")))))), "staging")))
        : stack.stackName === "agentx-staging-slack" ? withoutSlackCompanyService(template) : template;
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutSigninAuditWriter(withoutCoreEngine(withoutHostedContextRoutes(withoutTaskPeopleControls(withoutStuckCancelAlarm(withoutUnwaitedTaskBackstop(withoutDispatchDeadLettersAlarm(parity))))))) : parity).toMatchSnapshot();
    }, 120_000);
  }
});
