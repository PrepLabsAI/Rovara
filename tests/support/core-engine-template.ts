// Shared by the template-digest contract tests: take the core engine's named-environment addition (lane E2) out of a synthesized named control-plane template, asserting its exact shape first,
// so a test that pins "everything else" does not have to know the core engine's resources.
import { expect } from "vitest";
import { CORE_JOB_SCHEDULES } from "@agentx/contracts";
import { removePackedPieces } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown> };

/**
 * Migration plan v3.2 lane E2 adds the core engine's switch to a named control plane: the off-by-default CoreEngine parameter, its reference on the broker, and the CoreEngineJobs construct
 * (queue, dead letters, their queue policies, an alarm, a schedule group, the scheduler's role and one schedule per job, behind the CoreEngineIsOn condition). tests/contract/core-engine-infrastructure.test.ts
 * checks each in full; here their kinds and count are checked, then they are taken out, so the rest of the template must still match the snapshot (nothing else moved, the broker role included).
 */
export function withoutCoreEngine(template: unknown): unknown {
  const synthesized = template as { Parameters: Record<string, unknown>; Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(synthesized.Parameters.CoreEngine).toMatchObject({ Type: "String", Default: "off" });
  // Web task channel C8 (option b): the attention email's three parameters (default off), its condition and its template rule (checked in core-engine-infrastructure).
  expect(synthesized.Parameters.CoreAttentionEmail).toMatchObject({ Type: "String", Default: "off", AllowedValues: ["off", "on"] });
  for (const name of ["CoreEngine", "CoreAllowedCompanies", "CoreTaskCapUsd", "CoreCompanyDayCapUsd", "CorePolicyHook", "CoreLessons", "CoreModelGatewayHost", "CoreAgentModel", "CoreAttentionEmail", "CoreAttentionEmailHost", "CoreAttentionEmailSender"]) delete synthesized.Parameters[name];
  const conditions = Object.keys(synthesized.Conditions).filter((id) => id.startsWith("CoreEngineJobs"));
  expect(conditions.map((id) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["CoreEngineJobsAttentionEmailAttentionEmailIsOn", "CoreEngineJobsCoreEngineIsOn"]);
  for (const id of conditions) delete synthesized.Conditions[id];
  // Only the attention email's rule is taken out (an app's stack keeps CDK's own CheckBootstrapVersion).
  const rules = (template as { Rules?: Record<string, unknown> }).Rules ?? {};
  const attentionRules = Object.keys(rules).filter((id) => id.startsWith("CoreEngineJobs"));
  expect(attentionRules.map((id) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["CoreEngineJobsAttentionEmailAttentionEmailOwnSender"]);
  for (const id of attentionRules) delete rules[id];
  if (Object.keys(rules).length === 0) delete (template as { Rules?: unknown }).Rules;
  const added = Object.entries(synthesized.Resources).filter(([id]) => id.startsWith("CoreEngineJobs"));
  expect(added.map(([, resource]) => resource.Type).sort()).toEqual([
    "AWS::CloudWatch::Alarm", "AWS::IAM::Policy", "AWS::IAM::Role", ...Array<string>(CORE_JOB_SCHEDULES.length).fill("AWS::Scheduler::Schedule"), "AWS::Scheduler::ScheduleGroup",
    "AWS::SQS::Queue", "AWS::SQS::Queue", "AWS::SQS::QueuePolicy", "AWS::SQS::QueuePolicy",
    // R2 step 4: the dispatcher's core queue mapping and its policy under the condition.
    "AWS::Lambda::EventSourceMapping", "AWS::IAM::Policy",
    // Web task channel C8 (option b): the attention email's sender function, its log group, role, policy and the broker's invoke permission, all under AttentionEmailIsOn.
    "AWS::Lambda::Function", "AWS::Logs::LogGroup", "AWS::IAM::Role", "AWS::IAM::Policy", "AWS::Lambda::Permission",
  ].sort());
  for (const [id] of added) delete synthesized.Resources[id];
  // R2 step 4: the dispatcher's core variables and its one statement on the core queue, and the State table's outbox pending index (each checked in core-engine-infrastructure).
  const dispatchers = Object.entries(synthesized.Resources).filter(([id, resource]) => /^Dispatcher[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(dispatchers).toHaveLength(1);
  const dispatcherVariables = (dispatchers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  for (const name of ["CORE_DISPATCH_QUEUE_ARN", "CORE_DISPATCH_QUEUE_URL", "CORE_DISPATCH_DEAD_LETTER_URL", "ROVARA_CORE_ENGINE", "CALLBACK_SIGNING_KEY_SECRET_ID", "EC2_WORKER_SUBNETS", "EC2_WORKER_LAUNCH_TEMPLATE_ID"]) {
    expect(dispatcherVariables, name).toHaveProperty(name);
    delete dispatcherVariables[name];
  }
  removePackedPieces(dispatcherVariables, "AGENTX_SETTINGS", ["ac", "am", "cd", "cl", "ct", "gw"]);
  delete dispatcherVariables.ROVARA_POLICY_HOOK;
  delete dispatcherVariables.ROVARA_CORE_ALLOWED_COMPANIES;
  const dispatcherPolicy = Object.entries(synthesized.Resources).find(([id, resource]) => id.startsWith("DispatcherServiceRoleDefaultPolicy") && resource.Type === "AWS::IAM::Policy")!;
  const statements = (dispatcherPolicy[1].Properties.PolicyDocument as { Statement: Array<{ Sid?: string }> }).Statement;
  expect(statements.filter((statement) => statement.Sid === "ConsumeCoreDispatchQueue")).toHaveLength(1);
  (dispatcherPolicy[1].Properties.PolicyDocument as { Statement: Array<{ Sid?: string }> }).Statement = statements.filter((statement) => statement.Sid !== "ConsumeCoreDispatchQueue");
  const tables = Object.entries(synthesized.Resources).filter(([, resource]) => resource.Type === "AWS::DynamoDB::Table" && Array.isArray(resource.Properties.GlobalSecondaryIndexes)
    && (resource.Properties.GlobalSecondaryIndexes as Array<{ IndexName: string }>).some((index) => index.IndexName === "outbox-pending"));
  expect(tables).toHaveLength(1);
  const table = tables[0]![1].Properties;
  table.GlobalSecondaryIndexes = (table.GlobalSecondaryIndexes as Array<{ IndexName: string }>).filter((index) => index.IndexName !== "outbox-pending");
  const definitions = table.AttributeDefinitions as Array<{ AttributeName: string }>;
  table.AttributeDefinitions = definitions.filter((definition) => definition.AttributeName !== "outboxState" && definition.AttributeName !== "outboxStagedAt");
  // L9 reuses the notifier reader. Assert every addition before restoring the pre-core shape.
  const notifier = Object.entries(synthesized.Resources).find(([id, resource]) => id.startsWith("DeveloperTaskNotifierFunction") && resource.Type === "AWS::Lambda::Function")![1];
  const notifierVariables = (notifier.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const brokerId = Object.entries(synthesized.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")![0];
  expect(notifierVariables.BROKER_FUNCTION_NAME).toEqual({ Ref: brokerId });
  delete notifierVariables.BROKER_FUNCTION_NAME;
  const notifierPolicy = Object.entries(synthesized.Resources).find(([id, resource]) => id.startsWith("DeveloperTaskNotifierFunctionServiceRoleDefaultPolicy") && resource.Type === "AWS::IAM::Policy")![1];
  const notifierDocument = notifierPolicy.Properties.PolicyDocument as { Statement: Array<{ Sid?: string }> };
  expect(notifierDocument.Statement.filter((statement) => statement.Sid === "RelayCoreOutboxToBroker")).toEqual([
    { Sid: "RelayCoreOutboxToBroker", Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { "Fn::GetAtt": [brokerId, "Arn"] } },
  ]);
  notifierDocument.Statement = notifierDocument.Statement.filter((statement) => statement.Sid !== "RelayCoreOutboxToBroker");
  const streamMapping = Object.entries(synthesized.Resources).find(([id, resource]) => id.startsWith("DeveloperTaskNotifierStateStreamMapping") && resource.Type === "AWS::Lambda::EventSourceMapping")![1];
  expect(streamMapping.Properties.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
  delete streamMapping.Properties.FunctionResponseTypes;
  const filters = (streamMapping.Properties.FilterCriteria as { Filters: Array<{ Pattern: string }> }).Filters;
  expect(filters.map(({ Pattern }) => JSON.parse(Pattern) as unknown)).toEqual([
    { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK", "DEVELOPER_TASK_POINTER"] } } } },
    { dynamodb: { NewImage: { entityType: { S: ["OPERATION"] }, status: { S: ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] } } } },
    { dynamodb: { NewImage: { entityType: { S: ["ADMIN_CHANGE"] } } } },
    { dynamodb: { NewImage: { entityType: { S: ["WORKFLOW_ACTION_REFUSAL", "TASK_COMMENT_NUDGE", "TASK_PEOPLE_NOTIFICATION"] } } } },
    { eventName: ["INSERT"], dynamodb: { NewImage: { entityType: { S: ["OUTBOX"] }, pk: { S: [{ prefix: "ORG#" }] }, outboxState: { S: [{ exists: true }] } } } },
  ]);
  filters.pop();
  filters.splice(0, 1,
    { Pattern: JSON.stringify({ dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK"] } } } }) },
    { Pattern: JSON.stringify({ dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK_POINTER"] } } } }) });
  const brokers = Object.entries(synthesized.Resources).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
  expect(brokers).toHaveLength(1);
  const variables = (brokers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  // Core switch-on blocker (2026-11-17): the switch and the gateway settings are packed in the broker's settings.
  const settingsJoin = JSON.stringify(variables.AGENTX_SETTINGS);
  for (const [code, parameter] of [["sw", "CoreEngine"], ["gw", "CoreModelGatewayHost"], ["am", "CoreAgentModel"]] as const) expect(settingsJoin, code).toMatch(new RegExp(`${code}=",\\{"Ref":"${parameter}"\\}`, "u"));
  // Web task channel C8 (option b): the attention email switch, packed (the web app's host is the sender function's alone).
  expect(settingsJoin).toMatch(/ae=",\{"Ref":"CoreAttentionEmail"\}/u);
  expect(settingsJoin).not.toContain("CoreAttentionEmailHost");
  removePackedPieces(variables, "AGENTX_SETTINGS", ["ac", "ae", "am", "cd", "cl", "ct", "gw", "sw"]);
  delete variables.ROVARA_POLICY_HOOK;
  delete variables.ROVARA_CORE_ALLOWED_COMPANIES;

  return template;
}
