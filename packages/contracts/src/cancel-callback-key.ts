import { hkdfSync } from "node:crypto";

/**
 * #201: the cancel-result child key. The root is the existing UTF-8 parameter text, not decoded
 * base64url. Transport the returned bytes as base64url, then decode before signing or verifying.
 */
export function deriveCancelCallbackKey(root: string): Buffer {
  const input = Buffer.from(root, "utf8");
  if (input.length < 32) throw new Error("callback signing key must contain at least 32 bytes");
  return Buffer.from(hkdfSync(
    "sha256", input,
    Buffer.from("agentx:callback-key-derivation:v1", "utf8"),
    Buffer.from("agentx:cancel-callbacks:v1", "utf8"),
    32,
  ));
}
