import { isStrongStorageValue } from "./storage-entry-classifier.js";

/**
 * Whether a storage entry's whole value is a credential (MIDSTEPCOOKIE's boolean; MIDSTEP-2 moved the judgement to `credential-classifier.ts` and `storage-entry-classifier.ts`).
 *
 * The worker REFUSES a model call whose prompt shows a synced value, so only a credential may be strong: a draft the app autosaves, a `returnTo` address, a search history, a slug, a UUID
 * under an ordinary key are not. The tiers, the key reading and the JSON leaves are described in those two files; this stays as the one-entry question.
 */
export function isSessionStorageCredential(entry: { name: string; value: string }): boolean {
  return isStrongStorageValue(entry);
}
