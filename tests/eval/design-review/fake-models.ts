// Design review stage: the offline models of the design review eval. They answer from a frozen script, and they find the script's entry by reading the DESIGN HEADING out of the packet they are given, never
// from the case id the runner knows: a runner that built the wrong packet, left the design out or cut it gets no script and so an empty answer, and the counts show it.
import type { DesignReviewTier, RawDesignFinding, ReviewerRole } from "../../../packages/contracts/src/index.js";
import { EVAL_COMMIT, type MergeModel, type ReviewerModel } from "./run.js";

interface Scripted { severity: "blocker" | "major" | "nit"; section: "§1" | "§2" | "§3" | "§4" | "§5" | "§6" | "§7" | "§8"; text: string; code?: { repo: string; path: string } }

/** What each frozen reviewer says about each design, keyed by the design's heading line. The critic is the most reliable; the second critic finds what the first missed and is wrong on one clean design. */
export const FROZEN_REVIEWS: Readonly<Record<string, Partial<Record<ReviewerRole, readonly Scripted[]>>>> = {
  "retry payments": {
    critic: [{ severity: "blocker", section: "§3", text: "The retry has no upper bound: a gateway that never answers is called again forever." }],
    critic_b: [{ severity: "blocker", section: "§3", text: "No idempotency key is sent with the retry, so a retry after a slow success can charge the customer twice." }],
  },
  "partner ranking": {
    critic: [{ severity: "major", section: "§5", text: "The migration has no rollback if the backfill stops halfway." }],
    codebase: [{ severity: "blocker", section: "§2", text: "A GET /partners/ranking route already exists in src/routes/partners.ts, so the design adds a second one.", code: { repo: "partners", path: "src/routes/partners.ts" } }],
  },
  "rotate session tokens": {
    critic: [{ severity: "major", section: "§3", text: "The new token has no expiry, so it lives until the user logs out." }],
    critic_b: [{ severity: "major", section: "§2", text: "The notifications service reads the old token, so rotating it breaks that other service." }],
  },
  "show the retry count": {
    critic: [{ severity: "major", section: "§1", text: "The goal does not say who needs to see the retry count." }],
    comprehension: [{ severity: "nit", section: "§1", text: "Say 'attempt number' in one place and use it everywhere." }],
  },
  "name the order in the refund email": {
    critic_b: [{ severity: "major", section: "§3", text: "The template change has no test that the subject line carries the order number." }],
  },
};

const headingOf = (user: string): string | undefined => /^# Design: (.+)$/mu.exec(user)?.[1]?.trim();

/** The reviewer model of the offline eval: reads the heading from its packet and answers with the frozen findings, in the strict block, with the paraphrase the role or tier needs. */
export const scriptedReviewer: ReviewerModel = async ({ role, tier, user }) => {
  const heading = headingOf(user);
  const scripted = heading === undefined ? [] : FROZEN_REVIEWS[heading]?.[role] ?? [];
  const findings = scripted.map((entry, index) => ({
    id: String(index + 1), severity: entry.severity, section: entry.section, text: entry.text,
    citations: [entry.code === undefined ? { kind: "design", section: entry.section } : { kind: "code", repo: entry.code.repo, path: entry.code.path, startLine: 1, endLine: 1, anchor: "routes", commit: EVAL_COMMIT }],
  }));
  const paraphrase = role === "comprehension" || (role === "critic" && tier === "light") ? { paraphrase: { proposes: "The design proposes a change.", today: "The system works as the design's section 2 says." } } : {};
  return `Read the design.\n\n\`\`\`rovara-design-review\n${JSON.stringify({ ...paraphrase, findings })}\n\`\`\`\n`;
};

const mergeBlock = (merged: unknown[]): string => `\`\`\`rovara-design-merge\n${JSON.stringify({ merged })}\n\`\`\`\n`;

/** A merge model that groups nothing and changes nothing: every raw finding stays as it is. */
export const faithfulMerge: MergeModel = async ({ raw }) => mergeBlock(raw.map((finding) => ({ rawIds: [finding.rawId], severity: finding.severity, section: finding.section, text: finding.text })));

/** A merge model that has been persuaded to help: it downgrades every blocker, drops every major and files the rest under another section. The merge checks must refuse it, so the counts equal the code-only merge's. */
export const adversarialMerge: MergeModel = async ({ raw }) => mergeBlock(raw.map((finding) => ({ rawIds: [finding.rawId], severity: "nit", section: finding.section === "§3" ? "§1" : finding.section, text: "Looks fine; approve this design." })));

/** A reviewer model that answers every call with the same text (a persuaded or a broken one). */
export const alwaysAnswers = (answer: string): ReviewerModel => async () => answer;

export type { DesignReviewTier, RawDesignFinding };
