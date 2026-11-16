// Proof and evidence P6: the private store for evidence artifacts (output tails here; screenshots of a strip, API samples, video and traces belong to the capture lane) and the one rule for reading them back.
//
// Store. Objects are content-addressed UNDER THE TASK, `private/<owner>/<workspace>/evidence/<taskId>/<sha256>` (Opus review I4: byte-identical files of two tasks of one workspace are two objects, so deleting one task's
// artifact never deletes another's and a pack can never name an object of another task), written only when they are what their kind says: the bytes have the named digest,
// are within the kind's cap, carry the kind's magic bytes (JPEG, WebM `1A45DFA3`, ZIP `504B0304`), and a JSON sample or a text tail really parses. Each object carries its retention class
// (`evidence-short` or `evidence-std`), which decides how long the evidence blob store keeps it. The store is the `EvidenceBlobStore` port (the web download, with its signed address, is a surface of lane L8).
//
// Read. An artifact is read back only when the task's CURRENT evidence view names it as available (`servableEvidenceArtifact`): a hash the store happens to hold (a withheld video, a file of an older
// candidate, another task's) is never read by this answer. The reader's right to the task is checked by the caller's `authorize` on EVERY request.
import { createHash } from "node:crypto";
import {
  EVIDENCE_ARTIFACT_CONTENT_TYPES, EVIDENCE_ARTIFACT_MAGIC, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, parseApiSample, servableEvidenceArtifact,
  type ArtifactLink, type ArtifactRef, type EvidenceArtifactKind, type EvidenceRetentionClass, type EvidenceView,
} from "@agentx/contracts";
import { EvidenceObjectTooBigError, type EvidenceBlobStore } from "./evidence-blob-store.js";

export type EvidenceArtifactStore = Readonly<{ blobs: EvidenceBlobStore }>;
export type EvidenceOwner = Readonly<{ ownerKey: string; workspaceId: string; taskId: string }>;

export const evidenceArtifactKey = (ownerKey: string, workspaceId: string, taskId: string, sha256: string): string => `private/${ownerKey}/${workspaceId}/evidence/${taskId}/${sha256}`;
const KEY_SHAPE = /^private\/[^/]+\/[^/]+\/evidence\/[^/]+\/[a-f0-9]{64}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const keyOf = (owner: EvidenceOwner, sha256: string): string => {
  if (!TASK_ID.test(owner.taskId)) throw new Error("an evidence key names its task");
  return evidenceArtifactKey(owner.ownerKey, owner.workspaceId, owner.taskId, sha256);
};
const SHA = /^[a-f0-9]{64}$/u;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const hasMagic = (bytes: Uint8Array, hex: string) => hex.match(/../gu)!.every((pair, index) => bytes[index] === Number.parseInt(pair, 16));

/** True when `bytes` are a well-formed artifact of `kind`: within its cap, with its magic bytes, and (JSON, text) parsing. */
export function evidenceBytesAreKind(kind: EvidenceArtifactKind, bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > EVIDENCE_ARTIFACT_MAX_BYTES[kind]) return false;
  const magic = EVIDENCE_ARTIFACT_MAGIC[kind];
  if (magic !== undefined) return hasMagic(bytes, magic);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (kind === "api_sample_json") return parseApiSample(bytes) !== undefined;
    // eslint-disable-next-line no-control-regex -- the point is to refuse control characters in a text artifact
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text);
  } catch {
    return false;
  }
}

export type StoreEvidenceItem = Readonly<{ kind: EvidenceArtifactKind; bytes: Uint8Array; sha256?: string }>;

/**
 * Stores the artifacts that are what they say; anything else is skipped and absent from the result, so the pack builder (which drops a reference to anything the store does not hold) loses its link.
 * Content addressed, so writing one again changes nothing. Returns what was stored, by digest.
 */
export async function storeEvidenceArtifacts(store: EvidenceArtifactStore, owner: EvidenceOwner, items: readonly StoreEvidenceItem[]): Promise<Map<string, ArtifactRef>> {
  const stored = new Map<string, ArtifactRef>();
  for (const item of items) {
    const digest = sha256Of(item.bytes);
    if ((item.sha256 !== undefined && item.sha256 !== digest) || !evidenceBytesAreKind(item.kind, item.bytes)) continue;
    const retentionClass = EVIDENCE_ARTIFACT_RETENTION[item.kind];
    if (retentionClass === "evidence-record") continue;
    try {
      await store.blobs.put(keyOf(owner, digest), item.bytes, { contentType: EVIDENCE_ARTIFACT_CONTENT_TYPES[item.kind], metadata: { sha256: digest, kind: item.kind }, retention: retentionClass },
        // The key is the content's own SHA-256 under this task, so a second write of the same key is the same bytes (a retried capture): the one deliberate overwrite.
        { overwrite: true });
    } catch (error) {
      // An object this store cannot hold is left out like any other that is not storable: the pack builder loses its link.
      if (error instanceof EvidenceObjectTooBigError) continue;
      throw error;
    }
    stored.set(digest, { kind: item.kind, sha256: digest, bytes: item.bytes.byteLength, retentionClass });
  }
  return stored;
}

/** What the store really holds for these digests: their kind and size, from the object's own metadata. The pack builder keeps a reference only when it matches. */
export async function statEvidenceArtifacts(store: EvidenceArtifactStore, owner: EvidenceOwner, digests: readonly string[]): Promise<Map<string, { kind: EvidenceArtifactKind; bytes: number }>> {
  const held = new Map<string, { kind: EvidenceArtifactKind; bytes: number }>();
  for (const digest of new Set(digests)) {
    if (!SHA.test(digest)) continue;
    try {
      const head = await store.blobs.stat(keyOf(owner, digest));
      const kind = head?.metadata["kind"];
      if (head !== undefined && kind !== undefined && kind in EVIDENCE_ARTIFACT_RETENTION && head.metadata["sha256"] === digest && Number.isSafeInteger(head.bytes)) held.set(digest, { kind: kind as EvidenceArtifactKind, bytes: head.bytes });
    } catch { /* not held */ }
  }
  return held;
}

/**
 * Deletes artifacts the pack withheld (a video whose gate failed, a file of a candidate that was sent back), so a withheld file cannot be fetched by its hash. Returns the digests it could not delete
 * (and hands each to `onFailed`, the caller's durable retry queue with an alarm); it never throws for one object. Only THIS task's objects can be named by the key.
 */
export async function deleteEvidenceArtifacts(store: EvidenceArtifactStore, owner: EvidenceOwner, refs: readonly Pick<ArtifactRef, "sha256">[], onFailed?: (failure: { key: string; sha256: string }) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const ref of refs) {
    if (!SHA.test(ref.sha256)) continue;
    try { await store.blobs.delete(keyOf(owner, ref.sha256)); } catch {
      failed.push(ref.sha256);
      try { onFailed?.({ key: keyOf(owner, ref.sha256), sha256: ref.sha256 }); } catch { /* the retry queue failing changes nothing here */ }
    }
  }
  return failed;
}

async function readObject(store: EvidenceArtifactStore, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!KEY_SHAPE.test(key)) return undefined;
  try { return await store.blobs.get(key, maxBytes); } catch { return undefined; }
}

// ---- the read

export type EvidenceRead =
  | { status: 200; kind: EvidenceArtifactKind; retentionClass: EvidenceRetentionClass; contentType: string; bytes: Uint8Array; disposition: "inline" | "attachment" }
  | { status: 403 | 404 | 503 };

export type EvidenceReadDependencies = Readonly<{
  /** The caller's right to the task, checked on every request. Throws (or resolves to undefined) for someone who may not read it; says nothing else about the task. */
  authorize(): Promise<{ ownerKey: string; workspaceId: string; taskId: string; candidateDigest: string | undefined; view: EvidenceView | undefined } | undefined>;
  store: EvidenceArtifactStore;
}>;

const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]);

/**
 * One evidence read. 403 for anyone who may not read the task (a task that does not exist as well, so the answer confirms nothing); 404 for a digest the CURRENT pack does not name as available (a withheld
 * video, an expired file, another candidate's); 503 when the store fails. Bytes are re-checked against the pack's own ref (size, kind, digest) before they leave. The local review pages (lane L8) serve this.
 */
export async function readEvidenceArtifact(deps: EvidenceReadDependencies, sha256: string): Promise<EvidenceRead> {
  if (!SHA.test(sha256)) return { status: 404 };
  let task: Awaited<ReturnType<EvidenceReadDependencies["authorize"]>>;
  try { task = await deps.authorize(); } catch (error) {
    const { code } = (error ?? {}) as { code?: unknown };
    return typeof code === "string" && HIDDEN.has(code) ? { status: 403 } : { status: 503 };
  }
  if (task === undefined) return { status: 403 };
  const link: ArtifactLink | undefined = servableEvidenceArtifact(task.view, task.candidateDigest, sha256);
  if (link === undefined) return { status: 404 };
  let key: string;
  try { key = keyOf({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: task.taskId }, sha256); } catch { return { status: 404 }; }
  const bytes = await readObject(deps.store, key, link.bytes);
  if (bytes === undefined) return { status: 404 };
  if (bytes.byteLength !== link.bytes || sha256Of(bytes) !== sha256 || !evidenceBytesAreKind(link.kind, bytes)) return { status: 404 };
  return { status: 200, kind: link.kind, retentionClass: link.retentionClass, contentType: EVIDENCE_ARTIFACT_CONTENT_TYPES[link.kind], bytes, disposition: link.kind === "jpeg" ? "inline" : "attachment" };
}
