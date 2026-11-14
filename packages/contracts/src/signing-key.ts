// A trusted signing key, read from a PEM public key: the one key rule the signed service catalog (test services) needs. In Cloud the same function lives in the
// enterprise release-bundle file (bundle.ts), which Code does not carry (decision 41, "edition enterprise parts"); Cloud's file imports it from here.
import { createHash, createPublicKey } from "node:crypto";

const sha256OfBytes = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A trusted key, as a PEM "PUBLIC KEY" (SubjectPublicKeyInfo). A private key, a certificate or a non-P-256 key is refused. */
export function parseBundlePublicKey(pem: string): { keyId: string; key: ReturnType<typeof createPublicKey> } {
  if (typeof pem !== "string" || !/^\s*-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)) {
    throw new Error("a bundle signing key must be a PEM PUBLIC KEY");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("a bundle signing key must be an ECDSA P-256 key");
  }
  const der = key.export({ type: "spki", format: "der" });
  return { keyId: sha256OfBytes(der), key };
}
