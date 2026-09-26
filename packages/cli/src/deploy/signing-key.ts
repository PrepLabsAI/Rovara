// The control plane's callback signing key: a per-environment secret the deploy orchestrator reads
// (creating it on first use) and passes to the control-plane stack as the CallbackSigningKey
// parameter. Never logged, never returned in an error message: callers of `callbackSigningKey` get
// only the value itself, to hold in memory for the length of one deploy.
import { randomBytes } from "node:crypto";
import { CreateSecretCommand, GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** The number of random bytes in a freshly created callback signing key (before base64url encoding). */
const CALLBACK_SIGNING_KEY_BYTES = 48;

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/** What `callbackSigningKey` needs from Secrets Manager. */
export interface SecretValueStore {
  /** The secret's current value, or undefined when it does not exist. */
  get(name: string): Promise<string | undefined>;
  /** Creates the secret with this value. The caller has already checked it does not exist. */
  create(name: string, value: string): Promise<void>;
}

/** Reads and creates plain-string secrets with Secrets Manager. */
export function secretsManagerValueStore(client: SecretsManagerClient): SecretValueStore {
  return {
    async get(name) {
      try {
        const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: name }));
        return SecretString;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        throw error;
      }
    },
    async create(name, value) {
      await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    },
  };
}

/** `agentx/<env>/callback-signing-key`, exactly as the control-plane stack's operator guide names it. */
export function callbackSigningKeySecretName(env: string): string {
  return `agentx/${env}/callback-signing-key`;
}

/**
 * The environment's callback signing key, creating it (48 random bytes, base64url) the first time
 * it is needed. Never logs or prints the value.
 */
export async function callbackSigningKey(store: SecretValueStore, env: string): Promise<string> {
  const name = callbackSigningKeySecretName(env);
  const existing = await store.get(name);
  if (existing !== undefined) return existing;
  const value = randomBytes(CALLBACK_SIGNING_KEY_BYTES).toString("base64url");
  await store.create(name, value);
  return value;
}
