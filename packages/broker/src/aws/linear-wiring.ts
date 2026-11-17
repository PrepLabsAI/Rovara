// Guided onboarding PR 7: how the hosted broker builds the Linear connection pieces from its environment. Only where all of these are given:
//   - LINEAR_CONNECTION_KEY_ARN  the KMS key that seals each company's Linear tokens (infra/lib/control-plane.ts LinearConnectionKey; only the broker encrypts and decrypts)
//   - the app's settings secret  `<connector secret prefix>linear-oauth-app` (JSON { clientId, clientSecret, webhookSecret, redirectUri }), which the broker's existing
//                                connector-secret read grant already covers; absent or unreadable: connect says "isn't set up" and the webhook answers 503
// The company's tokens are only ever read for the company asking (`linearCompanyApiAccess`), so another company's token is never used for its projects.
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DecryptCommand, EncryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { OrgIdSchema } from "@agentx/contracts";
import { createLinearApiAccess } from "../plugins/tracker/linear/api.js";
import { LinearAppSettingsSchema, LinearConnections, linearAppSecretName, type LinearAppSettings, type LinearSealer } from "./linear-connections.js";
import type { LinearConnectWiring } from "./linear-connect-routes.js";
import type { LinearWebhookWiring } from "./linear-app-webhook.js";

const SETTINGS_CACHE_MS = 300_000;

export function kmsLinearSealer(client: Pick<KMSClient, "send">, keyId: string): LinearSealer {
  return {
    async seal(plain, context) {
      const sealed = await client.send(new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plain, "utf8"), EncryptionContext: context }));
      return Buffer.from(sealed.CiphertextBlob ?? new Uint8Array()).toString("base64");
    },
    async open(sealed, context) {
      const opened = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(sealed, "base64"), EncryptionContext: context }));
      return Buffer.from(opened.Plaintext ?? new Uint8Array()).toString("utf8");
    },
  };
}

/** The app's settings, read when first needed and kept 5 minutes; a missing, unreadable or malformed secret is "not set up" (never its words). */
export function linearAppSettingsReader(secrets: Pick<SecretsManagerClient, "send">, secretName: string, now: () => number = Date.now): () => Promise<LinearAppSettings | undefined> {
  let cached: { value: LinearAppSettings | undefined; at: number } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    let value: LinearAppSettings | undefined;
    try {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretName })) as { SecretString?: string };
      const parsed = LinearAppSettingsSchema.safeParse(JSON.parse(response.SecretString ?? ""));
      value = parsed.success ? parsed.data : undefined;
    } catch { value = undefined; }
    // Only a good read is kept; a failure is tried again next time.
    if (value !== undefined) cached = { value, at: now() };
    return value;
  };
}

export interface LinearCompanyWiring { connect: LinearConnectWiring; webhook: LinearWebhookWiring; connections: LinearConnections }

/** Everything, or nothing when the key is not given (the routes are then unknown and the webhook 404s). */
export function linearCompanyWiring(input: {
  env: NodeJS.ProcessEnv; documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; kms: Pick<KMSClient, "send">; secrets: Pick<SecretsManagerClient, "send">;
  connectorSecretPrefix: string; fetch?: typeof fetch; log: (entry: Record<string, unknown>) => void;
}): LinearCompanyWiring | undefined {
  const keyArn = input.env.LINEAR_CONNECTION_KEY_ARN;
  if (keyArn === undefined || keyArn === "") return undefined;
  const fetchImpl = input.fetch ?? fetch;
  const app = linearAppSettingsReader(input.secrets, linearAppSecretName(input.connectorSecretPrefix));
  const connections = new LinearConnections({ documentClient: input.documentClient, tableName: input.tableName, sealer: kmsLinearSealer(input.kms, keyArn), fetch: fetchImpl, now: Date.now, app, log: input.log });
  return {
    connections,
    connect: { connections, app, fetch: fetchImpl, log: input.log },
    webhook: { connections, app, now: Date.now, log: input.log },
  };
}

/**
 * The Linear tracker's access for ONE company over its OAuth connection: every call sends that company's own access token (`Bearer`), refreshed as needed. The app acts as
 * itself (actor=app), so what it writes is Rovara's own.
 */
export function linearCompanyApiAccess(connections: Pick<LinearConnections, "accessToken">, companyId: string, fetchImpl?: typeof fetch) {
  const company = OrgIdSchema.parse(companyId);
  return createLinearApiAccess({
    apiKey: async () => `Bearer ${await connections.accessToken(company)}`, companyId: company, ownAccountIsRovara: true, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
