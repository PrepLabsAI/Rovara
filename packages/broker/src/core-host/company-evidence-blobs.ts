// L4-HW4: the object storage a hosted company's evidence is kept in and read from. The registry's `object-storage` point is ONE bucket for every company, so the evidence path is never handed it as it is: every
// key must name a workspace of THIS company's own store (and the owner that workspace was started for), exactly as the flow's artifacts reader holds a read (company-artifact-reader.ts).
//   get      the same reader (a key outside the company's workspaces, another owner's key, a callback-shaped key with no ARTIFACT row of this company: not there), with the room the evidence readers ask for;
//   put, stat, delete   only the keys the evidence keeper writes (`private/<owner>/<workspace>/evidence-pack/<task>/...` and `.../evidence/<task>/...`) of a workspace this company holds; anything else is refused in fixed words;
//   deletePrefix   not offered here (the person erase and the company purge walk the bucket with their own handle).
// Fails closed everywhere: a store that cannot answer is "not there" for a read and a refusal for a write, and nothing here names a key, a company or a cause in what it says.
import { ObjectKeyError, assertObjectKey, type DocumentStore, type ObjectMeta, type ObjectPutOptions, type ObjectStat, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { artifactKeyScopeOf, createCompanyArtifactReader, workspaceHoldingKey, type ArtifactReadRefusal } from "./company-artifact-reader.js";

/** The most bytes one read may ask for: the largest the evidence readers ask for (the pack's 4 MiB; the worker's raw file is at most 2 MiB). */
export const COMPANY_EVIDENCE_READ_MAX_BYTES = 4 * 1_048_576;

/** The folders under a task's workspace that the evidence keeper owns: the pack (with its baseline and dependency facts) and the output tails. */
const EVIDENCE_FOLDERS: ReadonlySet<string> = new Set(["evidence-pack", "evidence"]);

export interface CompanyEvidenceBlobsOptions {
  blobs: ObjectStorage;
  /** The company's own store (the registry's `storage`): where the workspace record that binds a key to this company is read. */
  store: Pick<DocumentStore, "get">;
  companyId: OrgId;
  /** Told, best effort, why an access gave nothing. Fixed words only; a fault in it never reaches the caller. */
  refused?: (reason: ArtifactReadRefusal | "not_evidence_key") => void;
}

export const EVIDENCE_STORE_REFUSAL = "this evidence object is not one of this company's own";

export function createCompanyEvidenceBlobs(options: CompanyEvidenceBlobsOptions): ObjectStorage {
  const { blobs, store, companyId } = options;
  const note = (reason: ArtifactReadRefusal | "not_evidence_key"): void => { try { options.refused?.(reason); } catch { /* a log never changes an answer */ } };
  const reader = createCompanyArtifactReader({ blobs, store, companyId, maxReadBytes: COMPANY_EVIDENCE_READ_MAX_BYTES, refused: note });
  /** Throws (fixed words) unless the key is an evidence key of a workspace this company holds. */
  const requireEvidenceKey = async (key: string): Promise<void> => {
    assertObjectKey(key);
    const scope = artifactKeyScopeOf(key);
    const folder = key.split("/")[3];
    if (scope === undefined || scope.form !== "owner" || folder === undefined || !EVIDENCE_FOLDERS.has(folder)) { note("not_evidence_key"); throw new ObjectKeyError(EVIDENCE_STORE_REFUSAL); }
    const held = await workspaceHoldingKey({ store, companyId }, scope);
    if (typeof held === "string") { note(held); throw new ObjectKeyError(EVIDENCE_STORE_REFUSAL); }
  };
  return {
    async put(key: string, bytes: Uint8Array, meta: ObjectMeta, putOptions?: ObjectPutOptions): Promise<void> {
      await requireEvidenceKey(key);
      await blobs.put(key, bytes, meta, putOptions);
    },
    async get(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
      return await reader.get(key, maxBytes);
    },
    async stat(key: string): Promise<ObjectStat | undefined> {
      try { await requireEvidenceKey(key); } catch { return undefined; }
      return await blobs.stat(key);
    },
    async delete(key: string): Promise<void> {
      await requireEvidenceKey(key);
      await blobs.delete(key);
    },
    async deletePrefix(): Promise<boolean> {
      throw new ObjectKeyError(EVIDENCE_STORE_REFUSAL);
    },
  };
}
