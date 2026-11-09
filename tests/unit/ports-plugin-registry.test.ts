// Port lane L2: the code-host, tracker and check-runner plug-in points in the ONE registry: routing, loading from the plug-in config, the settings
// of each module, and the proof that a second provider plugs in with no core change.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostScopeSchema, IMPLICIT_COMPANY_ID, PluginRegistryError, type CodeHost, type PluginModule, type RepositoryRef } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import {
  NO_CHECK_RUNNER_MESSAGE, NO_CODE_HOST_MESSAGE, NO_HOST_MESSAGE, NO_TRACKER_MESSAGE, assertRepositoryHostsKnown, checkRunnerForKind, checkRunnerKinds, codeHostForKind, codeHostForRecord,
  codeHostForRepository, codeHostKinds, trackerForKind, trackerKinds,
} from "../../packages/broker/src/plugins/routing.js";
import { SECRET_FILE_MAX_BYTES, SecretSourceSchema, secretReader } from "../../packages/broker/src/plugins/module-support.js";
import { codeBuildPlugin } from "../../packages/broker/src/plugins/check-runner/codebuild/plugin.js";
import { githubActionsPlugin } from "../../packages/broker/src/plugins/check-runner/github-actions/plugin.js";
import { githubCodeHostPlugin } from "../../packages/broker/src/plugins/code-host/github/plugin.js";
import { fakePlugins } from "../../packages/broker/src/plugins/fake/plugins.js";
import { FakeCheckRunner } from "../../packages/broker/src/plugins/fake/check-runner.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { linearTrackerPlugin } from "../../packages/broker/src/plugins/tracker/linear/plugin.js";
import { GITHUB_REPO_URL, GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";

const REPO_URL = "https://git.example.test/acme/app";
const model = () => new FakeHostModel({ url: REPO_URL, id: "4242", fullName: "acme/app" });
const importerOf = (modules: Record<string, unknown>): ModuleImporter => async (specifier) => {
  if (!(specifier in modules)) throw new Error("no such module");
  return { plugin: modules[specifier] };
};
const entries = (...points: Array<[string, string, string, Record<string, unknown>?]>) =>
  parsePluginConfig({ version: 1, plugins: points.map(([point, name, module, settings]) => ({ point, name, module, settings: settings ?? {} })) });

/** The same fake host under another name: a second provider that the core has never heard of. */
function hostCalled(kind: string, host: CodeHost): CodeHost {
  return Object.assign(Object.create(host) as CodeHost, { kind });
}

describe("routing over the one registry", () => {
  it("finds a code host by kind, and by a repository record's host kind; a record with no host is on the legacy kind", () => {
    const registry = createAdapterRegistry();
    const github = hostCalled("github", new FakeCodeHost(model()));
    const examplehost = hostCalled("examplehost", new FakeCodeHost(model()));
    registry.register("code-host", "github", github);
    registry.register("code-host", "examplehost", examplehost);
    expect(codeHostKinds(registry)).toEqual(["examplehost", "github"]);
    expect(codeHostForKind(registry, "examplehost")).toBe(examplehost);
    expect(codeHostForRecord(registry, { host: { kind: "examplehost" } })).toBe(examplehost);
    expect(codeHostForRecord(registry, {})).toBe(github);
    expect(codeHostForRepository(registry, { url: "https://x.example.test/a/b" } satisfies RepositoryRef)).toBe(github);
    expect(codeHostForRepository(registry, { url: "https://x.example.test/a/b" }, () => "examplehost")).toBe(examplehost);
  });

  it("refuses a kind with no adapter with a fixed sentence that does not echo it, and never falls back to another adapter", () => {
    const registry = createAdapterRegistry();
    registry.register("code-host", "github", hostCalled("github", new FakeCodeHost(model())));
    const message = (run: () => unknown): string => { try { run(); } catch (error) { return (error as Error).message; } return ""; };
    expect(() => codeHostForKind(registry, "gitea-secret-name")).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_CODE_HOST_MESSAGE) as string }));
    expect(() => codeHostForRecord(registry, { host: { kind: "gitea-secret-name" } })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as string }));
    for (const run of [() => codeHostForKind(registry, "gitea-secret-name"), () => codeHostForRecord(registry, { host: { kind: "gitea-secret-name" } }), () => trackerForKind(registry, "gitea-secret-name"), () => checkRunnerForKind(registry, "gitea-secret-name", { allowedRepositories: [] }), () => assertRepositoryHostsKnown(registry, [{ host: { kind: "gitea-secret-name" } }])]) {
      expect(message(run)).not.toContain("gitea-secret-name");
    }
    expect(() => codeHostForRecord(registry, { host: { kind: "Not A Name" } })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => codeHostForKind(registry, "Not A Name")).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => trackerForKind(registry, "linear")).toThrowError(expect.objectContaining({ message: expect.stringContaining(NO_TRACKER_MESSAGE) as string }));
    expect(() => checkRunnerForKind(registry, "codebuild", { allowedRepositories: [] })).toThrowError(expect.objectContaining({ message: expect.stringContaining(NO_CHECK_RUNNER_MESSAGE) as string }));
    expect(() => assertRepositoryHostsKnown(registry, [{}, { host: { kind: "github" } }])).not.toThrow();
    expect(() => assertRepositoryHostsKnown(registry, [{}, { host: { kind: "gitea-secret-name" } }])).toThrowError(expect.objectContaining({ message: expect.stringContaining(NO_HOST_MESSAGE) as string }));
  });

  it("builds a check runner for each project's repositories, and the runner's kind must be its registered name", () => {
    const registry = createAdapterRegistry();
    const seen: string[][] = [];
    registry.register("check-runner", "fake-checks", { kind: "fake-checks", create: (context) => { seen.push([...context.allowedRepositories]); return new FakeCheckRunner(model()); } });
    expect(checkRunnerForKind(registry, "fake-checks", { allowedRepositories: [REPO_URL] }).kind).toBe("fake-checks");
    expect(seen).toEqual([[REPO_URL]]);
    const mismatched = createAdapterRegistry();
    mismatched.register("check-runner", "other", { kind: "other", create: () => new FakeCheckRunner(model()) });
    expect(() => checkRunnerForKind(mismatched, "other", { allowedRepositories: [] })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(checkRunnerKinds(mismatched)).toEqual(["other"]);
    expect(trackerKinds(mismatched)).toEqual([]);
  });

  it("refuses to register an adapter under a name that is not its kind", () => {
    const registry = createAdapterRegistry();
    const host = new FakeCodeHost(model());
    expect(() => registry.register("code-host", "github", host)).toThrowError(expect.objectContaining({ code: "bad_module" }));
    expect(() => registry.register("tracker", "x", {} as never)).toThrowError(expect.objectContaining({ code: "bad_module" }));
    registry.register("code-host", "fake", host);
    expect(registry.require("code-host", "fake")).toBe(host);
  });

  it("has no edition gate: any kind registers with no policy, and nothing is required to be there", () => {
    const registry = createAdapterRegistry();
    expect(codeHostKinds(registry)).toEqual([]);
    registry.register("code-host", "examplehost", hostCalled("examplehost", new FakeCodeHost(model())));
    expect(codeHostKinds(registry)).toEqual(["examplehost"]);
  });
});

describe("loading code hosts, trackers and check runners from the plug-in config", () => {
  it("loads the fake adapters by name, and routes to them once the registry is sealed", async () => {
    const registry = createAdapterRegistry();
    const fakes = fakePlugins(model());
    await loadAdapters(entries(["code-host", "fake", "./fake-host.js"], ["check-runner", "fake-checks", "./fake-checks.js"], ["tracker", "fake-tracker", "./fake-tracker.js"]), {
      registry, importModule: importerOf({ "./fake-host.js": fakes.codeHost, "./fake-checks.js": fakes.checkRunner, "./fake-tracker.js": fakes.tracker }),
    });
    registry.seal();
    expect(codeHostForKind(registry, "fake").kind).toBe("fake");
    expect(trackerForKind(registry, "fake-tracker").kind).toBe("fake-tracker");
    expect(checkRunnerForKind(registry, "fake-checks", { allowedRepositories: [REPO_URL] }).kind).toBe("fake-checks");
    // Sealed: a plug-in cannot add a code host afterwards.
    expect(() => registry.register("code-host", "late", hostCalled("late", new FakeCodeHost(model())))).toThrowError(PluginRegistryError);
  });

  it("refuses a module whose adapter is not called what the config entry says", async () => {
    const registry = createAdapterRegistry();
    const fakes = fakePlugins(model());
    const lying: PluginModule<"code-host"> = { point: "code-host", name: "github", create: () => new FakeCodeHost(model()) };
    expect(fakes.codeHost.name).toBe("fake");
    await expect(loadAdapters(entries(["code-host", "github", "./h.js"]), { registry, importModule: importerOf({ "./h.js": lying }) })).rejects.toMatchObject({ code: "bad_module" });
    expect(codeHostKinds(registry)).toEqual([]);
  });

  it("loads the GitHub code host and the GitHub Actions runner over one client, and reads the webhook secret by name", async () => {
    const registry = createAdapterRegistry();
    const client = new GitHubFixtureProvider(new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" }));
    const environment = "L2_TEST_WEBHOOK_SECRET";
    process.env[environment] = ["fixture", "webhook", "value"].join("-");
    try {
      await loadAdapters(entries(
        ["code-host", "github", "./github.js", { credentialRef: "github", webhookSecret: { env: environment } }],
        ["check-runner", "github-actions", "./actions.js"],
      ), { registry, importModule: importerOf({ "./github.js": githubCodeHostPlugin({ createProvider: () => client }), "./actions.js": githubActionsPlugin({ createProvider: () => client }) }) });
      const host = codeHostForKind(registry, "github");
      expect(host.kind).toBe("github");
      expect("normalise" in host.events).toBe(true);
      expect(await host.repositoryIdentity({ url: GITHUB_REPO_URL }, { system: "private-install" })).toMatchObject({ fullName: "acme/app" });
      expect(checkRunnerForKind(registry, "github-actions", { allowedRepositories: [] }).capabilities.logTail).toBe(true);
    } finally {
      delete process.env[environment];
    }
  });

  it("refuses a GitHub client that lacks methods, naming the methods and nothing else", async () => {
    const registry = createAdapterRegistry();
    const partial = { getRepositoryIdentity: async () => undefined };
    const error = await loadAdapters(entries(["code-host", "github", "./github.js", { credentialRef: "github" }]), { registry, importModule: importerOf({ "./github.js": githubCodeHostPlugin({ createProvider: () => partial as never }) }) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginRegistryError);
    expect((error as PluginRegistryError).code).toBe("create_failed");
    expect((error as PluginRegistryError).message).toContain("getPullRequestStatus");
    expect((error as PluginRegistryError).message).not.toContain("getRepositoryIdentity,");
    expect(codeHostKinds(registry)).toEqual([]);
  });

  it("reports a bad settings block by field name, never by value", async () => {
    const registry = createAdapterRegistry();
    const secretish = ["not", "a", "real", "value", "9876"].join("-");
    const load = (settings: Record<string, unknown>) => loadAdapters(entries(["code-host", "github", "./github.js", settings]), { registry, importModule: importerOf({ "./github.js": githubCodeHostPlugin({ createProvider: () => ({}) as never }) }) });
    const error = await load({ credentialRef: "github", webhookSecret: secretish }).catch((caught: unknown) => caught as PluginRegistryError);
    expect((error as PluginRegistryError).code).toBe("bad_config");
    expect((error as PluginRegistryError).message).toContain("webhookSecret");
    expect((error as PluginRegistryError).message).not.toContain(secretish);
    // An unknown field is refused too (a typo does not silently turn a setting off), and a secret cannot be written into the config.
    await expect(load({ credentialRef: "github", webhookSecretValue: secretish })).rejects.toMatchObject({ code: "bad_config" });
  });

  it("loads CodeBuild as an optional check runner that serves only the repositories a project registered", async () => {
    const registry = createAdapterRegistry();
    const built: string[] = [];
    const gateway = { start: async () => { throw new Error("not used"); }, status: async () => { throw new Error("not used"); } };
    await loadAdapters(entries(["check-runner", "codebuild", "./cb.js"]), { registry, importModule: importerOf({ "./cb.js": codeBuildPlugin({ createGateway: () => { built.push("gateway"); return gateway; } }) }) });
    expect(built).toEqual(["gateway"]);
    const runner = checkRunnerForKind(registry, "codebuild", { allowedRepositories: [REPO_URL] });
    expect(runner.capabilities.start).toBe(true);
    await expect(runner.start!({ repository: { url: "https://x.example.test/other" }, revision: "a".repeat(40), gate: "unit", project: "p", timeoutMinutes: 5, idempotencyKey: "k" }, { system: "private-install" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(loadAdapters(entries(["check-runner", "codebuild", "./cb.js"]), { registry: createAdapterRegistry(), importModule: importerOf({ "./cb.js": codeBuildPlugin({ createGateway: () => ({}) as never }) }) })).rejects.toMatchObject({ code: "create_failed" });
  });

  it("loads the Linear tracker, which offers what the install gave it", async () => {
    const registry = createAdapterRegistry();
    await loadAdapters(entries(["tracker", "linear", "./linear.js"]), { registry, importModule: importerOf({ "./linear.js": linearTrackerPlugin({ createAccess: () => ({ reply: { reply: async () => undefined } }) }) }) });
    const tracker = trackerForKind(registry, "linear");
    expect(tracker.capabilities).toMatchObject({ comment: true, events: "none" });
    expect(trackerKinds(registry)).toEqual(["linear"]);
  });

  it("proves a second code host plugs in with no core change: routing by the record's host kind reaches it", async () => {
    const registry = createAdapterRegistry();
    const second = fakePlugins(model());
    const examplehost: PluginModule<"code-host"> = { point: "code-host", name: "examplehost", create: () => hostCalled("examplehost", new FakeCodeHost(model())) };
    await loadAdapters(entries(["code-host", "fake", "./a.js"], ["code-host", "examplehost", "./b.js"]), { registry, importModule: importerOf({ "./a.js": second.codeHost, "./b.js": examplehost }) });
    expect(codeHostForRecord(registry, { host: { kind: "examplehost" } }).kind).toBe("examplehost");
    expect(codeHostForRecord(registry, { host: { kind: "fake" } }).kind).toBe("fake");
  });
});

describe("the settings helpers of the plug-in modules", () => {
  const fixtureDir = async () => mkdtemp(join(tmpdir(), "rovara-l2-"));
  const secretValue = ["fixture", "signing", "value"].join("-");

  it("reads a secret from an environment variable by name, each time, and says nothing about the name's absence beyond one sentence", async () => {
    const environment: NodeJS.ProcessEnv = { L2_SECRET: ` ${secretValue}\n` };
    const read = secretReader({ env: "L2_SECRET" }, environment);
    expect(await read()).toBe(secretValue);
    environment.L2_SECRET = "rotated";
    expect(await read()).toBe("rotated");
    delete environment.L2_SECRET;
    await expect(read()).rejects.toThrow("the secret is not available");
  });

  it("reads a secret file only when it is a plain, small, owner-only file; a link, a loose mode or a big file is refused with one sentence", async () => {
    const dir = await fixtureDir();
    try {
      const file = join(dir, "secret");
      await writeFile(file, secretValue, { mode: 0o600 });
      expect(await secretReader({ file })()).toBe(secretValue);
      await chmod(file, 0o644);
      await expect(secretReader({ file })()).rejects.toThrow("the secret is not available");
      await chmod(file, 0o600);
      const link = join(dir, "link");
      await symlink(file, link);
      await expect(secretReader({ file: link })()).rejects.toThrow("the secret is not available");
      const big = join(dir, "big");
      await writeFile(big, "x".repeat(SECRET_FILE_MAX_BYTES + 1), { mode: 0o600 });
      await expect(secretReader({ file: big })()).rejects.toThrow("the secret is not available");
      await expect(secretReader({ file: dir })()).rejects.toThrow("the secret is not available");
      await expect(secretReader({ file: join(dir, "missing") })()).rejects.toThrow("the secret is not available");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a secret file by absolute path only, and an environment name in capitals only", () => {
    expect(SecretSourceSchema.safeParse({ file: "relative/secret" }).success).toBe(false);
    expect(SecretSourceSchema.safeParse({ file: "/etc/rovara/secret" }).success).toBe(true);
    expect(SecretSourceSchema.safeParse({ env: "lower" }).success).toBe(false);
    expect(SecretSourceSchema.safeParse({ env: "A", file: "/x" }).success).toBe(false);
  });
});

describe("the company the config names is the scope of the plug-in calls", () => {
  it("accepts only an id that is a valid organization scope, so every company the config allows can be used in a HostScope", () => {
    for (const companyId of [IMPLICIT_COMPANY_ID, "org_aaaaaaaaaaaaaaaaaaaa"]) {
      expect(() => parsePluginConfig({ version: 1, companyId, plugins: [] })).not.toThrow();
      expect(HostScopeSchema.safeParse({ orgId: companyId }).success).toBe(true);
    }
    for (const companyId of ["acme", "org_abc", "ORG_AAAAAAAAAAAAAAAAAAAA", "org_aaaaaaaaaaaaaaaaaaaa#x"]) {
      expect(() => parsePluginConfig({ version: 1, companyId, plugins: [] })).toThrowError(expect.objectContaining({ code: "bad_config" }));
    }
  });
});
