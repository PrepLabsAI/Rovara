// CORE-DISPATCH-HOOK-SIGNER-20261117 (DEC 254zzz6 D1, rule D proof): the dispatcher's policy question signer is exactly two key-policy Allows on the policy hook key (Sign with the
// signer's algorithm and message type; GetPublicKey), the dispatcher's role added to the key's two existing Denies, and the key's ARN and the install's issuer in the dispatcher's
// environment. Each digest test that pins the rest of a named control plane asserts these exactly, then takes them out in place (the Denies restored to their earlier principals),
// so the pins it holds stay the ones recorded before this change. A template with no policy hook key (the legacy deployment) is returned as it is.
import { expect } from "vitest";

type Statement = { Sid?: string; Condition?: unknown } & Record<string, unknown>;
type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = { Resources: Record<string, Resource> };

const one = (resources: Record<string, Resource>, pattern: RegExp, type: string): string => {
  const found = Object.keys(resources).filter((id) => pattern.test(id) && resources[id]!.Type === type);
  expect(found, String(pattern)).toHaveLength(1);
  return found[0]!;
};

export function withoutDispatcherHookSigner<T>(input: T): T {
  const resources = (input as unknown as Template).Resources;
  const keys = Object.keys(resources).filter((id) => /^DeveloperSignInPolicyHookKey[0-9A-F]{8}$/u.test(id) && resources[id]!.Type === "AWS::KMS::Key");
  expect(keys.length, "at most one policy hook key").toBeLessThanOrEqual(1);
  const dispatcherId = one(resources, /^Dispatcher[0-9A-F]{8}$/u, "AWS::Lambda::Function");
  const variables = (resources[dispatcherId]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  if (keys.length === 0) {
    expect(variables).not.toHaveProperty("POLICY_HOOK_KEY_ARN");
    expect(variables).not.toHaveProperty("DEVELOPER_TOKEN_ISSUER");
    return input;
  }
  const keyId = keys[0]!;
  const role = (pattern: RegExp) => ({ "Fn::GetAtt": [one(resources, pattern, "AWS::IAM::Role"), "Arn"] });
  const broker = role(/^BrokerServiceRole[0-9A-F]{8}$/u);
  const signIn = role(/^DeveloperSignInFunctionServiceRole[0-9A-F]{8}$/u);
  const dispatcher = role(/^DispatcherServiceRole[0-9A-F]{8}$/u);
  const document = resources[keyId]!.Properties.KeyPolicy as { Statement: Statement[] };
  const sid = (name: string) => document.Statement.filter((statement) => statement.Sid === name);
  expect(sid("DispatcherSignsPolicyQuestions")).toEqual([{ Sid: "DispatcherSignsPolicyQuestions", Effect: "Allow", Principal: { AWS: dispatcher }, Action: "kms:Sign", Resource: "*", Condition: { StringEquals: { "kms:SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256", "kms:MessageType": "RAW" } } }]);
  expect(sid("DispatcherReadsPolicyQuestionKey")).toEqual([{ Sid: "DispatcherReadsPolicyQuestionKey", Effect: "Allow", Principal: { AWS: dispatcher }, Action: "kms:GetPublicKey", Resource: "*" }]);
  document.Statement = document.Statement.filter((statement) => statement.Sid !== "DispatcherSignsPolicyQuestions" && statement.Sid !== "DispatcherReadsPolicyQuestionKey");
  const [sign] = sid("SignOnlyAsBroker");
  expect(sign?.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": [broker, dispatcher] } });
  sign!.Condition = { ArnNotEquals: { "aws:PrincipalArn": broker } };
  const [read] = sid("GetPublicKeyOnlyAsBrokerAndDeveloperIdentity");
  expect(read?.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": [broker, signIn, dispatcher] } });
  read!.Condition = { ArnNotEquals: { "aws:PrincipalArn": [broker, signIn] } };
  const signInFunction = one(resources, /^DeveloperSignInFunction[0-9A-F]{8}$/u, "AWS::Lambda::Function");
  expect(variables.POLICY_HOOK_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
  expect(variables.DEVELOPER_TOKEN_ISSUER).toEqual((resources[signInFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables.DEVELOPER_TOKEN_ISSUER);
  delete variables.POLICY_HOOK_KEY_ARN;
  delete variables.DEVELOPER_TOKEN_ISSUER;
  return input;
}
