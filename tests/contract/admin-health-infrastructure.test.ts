// Spec 025 A13 and A6: the broker's health grants are exact, the index TTL is on, and both exist
// only in named environments.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";

type Statement = { Action: string | string[]; Resource: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Environment?: { Variables?: Record<string, unknown> } } };

function brokerStatements(template: Template): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole")))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}
function brokerEnvironment(template: Template): Record<string, unknown> {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const broker = functions.find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return broker?.[1].Properties.Environment?.Variables ?? {};
}

describe("the health route's grants (A13)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "HealthControlPlane", { naming: environmentNaming("live25d") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "HealthLegacyControlPlane"));

  it("lets the broker describe the environment's alarms, by their name prefix only", () => {
    const describe = brokerStatements(named).filter((statement) => statement.Action === "cloudwatch:DescribeAlarms");
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]?.Resource)).toContain(":alarm:agentx-live25d-*");
    expect(brokerEnvironment(named).AGENTX_ALARM_PREFIX).toBe("agentx-live25d-");
  });

  it("lets the broker read the attributes of exactly the four dead-letter queues", () => {
    const queues = brokerStatements(named).filter((statement) => statement.Action === "sqs:GetQueueAttributes");
    expect(queues).toHaveLength(1);
    expect(queues[0]?.Resource).toHaveLength(4);
    // Exactly the four queues' own ARNs, one each: no wildcard, no other queue.
    const queueIds = [/^DispatchDeadLetterQueue[0-9A-F]{8}$/, /^SlackRequestDeadLetterQueue[0-9A-F]{8}$/, /^DeveloperTaskNotifierNoticeDeadLetterQueue[0-9A-F]{8}$/, /^DeveloperTaskNotifierStreamFailureQueue[0-9A-F]{8}$/];
    const resources = queues[0]?.Resource as Array<{ "Fn::GetAtt"?: [string, string] }>;
    for (const resource of resources) {
      expect(resource).toEqual({ "Fn::GetAtt": [expect.any(String), "Arn"] });
      expect(Object.keys(named.findResources("AWS::SQS::Queue"))).toContain(resource["Fn::GetAtt"]?.[0]);
    }
    for (const id of queueIds) expect(resources.filter((resource) => id.test(resource["Fn::GetAtt"]?.[0] ?? ""))).toHaveLength(1);
    const listed = JSON.stringify(brokerEnvironment(named).HEALTH_DEAD_LETTER_QUEUES);
    for (const queue of ["DispatchDeadLetterQueue", "SlackRequestDeadLetterQueue", "NoticeDeadLetterQueue", "StreamFailureQueue"]) expect(listed).toContain(queue);
  });

  it("expires index items by TTL on indexExpiresAt in a named environment, and tells the reconciler so (A6, Q5)", () => {
    const tables = Object.values(named.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    const state = tables.filter((table) => table.Properties.StreamSpecification !== undefined);
    expect(state).toHaveLength(1);
    expect(state[0]?.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "indexExpiresAt", Enabled: true });
    const functions = Object.entries(named.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
    const reconciler = functions.find(([id]) => /Reconciler[0-9A-F]{8}$/.test(id));
    expect(reconciler?.[1].Properties.Environment?.Variables).toMatchObject({ INDEX_EXPIRY: "ttl" });
  });

  // 25c note 2 (owner answer, 2026-09-30): NOTICE (the notifier) and CHANNEL_OPERATION (broker.ts) items expire on it too.
  it("names indexExpiresAt only where index, notice and channel-operation items are written or read, so the TTL deletes nothing else", () => {
    const allowed = new Set([
      "packages/contracts/src/admin.ts", "packages/broker/src/aws/activity-index.ts", "packages/broker/src/aws/admin-reads.ts", "infra/lib/control-plane.ts",
      "packages/broker/src/aws/developer-task-notifier.ts", "packages/broker/src/aws/broker.ts",
    ]);
    const found = execFileSync("grep", ["-rl", "indexExpiresAt\\|INDEX_EXPIRY_ATTRIBUTE", "packages", "infra/lib", "--include=*.ts", "--exclude-dir=dist", "--exclude-dir=node_modules"], { encoding: "utf8" }).trim().split("\n").filter((file) => file !== "");
    expect(found.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("sets the TTL attribute in broker.ts on the channel-operation marker alone, and in the notifier on NOTICE items alone (25c note 2)", () => {
    const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
    const brokerUses = broker.split("\n").filter((line) => /indexExpiresAt\(|INDEX_EXPIRY_ATTRIBUTE\]/.test(line));
    expect(brokerUses).toEqual(["      [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(operation.createdAt),"]);
    const channelOperation = broker.slice(broker.indexOf("function channelOperation("), broker.indexOf("function requesterOf("));
    expect(channelOperation).toContain('entityType: "CHANNEL_OPERATION"');
    expect(channelOperation).toContain(brokerUses[0]);
    const notifier = readFileSync("packages/broker/src/aws/developer-task-notifier.ts", "utf8");
    const writes = notifier.split("\n").filter((line) => line.includes("noticeExpiry(deps)"));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const line of writes) expect(line).toMatch(/entityType: "NOTICE"|":expires": noticeExpiry/);
    // Nothing else in the notifier names the attribute: no other item there can carry it.
    const named = notifier.split("\n").filter((line) => /indexExpiresAt|INDEX_EXPIRY_ATTRIBUTE/.test(line)).map((line) => line.trim());
    expect(named).toHaveLength(4);
    expect(named[0]).toMatch(/^import \{ INDEX_EXPIRY_ATTRIBUTE, .*indexExpiresAt, .*\} from "@agentx\/contracts";$/);
    expect(named.slice(1)).toEqual([
      "const noticeExpiry = (deps: NotifierDependencies) => ({ [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(new Date(deps.now()).toISOString()) });",
      'ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },',
      'ExpressionAttributeValues: { ":notice": "NOTICE", ":until": until, ":now": deps.now(), ":expires": noticeExpiry(deps)[INDEX_EXPIRY_ATTRIBUTE] },',
    ]);
  });

  it("adds nothing to the legacy template", () => {
    expect(brokerStatements(legacy).some((statement) => statement.Action === "cloudwatch:DescribeAlarms" || statement.Action === "sqs:GetQueueAttributes")).toBe(false);
    const legacyTables = Object.values(legacy.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    expect(legacyTables.find((table) => table.Properties.StreamSpecification !== undefined)?.Properties.TimeToLiveSpecification).toBeUndefined();
    expect(brokerEnvironment(legacy)).not.toHaveProperty("AGENTX_ALARM_PREFIX");
    expect(brokerEnvironment(legacy)).not.toHaveProperty("HEALTH_DEAD_LETTER_QUEUES");
  });
});
