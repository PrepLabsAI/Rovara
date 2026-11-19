// L4-HARD (c), owner 2026-11-18: the ECS action-log group's resource policy let `events.amazonaws.com` write streams with no source condition (its `delivery.logs` sibling had
// aws:SourceAccount and aws:SourceArn). Now the events statement carries both: this account, and this stack's own deployment-failure rule (by name: the rule depends on the log group, so
// its ARN cannot be referenced from the group's policy). Named environments only (the legacy template has no action log group).
// NOT PROVEN HERE: that EventBridge sends aws:SourceArn / aws:SourceAccount when it delivers to a CloudWatch Logs target. The PR body says how to check it live (a change-set preview, then a
// deployment-failure test event after the owner's go) and what to do if it does not (drop the two conditions again).
import { App, Aspects } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";
import { RetainExceptOnCreate } from "../../infra/lib/retention.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";

type Json = Record<string, unknown>;
const template = (env?: string) => {
  const app = new App();
  const stack = new SlackOrchestratorStack(app, "Slack", { env: { region: "us-east-1" }, naming: env === undefined ? legacyNaming() : environmentNaming(env) });
  Aspects.of(app).add(new RetainExceptOnCreate());
  return Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: Json }> };
};
const named = template("staging");
const STACK_ID = "arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-slack/a1b2c3d4-0000-1111-2222-333344445555";

/** Enough of CloudFormation's intrinsics for these two strings. */
function resolve(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolve);
  if (value === null || typeof value !== "object") return value;
  const o = value as Json;
  const [k] = Object.keys(o);
  if (Object.keys(o).length === 1) {
    if (k === "Ref") return ({ "AWS::Partition": "aws", "AWS::Region": "us-east-1", "AWS::AccountId": "123456789012", "AWS::StackId": STACK_ID } as Record<string, string>)[o.Ref as string] ?? `<${String(o.Ref)}>`;
    if (k === "Fn::Join") { const [sep, parts] = o["Fn::Join"] as [string, unknown[]]; return parts.map(resolve).join(sep); }
    if (k === "Fn::Select") { const [i, list] = o["Fn::Select"] as [number, unknown[]]; return (resolve(list) as string[])[i]; }
    if (k === "Fn::Split") { const [sep, text] = o["Fn::Split"] as [string, unknown]; return String(resolve(text)).split(sep); }
  }
  return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, resolve(v)]));
}

const groups = () => Object.values(named.Resources).filter((r) => r.Type === "AWS::Logs::LogGroup" && r.Properties.ResourcePolicyDocument !== undefined);
const statements = () => (groups()[0]!.Properties.ResourcePolicyDocument as { Statement: Array<Json & { Sid: string; Condition?: Record<string, Record<string, unknown>> }> }).Statement;
const rule = () => Object.values(named.Resources).find((r) => r.Type === "AWS::Events::Rule")!;

function eventsMayWrite(request: { account?: string; sourceArn?: string }): boolean {
  const s = statements().find((x) => x.Sid === "AllowEcsDeploymentFailureEvents")!;
  const r = resolve(s) as typeof s;
  const wantAccount = r.Condition?.StringEquals?.["aws:SourceAccount"];
  const wantArn = String(r.Condition?.ArnLike?.["aws:SourceArn"]);
  if (r.Condition === undefined) return true;
  const glob = new RegExp(`^${wantArn.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u");
  return request.account === wantAccount && request.sourceArn !== undefined && glob.test(request.sourceArn);
}

describe("the action-log group's resource policy: both service statements are conditioned", () => {
  it("has the delivery.logs statement (unchanged) and the events statement with aws:SourceAccount and the rule's ARN", () => {
    expect(groups()).toHaveLength(1);
    expect(statements().map((s) => s.Sid)).toEqual(["AllowEcsActionLogDelivery", "AllowEcsDeploymentFailureEvents"]);
    const delivery = statements()[0]!;
    const events = statements()[1]!;
    expect(Object.keys(delivery.Condition as Json).sort()).toEqual(["ArnLike", "StringEquals"]);
    const anything: unknown = expect.anything();
    expect(events).toMatchObject({ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"] });
    expect(events.Condition).toEqual({
      StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
      ArnLike: { "aws:SourceArn": anything },
    });
  });

  it("simulation: the stack's own rule may write; another account, another rule, a rule of the same name elsewhere, or no source may not", () => {
    const name = String(resolve(rule().Properties.Name));
    expect(name).toBe("agentx-staging-a1b2c3d4-service-failures");
    const own = `arn:aws:events:us-east-1:123456789012:rule/${name}`;
    expect(eventsMayWrite({ account: "123456789012", sourceArn: own })).toBe(true);
    expect(eventsMayWrite({ account: "210987654321", sourceArn: own })).toBe(false);
    expect(eventsMayWrite({ account: "123456789012", sourceArn: "arn:aws:events:us-east-1:123456789012:rule/someone-elses-rule" })).toBe(false);
    expect(eventsMayWrite({ account: "123456789012", sourceArn: `arn:aws:events:us-east-1:210987654321:rule/${name}` })).toBe(false);
    expect(eventsMayWrite({ account: "123456789012", sourceArn: `arn:aws:events:eu-west-1:123456789012:rule/${name}` })).toBe(false);
    expect(eventsMayWrite({ account: "123456789012" })).toBe(false);
    expect(eventsMayWrite({})).toBe(false);
  });

  it("the condition's rule ARN is built from the SAME name expression as the rule, and the policy does not reference the rule (it would make a cycle)", () => {
    const events = statements()[1]!;
    const arn = (events.Condition!.ArnLike!["aws:SourceArn"] as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
    const name = (rule().Properties.Name as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
    // Same attempt expression and suffix as the rule's own name (only the front differs: `...:rule/agentx-<env>-` against `agentx-<env>-`).
    expect(JSON.stringify(arn.slice(-2))).toBe(JSON.stringify(name.slice(-2)));
    expect(arn.at(-3)).toBe(`:rule/${String(name[0])}`);
    expect(JSON.stringify(events)).not.toContain("GetAtt");
    expect(JSON.stringify(events)).not.toMatch(/"Ref":"ServiceDeploymentFailureEvents/u);
  });

  it("legacy has no action log group at all (named only)", () => {
    expect(Object.values(template().Resources).filter((r) => r.Type === "AWS::Logs::LogGroup" && r.Properties.ResourcePolicyDocument !== undefined)).toEqual([]);
  });
});
