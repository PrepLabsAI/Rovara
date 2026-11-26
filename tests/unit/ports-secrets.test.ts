// Owner decision 60 (item R2): the `secrets` socket. Code's adapter reads the environment, a file and the owner's key file; the model keys and the
// GitHub token are read through it; `keys.json` keeps its permission rule; a `secrets` plug-in replaces Code's.
import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, SecretRefSchema, SecretValue, type SecretRef, type SecretStore } from "@agentx/contracts";
import { createAdapterRegistry, LocalSecretError, asSecretValue, modelKeyReadError, secretsPluginWords, createFileModelKeyStore, createLocalSecretStore, createRegistrySecretStore, createSecretModelKeyStore, SECRET_FILE_MAX_BYTES } from "../../packages/broker/src/ports/index.js";
import { contextSecretReader } from "../../packages/broker/src/plugins/index.js";
import { githubTokenCodeHost } from "../../packages/broker/src/plugins/code-host/github/token-code-host.js";
import { resolveGithubAccess } from "../../packages/broker/src/plugins/code-host/github/token-access.js";
import { runSecretStoreConformance } from "../support/ports/secret-store-conformance.js";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function tempFolder(): Promise<string> {
  // The real path: a link in any part of a secret file's path is refused (and /var is one on a Mac).
  const folder = await realpath(await mkdtemp(join(tmpdir(), "rovara-p4-")));
  folders.push(folder);
  return folder;
}
const value = ["fixture", "p4", "value"].join("-");

/** An in-memory adapter: the kind Cloud's would be (a name -> value map behind `read`). */
function memorySecrets(held: Map<string, string>): SecretStore {
  return {
    async read(_company, ref) {
      if (!SecretRefSchema.safeParse(ref).success) throw new Error("the secret reference is not valid");
      const name = (ref as Record<string, string>).named;
      if (name === undefined) return undefined;
      const found = held.get(name);
      return found === undefined ? undefined : new SecretValue(found);
    },
  };
}

runSecretStoreConformance("memory (a map behind read)", {
  async create() {
    const held = new Map<string, string>();
    const ref = { named: "db-password" };
    return { store: memorySecrets(held), ref, unknownRef: { env: "ANYTHING" }, set: async (_ref, text) => { if (text === undefined) held.delete("db-password"); else held.set("db-password", text); } };
  },
});
runSecretStoreConformance("Code: environment", {
  async create() {
    const environment: Record<string, string | undefined> = {};
    return { store: createLocalSecretStore({ environment }), ref: { env: "P4_SECRET" }, unknownRef: { vault: "x" }, set: async (ref, text) => { environment[ref.env!] = text; } };
  },
});
runSecretStoreConformance("Code: file", {
  async create() {
    const folder = await tempFolder();
    const path = join(folder, "secret");
    return {
      store: createLocalSecretStore({ environment: {} }),
      ref: { file: path },
      unknownRef: { vault: "x" },
      set: async (_ref, text) => { if (text === undefined) await rm(path, { force: true }); else await writeFile(path, text, { mode: 0o600 }); },
    };
  },
});
runSecretStoreConformance("Code: key file entry", {
  async create() {
    const folder = await tempFolder();
    const path = join(folder, "keys.json");
    return {
      store: createLocalSecretStore({ environment: {}, keyFile: createFileModelKeyStore(path) }),
      ref: { key: "anthropic" },
      unknownRef: { vault: "x" },
      set: async (ref, text) => { await writeFile(path, JSON.stringify(text === undefined ? {} : { [ref.key!]: text }), { mode: 0o600 }); },
    };
  },
});

describe("the secrets point", () => {
  it("is a one-adapter point in the registry", () => {
    expect(PLUGIN_POINTS).toContain("secrets");
    expect(PLUGIN_POINT_CARDINALITY.secrets).toBe("one");
  });

  it("takes a reference of exactly one source, in plain words", () => {
    expect(SecretRefSchema.safeParse({ env: "NAME" }).success).toBe(true);
    expect(SecretRefSchema.safeParse({ secretService: "team/name" }).success).toBe(true);
    expect(SecretRefSchema.safeParse({}).success).toBe(false);
    expect(SecretRefSchema.safeParse({ env: "A", file: "/b" }).success).toBe(false);
    expect(SecretRefSchema.safeParse({ Env: "A" }).success).toBe(false);
    expect(SecretRefSchema.safeParse({ env: "" }).success).toBe(false);
  });
});

describe("Code's secrets adapter", () => {
  it("reads a file only when it is a plain, small, owner-only file, and says so in one fixed sentence that quotes nothing", async () => {
    const dir = await tempFolder();
    const store = createLocalSecretStore({ environment: {} });
    const file = join(dir, "secret-file-name");
    await writeFile(file, `${value}\n`, { mode: 0o600 });
    expect((await store.read(IMPLICIT_COMPANY_ID, { file }))?.reveal()).toBe(value);
    await chmod(file, 0o644);
    const loose = await store.read(IMPLICIT_COMPANY_ID, { file }).catch((caught: unknown) => caught as Error);
    expect(loose).toBeInstanceOf(Error);
    expect((loose as Error).message).toMatch(/must not be readable by other users/);
    expect((loose as Error).message).not.toContain(dir);
    expect((loose as Error).message).not.toContain(value);
    await chmod(file, 0o600);
    await symlink(file, join(dir, "link"));
    await expect(store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "link") })).rejects.toThrow(/must not go through a link/);
    await writeFile(join(dir, "big"), "x".repeat(SECRET_FILE_MAX_BYTES + 1), { mode: 0o600 });
    await expect(store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "big") })).rejects.toThrow(/too big/);
    await mkdir(join(dir, "folder"));
    await expect(store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "folder") })).rejects.toThrow(/plain file/);
    expect(await store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "missing") })).toBeUndefined();
    await writeFile(join(dir, "blank"), "  \n", { mode: 0o600 });
    expect(await store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "blank") })).toBeUndefined();
  });

  it("refuses an environment name that is not in capitals and a relative file", async () => {
    const store = createLocalSecretStore({ environment: { lower: value } });
    await expect(store.read(IMPLICIT_COMPANY_ID, { env: "lower" })).rejects.toThrow("the secret reference is not valid");
    await expect(store.read(IMPLICIT_COMPANY_ID, { file: "relative/secret" })).rejects.toThrow("the secret reference is not valid");
    await expect(store.read(IMPLICIT_COMPANY_ID, { key: "Bad Name" })).rejects.toThrow("the secret reference is not valid");
  });

  it("answers a key-file entry only when it has the key file, and holds the key file to its permission rule", async () => {
    const dir = await tempFolder();
    const path = join(dir, "keys.json");
    await writeFile(path, JSON.stringify({ github: value }), { mode: 0o600 });
    expect(await createLocalSecretStore({ environment: {} }).read(IMPLICIT_COMPANY_ID, { key: "github" })).toBeUndefined();
    const store = createLocalSecretStore({ environment: {}, keyFile: createFileModelKeyStore(path) });
    expect((await store.read(IMPLICIT_COMPANY_ID, { key: "github" }))?.reveal()).toBe(value);
    await chmod(path, 0o644);
    await expect(store.read(IMPLICIT_COMPANY_ID, { key: "github" })).rejects.toThrow(/readable by other users/);
  });
});

describe("model keys and the GitHub token are read through the socket", () => {
  /** Records every reference asked, and answers from a map keyed by "kind:value". */
  function spy(answers: Record<string, string>): { store: SecretStore; asked: SecretRef[] } {
    const asked: SecretRef[] = [];
    return {
      asked,
      store: { async read(_company, ref) { asked.push(ref); const [kind, name] = Object.entries(ref)[0]!; const found = answers[`${kind}:${name}`]; return found === undefined ? undefined : new SecretValue(found); } },
    };
  }

  it("reads the stored GitHub token as { key: \"github\" } (the key file alone), then GH_TOKEN, GITHUB_TOKEN, then the GitHub CLI", async () => {
    const { store, asked } = spy({ "key:github": "stored" });
    const access = await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: store, environment: { GH_TOKEN: "from-env" }, gh: async () => "from-cli" });
    expect(access?.source).toBe("key-store");
    expect(access?.token.reveal()).toBe("stored");
    expect(asked).toEqual([{ key: "github" }]);
    const none = spy({});
    expect((await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: none.store, environment: { GITHUB_TOKEN: "t" }, gh: async () => "from-cli" }))?.source).toBe("environment");
    // The model-key store's name for provider github (GITHUB_API_KEY) is not a GitHub sign-in.
    expect(await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: createLocalSecretStore({ environment: { GITHUB_API_KEY: "x" }, keyFile: createFileModelKeyStore("/not-used/keys.json") }), environment: {}, gh: async () => undefined })).toBeUndefined();
  });

  it("builds a model key store on any secrets adapter (the shape Cloud's will use)", async () => {
    const held = new Map([["key-anthropic", "cloud-key"]]);
    const keys = createSecretModelKeyStore({ secrets: memorySecrets(held), refs: (provider) => [{ named: `key-${provider}` }], providers: ["anthropic"] });
    expect((await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))?.reveal()).toBe("cloud-key");
    expect(await keys.get(IMPLICIT_COMPANY_ID, "openai")).toBeUndefined();
    expect(await keys.providers(IMPLICIT_COMPANY_ID)).toEqual(["anthropic"]);
  });
});

describe("a plug-in reads its secrets through the registry's adapter", () => {
  it("asks the registry on every read, so an adapter registered later is the one used; with none, Code's own reads the environment", async () => {
    const registry = createAdapterRegistry();
    const context = { registry, defaultCompanyId: IMPLICIT_COMPANY_ID };
    const read = contextSecretReader(context, { env: "P4_HOOK_SECRET" }, { P4_HOOK_SECRET: "from-env" });
    expect(await read()).toBe("from-env");
    registry.register("secrets", "custom", memorySecrets(new Map()), { isDefault: true });
    await expect(read()).rejects.toThrow("the secret is not available");
    const registrySide = createRegistrySecretStore(registry);
    expect(await registrySide.read(IMPLICIT_COMPANY_ID, { env: "P4_HOOK_SECRET" })).toBeUndefined();
  });

  it("answers undefined before any adapter is registered", async () => {
    expect(await createRegistrySecretStore(createAdapterRegistry()).read(IMPLICIT_COMPANY_ID, { env: "ANY" })).toBeUndefined();
  });
});

describe("a {file} secret (review L5, L2, L7)", () => {
  const store = createLocalSecretStore({ environment: {} });
  const refused = async (file: string): Promise<Error> => {
    const error = await store.read(IMPLICIT_COMPANY_ID, { file }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalSecretError);
    return error as Error;
  };

  it("refuses a link in ANY part of the path, not only the last", async () => {
    const dir = await tempFolder();
    await mkdir(join(dir, "real"));
    await writeFile(join(dir, "real", "secret"), value, { mode: 0o600 });
    await symlink(join(dir, "real"), join(dir, "alias"));
    expect((await store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "real", "secret") }))?.reveal()).toBe(value);
    expect((await refused(join(dir, "alias", "secret"))).message).toMatch(/must not go through a link/);
  });

  it("refuses a file that belongs to someone else", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const dir = await tempFolder();
    const file = join(dir, "secret");
    await writeFile(file, value, { mode: 0o600 });
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
    expect((await refused(file)).message).toBe("the secret file must belong to you");
  });

  it("takes a file of exactly the cap and refuses one byte more", async () => {
    const dir = await tempFolder();
    await writeFile(join(dir, "exact"), "x".repeat(SECRET_FILE_MAX_BYTES), { mode: 0o600 });
    await writeFile(join(dir, "over"), "x".repeat(SECRET_FILE_MAX_BYTES + 1), { mode: 0o600 });
    expect((await store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "exact") }))?.reveal().length).toBe(SECRET_FILE_MAX_BYTES);
    expect((await refused(join(dir, "over"))).message).toBe("the secret file is too big");
  });

  it("reads at most the cap plus one byte: a file that grows after the size check is refused", async () => {
    const dir = await tempFolder();
    const file = join(dir, "secret");
    await writeFile(file, "small", { mode: 0o600 });
    // The size check sees 5 bytes; the read then returns more than the cap (as a file that grew in between would).
    const probe = await open(file);
    const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const asked: number[] = [];
    vi.spyOn(proto, "read").mockImplementation(async (...args: unknown[]) => {
      const [buffer, offset, length] = args as [Buffer, number, number];
      asked.push(length);
      buffer.fill(0x78, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    expect((await refused(file)).message).toBe("the secret file is too big");
    expect(asked[0]).toBe(SECRET_FILE_MAX_BYTES + 1);
  });

  it("refuses a pipe and a device without waiting on them", async () => {
    if (process.platform === "win32") return;
    const dir = await tempFolder();
    const pipe = join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);
    expect((await refused(pipe)).message).toBe("the secret file must be a plain file");
    expect((await refused("/dev/null")).message).toBe("the secret file must be a plain file");
  });

  it("never quotes the path or the content, in the message, the inspected error or its cause, and keeps only a system error code", async () => {
    const dir = await tempFolder();
    const secretName = "distinct-secret-file-name";
    const file = join(dir, secretName);
    await writeFile(file, value, { mode: 0o600 });
    const cases: string[] = [];
    await chmod(file, 0o644);
    cases.push(file);
    const noRead = join(dir, `${secretName}-noread`);
    await writeFile(noRead, value, { mode: 0o000 });
    cases.push(noRead);
    await symlink(file, join(dir, `${secretName}-link`));
    cases.push(join(dir, `${secretName}-link`));
    await writeFile(join(dir, `${secretName}-big`), "x".repeat(SECRET_FILE_MAX_BYTES + 1), { mode: 0o600 });
    cases.push(join(dir, `${secretName}-big`));
    for (const path of cases) {
      const error = await refused(path);
      for (const text of [error.message, inspect(error), String(error.stack ?? ""), JSON.stringify({ ...error })]) {
        expect(text).not.toContain(secretName);
        expect(text).not.toContain(dir);
        expect(text).not.toContain(value);
      }
      expect(error.cause).toBeUndefined();
    }
    if (process.getuid?.() !== 0) expect(((await refused(noRead)) as LocalSecretError).code).toBe("EACCES");
  });
});

describe("what an adapter answers is always a SecretValue (review L3)", () => {
  it("wraps an object that has reveal(), refuses a bare string, and passes a SecretValue through", async () => {
    const registry = createAdapterRegistry();
    let answer: unknown;
    registry.register("secrets", "loose", { read: async () => answer as never }, { isDefault: true });
    const store = createRegistrySecretStore(registry);
    answer = { reveal: () => value, extra: "visible" };
    const wrapped = await store.read(IMPLICIT_COMPANY_ID, { env: "ANY" });
    expect(wrapped).toBeInstanceOf(SecretValue);
    expect(inspect(wrapped)).not.toContain(value);
    expect(JSON.stringify({ wrapped })).not.toContain(value);
    answer = value;
    await expect(store.read(IMPLICIT_COMPANY_ID, { env: "ANY" })).rejects.toThrow("the secrets adapter gave an answer that is not a secret value");
    const real = new SecretValue(value);
    answer = real;
    expect(await store.read(IMPLICIT_COMPANY_ID, { env: "ANY" })).toBe(real);
    answer = undefined;
    expect(await store.read(IMPLICIT_COMPANY_ID, { env: "ANY" })).toBeUndefined();
    expect(asSecretValue(null)).toBeUndefined();
  });

  it("answers a bare string from a plug-in with the fixed sentence through contextSecretReader, not a TypeError", async () => {
    const registry = createAdapterRegistry();
    registry.register("secrets", "bare", { read: async () => value as never }, { isDefault: true });
    const error = await contextSecretReader({ registry, defaultCompanyId: IMPLICIT_COMPANY_ID }, { env: "X" })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).message).toBe("the secret is not available");
  });

  it("also masks a plug-in's loose answer on the model-key and plug-in-setting paths", async () => {
    const loose: SecretStore = { read: async () => ({ reveal: () => value }) as never };
    const keys = createSecretModelKeyStore({ secrets: loose, refs: () => [{ env: "X" }], providers: ["anthropic"] });
    expect(inspect(await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))).toBe("[secret]");
    expect(await keys.providers(IMPLICIT_COMPANY_ID)).toEqual(["anthropic"]);
    const registry = createAdapterRegistry();
    registry.register("secrets", "loose", loose, { isDefault: true });
    expect(await contextSecretReader({ registry, defaultCompanyId: IMPLICIT_COMPANY_ID }, { env: "X" })()).toBe(value);
  });
});

describe("the owner is shown fixed words when the model keys cannot be read from a plug-in (round 3)", () => {
  it("keeps Code's own fixed sentence, replaces any other text, and names the plug-in", () => {
    const own = new LocalSecretError("the model key file must not be readable by other users (chmod 600)");
    expect(modelKeyReadError(own, undefined)).toBe(own);
    const replaced = modelKeyReadError(new Error("arn:aws:example:::secret/leaky"), 'the "svc" secrets plug-in');
    expect(replaced).toBeInstanceOf(LocalSecretError);
    expect(replaced.message).toBe('the model keys could not be read from the "svc" secrets plug-in');
    expect(modelKeyReadError("a string", undefined).message).toBe("the model keys could not be read from the secrets adapter");
  });

  it("names a plug-in other than Code's own, and nothing for Code's", () => {
    const registry = createAdapterRegistry();
    expect(secretsPluginWords(registry)).toBeUndefined();
    registry.register("secrets", "local", memorySecrets(new Map()), { isDefault: true });
    expect(secretsPluginWords(registry)).toBeUndefined();
    const other = createAdapterRegistry();
    other.register("secrets", "svc", memorySecrets(new Map()));
    expect(secretsPluginWords(other)).toBe('the "svc" secrets plug-in');
  });
});

describe("the GitHub token read through a plug-in (review L1)", () => {
  const host = (secrets: SecretStore, extra: Record<string, unknown> = {}) => githubTokenCodeHost({
    companyId: IMPLICIT_COMPANY_ID, secrets, environment: {}, gh: async () => undefined, registeredRepositories: () => [], ...extra,
  });

  it("shows a fixed sentence naming the kind of source, never the plug-in's own text, and does not blame keys.json", async () => {
    const leaky = "arn:aws:example:::secret/some-name-and-content";
    const broken: SecretStore = { read: async () => { throw new Error(leaky); } };
    const found = await host(broken).resolveCredentials!();
    expect(found.found).toBe(false);
    const checked = await host(broken).checkAccess!();
    for (const text of [JSON.stringify(found), JSON.stringify(checked)]) {
      expect(text).not.toContain(leaky);
      expect(text).not.toContain("chmod");
      expect(text).not.toContain("keys.json");
    }
    expect(found.summary).toBe("the secrets adapter could not read the GitHub token (source kind: key)");
  });

  it("still shows Code's own key file sentence with the chmod fix, and names the plug-in as the source when one answers", async () => {
    const dir = await tempFolder();
    const path = join(dir, "keys.json");
    await writeFile(path, "{}", { mode: 0o644 });
    const local = await githubTokenCodeHost({ companyId: IMPLICIT_COMPANY_ID, secrets: createLocalSecretStore({ environment: {}, keyFile: createFileModelKeyStore(path) }), environment: {}, keyFilePath: path, registeredRepositories: () => [] }).resolveCredentials!();
    expect(local.summary).toMatch(/readable by other users/);
    expect(local.fix).toContain(`chmod 600 ${path}`);
    const answering: SecretStore = { read: async () => new SecretValue("t") };
    const named = await host(answering, { secretsWords: 'the "svc" secrets plug-in' }).resolveCredentials!();
    expect(named.found).toBe(true);
    expect(named.summary).toContain('the "svc" secrets plug-in');
  });
});
