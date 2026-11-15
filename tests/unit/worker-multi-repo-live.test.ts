// MR1-LIVE: installed dependency folders mirrored into MR1's check root, the fallback to today's path, and the switch.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceRawSchema, MULTI_REPO_FALLBACK_NOTES } from "@agentx/contracts";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import * as isolatedCopies from "../../packages/worker/src/isolated-git.js";
import * as partCopies from "../../packages/worker/src/parallel-parts-git.js";
import { createDependencyMirror, DEPENDENCY_MIRROR_LIMITS, DEPENDENCY_REFUSAL, dependencyFolders, mirrorDependencyFolders, verifyMirroredLinks } from "../../packages/worker/src/multi-repo-dependencies.js";
import { createRepositoryCheckSupplier, MULTI_REPO_CHECKS_LIVE } from "../../packages/worker/src/multi-repo-supplier.js";
import { createCheckRunners, runChecks, type CheckPlan, type CheckRound, type CheckRunners } from "../../packages/worker/src/verification/checks.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", ...args], { cwd, env: isolatedGitEnvironment(cwd), encoding: "utf8" }).trim();
const put = async (root: string, path: string, text: string, mode?: number) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); if (mode !== undefined) await chmod(join(root, path), mode); };
const temporary = async (prefix: string) => { const root = realpathSync.native(await mkdtemp(join(tmpdir(), prefix))); roots.push(root); return root; };
const [SUBMODULE, LIMITS, DEPENDENCY_LIMITS, LINK, LAYOUT, COMMIT, WIRING, COPY] = MULTI_REPO_FALLBACK_NOTES;

type Repositories = { repositoryId: string; path: string; baseCommit: string }[];
async function workspace(repos: Record<string, Record<string, string>>) {
  const root = await temporary("mr1-live-");
  const repositories: Repositories = [];
  for (const [name, files] of Object.entries(repos)) {
    const directory = join(root, name); await mkdir(directory);
    git(directory, "init", "-q");
    for (const [path, text] of Object.entries(files)) await put(directory, path, text);
    git(directory, "add", "-A"); git(directory, "commit", "-qm", "base");
    repositories.push({ repositoryId: name, path: name, baseCommit: git(directory, "rev-parse", "HEAD") });
  }
  return { root, repositories };
}

/** app depends on lib (file:../lib, as npm installs it: a relative link) and on an installed third-party package with a .bin link; lib needs its own installed package. */
async function nodeWorkspace(gitignore = "node_modules/\n") {
  const w = await workspace({
    app: { ".gitignore": gitignore, "package.json": JSON.stringify({ name: "app", dependencies: { lib: "file:../lib", "fmt-app": "1.0.0" } }), "test.js": "const fmt = require('fmt-app'); console.log(fmt(require('lib')));\n" },
    lib: { ".gitignore": "node_modules/\n", "package.json": JSON.stringify({ name: "lib", main: "index.js" }), "index.js": "module.exports = require('pad-lib')('lib');\n" },
  });
  await put(w.root, "lib/node_modules/pad-lib/package.json", JSON.stringify({ name: "pad-lib", main: "index.js" }));
  await put(w.root, "lib/node_modules/pad-lib/index.js", "module.exports = (s) => `[${s}]`;\n");
  await put(w.root, "app/node_modules/fmt-app/package.json", JSON.stringify({ name: "fmt-app", main: "index.js" }));
  await put(w.root, "app/node_modules/fmt-app/index.js", "module.exports = (s) => `fmt:${s}`;\n");
  await put(w.root, "app/node_modules/fmt-app/cli.js", "#!/usr/bin/env node\nconsole.log('cli:' + require('./index.js')('ok'));\n", 0o755);
  await mkdir(join(w.root, "app/node_modules/.bin"));
  await symlink("../fmt-app/cli.js", join(w.root, "app/node_modules/.bin/fmt-cli"));
  await symlink("../../lib", join(w.root, "app/node_modules/lib"));
  return w;
}
const nodePlan: CheckPlan = { source: "project", readiness: [
  { executable: process.execPath, args: ["test.js"], cwd: "app", timeoutSeconds: 20 },
  { executable: "node_modules/.bin/fmt-cli", args: [], cwd: "app", timeoutSeconds: 20 },
] };

const pythonInfo = () => { const [executable, version] = execFileSync("python3", ["-c", "import os,sys;print(os.path.realpath(sys.executable));print('%d.%d'%sys.version_info[:2])"], { encoding: "utf8" }).trim().split("\n"); return { executable: executable!, version: version! }; };
/** A virtual environment exactly as `python3 -m venv` lays it out (pyvenv.cfg, an absolute interpreter link, site-packages), without pip. */
async function venv(root: string, path: string, site: Record<string, string>) {
  const { executable, version } = pythonInfo();
  await put(root, `${path}/pyvenv.cfg`, `home = ${dirname(executable)}\ninclude-system-site-packages = false\nversion = ${version}\n`);
  await mkdir(join(root, path, "bin"), { recursive: true });
  await symlink(executable, join(root, path, "bin/python"));
  await symlink("python", join(root, path, "bin/python3"));
  for (const [name, text] of Object.entries(site)) await put(root, `${path}/lib/python${version}/site-packages/${name}`, text);
}
/** app's venv: a third-party module, editable installs of app and lib (.pth with absolute workspace paths), and a script whose shebang names the venv. */
async function pythonWorkspace() {
  const w = await workspace({
    app: { ".gitignore": ".venv/\n", "pyproject.toml": '[project]\nname = "app"\ndependencies = ["libpkg"]\n', "src/apppkg/__init__.py": "VALUE = 'app'\n" },
    lib: { ".gitignore": ".venv/\n", "pyproject.toml": '[project]\nname = "libpkg"\n', "src/libpkg/__init__.py": "VALUE = 'lib'\n" },
  });
  await venv(w.root, "app/.venv", { "thirdparty.py": "VALUE = 'third'\n", "_apppkg.pth": `${join(w.root, "app/src")}\n`, "_libpkg.pth": `${join(w.root, "lib/src")}\n` });
  await put(w.root, "app/.venv/bin/show", `#!${join(w.root, "app/.venv/bin/python")}\nimport os, sys, thirdparty, apppkg, libpkg\nhere = os.path.dirname(os.getcwd())\nprint(thirdparty.VALUE, apppkg.VALUE, libpkg.VALUE, sys.prefix == os.path.join(os.getcwd(), '.venv'), os.path.realpath(apppkg.__file__).startswith(here + os.sep))\n`, 0o755);
  return w;
}
const pythonPlan: CheckPlan = { source: "project", readiness: [
  { executable: ".venv/bin/python", args: ["-c", "import thirdparty, apppkg, libpkg; print(thirdparty.VALUE, apppkg.VALUE, libpkg.VALUE)"], cwd: "app", timeoutSeconds: 20 },
  { executable: ".venv/bin/show", args: [], cwd: "app", timeoutSeconds: 20 },
] };
/**
 * MR1's Python wiring runs `python3 -m pip install --no-build-isolation`, which needs setuptools on the host (not on every machine). The fixture puts the
 * provider into the --target folder itself (copy) or fails as pip does without setuptools (fail); every other command runs for real.
 */
function withPip(root: string, base: CheckRunners, outcome: "copy" | "fail"): CheckRunners {
  return { ...base, async runProjectCommand(command, signal) {
    if (command.executable !== "python3" || command.args.slice(0, 3).join(" ") !== "-m pip install") return base.runProjectCommand(command, signal);
    if (outcome === "fail") return { exitCode: 1, timedOut: false, stdout: "", stderr: "ModuleNotFoundError: No module named 'setuptools'" };
    const cwd = join(root, command.cwd);
    await cp(join(resolve(cwd, command.args.at(-1)!), "src/libpkg"), join(resolve(cwd, command.args[command.args.indexOf("--target") + 1]!), "libpkg"), { recursive: true });
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  } };
}

const options = () => ({ signal: new AbortController().signal, budgetMs: 60_000 });
const comparable = (round: CheckRound) => ({ stopped: round.stopped, entries: round.entries.map((entry) => ({ ...entry, durationMs: 0 })) });
async function listing(directory: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // Python writes its bytecode cache beside imported code on today's path too: not part of what MR1 may change.
    if (entry.name === ".git" || entry.name.startsWith(".agentx") || entry.name === "__pycache__") continue;
    if (entry.isSymbolicLink()) out.push(`${path} -> ${await readlink(join(directory, path))}`);
    else if (entry.isDirectory()) out.push(`${path}/`, ...await listing(directory, path));
    else out.push(`${path} ${(await readFile(join(directory, path))).toString("base64")}`);
  }
  return out;
}
/** Today's path (MR1 off) and the live path on the same workspace and plan. */
async function bothPaths(w: { root: string; repositories: Repositories }, plan: CheckPlan, base: CheckRunners = createCheckRunners({ rootPath: w.root, local: true })) {
  const today = await runChecks(plan, createRepositoryCheckSupplier({ live: false, rootPath: w.root, repositories: w.repositories }).scope(base), options());
  const live = createRepositoryCheckSupplier({ live: true, rootPath: w.root, repositories: w.repositories });
  const runners = live.scope(base);
  const result = await runChecks(plan, runners, options());
  return { today, result, live, runners };
}
const checkRoots = async (root: string) => (await readdir(root)).filter((name) => name.startsWith(".agentx-check-"));

describe("MR1-LIVE: ordinary single-edge tasks pass identically to today's path", () => {
  it("Node: installed packages, a .bin link, a file: dependency link and the provider's own packages", async () => {
    const w = await nodeWorkspace();
    const before = await listing(w.root);
    const { today, result, live } = await bothPaths(w, nodePlan);
    expect(today.entries.map((entry) => [entry.after, entry.output])).toEqual([["passed", "fmt:[lib]\n"], ["passed", "cli:fmt:ok\n"]]);
    expect(comparable(result)).toEqual(comparable(today));
    // It really ran in MR1's check root: the edge is recorded with no fallback note.
    expect(await live.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 0 })).toEqual({ edges: [{ consumer: "app", provider: "lib", language: "node", source: "both" }], notes: [] });
    expect(live.notes()).toEqual([]);
    expect(await listing(w.root)).toEqual(before);
    expect(await checkRoots(w.root)).toEqual([]);
  });

  it("Python: a venv with a third-party module, editable .pth installs and a script whose shebang names the venv", async () => {
    const w = await pythonWorkspace();
    const before = await listing(w.root);
    const { today, result, live } = await bothPaths(w, pythonPlan, withPip(w.root, createCheckRunners({ rootPath: w.root, local: true }), "copy"));
    expect(today.entries.map((entry) => [entry.after, entry.output])).toEqual([["passed", "third app lib\n"], ["passed", "third app lib True True\n"]]);
    expect(comparable(result)).toEqual(comparable(today));
    expect(await live.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 0 })).toEqual({ edges: [{ consumer: "app", provider: "lib", language: "python", source: "both" }], notes: [] });
    expect(await listing(w.root)).toEqual(before);
    expect(await checkRoots(w.root)).toEqual([]);
  });

  it("Python with the host's own pip: MR1 or a recorded fallback, never a different result", async () => {
    const w = await pythonWorkspace();
    const { today, result, live } = await bothPaths(w, pythonPlan);
    expect(comparable(result)).toEqual(comparable(today));
    const notes = (await live.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 0 }))?.notes;
    expect([[], [WIRING]]).toContainEqual(notes);
  });

  it("an ignored folder named only in the source's .git/info/exclude stays out of MR1's tree snapshots", async () => {
    const w = await nodeWorkspace("");
    await writeFile(join(w.root, "app/.git/info/exclude"), "node_modules/\n");
    const plan: CheckPlan = { source: "project", readiness: [{ executable: process.execPath, args: ["-e", "require('fs').mkdirSync('node_modules/.cache',{recursive:true}); require('fs').writeFileSync('node_modules/.cache/x','1'); console.log(require('lib'))"], cwd: "app", timeoutSeconds: 20 }] };
    const { today, result, live } = await bothPaths(w, plan);
    expect(comparable(result)).toEqual(comparable(today));
    expect(result.entries[0]?.after).toBe("passed");
    expect(live.notes()).toEqual([]);
  });
});

describe("MR1-LIVE: the switch", () => {
  it("ships switched on", () => {
    expect(MULTI_REPO_CHECKS_LIVE).toBe(true);
  });
  it("single repository golden: the production supplier returns the exact runners and records nothing", async () => {
    const w = await nodeWorkspace();
    const base = createCheckRunners({ rootPath: w.root, local: true });
    const supplier = createRepositoryCheckSupplier({ rootPath: w.root, repositories: w.repositories.slice(0, 1) });
    expect(supplier.scope(base)).toBe(base);
    const plan: CheckPlan = { source: "project", readiness: [nodePlan.readiness![0]!] };
    const control = await runChecks(plan, base, { ...options(), now: () => 0 });
    expect(JSON.stringify(await runChecks(plan, supplier.scope(base), { ...options(), now: () => 0 }))).toBe(JSON.stringify(control));
    expect(await supplier.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 30_000 })).toBeUndefined();
    expect(await checkRoots(w.root)).toEqual([]);
  });
});

describe("MR1-LIVE: link safety", () => {
  const mirrorOf = async (w: { root: string }, checkRoot: string) => createDependencyMirror({ workspace: w.root, checkRoot, copies: new Map([[join(w.root, "app"), join(checkRoot, "app")], [join(w.root, "lib"), join(checkRoot, "lib")]]), checkTime: () => undefined });
  const fresh = async (w: { root: string }) => { const checkRoot = await mkdtemp(join(w.root, ".agentx-check-")); await mkdir(join(checkRoot, "app")); await mkdir(join(checkRoot, "lib")); return { checkRoot, mirror: await mirrorOf(w, checkRoot) }; };
  const node = [{ kind: "node" as const, path: "node_modules" }];

  it("re-points links into a repository at the copy and keeps links inside the folder relative", async () => {
    const w = await nodeWorkspace();
    const { checkRoot, mirror } = await fresh(w);
    expect(await mirrorDependencyFolders(mirror, join(w.root, "app"), join(checkRoot, "app"), node)).toEqual(["node_modules"]);
    await verifyMirroredLinks(mirror);
    expect(await readlink(join(checkRoot, "app/node_modules/lib"))).toBe("../../lib");
    expect(await readlink(join(checkRoot, "app/node_modules/.bin/fmt-cli"))).toBe("../fmt-app/cli.js");
    expect(((await lstat(join(checkRoot, "app/node_modules/fmt-app/cli.js"))).mode & 0o777).toString(8)).toBe("755");
    // A clone or copy, never a hard link: the workspace's file is a different inode.
    expect((await lstat(join(checkRoot, "app/node_modules/fmt-app/index.js"))).ino).not.toBe((await lstat(join(w.root, "app/node_modules/fmt-app/index.js"))).ino);
  });

  it.each([
    ["an absolute link out of the workspace", async (w: { root: string }, outside: string) => symlink(outside, join(w.root, "app/node_modules/evil"))],
    ["a relative link into the workspace outside every repository", async (w: { root: string }) => { await mkdir(join(w.root, "shared")); await symlink("../../shared", join(w.root, "app/node_modules/shared")); }],
    ["a dangling link", async (w: { root: string }) => symlink("../nowhere/at/all", join(w.root, "app/node_modules/gone"))],
  ])("refuses %s while mirroring, before any check", async (_label, plant) => {
    const w = await nodeWorkspace();
    const outside = await temporary("mr1-outside-");
    await plant(w, outside);
    const { checkRoot, mirror } = await fresh(w);
    const mirrored = mirrorDependencyFolders(mirror, join(w.root, "app"), join(checkRoot, "app"), node).then(() => verifyMirroredLinks(mirror));
    await expect(mirrored).rejects.toThrow(DEPENDENCY_REFUSAL.link);
  });

  it("the mirror itself refuses an escaping link (not only the final verification)", async () => {
    const w = await nodeWorkspace();
    const outside = await temporary("mr1-outside-");
    await symlink(outside, join(w.root, "app/node_modules/evil"));
    const { checkRoot, mirror } = await fresh(w);
    await expect(mirrorDependencyFolders(mirror, join(w.root, "app"), join(checkRoot, "app"), node)).rejects.toThrow(DEPENDENCY_REFUSAL.link);
  });

  it("the final verification refuses a mirrored link that resolves out of the check root", async () => {
    const w = await nodeWorkspace();
    const { checkRoot, mirror } = await fresh(w);
    await symlink(w.root, join(checkRoot, "app/escape"));
    mirror.links.push(join(checkRoot, "app/escape"));
    await expect(verifyMirroredLinks(mirror)).rejects.toThrow(DEPENDENCY_REFUSAL.link);
    mirror.links.pop();
    const interpreter = join(checkRoot, "app/python");
    await symlink(process.execPath, interpreter);
    mirror.interpreters.set(interpreter, join(w.root, "not-the-same"));
    await expect(verifyMirroredLinks(mirror)).rejects.toThrow(DEPENDENCY_REFUSAL.link);
  });

  it("a venv's interpreter link may name the base interpreter outside the workspace, recreated to that exact file", async () => {
    const w = await pythonWorkspace();
    const { checkRoot, mirror } = await fresh(w);
    expect(await mirrorDependencyFolders(mirror, join(w.root, "app"), join(checkRoot, "app"), [{ kind: "python", path: ".venv" }])).toEqual([".venv"]);
    await verifyMirroredLinks(mirror);
    expect(await readlink(join(checkRoot, "app/.venv/bin/python"))).toBe(pythonInfo().executable);
    expect(await readlink(join(checkRoot, "app/.venv/bin/python3"))).toBe("python");
    // The copy's script and .pth name the copy; the workspace's are untouched.
    expect((await readFile(join(checkRoot, "app/.venv/bin/show"), "utf8")).split("\n")[0]).toBe(`#!${join(checkRoot, "app/.venv/bin/python")}`);
    expect((await readFile(join(w.root, "app/.venv/bin/show"), "utf8")).split("\n")[0]).toBe(`#!${join(w.root, "app/.venv/bin/python")}`);
    const site = `.venv/lib/python${pythonInfo().version}/site-packages`;
    expect(await readFile(join(checkRoot, "app", site, "_libpkg.pth"), "utf8")).toBe(`${join(checkRoot, "lib/src")}\n`);
    expect(await readFile(join(w.root, "app", site, "_libpkg.pth"), "utf8")).toBe(`${join(w.root, "lib/src")}\n`);
  });

  it.each([
    ["an interpreter link into the workspace", async (w: { root: string }) => { await put(w.root, "tools/python", "#!/bin/sh\n", 0o755); await rm(join(w.root, "app/.venv/bin/python")); await symlink(join(w.root, "tools/python"), join(w.root, "app/.venv/bin/python")); }],
    ["a non-interpreter link out of the workspace in bin", async (w: { root: string }) => symlink(pythonInfo().executable, join(w.root, "app/.venv/bin/tool"))],
    ["an interpreter-named link outside bin", async (w: { root: string }) => symlink(pythonInfo().executable, join(w.root, `app/.venv/lib/python${pythonInfo().version}/python`))],
    ["an interpreter link to a directory", async (w: { root: string }) => { await rm(join(w.root, "app/.venv/bin/python")); await symlink(dirname(pythonInfo().executable), join(w.root, "app/.venv/bin/python")); }],
  ])("refuses %s", async (_label, plant) => {
    const w = await pythonWorkspace();
    await plant(w);
    const { checkRoot, mirror } = await fresh(w);
    await expect(mirrorDependencyFolders(mirror, join(w.root, "app"), join(checkRoot, "app"), [{ kind: "python", path: ".venv" }]).then(() => verifyMirroredLinks(mirror))).rejects.toThrow(DEPENDENCY_REFUSAL.link);
  });

  it("finds node_modules beside every tracked package.json (workspaces), venvs beside Python manifests, never a folder the tree tracks content in", () => {
    expect(dependencyFolders(["package.json", "packages/a/package.json", "packages/a/node_modules/x/index.js", "py/pyproject.toml", "node_modules/y/package.json", "vendor/.venv"])).toEqual({
      folders: [{ kind: "python", path: ".venv" }, { kind: "python", path: "py/.venv" }, { kind: "python", path: "py/venv" }, { kind: "python", path: "venv" }],
      pnp: [".pnp.cjs", ".pnp.js", "packages/a/.pnp.cjs", "packages/a/.pnp.js"],
    });
  });
});

describe("MR1-LIVE: every refusal falls back to today's path with its reason recorded", () => {
  const evidenceOf = async (supplier: ReturnType<typeof createRepositoryCheckSupplier>) => supplier.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 0 });
  async function fallsBack(w: { root: string; repositories: Repositories }, reason: string, plan: CheckPlan = nodePlan, base?: CheckRunners) {
    const { today, result, live } = await bothPaths(w, plan, base);
    expect(comparable(result)).toEqual(comparable(today));
    expect(today.entries.every((entry) => entry.after === "passed")).toBe(true);
    const evidence = await evidenceOf(live);
    expect(evidence?.notes).toEqual([reason]);
    expect(evidence?.edges.length).toBeGreaterThan(0);
    expect(live.notes()).toEqual([reason]);
    // The note is one the strict evidence schema accepts.
    expect(EvidenceRawSchema.shape.repositoryEdges.parse(evidence)).toEqual(evidence);
    expect(await checkRoots(w.root)).toEqual([]);
    return live;
  }

  it("a submodule", async () => {
    const w = await nodeWorkspace();
    const lib = join(w.root, "lib");
    await mkdir(join(lib, "sub"));
    git(lib, "update-index", "--add", "--cacheinfo", `160000,${w.repositories[1]!.baseCommit},sub`);
    git(lib, "commit", "-qm", "submodule");
    w.repositories[1]!.baseCommit = git(lib, "rev-parse", "HEAD");
    await fallsBack(w, SUBMODULE);
  });

  it("the candidate tree's copy limits (50,000 files / 512 MiB)", async () => {
    const w = await nodeWorkspace();
    const isolated = isolatedCopies.withIsolatedGit;
    vi.spyOn(isolatedCopies, "withIsolatedGit").mockImplementation((directory, mode, work) => isolated(directory, mode, (handle) => work({ ...handle, text: (args, more) => args[0] === "ls-tree" && args.includes("-r") && args.includes("-l") ? Promise.resolve(`100644 blob ${"a".repeat(40)} ${512 * 1024 * 1024 + 1}\tpackage.json\0`) : handle.text(args, more) })));
    await fallsBack(w, LIMITS);
  });

  it("the installed dependencies' own copy limits", async () => {
    const w = await nodeWorkspace();
    const limits = DEPENDENCY_MIRROR_LIMITS as { entries: number };
    const saved = limits.entries;
    limits.entries = 3;
    try { await fallsBack(w, DEPENDENCY_LIMITS); } finally { limits.entries = saved; }
  });

  it("a dependency link out of the check copy", async () => {
    const w = await nodeWorkspace();
    await symlink(await temporary("mr1-outside-"), join(w.root, "app/node_modules/evil"));
    await fallsBack(w, LINK);
  });

  it.each([
    ["node_modules is itself a link", async (w: { root: string }) => { await cp(join(w.root, "app/node_modules"), join(w.root, "elsewhere"), { recursive: true }); await rm(join(w.root, "app/node_modules"), { recursive: true }); await symlink("../elsewhere", join(w.root, "app/node_modules")); }],
    ["a FIFO in node_modules", async (w: { root: string }) => { execFileSync("mkfifo", [join(w.root, "app/node_modules/pipe")]); }],
    ["Yarn Plug'n'Play state outside node_modules", async (w: { root: string }) => put(w.root, "app/.pnp.cjs", "module.exports = {};\n")],
  ])("an unsupported layout: %s", async (_label, plant) => {
    // Ignored as installers' own .gitignore lines do (no trailing slash, so a linked node_modules is ignored too).
    const w = await nodeWorkspace("node_modules\n.pnp.cjs\n");
    await plant(w);
    await fallsBack(w, LAYOUT);
  });

  it("a repository whose new commit has its base's files (an IMPLEMENT revert)", async () => {
    const w = await nodeWorkspace();
    git(join(w.root, "lib"), "commit", "--allow-empty", "-qm", "revert to base");
    await fallsBack(w, COMMIT);
  });

  it("a dependency wiring setup that fails (Python without setuptools)", async () => {
    const w = await pythonWorkspace();
    await fallsBack(w, WIRING, pythonPlan, withPip(w.root, createCheckRunners({ rootPath: w.root, local: true }), "fail"));
  });

  it("anything else: fixed words, never the cause", async () => {
    const w = await nodeWorkspace();
    vi.spyOn(partCopies, "createPartWorkingCopy").mockRejectedValue(new Error(`private ${w.root} cause`));
    const live = await fallsBack(w, COPY);
    expect(JSON.stringify(await evidenceOf(live))).not.toContain("private");
  });
});

describe("MR1-LIVE: fallback rules", () => {
  it("is sticky for the invocation and applies the original code in the workspace in every phase", async () => {
    const w = await nodeWorkspace();
    await put(w.root, "lib/index.js", "module.exports = require('pad-lib')('candidate');\n");
    const base = createCheckRunners({ rootPath: w.root, local: true });
    const plan: CheckPlan = { source: "project", readiness: [nodePlan.readiness![0]!] };
    const original = w.repositories.map((repo) => ({ directory: join(w.root, repo.path), commit: repo.baseCommit }));
    const output = (round: CheckRound) => round.entries.map((entry) => `${entry.after}:${entry.output}`);
    const copies = vi.spyOn(partCopies, "createPartWorkingCopy");

    // 1. MR1 runs the candidate round; 2. its copy then fails inside an original-code phase MR1 was applying: the workspace shows the original code itself.
    const live = createRepositoryCheckSupplier({ live: true, rootPath: w.root, repositories: w.repositories });
    const runners = live.scope(base);
    expect(output(await runChecks(plan, runners, options()))).toEqual(["passed:fmt:[candidate]\n"]);
    expect(live.notes()).toEqual([]);
    copies.mockRejectedValueOnce(new Error("copy failed"));
    expect(output(await runners.originalCode!(original).run(() => runChecks(plan, runners, options())))).toEqual(["passed:fmt:[lib]\n"]);
    expect(live.notes()).toEqual([COPY]);
    const calls = copies.mock.calls.length;
    // 3. Sticky: later candidate and original-code rounds take today's path without trying MR1 again.
    expect(output(await runChecks(plan, runners, options()))).toEqual(["passed:fmt:[candidate]\n"]);
    expect(output(await runners.originalCode!(original).run(() => runChecks(plan, runners, options())))).toEqual(["passed:fmt:[lib]\n"]);
    expect(copies.mock.calls.length).toBe(calls);
    expect(await readFile(join(w.root, "lib/index.js"), "utf8")).toContain("candidate");

    // An original-code phase that is the invocation's first round (nothing applied yet) falls back to the original code too.
    const first = createRepositoryCheckSupplier({ live: true, rootPath: w.root, repositories: w.repositories });
    const firstRunners = first.scope(base);
    copies.mockRejectedValueOnce(new Error("copy failed"));
    expect(output(await firstRunners.originalCode!(original).run(() => runChecks(plan, firstRunners, options())))).toEqual(["passed:fmt:[lib]\n"]);
    expect(first.notes()).toEqual([COPY]);
  });

  it("never falls back after a check ran: a check that changes the candidate source still fails the round", async () => {
    const w = await nodeWorkspace();
    const plan: CheckPlan = { source: "project", readiness: [{ executable: process.execPath, args: ["-e", "require('fs').writeFileSync('test.js','changed')"], cwd: "app", timeoutSeconds: 20 }] };
    const live = createRepositoryCheckSupplier({ live: true, rootPath: w.root, repositories: w.repositories });
    await expect(runChecks(plan, live.scope(createCheckRunners({ rootPath: w.root, local: true })), options())).rejects.toThrow("multi-repository check changed candidate source");
    expect(live.notes()).toEqual([]);
  });

  it("never falls back on a stop: a round stopped while copying reports stopped, not today's result", async () => {
    const w = await nodeWorkspace();
    const stop = new AbortController();
    vi.spyOn(partCopies, "createPartWorkingCopy").mockImplementation(async () => { stop.abort(); throw new Error("copy failed"); });
    const live = createRepositoryCheckSupplier({ live: true, rootPath: w.root, repositories: w.repositories });
    const round = await runChecks(nodePlan, live.scope(createCheckRunners({ rootPath: w.root, local: true })), { signal: stop.signal, budgetMs: 60_000 }).catch((error: unknown) => error);
    expect(round instanceof Error ? round.message : (round as CheckRound).stopped).not.toBe(false);
    expect(live.notes()).toEqual([]);
    expect(await live.evidence({ kind: "local", signal: new AbortController().signal, budgetMs: 0 })).toBeUndefined();
  });
});


