// RULING Q3: schema digest checks remain synchronous and byte-identical in both hosts.
import { Sha256 } from "@aws-crypto/sha256-js";
export function sha256Hex(text: string): string {
 const hash = new Sha256(); hash.update(new TextEncoder().encode(text));
 return Array.from(hash.digestSync(), byte => byte.toString(16).padStart(2, "0")).join("");
}
