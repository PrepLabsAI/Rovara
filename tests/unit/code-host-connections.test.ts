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

  it("looks up the runner and the team lookup under the connection's own name first, and the provider's only when there is none (review L2)", async () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "github-company", connection("github-company", "github", true));
    registry.register("code-host", "github-main", connection("github-main", "github"));
    const asked: string[] = [];
    const runnerFor = (kind: string) => ({ kind } as never);
    const resolverWith = (registered: readonly string[]) => registryRepositoryResolver(registry, {
      pinned: async (_project, _revision, repositoryId) => ({ url: "https://github.com/acme/app", host: { kind: repositoryId === "main" ? "github-main" : "github-company" } }),
      checkRunner: (kind) => { asked.push(`runner:${kind}`); return registered.includes(kind) ? runnerFor(kind) : undefined; },
      isTeamMember: (kind) => { asked.push(`team:${kind}`); return registered.includes(kind) ? (async () => "member" as const) : undefined; },
    });
    const org = "org_aaaaaaaaaaaaaaaaaaaa" as never;
    // Two GitHub connections, a runner registered for each: each repository gets its own connection's runner.
    const both = resolverWith(["github-company", "github-main"]);
    expect((await both("p", 1, "company", org))?.checkRunner?.kind).toBe("github-company");
    expect((await both("p", 1, "main", org))?.checkRunner?.kind).toBe("github-main");
    // Only the provider has one: it serves both connections, after the connection's own name was tried.
    asked.length = 0;
    const shared = resolverWith(["github"]);
    expect((await shared("p", 1, "company", org))?.checkRunner?.kind).toBe("github");
    expect(asked).toEqual(["runner:github-company", "runner:github", "team:github-company", "team:github"]);
    // Nobody has one: none is invented.
    expect((await resolverWith([])("p", 1, "main", org))?.checkRunner).toBeUndefined();
  });
});

describe("the repository's host may be written (item C2)", () => {
  const project = (host?: unknown) => ({
    name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "app", url: "https://git.examplehost.test/acme/app", path: "app", defaultBranch: "main", credentialRef: "git", ...(host === undefined ? {} : { host }) }],
  });

  it("accepts a repository that names its connection, and still a record without one", () => {
    for (const host of [undefined, { kind: "github-company" }, { kind: "examplehost", ref: "r1" }, { kind: "github" }]) {
      expect(ProjectDefinitionSchema.safeParse(project(host)).success, JSON.stringify(host)).toBe(true);
    }
  });

  it("lets any connection of provider github carry the GitHub pins, and no other connection (review M3)", () => {
    const pinned = (host: Record<string, unknown>, top: Record<string, unknown> = {}) => ProjectDefinitionSchema.safeParse({ ...project(host), repositories: [{ ...project(host).repositories[0], ...top }] }).success;
    expect(pinned({ kind: "github", installationId: 5, repositoryId: 9 })).toBe(true);
    expect(pinned({ kind: "github-company", provider: "github", installationId: 5, repositoryId: 9 })).toBe(true);
    // The dual-read spelling at the top of the record must agree with the host's, for a second GitHub connection as for `github`.
    expect(pinned({ kind: "github-company", provider: "github", installationId: 5, repositoryId: 9 }, { installationId: 5, githubRepositoryId: 9 })).toBe(true);
    expect(pinned({ kind: "github-company", provider: "github", installationId: 5 }, { installationId: 6 })).toBe(false);
    // A connection of another provider, or one that does not say, has no GitHub pins.
    expect(pinned({ kind: "examplehost", provider: "examplehost", installationId: 5 })).toBe(false);
    expect(pinned({ kind: "github-company", installationId: 5 })).toBe(false);
    expect(pinned({ kind: "examplehost" }, { installationId: 5 })).toBe(false);
  });

  it("keeps the other rules of a host: a repository on another host has no GitHub pins", () => {
    const parsed = ProjectDefinitionSchema.safeParse({ ...project({ kind: "examplehost" }), repositories: [{ ...project({ kind: "examplehost" }).repositories[0], installationId: 5 }] });
    expect(parsed.success).toBe(false);
  });
});
