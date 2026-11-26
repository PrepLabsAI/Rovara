import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { expectLinearScalingAsync } from "../support/scaling.js";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { detectWorkspacePackages, detectWorkspacePackagesInThread } from "../../packages/worker/src/env-detect/packages.js";
import { discoverWorkspaceRoots } from "../../packages/worker/src/env-detect/workspace-roots.js";

type Files = Record<string, string>;
const node = '{"scripts":{"test":"vitest run"}}';
const entry = { url: new URL("../../packages/worker/src/env-detect/detect-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] };
const detect = (files: Files, options = {}) => detectWorkspacePackages(Object.keys(files), (path) => Promise.resolve(files[path]), "repo", { entry, ...options });
const declaration = (files: Files) => discoverWorkspaceRoots(Object.keys(files), (path) => Promise.resolve(files[path]));

describe("workspace call limits", () => {

  it("rejects an oversized inventory before attempting the guard", async () => {
    const paths = Array.from({ length: 5001 }, (_, n) => `f${String(n)}`);
    expect(await detectWorkspacePackages(paths, () => Promise.resolve(""), "repo", { timeoutMs: 100, entry: { url: new URL("../support/env-detect-stuck-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] } })).toEqual({ kind: "unavailable", units: [], reason: "Workspace inventory exceeds 5000 files." });
    await expect(discoverWorkspaceRoots(paths, () => Promise.resolve(""))).rejects.toThrow();
  });

  it("keeps a unit reader from reading files owned by nested units", async () => {
    const files: Files = { "package.json": '{"workspaces":["a","a/nested"]}', "a/package.json": node, "a/nested/package.json": node };
    const result = await detectWorkspacePackagesInThread(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, "repo", { only: ["ownership"], extraDetectors: [{ name: "ownership", run: async ({ repo, cwd }) => ({ notes: [cwd === "repo/a" && await repo.read("nested/package.json") !== undefined ? "leaked" : "isolated"] }) }] });
    expect(result.units.find((unit) => unit.root === "a")!.detection.notes).toEqual(["isolated"]);
  });

  it("refuses inventory entries the bounded reader would discard", async () => {
    expect(await detect({ "package.json": node, ["x".repeat(513)]: "" })).toMatchObject({ kind: "unavailable", units: [] });
  });

  it("ends the whole call while discovery is waiting on a loader", async () => {
    const started = performance.now();
    const reads: string[] = [];
    // The deadline must outlast detector-thread start-up on a loaded CI runner (2 s did not), so the loader is reached and then the call ends.
    const result = await detectWorkspacePackages(["pnpm-workspace.yaml"], (path) => { reads.push(path); return new Promise(() => {}); }, "repo", { entry, timeoutMs: 6000 });
    expect(result).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).toEqual(["pnpm-workspace.yaml"]);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it("stops uncached loads inside a detector after the shared budget is exhausted", async () => {
    const files: Files = { "pnpm-workspace.yaml": "packages: ['a']", "a/package.json": node };
    for (let n = 0; n < 40; n += 1) files[`a/.env.f${String(n)}`] = "#".repeat(262144);
    const reads: string[] = [];
    expect(await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo", { entry, only: ["env"] })).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads.filter((path) => path.startsWith("a/.env"))).toHaveLength(16);
    expect(reads).not.toContain("a/.env.f16");
  });

  it("refuses a missing guard instead of running unguarded", async () => {
    expect(await detect({ "package.json": node }, { entry: { url: new URL("../support/no-such-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] } })).toMatchObject({ kind: "unavailable", units: [] });
  });

});

describe("bounded workspace patterns", () => {

  it("matches 256 compiled prefix-pruned patterns against 4000 folders quickly", async () => {
    const filesOf = (folders: number): Files => {
      const files: Files = {};
      const patterns: string[] = [];
      for (let n = 0; n < folders; n += 1) files[`d/x${String(n)}/package.json`] = node;
      for (let n = 0; n < 128; n += 1) patterns.push(`d/x${String(n)}`, `!d/z${String(n)}/**`);
      files["pnpm-workspace.yaml"] = `packages: ${JSON.stringify(patterns)}`;
      return files;
    };
    // The time must grow about eight times from 300 to 2400 folders (about 100 bytes a folder, so the 8N input stays at or under 256 KiB and stays in CPU cache), never sixty-four (a scaling check, not a wall-clock bound). The full 4000 folders run once below.
    let roots: string[] | undefined;
    await expectLinearScalingAsync((folders) => {
      const files = filesOf(folders);
      return async () => { roots = await declaration(files); };
    }, { n: 300, unitBytes: 100, label: "prefix-pruned patterns against folders" });
    expect(roots).toHaveLength(128);
    // The work counter: with the prefix seek, 4000 folders cost far fewer than 20000 pattern tests.
    const files = filesOf(4000);
    const tests = vi.spyOn(RegExp.prototype, "test");
    try {
      expect(await declaration(files)).toHaveLength(128);
      expect(tests.mock.calls.length).toBeLessThan(20000);
    } finally { tests.mockRestore(); }
  }, 60_000);

  it("counts exclusions and patterns across declarations in the same cap", async () => {
    const files: Files = { "package.json": JSON.stringify({ workspaces: Array(128).fill("a") }), "a/package.json": node, "pyproject.toml": `[tool.uv.workspace]\nmembers = ["a"]\nexclude = ${JSON.stringify(Array(128).fill("b"))}` };
    await expect(declaration(files)).rejects.toThrow();
  });

  it.each(["apps/{a,b}", "apps/[", "apps/a**b"])("refuses unsupported glob syntax: %s", async (pattern) => {
    await expect(declaration({ "package.json": JSON.stringify({ workspaces: [pattern] }), "apps/a/package.json": node, "apps/ab/package.json": node, "apps/[/package.json": node, [`${pattern}/package.json`]: node })).rejects.toThrow();
  });
});

describe("single-repository goldens from review 1", () => {
  const cases: Array<[string, Files]> = [
    ["pnpm settings only", { "package.json": node, "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "onlyBuiltDependencies: [esbuild]\ncatalog: {react: '19'}" }],
    ["Nx standalone", { "package.json": node, "nx.json": "{}" }],
    ["Gradle includeBuild", { "build.gradle.kts": "plugins { java }", "settings.gradle.kts": 'pluginManagement { includeBuild("build-logic") }' }],
    ["Gradle includeGroup", { "build.gradle.kts": "plugins { java }", "settings.gradle.kts": 'repositories { content { includeGroup("com.x") } }' }],
    ["Gradle include string", { "build.gradle": "plugins { java }", "settings.gradle": "rootProject.name = 'include-tools'" }],
    ["yarn nohoist only", { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, workspaces: { nohoist: ["**"] } }), "yarn.lock": "" }],
    ["malformed root package.json", { "package.json": "{ not json", "pom.xml": "<project/>" }],
    ["oversize root pom", { "pom.xml": `<project>${" ".repeat(300000)}</project>` }],
  ];
  it.each(cases)("preserves %s byte for byte", async (_name, files) => {
    const old = await runDetectors(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, "repo");
    const result = await detect(files);
    expect(result.kind).toBe("single");
    expect(result.units).toHaveLength(1);
    expect(JSON.stringify(result.units[0]!.detection)).toBe(JSON.stringify(old));
  });
});
