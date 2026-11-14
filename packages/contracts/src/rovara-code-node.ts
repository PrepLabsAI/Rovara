// Rovara Code (Plan 6 Task 1): what needs Node's crypto. Kept apart from `rovara-code.ts`, which the web app imports.
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { MergeTrackingItem } from "./rovara-code.js";

/**
 * The digest of what a merge decision depends on: every field of a tracking item except `observedAt`, `version` and the digest itself, hashed as
 * canonical JSON (key order does not matter). The item is written only when this changes, so a pass that saw nothing new writes nothing.
 */
export function mergeTrackingDecisionDigest(item: Omit<MergeTrackingItem, "decisionDigest" | "observedAt" | "version"> & Partial<Pick<MergeTrackingItem, "decisionDigest" | "observedAt" | "version">>): string {
  const { decisionDigest: _digest, observedAt: _observedAt, version: _version, ...decision } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of the hash on purpose
  return createHash("sha256").update(canonicalJson(decision), "utf8").digest("hex");
}
