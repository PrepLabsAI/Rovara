// Proof and evidence: where kept evidence lives. In Cloud this was an S3 bucket (objects tagged with a retention class, expired by a lifecycle rule); Code keeps it behind this small port so the
// core never names a bucket (decision 51). The document-store adapter below is the default: it keeps each object as one document, so it holds only what fits a document (the pack and the output
// tails, which is all this path stores; video and trace belong to the capture lane and a file-backed adapter). The keys are Cloud's object keys, unchanged.
import { companyScoped, DOCUMENT_STORE_LIMITS, INDEX_EXPIRY_ATTRIBUTE, EVIDENCE_RETENTION_DAYS, queryAll, type DocumentStore, type EvidenceRetentionClass } from "@agentx/contracts";

export interface EvidenceBlobMeta {
  contentType: string;
  /** Small text facts about the object (its digest and kind), checked back on a stat. */
  metadata: Readonly<Record<string, string>>;
  /** Decides how long it is kept; `evidence-record` is stored as `evidence-std` (the pack expires with the tails). */
  retention: Exclude<EvidenceRetentionClass, "evidence-record">;
}

export interface EvidenceBlobStore {
  /** Stores the object, replacing one at the same key. Throws `EvidenceObjectTooBigError` for an object this store cannot hold. */
  put(key: string, bytes: Uint8Array, meta: EvidenceBlobMeta): Promise<void>;
  /** The object, or undefined when there is none or it is bigger than `maxBytes` (never cut). */
  get(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /** The size and metadata the store holds for the key, or undefined. */
  stat(key: string): Promise<{ bytes: number; metadata: Readonly<Record<string, string>> } | undefined>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix`; true when none is left. */
  deletePrefix(prefix: string): Promise<boolean>;
}

export class EvidenceObjectTooBigError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`an evidence object of ${String(bytes)} bytes does not fit this store (${String(limit)} at most)`);
    this.name = "EvidenceObjectTooBigError";
  }
}

const PARTITION = "EVIDENCE_BLOB";
/** What one document can hold of an object once it is written as base64 text with its other fields. */
export const DOCUMENT_BLOB_MAX_BYTES = Math.floor(((DOCUMENT_STORE_LIMITS.maxDocumentBytes - 4_096) * 3) / 4);
const DAY_SECONDS = 86_400;

/** The document-store adapter. `companyId` is the company the evidence belongs to (Code: the one implicit company); the scope is in the key (decision 45.6). */
export function createDocumentEvidenceBlobStore(store: Pick<DocumentStore, "get" | "put" | "delete" | "query" | "ttlAttribute">, options: { companyId: string; now?: () => number; retentionDays?: Partial<Record<EvidenceBlobMeta["retention"], number>> }): EvidenceBlobStore {
  const pk = companyScoped(options.companyId, PARTITION);
  const now = options.now ?? Date.now;
  const days = (retention: EvidenceBlobMeta["retention"]): number => options.retentionDays?.[retention] ?? EVIDENCE_RETENTION_DAYS[retention].default;
  const keyOf = (key: string) => ({ pk, sk: key });
  // The attribute the store sweeps (its `ttlAttribute`), else the scheme's default: a row written under another name would never expire.
  const ttlAttribute = store.ttlAttribute ?? INDEX_EXPIRY_ATTRIBUTE;
  const expired = (row: { [key: string]: unknown }): boolean => typeof row[ttlAttribute] === "number" && row[ttlAttribute] <= now() / 1000;
  return {
    async put(key, bytes, meta) {
      if (bytes.byteLength > DOCUMENT_BLOB_MAX_BYTES) throw new EvidenceObjectTooBigError(bytes.byteLength, DOCUMENT_BLOB_MAX_BYTES);
      await store.put({ item: {
        ...keyOf(key), entityType: "EVIDENCE_BLOB", bytes: bytes.byteLength, body: Buffer.from(bytes).toString("base64"), contentType: meta.contentType, metadata: { ...meta.metadata }, retention: meta.retention,
        [ttlAttribute]: Math.floor(now() / 1000) + days(meta.retention) * DAY_SECONDS,
      } });
    },
    async get(key, maxBytes) {
      const found = await store.get(keyOf(key));
      if (found === undefined || expired(found) || found["entityType"] !== "EVIDENCE_BLOB" || typeof found["body"] !== "string" || typeof found["bytes"] !== "number" || found["bytes"] > maxBytes) return undefined;
      const bytes = new Uint8Array(Buffer.from(found["body"], "base64"));
      return bytes.byteLength === found["bytes"] ? bytes : undefined;
    },
    async stat(key) {
      const found = await store.get(keyOf(key));
      if (found === undefined || expired(found) || found["entityType"] !== "EVIDENCE_BLOB" || typeof found["bytes"] !== "number") return undefined;
      const metadata = found["metadata"];
      return { bytes: found["bytes"], metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {} };
    },
    async delete(key) {
      await store.delete({ key: keyOf(key) });
    },
    async deletePrefix(prefix) {
      for (let round = 0; round < 100; round += 1) {
        const found = await queryAll(store, { pk, sk: { op: "beginsWith", prefix }, limit: 100 });
        if (found.length === 0) return true;
        for (const item of found) await store.delete({ key: { pk: item.pk, sk: item.sk } });
      }
      return false;
    },
  };
}
