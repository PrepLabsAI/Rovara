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
import { withoutDnsFirewall, withoutDnsFirewallAccess, withoutSwitchoverControlPlaneParity } from "../support/switchover-parity-template.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { withoutSlackCompanyMode, withoutSlackCompanyService } from "../support/slack-company-template.js";
import { createHash } from "node:crypto";
import { withoutBatchFAdditions } from "../support/batch-f-template.js";
import { withoutBrokerMemberConditionCheck } from "../support/broker-member-condition-check-template.js";
import { withoutWebhookSecretLane } from "../support/webhook-secret-template.js";
import { withoutStuckStoppingAlarm } from "../support/stuck-stopping-alarm-template.js";

skipLambdaBundling();
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
    TaskPeoplePublicInvitationsEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people may invite members to public channels in this environment",
      Type: "String",
    },
    TaskPeoplePrivateInvitationsEnabled: {
      AllowedValues: ["true", "false"],
      Default: "false",
      Description: "Whether task people may invite members to private channels in this environment",
      Type: "String",
    },
  };
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
    "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED",
    "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED",
  ];
  const brokerVariables = variablesFor(brokerFunctions[0]![1]);
  const expectedBrokerReferences = {
    AGENTX_TASK_PEOPLE_CHANGES_ENABLED: { Ref: "TaskPeopleChangesEnabled" },
    AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: { Ref: "TaskPeoplePublicInvitationsEnabled" },
    AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: { Ref: "TaskPeoplePrivateInvitationsEnabled" },
  };
  // ENV-ROOM: the named Broker gets them as pieces of AGENTX_SETTINGS (codes tc, tu, tv).
  const unpacked = unpackedBrokerVariables(brokerVariables);
  expect(Object.fromEntries(brokerEnvironmentNames.map((name) => [name, unpacked[name]]))).toStrictEqual(expectedBrokerReferences);
  for (const name of brokerEnvironmentNames) expect(brokerVariables).not.toHaveProperty(name);
  removePackedPieces(brokerVariables, "AGENTX_SETTINGS", ["tc", "tu", "tv"]);

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
    if (stack.stackName === "agentx-staging-control-plane") {
      it("removing only Batch F additions preserves code/next's agentx-staging-control-plane template", () => {
        const beforeBatchF = withoutWebhookSecretLane(withoutBatchFAdditions(withoutStuckStoppingAlarm(normalizedTemplate(stack), STAGING)));
        expect(createHash("sha256").update(JSON.stringify(beforeBatchF)).digest("hex")).toBe("8edf09fff29983cc3c3338a6b2d24bb27d061db29960bfa2e77a52c068618972");
      }, 120_000);
    }
    it(`${stack.stackName} is unchanged`, () => {
      // DEC 254zzz432: the alarm is taken out first, so every pin below holds as recorded (checked to be exactly one resource).
      let template = stack.stackName === "agentx-staging-control-plane" ? withoutStuckStoppingAlarm(normalizedTemplate(stack), STAGING) : normalizedTemplate(stack);
      // SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the new full synth
      // before the existing normalizers, then preserve every old policy/snapshot assertion.
      if (stack.stackName === "agentx-staging-control-plane") {
        expect(createHash("sha256").update(JSON.stringify(template)).digest("hex")).toBe("5b526b779a52869b09cb602a1d0a97545f10818f29983a879129dbf70553c745");
        // Webhook lane W3: the webhook secret slot, its throttle and one alarm, pinned exactly in tests/support/webhook-secret-template.ts, then removed.
        template = withoutWebhookSecretLane(withoutBrokerMemberConditionCheck(template));
      }
      const parity = stack.stackName === "agentx-staging-foundation" ? withoutNatEgressAddresses(withoutDnsFirewall(template))
        : stack.stackName === "agentx-staging-access" ? withoutSavedEnvAccess(withoutDnsFirewallAccess(template), "staging")
        // ENV-ROOM 2 (2026-11-17): the broker's names parameter is checked and the names put back in its environment first, as the rest was recorded.
        : stack.stackName === "agentx-staging-control-plane" ? withoutWorkerSandboxEgress(withoutNatEgressControlPlane(withoutGithubSignIn(withoutSwitchoverControlPlaneParity(withoutBrokerNamesParameter(withoutCompanyImportReads(withoutSlackCompanyMode(withoutChatGptKeyDeny(withoutBrokerSlackPoster(withoutSavedEnvSwitch(withoutSavedEnvImages(template, "staging")), "staging")))))), "staging")))
        : stack.stackName === "agentx-staging-slack" ? withoutSlackCompanyService(template) : template;
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutSigninAuditWriter(withoutCoreEngine(withoutHostedContextRoutes(withoutTaskPeopleControls(withoutStuckCancelAlarm(withoutUnwaitedTaskBackstop(withoutDispatchDeadLettersAlarm(parity))))))) : parity).toMatchSnapshot();
    }, 120_000);
  }
});
