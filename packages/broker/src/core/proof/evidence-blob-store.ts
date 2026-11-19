// Proof and evidence: where kept evidence lives. In Cloud this was an S3 bucket (objects tagged with a retention class, expired by a lifecycle rule); Code keeps it behind this small port so the
// core never names a bucket (decision 51). The document-store adapter below is the default: it keeps each object as one document, so it holds only what fits a document (the pack and the output
// tails, which is all this path stores; video and trace belong to the capture lane and a file-backed adapter). The keys are Cloud's object keys, unchanged.
import { when, assertObjectKey, assertObjectMeta, assertObjectPrefix, companyScoped, DOCUMENT_STORE_LIMITS, INDEX_EXPIRY_ATTRIBUTE, EVIDENCE_RETENTION_DAYS, ObjectConflictError, ObjectTooBigError, queryAll, type DocumentStore, type EvidenceRetentionClass, type ObjectMeta, type ObjectPutOptions, type ObjectStorage } from "@agentx/contracts";

/**
 * Port lane L9a (provisional, owner decision 58): the evidence blob store IS the `object-storage` port now (`ObjectStorage` in
 * @agentx/contracts). These names stay so the proof code and its tests need no change; the folder adapter lives in
 * @agentx/local-adapters and the document-store adapter below is the default.
 */
export interface EvidenceBlobMeta extends ObjectMeta {
  /** Decides how long it is kept; `evidence-record` is stored as `evidence-std` (the pack expires with the tails). */
  retention: Exclude<EvidenceRetentionClass, "evidence-record">;
}

export type EvidenceBlobStore = Omit<ObjectStorage, "put"> & {
  /** Stores the object, replacing one at the same key. Throws `EvidenceObjectTooBigError` for an object this store cannot hold. */
  put(key: string, bytes: Uint8Array, meta: EvidenceBlobMeta, options?: ObjectPutOptions): Promise<void>;
};

export const EvidenceObjectTooBigError = ObjectTooBigError;
export type EvidenceObjectTooBigError = ObjectTooBigError;

const PARTITION = "EVIDENCE_BLOB";
/** What one document can hold of an object once it is written as base64 text with its other fields. */
export const DOCUMENT_BLOB_MAX_BYTES = Math.floor(((DOCUMENT_STORE_LIMITS.maxDocumentBytes - 4_096) * 3) / 4);
const DAY_SECONDS = 86_400;

/** The document-store adapter. `companyId` is the company the evidence belongs to (Code: the one implicit company); the scope is in the key (decision 45.6). */
export function createDocumentEvidenceBlobStore(store: Pick<DocumentStore, "get" | "put" | "delete" | "query" | "ttlAttribute">, options: { companyId: string; now?: () => number; retentionDays?: Partial<Record<EvidenceBlobMeta["retention"], number>> }): EvidenceBlobStore {
  const pk = companyScoped(options.companyId, PARTITION);
  const now = options.now ?? Date.now;
  // A class this adapter does not know (the port's classes are the caller's words) is kept until it is deleted.
  const days = (retention: string): number | undefined => (options.retentionDays as Record<string, number | undefined> | undefined)?.[retention] ?? (retention === "evidence-short" || retention === "evidence-std" ? EVIDENCE_RETENTION_DAYS[retention].default : undefined);
  const keyOf = (key: string) => ({ pk, sk: key });
  // The attribute the store sweeps (its `ttlAttribute`), else the scheme's default: a row written under another name would never expire.
  const ttlAttribute = store.ttlAttribute ?? INDEX_EXPIRY_ATTRIBUTE;
  const expired = (row: { [key: string]: unknown }): boolean => typeof row[ttlAttribute] === "number" && row[ttlAttribute] <= now() / 1000;
  return {
    async put(key, bytes, meta, options) {
      assertObjectKey(key);
      assertObjectMeta(meta);
      if (bytes.byteLength > DOCUMENT_BLOB_MAX_BYTES) throw new EvidenceObjectTooBigError(bytes.byteLength, DOCUMENT_BLOB_MAX_BYTES);
      // Immutable by default: the write is conditional on the key being new, or its row having expired (not yet swept). One conditional write, so two writers racing for a key cannot both win.
      const free = { op: "or", conditions: [when.absent(), { op: "lte", path: [ttlAttribute], value: Math.floor(now() / 1000) }] } as const;
      const written = await store.put({
        ...(options?.overwrite === true ? {} : { condition: free }),
        item: {
          ...keyOf(key), entityType: "EVIDENCE_BLOB", bytes: bytes.byteLength, body: Buffer.from(bytes).toString("base64"), contentType: meta.contentType, metadata: { ...meta.metadata }, retention: meta.retention,
          ...(days(meta.retention) === undefined ? {} : { [ttlAttribute]: Math.floor(now() / 1000) + days(meta.retention)! * DAY_SECONDS }),
        },
      });
      if (!written.applied) throw new ObjectConflictError(key);
    },
    async get(key, maxBytes) {
      assertObjectKey(key);
      const found = await store.get(keyOf(key));
      if (found === undefined || expired(found) || found["entityType"] !== "EVIDENCE_BLOB" || typeof found["body"] !== "string" || typeof found["bytes"] !== "number" || found["bytes"] > maxBytes) return undefined;
      const bytes = new Uint8Array(Buffer.from(found["body"], "base64"));
      return bytes.byteLength === found["bytes"] ? bytes : undefined;
    },
    async stat(key) {
      assertObjectKey(key);
      const found = await store.get(keyOf(key));
      if (found === undefined || expired(found) || found["entityType"] !== "EVIDENCE_BLOB" || typeof found["bytes"] !== "number") return undefined;
      const metadata = found["metadata"];
      return { bytes: found["bytes"], metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {} };
    },
    async delete(key) {
      assertObjectKey(key);
      await store.delete({ key: keyOf(key) });
    },
    async deletePrefix(prefix) {
      assertObjectPrefix(prefix);
      for (let round = 0; round < 100; round += 1) {
        const found = await queryAll(store, { pk, sk: { op: "beginsWith", prefix }, limit: 100 });
        if (found.length === 0) return true;
        for (const item of found) await store.delete({ key: { pk: item.pk, sk: item.sk } });
      }
      return false;
    },
  };
}

/** The `object-storage` point's default adapter: objects kept as documents, so only what fits a document (see `DOCUMENT_BLOB_MAX_BYTES`). Same adapter as above, under the port's name. */
export function createDocumentObjectStorage(store: Pick<DocumentStore, "get" | "put" | "delete" | "query" | "ttlAttribute">, options: { companyId: string; now?: () => number; retentionDays?: Partial<Record<EvidenceBlobMeta["retention"], number>> }): ObjectStorage {
  return createDocumentEvidenceBlobStore(store, options);
}
