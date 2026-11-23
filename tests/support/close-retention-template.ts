import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };
/** Assert and subtract exactly DEC331's grant/ARN and the exact-target deleter additions; keep historical pins. */
export function withoutCloseRetention<T>(input: T): T {
  const copy = structuredClone(input), resources = (copy as { Resources: Record<string, Resource> }).Resources;
  const find = (name: string, type: string) => {
    const found = Object.entries(resources).filter(([id, resource]) => id.startsWith(name) && resource.Type === type);
    expect(found).toHaveLength(1); return found[0]!;
  };
  const [dispatcher] = find("Dispatcher", "AWS::Lambda::Function");
  const [, broker] = find("Broker", "AWS::Lambda::Function");
  const variables = (broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables.CLOSE_RETENTION_DISPATCHER_ARN).toEqual({ "Fn::GetAtt": [dispatcher, "Arn"] });
  delete variables.CLOSE_RETENTION_DISPATCHER_ARN;
  const [roleId] = find("BrokerServiceRole", "AWS::IAM::Role");
  const [permissionId, permission] = find("DispatcherVerifyCloseRetention", "AWS::Lambda::Permission");
  expect(permission).toEqual({ Type: "AWS::Lambda::Permission", Properties: {
    Action: "lambda:InvokeFunction", FunctionName: { "Fn::GetAtt": [dispatcher, "Arn"] }, Principal: { "Fn::GetAtt": [roleId, "Arn"] },
  } });
  delete resources[permissionId];
  const machines = Object.values(resources).filter(resource => resource.Type === "AWS::StepFunctions::StateMachine" && JSON.stringify(resource.Properties.DefinitionString).includes("Deletes a closed ec2-ebs"));
  expect(machines).toHaveLength(1);
  const machine = machines[0]!, joined = machine.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] };
  const tokens: unknown[] = [];
  const text = joined["Fn::Join"][1].map(part => typeof part === "string" ? part : `__RETENTION_TOKEN_${tokens.push(part) - 1}__`).join("");
  const definition = JSON.parse(text) as { States: Record<string, { Next?: string; Assign?: Record<string, unknown>; Arguments?: { FunctionName?: unknown; Payload?: Record<string, unknown> }; [field: string]: unknown }> };
  const start = definition.States.Start!, marked = definition.States.MarkDeleted!, validate = definition.States.ValidateDeletion!;
  expect(start.Assign!.closeDestroy).toBe("{% $exists($states.input.closeDestroy) ? $states.input.closeDestroy : null %}");
  expect(start.Next).toBe("ValidateDeletion");
  expect(validate).toMatchObject({ Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Next: "HasInstance", Arguments: { Payload: { action: "validateDeletion", workspaceId: "{% $workspaceId %}", closeDestroy: "{% $closeDestroy %}" } } });
  expect(marked.Arguments!.Payload!.closeDestroy).toBe("{% $closeDestroy %}");
  delete start.Assign!.closeDestroy; start.Next = "HasInstance";
  delete definition.States.ValidateDeletion; delete marked.Arguments!.Payload!.closeDestroy;
  const parts = JSON.stringify(definition).split(/(__RETENTION_TOKEN_\d+__)/u).filter(part => part !== "").map(part => {
    const match = /^__RETENTION_TOKEN_(\d+)__$/u.exec(part);
    return match === null ? part : tokens[Number(match[1])];
  });
  machine.Properties.DefinitionString = { "Fn::Join": ["", parts] };
  return copy;
}
