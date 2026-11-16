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
  for (const name of ["CoreEngine", "CoreAllowedCompanies", "CoreTaskCapUsd", "CoreCompanyDayCapUsd", "CorePolicyHook", "CoreLessons"]) delete synthesized.Parameters[name];
  const conditions = Object.keys(synthesized.Conditions).filter((id) => id.startsWith("CoreEngineJobs"));
  expect(conditions).toHaveLength(1);
  delete synthesized.Conditions[conditions[0]!];
  const added = Object.entries(synthesized.Resources).filter(([id]) => id.startsWith("CoreEngineJobs"));
  expect(added.map(([, resource]) => resource.Type).sort()).toEqual([
    "AWS::CloudWatch::Alarm", "AWS::IAM::Policy", "AWS::IAM::Role", ...Array<string>(CORE_JOB_SCHEDULES.length).fill("AWS::Scheduler::Schedule"), "AWS::Scheduler::ScheduleGroup",
    "AWS::SQS::Queue", "AWS::SQS::Queue", "AWS::SQS::QueuePolicy", "AWS::SQS::QueuePolicy",
    // R2 step 4: the dispatcher's core queue mapping and its policy under the condition.
    "AWS::Lambda::EventSourceMapping", "AWS::IAM::Policy",
  ].sort());
  for (const [id] of added) delete synthesized.Resources[id];
  // R2 step 4: the dispatcher's core variables and its one statement on the core queue, and the State table's outbox pending index (each checked in core-engine-infrastructure).
  const dispatchers = Object.entries(synthesized.Resources).filter(([id, resource]) => /^Dispatcher[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(dispatchers).toHaveLength(1);
  const dispatcherVariables = (dispatchers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  for (const name of ["CORE_DISPATCH_QUEUE_ARN", "CORE_DISPATCH_QUEUE_URL", "CORE_DISPATCH_DEAD_LETTER_URL", "ROVARA_CORE_ENGINE", "CALLBACK_SIGNING_KEY", "EC2_WORKER_SUBNETS", "EC2_WORKER_LAUNCH_TEMPLATE_ID"]) {
    expect(dispatcherVariables, name).toHaveProperty(name);
    delete dispatcherVariables[name];
  }
  removePackedPieces(dispatcherVariables, "AGENTX_SETTINGS", ["ac", "cd", "cl", "ct"]);
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
  const brokers = Object.entries(synthesized.Resources).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
  expect(brokers).toHaveLength(1);
  const variables = (brokers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables.ROVARA_CORE_ENGINE).toStrictEqual({ Ref: "CoreEngine" });
  removePackedPieces(variables, "AGENTX_SETTINGS", ["ac", "cd", "cl", "ct"]);
  delete variables.ROVARA_POLICY_HOOK;
  delete variables.ROVARA_CORE_ALLOWED_COMPANIES;
  delete variables.ROVARA_CORE_ENGINE;
  return template;
}
