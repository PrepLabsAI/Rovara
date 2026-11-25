// WORKER-DELIVERY-IDENTITY step 0 (ii) and (b-plus), as synthesized: the EventBridge rule on "EC2 Instance State-change Notification", the small function behind it, its least-privilege role, the dispatcher's
// one read-only EC2 statement, and (named environments) the deploy role's and its boundary's matching statement for exactly that rule.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { deployBoundaryStatements, serviceRoleStatements } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { INSTANCE_ENDED_STATES, INSTANCE_STATE_CHANGE_TABLE_ACTIONS, instanceStateChangeRuleName } from "../../infra/lib/instance-state-change.js";
import { SETUP_UNVERIFIED_METRIC } from "../../packages/broker/src/aws/machine-check-aws.js";
import { HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { ENDED_INSTANCE_STATES } from "../../packages/broker/src/aws/instance-state-change.js";
import { instanceStateChangeResources, withoutMachineGone } from "../support/machine-gone-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action?: string | string[]; Resource?: unknown; Condition?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
type Template_ = { Resources: Record<string, Resource> };

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
let named: Template_;
let legacy: Template_;
let access: Template_;

const stackJson = (app: ReturnType<typeof buildAgentXApp>, match: (stack: Stack) => boolean): Template_ =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && match(child))!).toJSON() as Template_;

beforeAll(() => {
  const namedApp = buildAgentXApp({ agentxEnv: "staging" });
  named = stackJson(namedApp, (stack) => stack.stackName === "agentx-staging-control-plane");
  access = stackJson(namedApp, (stack) => stack.stackName === "agentx-staging-access");
  legacy = stackJson(buildAgentXApp(), (stack) => stack.stackName === "AgentXControlPlane");
}, 240_000);

const policiesOf = (template: Template_, roleId: string): Statement[] => Object.values(template.Resources)
  .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles) === JSON.stringify([{ Ref: roleId }]))
  .flatMap((resource) => list((resource.Properties.PolicyDocument as { Statement: Statement | Statement[] }).Statement));
const roleIdOf = (template: Template_, prefix: RegExp): string => Object.keys(template.Resources).filter((id) => prefix.test(id) && template.Resources[id]!.Type === "AWS::IAM::Role")[0]!;

describe.each([["a named environment", () => named, "staging"], ["the legacy install", () => legacy, undefined]] as const)("the instance state-change handler in %s", (_name, template, env) => {
  it("is one EventBridge rule on EC2's state-change notification for the three states that end a worker, with the function as its one retrying target", () => {
    const ids = instanceStateChangeResources(structuredClone(template()));
    const rule = template().Resources[ids.rule]!;
    expect(rule.Properties).toMatchObject({
      EventPattern: { source: ["aws.ec2"], "detail-type": ["EC2 Instance State-change Notification"], detail: { state: ["stopping", "shutting-down", "terminated"] } },
      State: "ENABLED",
      Targets: [{ Arn: { "Fn::GetAtt": [ids.function, "Arn"] }, Id: "Target0", RetryPolicy: { MaximumRetryAttempts: 2 } }],
    });
    // The handler's own list and the rule's are the same three states.
    expect([...INSTANCE_ENDED_STATES]).toEqual([...ENDED_INSTANCE_STATES].sort((a, b) => ["stopping", "shutting-down", "terminated"].indexOf(a) - ["stopping", "shutting-down", "terminated"].indexOf(b)));
    expect(list((rule.Properties.EventPattern as { detail: { state: string[] } }).detail.state)).toEqual([...INSTANCE_ENDED_STATES]);
    // A named environment's rule has the fixed name its deploy role is limited to; the legacy install is deployed by an operator and takes a generated one.
    if (env === undefined) expect(rule.Properties.Name).toBeUndefined();
    else expect(rule.Properties.Name).toBe(instanceStateChangeRuleName(env));
  });

  it("lets only that rule invoke the function", () => {
    const ids = instanceStateChangeResources(structuredClone(template()));
    expect(template().Resources[ids.permission]!.Properties).toEqual({
      Action: "lambda:InvokeFunction", FunctionName: { "Fn::GetAtt": [ids.function, "Arn"] }, Principal: "events.amazonaws.com", SourceArn: { "Fn::GetAtt": [ids.rule, "Arn"] },
    });
  });

  it("gives the function the State table's reads and conditional writes and nothing else: no EC2, no Scan, no batch, no delete, no network", () => {
    const ids = instanceStateChangeResources(structuredClone(template()));
    const fn = template().Resources[ids.function]!;
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(fn.Properties.Runtime).toBe("nodejs22.x");
    const statements = policiesOf(template(), ids.role);
    const own = statements.filter((statement) => statement.Sid === "MarkLostSessions");
    expect(own).toHaveLength(1);
    expect(list(own[0]!.Action).sort()).toEqual([...INSTANCE_STATE_CHANGE_TABLE_ACTIONS].sort());
    expect(own[0]!.Effect).toBe("Allow");
    // The table and its indexes (the sparse session index), by ARN.
    const resources = list(own[0]!.Resource);
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources)).toContain("/index/*");
    expect(resources.every((resource) => resource !== "*")).toBe(true);
    for (const forbidden of ["ec2:", "dynamodb:Scan", "dynamodb:Batch", "dynamodb:DeleteItem", "dynamodb:*", "kms:", "secretsmanager:", "sqs:", "states:", "iam:", "lambda:"]) {
      expect(JSON.stringify(statements), forbidden).not.toContain(forbidden);
    }
    // The only wildcard resource is CDK's X-Ray tracing statement.
    expect(statements.filter((statement) => JSON.stringify(statement.Resource) === '"*"').flatMap((statement) => list(statement.Action)).every((action) => action.startsWith("xray:"))).toBe(true);
  });

  it("reports a setup delivery that could not be verified: the dispatcher's log metric, read by one alarm the health probe lists (WDI-SETUP)", () => {
    const alarms = Object.entries(template().Resources).filter(([id, resource]) => resource.Type === "AWS::CloudWatch::Alarm" && /^SessionsSetupMachineUnverifiedAlarm/u.test(id));
    expect(alarms).toHaveLength(1);
    const properties = alarms[0]![1].Properties;
    expect(properties).toMatchObject({ MetricName: SETUP_UNVERIFIED_METRIC, Statistic: "Sum", Period: 900, Threshold: 1, TreatMissingData: "notBreaching" });
    // The dispatcher is told the namespace the alarm reads (the metric is written by its own log line).
    const dispatcher = Object.values(template().Resources).find((resource) => resource.Type === "AWS::Lambda::Function" && JSON.stringify(resource.Properties).includes("AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID"))!;
    const variables = (dispatcher.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables["AGENTX_METRICS_NAMESPACE"]).toBe(properties.Namespace);
    expect(HEALTH_ALARM_SUFFIXES).toContain("SetupMachineUnverified");
    expect(String(properties.AlarmName)).toMatch(/SetupMachineUnverified$/u);
  });

  it("gives the dispatcher exactly one EC2 permission: Describe, read-only, on * (EC2 cannot scope it), and no terminate, run or tag", () => {
    const role = roleIdOf(template(), /^DispatcherServiceRole[0-9A-F]{8}$/u);
    const statements = policiesOf(template(), role);
    const ec2 = statements.filter((statement) => list(statement.Action).some((action) => action.startsWith("ec2:")));
    expect(ec2).toEqual([{ Sid: "VerifyWorkerMachine", Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*" }]);
    // And with the addition taken out the dispatcher holds no EC2 permission at all, as before the lane (the check is the whole of it).
    const without = withoutMachineGone(structuredClone(template()));
    expect(JSON.stringify(policiesOf(without, role))).not.toContain("ec2:");
  });
});

describe("the deploy role of a named environment", () => {
  const scope = (env: string) => ({ env, partition: "aws", region: "us-east-1", account: "111122223333", artifactBucketArn: "arn:aws:s3:::agentx-artifacts", pullThroughPrefix: "agentx", cloudFormationRoleName: `agentx-${env}-cloudformation` });
  const globOf = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`, "u");

  it.each(["staging", "headroom-longest-env", "a"])("may create the rule in %s with no change to the access stack: its name falls under the one EventBridge pattern the service role and the deploy boundary already allow", (env) => {
    const name = instanceStateChangeRuleName(env);
    expect(name.length).toBeLessThanOrEqual(64);
    const arn = `arn:aws:events:us-east-1:111122223333:rule/${name}`;
    for (const statements of [serviceRoleStatements(scope(env)), deployBoundaryStatements(scope(env))]) {
      const withEvents = statements.filter((statement) => statement.Effect === "Allow" && statement.Action.some((action) => action.startsWith("events:")));
      // Still only the one existing statement: no new EventBridge grant anywhere.
      expect(withEvents.map((statement) => statement.Sid)).toEqual(["EcsFailureEventsRule"]);
      expect(arn).toMatch(globOf(withEvents[0]!.Resource as string));
    }
  });

  it("does not widen what the rule pattern allows: another rule of the environment, or of another environment, is still outside it", () => {
    const pattern = globOf(serviceRoleStatements(scope("staging")).find((statement) => statement.Sid === "EcsFailureEventsRule")!.Resource as string);
    expect("arn:aws:events:us-east-1:111122223333:rule/agentx-staging-other").not.toMatch(pattern);
    expect(`arn:aws:events:us-east-1:111122223333:rule/${instanceStateChangeRuleName("other")}`).not.toMatch(pattern);
  });

  it("leaves the access stack's template as it was (the rule's name is the whole of the deploy-side change)", () => {
    expect(JSON.stringify(access)).not.toContain("worker-instance");
  });
});
