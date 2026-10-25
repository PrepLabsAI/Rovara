import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCandidateManifest } from "@agentx/contracts";
import { exportCandidateBuildSourceInScratch, type CandidateBuildSourceExport } from "./e2e-build-source-export.js";
import { createProcessCandidateGit } from "./e2e-candidate-source.js";
import { withIsolatedGit } from "./isolated-git.js";
import { readCommittedCandidateSourceExport, type CandidateRepositoryInput, type CommittedCandidateSourceExport } from "./verification/candidate.js";

/**
 * M1.3 Task 3.7b (owner decision D2): the unchanged code, for the baseline round. At the end of a coding run the worker exports the task's recorded base commit beside the candidate:
 * the committed tree and the safe sources, as the candidate's export holds them, and the build source manifest that describes the tree for a build. Both come through the same safe
 * git path as the candidate's (a throwaway repository that only borrows the objects; git never runs in the workspace's repository), and nothing in the workspace changes.
 *
 * The export is a candidate of its own: its manifest is made of the base commit and tree alone (no base of its own), so its digest names the unchanged code and no candidate round can
 * be mistaken for it. It never decides anything about the coding run: a base that cannot be exported is reported UNAVAILABLE with the reason and the baseline then says it could not
 * be checked. Only the operation's own cancellation throws.
 */

export type BaselineSourceExport =
  | { schemaVersion: "workflow-baseline-source/v1"; status: "READY"; source: CommittedCandidateSourceExport; buildSource: CandidateBuildSourceExport }
  | { schemaVersion: "workflow-baseline-source/v1"; status: "UNAVAILABLE"; reason: string };

const SCHEMA_VERSION = "workflow-baseline-source/v1" as const;
const REASON_CHARS = 480;
const unavailable = (reason: string): BaselineSourceExport => ({ schemaVersion: SCHEMA_VERSION, status: "UNAVAILABLE", reason: reason.length <= REASON_CHARS ? reason : `${reason.slice(0, REASON_CHARS - 1)}…` });

export async function exportBaselineSource(input: { repositories: readonly CandidateRepositoryInput[]; signal: AbortSignal }): Promise<BaselineSourceExport> {
  const cancelled = (error?: unknown) => (input.signal.reason instanceof Error ? input.signal.reason : error instanceof Error ? error : new Error("the baseline source export was cancelled"));
  if (input.signal.aborted) throw cancelled();
  const [repository] = input.repositories;
  if (input.repositories.length !== 1 || repository === undefined) return unavailable("the unchanged code can be exported for a task with exactly one repository");
  const baseCommitSha = repository.baseCommitSha;
  if (baseCommitSha === undefined) return unavailable("the task recorded no base commit, so there is no unchanged code to export");
  try {
    const directory = resolve(repository.directory);
    const baseTreeSha = await withIsolatedGit(directory, "read", async (git) => (await git.text(["rev-parse", "--verify", `${baseCommitSha}^{tree}`], { index: "none" })).trim());
    if (!/^[a-f0-9]{40}$/.test(baseTreeSha)) return unavailable("the task's base commit has no readable tree");
    // The base as a candidate of its own: no base commit of its own, so the exporter reads the commit it is told to and nothing else.
    const identity = { repositoryId: repository.repositoryId, commitSha: baseCommitSha, treeSha: baseTreeSha };
    const source = await readCommittedCandidateSourceExport([{ repositoryId: repository.repositoryId, directory: repository.directory }], [identity], { atCommit: baseCommitSha });
    if (createCandidateManifest([identity]).digest !== source.candidate.digest) return unavailable("the unchanged code's identity could not be established");
    if (input.signal.aborted) throw cancelled();
    const buildSource = await exportCandidateBuildSourceInScratch({ signal: input.signal, candidate: source.candidate, repositoryRoot: directory });
    return { schemaVersion: SCHEMA_VERSION, status: "READY", source, buildSource };
  } catch (error) {
    if (input.signal.aborted) throw cancelled(error);
    return unavailable(`the unchanged code could not be exported: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
}

/**
 * PLANDRYRUN: the unchanged code as plain files, for the planning run to try a plan's proposed checks on. The task's recorded base commit is written (regular files only: no
 * symlink, no submodule, no filter or attribute applied) into the new directory `destination` through the same safe git path as the exports above, so nothing in the
 * workspace's repository is read except its objects and nothing in the workspace changes. The result carries no text: a base that cannot be written is UNAVAILABLE, and only the
 * operation's own cancellation throws. A partly written directory is removed.
 */
export async function materializeBaseSource(input: { repositories: readonly CandidateRepositoryInput[]; destination: string; signal: AbortSignal; scratchRoot?: string }): Promise<{ status: "READY" | "UNAVAILABLE" }> {
  const cancelled = (error?: unknown) => (input.signal.reason instanceof Error ? input.signal.reason : error instanceof Error ? error : new Error("the base source export was cancelled"));
  if (input.signal.aborted) throw cancelled();
  const [repository] = input.repositories;
  if (input.repositories.length !== 1 || repository?.baseCommitSha === undefined) return { status: "UNAVAILABLE" };
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(input.scratchRoot ?? tmpdir(), "agentx-plan-dry-run-git-"));
    await mkdir(input.destination, { mode: 0o755 });
    // The checks run as an unprivileged user through a read-only mount: the folder must be readable whatever the process umask is.
    await chmod(input.destination, 0o755);
    await createProcessCandidateGit(scratch).materializeInto(resolve(repository.directory), repository.baseCommitSha, input.destination, input.signal);
    return { status: "READY" };
  } catch (error) {
    await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
    if (input.signal.aborted) throw cancelled(error);
    return { status: "UNAVAILABLE" };
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
