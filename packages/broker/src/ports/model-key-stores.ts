// Port lane W0: Code's model key stores. They read keys from the environment or from a local file; Cloud adapts the port to its
// secret store and model proxy. A key is a `SecretValue`, so it cannot be logged by accident.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SecretValue, type ModelKeyStore } from "@agentx/contracts";
import { LocalSecretError } from "./secret-error.js";

const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;

/** `ANTHROPIC_API_KEY` for provider `anthropic`, `OPENAI_API_KEY` for `openai`, and so on: the upper-cased name with `_API_KEY`. */
export function environmentVariableFor(provider: string): string {
  return `${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

/** The providers whose environment variable keeps its long-standing name. */
export const BUILTIN_KEY_PROVIDERS: readonly string[] = ["anthropic", "openai", "openrouter"];

/**
 * The environment variable a model provider's key is read from: the long-standing `<PROVIDER>_API_KEY` for the three built-ins, and `ROVARA_MODEL_<ID>_API_KEY` for any other provider id, so a
 * provider a plug-in brings (say one called `linear`) can never read another component's variable (`LINEAR_API_KEY`).
 */
export function modelKeyVariable(provider: string): string {
  return BUILTIN_KEY_PROVIDERS.includes(provider) ? environmentVariableFor(provider) : `ROVARA_MODEL_${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

export function createEnvironmentModelKeyStore(environment: Readonly<Record<string, string | undefined>>, knownProviders: readonly string[], variableFor: (provider: string) => string = environmentVariableFor): ModelKeyStore {
  return {
    async get(_companyId, provider) {
      if (!PROVIDER.test(provider)) return undefined;
      const value = environment[variableFor(provider)];
      return value === undefined || value.trim() === "" ? undefined : new SecretValue(value.trim());
    },
    async providers() {
      return knownProviders.filter((provider) => {
        const value = environment[variableFor(provider)];
        return value !== undefined && value.trim() !== "";
      });
    },
  };
}

/**
 * A JSON file of `{"<provider>": "<key>"}`. The file must not be readable by other users (mode 0600 or tighter) on systems that
 * have modes, and must not be a link, or it is refused. It is opened once and checked and read through that one handle, so the file
 * cannot be swapped between the check and the read. It is read on every call, so editing the file takes effect at once. Errors say
 * nothing about the content: a parse error's text can quote the key.
 */
export function createFileModelKeyStore(path: string): ModelKeyStore {
  async function read(): Promise<Record<string, string>> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new LocalSecretError("the model key file could not be opened (it must be a plain file, not a link)", (error as NodeJS.ErrnoException).code);
    }
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new LocalSecretError("the model key file must be a plain file");
      if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new LocalSecretError("the model key file must not be readable by other users (chmod 600)");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch {
        throw new LocalSecretError("the model key file is not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new LocalSecretError("the model key file must hold a JSON object");
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "" && PROVIDER.test(entry[0])).map(([provider, key]) => [provider, key.trim()]));
    } finally {
      await handle.close();
    }
  }
  return {
    async get(_companyId, provider) {
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
    async get(companyId, provider) {
      for (const store of stores) {
        const key = await store.get(companyId, provider);
        if (key !== undefined) return key;
      }
      return undefined;
    },
    async providers(companyId) {
      return [...new Set((await Promise.all(stores.map((store) => store.providers(companyId)))).flat())].sort();
    },
  };
}

/** A store held in memory, for tests and for callers that already have the keys. */
export function createMemoryModelKeyStore(keys: Readonly<Record<string, string>>): ModelKeyStore {
  return {
    async get(_companyId, provider) {
      const key = keys[provider];
      return key === undefined ? undefined : new SecretValue(key);
    },
    async providers() {
      return Object.keys(keys).sort();
    },
  };
}
