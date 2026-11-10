// Owner decision 60 (item R2): the `secrets` socket. Code's adapter reads the environment, a file and the owner's key file; the model keys and the
// laptop GitHub token are read through it; `keys.json` keeps working, with its permission rule; a `secrets` plug-in replaces Code's.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, SecretRefSchema, SecretValue, type SecretRef, type SecretStore } from "@agentx/contracts";
import { createAdapterRegistry, createFileModelKeyStore, createLocalSecretStore, createRegistrySecretStore, createSecretModelKeyStore, SECRET_FILE_MAX_BYTES } from "../../packages/broker/src/ports/index.js";
import { contextSecretReader } from "../../packages/broker/src/plugins/index.js";
import { createLocalModelKeyStore, createLocalSecrets } from "../../packages/broker/src/local/runtime.js";
import { resolveGithubAccess } from "../../packages/broker/src/plugins/code-host/github/token-access.js";
import { runSecretStoreConformance } from "../support/ports/secret-store-conformance.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function tempFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "rovara-p4-"));
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
    await expect(store.read(IMPLICIT_COMPANY_ID, { file: join(dir, "link") })).rejects.toThrow(/plain file, not a link/);
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

describe("the model keys and the GitHub token are read through the socket", () => {
  /** Records every reference asked, and answers from a map keyed by "kind:value". */
  function spy(answers: Record<string, string>): { store: SecretStore; asked: SecretRef[] } {
    const asked: SecretRef[] = [];
    return {
      asked,
      store: { async read(_company, ref) { asked.push(ref); const [kind, name] = Object.entries(ref)[0]!; const found = answers[`${kind}:${name}`]; return found === undefined ? undefined : new SecretValue(found); } },
    };
  }

  it("asks the environment reference first and the key file entry second, and keeps the environment first", async () => {
    const { store, asked } = spy({ "key:openai": "from-file", "env:ANTHROPIC_API_KEY": "from-env", "key:anthropic": "from-file-too" });
    const keys = createLocalModelKeyStore("/not-used", {}, store);
    expect((await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))?.reveal()).toBe("from-env");
    expect(asked).toEqual([{ env: "ANTHROPIC_API_KEY" }]);
    asked.length = 0;
    expect((await keys.get(IMPLICIT_COMPANY_ID, "openai"))?.reveal()).toBe("from-file");
    expect(asked).toEqual([{ env: "OPENAI_API_KEY" }, { key: "openai" }]);
    expect(await keys.get(IMPLICIT_COMPANY_ID, "Not A Provider!")).toBeUndefined();
    expect(String(await keys.get(IMPLICIT_COMPANY_ID, "openai"))).toBe("[secret]");
  });

  it("keeps keys.json working with its owner-only rule, and lists the providers of the environment and the file", async () => {
    const state = await tempFolder();
    await writeFile(join(state, "keys.json"), JSON.stringify({ openai: "from-file", github: "gh-from-file" }), { mode: 0o600 });
    const keys = createLocalModelKeyStore(state, { ANTHROPIC_API_KEY: "from-env" });
    expect((await keys.get(IMPLICIT_COMPANY_ID, "openai"))?.reveal()).toBe("from-file");
    expect((await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))?.reveal()).toBe("from-env");
    expect(await keys.providers(IMPLICIT_COMPANY_ID)).toEqual(["anthropic", "github", "openai"]);
    await chmod(join(state, "keys.json"), 0o644);
    await expect(keys.get(IMPLICIT_COMPANY_ID, "openai")).rejects.toThrow(/readable by other users/);
    // An environment key still answers without touching the loose file, as before.
    expect((await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))?.reveal()).toBe("from-env");
  });

  it("reads the stored GitHub token as { key: \"github\" } (the key file alone), then GH_TOKEN, GITHUB_TOKEN, then the GitHub CLI", async () => {
    const { store, asked } = spy({ "key:github": "stored" });
    const access = await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: store, environment: { GH_TOKEN: "from-env" }, gh: async () => "from-cli" });
    expect(access?.source).toBe("key-store");
    expect(access?.token.reveal()).toBe("stored");
    expect(asked).toEqual([{ key: "github" }]);
    const none = spy({});
    expect((await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: none.store, environment: { GITHUB_TOKEN: "t" }, gh: async () => "from-cli" }))?.source).toBe("environment");
    // The model-key store's name for provider github (GITHUB_API_KEY) is not a GitHub sign-in.
    expect(await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, secrets: createLocalSecrets("/not-used", { GITHUB_API_KEY: "x" }), environment: {}, gh: async () => undefined })).toBeUndefined();
  });

  it("builds a model key store on any secrets adapter (the shape Cloud's will use)", async () => {
    const held = new Map([["key-anthropic", "cloud-key"]]);
    const keys = createSecretModelKeyStore({ secrets: memorySecrets(held), refs: (provider) => [{ named: `key-${provider}` }], providers: async () => ["anthropic"] });
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
