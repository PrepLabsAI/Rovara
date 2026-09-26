import { createHash } from "node:crypto";

/** The sha256 hex digest used throughout release.json and its verification. */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
