// SH23: a task starts from the saved environment. The image is pulled by DIGEST with a one-repository login, checked against what the broker expects, copied without following links, its git history is
// the generated one with hooks off, and the default branch is fetched and checked out over the seed. ANY failure clones fresh, reports the step, and leaves nothing behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SAVED_ENV_LABEL_KEY, SAVED_ENV_LABEL_REVISION, parseCommandLine, savedEnvRepositoryName, savedEnvStepMarksStale, type ProjectDefinition, type PrepareSavedEnv, type SavedEnvRegistryAuth, type SavedEnvUseStep } from "../../packages/contracts/src/index.js";
import { prepareWorkspace, type PrepareWorkspaceOptions, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { checkSeedTree, replaceFileExclusively, savedEnvMaterializer, seededGitConfig, type SavedEnvUseOptions } from "../../packages/worker/src/saved-env/use.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "saved-env-use-")); cleanup.push(dir); return dir; };

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const DIGEST = `sha256:${"d".repeat(64)}`;
const KEY = "k".repeat(64).replace(/k/gu, "a");
const REF = `${REGISTRY}/${REPOSITORY}@${DIGEST}`;
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const ORIGIN = "https://github.com/acme/svc.git";
const gitEnv = { PATH: process.env["PATH"] ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnv, HOME: cwd } }).trim();

const auth = (over: Partial<SavedEnvRegistryAuth> = {}): SavedEnvRegistryAuth => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: PASSWORD, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ...over });
const refOf = (over: Partial<PrepareSavedEnv> = {}): PrepareSavedEnv => ({ repository: REPOSITORY, digest: DIGEST, testEnvRevision: 4, environmentKey: KEY, taskTestEnvRevision: 4, ...over });
const loginOf = (over: Partial<SavedEnvRegistryAuth> = {}) => async (): Promise<SavedEnvRegistryAuth> => auth(over);

const project = (over: Partial<ProjectDefinition["repositories"][number]> = {}): ProjectDefinition => ({
  name: "demo", revision: 1,
  repositories: [{ name: "svc", url: ORIGIN, path: "svc", defaultBranch: "main", credentialRef: "svc-read", ...over }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
});

interface Fixture { root: string; source: string; image: string; commit1: string; commit2: string }

/** A source repository with two commits, and an "image" folder holding a seed cloned at the first (with untracked dependencies) and a manifest. */
async function fixture(): Promise<Fixture> {
  const root = await scratch();
  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "app.js"), "one\n");
  await writeFile(join(source, "package.json"), "{}\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "one");
  const commit1 = git(source, "rev-parse", "HEAD");
  const image = join(root, "image");
  const seed = join(image, "seed", "svc");
  await mkdir(join(image, "seed"), { recursive: true });
  git(root, "clone", "-q", pathToFileURL(source).href, seed);
  git(seed, "remote", "set-url", "origin", ORIGIN);
  await mkdir(join(seed, "node_modules", "dep"), { recursive: true });
  await writeFile(join(seed, "node_modules", "dep", "index.js"), "dep\n");
  await symlink("dep/index.js", join(seed, "node_modules", "alias"));
  await mkdir(join(seed, ".git", "hooks"), { recursive: true });
  await writeFile(join(seed, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho pwned > /tmp/pwned-by-hook\n");
  await writeFile(join(image, "manifest.json"), JSON.stringify(manifest(commit1)));
  await writeFile(join(source, "app.js"), "two\n");
  git(source, "commit", "-q", "-a", "-m", "two");
  return { root, source, image, commit1, commit2: git(source, "rev-parse", "HEAD") };
}

function manifest(commit: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, environmentKey: KEY, testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: commit }], proveReportDigest: "b".repeat(64), builtAt: "2026-11-02T12:00:00.000Z", ...over };
}

interface Docker { cli: DockerCli; calls: string[][]; configAtPull: string | undefined; configDirs: string[]; loginAfterPull: boolean[] }
function fakeDocker(f: Fixture, over: { pull?: number; inspect?: (ref: string) => string; create?: number; cp?: number; labels?: Record<string, string>; digests?: string[] } = {}): Docker {
  const state: Docker = { calls: [], configAtPull: undefined, configDirs: [], loginAfterPull: [], cli: undefined as never };
  state.cli = {
    async run(args) {
      const list = [...args];
      state.calls.push(list);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (list[2] === "pull") {
        const dir = list[list.indexOf("--config") + 1]!;
        state.configDirs.push(dir);
        state.configAtPull = await readFile(join(dir, "config.json"), "utf8").catch(() => undefined);
        return { ...ok, exitCode: over.pull ?? 0 };
      }
      if (list[0] === "image" && list[1] === "inspect") {
        state.loginAfterPull.push(...state.configDirs.map((dir) => existsSync(dir)));
        const labels = over.labels ?? { [SAVED_ENV_LABEL_KEY]: KEY, [SAVED_ENV_LABEL_REVISION]: "4" };
        return { ...ok, stdout: over.inspect !== undefined ? over.inspect(list[list.length - 1]!) : `${JSON.stringify(over.digests ?? [REF])} ${JSON.stringify(labels)}\n` };
      }
      if (list[0] === "create") return { ...ok, exitCode: over.create ?? 0 };
      if (list[0] === "cp") {
        if ((over.cp ?? 0) !== 0) return { ...ok, exitCode: over.cp! };
        const from = list[1]!.slice(list[1]!.indexOf(":") + 1);
        if (from.endsWith("manifest.json")) await cp(join(f.image, "manifest.json"), list[2]!);
        else await cp(join(f.image, "seed"), list[2]!, { recursive: true, verbatimSymlinks: true, dereference: false });
        return ok;
      }
      return ok;
    },
  };
  return state;
}

/** The ordinary fresh clone (what the preparation does without a saved environment). */
function freshClone(f: Fixture, log: string[] = []): RepositoryMaterializer {
  return async (_repository, target) => { log.push("fresh clone"); execFileSync("git", ["clone", "-q", "--no-checkout", pathToFileURL(f.source).href, target], { env: gitEnv }); };
}

async function run(f: Fixture, docker: Docker, over: Partial<SavedEnvUseOptions> & { project?: ProjectDefinition; fail?: Error; prepare?: Partial<PrepareWorkspaceOptions> } = {}) {
  const fallbacks: SavedEnvUseStep[] = [];
  const diagnostics: string[] = [];
  const log: string[] = [];
  const rootPath = await scratch();
  const fetched: string[] = [];
  const manifestOut = await prepareWorkspace({
    rootPath, project: over.project ?? project(), readOnly: over.prepare?.readOnly ?? true, ...(over.links === undefined ? {} : { venvLinkPolicy: over.links }), ...over.prepare,
    credentialProvider: async () => ({ username: "x-access-token", password: "clone-credential-value" }),
    materializer: freshClone(f, log),
    savedEnv: {
      ref: refOf(), login: loginOf(), docker: docker.cli, onFallback: (step) => fallbacks.push(step), onDiagnostic: (message) => diagnostics.push(message),
      fetch: async ({ directory, branch }) => { fetched.push(directory); if (over.fail !== undefined) throw over.fail; execFileSync("git", ["fetch", "-q", "--no-tags", pathToFileURL(f.source).href, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: directory, env: { ...gitEnv, HOME: directory } }); },
      random: () => "0123456789abcdef",
      ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== "prepare" && key !== "project" && key !== "fail")),
    },
  });
  return { rootPath, manifest: manifestOut, fallbacks, diagnostics, log, fetched };
}

describe("a task starts from the saved environment", () => {
  it("pulls by digest with a one-repository login that exists only for the pull, never runs the image, copies the seed with links as links, regenerates git's config with hooks off, fetches and checks out the branch head over the seed", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const r = await run(f, docker);
    expect(r.manifest.complete).toBe(true);
    expect(r.fallbacks).toEqual([]);
    expect(r.log).toEqual([]);
    // by digest, never a tag
    const pull = docker.calls.find((call) => call[2] === "pull")!;
    expect(pull[pull.length - 1]).toBe(REF);
    expect(pull[pull.length - 1]).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(docker.calls)).not.toContain(PASSWORD);
    expect(Buffer.from((JSON.parse(docker.configAtPull!) as { auths: Record<string, { auth: string }> }).auths[REGISTRY]!.auth, "base64").toString()).toBe(`AWS:${PASSWORD}`);
    expect(docker.configDirs.every((dir) => !existsSync(dir))).toBe(true);
    // the login is gone as soon as the pull returns, before anything is inspected or extracted
    expect(docker.loginAfterPull).toEqual([false]);
    // created, never run
    expect(docker.calls.some((call) => call[0] === "run" || call[0] === "start" || call[0] === "exec")).toBe(false);
    expect(docker.calls.find((call) => call[0] === "create")).toEqual(["create", "--name", expect.stringMatching(/^rovara-saved-env-/u), REF, "/rovara/never-run"]);
    // the seed: dependencies kept, links kept as links
    const svc = join(r.rootPath, "svc");
    expect(readFileSync(join(svc, "node_modules", "dep", "index.js"), "utf8")).toBe("dep\n");
    expect((await lstat(join(svc, "node_modules", "alias"))).isSymbolicLink()).toBe(true);
    // the branch head is checked out over the seed
    expect(readFileSync(join(svc, "app.js"), "utf8")).toBe("two\n");
    expect(r.manifest.repositories[0]!.resolvedCommit).toBe(f.commit2);
    expect(git(svc, "rev-parse", "HEAD")).toBe(f.commit2);
    // hooks are off: none in the repository, and the config says so, with only the project's origin URL
    expect(existsSync(join(svc, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync("/tmp/pwned-by-hook")).toBe(false);
    const config = readFileSync(join(svc, ".git", "config"), "utf8");
    expect(config).toContain("hooksPath = /dev/null");
    expect(config).toContain(`url = ${ORIGIN}`);
    expect(config).not.toContain("file://");
    // nothing left on the machine
    expect(docker.calls.some((call) => call[0] === "rm" && call.includes("--force"))).toBe(true);
    expect(docker.calls.some((call) => call[0] === "rmi" && call.includes(REF))).toBe(true);
  });

  it("the default branch is fetched with the preparation's own clone credential", async () => {
    const f = await fixture();
    const seen: unknown[] = [];
    const r = await run(f, fakeDocker(f), { fetch: async ({ directory, branch, credential }) => { seen.push(credential); execFileSync("git", ["fetch", "-q", "--no-tags", pathToFileURL(f.source).href, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: directory, env: { ...gitEnv, HOME: directory } }); } });
    expect(r.manifest.complete).toBe(true);
    expect(seen).toEqual([{ username: "x-access-token", password: "clone-credential-value" }]);
  });
});

describe("any failure clones fresh, reports the step once, and leaves nothing behind", () => {
  const cases: Array<[string, SavedEnvUseStep, (f: Fixture) => Parameters<typeof fakeDocker>[1] | Promise<Parameters<typeof fakeDocker>[1]>, Partial<SavedEnvUseOptions>?]> = [
    ["the pull fails", "pull", () => ({ pull: 1 })],
    ["the image's digests do not name the pinned reference", "inspect", () => ({ digests: [`${REGISTRY}/${REPOSITORY}@sha256:${"9".repeat(64)}`] })],
    ["the image's key label is another key", "inspect", () => ({ labels: { [SAVED_ENV_LABEL_KEY]: "b".repeat(64), [SAVED_ENV_LABEL_REVISION]: "4" } })],
    ["the image's revision label is another revision", "inspect", () => ({ labels: { [SAVED_ENV_LABEL_KEY]: KEY, [SAVED_ENV_LABEL_REVISION]: "3" } })],
    ["the image has no labels", "inspect", () => ({ inspect: () => "[] null\n" })],
    ["the container cannot be created", "extract", () => ({ create: 1 })],
    ["the copy fails", "extract", () => ({ cp: 1 })],
  ];
  it.each(cases)("%s", async (_name, step, make) => {
    const f = await fixture();
    const docker = fakeDocker(f, await make(f));
    const r = await run(f, docker);
    expect(r.manifest.complete).toBe(true);
    expect(r.fallbacks).toEqual([step]);
    expect(r.diagnostics).toEqual([`fresh setup (saved environment failed at ${step})`]);
    expect(r.log).toEqual(["fresh clone"]);
    // a fresh clone, not the seed
    expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
    expect(readFileSync(join(r.rootPath, "svc", "app.js"), "utf8")).toBe("two\n");
    expect(docker.configDirs.every((dir) => !existsSync(dir))).toBe(true);
    expect(docker.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("the image's manifest says another key, another revision, or has no commit for the repository", async () => {
    for (const change of [{ environmentKey: "c".repeat(64) }, { testEnvRevision: 5 }, { commits: [{ repositoryId: "other", sha: "a".repeat(40) }] }]) {
      const f = await fixture();
      await writeFile(join(f.image, "manifest.json"), JSON.stringify(manifest(f.commit1, change)));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks, JSON.stringify(change)).toEqual(["manifest"]);
      expect(r.log).toEqual(["fresh clone"]);
    }
    const f = await fixture();
    await writeFile(join(f.image, "manifest.json"), "not json");
    expect((await run(f, fakeDocker(f))).fallbacks).toEqual(["manifest"]);
  });

  it("the seed lacks the repository's folder", async () => {
    const f = await fixture();
    await rm(join(f.image, "seed", "svc"), { recursive: true });
    await mkdir(join(f.image, "seed", "elsewhere"));
    const r = await run(f, fakeDocker(f));
    expect(r.fallbacks).toEqual(["layout"]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a link in the seed that is absolute or leaves the seed, even one the task would never open", async () => {
    for (const [name, target] of [["python", "/usr/bin/python3"], ["up", "../../../etc"]] as const) {
      const f = await fixture();
      await symlink(target, join(f.image, "seed", "svc", "node_modules", name));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks, name).toEqual(["links"]);
      expect(r.log).toEqual(["fresh clone"]);
      expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
    }
  });

  it("git history that is redirected (alternates, grafts, replace refs, modules, worktrees) in the image", async () => {
    const plants: Array<(git: string) => Promise<void>> = [
      async (g) => { await mkdir(join(g, "objects", "info"), { recursive: true }); await writeFile(join(g, "objects", "info", "alternates"), "/x\n"); },
      async (g) => { await mkdir(join(g, "info"), { recursive: true }); await writeFile(join(g, "info", "grafts"), "x\n"); },
      async (g) => { await mkdir(join(g, "refs", "replace"), { recursive: true }); },
      async (g) => { await mkdir(join(g, "modules"), { recursive: true }); },
      async (g) => { await mkdir(join(g, "worktrees"), { recursive: true }); },
    ];
    for (const plant of plants) {
      const f = await fixture();
      await plant(join(f.image, "seed", "svc", ".git"));
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks).toEqual(["git"]);
      expect(r.log).toEqual(["fresh clone"]);
    }
  });

  it("a project URL with a credential never reaches the config: the repository is cloned fresh", async () => {
    const f = await fixture();
    const r = await run(f, fakeDocker(f), { project: project({ url: "https://user:pw@github.com/acme/svc.git" }) }).catch((error: unknown) => error);
    // the ordinary clone path refuses a credentialed remote as well; the point is that the seed was not used with it
    expect(r instanceof Error || (r as { fallbacks: string[] }).fallbacks[0] === "git").toBe(true);
  });

  it("the fetch fails: the seed is removed and the repository is cloned fresh", async () => {
    const f = await fixture();
    const r = await run(f, fakeDocker(f), { fail: new Error("network down") });
    expect(r.fallbacks).toEqual(["fetch"]);
    expect(r.log).toEqual(["fresh clone"]);
    expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
  });
});

describe("the revision the image was built at must be the revision the task is pinned to", () => {
  it("a task pinned to another revision never pulls the image", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const r = await run(f, docker, { ref: refOf({ taskTestEnvRevision: 5 }) });
    expect(r.fallbacks).toEqual(["revision"]);
    expect(docker.calls).toEqual([]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a reference with a tag instead of a digest, or for a repository that is not a saved environment, is refused before a login is asked for or anything is pulled", async () => {
    const f = await fixture();
    for (const ref of [{ ...refOf(), digest: "latest" }, { ...refOf(), repository: "evil/repo" }] as unknown as PrepareSavedEnv[]) {
      const docker = fakeDocker(f);
      let asked = 0;
      const r = await run(f, docker, { ref, login: async () => { asked += 1; return auth(); } });
      expect(r.fallbacks).toEqual(["input"]);
      expect(docker.calls).toEqual([]);
      expect(asked).toBe(0);
    }
  });

  it("a login for another repository, or for a registry that is not ECR, is refused before anything is pulled, and does not mark the image stale", async () => {
    const other = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-2" });
    const f = await fixture();
    for (const over of [{ repository: other }, { registry: "evil.example.com" }]) {
      const docker = fakeDocker(f);
      const r = await run(f, docker, { login: loginOf(over) });
      expect(r.fallbacks).toEqual(["login"]);
      expect(savedEnvStepMarksStale("login")).toBe(false);
      expect(docker.calls).toEqual([]);
    }
  });

  it("a login that fails, or is out of date or nearly so, falls back to a fresh setup without pulling, and does not mark the image stale", async () => {
    const f = await fixture();
    const failing = fakeDocker(f);
    const r1 = await run(f, failing, { login: async () => { throw new Error("broker down"); } });
    expect(r1.fallbacks).toEqual(["login"]);
    expect(failing.calls).toEqual([]);
    for (const left of [-5_000, 30_000]) {
      const docker = fakeDocker(f);
      const r = await run(f, docker, { login: loginOf({ expiresAt: new Date(Date.now() + left).toISOString() }) });
      expect(r.fallbacks).toEqual(["expired"]);
      expect(docker.calls).toEqual([]);
      expect(r.log).toEqual(["fresh clone"]);
    }
    expect(savedEnvStepMarksStale("expired")).toBe(false);
    expect(savedEnvStepMarksStale("pull")).toBe(true);
  });

  it("the login is asked for once per preparation, however many repositories it has", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    let asked = 0;
    await run(f, docker, { login: async () => { asked += 1; return auth(); } });
    expect(asked).toBe(1);
  });
});

describe("pieces", () => {
  it("the meta repository, which is not in the image, clones as before and says nothing", async () => {
    const f = await fixture();
    const docker = fakeDocker(f);
    const log: string[] = [];
    const fallbacks: string[] = [];
    const materialize = savedEnvMaterializer({ ref: refOf(), login: loginOf(), docker: docker.cli, onFallback: (s) => fallbacks.push(s) }, project().repositories, freshClone(f, log));
    await materialize({ name: "meta", url: ORIGIN, path: "meta", defaultBranch: "main", credentialRef: "x" }, join(await scratch(), "meta"), {});
    expect(log).toEqual(["fresh clone"]);
    expect(fallbacks).toEqual([]);
    expect(docker.calls).toEqual([]);
  });

  it("the generated config has the origin URL, hooks off, and refuses an unsafe URL", () => {
    const config = seededGitConfig(ORIGIN);
    expect(config).toContain("hooksPath = /dev/null");
    expect(config.match(/\[core\]/gu)).toHaveLength(1);
    expect(() => seededGitConfig("https://u:p@h/a")).toThrow();
  });

  it("the seed check accepts links that stay inside and refuses a device-like file via the special-file path", async () => {
    const root = await scratch();
    await mkdir(join(root, "svc", "a"), { recursive: true });
    await writeFile(join(root, "svc", "a", "f"), "x");
    await symlink("f", join(root, "svc", "a", "ok"));
    expect(await checkSeedTree(root)).toBe("ok");
    await symlink("/etc/passwd", join(root, "svc", "bad"));
    expect(await checkSeedTree(root)).toBe("unsafe_link");
    expect((await readdir(root)).length).toBe(1);
  });
});

describe("links in the seed are checked on the real tree (review A1, A3)", () => {
  it("a -> . with x -> a/a/a/a/../../../../.. is refused", async () => {
    const f = await fixture();
    const nm = join(f.image, "seed", "svc", "node_modules");
    await symlink(".", join(nm, "a"));
    await symlink("a/a/a/a/../../../../..", join(nm, "x"));
    const r = await run(f, fakeDocker(f));
    expect(r.fallbacks).toEqual(["links"]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a virtual environment's interpreter links into the base image's interpreter folder are kept; an absolute link anywhere else is not", async () => {
    const f = await fixture();
    const bin = join(f.image, "seed", "svc", ".venv", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "..", "pyvenv.cfg"), "home = /usr/bin\n");
    await symlink("/usr/bin/python3.12", join(bin, "python"));
    await symlink("python", join(bin, "python3"));
    const r = await run(f, fakeDocker(f));
    expect(r.fallbacks).toEqual([]);
    expect(await readlink(join(r.rootPath, "svc", ".venv", "bin", "python"))).toBe("/usr/bin/python3.12");
    const g = await fixture();
    await mkdir(join(g.image, "seed", "svc", ".venv", "bin"), { recursive: true });
    await writeFile(join(g.image, "seed", "svc", ".venv", "pyvenv.cfg"), "home = /opt/py\n");
    await symlink("/opt/py/bin/python3.12", join(g.image, "seed", "svc", ".venv", "bin", "python"));
    expect((await run(g, fakeDocker(g))).fallbacks).toEqual(["links"]);
    expect((await run(g, fakeDocker(g), { links: { interpreterDirectories: ["/opt/py/bin"], managedPythonRoots: [] } })).fallbacks).toEqual([]);
  });

  it("a real `python -m venv` tree is used when its interpreter folder is allowed", async () => {
    const f = await fixture();
    execFileSync("python3", ["-m", "venv", "--without-pip", join(f.image, "seed", "svc", ".venv")]);
    const bin = join(f.image, "seed", "svc", ".venv", "bin");
    let target = "";
    for (const name of await readdir(bin)) { const link = await readlink(join(bin, name)).catch(() => ""); if (link.startsWith("/")) target = link; }
    expect(target.startsWith("/")).toBe(true);
    const folder = target.slice(0, target.lastIndexOf("/"));
    const refused = folder === "/usr/bin" || folder === "/usr/local/bin" ? [] : ["links"];
    expect((await run(f, fakeDocker(f))).fallbacks).toEqual(refused);
    const g = await fixture();
    execFileSync("python3", ["-m", "venv", "--without-pip", join(g.image, "seed", "svc", ".venv")]);
    const r = await run(g, fakeDocker(g), { links: { interpreterDirectories: [folder], managedPythonRoots: [] } });
    expect(r.fallbacks).toEqual([]);
    expect(existsSync(join(r.rootPath, "svc", ".venv", "pyvenv.cfg"))).toBe(true);
  });

  it("a seed built at another workspace path is used and the difference is reported", async () => {
    const f = await fixture();
    await writeFile(join(f.image, "manifest.json"), JSON.stringify(manifest(f.commit1, { workspaceRoot: "/mnt/other-workspace" })));
    const r = await run(f, fakeDocker(f));
    expect(r.fallbacks).toEqual([]);
    expect(r.diagnostics.join(" ")).toContain("another workspace path");
  });
});

describe("the git folder in the seed (review B2) and special modes (B3)", () => {
  it("a .git that is a link, a link anywhere under .git, or a config that is a link is refused", async () => {
    const asLink = await fixture();
    await rm(join(asLink.image, "seed", "svc", ".git"), { recursive: true });
    await symlink("/tmp", join(asLink.image, "seed", "svc", ".git"));
    expect((await run(asLink, fakeDocker(asLink))).fallbacks).toHaveLength(1);
    const inside = await fixture();
    await symlink("../HEAD", join(inside.image, "seed", "svc", ".git", "refs", "heads-link"));
    expect((await run(inside, fakeDocker(inside))).fallbacks).toEqual(["links"]);
    const config = await fixture();
    await rm(join(config.image, "seed", "svc", ".git", "config"));
    await symlink("/tmp/evil-config", join(config.image, "seed", "svc", ".git", "config"));
    const r = await run(config, fakeDocker(config));
    expect(r.fallbacks).toEqual(["links"]);
    expect(existsSync("/tmp/evil-config")).toBe(false);
  });

  it("an index flag that hides a change (assume-unchanged, skip-worktree) in the seed is refused", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const f = await fixture();
      git(join(f.image, "seed", "svc"), "update-index", flag, "app.js");
      const r = await run(f, fakeDocker(f));
      expect(r.fallbacks, flag).toEqual(["git"]);
      expect(r.log).toEqual(["fresh clone"]);
    }
  });

  it("a set-user-id or set-group-id file in the seed is refused", async () => {
    const f = await fixture();
    for (const mode of [0o4755, 0o2755]) {
      const file = join(f.image, "seed", "svc", "node_modules", "dep", `tool${mode.toString(8)}`);
      await writeFile(file, "x");
      await chmod(file, mode);
      expect(await checkSeedTree(join(f.image, "seed")), mode.toString(8)).toBe("unsafe_mode");
      await rm(file);
    }
    const g = await fixture();
    const file = join(g.image, "seed", "svc", "node_modules", "dep", "tool");
    await writeFile(file, "x");
    await chmod(file, 0o4755);
    expect((await run(g, fakeDocker(g))).fallbacks).toEqual(["links"]);
  });
});

describe("the config is replaced, never written through (review B2)", () => {
  it("a file, or a link in its place, is replaced by a new file; the link's target is untouched; an existing file is never appended to", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "target"), "original");
    await symlink(join(dir, "target"), join(dir, "config"));
    await replaceFileExclusively(join(dir, "config"), "generated");
    expect(readFileSync(join(dir, "target"), "utf8")).toBe("original");
    expect((await lstat(join(dir, "config"))).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "config"), "utf8")).toBe("generated");
    await replaceFileExclusively(join(dir, "config"), "again");
    expect(readFileSync(join(dir, "config"), "utf8")).toBe("again");
  });
});

describe("a failure after the seed was used starts over without it (review B1)", () => {
  const withSetup = (): ProjectDefinition => ({ ...project(), setup: [parseCommandLine("npm ci", "svc", 900)] });
  /** Setup that fails only on the seed: it finds the seed's dependency folder and refuses it. */
  const runner = (calls: string[]) => async (_command: unknown, _index: number, rootPath: string) => {
    const seeded = existsSync(join(rootPath, "svc", "node_modules"));
    calls.push(seeded ? "setup on seed" : "setup fresh");
    return { exitCode: seeded ? 1 : 0, stdout: "", stderr: seeded ? "dependency tree is stale" : "" };
  };

  it("setup fails only on the seed: the workspace is wiped, the step is reported, and the preparation runs again fresh and succeeds", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const docker = fakeDocker(f);
    const r = await run(f, docker, { project: withSetup(), prepare: { readOnly: false, commandRunner: runner(calls) } });
    expect(r.manifest.complete).toBe(true);
    expect(calls).toEqual(["setup on seed", "setup fresh"]);
    expect(r.fallbacks).toEqual(["setup"]);
    expect(r.diagnostics).toContain("fresh setup (saved environment failed at setup)");
    expect(r.log).toEqual(["fresh clone"]);
    expect(existsSync(join(r.rootPath, "svc", "node_modules"))).toBe(false);
    expect(docker.calls.filter((call) => call[0] === "rmi")).toHaveLength(1);
  });

  it("the checkout fails after the seed was placed: reported as checkout, then fresh", async () => {
    const f = await fixture();
    const r = await run(f, fakeDocker(f), {
      fetch: async ({ directory }) => { execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: directory, env: { ...gitEnv, HOME: directory } }); },
    });
    expect(r.manifest.complete).toBe(true);
    expect(r.fallbacks).toEqual(["checkout"]);
    expect(r.log).toEqual(["fresh clone"]);
  });

  it("a failure that is also the fresh run's own failure is thrown, and NOTHING is reported: the image is not marked stale (no rebuild storm)", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const fallbacks: SavedEnvUseStep[] = [];
    const diagnostics: string[] = [];
    await expect(run(f, fakeDocker(f), { project: withSetup(), onFallback: (step) => fallbacks.push(step), onDiagnostic: (message) => diagnostics.push(message), prepare: { readOnly: false, commandRunner: async () => { calls.push("run"); return { exitCode: 1, stdout: "", stderr: "broken" }; } } })).rejects.toThrow();
    expect(calls).toEqual(["run", "run"]);
    expect(fallbacks).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("a failure when the seed was NOT used (it fell back) is not retried a second time", async () => {
    const f = await fixture();
    const calls: string[] = [];
    await expect(run(f, fakeDocker(f, { pull: 1 }), { project: withSetup(), prepare: { readOnly: false, commandRunner: async () => { calls.push("run"); return { exitCode: 1, stdout: "", stderr: "broken" }; } } })).rejects.toThrow();
    expect(calls).toEqual(["run"]);
  });
});
