// Design review stage: the one rule about approving a design that belongs to the design review itself, PURE. WHO may approve, in what capacity, with what sign-in and how many approvers is NOT decided here: in Code
// that is the approval gate and the `approvers` port (`core/decisions/approval-gate.ts`), for every surface, with the risk tier this module's neighbours work out (`risk.ts`, `core/decisions/risk-tier.ts`). Cloud's directory-based
// rules (the sole-owner exception, the high-risk approver group) are the hosted approvers adapter's, not the core's.
//
// What stays here: an open blocker allows approval only with a one-line reason, which goes on the pull request's Proof line.
import { openBlockerWords } from "./proof-line.js";

/** A blocker's one-line reason: one plain line of 1 to 200 characters, or undefined. Used as the Proof line's words, so it is cut and cleaned here, not later. */
export const BLOCKER_REASON_MAX = 200;
export function blockerReasonLine(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.normalize("NFC").trim();
  if (text.length === 0 || text.length > BLOCKER_REASON_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return undefined;
  return text;
}

export const DESIGN_REASON_REQUIRED_MESSAGE = "reason: say in one line why you approve with an open blocker";
export const DESIGN_REASON_NOT_ALLOWED_MESSAGE = "reason: a reason is taken only when a blocker is open";

/** Whether a design with `openBlockers` open may be approved with this reason. A reason with no open blocker is refused too, so it cannot be smuggled onto a clean approval. */
export function designApprovalReason(input: { openBlockers: number; blockerReason?: string | undefined }): { ok: true; proofReason?: string } | { ok: false; code: "reason_required" | "reason_not_allowed" } {
  if (input.openBlockers <= 0) return input.blockerReason === undefined ? { ok: true } : { ok: false, code: "reason_not_allowed" };
  const line = blockerReasonLine(input.blockerReason);
  return line === undefined ? { ok: false, code: "reason_required" } : { ok: true, proofReason: line };
}

/**
 * The words on the PR's Proof line when a design was approved with open blockers. Empty (undefined) when there were none. The approver's reason is a person's words on a line the repository's readers see, so it is made inert
 * (`inertLine`: no @ mention, link, issue reference or markup survives) by the same function the Proof section uses (money N11).
 */
export function designApprovalProofLine(openBlockers: number, reason: string | undefined): string | undefined {
  if (openBlockers <= 0 || reason === undefined) return undefined;
  return openBlockerWords(openBlockers, reason);
}
