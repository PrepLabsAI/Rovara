import { createHash } from "node:crypto";
import { AwsError, AwsJsonClient, type CredentialSource, type WireTransport } from "./aws.js";
import { PRODUCT_KEY_PURPOSE, type KmsLike, type ProductKeyFingerprinter } from "./product-seal.js";

/**
 * KMS's JSON protocol for the two calls product-key sealing makes (product-seal.ts kmsProductKeyService): GenerateDataKey and
 * Decrypt, both with an encryption context. Node built-ins only (the image holds no node_modules), like aws.ts's other clients.
 * A KMS refusal is thrown with the service's error code as its `name` (InvalidCiphertextException, IncorrectKeyException, ...),
 * so the seal can tell "this record is not ours" from an outage. Blobs travel base64 both ways; nothing here is logged.
 */
export interface KmsClientOptions { region: string; credentials: CredentialSource; transport?: WireTransport; endpoint?: string; now?: () => number }

export class KmsRefused extends Error { constructor(code: string) { super("kms request refused"); this.name = code; } }

const blob = (value: unknown): Uint8Array | undefined => typeof value === "string" && value.length <= 16_384 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) ? new Uint8Array(Buffer.from(value, "base64")) : undefined;

/** KmsLike plus GenerateMac (the fingerprint key, an HMAC_256 KMS key: the secret never leaves KMS). */
export interface KmsWithMac extends KmsLike {
  generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }>;
  /** KMS VerifyMac: true only when KMS answers MacValid true. A wrong MAC is KMS's KMSInvalidMacException (thrown as KmsRefused). */
  verifyMac(input: { KeyId: string; Message: Uint8Array; Mac: Uint8Array }): Promise<boolean>;
}

export function awsKms(options: KmsClientOptions): KmsWithMac {
  const client = new AwsJsonClient({ region: options.region, service: "kms", targetPrefix: "TrentService", contentType: "application/x-amz-json-1.1", credentials: options.credentials, ...(options.transport === undefined ? {} : { transport: options.transport }), ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }), ...(options.now === undefined ? {} : { now: options.now }) });
  const call = async (operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { return await client.call(operation, input); }
    catch (error) { if (error instanceof AwsError) throw new KmsRefused(error.code); throw error; }
  };
  return {
    async generateDataKey(input) {
      const answer = await call("GenerateDataKey", { KeyId: input.KeyId, KeySpec: input.KeySpec, EncryptionContext: { ...input.EncryptionContext } });
      const plaintext = blob(answer.Plaintext); const wrapped = blob(answer.CiphertextBlob);
      return { ...(plaintext === undefined ? {} : { Plaintext: plaintext }), ...(wrapped === undefined ? {} : { CiphertextBlob: wrapped }) };
    },
    async generateMac(input) {
      const answer = await call("GenerateMac", { KeyId: input.KeyId, MacAlgorithm: "HMAC_SHA_256", Message: Buffer.from(input.Message).toString("base64") });
      const mac = blob(answer.Mac);
      return mac === undefined ? {} : { Mac: mac };
    },
    async verifyMac(input) {
      const answer = await call("VerifyMac", { KeyId: input.KeyId, MacAlgorithm: "HMAC_SHA_256", Message: Buffer.from(input.Message).toString("base64"), Mac: Buffer.from(input.Mac).toString("base64") });
      return answer.MacValid === true;
    },
    async decrypt(input) {
      const answer = await call("Decrypt", { KeyId: input.KeyId, CiphertextBlob: Buffer.from(input.CiphertextBlob).toString("base64"), EncryptionContext: { ...input.EncryptionContext } });
      const plaintext = blob(answer.Plaintext);
      return plaintext === undefined ? {} : { Plaintext: plaintext };
    },
  };
}

/**
 * Keyed fingerprints (F1-d L4) from a KMS HMAC key: the same input as product-seal.ts hmacFingerprinter, hashed first so the
 * message stays under KMS's 4,096-byte limit. Used where keys are written (Cloud's settings routes); the gateway never needs it.
 */
export function kmsFingerprinter(kms: Pick<KmsWithMac, "generateMac">, keyId: string): ProductKeyFingerprinter {
  return async (input) => {
    const message = createHash("sha256").update(JSON.stringify([PRODUCT_KEY_PURPOSE, input.cid, input.owner, input.sourceId, input.key])).digest();
    const answer = await kms.generateMac({ KeyId: keyId, Message: message });
    if (answer.Mac === undefined || answer.Mac.length !== 32) throw new Error("product keys unavailable");
    return Buffer.from(answer.Mac).toString("hex");
  };
}
