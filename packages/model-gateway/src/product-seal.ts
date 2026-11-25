// Sealing a stored product key: envelope encryption, the same scheme as Cloud's session store (cloud-server session-crypto.ts),
// under its own purpose. Each write asks the key service (KMS deployed) for a fresh data key, seals the key with AES-256-GCM
// and keeps only the wrapped data key beside it. Both the data key (KMS encryption context) and the sealed text (GCM
// additional data) are bound to the exact row: install, company, owner, source and version. A sealed key copied onto another
// row, company or version does not open.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const PRODUCT_KEY_PURPOSE = "rovara-product-ai-key";
const FORMAT = "pk1";

/** The row a sealed key belongs to. Every field is part of the binding. */
export interface ProductKeyRow { iss: string; cid: string; owner: string; sourceId: string; versionId: string }

/** Where data keys come from (KMS deployed). Both calls are bound to the row by `context`. */
export interface ProductKeyService {
  generateDataKey(context: Readonly<Record<string, string>>): Promise<{ plaintext: Uint8Array; wrapped: Uint8Array }>;
  unwrapDataKey(wrapped: Uint8Array, context: Readonly<Record<string, string>>): Promise<Uint8Array>;
}

/** Fixed words, no detail: another key, another row, or damaged. */
export class SealedProductKeyRefused extends Error { constructor() { super("the stored product key could not be opened"); this.name = "SealedProductKeyRefused"; } }

export const productKeyContext = (row: ProductKeyRow): Record<string, string> => ({ purpose: PRODUCT_KEY_PURPOSE, install: row.iss, company: row.cid, owner: row.owner, source: row.sourceId, version: row.versionId });
const aad = (row: ProductKeyRow) => Buffer.from(JSON.stringify([PRODUCT_KEY_PURPOSE, FORMAT, row.iss, row.cid, row.owner, row.sourceId, row.versionId]));

export class ProductKeySealer {
  constructor(private readonly keys: ProductKeyService) {}
  async seal(plaintext: string, row: ProductKeyRow): Promise<string> {
    const { plaintext: dataKey, wrapped } = await this.keys.generateDataKey(productKeyContext(row));
    if (dataKey.length !== 32) throw new Error("product keys unavailable");
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv).setAAD(aad(row));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [FORMAT, Buffer.from(wrapped).toString("base64url"), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    } finally { dataKey.fill(0); }
  }
  async open(sealed: string, row: ProductKeyRow): Promise<string> {
    const parts = typeof sealed === "string" ? sealed.split(".") : [];
    if (parts.length !== 5 || parts[0] !== FORMAT) throw new SealedProductKeyRefused();
    const [, wrapped, iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer, Buffer, Buffer];
    if (iv.length !== 12 || tag.length !== 16) throw new SealedProductKeyRefused();
    // A refusal throws SealedProductKeyRefused; a key-service outage throws as it is and keeps the record.
    const dataKey = await this.keys.unwrapDataKey(wrapped, productKeyContext(row));
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, iv).setAAD(aad(row)).setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch { throw new SealedProductKeyRefused(); } finally { dataKey.fill(0); }
  }
}

/** The subset of the AWS SDK's aggregated `KMS` client this needs (structural: no SDK import in this package). */
export interface KmsLike {
  generateDataKey(input: { KeyId: string; KeySpec: "AES_256"; EncryptionContext: Record<string, string> }): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  decrypt(input: { KeyId: string; CiphertextBlob: Uint8Array; EncryptionContext: Record<string, string> }): Promise<{ Plaintext?: Uint8Array }>;
}
/** Data keys from KMS under the gateway's own product-key key. Decrypt names the key, so a record wrapped by any other key is refused. */
export function kmsProductKeyService(kms: KmsLike, keyId: string): ProductKeyService {
  return {
    async generateDataKey(context) {
      const answer = await kms.generateDataKey({ KeyId: keyId, KeySpec: "AES_256", EncryptionContext: { ...context } });
      if (answer.Plaintext?.length !== 32 || answer.CiphertextBlob === undefined) throw new Error("product keys unavailable");
      return { plaintext: answer.Plaintext, wrapped: answer.CiphertextBlob };
    },
    async unwrapDataKey(wrapped, context) {
      let answer: { Plaintext?: Uint8Array };
      try { answer = await kms.decrypt({ KeyId: keyId, CiphertextBlob: wrapped, EncryptionContext: { ...context } }); }
      catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "InvalidCiphertextException" || name === "IncorrectKeyException") throw new SealedProductKeyRefused();
        throw new Error("product keys unavailable", { cause: error });
      }
      if (answer.Plaintext?.length !== 32) throw new SealedProductKeyRefused();
      return answer.Plaintext;
    },
  };
}
/** Data keys wrapped by a 32-byte key held in memory: tests and a laptop only, never a deployed gateway. */
export function localProductKeyService(key: Uint8Array): ProductKeyService {
  if (key.length !== 32) throw new Error("a local product key service key is 32 bytes");
  const master = Buffer.from(key);
  const bind = (context: Readonly<Record<string, string>>) => Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  return {
    async generateDataKey(context) {
      const plaintext = randomBytes(32); const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv).setAAD(bind(context));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]) };
    },
    async unwrapDataKey(wrapped, context) {
      const bytes = Buffer.from(wrapped);
      try {
        const decipher = createDecipheriv("aes-256-gcm", master, bytes.subarray(0, 12)).setAAD(bind(context)).setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      } catch { throw new SealedProductKeyRefused(); }
    },
  };
}

/** Key fingerprints are a KEYED HMAC (F1-d L4), never a plain hash of the key: a leaked fingerprint can't be checked against a guessed key. */
export type ProductKeyFingerprinter = (input: { cid: string; owner: string; sourceId: string; key: string }) => Promise<string>;
export function hmacFingerprinter(secret: Uint8Array): ProductKeyFingerprinter {
  if (secret.length < 32) throw new Error("a fingerprint key is at least 32 bytes");
  const key = Buffer.from(secret);
  return async (input) => createHmac("sha256", key).update(JSON.stringify([PRODUCT_KEY_PURPOSE, input.cid, input.owner, input.sourceId, input.key])).digest("hex");
}
