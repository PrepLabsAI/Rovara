// L4-NETG (DEC 254zzz77, rule D proof): the stack parameter WorkerSandboxEgress and the one variable that reads it (the session steps' ROVARA_WORKER_SANDBOX_EGRESS) are the whole template change of the
// worker sandbox egress setting: no resource, no IAM statement, no other variable. Each digest test that pins the rest of a named control plane asserts these exactly, then takes them out in place, so the pins
// it holds stay the ones recorded before this change (tests/contract/worker-sandbox-egress-infrastructure.test.ts checks the setting itself). A template without the parameter (the legacy deployment) is returned as it is.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = { Parameters?: Record<string, unknown>; Resources: Record<string, Resource> };

export function withoutWorkerSandboxEgress<T>(input: T): T {
  const template = input as unknown as Template;
  const steps = Object.keys(template.Resources).filter((id) => /^SessionsSteps[0-9A-F]{8}$/u.test(id) && template.Resources[id]!.Type === "AWS::Lambda::Function");
  expect(steps, "one session steps function").toHaveLength(1);
  const variables = (template.Resources[steps[0]!]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  if (template.Parameters?.WorkerSandboxEgress === undefined) {
    expect(variables).not.toHaveProperty("ROVARA_WORKER_SANDBOX_EGRESS");
    return input;
  }
  expect(template.Parameters.WorkerSandboxEgress).toMatchObject({ Type: "String", Default: "bridge", AllowedValues: ["bridge", "gateway"] });
  expect(variables.ROVARA_WORKER_SANDBOX_EGRESS).toEqual({ Ref: "WorkerSandboxEgress" });
  // Nothing else in the template refers to the parameter.
  const users = Object.entries(template.Resources).filter(([, resource]) => JSON.stringify(resource).includes('"Ref":"WorkerSandboxEgress"')).map(([id]) => id);
  expect(users).toEqual(steps);
  delete template.Parameters.WorkerSandboxEgress;
  delete variables.ROVARA_WORKER_SANDBOX_EGRESS;
  return input;
}
