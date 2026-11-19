// Owner decision 60 (item R2): Code's `secrets` adapter. It reads a secret from the environment, from a file, or from an entry of the owner's key file, and
// answers a `SecretValue`. A message here is a FIXED sentence: it never quotes a path, a variable's value or a file's content (a parse error's text can quote the key).
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, parse, sep } from "node:path";
import { SecretRefSchema, SecretValue, type ModelKeyStore, type SecretRef, type SecretStore } from "@agentx/contracts";
import { LocalSecretError } from "./secret-error.js";

/** The most bytes of a secret file that are read: a signing secret is a few dozen bytes. */
export const SECRET_FILE_MAX_BYTES = 65_536;

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const KEY_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Refuses a path with a link in any part of it. (A system's own links, such as `/var` on a Mac, count: name the real path.)
 * Known window: the parts are checked one by one and the file is opened afterwards, and only the LAST part is opened without following a link, so a directory in the middle that is swapped for a link
 * between the check and the open is followed. That needs someone who can already write inside the owner's own secret folder, and only the owner's config names the path; the check is a guard against
 * a mistake and a stray link, not against that attacker. The file itself is still checked (plain file, owner, mode, size) through the handle that was opened.
 */
async function assertNoLinkInPath(path: string): Promise<void> {
  const parts = path.split(sep).filter((part) => part !== "");
  let walked = parse(path).root;
  for (const part of parts) {
    walked = join(walked, part);
    let details;
    try {
      details = await lstat(walked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new LocalSecretError("the secret file could not be opened (it must be a plain file, not a link)", (error as NodeJS.ErrnoException).code);
    }
    if (details.isSymbolicLink()) throw new LocalSecretError("the secret file's path must not go through a link (name the real path)", "ELOOP");
  }
}

/**
 * A file is held to the model key file's rules and a few more: no link in any part of its path, opened once without following a link, a plain file that belongs to
 * the current user, not readable by other users (on systems that have modes), and small. It is checked and read through the one handle, so it cannot be swapped between the check
 * and the read, and at most the cap plus one byte is read, so a file that grows after the check is still refused. A file that is not there is `undefined`; one that is there and
 * must not be used is a `LocalSecretError` with a fixed sentence (the system error's text quotes the path, so only its code is kept).
 */
export async function readSecretFile(path: string): Promise<SecretValue | undefined> {
  await assertNoLinkInPath(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalSecretError("the secret file could not be opened (it must be a plain file, not a link)", (error as NodeJS.ErrnoException).code);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new LocalSecretError("the secret file must be a plain file");
    if (details.size > SECRET_FILE_MAX_BYTES) throw new LocalSecretError("the secret file is too big");
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw new LocalSecretError("the secret file must belong to you");
      if ((details.mode & 0o077) !== 0) throw new LocalSecretError("the secret file must not be readable by other users (chmod 600)");
    }
    const buffer = Buffer.alloc(SECRET_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > SECRET_FILE_MAX_BYTES) throw new LocalSecretError("the secret file is too big");
    const text = buffer.toString("utf8", 0, length).trim();
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
      if (!parsed.success) throw new LocalSecretError("the secret reference is not valid");
      const [kind, value] = Object.entries(parsed.data)[0] as [string, string];
      switch (kind) {
        case "env": {
          if (!ENVIRONMENT_NAME.test(value)) throw new LocalSecretError("the secret reference is not valid");
          const text = options.environment[value]?.trim();
          return text === undefined || text === "" ? undefined : new SecretValue(text);
        }
        case "file":
          if (!isAbsolute(value)) throw new LocalSecretError("the secret reference is not valid");
          return readSecretFile(value);
        case "key":
          if (!KEY_NAME.test(value)) throw new LocalSecretError("the secret reference is not valid");
          return options.keyFile?.get(companyId, value);
        default:
          return undefined;
      }
    },
  };
}

/**
 * What an adapter answered, as a `SecretValue` (so it prints as `[secret]` wherever it ends up). A plug-in from another copy of the package, or one written without the class, may answer
 * an object with `reveal()`: it is wrapped. Anything else (a bare string, a number) is refused with a fixed sentence, because a bare string would print.
 */
export function asSecretValue(answer: unknown): SecretValue | undefined {
  if (answer === undefined || answer === null) return undefined;
  if (answer instanceof SecretValue) return answer;
  const reveal = (answer as { reveal?: unknown }).reveal;
  if (typeof answer === "object" && typeof reveal === "function") {
    const text: unknown = (reveal as () => unknown).call(answer);
    if (typeof text === "string") return new SecretValue(text);
  }
  throw new LocalSecretError("the secrets adapter gave an answer that is not a secret value");
}

/**
 * A store that asks the registry's `secrets` adapter each time, so the adapter a config names later (and the one the registry is sealed with) is the one used, not the
 * default that was there when the caller was made. Before any adapter is registered it answers `undefined`. Every answer is checked with `asSecretValue`.
 */
export function createRegistrySecretStore(registry: { names(point: "secrets"): string[]; require(point: "secrets"): SecretStore }): SecretStore {
  return {
    async read(companyId, ref) {
      return registry.names("secrets").length === 0 ? undefined : asSecretValue(await registry.require("secrets").read(companyId, ref));
    },
  };
}

/**
 * How to name where the secrets come from when a `secrets` plug-in other than Code's own `local` adapter is registered: `the "<name>" secrets plug-in`; `undefined` for Code's own (the key file and
 * the environment). For words shown to the owner.
 */
export function secretsPluginWords(registry: { names(point: "secrets"): string[] }): string | undefined {
  const name = registry.names("secrets")[0];
  return name === undefined || name === "local" ? undefined : `the "${name}" secrets plug-in`;
}

/** An error from reading model keys as the owner may see it: Code's own fixed sentence as it is, anything else (a plug-in's text may quote a name or content) replaced by a sentence naming the source. */
export function modelKeyReadError(error: unknown, pluginWords: string | undefined): LocalSecretError {
  return error instanceof LocalSecretError ? error : new LocalSecretError(`the model keys could not be read from ${pluginWords ?? "the secrets adapter"}`);
}

export interface SecretModelKeyStoreOptions {
  secrets: SecretStore;
  /** Where a provider's key may be, in order; the first that has one wins. */
  refs(provider: string): readonly SecretRef[];
  /** The providers to ask about when listing: those the store has a key for are listed. Never the keys. A secret store cannot list, so the caller names who to ask. */
  providers: readonly string[];
}

/** A model key store whose reads go through the `secrets` socket (Cloud's adapter later reads its secret service the same way), and whose listing asks the same store. */
export function createSecretModelKeyStore(options: SecretModelKeyStoreOptions): ModelKeyStore {
  const get = async (companyId: string, provider: string) => {
    if (!KEY_NAME.test(provider)) return undefined;
    for (const ref of options.refs(provider)) {
      const value = asSecretValue(await options.secrets.read(companyId, ref));
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    get,
    async providers(companyId) {
      const listed: string[] = [];
      for (const provider of options.providers) if ((await get(companyId, provider)) !== undefined) listed.push(provider);
      return listed.sort();
    },
  };
}
