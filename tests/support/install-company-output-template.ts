import { expect } from "vitest";

type Template = { Resources: Record<string, { Type: string }>; Outputs?: Record<string, unknown> };

/**
 * #1612 (Rule D): the install's company step (init and upgrade) adds ONE thing to a control plane, and nothing else: the output DeveloperSignInTableName, the developer
 * sign-in table's name, so the CLI can reach that table with the operator's own credentials. It is checked here to be exactly that, then taken out, so every pin recorded
 * before it still holds. Takes it out of `input` itself (like the other withoutX helpers) and returns it.
 */
export function withoutDeveloperSignInTableOutput<T>(input: T): T {
  const template = input as Template;
  const tables = Object.keys(template.Resources).filter((id) => id.startsWith("DeveloperSignInTable") && template.Resources[id]!.Type === "AWS::DynamoDB::Table");
  expect(tables).toHaveLength(1);
  expect(template.Outputs?.["DeveloperSignInTableName"]).toStrictEqual({ Value: { Ref: tables[0] } });
  delete template.Outputs!["DeveloperSignInTableName"];
  return input;
}

/** The normalized template with the output taken out of a control plane (the one stack that has it). */
export function withoutInstallCompanyOutput<T>(stackName: string, template: T): T {
  return stackName === "AgentXControlPlane" || /^agentx-[a-z0-9-]+-control-plane$/u.test(stackName) ? withoutDeveloperSignInTableOutput(template) : template;
}
