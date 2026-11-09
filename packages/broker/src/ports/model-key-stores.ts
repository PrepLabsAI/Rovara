// Port lane W0: Code's model key stores. They read keys from the environment or from a local file; Cloud adapts the port to its
// secret store and model proxy. A key is a `SecretValue`, so it cannot be logged by accident.
import { readFile, stat } from "node:fs/promises";
import { SecretValue, type ModelKeyStore } from "@agentx/contracts";

const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;

/** `ANTHROPIC_API_KEY` for provider `anthropic`, `OPENAI_API_KEY` for `openai`, and so on: the upper-cased name with `_API_KEY`. */
export function environmentVariableFor(provider: string): string {
  return `${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

export function createEnvironmentModelKeyStore(environment: Readonly<Record<string, string | undefined>>, knownProviders: readonly string[]): ModelKeyStore {
  return {
    async get(provider) {
      if (!PROVIDER.test(provider)) return undefined;
      const value = environment[environmentVariableFor(provider)];
      return value === undefined || value.trim() === "" ? undefined : new SecretValue(value.trim());
    },
    async providers() {
      return knownProviders.filter((provider) => {
        const value = environment[environmentVariableFor(provider)];
        return value !== undefined && value.trim() !== "";
      });
    },
  };
}

/**
 * A JSON file of `{"<provider>": "<key>"}`. The file must not be readable by other users (mode 0600 or tighter) on systems that
 * have modes, or it is refused. It is read on every call, so editing the file takes effect at once.
 */
export function createFileModelKeyStore(path: string): ModelKeyStore {
  async function read(): Promise<Record<string, string>> {
    let details;
    try {
      details = await stat(path);
    } catch {
      return {};
    }
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error("the model key file must not be readable by other users (chmod 600)");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the model key file must hold a JSON object");
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "" && PROVIDER.test(entry[0])).map(([provider, key]) => [provider, key.trim()]));
  }
  return {
    async get(provider) {
      const key = (await read())[provider];
      return key === undefined ? undefined : new SecretValue(key);
    },
    async providers() {
      return Object.keys(await read()).sort();
    },
  };
}

/** Tries each store in order: a key in the environment wins over one in the file, or the other way, as the caller orders them. */
export function createLayeredModelKeyStore(stores: readonly ModelKeyStore[]): ModelKeyStore {
  return {
    async get(provider) {
      for (const store of stores) {
        const key = await store.get(provider);
        if (key !== undefined) return key;
      }
      return undefined;
    },
    async providers() {
      return [...new Set((await Promise.all(stores.map((store) => store.providers()))).flat())].sort();
    },
  };
}

/** A store held in memory, for tests and for callers that already have the keys. */
export function createMemoryModelKeyStore(keys: Readonly<Record<string, string>>): ModelKeyStore {
  return {
    async get(provider) {
      const key = keys[provider];
      return key === undefined ? undefined : new SecretValue(key);
    },
    async providers() {
      return Object.keys(keys).sort();
    },
  };
}
