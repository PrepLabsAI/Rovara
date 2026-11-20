// Meta repo lane A, task A1: the project model's contracts. The meta role on a repository, the config file, the origin of each setting, and the citation a
// proposed item must carry. Every case below fails when the rule it names is removed; old stored records must still read exactly as before.
import { describe, expect, it } from "vitest";
import { META_CONFIG_MAX_BYTES, CreateProjectFromMetaBodySchema, ProjectDefinitionSchema, ProvenanceSchema, StoredProjectDefinitionSchema, canonicalJson, codeRepositoriesOf, fileManagedFields, isCreateFromMetaBody, metaConfigReferenceProblems, metaRepositoryOf, parseMetaProjectConfig, parseMetaProjectConfigJson, projectMetaShape, settingOriginOf, withSettingOrigins, workerProjectDefinition } from "../../packages/contracts/src/index.js";

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", ...extra,
});
const project = (repositories: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "payments", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...extra,
});
const problems = (value: unknown, schema: { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } } = ProjectDefinitionSchema) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : (parsed.error?.issues ?? []).map((issue) => issue.message);
};

describe("a repository's role in a project", () => {
  it("reads a project that predates roles exactly as before, with no role added", () => {
    const old = project([repo("api"), repo("web")]);
    const parsed = ProjectDefinitionSchema.parse(old);
    // Nothing is added on parse, so a stored revision's canonical form and any digest of it do not move.
    expect(canonicalJson(parsed)).toBe(canonicalJson(old));
    expect(StoredProjectDefinitionSchema.parse(old)).toEqual(old);
    expect(projectMetaShape(parsed)).toBe("none");
    expect(metaRepositoryOf(parsed)).toBeUndefined();
    expect(codeRepositoriesOf(parsed).map((entry) => entry.name)).toEqual(["api", "web"]);
  });

  it("accepts one meta repository beside code repositories", () => {
    const parsed = ProjectDefinitionSchema.parse(project([repo("service-meta", { role: "meta" }), repo("api", { role: "code" }), repo("web")]));
    expect(projectMetaShape(parsed)).toBe("separate");
    expect(metaRepositoryOf(parsed)?.name).toBe("service-meta");
    expect(codeRepositoriesOf(parsed).map((entry) => entry.name)).toEqual(["api", "web"]);
  });

  it("accepts a one-repository project that is its own meta repository", () => {
    const parsed = ProjectDefinitionSchema.parse(project([repo("app", { role: "meta", alsoCode: true })]));
    expect(projectMetaShape(parsed)).toBe("self");
    expect(codeRepositoriesOf(parsed).map((entry) => entry.name)).toEqual(["app"]);
  });

  it("refuses a second meta repository", () => {
    expect(problems(project([repo("a", { role: "meta" }), repo("b", { role: "meta" }), repo("c")]))).toContain("a project has at most one meta repository");
  });

  it("refuses a meta repository with no code beside it, unless it is also code", () => {
    expect(problems(project([repo("only-meta", { role: "meta" })]))).toContain("a meta repository that is not also code needs at least one code repository");
    expect(problems(project([repo("only-meta", { role: "meta", alsoCode: false })]))).toContain("a meta repository that is not also code needs at least one code repository");
  });

  it("allows alsoCode only on the project's only repository", () => {
    expect(problems(project([repo("a", { role: "meta", alsoCode: true }), repo("b")]))).toContain("a repository that is both meta and code must be the project's only repository; make the meta repository a separate one first");
  });

  it("refuses alsoCode on a repository that is not the meta repository", () => {
    expect(problems(project([repo("a", { alsoCode: true })]))).toContain("alsoCode is only for the meta repository");
    expect(problems(project([repo("a", { role: "code", alsoCode: true })]))).toContain("alsoCode is only for the meta repository");
  });

  it("keeps the devcontainer out of a meta repository that is not code", () => {
    const definition = project([repo("meta", { role: "meta" }), repo("api")], { devcontainer: { repository: "meta" } });
    expect(problems(definition)).toContain("the devcontainer cannot be in a meta repository that is not also code");
    expect(problems({ ...definition, devcontainer: { repository: "api" } })).toEqual([]);
  });

});

describe("what a worker is sent", () => {

  it("keeps a repository that is both meta and code, without its role", () => {
    const definition = ProjectDefinitionSchema.parse(project([repo("app", { role: "meta", alsoCode: true })]));
    const sent = workerProjectDefinition(definition) as { repositories: Array<Record<string, unknown>> };
    expect(sent.repositories).toHaveLength(1);
    expect(sent.repositories[0]).not.toHaveProperty("role");
    expect(sent.repositories[0]).not.toHaveProperty("alsoCode");
  });

});

describe("the origin of each setting", () => {
  it("reads a field with no entry as set by a person", () => {
    expect(settingOriginOf({}, "setup")).toBe("person");
    expect(settingOriginOf({ origins: { setup: "file" } }, "setup")).toBe("file");
    expect(settingOriginOf({ origins: { setup: "file" } }, "readiness")).toBe("person");
  });

  it("lists the fields a file manages", () => {
    expect(fileManagedFields({ origins: { setup: "file", readiness: "agent", network: "file" } })).toEqual(["setup", "network"]);
    expect(fileManagedFields({})).toEqual([]);
  });

  it("stores only what an agent or a file set: a person's edit removes the entry", () => {
    const from = withSettingOrigins(undefined, ["setup", "readiness"], "file");
    expect(from).toEqual({ setup: "file", readiness: "file" });
    expect(withSettingOrigins(from, ["setup"], "person")).toEqual({ readiness: "file" });
    expect(withSettingOrigins({ setup: "file" }, ["setup"], "person")).toBeUndefined();
  });

});

describe("the meta repo's config file", () => {
  const minimal = { version: 1 };
  it("accepts a minimal file and a full one", () => {
    expect(parseMetaProjectConfig(minimal).ok).toBe(true);
    const full = {
      version: 1,
      repositories: [{ name: "api", url: "https://github.com/acme/api.git", defaultBranch: "main", role: "code" }, { name: "web", url: "https://github.com/acme/web", path: "repo/web" }],
      setup: { api: ["npm ci"], web: ["npm ci"] },
      tests: { api: { commands: ["npm test"], affected: "npm run affected" } },
      checks: [{ name: "Lint", repo: "api", command: "npm run lint" }],
      knowledge: { steering: [".kiro/steering"], skills: [".agents/skills"], specs: [".kiro/specs"], runbooks: ["runbooks"], keyDocs: ["ARCHITECTURE.md"] },
      specTarget: { where: "meta_repo", format: "kiro" },
      sources: [{ connection: "Team wiki", label: "Wiki" }],
      intake: [{ channel: "tracker", system: "sim", when: { label: "rovara" } }],
    };
    expect(parseMetaProjectConfig(full)).toMatchObject({ ok: true });
  });

  it("refuses a version it does not know, an unknown key and a missing version", () => {
    expect(parseMetaProjectConfig({ version: 2 }).ok).toBe(false);
    expect(parseMetaProjectConfig({}).ok).toBe(false);
    const unknown = parseMetaProjectConfig({ version: 1, secrets: { token: "x" } });
    expect(unknown).toMatchObject({ ok: false });
    expect(JSON.stringify(unknown)).not.toContain("token");
  });

  it("limits repositories to 31, and repository names and checks to be unique", () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ name: `r${String(i)}`, url: `https://github.com/acme/r${String(i)}.git` }));
    expect(parseMetaProjectConfig({ version: 1, repositories: many }).ok).toBe(false);
    expect(parseMetaProjectConfig({ version: 1, repositories: many.slice(0, 31) }).ok).toBe(true);
    expect(parseMetaProjectConfig({ version: 1, repositories: [many[0], many[0]] }).ok).toBe(false);
    expect(parseMetaProjectConfig({ version: 1, checks: [{ name: "Lint", repo: "a", command: "x" }, { name: "lint", repo: "a", command: "y" }] }).ok).toBe(false);
  });

  it("takes repository URLs over https only, with no user or password", () => {
    const url = (value: string) => parseMetaProjectConfig({ version: 1, repositories: [{ name: "api", url: value }] }).ok;
    expect(url("https://github.com/acme/api.git")).toBe(true);
    expect(url("http://github.com/acme/api.git")).toBe(false);
    expect(url("git@github.com:acme/api.git")).toBe(false);
    expect(url("https://user:pass@github.com/acme/api.git")).toBe(false);
    expect(url("file:///etc/passwd")).toBe(false);
  });

  it("keeps knowledge paths inside the meta repo", () => {
    const path = (value: string) => parseMetaProjectConfig({ version: 1, knowledge: { steering: [value] } }).ok;
    expect(path(".kiro/steering")).toBe(true);
    expect(path("../outside")).toBe(false);
    expect(path("/etc")).toBe(false);
    expect(path("a/../b")).toBe(false);
    expect(path(".git/hooks")).toBe(false);
    expect(path("a\\b")).toBe(false);
    expect(parseMetaProjectConfig({ version: 1, knowledge: { steering: ["a", "a"] } }).ok).toBe(false);
  });

  it("bounds the sections other lanes own: size, depth and reserved keys", () => {
    expect(parseMetaProjectConfig({ version: 1, specTarget: { blob: "x".repeat(9_000) } }).ok).toBe(false);
    expect(parseMetaProjectConfig({ version: 1, specTarget: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }).ok).toBe(false);
    const polluted = JSON.parse('{"version":1,"specTarget":{"__proto__":{"x":1}}}') as unknown;
    expect(parseMetaProjectConfig(polluted).ok).toBe(false);
    expect(parseMetaProjectConfig({ version: 1, intake: Array.from({ length: 17 }, () => ({ channel: "tracker", system: "sim", when: { label: "rovara" } })) }).ok).toBe(false);
  });

  it("parses JSON text, refusing a file over the size limit unread and text that is not JSON", () => {
    expect(parseMetaProjectConfigJson('{"version":1}').ok).toBe(true);
    expect(parseMetaProjectConfigJson("{nope")).toEqual({ ok: false, problems: [{ path: "(file)", message: "the file is not valid JSON" }] });
    const big = parseMetaProjectConfigJson(JSON.stringify({ version: 1, specTarget: { x: "y".repeat(META_CONFIG_MAX_BYTES) } }));
    expect(big).toMatchObject({ ok: false });
  });

  it("cross-checks repository names against the project, including the meta repo's own name", () => {
    const config = parseMetaProjectConfig({ version: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git" }], setup: { api: ["a"], ghost: ["b"], "service-meta": ["c"] }, tests: { ghost2: { commands: ["t"] } }, checks: [{ name: "x", repo: "ghost3", command: "c" }] });
    if (!config.ok) throw new Error("expected a valid config");
    const found = metaConfigReferenceProblems(config.config, "service-meta").map((problem) => problem.path).sort();
    expect(found).toEqual(["checks.0.repo", "setup.ghost", "tests.ghost2"]);
    const listsMeta = parseMetaProjectConfig({ version: 1, repositories: [{ name: "service-meta", url: "https://github.com/acme/m.git" }] });
    if (!listsMeta.ok) throw new Error("expected a valid config");
    expect(metaConfigReferenceProblems(listsMeta.config, "service-meta").map((problem) => problem.message)).toContain("the meta repo is the repository the file is in; do not list it");
  });
});

describe("creating a project from a meta repo", () => {
  const id = "0b9f4c1e-6a56-4a52-8a8e-2f3a8d9a8c11";
  it("refuses duplicates, the meta repo among the code repos, a bad name and extra keys", () => {
    expect(CreateProjectFromMetaBodySchema.safeParse({ requestId: id, metaRepository: "acme/m", codeRepositories: ["acme/m"] }).success).toBe(false);
    expect(CreateProjectFromMetaBodySchema.safeParse({ requestId: id, metaRepository: "acme/m", codeRepositories: ["acme/a", "ACME/a"] }).success).toBe(false);
    expect(CreateProjectFromMetaBodySchema.safeParse({ requestId: id, metaRepository: "not a repo" }).success).toBe(false);
    expect(CreateProjectFromMetaBodySchema.safeParse({ requestId: id, metaRepository: "acme/m", codeRepositories: [] }).success).toBe(false);
    expect(CreateProjectFromMetaBodySchema.safeParse({ requestId: id, metaRepository: "acme/m", token: "x" }).success).toBe(false);
  });
  it("tells a meta body from the single-repository one", () => {
    expect(isCreateFromMetaBody({ metaRepository: "acme/m" })).toBe(true);
    expect(isCreateFromMetaBody({ repository: "acme/m" })).toBe(false);
    expect(isCreateFromMetaBody(null)).toBe(false);
    expect(isCreateFromMetaBody([])).toBe(false);
  });
});

describe("the citation a proposed item carries", () => {
  const commit = "a".repeat(40);
  const file = { kind: "file", repo: "service-meta", commit, path: ".kiro/steering/tech.md", line: 22, quote: "build-tool release" };
  it("refuses a file citation with no repo, commit or path, and an inferred one with no note", () => {
    expect(ProvenanceSchema.safeParse({ ...file, repo: undefined }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...file, commit: undefined }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...file, path: undefined, line: undefined, quote: undefined }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ kind: "inferred" }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ kind: "connector" }).success).toBe(false);
  });
  it("refuses a short commit, an escaping path, a quote over 200 characters and a line or quote with no path", () => {
    expect(ProvenanceSchema.safeParse({ ...file, commit: "abc123" }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...file, path: "../etc/passwd" }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...file, quote: "q".repeat(201) }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ kind: "person", line: 3 }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ kind: "inferred", note: "n", quote: "q" }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...file, line: 0 }).success).toBe(false);
  });
});
