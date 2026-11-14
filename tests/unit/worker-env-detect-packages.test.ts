import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { detectWorkspacePackages } from "../../packages/worker/src/env-detect/packages.js";
import type { Detector } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
const node = JSON.stringify({ scripts: { test: "vitest run" } });
const detect = (files: Files, options = {}) => detectWorkspacePackages(Object.keys(files), (path) => Promise.resolve(files[path]), "repo", options);
const roots = async (files: Files) => (await detect(files)).units.map((unit) => unit.root);

describe("workspace package discovery foundation", () => {
  it("keeps the single-repo detection byte-for-byte", async () => {
    const files: Files = { "package.json": node, "package-lock.json": "{}", "test/a.test.ts": "" };
    const old = await runDetectors(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, "repo");
    const result = await detect(files);
    expect(result.kind).toBe("single");
    expect(result.units).toHaveLength(1);
    expect(JSON.stringify(result.units[0]!.detection)).toBe(JSON.stringify(old));
    expect(result.units[0]!.detection.checks[0]!.value.command).toEqual({ cwd: "repo", executable: "npm", args: ["run", "test"], timeoutSeconds: 1800 });
  });

  it("discovers all 40 pnpm packages before applying a fresh path budget to each", async () => {
    const files: Files = { "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/ignored'\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'" };
    for (let n = 0; n < 40; n += 1) {
      files[`packages/p${String(n)}/package.json`] = node;
      for (let f = 0; f < 130; f += 1) files[`packages/p${String(n)}/src/f${String(f)}.ts`] = "";
    }
    files["packages/ignored/package.json"] = node;
    files["undeclared/package.json"] = node;
    const result = await detect(files);
    expect(result.kind).toBe("workspace");
    expect(result.units).toHaveLength(40);
    for (const unit of result.units) {
      expect(unit.detection.checks[0]!.value.command).toEqual({ cwd: `repo/${unit.root}`, executable: "pnpm", args: ["test"], timeoutSeconds: 1800 });
      expect(unit.detection.setupCommands[0]!.value).toEqual({ cwd: "repo", executable: "pnpm", args: ["install", "--frozen-lockfile"], timeoutSeconds: 900 });
      expect(unit.omittedPaths).toBe(0);
    }
  });

  it.each([
    ["npm", { "package.json": JSON.stringify({ workspaces: ["apps/*"] }) }],
    ["yarn", { "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }), "yarn.lock": "" }],
    ["turbo", { "package.json": JSON.stringify({ workspaces: ["apps/*"] }), "turbo.json": "{}" }],
    ["nx", { "nx.json": "{}", "apps/api/project.json": '{"name":"api"}' }],
    ["nx legacy", { "nx.json": "{}", "workspace.json": '{"projects":{"api":{"root":"apps/api"}}}' }],
  ])("reads %s workspace definitions, deduplicates roots and ignores undeclared packages", async (_name, definition) => {
    const result = await roots({ ...definition, "apps/api/package.json": node, "elsewhere/package.json": node });
    expect(result.filter((root) => root !== ".")).toEqual(["apps/api"]);
  });

  it("detects setup and tests independently for a Gradle multi-module fixture", async () => {
    const result = await detect({
      "settings.gradle.kts": 'rootProject.name = "example"\ninclude(":api", ":lib:util")\n',
      "api/build.gradle.kts": 'plugins { java }', "api/src/test/java/ApiTest.java": "",
      "lib/util/build.gradle.kts": 'plugins { java }', "lib/util/src/test/java/UtilTest.java": "",
    });
    expect(result.units.map((unit) => unit.root)).toEqual(["api", "lib/util"]);
    for (const unit of result.units) {
      expect(unit.detection.setupCommands[0]!.value.cwd).toBe(`repo/${unit.root}`);
      expect(unit.detection.checks[0]!.value.command).toMatchObject({ cwd: `repo/${unit.root}`, executable: "gradle", args: ["--console=plain", "test"] });
    }
  });

  it("reads nested Maven modules", async () => {
    expect(await roots({ "pom.xml": "<project><modules><module>lib</module></modules></project>", "lib/pom.xml": "<project><modules><module>util</module></modules></project>", "lib/util/pom.xml": "<project/>" })).toEqual([".", "lib", "lib/util"]);
  });

  it("detects setup and pytest independently for a Python uv multi-project fixture", async () => {
    const result = await detect({
      "pyproject.toml": '[tool.uv.workspace]\nmembers = [\n "libs/*",\n]\nexclude = ["libs/skip"]\n',
      "libs/a/pyproject.toml": '[project]\nname = "a"\n[tool.pytest.ini_options]\n',
      "libs/b/pyproject.toml": '[project]\nname = "b"\n[tool.pytest.ini_options]\n',
      "libs/skip/pyproject.toml": '[project]\nname = "skip"',
    });
    expect(result.units.map((unit) => unit.root)).toEqual([".", "libs/a", "libs/b"]);
    for (const unit of result.units.slice(1)) {
      expect(unit.detection.setupCommands[0]!.value).toMatchObject({ cwd: `repo/${unit.root}`, executable: "pip", args: ["install", "-e", "."] });
      expect(unit.detection.checks[0]!.value.command).toMatchObject({ cwd: `repo/${unit.root}`, executable: "pytest" });
    }
  });

  it("isolates nested packages and applies 5000 paths and 32 checks per package", async () => {
    const files: Files = { "package.json": '{"workspaces":["a","a/nested","b"]}', "a/package.json": node, "a/nested/package.json": node, "b/package.json": node };
    for (let n = 0; n < 5001; n += 1) files[`a/file${String(n)}.txt`] = "";
    const many: Detector = ({ cwd, repo }) => {
      expect(repo.paths).not.toContain("nested/package.json");
      return Promise.resolve({ checks: Array.from({ length: 40 }, (_, n) => ({ source: "detector:many" as const, value: { id: `t${String(n)}`, label: "Test", kind: "test" as const, command: { cwd, executable: "make", args: [String(n)], timeoutSeconds: 60 } } })) });
    };
    const result = await detect(files, { only: ["many"], extraDetectors: [{ name: "many", run: many }] });
    expect(result.units.map((unit) => [unit.root, unit.omittedPaths, unit.detection.checks.length])).toEqual([[".", 0, 32], ["a", 2, 32], ["a/nested", 0, 32], ["b", 0, 32]]);
    for (const unit of result.units) expect(unit.detection.notes.join(" ")).toContain("More than 32 checks");
  });

  it.each([
    { "pnpm-workspace.yaml": "packages: [", "a/package.json": node },
    { "package.json": '{"workspaces":"apps/*"}' },
    { "package.json": '{"workspaces":["../outside"]}' },
    { "package.json": '{"workspaces":["a","missing"]}', "a/package.json": node },
    { "settings.gradle": 'include(":api" + suffix)', "api/build.gradle": 'plugins { java }' },
    { "settings.gradle": 'include(":api")\nproject(":api").projectDir = file("elsewhere")', "api/build.gradle": 'plugins { java }' },
    { "pyproject.toml": '[tool.uv.workspace]\nmembers = compute()' },
    { "nx.json": "{broken" },
    { "turbo.json": "{}" },
  ])("refuses unreadable, unsupported or unresolved definitions instead of falling back: %j", async (files) => {
    const result = await detect(files);
    expect(result).toMatchObject({ kind: "unavailable", units: [] });
    if (result.kind === "unavailable") expect(typeof result.reason).toBe("string");
  });

  it("refuses a listed definition that cannot be loaded and never reads outside the inventory", async () => {
    const read: string[] = [];
    const result = await detectWorkspacePackages(["pnpm-workspace.yaml"], (path) => { read.push(path); return Promise.reject(new Error("private detail")); }, "repo");
    expect(result).toEqual({ kind: "unavailable", units: [], reason: "Workspace definitions could not be read." });
    expect(read).toEqual(["pnpm-workspace.yaml"]);
  });
  it("keeps a child's own lock ahead of a different root package manager", async () => {
    const result = await detect({ "package.json": '{"workspaces":["a"]}', "package-lock.json": "{}", "a/package.json": node, "a/yarn.lock": "" });
    const child = result.units.find((unit) => unit.root === "a")!;
    expect(child.detection.checks[0]!.value.command.executable).toBe("yarn");
    expect(child.detection.setupCommands[0]!.value.cwd).toBe("repo/a");
    expect(child.inheritedFiles).toEqual([]);
  });

  it.each([
    { "package.json": '{"workspaces":["a"]}', "a/package.json": node, "../escape": "" },
    { "package.json": '{"workspaces":["/absolute"]}', "/absolute/package.json": node },
    { "package.json": '{"workspaces":["a/../b"]}', "b/package.json": node },
    { "package.json": '{"workspaces":["a"]}', "a/package.json": node, "a/" : "" },
    { "package.json": '{"workspaces":["a"]}', "a/package.json": node, ["a/" + String.fromCharCode(0)]: "" },
    { "package.json": '{"workspaces":["a"]}', "a/package.json": node, ["a/" + "x".repeat(513)]: "" },
    { "package.json": '{"workspaces":["a"]}', "a/package.json": node, ["a/" + String.fromCharCode(92) + "x"]: "" },
    { "pnpm-workspace.yaml": "packages: []" },
    { "nx.json": "{}", "workspace.json": '{"projects":{"bad":{"root":7},"good":{"root":"a"}}}', "a/project.json": '{}' },
    { "nx.json": "{}", "a/project.json": "null" },
    { "nx.json": "[]", "a/project.json": "{}" },
    { "nx.json": "{}", "workspace.json": '{"projects":{"a":"missing"}}' },
    { "pom.xml": "<project><modules>" },
    { "pom.xml": "<project><modules><module>a</module><other/></modules></project>", "a/pom.xml": "<project/>" },
    { "pom.xml": "<project><modules><module>missing</module></modules></project>", "missing/package.json": node },
    { "pom.xml": "<project><modules><module>${name}</module></modules></project>", "${name}/pom.xml": "<project/>" },
    { "pyproject.toml": '[tool.uv.workspace]\nexclude = ["b"]', "a/pyproject.toml": '[project]' },
    { "pnpm-workspace.yaml": "packages: [a, 7]", "a/package.json": node },
    { "pnpm-workspace.yaml": "packages: [*undefined]", "a/package.json": node },
    { "package.json": '{"workspaces":["a"]}' + " ".repeat(1048576), "a/package.json": node },
    { "pnpm-workspace.yaml": "packages: ['a']\n" + "#".repeat(262144), "a/package.json": node },
  ])("refuses unsupported definitions and invalid inventories (case %#)", async (files) => {
    const result = await detect(files);
    expect(result.kind).toBe("unavailable");
    expect(result.units).toEqual([]);
  });

  it("rejects an over-budget declaration inventory explicitly", async () => {
    const files: Files = { "nx.json": "{}" };
    for (let n = 0; n < 5000; n += 1) files[`p${String(n)}/project.json`] = "{}";
    const reads: string[] = [];
    expect(await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo")).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).toEqual([]);
  });

  it("handles globstar, exclusions and duplicate declarations without matching a sibling prefix", async () => {
    const result = await roots({ "package.json": '{"workspaces":["apps/**","apps/api","!apps/no"]}', "apps/api/package.json": node, "apps/deep/lib/package.json": node, "apps/no/package.json": node, "apps2/wrong/package.json": node });
    expect(result).toEqual([".", "apps/api", "apps/deep/lib"]);
  });

  it("keeps byte budgets independent and accepts exactly 5000 paths per package", async () => {
    const files: Files = { "package.json": '{"workspaces":["a","b"]}' };
    for (const root of ["a", "b"]) {
      files[`${root}/package.json`] = node;
      for (let n = 0; n < 4999; n += 1) files[`${root}/f${String(n)}.txt`] = n < 17 ? "x".repeat(262144) : "";
    }
    const budget: Detector = async ({ repo, cwd }) => {
      if (cwd === "repo") return {};
      for (let n = 0; n < 16; n += 1) expect((await repo.read(`f${String(n)}.txt`))?.length).toBe(262144);
      expect(await repo.read("f16.txt")).toBeUndefined();
      return { notes: ["byte-budget detector ran"] };
    };
    const result = await detect(files, { only: ["budget"], extraDetectors: [{ name: "budget", run: budget }] });
    expect(result.units.map((unit) => unit.omittedPaths)).toEqual([0, 0, 0]);
    for (const unit of result.units.slice(1)) {
      expect(unit.detection.notes).toContain("byte-budget detector ran");
      expect(unit.detection.notes).toContain("Some files were not read: the read budget ran out.");
    }
  });

  it("reads literal Python arrays with indentation, comments and bracket globs", async () => {
    expect(await roots({
      "pyproject.toml": '  [tool.uv.workspace] # workspace\n  members = [\n    "libs/[ab]", # members\n  ]\n  exclude = ["libs/b"]\n[project]\nname = "root"',
      "libs/a/pyproject.toml": "[project]", "libs/b/pyproject.toml": "[project]",
    })).toEqual([".", "libs/a"]);
  });

  it.each([
    '[tool.uv.workspace]\nmembers = ["a"] + unknown',
    '[tool.uv.workspace]\nmembers = ["a"]\nmembers = ["b"]',
  ])("refuses nonliteral or duplicate Python member definitions", async (definition) => {
    expect(await detect({ "pyproject.toml": definition, "a/pyproject.toml": "[project]", "b/pyproject.toml": "[project]" })).toMatchObject({ kind: "unavailable", units: [] });
  });

  it.each([
    "<project><modules><module>a</module></modules><modules></project>",
    "<project><profiles><profile><modules><module>a</module></modules></profile></profiles></project>",
  ])("refuses incomplete or profile-dependent Maven module declarations", async (pom) => {
    expect(await detect({ "pom.xml": pom, "a/pom.xml": "<project/>" })).toMatchObject({ kind: "unavailable", units: [] });
  });

  it("keeps a non-workspace Maven repository golden even with more than 5000 nested example manifests", async () => {
    const files: Files = {};
    for (let n = 0; n < 5001; n += 1) files[`examples/p${String(n)}/pom.xml`] = "<project/>";
    files["pom.xml"] = "<project/>";
    const old = await runDetectors(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, "repo");
    const result = await detect(files);
    expect(result.kind).toBe("single");
    expect(JSON.stringify(result.units[0]!.detection)).toBe(JSON.stringify(old));
  });

});
