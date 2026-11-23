// Webhook lane W3, Opus review tests: the REAL `hasValue` (secretsManagerInitSecrets) that decides whether `agentx upgrade` / `agentx init` may send GitHub a secret.
// The dedicated-mode tests use an in-memory fake (values.has), so the AWS-facing check itself was untested. It must:
//  - ask DescribeSecret only (never read the value);
//  - say "has a value" only when a version carries AWSCURRENT (the stack creates the slot EMPTY, so "exists" is not enough);
//  - say "no value" only for ResourceNotFoundException; any other failure (access, throttle, network) throws, so the caller FAILS CLOSED and never falls back to
//    re-pushing the App secret's old key over the owner's secret.
import { describe, expect, it } from "vitest";
import { DescribeSecretCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { githubWebhookSecretName } from "@agentx/contracts";
import { secretsManagerInitSecrets } from "../../packages/cli/src/init/context.js";
import { ensureGithubWebhook } from "../../packages/cli/src/github/webhook-setup.js";
import { githubAppSecretName } from "../../packages/cli/src/init/github-app.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const DEDICATED = githubWebhookSecretName("staging");

function client(reply: Record<string, unknown> | { error: string }) {
  const commands: unknown[] = [];
  const fake = {
    send: async (command: unknown) => {
      commands.push(command);
      if ("error" in reply) throw Object.assign(new Error(`${reply.error as string} for the secret`), { name: reply.error });
      return reply;
    },
  };
  return { commands, secrets: secretsManagerInitSecrets(fake as unknown as SecretsManagerClient) };
}

describe("secretsManagerInitSecrets.hasValue (the DescribeSecret-only check behind the upgrade overwrite fix)", () => {
  it("is true only when a version carries AWSCURRENT, and asks DescribeSecret alone (never a value read)", async () => {
    const filled = client({ ARN: "arn", VersionIdsToStages: { v1: ["AWSCURRENT"] } });
    await expect(filled.secrets.hasValue(DEDICATED)).resolves.toBe(true);
    expect(filled.commands).toHaveLength(1);
    expect(filled.commands[0]).toBeInstanceOf(DescribeSecretCommand);
    expect((filled.commands[0] as DescribeSecretCommand).input).toEqual({ SecretId: DEDICATED });
  });

  it.each([
    ["the stack's empty slot (no versions)", { ARN: "arn" }],
    ["an empty version map", { ARN: "arn", VersionIdsToStages: {} }],
    ["only a pending version", { ARN: "arn", VersionIdsToStages: { v1: ["AWSPENDING"] } }],
  ])("is false for %s: existing is not having a value", async (_label, reply) => {
    await expect(client(reply).secrets.hasValue(DEDICATED)).resolves.toBe(false);
  });

  it("is false when the secret does not exist", async () => {
    await expect(client({ error: "ResourceNotFoundException" }).secrets.hasValue(DEDICATED)).resolves.toBe(false);
  });

  it.each(["AccessDeniedException", "ThrottlingException", "InternalServiceError", "TimeoutError"])("throws on %s (never reads it as 'no value')", async (name) => {
    await expect(client({ error: name }).secrets.hasValue(DEDICATED)).rejects.toMatchObject({ name });
  });

  it("an unreadable answer stops ensureGithubWebhook before any GitHub write or App-secret write (fail closed)", async () => {
    const secretId = githubAppSecretName("staging");
    const secrets = memoryInitSecrets({ [secretId]: JSON.stringify({ appId: "123", slug: "s", account: "a", privateKey: TEST_PRIVATE_KEY, webhookSecret: "old-app-json-webhook-secret-".padEnd(48, "o") }) });
    const writes: string[] = [];
    secrets.put = async (name) => { writes.push(name); };
    secrets.hasValue = async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); };
    const api = fakeGitHubApi({ hookUrl: "https://old.example.test/hook" });
    await expect(ensureGithubWebhook({ appJwt: "jwt", api, secrets, secretId, dedicatedSecretId: DEDICATED, webhookUrl: "https://cp.example.test/v1/github/webhooks" })).rejects.toThrow();
    expect(api.hookWrites).toEqual([]);
    expect(writes).toEqual([]);
  });
});
