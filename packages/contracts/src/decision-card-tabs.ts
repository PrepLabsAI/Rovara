// Decisions D1/D2 (owner Q1, accepted): on the Full path the requirements and the design read as ONE card with two tabs. It still records two approvals, one per document, so the Full
// contract and the audit do not change. The card itself is the ordinary `DecisionCard` (kind `approve_requirements`); the tabs travel beside it, keyed by the card's id, so the card
// contract is untouched. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { DecisionCardIdSchema, DecisionCardReaderSchema, DecisionCardSchema, DECISION_CARDS_MAX, EvidenceChipSchema } from "./decision-cards.js";

export const DECISION_TAB_IDS = ["requirements", "design"] as const;
export const DecisionTabIdSchema = z.enum(DECISION_TAB_IDS);
export type DecisionTabId = z.infer<typeof DecisionTabIdSchema>;

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");

export const DecisionTabSchema = z
  .object({ id: DecisionTabIdSchema, title: line(60), summary: line(300), evidence: z.array(EvidenceChipSchema).max(6), approved: z.boolean() })
  .strict();
export type DecisionTab = z.infer<typeof DecisionTabSchema>;

/** The tabs of a card, in reading order: requirements, then design. A card has both or none. */
export const DecisionTabsSchema = z
  .array(DecisionTabSchema)
  .length(2)
  .refine((tabs) => tabs[0]?.id === "requirements" && tabs[1]?.id === "design", { message: "the tabs are requirements, then design" });

export const DecisionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** A group of evidence lines a medium card shows in its panel: what the person must see that is NOT already on the front (names, not counts). `tab` names the document on a card with tabs. */
export const DecisionDetailGroupSchema = z
  .object({ tab: DecisionTabIdSchema.optional(), title: line(60), lines: z.array(line(200)).min(1).max(20) })
  .strict();
export type DecisionDetailGroup = z.infer<typeof DecisionDetailGroupSchema>;
export const DECISION_DETAIL_GROUPS_MAX = 12;
export const DecisionDetailGroupsSchema = z.array(DecisionDetailGroupSchema).max(DECISION_DETAIL_GROUPS_MAX);

/** The most comments one decision includes and the longest note: the workflow decision's own limits (`DECISION_COMMENTS_MAX`, `PAGE_NOTE_MAX_CHARS` in task-comments.ts, which is not browser-safe). */
export const DECISION_PLAN_COMMENTS_MAX = 25;
export const DECISION_PLAN_NOTE_MAX = 500;
export const DECISION_PLAN_QUESTIONS_MAX = 20;
export const DECISION_PLAN_CHECKS_MAX = 20;
/** OWNER DECISION 18: the most summary lines a document card shows. */
export const DECISION_PLAN_SUMMARY_LINES_MAX = 5;
/** OWNER DECISION 7: the card kinds that carry the document's own choices (its questions, the optional checks, the open comments, a note), as the old review page sent them with a decision. */
export const DECISION_PLAN_CHOICE_KINDS: readonly string[] = ["approve_plan", "approve_requirements", "approve_design"];
/** The card kinds whose Approve chooses optional checks: the coding plan only (the workflow decision's rule). */
export const DECISION_OPTIONAL_CHECK_KINDS: readonly string[] = ["approve_plan"];

/** One answer to a question of the document: the option chosen and whether the person opened the question (the old page's `opened`). */
export const DecisionPlanAnswerSchema = z.object({ decisionId: z.string().min(1).max(4), optionId: z.string().min(1).max(31), opened: z.boolean() }).strict();
export type DecisionPlanAnswer = z.infer<typeof DecisionPlanAnswerSchema>;
const planAnswers = z.array(DecisionPlanAnswerSchema).max(DECISION_PLAN_QUESTIONS_MAX).refine((answers) => new Set(answers.map((answer) => answer.decisionId)).size === answers.length, "each question once");
const commentIds = z.array(z.string().uuid()).max(DECISION_PLAN_COMMENTS_MAX).refine((ids) => new Set(ids).size === ids.length, "each comment once");

/**
 * OWNER DECISION 7: what a requirements or coding plan card offers beside Approve and Request changes, read from the document the card was drawn from (its questions, each with the options and AgentX's
 * recommendation), the task's optional checks (the coding plan only) and the person comments still open on the document. The workflow decision checks every answer, check and comment again.
 */
export const DecisionPlanChoicesSchema = z.object({
  questions: z.array(z.object({
    id: z.string().min(1).max(4), question: line(500), recommended: z.string().min(1).max(31),
    options: z.array(z.object({ id: z.string().min(1).max(31), label: line(300) }).strict()).min(1).max(12),
    /** The suggestions people who may comment made on this question (on the old review page or in Slack), with their names, for the owner who decides. */
    suggested: z.array(z.object({ optionId: z.string().min(1).max(31), name: line(80) }).strict()).max(10).optional(),
  }).strict()).max(DECISION_PLAN_QUESTIONS_MAX),
  optionalChecks: z.array(z.object({ id: z.string().min(1).max(64), label: line(200), selected: z.boolean() }).strict()).max(DECISION_PLAN_CHECKS_MAX),
  openComments: z.array(z.object({ id: z.string().uuid(), excerpt: line(200) }).strict()).max(DECISION_PLAN_COMMENTS_MAX),
  /**
   * OWNER DECISION 18: the key facts on the card, worked out by the server from the document itself (no model call; the same document gives the same lines): what is needed, and what Rovara will do
   * in 1 to 5 lines (3 to 5 whenever the document has that many points). Absent when the document cannot be read.
   */
  summary: z.object({ needed: line(300), lines: z.array(line(200)).min(1).max(DECISION_PLAN_SUMMARY_LINES_MAX) }).strict().optional(),
  /** OWNER DECISION 18: how many person comments are open on this version (all of them; `openComments` lists at most 25). */
  openCommentCount: z.number().int().min(0).max(100_000).optional(),
}).strict();
export type DecisionPlanChoices = z.infer<typeof DecisionPlanChoicesSchema>;

/** Why an approve body's plan fields are refused for a card of this kind, or undefined (as `approveReasonProblem`: never dropped, never smuggled onto another kind). */
export function planChoicesProblem(itemKind: string, body: { answers?: unknown; selectedOptionalCheckIds?: unknown; includedCommentIds?: unknown; note?: unknown }): string | undefined {
  const field = (["answers", "selectedOptionalCheckIds", "includedCommentIds", "note"] as const).find((key) => body[key] !== undefined);
  if (field === undefined) return undefined;
  if (!DECISION_PLAN_CHOICE_KINDS.includes(itemKind)) return `${field}: this card takes no ${field}`;
  if (body.selectedOptionalCheckIds !== undefined && !DECISION_OPTIONAL_CHECK_KINDS.includes(itemKind)) return "selectedOptionalCheckIds: only a coding plan has optional checks";
  return undefined;
}


/**
 * `GET /v1/app/decisions`: the cards, the tabs of the cards that have them, the evidence detail of each, and a `digests` entry per card: the digest of what the server is showing NOW (the card,
 * its tabs and the content version behind it: the document version, the pull request head). A client sends it back as `shownDigest` with `evidence-opened` and `approve`, so a person can only
 * open or approve what they were shown. `dropped` counts pending items that could not become a safe card; they are decided on their own page.
 */
export const DecisionCardsViewSchema = z
  .object({
    cards: z.array(DecisionCardSchema).max(DECISION_CARDS_MAX),
    total: z.number().int().min(0),
    tabs: z.record(DecisionCardIdSchema, DecisionTabsSchema),
    details: z.record(DecisionCardIdSchema, DecisionDetailGroupsSchema),
    digests: z.record(DecisionCardIdSchema, DecisionDigestSchema),
    dropped: z.number().int().min(0).max(100_000),
    /** High-risk cards whose source gave no confirmation page: they open the item's own page and make no fresh-sign-in claim. A source should supply one; this makes a missing one visible. */
    unconfirmed: z.array(DecisionCardIdSchema).max(DECISION_CARDS_MAX).optional(),
    /** OWNER DECISION 7: the questions, optional checks and open comments of the requirements and coding plan cards that have any (`DecisionPlanChoicesSchema`). */
    choices: z.record(DecisionCardIdSchema, DecisionPlanChoicesSchema).optional(),
  })
  .strict()
  .refine((view) => [...Object.keys(view.tabs), ...Object.keys(view.details), ...Object.keys(view.choices ?? {})].every((id) => view.cards.some((card) => card.id === id)), { message: "tabs and details belong to listed cards", path: ["tabs"] })
  .refine((view) => view.cards.every((card) => view.digests[card.id] !== undefined), { message: "every card has a digest", path: ["digests"] });
export type DecisionCardsView = z.infer<typeof DecisionCardsViewSchema>;

/**
 * What a client reads: a card a newer server changed still reads (the card reader keeps unknown fields and reads an unknown kind as "unknown"), and each card's tabs and details are checked one
 * by one by the client, so one bad entry hides one card's extras and not the list. NOTE: the reader drops the card schema's refinements, so a client must never rely on them (see `DecisionCard.tsx`).
 */
export const DecisionCardsViewReaderSchema = z.looseObject({
  cards: z.array(DecisionCardReaderSchema).max(DECISION_CARDS_MAX), total: z.number().int().min(0),
  tabs: z.record(z.string(), z.unknown()).optional(), details: z.record(z.string(), z.unknown()).optional(), digests: z.record(z.string(), z.unknown()).optional(), dropped: z.number().int().min(0).optional(),
  choices: z.record(z.string(), z.unknown()).optional(),
});

/** `POST .../evidence-opened`: the digest the person was shown. */
export const DecisionOpenedBodySchema = z.object({ requestId: z.string().uuid(), shownDigest: DecisionDigestSchema }).strict();
export type DecisionOpenedBody = z.infer<typeof DecisionOpenedBodySchema>;

/** The longest one-line reason a person gives for approving a design that still has an open blocker (owner Q8). */
export const DECISION_APPROVE_REASON_MAX = 200;

/**
 * `POST /v1/app/decisions/{kind}/{subject}/approve`. `tab` is required on a card with tabs (one approval per tab) and refused on one without; `shownDigest` is what the person was shown. Not bulk: one card, one tab, one
 * request. `reason` is one plain line, accepted ONLY on an `approve_design` card (`approveReasonProblem`: the route refuses it on every other kind), and there only where a blocker is open (the design handler refuses it otherwise) and REQUIRED there (Q8). It is
 * put on the PR's Proof line, so it is bounded and has no control or hidden characters here, and is cleaned again where it is used.
 */
export const DECISION_REASON_ELSEWHERE_MESSAGE = "reason: this card takes no reason";
/** The card kinds that take a `reason` on approve. Every other kind refuses it (a reason is never smuggled onto a clean approval, and never silently dropped). */
export const DECISION_REASON_KINDS: readonly string[] = ["approve_design"];
/** Why an approve body's `reason` is refused for a card of this kind, or undefined. The route calls it; the design handler decides on its own whether a blocker is open. */
export function approveReasonProblem(itemKind: string, reason: string | undefined): string | undefined {
  return reason === undefined || DECISION_REASON_KINDS.includes(itemKind) ? undefined : DECISION_REASON_ELSEWHERE_MESSAGE;
}
export const DecisionApproveBodySchema = z.object({
  requestId: z.string().uuid(), shownDigest: DecisionDigestSchema, tab: DecisionTabIdSchema.optional(), reason: line(DECISION_APPROVE_REASON_MAX).optional(),
  /** A coding plan's card only: the run limit the card showed and the person ticked (slice 2). The broker refuses an approval that would set another, and one that raises the limit without it. */
  acknowledgedRunLimitUsd: z.number().min(0).max(100_000).optional(),
  /** OWNER DECISION 7 (requirements and coding plan cards only): the person's answers to the document's questions (an unanswered one takes AgentX's answer). */
  answers: planAnswers.optional(),
  /** OWNER DECISION 7 (coding plan only): the optional checks to run. Absent: the plan's own selection. */
  selectedOptionalCheckIds: z.array(z.string().min(1).max(64)).max(DECISION_PLAN_CHECKS_MAX).refine((ids) => new Set(ids).size === ids.length, "each check once").optional(),
  /** OWNER DECISION 7: the open comments sent with the approval. Absent: the open comments, oldest first, as Slack's Approve takes them. */
  includedCommentIds: commentIds.optional(),
  /** OWNER DECISION 7: a free note for AgentX, sent with the approval. */
  note: z.string().trim().min(1).max(DECISION_PLAN_NOTE_MAX).refine((text) => /^[^\p{Cc}\p{Cf}]*$/u.test(text.replaceAll("\n", "")), "plain text (line breaks are kept)").optional(),
}).strict();
export type DecisionApproveBody = z.infer<typeof DecisionApproveBodySchema>;
/** The card kinds that take `acknowledgedRunLimitUsd` on approve; every other kind refuses it. */
export const DECISION_RUN_LIMIT_KINDS: readonly string[] = ["approve_plan"];

/** The longest reason a Request changes carries: the workflow decision's own limit. */
export const DECISION_CHANGES_REASON_MAX = 500;
/**
 * `POST /v1/app/decisions/{kind}/{subject}/request-changes` (slice 2): the document goes back to the planner with the person's reason, through the same workflow decision (REQUEST_CHANGES) Slack and the task page
 * use, with the same authority. `shownDigest` is what the person was shown: a changed card is refused as stale.
 */
export const DecisionRequestChangesBodySchema = z.object({
  requestId: z.string().uuid(), shownDigest: DecisionDigestSchema, reason: z.string().trim().min(1).max(DECISION_CHANGES_REASON_MAX).regex(/^[^\p{Cc}\p{Cf}]*$/u, "plain text"),
  /** OWNER DECISION 7 (requirements and coding plan cards only): the open comments sent back with the reason (the review comments). Absent: none, as Slack's Request changes. */
  includedCommentIds: commentIds.optional(),
}).strict();
export type DecisionRequestChangesBody = z.infer<typeof DecisionRequestChangesBodySchema>;

/** What an approve or a reject answers when it was decided: the card, what was recorded and, on a card with tabs, which documents are still waiting. */
export const DecisionAnsweredSchema = z
  .object({
    cardId: DecisionCardIdSchema,
    outcome: z.enum(["approved", "rejected"]),
    tab: DecisionTabIdSchema.optional(),
    remainingTabs: z.array(DecisionTabIdSchema).max(2),
  })
  .strict();
export type DecisionAnswered = z.infer<typeof DecisionAnsweredSchema>;

/** `202`: the existing endpoint did not decide; the person decides on its confirmation page (a fresh sign-in). Nothing was approved, so no surface may say "Approved". */
export const DECISION_MERGING_MAX = 20;
/** What a merge press is about to merge, so the app can ask "Merge #N into <branch>?" before the person goes on to the confirmation page. Present only on a merge. */
export const DecisionMergingSchema = z.array(z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), baseBranch: z.string().min(1).max(255) }).strict()).min(1).max(DECISION_MERGING_MAX);
export const DecisionNeedsConfirmationSchema = z
  .object({ cardId: DecisionCardIdSchema, outcome: z.literal("needs_confirmation"), confirmUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "an https link"), merging: DecisionMergingSchema.optional() })
  .strict();
export type DecisionNeedsConfirmation = z.infer<typeof DecisionNeedsConfirmationSchema>;

/** What an approve or a reject answers: decided, or waiting on a confirmation page. */
export const DecisionOutcomeSchema = z.union([DecisionAnsweredSchema, DecisionNeedsConfirmationSchema]);
/** What the app reads: a field a newer server adds to either answer is kept, never a reason to refuse the answer (an older bundle's strict reader once refused `merging`). */
export const DecisionOutcomeReaderSchema = z.union([
  z.looseObject({ cardId: DecisionCardIdSchema, outcome: z.enum(["approved", "rejected"]), tab: DecisionTabIdSchema.optional(), remainingTabs: z.array(DecisionTabIdSchema).max(2) }),
  z.looseObject({ cardId: DecisionCardIdSchema, outcome: z.literal("needs_confirmation"), confirmUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "an https link"), merging: DecisionMergingSchema.optional() }),
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** The fixed reasons a performer refuses, and what each means to the person. */
export const DECISION_REFUSAL_REASONS = ["forbidden", "stale", "second_person_required", "not_ready", "unsupported"] as const;
export type DecisionRefusalReason = (typeof DECISION_REFUSAL_REASONS)[number];

/** What `evidence-opened` answers. `recorded` is false for a card that needs no such record (a low-risk one). */
export const DecisionEvidenceOpenedAnswerSchema = z.object({ cardId: DecisionCardIdSchema, opened: z.literal(true), recorded: z.boolean() }).strict();
export type DecisionEvidenceOpenedAnswer = z.infer<typeof DecisionEvidenceOpenedAnswerSchema>;
