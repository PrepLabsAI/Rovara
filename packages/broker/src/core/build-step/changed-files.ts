// Lane L12, slice 4: the files the checked code changes, for the pull request's description and the risk it shows. The worker saves `workspace.diff` with each coding run and each rerun of the checks; the newest
// finished one is the code the candidate holds. Its names are read by `parseChangedFiles` (real names, both names of a rename, no count when the diff gave none), so the risk rules (`assessRisk`) see the sensitive
// files and the size of the change, and the description lists them. A diff that cannot be read (none saved, the bytes changed, cut short) gives `undefined` or an incomplete list, and the risk then never reads low.
import { createHash } from "node:crypto";
import { parseChangedFiles } from "../proof/changed-files.js";
import type { ChangedFilesRead, LessonsUsedSection } from "../proof/pull-request-body.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceOperations } from "../task-flow/reads.js";

export const WORKSPACE_DIFF_ARTIFACT = "workspace.diff";
const DIFF_READ_MAX_BYTES = 210_000;

/** The row a worker's artifact is recorded under (`callbacks.ts` writes it; the key is the flow's own scheme). */
export const artifactRowKey = (workspaceId: string, operationId: string, name: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${name}` });

/** The "Lessons used" section of a description on an install with no lessons: it says so, so the section is there and a reader knows why it is empty. */
export const NO_LESSONS_USED: LessonsUsedSection = { count: 0, taskUrl: "", entries: [], none: true };

/** The changed files of the code the task holds now, or undefined when no run saved a diff that matches its digest. Never throws. */
export async function changedFilesOfCandidate(deps: Pick<TaskFlowDeps, "store" | "artifacts">, workspaceId: string): Promise<ChangedFilesRead | undefined> {
  if (deps.artifacts === undefined) return undefined;
  try {
    const finished = (await workspaceOperations(deps, workspaceId)).filter((operation) => operation.status === "SUCCEEDED" && (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS")).reverse();
    for (const operation of finished) {
      const row = await deps.store.get(artifactRowKey(workspaceId, operation.id, WORKSPACE_DIFF_ARTIFACT));
      if (row === undefined || typeof row["objectKey"] !== "string" || typeof row["sha256"] !== "string") continue;
      const bytes = await deps.artifacts.get(row["objectKey"], DIFF_READ_MAX_BYTES);
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== row["sha256"]) continue;
      return parseChangedFiles(new TextDecoder().decode(bytes));
    }
  } catch {
    return undefined;
  }
  return undefined;
}
