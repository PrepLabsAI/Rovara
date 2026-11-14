// Design review stage (DR11 UI): the words and rules the task page and the broker both read, so a person sees the same sentence wherever it appears. Browser-safe and pure.
// These moved here, unchanged, from broker/src/design-review/mode.ts (which re-exports them): the reason phrases, the skip rules and the sentence for a refused Skip. `DesignActionsViewSchema` is new:
// what the broker tells the task page about the Design first and Skip buttons for THIS caller (the page never works out who may skip; it shows what the broker decided).
import { z } from "zod";
import { DESIGN_REVIEW_RETRIES_MAX, isHighRiskDesign, type DesignReason, type DesignReviewSetting } from "./design-review.js";

const REASON_PHRASES: Readonly<Record<DesignReason, string>> = {
  new_api: "adds a new API",
  api_change: "changes an existing API",
  data_model: "changes the data model",
  cross_repo_or_service: "works across repositories or services",
  new_dependency: "adds a new dependency",
  auth: "touches sign-in or permissions",
  money: "touches money or billing",
  pii: "touches personal data",
  infrastructure: "changes infrastructure",
  small_change: "a small change inside one module",
  bug_fix: "a bug fix inside one module",
};

/** A fixed phrase for every reason code, so a line never carries a model's words for the reason itself. */
export const designReasonPhrase = (reason: DesignReason): string => REASON_PHRASES[reason];

/** Whether Skip may be used on this design, and if not, why. Shown beside the classification line ("Ask Priya to skip"). */
export type SkipVerdict = { allowed: true } | { allowed: false; because: "skip_off" | "needs_high_risk_approver" };

/** The skip rules. `allowSkip: false` means no Skip. A design with a high-risk reason can be skipped only by the high-risk approver. */
export function skipVerdict(setting: DesignReviewSetting, reasons: readonly DesignReason[], isHighRiskApprover: boolean): SkipVerdict {
  if (!setting.allowSkip) return { allowed: false, because: "skip_off" };
  if (isHighRiskDesign(reasons) && !isHighRiskApprover) return { allowed: false, because: "needs_high_risk_approver" };
  return { allowed: true };
}

/** A name or other text flattened to one line: control and hidden characters become spaces, runs of space become one, and the end is cut at a word with an ellipsis. */
export function plainOneLine(value: string, max: number): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, Math.max(1, max - 1)).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Why a person must ask someone else to skip, in plain words. `approverName` is the high-risk approver's display name, when known. */
export function skipRefusalText(verdict: Extract<SkipVerdict, { allowed: false }>, approverName?: string): string {
  if (verdict.because === "skip_off") return "This project does not allow skipping design review.";
  const name = approverName === undefined || approverName.trim() === "" ? "the design approver" : plainOneLine(approverName, 80);
  return `Ask ${name} to skip: this design is high risk.`;
}

export const DESIGN_ACTIONS_NAME_MAX = 80;

/**
 * What the task view says about the design review buttons for the person reading it (version 2 reads only). The broker works it out from the live setting and the caller's authority; the page shows it and the
 * broker re-checks on every press.
 * - `designFirst`: the "Design first" button is offered (the person may start a task, and no design review is on or finished for it).
 * - `skip`: absent when Skip does not apply (no review is waiting to start); `{ allowed: true }` shows the Skip button; `{ allowed: false }` shows the refusal sentence instead.
 * - `hint`: a Quick plan touches something that may need design (migrations, IAM, a package manifest's new entry, more than one repository). The page shows a chip and the Design first button; nothing starts by itself (Q4).
 */
export const DesignActionsViewSchema = z.object({
  designFirst: z.boolean(),
  skip: z.discriminatedUnion("allowed", [
    z.object({ allowed: z.literal(true) }).strict(),
    z.object({ allowed: z.literal(false), because: z.enum(["skip_off", "needs_high_risk_approver"]), approverName: z.string().min(1).max(DESIGN_ACTIONS_NAME_MAX).optional() }).strict(),
  ]).optional(),
  hint: z.boolean().optional(),
  /**
   * DR-KEY-1 (D): "Retry review" under a review that did not run (`designReviewRetryOffer`, the same rule as the route `POST .../design-review/retry`). Absent when the review is not one that did not run (a skip,
   * the re-review limit, a cap stop); `allowed` is false when its retries are used, or this person may not direct the task's work.
   */
  retry: z.object({ allowed: z.boolean(), retriesLeft: z.number().int().min(0).max(DESIGN_REVIEW_RETRIES_MAX) }).strict().optional(),
}).strict();
export type DesignActionsView = z.infer<typeof DesignActionsViewSchema>;

/**
 * A finding whose every citation is a source item (a tracker issue, an MCP item) and that cites neither the design nor the code (3.12 item 5). It is still counted as open; the card and the Design tab only LABEL it
 * "source-only", so the person knows it rests on outside text alone. The same test as `findingRestsOnSourceAlone` (design-review-block.ts), here so the browser reads it too; a finding with no citation at all is not source-only.
 */
export const designFindingIsSourceOnly = (finding: { citations: readonly { kind: string }[] }): boolean =>
  finding.citations.length > 0 && finding.citations.every((citation) => citation.kind === "source");

/** The label a source-only blocker carries. */
export const DESIGN_SOURCE_ONLY_LABEL = "source-only";
