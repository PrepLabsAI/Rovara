// Lane L9-wire: a worker's document (a plan) is untrusted bytes. The workflow fixes the document's digest when the plan is submitted, and the owner's approval binds that digest; so every
// reader checks the bytes it is about to show against the digest and shows nothing that does not match (fail closed).
import type { ObjectStorage } from "@agentx/contracts";
import { createHash } from "node:crypto";

export const DOCUMENT_CHANGED = "This document changed after it was submitted, so it cannot be shown. Ask for a new plan.";

/** The document's text, or undefined when it is gone, too big, or its bytes are not the ones the digest names. */
export async function readVerifiedText(blobs: Pick<ObjectStorage, "get">, artifact: { objectKey: string; sha256: string }, maxBytes: number): Promise<{ text: string } | { missing: true } | { changed: true }> {
  const bytes = await blobs.get(artifact.objectKey, maxBytes);
  if (bytes === undefined) return { missing: true };
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) return { changed: true };
  return { text: new TextDecoder().decode(bytes) };
}
