// The callback signing key, read from Secrets Manager. Infrastructure passes a Lambda only the secret's name (CALLBACK_SIGNING_KEY_SECRET_ID), never the key: a secret as a plain
// environment value is readable by anyone who can read the function's configuration. The function reads the secret once per container, with a GetSecretValue its role holds on exactly
// that secret, and keeps it in memory.
//
// Fails closed: a missing setting, an unreadable secret, or a value that is not a string of at least 32 bytes refuses with one fixed message. The message never carries the secret's
// text, the secret's id, or the cause (an SDK error's text), and a failure is not cached, so the next call reads again.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** The variable infrastructure sets: the name (or ARN) of the one secret that holds the key. A role may read exactly that secret. */
export const CALLBACK_SIGNING_KEY_SECRET_VARIABLE = "CALLBACK_SIGNING_KEY_SECRET_ID";
/** The shortest key the broker signs with (the stack's own parameter has always required 32). */
export const CALLBACK_SIGNING_KEY_MIN_BYTES = 32;
/** The only text a failure carries. */
export const CALLBACK_SIGNING_KEY_UNAVAILABLE = "the callback signing key is not available";

/** What the loader needs of a Secrets Manager client. */
export interface CallbackSigningKeyReader {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }>;
}

/** Whether infrastructure gave this function the secret (named environments' reconciler only; the legacy one has none). */
export function callbackSigningKeyWired(env: Record<string, string | undefined>): boolean {
  const secretId = env[CALLBACK_SIGNING_KEY_SECRET_VARIABLE];
  return secretId !== undefined && secretId !== "";
}

function unavailable(): Error {
  return Object.assign(new Error(CALLBACK_SIGNING_KEY_UNAVAILABLE), { name: "CallbackSigningKeyUnavailable" });
}

let loaded: { secretId: string; value: string } | undefined;
let loading: { secretId: string; promise: Promise<string> } | undefined;

/**
 * The key, read once per container. Concurrent calls share one read. `reader` is for tests; production builds a client for this function's own region on its first read.
 */
export async function loadCallbackSigningKey(env: Record<string, string | undefined>, reader?: CallbackSigningKeyReader): Promise<string> {
  const secretId = env[CALLBACK_SIGNING_KEY_SECRET_VARIABLE];
  if (secretId === undefined || secretId.trim() === "" || secretId.length > 2048) throw unavailable();
  if (loaded !== undefined && loaded.secretId === secretId) return loaded.value;
  if (loading !== undefined && loading.secretId === secretId) return loading.promise;
  const client = reader ?? new SecretsManagerClient(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION });
  const promise = (async () => {
    let text: string | undefined;
    try {
      text = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
    } catch {
      throw unavailable();
    }
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < CALLBACK_SIGNING_KEY_MIN_BYTES) throw unavailable();
    loaded = { secretId, value: text };
    return text;
  })();
  const entry = { secretId, promise };
  loading = entry;
  try {
    return await promise;
  } finally {
    if (loading === entry) loading = undefined;
  }
}

/** The key a prior `loadCallbackSigningKey` read. Throws the same fixed refusal when none was read, so code that runs before a load cannot sign with nothing. */
export function loadedCallbackSigningKey(): string {
  if (loaded === undefined) throw unavailable();
  return loaded.value;
}

/** Forgets the container's copy (tests only; a container otherwise keeps it for its life). */
export function forgetCallbackSigningKey(): void {
  loaded = undefined;
  loading = undefined;
}
