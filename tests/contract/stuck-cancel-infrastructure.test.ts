// Issue 195: the stuck-cancel retry runs in the reconciler's own process (through #173's shared
// cancel code and signing key), so it adds no grant and no environment variable: only the
// StuckCancels alarm, in named environments only. The legacy templates are proven byte-identical by
// legacy-templates.test.ts.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Role: { "Fn::GetAtt": [string, string] }; Environment?: { Variables?: Record<string, unknown> } } };
type Alarm = { Properties: Record<string, unknown> };

function reconciler(template: Template) {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const [, fn] = functions.find(([id]) => id.startsWith("SessionsReconciler"))!;
  const roleId = fn.Properties.Role["Fn::GetAtt"][0];
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  return { environment: fn.Properties.Environment?.Variables ?? {}, statements };
}
const topicId = (template: Template) => Object.keys(template.findResources("AWS::SNS::Topic")).find((id) => id.startsWith("OperatorAlerts"))!;
const actionsOf = (statements: Statement[]) => statements.flatMap((statement) => [statement.Action].flat());
const stuckCancelAlarms = (template: Template) => Object.entries(template.findResources("AWS::CloudWatch::Alarm") as Record<string, Alarm>)
  .filter(([, alarm]) => JSON.stringify(alarm.Properties).includes("StuckCancel"));

describe("the stuck-cancel retry's infrastructure (#195)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "StuckCancelControlPlane", { naming: environmentNaming("staging") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "StuckCancelLegacyControlPlane"));

  it("never lets the named reconciler invoke the broker, or any function", () => {
    const { statements } = reconciler(named);
    expect(actionsOf(statements).filter((action) => action.startsWith("lambda:"))).toEqual([]);
    expect(statements.map((statement) => statement.Sid)).not.toContain("RetryStuckCancels");
  });

  it("never names the broker to the named reconciler, and signs the retried cancel with #173's key", () => {
    const { environment } = reconciler(named);
    expect(environment).not.toHaveProperty("BROKER_FUNCTION_NAME");
    expect(environment).toMatchObject({ CALLBACK_SIGNING_KEY: { Ref: "CallbackSigningKey" } });
  });

  it("alarms the operator on any stuck cancel retried or ended, or any failure to do so", () => {
    const alarms = stuckCancelAlarms(named);
    expect(alarms).toHaveLength(1);
    const [id, alarm] = alarms[0]!;
    expect(id).toMatch(/^SessionsStuckCancelsAlarm[0-9A-F]{8}$/);
    const stat = (metricName: string) => ({ MetricName: metricName, Namespace: "AgentX/staging" });
    expect(alarm.Properties).toStrictEqual({
      AlarmActions: [{ Ref: topicId(named) }],
      AlarmDescription: "The reconciler found a task whose cancel never reached its worker, and queued the cancel again or ended the task (or failed to). Check the reconciler's logs for stuck_cancel events: a retried cancel that finishes, or an ended task, needs no action; repeated ones point at a dispatch or worker fault.",
      AlarmName: "agentx-staging-StuckCancels",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      Metrics: [
        { Expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0) + FILL(unretried, 0)", Id: "expr_1", Label: "Stuck cancels retried, ended, failed or unretried", ReturnData: true },
        { Id: "retries", MetricStat: { Metric: stat("ReconcilerStuckCancelRetries"), Period: 900, Stat: "Maximum" }, ReturnData: false },
        { Id: "ended", MetricStat: { Metric: stat("ReconcilerStuckCancelsEnded"), Period: 900, Stat: "Maximum" }, ReturnData: false },
        { Id: "interrupted", MetricStat: { Metric: stat("ReconcilerStuckCancelsInterrupted"), Period: 900, Stat: "Maximum" }, ReturnData: false },
        { Id: "failures", MetricStat: { Metric: stat("ReconcilerStuckCancelFailures"), Period: 900, Stat: "Maximum" }, ReturnData: false },
        { Id: "unretried", MetricStat: { Metric: stat("ReconcilerStuckCancelsUnretried"), Period: 900, Stat: "Maximum" }, ReturnData: false },
      ],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
  });

  it("names the alarm with a single-word suffix, so the admin health route lists it as this environment's", () => {
    const name = String(stuckCancelAlarms(named)[0]![1].Properties.AlarmName);
    const prefix = environmentNaming("staging").alarmName("");
    expect(name.startsWith(prefix)).toBe(true);
    expect(name.slice(prefix.length)).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("adds none of it to the legacy deployment", () => {
    const { environment, statements } = reconciler(legacy);
    expect(environment).not.toHaveProperty("BROKER_FUNCTION_NAME");
    expect(environment).not.toHaveProperty("CALLBACK_SIGNING_KEY");
    expect(actionsOf(statements).filter((action) => action.startsWith("lambda:"))).toEqual([]);
    expect(stuckCancelAlarms(legacy)).toEqual([]);
  });
});
