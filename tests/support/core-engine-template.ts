// Shared by the template-digest contract tests: take the core engine's named-environment addition (lane E2) out of a synthesized named control-plane template, asserting its exact shape first,
// so a test that pins "everything else" does not have to know the core engine's resources.
import { expect } from "vitest";
import { CORE_JOB_SCHEDULES } from "@agentx/contracts";

type Resource = { Type: string; Properties: Record<string, unknown> };

/**
 * Migration plan v3.2 lane E2 adds the core engine's switch to a named control plane: the off-by-default CoreEngine parameter, its reference on the broker, and the CoreEngineJobs construct
 * (queue, dead letters, their queue policies, an alarm, a schedule group, the scheduler's role and one schedule per job, behind the CoreEngineIsOn condition). tests/contract/core-engine-infrastructure.test.ts
 * checks each in full; here their kinds and count are checked, then they are taken out, so the rest of the template must still match the snapshot (nothing else moved, the broker role included).
 */
export function withoutCoreEngine(template: unknown): unknown {
  const synthesized = template as { Parameters: Record<string, unknown>; Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(synthesized.Parameters.CoreEngine).toMatchObject({ Type: "String", Default: "off" });
  delete synthesized.Parameters.CoreEngine;
  const conditions = Object.keys(synthesized.Conditions).filter((id) => id.startsWith("CoreEngineJobs"));
  expect(conditions).toHaveLength(1);
  delete synthesized.Conditions[conditions[0]!];
  const added = Object.entries(synthesized.Resources).filter(([id]) => id.startsWith("CoreEngineJobs"));
  expect(added.map(([, resource]) => resource.Type).sort()).toEqual([
    "AWS::CloudWatch::Alarm", "AWS::IAM::Policy", "AWS::IAM::Role", ...Array<string>(CORE_JOB_SCHEDULES.length).fill("AWS::Scheduler::Schedule"), "AWS::Scheduler::ScheduleGroup",
    "AWS::SQS::Queue", "AWS::SQS::Queue", "AWS::SQS::QueuePolicy", "AWS::SQS::QueuePolicy",
  ].sort());
  for (const [id] of added) delete synthesized.Resources[id];
  const brokers = Object.entries(synthesized.Resources).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
  expect(brokers).toHaveLength(1);
  const variables = (brokers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables.ROVARA_CORE_ENGINE).toStrictEqual({ Ref: "CoreEngine" });
  delete variables.ROVARA_CORE_ENGINE;
  return template;
}
