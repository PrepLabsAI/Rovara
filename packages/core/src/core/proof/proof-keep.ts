// Playbook P1: the Proof section when its inputs cannot be read in time. The description rewrite after a pushed PR-feedback fix runs under a short deadline (5 seconds), and the Proof section's reads (the
// approved plan, the test proof, the browser/API rows) must not be what abandons it. They are given a short time of their own; if they do not answer and the description already had a Proof section, that section's
// table describes the code before the fix, so its body becomes a one-line marker (see `PROOF_STALE_LINE`) and the rest of the block is brought up to date. The next full rewrite replaces the marker.
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";

/** The longest the Proof section's reads may take inside the description rewrite, whatever the rewrite's own limit is. */
export const PROOF_READ_MAX_MS = 1_500;

/** The Proof section's share of the rewrite's time limit: a third of it, at most `PROOF_READ_MAX_MS`. */
export function proofReadLimitMs(updateMaxMs: number): number {
  return Math.max(1, Math.min(PROOF_READ_MAX_MS, Math.floor(updateMaxMs / 3)));
}

/** `read`'s value if it answers within `ms`; `{ done: false }` when it is slower or fails (it is then left to finish or fail on its own, and its outcome is ignored). Never rejects. */
export async function withinTime<T>(ms: number, read: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read().then((value) => ({ done: true as const, value }), () => ({ done: false as const })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether `body`'s marked block has a Proof section (a "### Proof" heading line): false when there is none or the block is not exactly one pair of markers in order. Only the block is looked at: a heading a person
 * wrote outside it is not Rovara's section, and the rewrite leaves it alone.
 */
export function hadProofSection(body: string): boolean {
  const start = body.indexOf(ROVARA_STATUS_START);
  const end = body.indexOf(ROVARA_STATUS_END);
  if (start === -1 || end === -1 || end < start || body.indexOf(ROVARA_STATUS_START, start + 1) !== -1 || body.indexOf(ROVARA_STATUS_END, end + 1) !== -1) return false;
  return body.slice(start + ROVARA_STATUS_START.length, end).split(/\r?\n/u).includes("### Proof");
}
