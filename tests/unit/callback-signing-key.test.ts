import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLBACK_SIGNING_KEY_SECRET_VARIABLE, CALLBACK_SIGNING_KEY_UNAVAILABLE, forgetCallbackSigningKey, loadCallbackSigningKey, loadedCallbackSigningKey,
  type CallbackSigningKeyReader,
} from "../../packages/broker/src/aws/callback-signing-key.js";

const ARN = "arn:aws:secretsmanager:us-west-2:111122223333:secret:agentx/staging/callback-key-AbCdEf";
const KEY = "k-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJ";
const env = { [CALLBACK_SIGNING_KEY_SECRET_VARIABLE]: ARN, AWS_REGION: "us-west-2" };

function reader(answer: () => Promise<{ SecretString?: string }>): CallbackSigningKeyReader & { commands: GetSecretValueCommand[] } {
  const commands: GetSecretValueCommand[] = [];
  return { commands, async send(command) { commands.push(command); return answer(); } };
}

/** The refusal a promise ends with (a promise that does not refuse fails the test). */
const caught = (promise: Promise<unknown>): Promise<Error> => promise.then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error as Error);

afterEach(() => forgetCallbackSigningKey());

describe("loading the callback signing key from Secrets Manager", () => {
  it("reads exactly the named secret and caches it for the container", async () => {
    const secrets = reader(async () => ({ SecretString: KEY }));
    expect(await loadCallbackSigningKey(env, secrets)).toBe(KEY);
    expect(await loadCallbackSigningKey(env, secrets)).toBe(KEY);
    expect(secrets.commands).toHaveLength(1);
    expect(secrets.commands[0]!.input).toEqual({ SecretId: ARN });
    expect(loadedCallbackSigningKey()).toBe(KEY);
  });

  it("shares one read between concurrent first calls", async () => {
    const secrets = reader(async () => ({ SecretString: KEY }));
    const keys = await Promise.all([loadCallbackSigningKey(env, secrets), loadCallbackSigningKey(env, secrets), loadCallbackSigningKey(env, secrets)]);
    expect(keys).toEqual([KEY, KEY, KEY]);
    expect(secrets.commands).toHaveLength(1);
  });

  it("fails closed when the setting is missing or blank, without reading anything", async () => {
    const secrets = reader(async () => ({ SecretString: KEY }));
    for (const value of [undefined, "", "   "]) {
      await expect(loadCallbackSigningKey({ [CALLBACK_SIGNING_KEY_SECRET_VARIABLE]: value }, secrets)).rejects.toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    }
    await expect(loadCallbackSigningKey({}, secrets)).rejects.toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(secrets.commands).toHaveLength(0);
  });

  it("does not take the key from a plain CALLBACK_SIGNING_KEY value", async () => {
    const secrets = reader(async () => ({ SecretString: KEY }));
    await expect(loadCallbackSigningKey({ CALLBACK_SIGNING_KEY: KEY }, secrets)).rejects.toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(() => loadedCallbackSigningKey()).toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
  });

  it("fails closed when the secret cannot be read, says nothing of the cause, and reads again next time", async () => {
    let calls = 0;
    const secrets = reader(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error(`AccessDeniedException: not allowed to read ${ARN} ${KEY}`), { name: "AccessDeniedException" });
      return { SecretString: KEY };
    });
    const failure = await caught(loadCallbackSigningKey(env, secrets));
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(failure.name).toBe("CallbackSigningKeyUnavailable");
    expect(failure.cause).toBeUndefined();
    expect(`${failure.stack ?? ""}${JSON.stringify(failure)}`).not.toContain(KEY);
    expect(`${failure.stack ?? ""}${JSON.stringify(failure)}`).not.toContain(ARN);
    expect(() => loadedCallbackSigningKey()).toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    expect(await loadCallbackSigningKey(env, secrets)).toBe(KEY);
    expect(secrets.commands).toHaveLength(2);
  });

  it.each([
    ["a missing string (a binary secret)", {}],
    ["an empty string", { SecretString: "" }],
    ["31 bytes", { SecretString: "k".repeat(31) }],
    ["30 bytes in 15 two-byte letters (the length is in bytes, not characters)", { SecretString: "é".repeat(15) }],
  ])("refuses %s, with the fixed message and nothing of the value", async (_name, answer) => {
    const secrets = reader(async () => answer);
    const failure = await caught(loadCallbackSigningKey(env, secrets));
    expect(failure.message).toBe(CALLBACK_SIGNING_KEY_UNAVAILABLE);
    if ("SecretString" in answer && answer.SecretString !== "") expect(failure.message).not.toContain(answer.SecretString);
    expect(() => loadedCallbackSigningKey()).toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
  });

  it("accepts exactly 32 bytes", async () => {
    const secrets = reader(async () => ({ SecretString: "k".repeat(32) }));
    expect(await loadCallbackSigningKey(env, secrets)).toBe("k".repeat(32));
  });

  it("cannot sign before anything was loaded", () => {
    expect(() => loadedCallbackSigningKey()).toThrow(CALLBACK_SIGNING_KEY_UNAVAILABLE);
  });
});
