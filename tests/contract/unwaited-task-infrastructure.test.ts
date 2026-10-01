// Issue 173: the reconciler backstop's grants are exact (read thread waiters, read the Slack secret),
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
type Alarm = { Properties: { Metrics?: Array<{ Id: string; Expression?: string; MetricStat?: { Metric: { MetricName: string; Namespace: string }; Period: number; Stat: string } }>; AlarmName?: unknown; Period?: number; Statistic?: string; ComparisonOperator?: string; TreatMissingData?: string; MetricName?: string; Namespace?: string; EvaluationPeriods?: number; Threshold?: number; AlarmActions?: unknown[] } };

function reconciler(template: Template) {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const [, fn] = functions.find(([id]) => id.startsWith("SessionsReconciler"))!;
  const roleId = fn.Properties.Role["Fn::GetAtt"][0];
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  return { environment: fn.Properties.Environment?.Variables ?? {}, statements };
}
const threadsTableId = (template: Template) => Object.keys(template.findResources("AWS::DynamoDB::Table")).find((id) => id.startsWith("SlackThreads"))!;
const slackSecretId = (template: Template) => Object.keys(template.findResources("AWS::SecretsManager::Secret")).find((id) => id.startsWith("SlackSecret"))!;
const actionsOf = (statements: Statement[]) => statements.flatMap((statement) => [statement.Action].flat());
const backstopAlarms = (template: Template) => (Object.values(template.findResources("AWS::CloudWatch::Alarm")) as Alarm[])
  .filter((alarm) => alarm.Properties.AlarmName === "agentx-staging-UnwaitedTaskFailures" || JSON.stringify(alarm.Properties).includes("ReconcilerUnwaitedTask"));

describe("the unwaited task backstop's infrastructure (#173)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "UnwaitedControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "UnwaitedLegacyControlPlane"));

  it("never lets the reconciler invoke the broker: the backstop cancels inside the reconciler", () => {
    for (const template of [named, legacy]) {
      expect(actionsOf(reconciler(template).statements).filter((action) => action.startsWith("lambda:"))).toEqual([]);
      expect(reconciler(template).environment).not.toHaveProperty("BROKER_FUNCTION_NAME");
    }
  });

  it("lets the named reconciler read only the activeTurn of THREAD# items in the Slack threads table, by key", () => {
    const { statements } = reconciler(named);
    const threads = statements.filter((statement) => JSON.stringify(statement.Resource).includes(threadsTableId(named)));
    expect(threads).toEqual([{
      Sid: "ReadThreadWaiters", Effect: "Allow", Action: "dynamodb:GetItem", Resource: { "Fn::GetAtt": [threadsTableId(named), "Arn"] },
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "activeTurn"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        Null: { "dynamodb:Attributes": "false" },
      },
    }]);
  });

  it("lets the named reconciler read the Slack secret alone, for the bot token, and nothing else", () => {
    const { statements } = reconciler(named);
    const secrets = statements.filter((statement) => actionsOf([statement]).some((action) => action.startsWith("secretsmanager:")));
    expect(secrets).toEqual([{ Sid: "PostUnwaitedTaskNote", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: slackSecretId(named) } }]);
  });

  it("names the threads table, the Slack secret and the callback signing key to the named reconciler", () => {
    expect(reconciler(named).environment).toMatchObject({
      SLACK_THREADS_TABLE_NAME: { Ref: threadsTableId(named) },
      SLACK_SECRET_ARN: { Ref: slackSecretId(named) },
      CALLBACK_SIGNING_KEY: { Ref: "CallbackSigningKey" },
    });
  });

  it("alarms the operator when cancels or the backstop's reads keep failing on two runs in a row", () => {
    const alarms = backstopAlarms(named);
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0]!.Properties;
    expect(alarm).toMatchObject({
      AlarmName: "agentx-staging-UnwaitedTaskFailures", EvaluationPeriods: 2, Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    });
    expect(alarm.AlarmActions).toHaveLength(1);
    const stats = (alarm.Metrics ?? []).filter((metric) => metric.MetricStat !== undefined).map((metric) => metric.MetricStat!);
    expect(stats.map((stat) => stat.Metric.MetricName).sort()).toEqual(["ReconcilerUnwaitedTaskFailures", "ReconcilerUnwaitedTaskReadFailures"]);
    for (const stat of stats) expect(stat).toMatchObject({ Metric: { Namespace: "AgentX/staging" }, Period: 600, Stat: "Maximum" });
    const expression = (alarm.Metrics ?? []).find((metric) => metric.Expression !== undefined)?.Expression;
    expect(expression).toMatch(/^FILL\(\w+, ?0\) \+ FILL\(\w+, ?0\)$/);
  });

  it("adds none of it to the legacy deployment", () => {
    const { environment, statements } = reconciler(legacy);
    for (const name of ["BROKER_FUNCTION_NAME", "SLACK_SECRET_ARN", "SLACK_THREADS_TABLE_NAME", "CALLBACK_SIGNING_KEY"]) expect(environment).not.toHaveProperty(name);
    expect(JSON.stringify(statements)).not.toContain("SlackThreads");
    expect(actionsOf(statements).filter((action) => action.startsWith("lambda:") || action.startsWith("secretsmanager:"))).toEqual([]);
    expect(backstopAlarms(legacy)).toEqual([]);
  });
});
