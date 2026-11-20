// The meta repo's config file (`.rovara/project.yaml`): how a file's text is read, and what it would change in a project, worked out without writing anything. The cases are the Cloud suite's own, run over
// Code's copy of the reader and the planner (the broker's pending-change store and its apply step are Cloud's and stay there).
import { describe, expect, it } from "vitest";
import { StoredProjectDefinitionSchema, parseCommandLine } from "@agentx/contracts";
import { parseMetaConfigFile, planMetaConfigChange, githubFullName } from "../../packages/broker/src/core/meta-repo/config-plan.js";

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: 100 + name.length, ...extra,
});
const command = (line: string, cwd: string, timeout = 900) => parseCommandLine(line, cwd, timeout);
const definition = (repositories: unknown[], extra: Record<string, unknown> = {}, revision = 1) => ({
  name: "payments", revision, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...extra,
});
const separate = (extra: Record<string, unknown> = {}) => definition([repo("api", { role: "code" }), repo("web"), repo("service-meta", { role: "meta" })], extra);
const selfMeta = (extra: Record<string, unknown> = {}) => definition([repo("app", { role: "meta", alsoCode: true })], extra);
const stored = (value: unknown) => StoredProjectDefinitionSchema.parse(value);
const yaml = (text: string) => { const parsed = parseMetaConfigFile(".rovara/project.yaml", text); if (!parsed.ok) throw new Error(`config did not parse: ${JSON.stringify(parsed.problems)}`); return parsed.config; };

describe("reading a config file", () => {
  it("reads YAML, and JSON by its extension", () => {
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nsetup:\n  api:\n    - npm ci\n")).toMatchObject({ ok: true, config: { setup: { api: ["npm ci"] } } });
    expect(parseMetaConfigFile(".rovara/project.yml", "version: 1\n")).toMatchObject({ ok: true });
    expect(parseMetaConfigFile(".rovara/project.json", '{"version":1,"setup":{"api":["npm ci"]}}')).toMatchObject({ ok: true });
    expect(parseMetaConfigFile(".rovara/project.json", "version: 1")).toMatchObject({ ok: false });
  });

  it("refuses a file over the size limit unread", () => {
    expect(parseMetaConfigFile(".rovara/project.yaml", `version: 1\n# ${"x".repeat(262_144)}`)).toMatchObject({ ok: false });
  });

  it("refuses an alias expansion (YAML's billion-laughs shape), merge keys, duplicate keys and a second document", () => {
    const aliases = `version: 1\nsetup:\n  api: &a [x]\n  b: [${Array.from({ length: 30 }, () => "*a").join(", ")}]\n`;
    expect(parseMetaConfigFile(".rovara/project.yaml", aliases)).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "base: &b {x: 1}\nversion: 1\n<<: *b\n")).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\nversion: 1\n")).toMatchObject({ ok: false });
    expect(parseMetaConfigFile(".rovara/project.yaml", "version: 1\n---\nversion: 1\n")).toMatchObject({ ok: false });
  });

});

describe("planning what a config file changes", () => {

  it("flags a value a person typed that differs, but not an empty one, one the file set before, or one an agent set", () => {
    const config = yaml("version: 1\nsetup:\n  api: [npm ci]\n");
    const typed = stored(separate({ setup: [command("make setup", "repo/api")] }));
    expect(planMetaConfigChange({ config, definition: typed }).items[0]).toMatchObject({ id: "setup", conflict: "person_value", before: ["api: make setup"] });
    expect(planMetaConfigChange({ config, definition: stored(separate()) }).items[0]!.conflict).toBeUndefined();
    expect(planMetaConfigChange({ config, definition: stored(separate({ setup: [command("make setup", "repo/api")], origins: { setup: "file" } })) }).items[0]!.conflict).toBeUndefined();
    expect(planMetaConfigChange({ config, definition: stored(separate({ setup: [command("make setup", "repo/api")], origins: { setup: "agent" } })) }).items[0]!.conflict).toBeUndefined();
  });

  it("adds a repository the file lists, matching an existing one by its GitHub name whatever its case, and never removes without a confirmation", () => {
    const plan = planMetaConfigChange({
      config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/Acme/lib.git'}\n  - {name: api, url: 'https://github.com/ACME/API'}\n"),
      definition: stored(separate()),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((item) => `${item.id}${item.needsConfirmation === true ? "*" : ""}${item.blocked === undefined ? "" : `!${item.blocked}`}`)).toEqual(["repositories:add:lib", "repositories:remove:web*"]);
  });

  it("blocks adding a repository on another host, a name that is taken, and any addition to a project whose one repository is its own meta repo", () => {
    const config = yaml("version: 1\nrepositories:\n  - {name: gitlabrepo, url: 'https://gitlab.com/acme/x.git'}\n  - {name: web, url: 'https://github.com/acme/other-web.git'}\n");
    const plan = planMetaConfigChange({ config, definition: stored(separate()) });
    expect(plan.items.filter((item) => item.kind === "add_repository").map((item) => item.blocked)).toEqual(["unsupported_host", "invalid"]);
    const self = planMetaConfigChange({ config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\n"), definition: stored(selfMeta()) });
    expect(self.items).toMatchObject([{ id: "repositories:add:lib", blocked: "self_meta_project" }]);
    // A project that is its own meta repo is never asked to remove its only repository.
    expect(self.items.some((item) => item.kind === "remove_repository")).toBe(false);
  });

  it("runs an added repository's commands in its folder repo/<name>, and shows that folder in the plan", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nrepositories:\n  - {name: lib, url: 'https://github.com/acme/lib.git'}\nsetup:\n  lib: [make]\n"), definition: stored(separate()) });
    expect(plan.problems).toEqual([]);
    expect(plan.items.find((item) => item.id === "setup")).toMatchObject({ after: ["lib: make"] });
    expect(plan.items.find((item) => item.id === "repositories:add:lib")).toMatchObject({ path: "repo/lib" });
  });

  it("reports a command that cannot be read, a repository the project does not have, and commands for the meta repository that holds no code", () => {
    const plan = planMetaConfigChange({
      config: yaml("version: 1\nsetup:\n  api: ['npm ci && npm test']\n  ghost: [x]\n  service-meta: [y]\ntests:\n  web:\n    commands: ['\"unclosed']\n"),
      definition: stored(separate()),
    });
    const paths = plan.problems.map((problem) => problem.path).sort();
    expect(paths).toContain("setup.api.0");
    expect(paths).toContain("setup.ghost");
    expect(paths).toContain("setup.service-meta");
    expect(paths).toContain("tests.web.commands.0");
    expect(plan.items.some((item) => item.id === "setup")).toBe(false);
    expect(JSON.stringify(plan.problems)).not.toContain("npm test");
  });

  it("plans for a repository called constructor (a name every record has on its prototype), reading only the file's own entries", () => {
    const def = stored(definition([repo("constructor", { role: "code" }), repo("service-meta", { role: "meta" })]));
    const none = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  other: [x]\n"), definition: def });
    expect(none.problems.map((problem) => problem.path)).toEqual(["setup.other"]);
    expect(planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  constructor: [make]\n"), definition: def }).items[0]).toMatchObject({ id: "setup", after: ["constructor: make"] });
    expect(() => planMetaConfigChange({ config: yaml("version: 1\ntests:\n  api:\n    commands: [t]\n"), definition: def })).not.toThrow();
    expect(() => planMetaConfigChange({ config: yaml("version: 1\n"), definition: def })).not.toThrow();
  });

  it("says how many of a person's commands the file removes", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nsetup:\n  api: [one]\n"), definition: stored(separate({ setup: [command("a", "repo/api"), command("b", "repo/api"), command("c", "repo/web")], origins: { setup: "file" } })) });
    expect(plan.items[0]).toMatchObject({ id: "setup", removes: 2 });
  });

  it("lists the sections it carries but does not apply, and refuses a project with no meta repository", () => {
    const plan = planMetaConfigChange({ config: yaml("version: 1\nchecks:\n  - {name: Lint, repo: api, command: npm run lint}\nsources:\n  - {connection: wiki}\n"), definition: stored(separate()) });
    expect(plan.deferred).toEqual(["checks", "sources"]);
    expect(plan.items).toEqual([]);
    expect(planMetaConfigChange({ config: yaml("version: 1\n"), definition: stored(definition([repo("api")])) }).problems).toEqual([{ path: "(project)", message: "this project has no meta repository" }]);
  });

  it("refuses a spec folder inside a folder the same file names as its own rules, steering, skills, runbooks or key docs", () => {
    const file = (template: string) => yaml(`version: 1\nknowledge: {steering: [design/rules], skills: [design/skills], runbooks: [ops/books], keyDocs: [docs/key]}\nspecTarget: {pathTemplate: "${template}"}\n`);
    for (const template of ["design/rules/{slug}/", "design/skills/x/", "ops/books/{slug}/", "docs/key/{slug}/", "design/rules"]) {
      expect(planMetaConfigChange({ config: file(template), definition: stored(separate()) }).problems.map((problem) => problem.path), template).toEqual(["specTarget.pathTemplate"]);
    }
    expect(planMetaConfigChange({ config: file("design/specs/{slug}/"), definition: stored(separate()) }).problems).toEqual([]);
  });

  it("knows a GitHub repository by its owner and name only", () => {
    expect(githubFullName("https://github.com/Acme/Api.git")).toBe("acme/api");
    expect(githubFullName("https://github.com/acme/api/")).toBe("acme/api");
    expect(githubFullName("https://gitlab.com/acme/api")).toBeUndefined();
    expect(githubFullName("http://github.com/acme/api")).toBeUndefined();
    expect(githubFullName("https://github.com/acme")).toBeUndefined();
  });
});

