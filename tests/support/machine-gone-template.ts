// WORKER-DELIVERY-IDENTITY step 0 (ii) and (b-plus), as a synthesized template shows them, for the tests that pin "everything else" (Rule D: a re-pin is only for exactly this addition).
//  - `withoutMachineGone` checks the control plane's addition is exactly this and takes it out: the instance state-change function (its role, policy and log group), the EventBridge rule that calls
//    it and the permission that lets the rule invoke it, and the dispatcher's one `ec2:DescribeInstances` statement. The pins and snapshots recorded before it hold with it gone.
//    The access stack is not touched by the lane (the rule's name falls under the deploy role's existing EventBridge pattern), so it has no stripper.
import { expect } from "vitest";
import { INSTANCE_ENDED_STATES, INSTANCE_STATE_CHANGE_TABLE_ACTIONS } from "../../infra/lib/instance-state-change.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown; Condition?: string };
type Template = { Resources: Record<string, Resource> };
type Statement = { Sid?: string; Effect: string; Action?: string | string[]; Resource?: unknown; Condition?: unknown };

const OWN = /^SessionsInstanceStateChange/u;
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** The statements of every IAM::Policy (and ManagedPolicy) in the template, with the policy's id. */
function policyStatements(template: Template): Array<{ id: string; statements: Statement[]; roles: unknown }> {
  return Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
    .map(([id, resource]) => ({ id, roles: resource.Properties.Roles, statements: list((resource.Properties.PolicyDocument as { Statement: Statement | Statement[] }).Statement) }));
}

/** The addition's resources, in the order they are asserted: exactly one of each type, all named by the Sessions/InstanceStateChange construct. */
export function instanceStateChangeResources(template: Template): Record<"function" | "role" | "policy" | "logGroup" | "rule" | "permission", string> {
  const own = Object.entries(template.Resources).filter(([id]) => OWN.test(id));
  const byType = (type: string): string => {
    const found = own.filter(([, resource]) => resource.Type === type).map(([id]) => id);
    expect(found, `exactly one ${type} of the instance state-change handler`).toHaveLength(1);
    return found[0]!;
  };
  const ids = {
    function: byType("AWS::Lambda::Function"), role: byType("AWS::IAM::Role"), policy: byType("AWS::IAM::Policy"),
    logGroup: byType("AWS::Logs::LogGroup"), rule: byType("AWS::Events::Rule"), permission: byType("AWS::Lambda::Permission"),
  };
  expect(own.map(([id]) => id).sort(), "nothing else is named by the construct").toEqual(Object.values(ids).sort());
  return ids;
}

/**
 * Asserts the control plane's addition is exactly: the function (state table and metrics namespace variables only, no VPC), its role with one policy of exactly the five table actions, the log group, the
 * rule with the three ending states and a single retrying Lambda target, the rule's invoke permission, and the dispatcher's `VerifyWorkerMachine` statement (ec2:DescribeInstances on `*` alone); then
 * removes all of it. Mutates and returns `input` (clone first to keep the original).
 */
export function withoutMachineGone<T>(input: T): T {
  const template = input as unknown as Template;
  const ids = instanceStateChangeResources(template);
  const fn = template.Resources[ids.function]!;
  expect(Object.keys((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).sort()).toEqual(["AGENTX_METRICS_NAMESPACE", "STATE_TABLE_NAME"]);
  expect(fn.Properties.VpcConfig, "the handler needs no network path").toBeUndefined();
  const policy = policyStatements(template).find(({ id }) => id === ids.policy)!;
  expect(policy.roles).toEqual([{ Ref: ids.role }]);
  const marks = policy.statements.filter((statement) => statement.Sid === "MarkLostSessions");
  expect(marks).toHaveLength(1);
  expect(list(marks[0]!.Action).sort()).toEqual([...INSTANCE_STATE_CHANGE_TABLE_ACTIONS].sort());
  expect(JSON.stringify(policy.statements), "the handler holds no EC2 permission").not.toContain("ec2:");
  const rule = template.Resources[ids.rule]!;
  expect((rule.Properties.EventPattern as { detail: { state: string[] } }).detail.state).toEqual([...INSTANCE_ENDED_STATES]);
  expect(list(rule.Properties.Targets as unknown[])).toHaveLength(1);
  // The dispatcher's statement.
  const dispatcherRoles = Object.keys(template.Resources).filter((id) => /^DispatcherServiceRole[0-9A-F]{8}$/u.test(id));
  expect(dispatcherRoles).toHaveLength(1);
  const dispatcherPolicies = policyStatements(template).filter(({ roles }) => JSON.stringify(roles) === JSON.stringify([{ Ref: dispatcherRoles[0] }]));
  const holders = dispatcherPolicies.filter(({ statements }) => statements.some((statement) => statement.Sid === "VerifyWorkerMachine"));
  expect(holders, "exactly one dispatcher policy holds the statement").toHaveLength(1);
  const document = template.Resources[holders[0]!.id]!.Properties.PolicyDocument as { Statement: Statement | Statement[] };
  const statements = list(document.Statement);
  expect(statements.filter((statement) => statement.Sid === "VerifyWorkerMachine")).toEqual([{ Sid: "VerifyWorkerMachine", Effect: "Allow", Action: "ec2:DescribeInstances", Resource: "*" }]);
  document.Statement = statements.filter((statement) => statement.Sid !== "VerifyWorkerMachine");
  // WDI-SETUP: the dispatcher's metrics namespace variable and the one alarm that reads the grace metric.
  const dispatcher = template.Resources[Object.keys(template.Resources).find((id) => /^Dispatcher[0-9A-F]{8}$/u.test(id) && template.Resources[id]!.Type === "AWS::Lambda::Function")!]!;
  const variables = (dispatcher.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(typeof variables["AGENTX_METRICS_NAMESPACE"], "the dispatcher's metrics namespace (plain text)").toBe("string");
  delete variables["AGENTX_METRICS_NAMESPACE"];
  const alarms = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === "AWS::CloudWatch::Alarm" && /^SessionsSetupMachineUnverifiedAlarm/u.test(id));
  expect(alarms, "exactly one grace alarm").toHaveLength(1);
  expect(alarms[0]![1].Properties).toMatchObject({ MetricName: "SetupMachineUnverified", Statistic: "Sum", Period: 900, Threshold: 1, EvaluationPeriods: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
  expect(list((alarms[0]![1].Properties as { AlarmActions: unknown[] }).AlarmActions)).toHaveLength(1);
  delete template.Resources[alarms[0]![0]];
  for (const id of Object.values(ids)) delete template.Resources[id];
  // Nothing may still name what was taken out (a DependsOn or a Ref left behind would be a template that cannot deploy).
  expect(JSON.stringify(template.Resources)).not.toContain("SessionsInstanceStateChange");
  return input;
}
