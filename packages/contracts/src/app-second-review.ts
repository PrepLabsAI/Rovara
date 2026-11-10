// Second review: what the browser reads and sends for the company's settings screen for the second opinion: `/v1/app/org/second-review`. Strict shapes for what the app sends, readers (forward
// compatible) for what it reads. Words, ids, counts and model names; never a model's output. Browser-safe: nothing here imports a Node module (the modes are spelled out so this file does not pull in the review contract).
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

const Mode = z.enum(["off", "shadow", "on"]);
const ModelRef = z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict();
const ChangeId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);

export const SecondReviewPickerEntrySchema = z.object({
  model: ModelRef,
  /** The maker, a fixed word (`anthropic`, `openai`, `google`, ...; `other` when unknown). */
  company: z.string().min(1).max(64),
  /** The estimated cost of one review in US dollars; absent when the catalog has no price. */
  costUsd: z.number().min(0).optional(),
  /** False: the model is greyed out, and `ineligibleWhy` says why (`same-company` as the model that writes the code, or `company-unknown`). */
  eligible: z.boolean(),
  ineligibleWhy: z.enum(["same-company", "company-unknown"]).optional(),
  notes: z.array(z.string().max(200)).max(5),
  suggested: z.boolean(),
  suggestionReason: z.string().max(300).optional(),
  trackRecord: z.string().max(300).optional(),
}).strict();

export const SecondReviewTrackRecordViewSchema = z.object({
  model: z.string().max(256),
  days: z.number().int().min(0),
  firstAt: z.string().datetime().optional(),
  lastAt: z.string().datetime().optional(),
  reviews: z.number().int().min(0),
  findings: z.number().int().min(0),
  agreed: z.number().int().min(0),
  wrong: z.number().int().min(0),
  open: z.number().int().min(0),
  caughtMissedByFirst: z.number().int().min(0),
}).strict();
export type SecondReviewTrackRecordView = z.infer<typeof SecondReviewTrackRecordViewSchema>;

export const SecondReviewEvidenceViewSchema = z.object({
  model: ModelRef,
  /** Whether the evidence lets this model block NOW (recomputed by the server on every read). */
  holds: z.boolean(),
  verdict: z.object({ recordedAt: z.string().datetime(), withdrawn: z.boolean(), shadowDays: z.number().int().min(0), shadowFindings: z.number().int().min(0), shadowAgreed: z.number().int().min(0), shadowPassed: z.boolean() }).strict().nullable(),
  replay: z.object({ tasks: z.number().int().min(0), knownDefects: z.number().int().min(0), plantedBugs: z.number().int().min(0), baselineCaught: z.number().int().min(0), bothCaught: z.number().int().min(0), extraCatches: z.number().int().min(0), dismissedBlocking: z.number().int().min(0), passed: z.boolean(), failures: z.array(z.string().max(64)).max(10) }).strict().nullable(),
}).strict();

export const SecondReviewPendingViewSchema = z.object({
  changeId: ChangeId, scope: z.enum(["company", "project"]), project: z.string().max(100).optional(), from: Mode, to: Mode, proposedByYou: z.boolean(), expiresAt: z.string().datetime(),
}).strict();

export const SecondReviewStateSchema = z.object({
  /** The mode that applies to the project asked for (else the company). */
  mode: Mode,
  modes: z.object({ company: Mode, project: Mode.nullable(), effective: Mode }).strict(),
  /** False on the company page: the model that writes the code differs per task, so fit is only "its maker is known" and a task checks the real fit. */
  fitKnown: z.boolean().optional(),
  pendingLowering: z.boolean(),
  /** Only an admin is told which proposal it is, and whether it is theirs. */
  pending: z.array(SecondReviewPendingViewSchema).max(100).optional(),
  evidence: SecondReviewEvidenceViewSchema.nullable(),
  trackRecord: SecondReviewTrackRecordViewSchema.nullable(),
  /** The notice that the reviewer model stopped qualifying: the broker's fixed sentences; `seen` once an admin pressed "I've seen it". */
  notice: z.object({ key: z.string().regex(/^[a-f0-9]{32}$/u), code: z.string().max(64), seen: z.boolean(), lines: z.array(z.string().max(400)).min(1).max(6), createdAt: z.string().datetime() }).strict().nullable(),
  context: z.enum(["change_only", "same_as_first"]),
  alsoSees: z.string().max(300).nullable(),
  models: z.array(SecondReviewPickerEntrySchema).max(500),
  suggested: z.array(ModelRef).max(5),
  typicalReview: z.object({ input: z.number().int().min(0), output: z.number().int().min(0) }).strict(),
  choice: z.object({ models: z.array(ModelRef).max(2) }).strict().nullable(),
  projectNarrowing: z.object({ models: z.array(ModelRef).max(2) }).strict().nullable(),
  current: z.object({
    /** `company` (the company's choice), `default` (Rovara's top suggestion), `choice` (a choice that no longer qualifies) or `none`. */
    source: z.enum(["company", "default", "choice", "none"]),
    models: z.array(ModelRef).max(5),
    line: z.string().max(300).optional(),
    reason: z.string().max(64).optional(),
    skipped: z.array(z.object({ model: ModelRef, why: z.string().max(64) }).strict()).max(5).optional(),
  }).strict(),
}).strict();
export type SecondReviewState = z.infer<typeof SecondReviewStateSchema>;
export const SecondReviewStateReaderSchema = forwardReader(SecondReviewStateSchema);

/** What the app sends. The server decides who may; a refusal comes back in its own words. */
export const SecondReviewBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose"), primary: ModelRef, backup: ModelRef.optional() }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({ action: z.literal("context"), context: z.enum(["change_only", "same_as_first"]) }).strict(),
  z.object({ action: z.literal("mode"), scope: z.literal("company"), mode: Mode }).strict(),
  z.object({ action: z.literal("approve-mode"), changeId: ChangeId }).strict(),
  z.object({ action: z.literal("cancel-mode"), changeId: ChangeId }).strict(),
  z.object({ action: z.literal("withdraw"), model: ModelRef }).strict(),
  z.object({ action: z.literal("notice-seen"), key: z.string().regex(/^[a-f0-9]{32}$/u) }).strict(),
]);
export type SecondReviewBody = z.infer<typeof SecondReviewBodySchema>;
/** 200 `applied` / `cancelled`, or 202 `needs_approval` (a lowering waits for a different admin). Fields the server adds are kept. */
export const SecondReviewAnswerSchema = z.object({
  status: z.enum(["applied", "needs_approval", "cancelled"]),
  changeId: ChangeId.optional(),
  mode: Mode.optional(),
}).strict();
export const SecondReviewAnswerReaderSchema = forwardReader(SecondReviewAnswerSchema);

/** The task page's "I've seen it" for "Second review did not run" (the merge gate), sent to the task's acknowledge route. */
export const SecondReviewTaskViewSchema = z.object({ lines: z.array(z.string().max(400)).max(10), needsAcknowledgement: z.boolean(), acknowledged: z.boolean() }).strict();
export type SecondReviewTaskView = z.infer<typeof SecondReviewTaskViewSchema>;
