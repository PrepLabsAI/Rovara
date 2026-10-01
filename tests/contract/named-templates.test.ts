import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string };

/**
 * Issue 173 adds the reconciler backstop to a named control plane, and nothing else: its two
 * environment variables, its two statements and its alarm. They are checked here to be exactly
 * these, then taken out, so the rest of the template must still match the recorded snapshot.
 */
function withoutUnwaitedTaskBackstop(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const reconcilerEntry = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function");
  expect(reconcilerEntry).toBeDefined();
  const reconciler = reconcilerEntry![1];
  const variables = (reconciler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const brokerId = Object.keys(resources).find((id) => /^Broker[0-9A-F]{8}$/.test(id))!;
  const slackSecretId = Object.keys(resources).find((id) => id.startsWith("SlackSecret") && resources[id]!.Type === "AWS::SecretsManager::Secret")!;
  expect(variables.BROKER_FUNCTION_NAME).toEqual({ Ref: brokerId });
  expect(variables.SLACK_SECRET_ARN).toEqual({ Ref: slackSecretId });
  delete variables.BROKER_FUNCTION_NAME;
  delete variables.SLACK_SECRET_ARN;
  const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const policies = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy"
    && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId));
  const added = new Set(["StopUnwaitedTasks", "PostUnwaitedTaskNote"]);
  const removed: Statement[] = [];
  for (const policy of policies) {
    const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
    removed.push(...document.Statement.filter((statement) => added.has(statement.Sid ?? "")));
    document.Statement = document.Statement.filter((statement) => !added.has(statement.Sid ?? ""));
  }
  expect(removed).toEqual([
    { Sid: "StopUnwaitedTasks", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { "Fn::GetAtt": [brokerId, "Arn"] } },
    { Sid: "PostUnwaitedTaskNote", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: slackSecretId } },
  ]);
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsUnwaitedTaskFailuresAlarm"));
  expect(alarms).toHaveLength(1);
  expect(resources[alarms[0]!]!.Properties).toMatchObject({ AlarmName: "agentx-staging-UnwaitedTaskFailures" });
  expect(JSON.stringify(resources[alarms[0]!]!.Properties.Metrics)).toContain("ReconcilerUnwaitedTaskReadFailures");
  delete resources[alarms[0]!];
  return template;
}

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 4a605fd (re-recorded there when mainline merged in), so a named environment's templates must stay
// as they were, apart from issue 173's reconciler backstop, checked and taken out above.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutUnwaitedTaskBackstop(template) : template).toMatchSnapshot();
    }, 120_000);
  }
});
