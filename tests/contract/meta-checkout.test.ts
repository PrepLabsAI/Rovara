// The worker puts the meta repository in the workspace read-only and sparse, and reports the commit every stage reads (`knowledgeCommit`).
// Real Git repositories in a temporary folder; the clone is injected as the other preparation tests do. Each case fails when the rule it names is removed.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PrepareMetaSchema, StoredProjectDefinitionSchema, type ProjectDefinition } from "../../packages/contracts/src/index.js";
import { META_CHECKOUT_MAX_FILES, listMaterialized, metaPathWanted, parseTreeListing } from "../../packages/worker/src/meta-checkout.js";
import { prepareWorkspace, preparedBaseResult, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { META_PREPARE_FEATURE, knowledgeCommitToStore, metaPrepareFor, metaPrepareProblem } from "../../packages/broker/src/core/meta-repo/prepare-meta.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv })).stdout.trim();

async function repository(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<{ dir: string; head: string }> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", dir], { env: gitEnv });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text, "utf8");
  }
  for (const [path, target] of Object.entries(links)) await symlink(target, join(dir, path));
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "init");
  return { dir, head: await git(dir, "rev-parse", "HEAD") };
}

const META_FILES = {
  "AGENTS.md": "# team rules\n",
  ".kiro/steering/product.md": "---\ninclusion: always\n---\nproduct\n",
  ".kiro/steering/oncall.md": "oncall\n",
  ".agents/skills/build/SKILL.md": "---\nname: build\n---\n",
  "services/search/AGENTS.md": "# search rules\n",
  "services/search/src/big.bin": "x".repeat(10_000),
  "src/app.py": "print('code')\n",
  "docs/unrelated.md": "not knowledge\n",
};

async function fixture(options: { files?: Record<string, string>; links?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "meta-checkout-"));
  const meta = await repository(root, "meta-source", options.files ?? META_FILES, options.links);
  const code = await repository(root, "api-source", { "README.md": "# api\n" });
  const project: ProjectDefinition = {
    name: "payments", revision: 1,
    repositories: [
      { name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", role: "code" },
      { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" },
    ],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
  const cloned: string[] = [];
  const materializer: RepositoryMaterializer = async (repo, target) => {
    cloned.push(repo.name);
    const source = repo.name === "service-meta" ? meta.dir : code.dir;
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv });
  };
  const workspace = () => mkdtemp(join(root, "ws-"));
  const metaRequest = { repository: { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" }, paths: [".kiro/steering", ".agents/skills", "AGENTS.md"], commit: meta.head };
  // What a worker is sent: the project without the pure meta repository.
  const workerProject = StoredProjectDefinitionSchema.parse({ ...project, repositories: [{ name: "api", url: project.repositories[0]!.url, path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }] });
  return { root, meta, code, project, workerProject, cloned, materializer, workspace, metaRequest };
}

describe("the meta repository in the workspace", () => {
  it("materializes only the knowledge paths and the nested rule files, at the default branch's head", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(manifest.complete).toBe(true);
    expect(f.cloned).toEqual(["api", "service-meta"]);
    expect(await listMaterialized(join(rootPath, "repo/service-meta"))).toEqual([
      ".agents/skills/build/SKILL.md", ".kiro/steering/oncall.md", ".kiro/steering/product.md", "AGENTS.md", "services/search/AGENTS.md",
    ]);
    expect(manifest.meta).toMatchObject({ name: "service-meta", path: "repo/service-meta", resolvedCommit: f.meta.head, files: 5, skipped: 0 });
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("reads exactly the commit the broker named, even when the branch has moved on since", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    // The meta repo's branch moves before the worker clones: the broker pinned the earlier commit.
    await writeFile(join(f.meta.dir, "AGENTS.md"), "# changed later\n", "utf8");
    await git(f.meta.dir, "commit", "--quiet", "-am", "later");
    const later = await git(f.meta.dir, "rev-parse", "HEAD");
    expect(later).not.toBe(f.meta.head);
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(manifest.meta?.resolvedCommit).toBe(f.meta.head);
    expect(preparedBaseResult(manifest).knowledgeCommit).toBe(f.meta.head);
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("refuses a commit the clone does not hold, one that is not on the default branch, and one that is not a full hash", async () => {
    const f = await fixture();
    const absent = { ...f.metaRequest, commit: "e".repeat(40) };
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: absent }))
      .rejects.toThrow("does not hold the commit asked for on its default branch");
    // A commit that exists in the repository but only on another branch.
    await git(f.meta.dir, "checkout", "--quiet", "-b", "side");
    await writeFile(join(f.meta.dir, "AGENTS.md"), "# side branch\n", "utf8");
    await git(f.meta.dir, "commit", "--quiet", "-am", "side");
    const side = await git(f.meta.dir, "rev-parse", "HEAD");
    await git(f.meta.dir, "checkout", "--quiet", "main");
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: { ...f.metaRequest, commit: side } }))
      .rejects.toThrow("does not hold the commit asked for on its default branch");
    for (const bad of ["main", "abc123", "A".repeat(40)]) expect(PrepareMetaSchema.safeParse({ ...f.metaRequest, commit: bad }).success).toBe(false);
  });

  it("does not reuse a workspace prepared at another commit, nor take a knowledge commit from a manifest written before", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    await writeFile(join(f.meta.dir, "AGENTS.md"), "# changed later\n", "utf8");
    await git(f.meta.dir, "commit", "--quiet", "-am", "later");
    const later = await git(f.meta.dir, "rev-parse", "HEAD");
    await expect(prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: { ...f.metaRequest, commit: later } }))
      .rejects.toThrow("another commit than the one asked for");
  });

  it("does nothing about a meta repo when none is asked for, and writes no meta entry in the manifest", async () => {
    const f = await fixture();
    const manifest = await prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer });
    expect(manifest.meta).toBeUndefined();
    expect(f.cloned).toEqual(["api"]);
    expect(preparedBaseResult(manifest)).not.toHaveProperty("knowledgeCommit");
  });

  it("refuses a meta repo with more knowledge files than the cap, with a fixed message", async () => {
    const files: Record<string, string> = { "AGENTS.md": "x\n" };
    for (let i = 0; i <= META_CHECKOUT_MAX_FILES; i += 1) files[`.kiro/steering/f${String(i)}.md`] = "x";
    const f = await fixture({ files });
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest }))
      .rejects.toThrow("the meta repo cannot be read: too many files");
  });

  it("refuses a meta repo whose knowledge is larger than the byte cap", async () => {
    const f = await fixture({ files: { "AGENTS.md": "x\n", ".kiro/steering/huge.md": "y".repeat(17 * 1024 * 1024) } });
    await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest }))
      .rejects.toThrow("the meta repo cannot be read: too large");
  });

  it("fails the preparation, and records the failure, when the meta repo cannot be cloned", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    const failing: RepositoryMaterializer = async (repo, target, credential) => {
      if (repo.name === "service-meta") throw new Error("fatal: Authentication failed for 'https://x-access-token:ghs_leaked@github.com/acme/service-meta.git'");
      return f.materializer(repo, target, credential);
    };
    await expect(prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: failing, meta: f.metaRequest })).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(rootPath, ".agentx/preparation-manifest.json"), "utf8")) as { complete: boolean; failure?: string };
    expect(manifest.complete).toBe(false);
    expect(manifest.failure).not.toContain("ghs_leaked");
  });

  it("starts again from a folder an interrupted attempt left, instead of trusting it", async () => {
    const f = await fixture();
    const rootPath = await f.workspace();
    await mkdir(join(rootPath, "repo/service-meta"), { recursive: true });
    await writeFile(join(rootPath, "repo/service-meta/AGENTS.md"), "# tampered\n", "utf8");
    const manifest = await prepareWorkspace({ rootPath, project: f.workerProject, readOnly: true, materializer: f.materializer, meta: f.metaRequest });
    expect(manifest.meta?.resolvedCommit).toBe(f.meta.head);
    expect(await readFile(join(rootPath, "repo/service-meta/AGENTS.md"), "utf8")).toBe("# team rules\n");
  });

  it("refuses a meta repository that shares a name or folder with one of the project's repositories", async () => {
    const f = await fixture();
    for (const repositoryOverride of [{ path: "repo/api/meta" }, { path: "repo/api" }, { name: "api" }, { path: "repo" }]) {
      const clash = { ...f.metaRequest, repository: { ...f.metaRequest.repository, ...repositoryOverride } };
      await expect(prepareWorkspace({ rootPath: await f.workspace(), project: f.workerProject, readOnly: true, materializer: f.materializer, meta: clash }), JSON.stringify(repositoryOverride)).rejects.toThrow("also another repository's");
    }
  });

  it("matches paths by folder and by name, never by prefix of a name", () => {
    const chosen = [".kiro/steering", "AGENTS.md"];
    expect(metaPathWanted(".kiro/steering/a.md", chosen)).toBe(true);
    expect(metaPathWanted(".kiro/steering-old/a.md", chosen)).toBe(false);
    expect(metaPathWanted("AGENTS.md", chosen)).toBe(true);
    expect(metaPathWanted("a/b/CLAUDE.md", chosen)).toBe(true);
    expect(metaPathWanted("a/b/NOTAGENTS.md", chosen)).toBe(false);
    expect(metaPathWanted("src/app.py", chosen)).toBe(false);
  });

  it("reads a tree listing with odd names, and drops a line it cannot read", () => {
    const listing = ["100644 blob aaaa      12\tdocs/a b.md", "100644 blob bbbb       3\tweird\nname.md", "garbage", "120000 blob cccc       4\tlink"].join("\0");
    expect(parseTreeListing(listing).map((entry) => entry.path)).toEqual(["docs/a b.md", "weird\nname.md", "link"]);
  });
});

describe("the contract and the broker's side", () => {
  const COMMIT = "a".repeat(40);

  const separate = StoredProjectDefinitionSchema.parse({
    name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
    repositories: [
      { name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" },
      { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" },
    ],
  });
  const reader = (head: string | Error) => ({ calls: [] as Array<{ repositoryUrl: string; branch: string }>, async getHead(input: { repositoryUrl: string; branch: string }) { this.calls.push(input); if (head instanceof Error) throw head; return head; } });
  const fail = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "ok"; } catch (error) { return `${(error as { code?: string }).code ?? "other"}: ${(error as Error).message}`; } };

  it("reads the meta repo's head itself and sends it, with the repository entry and the knowledge paths", async () => {
    const heads = reader(COMMIT);
    const fields = await metaPrepareFor(separate, heads, undefined);
    expect(heads.calls).toEqual([{ orgId: undefined, repositoryUrl: "https://github.com/acme/service-meta.git", branch: "main" }]);
    expect(fields.knowledgeCommit).toBe(COMMIT);
    expect(fields.meta).toMatchObject({ commit: COMMIT, repository: { name: "service-meta", defaultBranch: "main" } });
    expect(fields.meta?.paths).toEqual(expect.arrayContaining([".kiro/steering", ".agents/skills", ".kiro/specs", "AGENTS.md", ".rovara"]));
    expect(PrepareMetaSchema.safeParse(fields.meta).success).toBe(true);
  });

  it("refuses to prepare when the head cannot be read, or is not a full hash, instead of running without the team's rules", async () => {
    expect(await fail(metaPrepareFor(separate, reader(new Error("503 from github.com/secret-path")), undefined))).toMatch(/RUNTIME_UNAVAILABLE: Rovara can't read the project's meta repo just now/);
    expect(await fail(metaPrepareFor(separate, reader("main"), undefined))).toMatch(/^RUNTIME_UNAVAILABLE/);
    expect(await fail(metaPrepareFor(separate, undefined, undefined))).toMatch(/^RUNTIME_UNAVAILABLE/);
    // The error carries none of the lower layer's words.
    expect(await fail(metaPrepareFor(separate, reader(new Error("503 from github.com/secret-path")), undefined))).not.toContain("secret-path");
  });

  it("asks for nothing, and reads nothing, when the project has no meta repo or the meta repo is its own code", async () => {
    const heads = reader(COMMIT);
    const plain = StoredProjectDefinitionSchema.parse({ ...separate, repositories: [separate.repositories[0]] });
    expect(await metaPrepareFor(plain, heads, undefined)).toEqual({});
    const self = StoredProjectDefinitionSchema.parse({ ...separate, repositories: [{ ...separate.repositories[1], role: "meta", alsoCode: true }] });
    expect(await metaPrepareFor(self, heads, undefined)).toEqual({});
    expect(heads.calls).toEqual([]);
    expect(metaPrepareProblem(plain, [])).toBeUndefined();
    expect(metaPrepareProblem(self, [])).toBeUndefined();
    expect(metaPrepareProblem(separate, [])).toBe("This project's meta repo needs a newer worker. Ask an admin to upgrade Rovara.");
    expect(metaPrepareProblem(separate, [META_PREPARE_FEATURE])).toBeUndefined();
  });

  it("stores the commit the BROKER chose, and only when the worker reported exactly it", () => {
    const other = "b".repeat(40);
    expect(knowledgeCommitToStore(COMMIT, { knowledgeCommit: COMMIT })).toBe(COMMIT);
    // The worker (or a manifest written before the task) names another commit: nothing is stored.
    expect(knowledgeCommitToStore(COMMIT, { knowledgeCommit: other })).toBeUndefined();
    expect(knowledgeCommitToStore(COMMIT, {})).toBeUndefined();
    expect(knowledgeCommitToStore(COMMIT, null)).toBeUndefined();
    // No choice by the broker (a prepare with no meta request): a report alone decides nothing.
    expect(knowledgeCommitToStore(undefined, { knowledgeCommit: other })).toBeUndefined();
    expect(knowledgeCommitToStore("main", { knowledgeCommit: "main" })).toBeUndefined();
  });
});
