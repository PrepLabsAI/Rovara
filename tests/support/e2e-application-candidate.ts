import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { E2EApplicationBuildSourceManifest, E2ESourceSnapshot } from "@agentx/contracts";
import { assessCandidateBuildSource, candidateBuildSourceAdmissionReference } from "../../packages/broker/src/aws/candidate-build-source.js";
import { exportCandidateBuildSource } from "../../packages/worker/src/e2e-build-source-export.js";
import { createProcessCandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import { readCommittedCandidateSourceExport } from "../../packages/worker/src/verification/candidate.js";
import { exportBaselineSource } from "../../packages/worker/src/baseline-source-export.js";
import { assessBaselineSource } from "../../packages/broker/src/aws/baseline-source.js";

const roots: string[] = [];
/** Removes every repository this module made; call it from an afterEach. */
export async function disposeRealCandidates(): Promise<void> { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); }
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/**
 * A real committed candidate, exported the way the worker exports one at the end of an IMPLEMENT run (the same code) and judged the way the broker judges its
 * build source (the same assessment), so tests build their admissions from exactly the records Task 2.4b writes.
 */
export async function createRealCandidate(tree: Record<string, string>, options: { repositoryId?: string; baseCommitSha?: string; baseTree?: Record<string, string> } = {}) {
  const repositoryId = options.repositoryId ?? "demo";
  const root = await temp("application-candidate-");
  git(root, "init", "-q");
  // With a base tree, the repository holds the task's base commit first and the candidate on top of it, and the unchanged code is exported the way the worker does (Task 3.7b).
  let baseline: { baseCommitSha: string; baseTreeSha: string; stored: ReturnType<typeof assessBaselineSource>; sourceBytes: Buffer; manifestBytes: Buffer } | undefined;
  if (options.baseTree !== undefined) {
    for (const [path, content] of Object.entries(options.baseTree)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const baseCommitSha = git(root, "rev-parse", "HEAD");
    const built = await exportBaselineSource({ repositories: [{ repositoryId, directory: root, baseCommitSha }], signal: new AbortController().signal });
    if (built.status !== "READY" || built.buildSource.status !== "READY") throw new Error(built.status === "READY" ? "the baseline build source is unavailable" : built.reason);
    const sourceBytes = Buffer.from(JSON.stringify(built.source), "utf8");
    const manifestBytes = Buffer.from(JSON.stringify(built.buildSource.manifest), "utf8");
    baseline = { baseCommitSha, baseTreeSha: git(root, "rev-parse", "HEAD^{tree}"), stored: assessBaselineSource({ sourceBytes, manifestBytes }), sourceBytes, manifestBytes };
  }
  for (const [path, content] of Object.entries(tree)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "candidate");
  const baseCommitSha = baseline?.baseCommitSha ?? options.baseCommitSha;
  const identity = { repositoryId, commitSha: git(root, "rev-parse", "HEAD"), treeSha: git(root, "rev-parse", "HEAD^{tree}"), ...(baseCommitSha === undefined ? {} : { baseCommitSha }) };
  const source = await readCommittedCandidateSourceExport([{ repositoryId, directory: root }], [identity]);
  const built = await exportCandidateBuildSource({ git: createProcessCandidateGit(await temp("application-scratch-")), repositoryRoot: root, candidate: source.candidate, signal: new AbortController().signal });
  if (built.status !== "READY") throw new Error(built.reason);
  const manifest: E2EApplicationBuildSourceManifest = built.manifest;
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const stored = assessCandidateBuildSource({ manifestBytes, committed: source });
  if (stored.status !== "READY") throw new Error(stored.reason);
  const repository = source.repositories[0]!;
  const snapshot: E2ESourceSnapshot = { candidate: source.candidate, commitSha: identity.commitSha, treeSha: identity.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map((item) => ({ path: item.path, sha256: item.sha256, kind: "blob" as const, bytes: Buffer.from(item.bytesBase64, "base64") })) };
  return { root, identity, source, manifest, manifestBytes, stored, snapshot, buildSource: { manifest, reference: candidateBuildSourceAdmissionReference(stored) }, baseline };
}
export type RealCandidate = Awaited<ReturnType<typeof createRealCandidate>>;
