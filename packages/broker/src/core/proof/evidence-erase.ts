// Proof and evidence (wire-proof fix round 1): deleting what the evidence path stored. Two kinds of object live under a task's workspace:
//   private/<owner>/<workspace>/evidence-pack/<task>/<digest>.json   the pack (test names, check labels, paths)
//   private/<owner>/<workspace>/evidence/<task>/<sha256>             output tails (and any artifact the capture lane adds)
// Only keys under the exact prefixes above are ever listed or deleted; an owner, workspace or task id that is not a plain id is refused, so no id can widen a prefix.
//
// Left in Cloud (decision 41, 51 gap): the walks by PERSON, PROJECT and COMPANY (`createEvidenceErase`: the company's project catalog, the workspace-by-project index, the resumable cursor and the marker
// of the orgs that hold evidence, the nightly coverage maps and the test-service fixtures). They read Cloud's org data. A Cloud adapter finds the workspaces and calls `eraseWorkspaceEvidence` for each.
import type { EvidenceBlobStore } from "./evidence-blob-store.js";

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** The prefixes of one task's evidence in a workspace; `taskId` undefined is every task's in that workspace. Undefined when an id is not a plain id. */
export function evidencePrefixesOf(scope: { ownerKey: string; workspaceId: string; taskId?: string | undefined }): string[] | undefined {
  if (!PLAIN.test(scope.ownerKey) || !PLAIN.test(scope.workspaceId) || (scope.taskId !== undefined && !PLAIN.test(scope.taskId))) return undefined;
  const base = `private/${scope.ownerKey}/${scope.workspaceId}`;
  const tail = scope.taskId === undefined ? "/" : `/${scope.taskId}/`;
  return [`${base}/evidence-pack${tail}`, `${base}/evidence${tail}`];
}

/** Deletes the pack and the tails of one task. True when nothing is left; throws for an id that is not a plain id (nothing is deleted). */
export async function eraseTaskEvidence(blobs: Pick<EvidenceBlobStore, "deletePrefix">, scope: { ownerKey: string; workspaceId: string; taskId: string }): Promise<boolean> {
  return erase(blobs, scope);
}

/** Deletes the evidence of every task of a workspace. True when nothing is left. */
export async function eraseWorkspaceEvidence(blobs: Pick<EvidenceBlobStore, "deletePrefix">, scope: { ownerKey: string; workspaceId: string }): Promise<boolean> {
  return erase(blobs, scope);
}

async function erase(blobs: Pick<EvidenceBlobStore, "deletePrefix">, scope: { ownerKey: string; workspaceId: string; taskId?: string | undefined }): Promise<boolean> {
  const prefixes = evidencePrefixesOf(scope);
  if (prefixes === undefined) throw new Error("an evidence erase names plain ids");
  let finished = true;
  for (const prefix of prefixes) finished = (await blobs.deletePrefix(prefix)) && finished;
  return finished;
}
