// The callback signing key the way a Lambda gets it: the environment names the secret, and the key is the answer to a GetSecretValue on that name. A test that runs a deployed handler
// (broker.ts) calls this first; nothing here puts the key in the environment.
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { vi } from "vitest";
import { CALLBACK_SIGNING_KEY_SECRET_VARIABLE, forgetCallbackSigningKey } from "../../packages/broker/src/aws/callback-signing-key.js";

export const TEST_CALLBACK_SIGNING_KEY_SECRET_ID = "agentx/staging/callback-key";

/**
 * Names the secret in the environment (vi.stubEnv, undone by vi.unstubAllEnvs) and answers GetSecretValue on any Secrets Manager client with `key`. Returns the reads, so a test can
 * count them. The loader is a module of the broker, so a test that resets modules gets its own copy of the container's cache; this clears the one in the current registry too.
 */
export function stubCallbackSigningKeySecret(key = "c".repeat(64)): { reads: unknown[]; restore: () => void } {
  forgetCallbackSigningKey();
  vi.stubEnv(CALLBACK_SIGNING_KEY_SECRET_VARIABLE, TEST_CALLBACK_SIGNING_KEY_SECRET_ID);
  const reads: unknown[] = [];
  // Only a read of the named secret is answered: any other Secrets Manager read in the handler under test fails the test instead of getting the key.
  const spy = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async (command: { input: { SecretId?: string } }) => {
    reads.push(command.input);
    if (command.input.SecretId !== TEST_CALLBACK_SIGNING_KEY_SECRET_ID) throw new Error("unexpected Secrets Manager read in a test");
    return { SecretString: key };
  }) as never);
  return { reads, restore: () => { spy.mockRestore(); forgetCallbackSigningKey(); } };
}
