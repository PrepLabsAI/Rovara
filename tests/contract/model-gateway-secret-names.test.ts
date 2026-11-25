// The model gateway's provider key secrets: CloudFormation generates their names by default (a fixed name stays reserved after a
// failed create and blocks the re-create); `-c rovaraModelGatewayProviderSecretNames=fixed` keeps the original fixed names for an
// environment that was deployed with them (a name change replaces a secret, and the replacement starts as a placeholder).
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, providerSecretName, providerSecretNamesMode } from "../../infra/lib/model-gateway.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
type Statement = { Sid?: string; Condition?: Record<string, Record<string, unknown>> };

function synth(extra: Record<string, unknown> = {}) {
  const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "staging", agentxRegion: "us-west-2", ...extra });
  const json = Template.fromStack(app.node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown; Description: string }> };
  const entries = Object.entries(json.Resources);
  const secrets = entries.filter(([, each]) => each.Type === "AWS::SecretsManager::Secret");
  const keyPolicy = (entries.find(([, each]) => each.Type === "AWS::KMS::Key" && JSON.stringify(each.Properties.KeyPolicy).includes("OnlyGatewayReads"))![1].Properties.KeyPolicy as { Statement: Statement[] }).Statement;
  const patterns = keyPolicy.map((each) => each.Condition?.["StringLike"]?.["kms:EncryptionContext:SecretARN"]).filter((each) => each !== undefined);
  return { json, secrets, patterns };
}
const tail = (pattern: unknown) => ((pattern as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1]).at(-1);

describe("model gateway provider secret names", () => {
  it("lets CloudFormation generate the names by default, and tells the operator the ARN to put the key in", () => {
    const { json, secrets, patterns } = synth();
    expect(secrets).toHaveLength(1);
    for (const [, secret] of secrets) {
      expect(secret.Properties).not.toHaveProperty("Name");
      expect(secret.DeletionPolicy).toBe("Retain");
    }
    expect(json.Outputs["ProviderKeySecrets"]!.Value).toEqual({ Ref: secrets[0]![0] });
    expect(json.Outputs["ProviderKeySecrets"]!.Description).toMatch(/ARN/u);
    // The key policy cannot name secrets that do not exist yet (they name the key): every secret of the account and Region.
    expect(patterns).toHaveLength(3);
    for (const pattern of patterns) expect(tail(pattern)).toBe(":secret:*");
    // Only the SecretARN pattern differs between modes: the principal and version conditions stay.
    const strip = (mode: Record<string, unknown>) => JSON.stringify(synth(mode).json.Resources).replace(/:secret:[^"]*"/gu, ':secret:X"');
    expect(strip({})).toContain('"aws:PrincipalArn"');
    expect(strip({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" }).match(/"kms:EncryptionContext:SecretVersionId"/gu)).toHaveLength(1);
    expect(strip({}).match(/"kms:EncryptionContext:SecretVersionId"/gu)).toHaveLength(1);
    // "generated" spelled out is the same template.
    expect(synth({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "generated" }).json).toEqual(json);
  });

  it("keeps the original fixed names with fixed, so an environment deployed that way is not replaced", () => {
    const { json, secrets, patterns } = synth({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" });
    expect(secrets.map(([, secret]) => secret.Properties["Name"])).toEqual([providerSecretName("staging", "anthropic")]);
    expect(providerSecretName("staging", "anthropic")).toBe("rovara-cloud/staging/model-gateway/provider/anthropic");
    expect(json.Outputs["ProviderKeySecrets"]!.Value).toBe("rovara-cloud/staging/model-gateway/provider/anthropic");
    expect(patterns).toHaveLength(3);
    for (const pattern of patterns) expect(tail(pattern)).toBe(":secret:rovara-cloud/staging/model-gateway/provider/*");
  });

  it("is the same in both modes everywhere else: the serving role reads the secrets by ARN, the task gets the ARN", () => {
    for (const extra of [{}, { [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: "fixed" }]) {
      const { json, secrets } = synth(extra);
      const text = JSON.stringify(json);
      const ref = secrets[0]![0];
      expect(text).toContain(`"GATEWAY_ANTHROPIC_KEY_SECRET"`);
      expect(text).toContain(`"Value":{"Ref":"${ref}"}`);
      const reads = Object.values(json.Resources).filter((each) => each.Type === "AWS::IAM::Policy")
        .flatMap((each) => (each.Properties["PolicyDocument"] as { Statement: Array<{ Sid?: string; Resource: unknown }> }).Statement)
        .filter((each) => each.Sid === "ReadProviderKeys");
      expect(reads).toEqual([expect.objectContaining({ Resource: { Ref: ref } })]);
    }
  });

  it("refuses any other value", () => {
    expect(providerSecretNamesMode(undefined)).toBe("generated");
    for (const bad of ["on", "Fixed", "", true, 1]) {
      expect(() => providerSecretNamesMode(bad)).toThrow(/must be "fixed" or "generated"/u);
      expect(() => synth({ [MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY]: bad })).toThrow(/must be "fixed" or "generated"/u);
    }
  });
});
