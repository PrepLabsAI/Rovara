import { describe, expect, it } from "vitest";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  callbackSigningKey, callbackSigningKeySecretName, SecretAlreadyExistsError, secretsManagerValueStore, type SecretValueStore,
} from "../../packages/cli/src/deploy/signing-key.js";

/** An SDK-shaped error: the SDK sets `name` to the service's error code. */
function awsError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A minimal `{ send(command) }` fake keyed on the command's class name, scripted with one reply
 * (a value) or one thrown error per command kind. */
function fakeClient(script: { get?: unknown; create?: unknown }): SecretsManagerClient {
  return {
    async send(command: { constructor: { name: string } }) {
      const name = command.constructor.name;
      if (name === "GetSecretValueCommand") {
        if (!("get" in script)) throw new Error("test setup: no GetSecretValue scripted");
        if (script.get instanceof Error) throw script.get;
        return script.get;
      }
      if (name === "CreateSecretCommand") {
        if (!("create" in script)) throw new Error("test setup: no CreateSecret scripted");
        if (script.create instanceof Error) throw script.create;
        return script.create;
      }
      throw new Error(`unscripted call ${name}`);
    },
  } as unknown as SecretsManagerClient;
}

const NAME = callbackSigningKeySecretName("staging");

describe("secretsManagerValueStore", () => {
  it("returns undefined when the secret does not exist", async () => {
    const store = secretsManagerValueStore(fakeClient({ get: awsError("ResourceNotFoundException") }));
    await expect(store.get(NAME)).resolves.toBeUndefined();
  });

  it("returns the secret's value when it exists", async () => {
    const store = secretsManagerValueStore(fakeClient({ get: { SecretString: "the-value" } }));
    await expect(store.get(NAME)).resolves.toBe("the-value");
  });

  it("re-throws a get error that is not ResourceNotFoundException", async () => {
    const store = secretsManagerValueStore(fakeClient({ get: awsError("AccessDenied", "not authorized to read the secret") }));
    await expect(store.get(NAME)).rejects.toThrow("not authorized to read the secret");
  });

  it("surfaces a typed SecretAlreadyExistsError when the secret already exists, not the raw SDK error", async () => {
    const store = secretsManagerValueStore(fakeClient({ create: awsError("ResourceExistsException", "a secret with this name already exists") }));
    const error = await store.create(NAME, "value").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SecretAlreadyExistsError);
    expect((error as Error).message).not.toContain("a secret with this name already exists");
  });

  it("re-throws a create error that is not ResourceExistsException", async () => {
    const store = secretsManagerValueStore(fakeClient({ create: awsError("AccessDenied", "not authorized to create the secret") }));
    await expect(store.create(NAME, "value")).rejects.toThrow("not authorized to create the secret");
  });
});

describe("callbackSigningKey", () => {
  it("creates the key (48 random bytes, base64url) when it does not exist yet", async () => {
    let created: string | undefined;
    const store: SecretValueStore = {
      async get() {
        return created;
      },
      async create(_name, value) {
        created = value;
      },
    };
    const key = await callbackSigningKey(store, "staging");
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(created).toBe(key);
  });

  it("reuses the existing key without creating one", async () => {
    let createCalls = 0;
    const store: SecretValueStore = {
      async get() {
        return "existing-key-value-1234567890123456";
      },
      async create() {
        createCalls += 1;
      },
    };
    const key = await callbackSigningKey(store, "staging");
    expect(key).toBe("existing-key-value-1234567890123456");
    expect(createCalls).toBe(0);
  });

  it("uses the winning value when another caller created the key first (create races with get)", async () => {
    const winningValue = "winning-value-from-the-other-caller-000000";
    let getCalls = 0;
    const store: SecretValueStore = {
      async get() {
        getCalls += 1;
        // Not there on the first read (which is why we try to create); the other caller's value on
        // the second (after our own create loses the race).
        return getCalls === 1 ? undefined : winningValue;
      },
      async create() {
        throw new SecretAlreadyExistsError(callbackSigningKeySecretName("staging"));
      },
    };
    const key = await callbackSigningKey(store, "staging");
    expect(key).toBe(winningValue);
    expect(getCalls).toBe(2);
  });

  it("surfaces the original error if the winning value cannot be read back after losing the race", async () => {
    const store: SecretValueStore = {
      async get() {
        return undefined;
      },
      async create() {
        throw new SecretAlreadyExistsError(callbackSigningKeySecretName("staging"));
      },
    };
    await expect(callbackSigningKey(store, "staging")).rejects.toBeInstanceOf(SecretAlreadyExistsError);
  });
});
