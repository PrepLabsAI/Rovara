// The GitHub App credentials as the broker and the plan evidence job build them: one definition, from the same environment
// (GITHUB_APP_CREDENTIAL_REF, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN) and the same secret.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@agentx/contracts";
import { appIdFromSecret, GitHubAppCredentialProvider, isWebhookSecretMissing, privateKeyFromSecret, webhookSecretFromSecret } from "../github-app.js";
import { requiredEnvironment } from "./lambda.js";

export interface GitHubAppCredentials {
  provider: GitHubAppCredentialProvider;
  /** The secret's ARN, for the connector credential registry. */
  privateKeySecretArn: string;
  /**
   * Reads the GitHub webhook HMAC key from the same secret. A copy with no valid key, or `refresh: true`, re-reads the
   * secret (at most once per REREAD_INTERVAL_MS per container), so a key added or changed after the container started is
   * picked up without a redeploy.
   */
  webhookSecret: (options?: { refresh?: boolean }) => Promise<string>;
}

const REREAD_INTERVAL_MS = 30_000;

export function createGitHubAppCredentials(secretsManager: Pick<SecretsManagerClient, "send">): GitHubAppCredentials {
  const privateKeySecretArn = requiredEnvironment("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
  const appIdSetting = process.env.GITHUB_APP_ID ?? "";
  let appSecret: Promise<string> | undefined;
  const loadSecret = (): Promise<string> => {
    appSecret ??= secretsManager.send(new GetSecretValueCommand({
      SecretId: privateKeySecretArn,
    })).then((response) => {
      const secret = response.SecretString ?? (
        response.SecretBinary === undefined
          ? undefined
          : Buffer.from(response.SecretBinary).toString("utf8")
      );
      if (!secret) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty");
      return secret;
    }).catch((error: unknown) => {
      appSecret = undefined;
      // The secret has no version until `agentx init` creates the GitHub App.
      if (error instanceof Error && error.name === "ResourceNotFoundException") {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty; finish agentx init to create the GitHub App");
      }
      throw error;
    });
    return appSecret;
  };
  let app: Promise<{ appId: string; privateKey: string }> | undefined;
  const loadApp = (): Promise<{ appId: string; privateKey: string }> => {
    app ??= loadSecret().then((secret) => ({
      appId: appIdSetting !== "" ? appIdSetting : appIdFromSecret(secret),
      privateKey: privateKeyFromSecret(secret),
    })).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return app;
  };
  // Forced re-reads are spaced out so a stream of unsigned requests cannot hammer Secrets Manager.
  let lastReread: number | undefined;
  const reread = (): Promise<string> => {
    const now = Date.now();
    if (lastReread === undefined || now - lastReread >= REREAD_INTERVAL_MS) {
      lastReread = now;
      appSecret = undefined;
      app = undefined;
    }
    return loadSecret();
  };
  const provider = new GitHubAppCredentialProvider({
    credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
    appId: appIdSetting !== "" ? appIdSetting : async () => (await loadApp()).appId,
    getPrivateKey: () => loadSecret().then(privateKeyFromSecret),
  });
  const webhookSecret = async (options?: { refresh?: boolean }): Promise<string> => {
    if (options?.refresh === true) return webhookSecretFromSecret(await reread());
    try {
      return webhookSecretFromSecret(await loadSecret());
    } catch (error) {
      if (isWebhookSecretMissing(error)) return webhookSecretFromSecret(await reread());
      throw error;
    }
  };
  return { provider, privateKeySecretArn, webhookSecret };
}
