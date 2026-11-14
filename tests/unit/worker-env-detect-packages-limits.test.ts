import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { detectWorkspacePackages, detectWorkspacePackagesInThread } from "../../packages/worker/src/env-detect/packages.js";
import { discoverWorkspaceRoots } from "../../packages/worker/src/env-detect/workspace-roots.js";

type Files = Record<string, string>;
const node = '{"scripts":{"test":"vitest run"}}';
const entry = { url: new URL("../../packages/worker/src/env-detect/detect-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] };
const detect = (files: Files, options = {}) => detectWorkspacePackages(Object.keys(files), (path) => Promise.resolve(files[path]), "repo", { entry, ...options });
const declaration = (files: Files) => discoverWorkspaceRoots(Object.keys(files), (path) => Promise.resolve(files[path]));

describe("workspace call limits", () => {
  it("accepts exactly 64 units and rejects 65 before loading package content", async () => {
    const files: Files = { "pnpm-workspace.yaml": "packages: ['p/*']" };
    for (let n = 0; n < 63; n += 1) files[`p/${String(n)}/package.json`] = node;
    const result = await detect(files);
    expect(result.kind).toBe("workspace");
    expect(result.units).toHaveLength(64);
    expect(result.units.slice(1).every((unit) => unit.detection.checks.length === 1)).toBe(true);
    files["p/extra/package.json"] = node;
    const reads: string[] = [];
    expect(await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo", { entry })).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).toEqual(["pnpm-workspace.yaml"]);
  });

  it("rejects an oversized inventory before attempting the guard", async () => {
    const paths = Array.from({ length: 5001 }, (_, n) => `f${String(n)}`);
    expect(await detectWorkspacePackages(paths, () => Promise.resolve(""), "repo", { timeoutMs: 100, entry: { url: new URL("../support/env-detect-stuck-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] } })).toEqual({ kind: "unavailable", units: [], reason: "Workspace inventory exceeds 5000 files." });
    await expect(discoverWorkspaceRoots(paths, () => Promise.resolve(""))).rejects.toThrow();
  });

  it("keeps a unit reader from reading files owned by nested units", async () => {
    // On code/next this probes with a plug-in detector (step 5's build-system plug-ins, not on mainline yet). Here the built-in
    // compose detector, which reads every compose file its reader lists, shows the same thing: a file owned by a nested unit is
    // seen by that unit only, never by the unit around it.
    const files: Files = { "package.json": '{"workspaces":["a","a/nested"]}', "a/package.json": node, "a/nested/package.json": node, "a/nested/docker-compose.yml": "services:\n  db:\n    image: postgres:16\n" };
    const result = await detectWorkspacePackagesInThread(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, "repo", { only: ["compose"] });
    const unit = (root: string) => result.units.find((entry) => entry.root === root)!;
    expect(unit("a/nested").detection.dependencies?.length ?? 0).toBeGreaterThan(0);
    expect(unit("a").detection.dependencies ?? []).toEqual([]);
    expect(unit(".").detection.dependencies ?? []).toEqual([]);
  });

  it("accepts exactly 5000 inventory paths", async () => {
    const files: Files = { "package.json": node };
    for (let n = 1; n < 5000; n += 1) files[`docs/${String(n)}.txt`] = "";
    const result = await detect(files);
    expect(result.kind).toBe("single");
    expect(result.units[0]!.omittedPaths).toBe(0);
    expect(result.units[0]!.detection.checks).toHaveLength(1);
  });

  it("refuses inventory entries the bounded reader would discard", async () => {
    expect(await detect({ "package.json": node, ["x".repeat(513)]: "" })).toMatchObject({ kind: "unavailable", units: [] });
  });

  it("reads the inherited root lock and each manifest only once for the whole call", async () => {
    const files: Files = { "package.json": '{"workspaces":["p/*"]}', "pnpm-lock.yaml": "#".repeat(250000) };
    for (let n = 0; n < 40; n += 1) files[`p/${String(n)}/package.json`] = node;
    const reads: string[] = [];
    const result = await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo", { entry });
    expect(result.kind).toBe("workspace");
    expect(reads.filter((path) => path === "pnpm-lock.yaml")).toHaveLength(1);
    expect(reads).toHaveLength(new Set(reads).size);
    expect(result.units.slice(1).every((unit) => unit.detection.checks[0]!.value.command.executable === "pnpm")).toBe(true);
  });

  it("shares the 4 MiB budget between discovery and all packages and stops further loads", async () => {
    const definition = "packages: ['p/*']";
    const files: Files = { "pnpm-workspace.yaml": definition };
    // Exactly 4 MiB, including discovery, must still work.
    for (let n = 0; n < 16; n += 1) files[`p/${String(n).padStart(2, "0")}/package.json`] = node.padEnd(262144 - (n === 0 ? definition.length : 0));
    expect((await detect(files)).kind).toBe("workspace");
    files["p/16/package.json"] = node;
    files["p/17/package.json"] = node;
    const reads: string[] = [];
    const result = await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo", { entry });
    expect(result).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).not.toContain("p/17/package.json");
  });

  it("ends the whole call while discovery is waiting on a loader", async () => {
    const started = performance.now();
    const reads: string[] = [];
    // The deadline must outlast detector-thread start-up on a loaded CI runner (2 s did not), so the loader is reached and then the call ends.
    const result = await detectWorkspacePackages(["pnpm-workspace.yaml"], (path) => { reads.push(path); return new Promise(() => {}); }, "repo", { entry, timeoutMs: 6000 });
    expect(result).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).toEqual(["pnpm-workspace.yaml"]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("stops uncached loads inside a detector after the shared budget is exhausted", async () => {
    const files: Files = { "pnpm-workspace.yaml": "packages: ['a']", "a/package.json": node };
    for (let n = 0; n < 40; n += 1) files[`a/.env.f${String(n)}`] = "#".repeat(262144);
    const reads: string[] = [];
    expect(await detectWorkspacePackages(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); }, "repo", { entry, only: ["env"] })).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads.filter((path) => path.startsWith("a/.env"))).toHaveLength(16);
    expect(reads).not.toContain("a/.env.f16");
  });

  it("ends a stuck detector thread without an unguarded or partial fallback", async () => {
    const started = performance.now();
    const reads: string[] = [];
    // Signal a read before occupying the thread, so the control proves the busy loop started.
    const busy = 'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ type: "read", id: 1, path: "package.json" }); for (;;) {}';
    const result = await detectWorkspacePackages(["package.json"], (path) => { reads.push(path); return Promise.resolve(node); }, "repo", { timeoutMs: 300, entry: { url: new URL(`data:text/javascript,${encodeURIComponent(busy)}`), execArgv: [] } });
    expect(result).toMatchObject({ kind: "unavailable", units: [] });
    expect(reads).toEqual(["package.json"]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("refuses a missing guard instead of running unguarded", async () => {
    expect(await detect({ "package.json": node }, { entry: { url: new URL("../support/no-such-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] } })).toMatchObject({ kind: "unavailable", units: [] });
  });

  it("retains undeclared files in a root remainder unit", async () => {
    const result = await detect({ "settings.gradle": "include ':a'", "a/build.gradle": "plugins { java }", "packages/b/package.json": '{"dependencies":{"pg":"8"}}' });
    expect(result.units.map((unit) => unit.root)).toEqual([".", "a"]);
    expect(result.units[0]!.detection.dependencies?.map((item) => item.family)).toContain("postgres");
  });
});

describe("bounded workspace patterns", () => {
  it("rejects the review's 127 KiB pattern bomb quickly", async () => {
    const files: Files = {};
    const patterns: string[] = [];
    for (let n = 0; n < 4000; n += 1) { files[`d/x${String(n)}/package.json`] = node; patterns.push(`  - 'd/x${String(n)}'`); }
    for (let n = 0; n < 4000; n += 1) patterns.push(`  - '!d/zz${String(n)}/**'`);
    files["pnpm-workspace.yaml"] = `packages:\n${patterns.join("\n")}\n`;
    const started = performance.now();
    await expect(declaration(files)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  }, 4000);

  it("matches 256 compiled prefix-pruned patterns against 4000 folders quickly", async () => {
    const files: Files = {};
    const patterns: string[] = [];
    for (let n = 0; n < 4000; n += 1) files[`d/x${String(n)}/package.json`] = node;
    for (let n = 0; n < 128; n += 1) patterns.push(`d/x${String(n)}`, `!d/z${String(n)}/**`);
    files["pnpm-workspace.yaml"] = `packages: ${JSON.stringify(patterns)}`;
    const started = performance.now();
    const tests = vi.spyOn(RegExp.prototype, "test");
    try {
      expect(await declaration(files)).toHaveLength(128);
      expect(tests.mock.calls.length).toBeLessThan(20000);
      expect(performance.now() - started).toBeLessThan(500);
    } finally { tests.mockRestore(); }
  });

  it("counts exclusions and patterns across declarations in the same cap", async () => {
    const files: Files = { "package.json": JSON.stringify({ workspaces: Array(128).fill("a") }), "a/package.json": node, "pyproject.toml": `[tool.uv.workspace]\nmembers = ["a"]\nexclude = ${JSON.stringify(Array(128).fill("b"))}` };
    await expect(declaration(files)).rejects.toThrow();
  });

  it.each(["apps/{a,b}", "apps/@(a)", "apps/[", "apps/a**b"])("refuses unsupported glob syntax: %s", async (pattern) => {
    await expect(declaration({ "package.json": JSON.stringify({ workspaces: [pattern] }), "apps/a/package.json": node, "apps/ab/package.json": node, "apps/[/package.json": node, [`${pattern}/package.json`]: node })).rejects.toThrow();
  });
});

describe("complete Gradle declarations", () => {
  it.each(["settings.gradle", "settings.gradle.kts"])("refuses a bare multiline continuation in %s", async (path) => {
    expect(await detect({ [path]: "include ':a',\n        ':b'\n", "a/build.gradle": "plugins { java }", "b/build.gradle": "plugins { java }" })).toMatchObject({ kind: "unavailable", units: [] });
  });
  it("refuses an unterminated parenthesized include", async () => {
    expect(await detect({ "settings.gradle": 'include(":a"', "a/build.gradle": "plugins { java }" })).toMatchObject({ kind: "unavailable", units: [] });
  });
  it.each(["settings.gradle", "settings.gradle.kts"])("reads every parenthesized multiline module in %s", async (path) => {
    const result = await detect({ [path]: 'include(\n ":a",\n ":b",\n)\n', "a/build.gradle": "plugins { java }", "b/build.gradle": "plugins { java }" });
    expect(result.units.map((unit) => unit.root)).toEqual([".", "a", "b"]);
  });
});

it("refuses a malformed root package when another file declares a workspace", async () => {
  expect(await detect({ "package.json": "{ not json", "pnpm-workspace.yaml": "packages: ['a']", "a/package.json": node })).toMatchObject({ kind: "unavailable", units: [] });
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
