// Spec 052 FR-011: the eval batch tick is a scheduled Lambda in the control plane, every 2 minutes,
// with only the permissions its work needs.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };

describe("the eval batch tick's infrastructure (spec 052 FR-006, FR-011)", () => {
  let resources: Record<string, Resource>;

  beforeAll(() => {
    const app = buildAgentXApp();
    const control = app.node.children.find((c): c is Stack => Stack.isStack(c) && c.stackName === "AgentXControlPlane")!;
    resources = Template.fromStack(control).toJSON().Resources as Record<string, Resource>;
  }, 240_000);

  const tickId = () => Object.entries(resources).find(([id, r]) => r.Type === "AWS::Lambda::Function" && id.startsWith("EvalBatchTick"))![0];
  const roleId = () => (resources[tickId()]!.Properties.Role as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
  const statements = () => Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(roleId()))
    .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  const actions = () => [...new Set(statements().flatMap((s) => [s.Action].flat()))].sort();

  it("is a Lambda with the broker's eval settings, run every 2 minutes by EventBridge Scheduler", () => {
    const tick = resources[tickId()]!;
    expect(tick.Properties.Timeout).toBe(90);
    const environment = (tick.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(environment)).toEqual(expect.arrayContaining(["STATE_TABLE_NAME", "ARTIFACT_BUCKET_NAME", "CALLBACK_SIGNING_KEY", "SWEBENCH_SETTINGS_PREFIX"]));
    expect(environment.SWEBENCH_SETTINGS_PREFIX).toBe("/agentx/production/");
    const schedules = Object.values(resources).filter((r) => r.Type === "AWS::Scheduler::Schedule" && JSON.stringify(r.Properties.Target).includes(tickId()));
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.Properties).toMatchObject({ ScheduleExpression: "rate(2 minutes)", State: "ENABLED" });
  });

  it("may only use the State table, write eval objects, read the eval settings, start and describe the eval state machine's executions, and terminate eval instances", () => {
    expect(actions().filter((action) => !action.startsWith("dynamodb:") && !action.startsWith("xray:"))).toEqual([
      "ec2:TerminateInstances", "s3:PutObject", "ssm:GetParameters", "states:DescribeExecution", "states:StartExecution",
    ]);
    const byAction = (action: string) => statements().filter((s) => [s.Action].flat().includes(action));
    expect(byAction("s3:PutObject")).toHaveLength(1);
    expect(JSON.stringify(byAction("s3:PutObject")[0]!.Resource)).toMatch(/"\/evals\/\*"\]/);
    expect(JSON.stringify(byAction("states:StartExecution")[0]!.Resource)).toContain(":stateMachine:agentx-production-swebench-eval");
    // Ruling 16: it terminates only this environment's eval instances, by the tags the launcher sets.
    const terminate = byAction("ec2:TerminateInstances");
    expect(terminate).toHaveLength(1);
    expect(JSON.stringify(terminate[0]!.Resource)).toContain(":instance/*");
    expect(terminate[0]!.Condition).toEqual({ StringEquals: { "aws:ResourceTag/DeploymentMode": "swebench-eval", "aws:ResourceTag/Environment": "production" } });
    // Ruling 13: it describes only the eval state machine's executions.
    expect(byAction("states:DescribeExecution")).toHaveLength(1);
    expect(JSON.stringify(byAction("states:DescribeExecution")[0]!.Resource)).toMatch(/:execution:agentx-production-swebench-eval:\*"/);
    const ssm = JSON.stringify(byAction("ssm:GetParameters")[0]!.Resource);
    expect(ssm).toContain("parameter/agentx/production/eval/settings");
    expect(ssm).not.toContain("*");
    // The table's data only: the grant names the State table and its indexes, nothing else.
    const dynamo = statements().filter((s) => [s.Action].flat().some((action) => action.startsWith("dynamodb:")));
    expect(dynamo.every((s) => JSON.stringify(s.Resource).includes("State"))).toBe(true);
    // Only X-Ray's tracing calls, which take no resource, are allowed on every resource.
    const unscoped = statements().filter((s) => s.Resource === "*" && ![s.Action].flat().every((action) => action.startsWith("xray:")));
    expect(unscoped).toEqual([]);
    expect(statements().every((s) => s.Effect === "Allow")).toBe(true);
  });

  it("alarms the operator when it keeps failing", () => {
    const alarm = Object.values(resources).find((r) => r.Type === "AWS::CloudWatch::Alarm" && JSON.stringify(r.Properties.Dimensions ?? []).includes(tickId()))!;
    expect(alarm.Properties).toMatchObject({ MetricName: "Errors", Threshold: 1, EvaluationPeriods: 3, TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
  });

  it("alarms the operator when the eval state machine fails an execution, which only its SlotReleaseFailed does (Ruling 31, review M-2)", () => {
    const alarm = Object.values(resources).find((r) => r.Type === "AWS::CloudWatch::Alarm" && r.Properties.MetricName === "ExecutionsFailed")!;
    expect(alarm.Properties).toMatchObject({ Namespace: "AWS/States", Statistic: "Sum", Threshold: 1, EvaluationPeriods: 1, TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm.Properties.Dimensions)).toContain(":stateMachine:agentx-production-swebench-eval");
    expect(String(alarm.Properties.AlarmDescription)).toContain("SlotReleaseFailed");
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
  });

  it("alarms the operator on the Slack service's batch watcher errors (Ruling 31, review M-1)", () => {
    const alarm = Object.values(resources).find((r) => r.Type === "AWS::CloudWatch::Alarm" && r.Properties.MetricName === "EvalBatchWatcherFailed")!;
    expect(alarm.Properties).toMatchObject({ Namespace: "AgentX", Statistic: "Sum", Threshold: 1, EvaluationPeriods: 1, TreatMissingData: "notBreaching" });
    expect(String(alarm.Properties.AlarmDescription)).toContain("eval_batch_watch");
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
  });

  it("publishes the watcher's error lines as a metric from the Slack service's log group", () => {
    const app = buildAgentXApp();
    const slack = app.node.children.find((c): c is Stack => Stack.isStack(c) && c.stackName === "AgentXSlackOrchestrator")!;
    const filters = Object.values(Template.fromStack(slack).toJSON().Resources as Record<string, Resource>).filter((r) => r.Type === "AWS::Logs::MetricFilter"
      && JSON.stringify(r.Properties.MetricTransformations).includes("EvalBatchWatcherFailed"));
    expect(filters).toHaveLength(1);
    expect(filters[0]!.Properties.FilterPattern).toBe('{ ($.event = "eval_batch_watch.*") && ($.level = "error") }');
    expect(filters[0]!.Properties.MetricTransformations).toEqual([{ MetricNamespace: "AgentX", MetricName: "EvalBatchWatcherFailed", MetricValue: "1" }]);
  }, 240_000);
});
