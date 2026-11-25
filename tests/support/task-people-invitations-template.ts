import { expect } from "vitest";

type Resource = { Type: string; Properties?: Record<string, unknown> };

const PUBLIC = { name: "TaskPeoplePublicInvitationsEnabled", code: "tu", description: "Whether task people may invite members to public channels in this environment" };
const PRIVATE = { name: "TaskPeoplePrivateInvitationsEnabled", code: "tv", description: "Whether task people may invite members to private channels in this environment" };

/**
 * F1 lane L1a-1 deleted the two dead invitation switches: the CloudFormation parameters TaskPeoplePublicInvitationsEnabled and TaskPeoplePrivateInvitationsEnabled (default "false", true/false,
 * nothing in the broker read either) and their two packed broker settings (`tu`, `tv`, in the broker's AGENTX_SETTINGS right after SlackTeamId's `tm` piece).
 *
 * This is the INVERSE of the other strippers in this folder (Rule D): it PUTS BACK exactly those two parameters and those two settings, so every pin and snapshot recorded before L1a-1 holds
 * unchanged on the template with them put back. The old pins prove the delta is exactly this; the full-template pins moved and say so where they are.
 * It asserts the shape it relies on (the new template has neither parameter and neither piece, the role-change switch it sits next to is there) and the shape it adds.
 */
export function withTaskPeopleInvitationSwitches<T>(input: T): T {
  const copy = structuredClone(input);
  const template = copy as unknown as { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource> };
  expect(template.Parameters).toHaveProperty("TaskPeopleChangesEnabled");
  for (const each of [PUBLIC, PRIVATE]) expect(template.Parameters, `${each.name} is deleted`).not.toHaveProperty(each.name);

  // The parameters stood right after TaskPeopleChangesEnabled, defined as it is.
  const changes = template.Parameters.TaskPeopleChangesEnabled!;
  expect(changes).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
  const rebuilt: Record<string, Record<string, unknown>> = {};
  for (const [name, parameter] of Object.entries(template.Parameters)) {
    rebuilt[name] = parameter;
    if (name === "TaskPeopleChangesEnabled") for (const each of [PUBLIC, PRIVATE]) rebuilt[each.name] = { ...changes, Description: each.description };
  }
  template.Parameters = rebuilt;

  // The broker's packed settings: one Fn::Join in AGENTX_SETTINGS; the two pieces stood right after SlackTeamId's `tm` piece (the pieces are in code order: tc, td, ti, tm, tu, tv, wd; a later
  // piece, `wd`, may have been taken out by another stripper, so the anchor is `tm`).
  const brokers = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::Lambda::Function"
    && JSON.stringify((resource.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables?.AGENTX_SETTINGS ?? "").includes(",tm="));
  expect(brokers).toHaveLength(1);
  const settings = (brokers[0]!.Properties!.Environment as { Variables: { AGENTX_SETTINGS: { "Fn::Join": [string, unknown[]] } } }).Variables.AGENTX_SETTINGS["Fn::Join"][1];
  const tm = settings.findIndex((piece, at) => typeof piece === "object" && JSON.stringify(piece) === JSON.stringify({ Ref: "SlackTeamId" }) && typeof settings[at - 1] === "string" && (settings[at - 1] as string).endsWith(",tm="));
  expect(tm).toBeGreaterThan(0);
  expect(JSON.stringify(settings)).not.toMatch(/"[^"]*,t[uv]=/u);
  settings.splice(tm + 1, 0, `,${PUBLIC.code}=`, { Ref: PUBLIC.name }, `,${PRIVATE.code}=`, { Ref: PRIVATE.name });
  return copy;
}
