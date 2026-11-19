// L4-HARD (c), owner 2026-11-18: the ChatGPT-token KMS key gets the Deny its sibling keys have (infra/lib/control-plane.ts, named environments only): every use of the key
// (Encrypt, Decrypt, ReEncrypt, GenerateDataKey) is denied to every principal except the broker's role. Each digest or snapshot test that pins the rest of the control-plane template
// asserts this addition exactly, then takes it out (in place), so the pins they hold stay the ones recorded before this change (rule D: removing exactly this gives back the old template).
// The same statement is asserted in full, with its mutants, in tests/contract/chatgpt-key-deny-infrastructure.test.ts. A template with none of it (the legacy deployment, which gets none) is returned as it is.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = { Resources: Record<string, Resource> };
type Statement = Record<string, unknown>;

/** The one Deny statement, as the template holds it, for the key's broker role logical id. */
export function chatGptKeyDenyStatement(brokerRoleId: string): Statement {
  return {
    Sid: "UseOnlyAsBroker", Effect: "Deny", Principal: { AWS: "*" },
    Action: ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"], Resource: "*",
    Condition: { ArnNotEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [brokerRoleId, "Arn"] } } },
  };
}

export function withoutChatGptKeyDeny<T>(input: T): T {
  const resources = (input as unknown as Template).Resources;
  const keys = Object.keys(resources).filter((id) => /^ChatGptConnectionKey[0-9A-F]{8}$/u.test(id) && resources[id]!.Type === "AWS::KMS::Key");
  expect(keys).toHaveLength(1);
  const roles = Object.keys(resources).filter((id) => /^BrokerServiceRole[0-9A-F]{8}$/u.test(id) && resources[id]!.Type === "AWS::IAM::Role");
  expect(roles).toHaveLength(1);
  const statements = (resources[keys[0]!]!.Properties.KeyPolicy as { Statement: Statement[] }).Statement;
  const at = statements.findIndex((s) => s.Sid === "UseOnlyAsBroker");
  if (at === -1) return input;
  expect(statements.filter((s) => s.Sid === "UseOnlyAsBroker")).toHaveLength(1);
  expect(statements[at]).toEqual(chatGptKeyDenyStatement(roles[0]!));
  statements.splice(at, 1);
  return input;
}
