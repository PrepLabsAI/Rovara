// SH22/SH23 review B4: what the build writes is what the use reads. The build's repositoryId is the repository NAME and its folder is the repository PATH; the use looks both up exactly so. This test builds an image
// from a project with a nested path, hands the build's own output to the preparation as the pulled image, and checks it is used (and that a build with other names is not).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatCommandLine, parseCommandLine, savedEnvRepositoryName, testEnvDigest, type ProjectDefinition, type TestEnvironmentBody } from "../../packages/contracts/src/index.js";
import { buildEnvironmentDraft } from "../../packages/worker/src/env-detect/propose.js";
import { emptyDetection } from "../../packages/worker/src/env-detect/types.js";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { buildRepositoriesOf, fsckOf, gitStateOf, hashWithAttributesOf, installGitInto, proveAndBuildSavedImage, rebuildIndexOf, snapshotGitOf, stageTree, trackedTreeOf, type BuildSandbox, type SavedEnvBuildPorts } from "../../packages/worker/src/saved-env/build.js";
import { scanTreeForSecrets } from "../../packages/worker/src/saved-env/secret-scan.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "saved-env-roundtrip-")); cleanup.push(dir); return dir; };

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const ORIGIN = "https://github.com/acme/svc.git";
const gitEnv = { PATH: process.env["PATH"] ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnv, HOME: cwd } }).trim();

function environment(): TestEnvironmentBody {
  const detection = emptyDetection();
  detection.setupCommands.push({ value: parseCommandLine("npm ci", "repo/svc", 900), source: { path: "README.md", line: 3 } });
  detection.checks.push({ value: { id: "unit", label: "unit", command: parseCommandLine("npm test", "repo/svc", 1_800), kind: "test", reportPath: "out/junit.xml" }, source: { path: "package.json", line: 5 } });
  const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
  if ("ok" in draft) throw new Error("draft");
  return draft.environment;
}

const PROJECT: ProjectDefinition = {
  name: "demo", revision: 1,
  repositories: [{ name: "svc", url: ORIGIN, path: "repo/svc", defaultBranch: "main", credentialRef: "svc-read" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
};

/** Builds an image of the project with the given build names; returns what the build left (the context of the image) and the broker's manifest. */
async function build(over: { repositoryId?: string; directory?: string } = {}) {
  const root = await scratch();
  const keep = await scratch();
  const tempParent = await scratch();
  const workspace = join(root, "ws");
  const clone = join(workspace, "repo", "svc");
  await mkdir(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  await writeFile(join(clone, "app.js"), "one\n");
  await writeFile(join(clone, "package.json"), "{}\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "one");
  git(clone, "remote", "add", "origin", ORIGIN);
  const commit = git(clone, "rev-parse", "HEAD");
  git(clone, "update-ref", "refs/remotes/origin/main", commit);
  await mkdir(join(clone, "node_modules", "dep"), { recursive: true });
  await writeFile(join(clone, "node_modules", "dep", "index.js"), "dep\n");
  const env = environment();
  let started = false;
  let t = 1_000_000;
  const sandbox: BuildSandbox = {
    id: "fresh-1", rootPath: workspace, hasStarted: () => started, start: async () => { started = true; }, stopProcesses: async () => undefined, dispose: async () => undefined,
    ports: { runCommand: async (command) => { void formatCommandLine(command); t += 1_000; return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }; }, startMock: async () => undefined, probePreprod: async () => true, mockUnmatched: async () => [], buildCoverageMap: async () => undefined, suiteTestCount: async () => 1, now: () => t },
  };
  const docker: DockerCli = {
    async run(args) {
      const list = [...args];
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (list[0] === "buildx" && list[1] === "build") {
        const context = list[list.length - 1]!;
        await cp(join(context, "seed"), join(keep, "seed"), { recursive: true, verbatimSymlinks: true });
        await cp(join(context, "manifest.json"), join(keep, "manifest.json"));
        return ok;
      }
      if (list[0] === "image" && list[1] === "inspect") return { ...ok, stdout: JSON.stringify([`${REGISTRY}/${REPOSITORY}@${IMAGE_DIGEST}`]) };
      return ok;
    },
  };
  const ports: SavedEnvBuildPorts = {
    docker, makeFresh: async () => sandbox, snapshotGit: snapshotGitOf, gitState: gitStateOf, rebuildIndex: rebuildIndexOf, trackedTree: trackedTreeOf, stage: stageTree, fsck: fsckOf, hashWithAttributes: hashWithAttributesOf, installGit: installGitInto,
    scan: (dir, options) => scanTreeForSecrets(dir, { forbiddenValues: options.forbiddenValues, deadlineAtMs: Date.now() + options.budgetMs, links: options.links }),
    pushSession: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: ["login", "-", "p".repeat(30)].join(""), expiresAt: new Date(Date.now() + 1_800_000).toISOString() }),
    temporaryFolder: async () => { const d = await mkdtemp(join(tempParent, "t-")); return { path: d, remove: () => rm(d, { recursive: true, force: true }) }; },
    now: () => Date.now(), random: () => "0123456789abcdef",
  };
  const repositories = buildRepositoriesOf(PROJECT.repositories, new Map([["svc", commit]])).map((repository) => ({ ...repository, ...(over.repositoryId === undefined ? {} : { repositoryId: over.repositoryId }), ...(over.directory === undefined ? {} : { directory: over.directory }) }));
  if (over.directory !== undefined) {
    // the clone sits where the build is told it does
    await mkdir(join(workspace, over.directory, ".."), { recursive: true });
    await cp(clone, join(workspace, over.directory), { recursive: true });
  }
  const result = await proveAndBuildSavedImage({
    repository: REPOSITORY, environment: env, approved: { revision: 4, digest: testEnvDigest(env) }, repositories, detectorGlobs: [], secretNames: [], baseImageDigest: `sha256:${"b".repeat(64)}`,
    notFrom: [], forbiddenValues: [], signal: new AbortController().signal, proveDeadlineMs: 3_600_000,
  }, ports);
  return { result, keep, commit, source: clone };
}

describe("what the build writes is what the use reads (B4)", () => {
  it("buildRepositoriesOf takes the repository NAME as the id and the repository PATH as the folder, and needs a commit for each", () => {
    expect(buildRepositoriesOf(PROJECT.repositories, new Map([["svc", "a".repeat(40)]]))).toEqual([{ repositoryId: "svc", directory: "repo/svc", defaultBranch: "main", commit: "a".repeat(40) }]);
    expect(() => buildRepositoriesOf(PROJECT.repositories, new Map())).toThrow();
  });

  it("an image built from a project with a nested repository path is used by the preparation of that project", async () => {
    const built = await build();
    expect(built.result.ok).toBe(true);
    if (!built.result.ok) return;
    expect(built.result.manifest.commits).toEqual([{ repositoryId: "svc", sha: built.commit }]);
    expect(existsSync(join(built.keep, "seed", "repo", "svc", "node_modules", "dep", "index.js"))).toBe(true);
    const key = built.result.manifest.environmentKey;
    const docker: DockerCli = {
      async run(args) {
        const list = [...args];
        const ok = { exitCode: 0, stdout: "", stderr: "" };
        if (list[0] === "image" && list[1] === "inspect") return { ...ok, stdout: `${JSON.stringify([`${REGISTRY}/${REPOSITORY}@${IMAGE_DIGEST}`])} ${JSON.stringify({ "io.rovara.saved-env.key": key, "io.rovara.saved-env.revision": "4" })}\n` };
        if (list[0] === "cp") {
          if (list[1]!.endsWith("manifest.json")) await cp(join(built.keep, "manifest.json"), list[2]!);
          else await cp(join(built.keep, "seed"), list[2]!, { recursive: true, verbatimSymlinks: true });
        }
        return ok;
      },
    };
    const fallbacks: string[] = [];
    const clones: string[] = [];
    const materializer: RepositoryMaterializer = async () => { clones.push("fresh clone"); throw new Error("a fresh clone: the saved environment was not used"); };
    const rootPath = await scratch();
    const manifest = await prepareWorkspace({
      rootPath, project: PROJECT, readOnly: true, materializer, credentialProvider: async () => ({}),
      savedEnv: {
        ref: { repository: REPOSITORY, digest: IMAGE_DIGEST, testEnvRevision: 4, environmentKey: key, taskTestEnvRevision: 4 }, login: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: ["login", "-", "p".repeat(30)].join(""), expiresAt: new Date(Date.now() + 1_800_000).toISOString() }), docker, onFallback: (step) => fallbacks.push(step),
        fetch: async ({ directory, branch }) => { execFileSync("git", ["fetch", "-q", "--no-tags", pathToFileURL(built.source).href, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: directory, env: { ...gitEnv, HOME: directory } }); },
      },
    });
    expect(fallbacks).toEqual([]);
    expect(clones).toEqual([]);
    expect(manifest.complete).toBe(true);
    expect(manifest.repositories[0]!.path).toBe("repo/svc");
    expect(readFileSync(join(rootPath, "repo", "svc", "node_modules", "dep", "index.js"), "utf8")).toBe("dep\n");
    expect(await readFile(join(rootPath, "repo", "svc", "app.js"), "utf8")).toBe("one\n");
  });

  it("an image built under another repository id or another folder is not found by the use: the manifest or layout step falls back to a fresh clone", async () => {
    for (const [over, step] of [[{ repositoryId: "other-name" }, "manifest"], [{ directory: "elsewhere/svc" }, "layout"]] as const) {
      const built = await build(over);
      expect(built.result.ok, JSON.stringify(over)).toBe(true);
      if (!built.result.ok) return;
      const key = built.result.manifest.environmentKey;
      const docker: DockerCli = {
        async run(args) {
          const list = [...args];
          const ok = { exitCode: 0, stdout: "", stderr: "" };
          if (list[0] === "image" && list[1] === "inspect") return { ...ok, stdout: `${JSON.stringify([`${REGISTRY}/${REPOSITORY}@${IMAGE_DIGEST}`])} ${JSON.stringify({ "io.rovara.saved-env.key": key, "io.rovara.saved-env.revision": "4" })}\n` };
          if (list[0] === "cp") {
            if (list[1]!.endsWith("manifest.json")) await cp(join(built.keep, "manifest.json"), list[2]!);
            else await cp(join(built.keep, "seed"), list[2]!, { recursive: true, verbatimSymlinks: true });
          }
          return ok;
        },
      };
      const fallbacks: string[] = [];
      const materializer: RepositoryMaterializer = async (_repository, target) => { execFileSync("git", ["clone", "-q", "--no-checkout", pathToFileURL(built.source).href, target], { env: gitEnv }); };
      const manifest = await prepareWorkspace({
        rootPath: await scratch(), project: PROJECT, readOnly: true, materializer, credentialProvider: async () => ({}),
        savedEnv: { ref: { repository: REPOSITORY, digest: IMAGE_DIGEST, testEnvRevision: 4, environmentKey: key, taskTestEnvRevision: 4 }, login: async () => ({ registry: REGISTRY, repository: REPOSITORY, username: "AWS", password: ["login", "-", "p".repeat(30)].join(""), expiresAt: new Date(Date.now() + 1_800_000).toISOString() }), docker, onFallback: (s) => fallbacks.push(s) },
      });
      expect(manifest.complete).toBe(true);
      expect(fallbacks).toEqual([step]);
    }
  });
});
