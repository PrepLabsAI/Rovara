// Issue 173: the reconciler backstop's grants are exact (invoke the broker, read the Slack secret),
// and they, its environment and its alarm exist only in named environments. The legacy templates
// are proven byte-identical by legacy-templates.test.ts.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Role: { "Fn::GetAtt": [string, string] }; Environment?: { Variables?: Record<string, unknown> } } };
type Alarm = { Properties: { AlarmName?: unknown; Period?: number; Statistic?: string; ComparisonOperator?: string; TreatMissingData?: string; MetricName?: string; Namespace?: string; EvaluationPeriods?: number; Threshold?: number; AlarmActions?: unknown[] } };

function reconciler(template: Template) {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const [, fn] = functions.find(([id]) => id.startsWith("SessionsReconciler"))!;
  const roleId = fn.Properties.Role["Fn::GetAtt"][0];
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  return { environment: fn.Properties.Environment?.Variables ?? {}, statements };
}
const brokerId = (template: Template) => Object.keys(template.findResources("AWS::Lambda::Function")).find((id) => /^Broker[0-9A-F]{8}$/.test(id))!;
const slackSecretId = (template: Template) => Object.keys(template.findResources("AWS::SecretsManager::Secret")).find((id) => id.startsWith("SlackSecret"))!;
const actionsOf = (statements: Statement[]) => statements.flatMap((statement) => [statement.Action].flat());
const backstopAlarms = (template: Template) => (Object.values(template.findResources("AWS::CloudWatch::Alarm")) as Alarm[])
  .filter((alarm) => alarm.Properties.MetricName === "ReconcilerUnwaitedTaskFailures");

describe("the unwaited task backstop's infrastructure (#173)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "UnwaitedControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "UnwaitedLegacyControlPlane"));

  it("lets the named reconciler invoke the broker function alone, and nothing else", () => {
    const { statements } = reconciler(named);
    const invoke = statements.filter((statement) => actionsOf([statement]).some((action) => action.startsWith("lambda:")));
    expect(invoke).toEqual([{ Sid: "StopUnwaitedTasks", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [brokerId(named), "Arn"] } }]);
  });

  it("lets the named reconciler read the Slack secret alone, for the bot token, and nothing else", () => {
    const { statements } = reconciler(named);
    const secrets = statements.filter((statement) => actionsOf([statement]).some((action) => action.startsWith("secretsmanager:")));
    expect(secrets).toEqual([{ Sid: "PostUnwaitedTaskNote", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: slackSecretId(named) } }]);
  });

  it("names the broker and the Slack secret to the named reconciler", () => {
    expect(reconciler(named).environment).toMatchObject({
      BROKER_FUNCTION_NAME: { Ref: brokerId(named) },
      SLACK_SECRET_ARN: { Ref: slackSecretId(named) },
    });
  });

  it("alarms the operator when cancels keep failing on two runs in a row", () => {
    const alarms = backstopAlarms(named);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.Properties).toMatchObject({
      AlarmName: "agentx-staging-UnwaitedTaskFailures", Namespace: "AgentX/staging", EvaluationPeriods: 2, Threshold: 1,
      Period: 600, Statistic: "Maximum", ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    });
    expect(alarms[0]!.Properties.AlarmActions).toHaveLength(1);
  });

  it("adds none of it to the legacy deployment", () => {
    const { environment, statements } = reconciler(legacy);
    expect(environment).not.toHaveProperty("BROKER_FUNCTION_NAME");
    expect(environment).not.toHaveProperty("SLACK_SECRET_ARN");
    expect(actionsOf(statements).filter((action) => action.startsWith("lambda:") || action.startsWith("secretsmanager:"))).toEqual([]);
    expect(backstopAlarms(legacy)).toEqual([]);
  });
});
