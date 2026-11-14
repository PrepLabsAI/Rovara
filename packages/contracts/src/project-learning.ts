// v1.2 learning loop (slice 1): what a project's learning partition (`PROJECT_LEARNING#<project>`) holds and the API the screens use (design §3 and §6.2). Browser-safe: nothing
// here imports a Node module.
//
// Stored items are read with plain objects, which drop an unknown field, so a newer writer's addition never breaks an older reader during a rolling deploy. Every request body is
// strict, and every answer has a forward reader (`*ReaderSchema`): it keeps unknown fields and reads an enum value it doesn't know as "unknown".
//
// Text rules: correction text is plain text, at most 1,000 characters, and lives at most 180 days. A suggestion keeps `proposedText` and `dismissNote` only while it is
// open; every terminal state removes both and gives the suggestion its own 180-day `indexExpiresAt` (re-check gap 1).
import { z } from "zod";
import { StepIdSchema } from "./agent-recipe.js";
import { forwardReader } from "./forward-reader.js";

// ---- limits (design §3.2 and §3.4)

/** Corrections, dismissed patterns and terminal suggestions are kept this long, then deleted (TTL in named environments, the learning sweep elsewhere). */
export const LEARNING_RETENTION_DAYS = 180;
/** Suggestions that are not terminal (open, accepting, awaiting approval) per project. A 21st group waits. */
export const LEARNING_OPEN_SUGGESTIONS_MAX = 20;
/** Corrections a project keeps at once. Past that, capture is refused. */
export const LEARNING_LIVE_CORRECTIONS_MAX = 2000;
/** Automatic captures (send-back and PR comment) per project per UTC day, of which PR comments at most `LEARNING_DAILY_PR_MAX`. */
export const LEARNING_DAILY_AUTOMATIC_MAX = 100;
export const LEARNING_DAILY_PR_MAX = 50;
/** "Remember this": per person per project per window. */
export const LEARNING_REMEMBER_MAX = 30;
export const LEARNING_REMEMBER_WINDOW_SECONDS = 600;
/** A daily or rate item is dead weight soon after its window; the TTL deletes it. */
export const LEARNING_RATE_ITEM_SECONDS = 2 * 86_400;
export const LEARNING_TEXT_MAX = 1000;
export const LEARNING_SUGGESTION_SOURCES_MIN = 2;
export const LEARNING_SUGGESTION_SOURCES_MAX = 10;

// ---- shared pieces

/** A step of the project's process ("build", "plan"), or `*` for a rule that applies to the whole project. */
export const LEARNING_PROJECT_WIDE = "*" as const;
export const LearningStageSchema = z.union([StepIdSchema, z.literal(LEARNING_PROJECT_WIDE)]);
export type LearningStage = z.infer<typeof LearningStageSchema>;

export const LearningStandingSchema = z.enum(["member", "outsider"]);
export type LearningStanding = z.infer<typeof LearningStandingSchema>;

export const LEARNING_CORRECTION_SOURCES = ["comment", "send_back", "pr_comment"] as const;
export const LearningCorrectionSourceSchema = z.enum(LEARNING_CORRECTION_SOURCES);
export type LearningCorrectionSource = z.infer<typeof LearningCorrectionSourceSchema>;

export const LEARNING_SUGGESTION_STATUSES = ["open", "accepting", "awaiting_approval", "accepted", "dismissed", "withdrawn", "expired"] as const;
export const LearningSuggestionStatusSchema = z.enum(LEARNING_SUGGESTION_STATUSES);
export type LearningSuggestionStatus = z.infer<typeof LearningSuggestionStatusSchema>;
/** The states a suggestion never leaves (a dismissed one can be reopened by writing a new suggestion state, which is its own transition in B6). */
export const LEARNING_TERMINAL_STATUSES = ["accepted", "dismissed", "withdrawn", "expired"] as const;
export type LearningTerminalStatus = (typeof LEARNING_TERMINAL_STATUSES)[number];
export const isTerminalSuggestionStatus = (status: LearningSuggestionStatus): status is LearningTerminalStatus => (LEARNING_TERMINAL_STATUSES as readonly string[]).includes(status);

export const LEARNING_DISMISS_KINDS = ["wrong", "already_covered", "one_off", "other"] as const;
export const LearningDismissKindSchema = z.enum(LEARNING_DISMISS_KINDS);

const IsoInstantSchema = z.string().datetime();
const EpochSecondsSchema = z.number().int().positive();
const CountSchema = z.number().int().min(0);
const IdSchema = z.string().min(1).max(100);

// ---- stored items (design §3.1)

/** The serialization point for grouping. `openSuggestions` counts suggestions that are not terminal. */
export const LearningStateSchema = z.object({
  revision: CountSchema,
  /** The project META's `createdAt` the counters belong to; a project created again under the same name starts a new STATE. */
  projectCreatedAt: IsoInstantSchema,
  openSuggestions: CountSchema,
  liveCorrections: CountSchema,
  pendingRules: CountSchema,
  lastGroupedAt: IsoInstantSchema.optional(),
  /** When a capture last counted the stored corrections and found the project full (epoch ms): a full project is not recounted again for a few minutes. */
  recountedAt: z.number().int().positive().optional(),
});
export type LearningState = z.infer<typeof LearningStateSchema>;

export const LEARNING_PR_COMMENT_SETTINGS = ["on", "off"] as const;
export const LearningSettingsSchema = z.object({
  revision: CountSchema,
  prComments: z.enum(LEARNING_PR_COMMENT_SETTINGS),
  changedBy: z.string().min(1).max(100),
  changedAt: IsoInstantSchema,
  pendingProposalId: IdSchema.optional(),
  projectCreatedAt: IsoInstantSchema,
});
export type LearningSettings = z.infer<typeof LearningSettingsSchema>;

/** Where a correction came from. Each field is an id or a digest, never text. */
export const LearningSourceRefSchema = z.object({
  taskId: IdSchema.optional(),
  commentId: IdSchema.optional(),
  decisionRequestId: IdSchema.optional(),
  repositoryId: IdSchema.optional(),
  feedbackCommentId: IdSchema.optional(),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type LearningSourceRef = z.infer<typeof LearningSourceRefSchema>;
/** The same ref as a STORED item has it: a newer writer's extra field (v2 citations) is dropped, not refused. Request bodies keep `LearningSourceRefSchema`. */
export const LearningStoredSourceRefSchema = LearningSourceRefSchema.strip();

export const LearningCorrectionSchema = z.object({
  id: IdSchema,
  stage: LearningStageSchema,
  source: LearningCorrectionSourceSchema,
  sourceRef: LearningStoredSourceRefSchema,
  taskId: IdSchema,
  /** Removed when the correction's rule is accepted, and by person erase. */
  text: z.string().max(LEARNING_TEXT_MAX).optional(),
  /** Salted per-project token hashes, so similarity still works after the text is gone. */
  signature: z.array(z.string().max(64)).max(400),
  /** A developer id; `erased` after person erase. */
  author: z.string().min(1).max(100),
  githubUserId: z.string().min(1).max(40).optional(),
  standing: LearningStandingSchema,
  rememberedBy: z.string().min(1).max(100).optional(),
  linkedTo: IdSchema.optional(),
  groupedAt: IsoInstantSchema.optional(),
  repeatOf: IdSchema.optional(),
  suggestionId: IdSchema.optional(),
  createdAt: IsoInstantSchema,
  projectCreatedAt: IsoInstantSchema,
  indexExpiresAt: EpochSecondsSchema,
});
export type LearningCorrection = z.infer<typeof LearningCorrectionSchema>;

/** The one record per source, so a repeat of the same source finds its correction. */
export const LearningSourceItemSchema = z.object({
  correctionId: IdSchema,
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  projectCreatedAt: IsoInstantSchema,
  indexExpiresAt: EpochSecondsSchema,
});

const SuggestionBaseSchema = z.object({
  id: IdSchema,
  stage: LearningStageSchema,
  status: LearningSuggestionStatusSchema,
  correctionIds: z.array(IdSchema).min(LEARNING_SUGGESTION_SOURCES_MIN).max(LEARNING_SUGGESTION_SOURCES_MAX),
  allFromOnePerson: z.boolean(),
  /** Correction text: present only while the suggestion is not terminal. */
  proposedText: z.string().max(LEARNING_TEXT_MAX).optional(),
  signature: z.array(z.string().max(64)).max(400),
  lessSafe: z.boolean(),
  kinds: z.array(z.string().max(60)).max(10),
  overlaps: z.array(z.string().max(100)).max(20),
  revision: CountSchema,
  ruleId: IdSchema.optional(),
  decidedBy: z.string().min(1).max(100).optional(),
  decidedAt: IsoInstantSchema.optional(),
  dismissKind: LearningDismissKindSchema.optional(),
  /** Free text from the person who dismissed it: removed on every terminal state, never audited. */
  dismissNote: z.string().max(500).optional(),
  terminalAt: IsoInstantSchema.optional(),
  /** Terminal suggestions only: `terminalAt` + 180 days. */
  indexExpiresAt: EpochSecondsSchema.optional(),
  createdAt: IsoInstantSchema,
  projectCreatedAt: IsoInstantSchema,
});
export const LearningSuggestionSchema = SuggestionBaseSchema.superRefine((suggestion, context) => {
  const terminal = isTerminalSuggestionStatus(suggestion.status);
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (terminal) {
    if (suggestion.proposedText !== undefined) issue("proposedText", "a terminal suggestion keeps no correction text");
    if (suggestion.dismissNote !== undefined) issue("dismissNote", "a terminal suggestion keeps no dismiss note");
    if (suggestion.terminalAt === undefined) issue("terminalAt", "a terminal suggestion has the time it ended");
    if (suggestion.indexExpiresAt === undefined) issue("indexExpiresAt", "a terminal suggestion expires");
  } else if (suggestion.terminalAt !== undefined || suggestion.indexExpiresAt !== undefined) {
    issue("terminalAt", "only a terminal suggestion has an end time and an expiry");
  }
});
export type LearningSuggestion = z.infer<typeof LearningSuggestionSchema>;

export const LEARNING_RULE_STATUSES = ["pending", "awaiting_approval", "active", "not_applied", "removed"] as const;
export const LearningRuleSchema = z.object({
  id: IdSchema,
  suggestionId: IdSchema,
  stage: LearningStageSchema,
  /** The text the published version already holds. */
  text: z.string().min(1).max(LEARNING_TEXT_MAX),
  processAgentId: IdSchema,
  requestId: IdSchema,
  approvalId: IdSchema.optional(),
  status: z.enum(LEARNING_RULE_STATUSES),
  processVersion: z.number().int().positive().optional(),
  removedInVersion: z.number().int().positive().optional(),
  /** B6: when the accept started (a rule stuck in `pending` is resolved after 10 minutes), who asked, whether the text was edited and whether the publish waited for a person (audit facts at settlement). */
  createdAt: IsoInstantSchema.optional(),
  requestedBy: z.string().min(1).max(100).optional(),
  edited: z.boolean().optional(),
  lessSafe: z.boolean().optional(),
  /** B6: Remove waited for a person; the rule stays `active` until that approval ends. */
  removalApprovalId: IdSchema.optional(),
  projectCreatedAt: IsoInstantSchema,
});
export type LearningRule = z.infer<typeof LearningRuleSchema>;

export const LearningDismissedSchema = z.object({
  signature: z.array(z.string().max(64)).max(400),
  suggestionId: IdSchema,
  dismissedAt: IsoInstantSchema,
  projectCreatedAt: IsoInstantSchema,
  indexExpiresAt: EpochSecondsSchema,
});

// ---- the company-wide walk (design §3.1, last paragraph)

export const LEARNING_WALK_KINDS = ["close", "sweep"] as const;
/** `close`, `sweep`, or `erase#<developerId>`. Holds no text. */
export const LearningWalkKindSchema = z.union([z.enum(LEARNING_WALK_KINDS), z.string().regex(/^erase#[^#\s]{1,100}$/)]);
export type LearningWalkKind = z.infer<typeof LearningWalkKindSchema>;
export const LearningWalkSchema = z.object({
  status: z.enum(["running", "done"]),
  /** The catalog cursor: the last project name finished. */
  afterProject: z.string().min(1).max(63).optional(),
  startedAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  projectsDone: CountSchema,
});
export type LearningWalk = z.infer<typeof LearningWalkSchema>;

// ---- the company's master "suggestions" switch (v1.2 switch contract)

export const LEARNING_SUGGESTION_SWITCH = ["on", "off"] as const;
export const LearningSuggestionSwitchSchema = z.enum(LEARNING_SUGGESTION_SWITCH);
export type LearningSuggestionSwitch = z.infer<typeof LearningSuggestionSwitchSchema>;
/** Where the effective value came from: the company's own record, or the install-wide default (deployment config) while the company never chose. */
export const LEARNING_SUGGESTION_SWITCH_SOURCES = ["company", "install_default"] as const;

/** The company's record (`ORG#<org>` / `LEARNING_SETTINGS`). Read as a plain object, so a newer writer's extra field is dropped, not refused. */
export const LearningCompanySettingsSchema = z.object({
  revision: z.number().int().min(1),
  suggestions: LearningSuggestionSwitchSchema,
  // Optional on read: a record whose value and revision read is the company's choice even if these are missing, so it never blocks the next write.
  changedBy: z.string().min(1).max(100).optional(),
  changedAt: z.string().datetime().optional(),
});
export type LearningCompanySettings = z.infer<typeof LearningCompanySettingsSchema>;

// ---- API (design §6.2): request bodies are strict; answers have a forward reader

const RequestIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().min(0);

/** `POST /review/<task>/task/api/comments/<id>/remember` and `/forget` (the task page). */
export const LearningTaskPageBodySchema = z.object({}).strict();
/** `POST /v1/app/projects/{p}/learning/remember`. */
export const LearningRememberBodySchema = z.object({ requestId: RequestIdSchema, taskId: IdSchema, commentId: IdSchema }).strict();
export const LearningForgetBodySchema = z.object({ requestId: RequestIdSchema }).strict();
export const LearningAcceptBodySchema = z.object({ requestId: RequestIdSchema, expectedRevision: RevisionSchema, stage: LearningStageSchema, text: z.string().min(1).max(LEARNING_TEXT_MAX) }).strict();
export const LearningDismissBodySchema = z.object({ expectedRevision: RevisionSchema, dismissKind: LearningDismissKindSchema, note: z.string().max(500).optional() }).strict();
export const LearningReopenBodySchema = z.object({}).strict();
export const LearningRuleRemoveBodySchema = z.object({ requestId: RequestIdSchema }).strict();
export const LearningSettingsBodySchema = z.object({ expectedRevision: RevisionSchema, prComments: z.enum(LEARNING_PR_COMMENT_SETTINGS) }).strict();
/** `PUT /v1/app/org/learning-settings`: owner or admin of the company, a live browser session. `expectedRevision` is 0 while the company has no record. */
export const LearningCompanySettingsBodySchema = z.object({ expectedRevision: RevisionSchema, suggestions: LearningSuggestionSwitchSchema }).strict();
export const LearningProposalDecisionBodySchema = z.object({ decision: z.enum(["approve", "decline"]), soleOwnerAcknowledged: z.boolean().optional() }).strict();

/**
 * The task page's comment listing (`GET /review/<task>/task/api/comments`), for a person with standing in the project only: whether a comment is already remembered, and its correction. Both
 * this and `canRemember` are absent for everyone else, and when the read fails or is slow. `correctionId` is present only when `remembered` is true.
 */
export const TaskCommentLearningSchema = z.object({ remembered: z.boolean(), correctionId: IdSchema.optional() }).strict();
export type TaskCommentLearning = z.infer<typeof TaskCommentLearningSchema>;

export const LearningCorrectionViewSchema = z.object({ id: IdSchema, standing: LearningStandingSchema, stage: LearningStageSchema }).strict();
export const LearningRememberAnswerSchema = z.object({ correction: LearningCorrectionViewSchema }).strict();
export const LearningForgetAnswerSchema = z.object({ forgotten: z.literal(true) }).strict();

export const LearningSettingsViewSchema = z.object({
  prComments: z.enum(LEARNING_PR_COMMENT_SETTINGS),
  locked: z.boolean(),
  lockedBy: z.literal("company").optional(),
  pendingProposal: z.object({ id: IdSchema, expiresAt: IsoInstantSchema.optional() }).strict().optional(),
  revision: RevisionSchema.optional(),
}).strict();

export const LearningSuggestionSourceViewSchema = z.object({
  kind: LearningCorrectionSourceSchema,
  /** Absent (with `at`, `label` and `href`) for a source whose author was erased, and for a caller who may not read the project's words: they get the fixed phrase and the count only. */
  taskId: IdSchema.optional(),
  /** The member correction's text, plain (what the card shows), or a fixed phrase for a caller who may not read it. */
  label: z.string().max(LEARNING_TEXT_MAX).optional(),
  at: IsoInstantSchema.optional(),
  standing: LearningStandingSchema,
  href: z.string().max(500).optional(),
}).strict();
export const LearningSuggestionViewSchema = z.object({
  id: IdSchema,
  stage: LearningStageSchema,
  status: LearningSuggestionStatusSchema,
  proposedText: z.string().max(LEARNING_TEXT_MAX).optional(),
  allFromOnePerson: z.boolean(),
  lessSafe: z.boolean(),
  lessSafeWords: z.array(z.string().max(60)).max(10),
  overlaps: z.array(z.string().max(200)).max(20),
  sources: z.array(LearningSuggestionSourceViewSchema).max(LEARNING_SUGGESTION_SOURCES_MAX),
  revision: RevisionSchema,
  /** How many sources the suggestion still has (every caller gets it, including those who see no source detail). */
  sourceCount: z.number().int().min(0).max(LEARNING_SUGGESTION_SOURCES_MAX).optional(),
  /** Whether THIS caller may accept this suggestion: a live member with How we work edit rights (being an author grants nothing). Computed with the rule Accept itself uses. */
  canDecide: z.boolean().optional(),
}).strict();
export const LearningRuleViewSchema = z.object({
  id: IdSchema,
  stage: LearningStageSchema,
  text: z.string().max(LEARNING_TEXT_MAX),
  status: z.enum(LEARNING_RULE_STATUSES),
  processVersion: z.number().int().positive().optional(),
}).strict();
export const LearningDismissedViewSchema = z.object({ id: IdSchema, stage: LearningStageSchema, dismissedAt: IsoInstantSchema, dismissKind: LearningDismissKindSchema.optional() }).strict();

/** What the screens show about the master switch: `collecting` carries the project's live corrections. An absent field (an older server) means `on`. */
export const LearningSuggestionsStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("on") }).strict(),
  z.object({ state: z.literal("collecting"), corrections: CountSchema }).strict(),
]);
export type LearningSuggestionsState = z.infer<typeof LearningSuggestionsStateSchema>;

/** `GET` and `PUT /v1/app/org/learning-settings`. `revision` is 0 while `source` is `install_default`. */
export const LearningCompanySettingsAnswerSchema = z.object({
  suggestions: LearningSuggestionSwitchSchema,
  source: z.enum(LEARNING_SUGGESTION_SWITCH_SOURCES),
  revision: RevisionSchema,
  canChange: z.boolean(),
}).strict();
export type LearningCompanySettingsAnswer = z.infer<typeof LearningCompanySettingsAnswerSchema>;

/** `GET /v1/app/projects/{p}/learning`. */
export const LearningViewAnswerSchema = z.object({
  settings: LearningSettingsViewSchema,
  suggestions: z.array(LearningSuggestionViewSchema).max(LEARNING_OPEN_SUGGESTIONS_MAX),
  dismissed: z.array(LearningDismissedViewSchema).max(200),
  rules: z.array(LearningRuleViewSchema).max(500),
  skippedUnlinked: CountSchema,
  canDecide: z.boolean(),
  /** The company's master switch for this project's view (optional: an absent field means `on`). While `collecting`, `suggestions` above is empty. */
  suggestionsState: LearningSuggestionsStateSchema.optional(),
  /** Present only when a list was cut at its limit (the read is bounded): which lists. */
  truncated: z.array(z.enum(["suggestions", "dismissed", "rules"])).max(3).optional(),
}).strict();
export type LearningViewAnswer = z.infer<typeof LearningViewAnswerSchema>;

export const LearningAcceptAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("published"), version: z.number().int().positive() }).strict(),
  // `status` and `changes` are what a hand publish's 202 carries too (added: older readers ignore them).
  z.object({ outcome: z.literal("awaiting_approval"), confirmUrl: z.string().max(1000), status: z.literal("NEEDS_CONFIRMATION").optional(), changes: z.array(z.string().max(1000)).max(100).optional() }).strict(),
]);
// What the dismiss route answers: the suggestion's id and its new status. The screens read the list again for the rest.
export const LearningDismissAnswerSchema = z.object({ suggestion: z.object({ id: z.string().min(1).max(100), status: z.literal("dismissed") }).strict() }).strict();
export const LearningReopenAnswerSchema = z.object({ reopened: z.literal(true) }).strict();
export const LearningRuleRemoveAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("published"), version: z.number().int().positive() }).strict(),
  // `status` and `changes` are what a hand publish's 202 carries too (added: older readers ignore them).
  z.object({ outcome: z.literal("awaiting_approval"), confirmUrl: z.string().max(1000), status: z.literal("NEEDS_CONFIRMATION").optional(), changes: z.array(z.string().max(1000)).max(100).optional() }).strict(),
  z.object({ outcome: z.literal("needs_editor"), stage: LearningStageSchema }).strict(),
]);
export const LearningSettingsAnswerSchema = z.discriminatedUnion("applied", [
  z.object({ applied: z.literal(true), settings: LearningSettingsViewSchema }).strict(),
  z.object({ applied: z.literal(false), proposalId: IdSchema }).strict(),
]);
export const LearningProposalDecisionAnswerSchema = z.object({ settings: LearningSettingsViewSchema }).strict();

export const LearningRememberAnswerReaderSchema = forwardReader(LearningRememberAnswerSchema);
export const LearningForgetAnswerReaderSchema = forwardReader(LearningForgetAnswerSchema);
export const LearningViewAnswerReaderSchema = forwardReader(LearningViewAnswerSchema);
export const LearningAcceptAnswerReaderSchema = forwardReader(LearningAcceptAnswerSchema);
export const LearningDismissAnswerReaderSchema = forwardReader(LearningDismissAnswerSchema);
export const LearningReopenAnswerReaderSchema = forwardReader(LearningReopenAnswerSchema);
export const LearningRuleRemoveAnswerReaderSchema = forwardReader(LearningRuleRemoveAnswerSchema);
export const LearningSettingsAnswerReaderSchema = forwardReader(LearningSettingsAnswerSchema);
export const LearningCompanySettingsAnswerReaderSchema = forwardReader(LearningCompanySettingsAnswerSchema);
export const LearningProposalDecisionAnswerReaderSchema = forwardReader(LearningProposalDecisionAnswerSchema);
