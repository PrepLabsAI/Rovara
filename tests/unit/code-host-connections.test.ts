// Port lane P2, item C2 (decision 60): several code host connections of one provider, each with a name, and ONE default connection per provider used when a repository names none.
import { describe, expect, it } from "vitest";
import { ProjectDefinitionSchema, type CodeHost } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { AMBIGUOUS_CONNECTION_MESSAGE, TWO_DEFAULT_CONNECTIONS_MESSAGE, connectionProblems, defaultConnectionOf, providerOf } from "../../packages/broker/src/plugins/code-host/connections.js";
import { NO_HOST_MESSAGE, assertRepositoryHostsKnown, codeHostForKind, codeHostForRecord } from "../../packages/broker/src/plugins/routing.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { githubCodeHostPlugin } from "../../packages/broker/src/plugins/code-host/github/plugin.js";
import { registryRepositoryResolver } from "../../packages/broker/src/core/merge/resolver.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { GITHUB_REPO_URL, GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";

const fakeModel = () => new FakeHostModel({ url: "https://git.examplehost.test/acme/app", id: "1", fullName: "acme/app" });

/** A connection: the fake host under a name, of a provider, optionally the default. */
function connection(name: string, provider: string, isDefault = false): CodeHost {
  return Object.assign(Object.create(new FakeCodeHost(fakeModel())) as CodeHost, { kind: name, provider, ...(isDefault ? { defaultConnection: true } : {}) });
}
const entries = (...points: Array<[string, string, string, Record<string, unknown>?]>) =>
  parsePluginConfig({ version: 1, plugins: points.map(([point, name, module, settings]) => ({ point, name, module, settings: settings ?? {} })) });
const importerOf = (modules: Record<string, unknown>): ModuleImporter => async (specifier) => {
  if (!(specifier in modules)) throw new Error("no such module");
  return { plugin: modules[specifier] };
};

describe("code host connections", () => {
  it("serves a repository from the connection its record names, and a record that names none from the provider's default", () => {
    const registry = createAdapterRegistry();
    const main = connection("github", "github", true);
    const company = connection("github-company", "github");
    registry.register("code-host", "github", main);
    registry.register("code-host", "github-company", company);
    expect(codeHostForRecord(registry, { host: { kind: "github-company" } })).toBe(company);
    expect(codeHostForRecord(registry, { host: { kind: "github" } })).toBe(main);
    expect(codeHostForRecord(registry, {})).toBe(main);
    expect(codeHostForKind(registry, "github-company")).toBe(company);
    expect(() => assertRepositoryHostsKnown(registry, [{}, { host: { kind: "github-company" } }])).not.toThrow();
  });

  it("lets a repository name the provider when no connection has that name: the provider's default serves it", () => {
    const registry = createAdapterRegistry();
    const main = connection("github-main", "github", true);
    registry.register("code-host", "github-main", main);
    registry.register("code-host", "github-company", connection("github-company", "github"));
    expect(codeHostForRecord(registry, { host: { kind: "github" } })).toBe(main);
    expect(codeHostForRecord(registry, {})).toBe(main);
    expect(providerOf(main)).toBe("github");
    expect(providerOf(new FakeCodeHost(fakeModel()))).toBe("fake");
  });

  it("is never served by a connection of another provider, and a name nobody registered is refused with the fixed sentence", () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "examplehost", connection("examplehost", "examplehost", true));
    // No GitHub connection at all: a record with no host is refused, not sent to the other provider.
    expect(() => codeHostForRecord(registry, {})).toThrow(NO_HOST_MESSAGE);
    expect(() => codeHostForRecord(registry, { host: { kind: "github-company" } })).toThrow(NO_HOST_MESSAGE);
    expect(() => assertRepositoryHostsKnown(registry, [{ host: { kind: "github-company" } }])).toThrow(NO_HOST_MESSAGE);
  });

  it("takes the only connection of a provider as its default, and refuses several with no default or two defaults", () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "github", connection("github", "github"));
    expect(defaultConnectionOf(registry, "github")?.kind).toBe("github");
    registry.register("code-host", "github-company", connection("github-company", "github"));
    expect(() => defaultConnectionOf(registry, "github")).toThrowError(expect.objectContaining({ code: "ambiguous", message: AMBIGUOUS_CONNECTION_MESSAGE }));
    expect(connectionProblems(registry)).toHaveLength(1);
    const two = createAdapterRegistry();
    two.register("code-host", "github", connection("github", "github", true));
    two.register("code-host", "github-company", connection("github-company", "github", true));
    expect(() => defaultConnectionOf(two, "github")).toThrowError(expect.objectContaining({ message: TWO_DEFAULT_CONNECTIONS_MESSAGE }));
    expect(defaultConnectionOf(two, "nothing-registered")).toBeUndefined();
  });

  it("refuses a plug-in config with several connections and no single default when it loads", async () => {
    const make = (name: string, settings: Record<string, unknown>) => ({ name, module: githubCodeHostPlugin({ name, createProvider: () => new GitHubFixtureProvider(new FakeHostModel({ url: GITHUB_REPO_URL, id: "1", fullName: "acme/app", webBase: "https://github.com" })) }), settings });
    const a = make("github", { credentialRef: "github" });
    const b = make("github-company", { credentialRef: "company" });
    const load = (settingsA: Record<string, unknown>, settingsB: Record<string, unknown>) => loadAdapters(
      entries(["code-host", "github", "./a.js", settingsA], ["code-host", "github-company", "./b.js", settingsB]),
      { registry: createAdapterRegistry(), importModule: importerOf({ "./a.js": a.module, "./b.js": b.module }) },
    );
    await expect(load(a.settings, b.settings)).rejects.toMatchObject({ code: "bad_config" });
    await expect(load({ ...a.settings, default: true }, { ...b.settings, default: true })).rejects.toMatchObject({ code: "bad_config" });
    const registry = createAdapterRegistry();
    await loadAdapters(entries(["code-host", "github", "./a.js", a.settings], ["code-host", "github-company", "./b.js", { ...b.settings, default: true }]), { registry, importModule: importerOf({ "./a.js": a.module, "./b.js": b.module }) });
    // The default the config named serves a repository that names none, and each connection keeps its own name.
    expect(codeHostForRecord(registry, {}).kind).toBe("github-company");
    expect(codeHostForRecord(registry, { host: { kind: "github" } }).kind).toBe("github");
    expect(registry.names("code-host")).toEqual(["github", "github-company"]);
  });

  it("makes the GitHub adapter a named connection of provider github, and its webhook events carry the connection's name", async () => {
    const provider = new GitHubFixtureProvider(new FakeHostModel({ url: GITHUB_REPO_URL, id: "1", fullName: "acme/app", webBase: "https://github.com" }));
    const plain = githubCodeHost(provider, { credentialRef: "github" });
    expect(plain.kind).toBe("github");
    expect(providerOf(plain)).toBe("github");
    expect(plain.defaultConnection).toBeUndefined();
    const company = githubCodeHost(provider, { credentialRef: "company", name: "github-company", isDefault: true, webhookSecret: async () => "fixture-secret" });
    expect(company.kind).toBe("github-company");
    expect(providerOf(company)).toBe("github");
    expect(company.defaultConnection).toBe(true);
  });

  it("looks up the runner and the team lookup by the connection's provider", async () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "github-company", connection("github-company", "github", true));
    const asked: string[] = [];
    const resolver = registryRepositoryResolver(registry, {
      pinned: async () => ({ url: "https://github.com/acme/app", host: { kind: "github-company" } }),
      checkRunner: (kind) => { asked.push(`runner:${kind}`); return undefined; },
      isTeamMember: (kind) => { asked.push(`team:${kind}`); return undefined; },
    });
    const found = await resolver("p", 1, "app", "org_aaaaaaaaaaaaaaaaaaaa");
    expect(found?.codeHost.kind).toBe("github-company");
    expect(asked).toEqual(["runner:github", "team:github"]);
  });
});

describe("the repository's host may be written (item C2)", () => {
  const project = (host?: unknown) => ({
    name: "demo", repositories: [{ name: "app", url: "https://git.examplehost.test/acme/app", path: "app", defaultBranch: "main", credentialRef: "git", ...(host === undefined ? {} : { host }) }],
    readiness: [], setup: [], test: [],
  });

  it("accepts a repository that names its connection, and still a record without one", () => {
    for (const host of [undefined, { kind: "github-company" }, { kind: "examplehost", ref: "r1" }, { kind: "github" }]) {
      const parsed = ProjectDefinitionSchema.safeParse(project(host));
      // Whatever else the minimal fixture lacks, the host is no longer what is refused.
      expect(JSON.stringify(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)), JSON.stringify(host)).not.toContain('"host"');
    }
  });

  it("keeps the other rules of a host: a repository on another host has no GitHub pins", () => {
    const parsed = ProjectDefinitionSchema.safeParse({ ...project({ kind: "examplehost" }), repositories: [{ ...project({ kind: "examplehost" }).repositories[0], installationId: 5 }] });
    expect(parsed.success).toBe(false);
  });
});
