// The seams of the learning lane. The record core (R-lanes), storage and ingest are built in parallel; each interface here is what this
// lane needs from them, with an in-memory stand-in in the tests. Nothing here talks to a provider.
import type { LessonStage, LessonsPauseCode, TransactItem } from "@agentx/contracts";
import type { TaskFailureTally } from "./pause.js";
import type { Lesson, LessonAuditAction, IdentitySet } from "./types.js";

export type Clock = () => number;

/**
 * A model call for the learning pipeline (reflector, curator judge, outcome judge). It takes text and returns text: there is no field for tools, so a
 * pipeline model cannot act. The caller validates the text against a schema and drops it on any failure.
 * `costUsd` is an UPPER BOUND on what the call cost (the cap its key holds), not a measurement: the real figure is settled later from the proxy.
 */
export interface PipelineModel {
  /**
   * What a call of this size would hold, before it is made (lessons in production): the cheapest suitable model's worst-case price for this prompt and `maxOutputTokens`, or the fixed code of why learning
   * cannot run (no provider, every model forbidden, the budgets cannot cover it, the cheapest model costs too much). Reads and writes nothing of the call's. Absent: the caller uses its own fixed estimate.
   */
  quote?(request: { purpose: "reflect" | "judge" | "distill" | "outcome"; system: string; user: string; maxOutputTokens: number; workspaceId: string; project?: string; /** The most one call may hold (the edition's per-task cap): the model chooses among the ones whose hold fits, and refuses with `cost_too_high` only when none does. Absent: no cap of its own. */ maxHoldUsd?: number }): Promise<{ ok: true; usd: number } | { ok: false; code: LessonsPauseCode }>;
  complete(request: { purpose: "reflect" | "judge" | "distill" | "outcome"; system: string; user: string; maxOutputTokens: number; workspaceId: string; /** The project the call is for: the company's own model route is chosen per project. A model that routes per project refuses a call without one. */ project?: string; /** The most one call may hold (the edition's per-task cap), as in `quote`. */ maxHoldUsd?: number; /** The most the call may cost, in US dollars: the amount `LearningSpend.admit` was asked about. The model's key holds exactly this much (never more). Absent: the model's own default. */ budgetUsd?: number }): Promise<{ text: string; costUsd: number; model: string }>;
}

export type { Embedder, EmbedderCall, LessonEmbedder, LessonVectors, StoredLessonVector } from "@agentx/contracts";

/**
 * Spend for learning. `admit` is the cheap look before a model call: whether the company's own learning limit (Public: $20 a month) has room for a call of about `estimateUsd`. It holds nothing and writes nothing.
 * The money itself is held and booked by the model's key, in the company's spend ledger (`PipelineModel.complete` mints and reserves it, the ordinary sweep settles and finalizes it), so a call that failed or
 * crashed still holds its cap until it is settled. Enterprise has no learning cap of its own, only the company's existing budgets.
 */
export interface LearningSpend {
  admit(workspaceId: string, estimateUsd: number): Promise<boolean>;
  /**
   * The same look with the reason when it refuses: `month_full` (the company's learning month has no room), `too_large` (one call of this size cannot fit the month's whole cap) or `unreadable` (the counter
   * could not be read: a fault, not a limit). Absent: the caller asks `admit` and reads a refusal as `month_full`.
   */
  look?(workspaceId: string, estimateUsd: number): Promise<"ok" | "month_full" | "too_large" | "unreadable">;
}

export interface LessonAuditEvent {
  action: LessonAuditAction; workspaceId: string; project: string; lessonId?: string; actor?: string;
  /** Ids, counts and fixed codes only; never lesson text or anything a person wrote. */
  facts: Record<string, string | number | boolean>;
}
/** `required`: the event grants something (`requireAudit`), so a sink that has no ledger name for it must FAIL (throw) instead of passing without a record. */
export interface LessonAuditSink {
  emit(event: LessonAuditEvent, options?: { required?: boolean }): Promise<void>;
  /**
   * The event as items for the CALLER's own document-store transaction: the audit's pending item, to be written in the same `DocumentStore.transact` as the change it records, so the change and its audit line commit
   * together or not at all. `sent` flushes the committed event to the ledger's queue afterwards (it never throws into the caller). Throws when the event has no ledger name or the install has no ledger.
   * Absent: the sink can only `emit` after the fact, and a caller that needs both in one transaction refuses.
   */
  stage?(event: LessonAuditEvent): { items: readonly TransactItem[]; sent(): Promise<void> };
}
export interface AlertSink { alert(workspaceId: string, project: string, code: "source_spike_paused" | "project_volume_spike" | "lesson_contradiction" | "retire_proposed"): Promise<void> }
export interface Metrics { count(name: string, tags?: Record<string, string>): void }

/** The broker's check of a code citation against a base commit's objects (never a working tree). `unknown`: it could not tell, so the lesson is not trusted as verified. */
export interface CitationVerifier {
  verify(input: { workspaceId: string; /** The lesson's project: the repository must be one of ITS repositories. */ project?: string; repo: string; commit: string; path: string; startLine: number; endLine: number; anchor: string }): Promise<{ result: "valid" | "moved" | "stale" | "unknown"; startLine?: number; endLine?: number }>;
}

/** Who may approve lessons for a project (project maintainers, How-we-work editors, company admins). `complete: false` means the answer is not trustworthy. */
export interface ApproverDirectory {
  /**
   * `who` names the person the answer is for. A production directory that can pin the answer returns `fence`: the commit conditions that hold only while the membership generation and
   * that person's authority are as read (`readSecondPersonApprovalEvidence`'s). The approval's writes carry them (`LessonStore.commit`), so a person removed between the read and the write cannot activate.
   */
  eligibility(workspaceId: string, project: string, who?: { approverId: string }): Promise<{
    complete: boolean; membershipVersion: number; ownerIds: string[]; eligibleIds: string[]; lastEligibleLossAtMs: number | null;
    fence?: readonly unknown[];
    /** Named groups (Enterprise): group id to member ids. */
    groups?: Record<string, string[]>;
  }>;
  identity(workspaceId: string, developerId: string): Promise<IdentitySet>;
  /**
   * The member a (possibly merged-away) developer id stands for: the end of its `mergedInto` chain, or the id itself. The author rules (who may approve alone, who counts as a second
   * person) compare these, so an author recorded under an id that was merged into another member is that member. Absent: ids are compared as they are. A failure is a refusal (fail closed).
   */
  resolveMember?(workspaceId: string, developerId: string): Promise<string>;
}

/** Publishes one paragraph as a How we work rule (the host's own accept path for a suggested rule). It inherits that path's own less-safe checks. */
export interface RulePublisher {
  publish(input: { workspaceId: string; project: string; paragraph: string; lessonId: string; approverId: string }): Promise<{ ruleId: string }>;
}

export type CorrectionKind = "send_back" | "review_comment" | "human_edit" | "revert";
export type CorrectionRating = "caused" | "contradicts" | "unrelated" | "same_ignored";
/** Rates one correction against one lesson that was loaded for the task (no tools; the answer is a fixed code). */
export interface CorrectionJudge {
  /** Rates one correction. Throws when it cannot (no model, a refusal, a failed call, an answer that does not parse): the caller leaves the correction unjudged, which gives no helpful mark. */
  rate(input: { workspaceId: string; project: string; /** Called once, right before the paid model call: false means this very correction was already paid for (by an earlier delivery), so the call is not made. */ claim?: () => Promise<boolean>; lesson: Pick<Lesson, "id" | "title" | "description" | "body" | "type">; correctionKind: CorrectionKind; correctionText: string }): Promise<CorrectionRating>;
  /** Whether outcomes can be rated now: a usable model on the company's own provider and room in the learning month. Reads and records nothing. Absent: assumed usable. */
  usable?(scope: { workspaceId: string; project: string }): Promise<boolean>;
  /** The same judge counting its failed calls toward `model_failed` once for this task (`failuresCountedOncePerTask`). Absent: the judge counts as it is. */
  forTask?(tally: TaskFailureTally): CorrectionJudge;
}

/**
 * What the broker can read of the repository at a CITED commit (base objects, never a working tree) so a tier-0 lesson's words can be checked against real code.
 * Implemented beside the citation verifier (`trusted-base-objects.ts`); `identifiers` lexes the cited lines and drops comments and string literals.
 */
export interface CodeFacts {
  /** Identifier tokens of lines startLine..endLine of the file at the commit, without comments and string literals. Undefined when unreadable. */
  identifiers(input: { workspaceId: string; /** The project the lesson belongs to: the repository must be one of ITS repositories. Absent: nothing is read. */ project?: string; repo: string; commit: string; path: string; startLine: number; endLine: number }): Promise<string[] | undefined>;
  /** Whether the path exists in the tree at the commit; for a glob, whether its literal directory prefix does. */
  pathExists(input: { workspaceId: string; project?: string; repo: string; commit: string; path: string }): Promise<boolean | undefined>;
  /** The project's repositories (the project's own list, not the lesson's claim). */
  repositories(workspaceId: string, project: string): Promise<string[]>;
}

export interface LessonDeps {
  now: Clock;
  audit: LessonAuditSink;
  metrics?: Metrics;
  newId?: () => string;
}

export type { LessonStage };
