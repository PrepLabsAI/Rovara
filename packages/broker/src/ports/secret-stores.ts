// Owner decision 60 (item R2): Code's `secrets` adapter. It reads a secret from the environment, from a file, or from an entry of the owner's key file, and
// answers a `SecretValue`. A message here is a FIXED sentence: it never quotes a path, a variable's value or a file's content (a parse error's text can quote the key).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SecretRefSchema, SecretValue, type ModelKeyStore, type SecretRef, type SecretStore } from "@agentx/contracts";

/** The most bytes of a secret file that are read: a signing secret is a few dozen bytes. */
export const SECRET_FILE_MAX_BYTES = 65_536;

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const KEY_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A file is held to the model key file's rules: opened once without following a link, a plain file, not readable by other users (on systems that have modes),
 * and small; it is checked and read through the one handle, so it cannot be swapped between the check and the read. A file that is not there is `undefined`;
 * one that is there and must not be used is an error.
 */
export async function readSecretFile(path: string): Promise<SecretValue | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("the secret file could not be opened (it must be a plain file, not a link)", { cause: error });
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("the secret file must be a plain file");
    if (details.size > SECRET_FILE_MAX_BYTES) throw new Error("the secret file is too big");
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error("the secret file must not be readable by other users (chmod 600)");
    const text = (await handle.readFile("utf8")).trim();
    return text === "" ? undefined : new SecretValue(text);
  } finally {
    await handle.close();
  }
}

export interface LocalSecretStoreOptions {
  /** Where `{ env }` references are read. Read on every call, so a changed variable is picked up. */
  environment: Readonly<Record<string, string | undefined>>;
  /**
   * The key file ALONE (a file store, never the layered model-key store: an environment variable like `GITHUB_API_KEY` must not win over the file).
   * Absent: `{ key }` references are not known and answer `undefined`.
   */
  keyFile?: ModelKeyStore | undefined;
}

/** Code's secrets adapter: `{ env }`, `{ file }` and `{ key }` (an entry of the owner's key file). A kind it does not know answers `undefined`. */
export function createLocalSecretStore(options: LocalSecretStoreOptions): SecretStore {
  return {
    async read(companyId, ref) {
      const parsed = SecretRefSchema.safeParse(ref);
      if (!parsed.success) throw new Error("the secret reference is not valid");
      const [kind, value] = Object.entries(parsed.data)[0] as [string, string];
      switch (kind) {
        case "env": {
          if (!ENVIRONMENT_NAME.test(value)) throw new Error("the secret reference is not valid");
          const text = options.environment[value]?.trim();
          return text === undefined || text === "" ? undefined : new SecretValue(text);
        }
        case "file":
          if (!isAbsolute(value)) throw new Error("the secret reference is not valid");
          return readSecretFile(value);
        case "key":
          if (!KEY_NAME.test(value)) throw new Error("the secret reference is not valid");
          return options.keyFile?.get(companyId, value);
        default:
          return undefined;
      }
    },
  };
}

/**
 * A store that asks the registry's `secrets` adapter each time, so the adapter a config names later (and the one the registry is sealed with) is the one used, not the
 * default that was there when the caller was made. Before any adapter is registered it answers `undefined`.
 */
export function createRegistrySecretStore(registry: { names(point: "secrets"): string[]; require(point: "secrets"): SecretStore }): SecretStore {
  return {
    async read(companyId, ref) {
      return registry.names("secrets").length === 0 ? undefined : registry.require("secrets").read(companyId, ref);
    },
  };
}

export interface SecretModelKeyStoreOptions {
  secrets: SecretStore;
  /** Where a provider's key may be, in order; the first that has one wins. */
  refs(provider: string): readonly SecretRef[];
  /** The providers that have a key. Never the keys. A secret store cannot list, so the caller says. */
  providers(companyId: string): Promise<string[]>;
}

/** A model key store whose reads go through the `secrets` socket (Cloud's adapter later reads its secret service the same way). */
export function createSecretModelKeyStore(options: SecretModelKeyStoreOptions): ModelKeyStore {
  return {
    async get(companyId, provider) {
      if (!KEY_NAME.test(provider)) return undefined;
      for (const ref of options.refs(provider)) {
        const value = await options.secrets.read(companyId, ref);
        if (value !== undefined) return value;
      }
      return undefined;
    },
    providers: (companyId) => options.providers(companyId),
  };
}
