// Lane L8: what the local review pages read and do. The pages know nothing about task records, the document store or a code host: the task flow
// (lanes L6a and L6b) implements these two interfaces and hands them to `createLocalPagesServer`. Reads are plain view models; every write names
// the exact revision and digest the person saw, and an approval carries a proof for the W0 `Approvers` seam to check.
import type { ApprovalProof, CreatedScriptToken, PlanDocument, PlanEvidenceBundle, ScriptTokenView, SecondReviewContext, SecondReviewMode, SecondReviewModelRef, SecondReviewState } from "@agentx/contracts";

/** Why a write did not happen, in words fit to show. `stale`: the content moved on since the page was drawn. */
export type LocalActionResult = { ok: true; message?: string } | { ok: false; reason: "stale" | "refused" | "not_found" | "invalid" | "reauth"; message: string };

/** The approval a page offers. The id, revision and digest are what the person is looking at; the page signs them into its form. */
import type { WorkBreakdownView } from "../work-breakdown/view.js";
import type { PlanSelfCheckView } from "../../developer/plan-self-check.js";

export interface ApprovalOffer {
  /** The decision card or approval request this answers (the `requestId` of the W0 `ApprovalRequest`). */
  requestId: string;
  revision: number;
  artifactDigest: string;
  /** `plan`, `design`: the W0 approval kind. */
  kind: "plan" | "design";
  risk?: "low" | "medium" | "high";
}

export interface PlanVersionView {
  version: number;
  kind: "requirements" | "design" | "coding plan";
  approved: boolean;
  current: boolean;
  /** A structured plan renders as claims, evidence and decisions; a Markdown plan renders as plain text (never as HTML). */
  content: { format: "structured"; plan: PlanDocument; evidence?: PlanEvidenceBundle } | { format: "markdown"; markdown: string };
  createdAt?: string;
  /**
   * What Rovara's own check of a coding plan found, kept beside the plan: the record the page draws under the plan (whether the rules ran, the findings, what each check did on the unchanged code), and the plan on
   * one screen. Only for the current version of a structured coding plan.
   */
  check?: { selfCheck: PlanSelfCheckView; oneScreen?: string };
}

export interface CommentView {
  id: string;
  author: string;
  at: string;
  /** What it is about: a claim id such as `2.1`, a check id, or empty for the plan as a whole. */
  target: string;
  text: string;
}

/**
 * What the owner needs to see and answer on the task's page besides the plan (lane L12), in Rovara's fixed words: why it stopped and asks, where the pull request stands, and the questions it is waiting on.
 * The sentences are Rovara's; the names in them (checks, files) and the questions are redacted text from outside, and a page draws them as untrusted.
 */
export interface AttentionView {
  /** Rovara's own ask: it fixed what it could and asks the owner. `retry` says the owner can run the step again from here. */
  ask?: { lines: string[]; retry: boolean };
  /** Where the pull request stands (checks, reviews, who pushed), and what Rovara is doing about it. */
  merge?: { lines: string[] };
  /** Where the plan is posted (lane L12): the thread the owner attached, and the project's repositories one can be attached from. Absent: no code host reads comments. */
  thread?: { attached?: { repository: string; number: number }; repositories: string[] };
  /** Understand's questions, answered here. `round` is the round being answered. */
  questions?: { round: number; items: Array<{ id: string; text: string; options: Array<{ id: string; label: string }> }> };
}

export interface PlanPageView {
  taskId: string;
  title: string;
  /** Where the task stands, in plain words. */
  status: string;
  /** Moves whenever the task changes; a form posted against an older one is refused as stale. */
  revision: number;
  versions: PlanVersionView[];
  checks: Array<{ label: string; status: "passed" | "failed" | "not_run" | "proposed" }>;
  findings: Array<{ role: "code" | "security"; text: string; file?: string; line?: number }>;
  pullRequests: Array<{ url: string; number: number; state: string; /** Said when the pull request is not what Rovara checked (changed outside Rovara). */ note?: string }>;
  comments: CommentView[];
  /** Present while the plan waits for the owner. */
  approval?: ApprovalOffer;
  /** Rovara's ask, the merge state and any questions (lane L12). */
  attention?: AttentionView;
  /** What a second model made of the coding plan (the plan check), one line each, in Rovara's fixed words; the points are the second model's text and are drawn as untrusted. Absent: the plan was not checked. */
  critique?: string[];
  /** The parts of an ordered run (spec 059): what the plan lists and where each stands. Absent for a plan with no work breakdown. */
  breakdown?: WorkBreakdownView;
  /** The second review of the code the task holds: its lines, and whether the owner must acknowledge that it did not run before the task can be merged. Absent: none to show. */
  secondReview?: { lines: string[]; needsAcknowledgement: boolean; acknowledged: boolean };
  /** The acknowledgement key the form carries (set only while the owner has to acknowledge). */
  secondReviewAck?: string;
  /** One plain line when the design's review did not run ("Design review did not run: ..."). Fixed words. Absent when it ran or there was none. */
  designNote?: string;
}

export interface DesignMockupView {
  id: string;
  caption: string;
  /** An image type the page allows: png, jpeg, webp or gif. Never svg. */
  contentType: string;
}

export interface DesignReviewView {
  taskId: string;
  title: string;
  state: "running" | "waiting" | "approved" | "rejected";
  revision: number;
  summary: string;
  mockups: DesignMockupView[];
  findings: Array<{ id: string; severity: "blocker" | "concern" | "note"; reviewer: string; text: string; evidence: Array<{ label: string; mockupId?: string }> }>;
  approval?: ApprovalOffer;
}

export interface LessonView {
  id: string;
  text: string;
  scope: string;
  status: "proposed" | "active" | "retired";
  /** Tasks that used it, newest first. */
  usedIn: Array<{ taskId: string; title: string }>;
}

export interface ProofRowView {
  claim: string;
  check: string;
  status: "passed" | "failed" | "not_run";
  detail?: string;
}

export interface ProofReportView {
  taskId: string;
  title: string;
  revision: number;
  summary: string;
  rows: ProofRowView[];
  /** One line: what the task cost, when the metering seam knows. */
  cost?: string;
  pullRequests: Array<{ url: string; number: number; state: string }>;
}

export interface PendingItemView {
  kind: "plan" | "design";
  taskId: string;
  title: string;
  since: string;
}

/** what the script tokens page shows. `projects` are the names a token can be made for. */
export interface ScriptTokensPageView {
  tokens: ScriptTokenView[];
  projects: string[];
}

/** A token the page just made: the secret is shown on the answer to the form, once, and kept nowhere. */
export type LocalCreateTokenResult = { ok: true; created: CreatedScriptToken } | { ok: false; reason: "refused" | "invalid" | "not_found"; message: string };

/** The read side: each method answers undefined for something that is not there. */
export interface LocalPageData {
  /** What waits for the owner. */
  listPending(): Promise<PendingItemView[]>;
  getPlanPage(taskId: string): Promise<PlanPageView | undefined>;
  getDesignReview(taskId: string): Promise<DesignReviewView | undefined>;
  /** An image of a design review; the page checks its type again before sending it. */
  readMockup(taskId: string, mockupId: string): Promise<{ contentType: string; bytes: Uint8Array } | undefined>;
  listLessons(): Promise<LessonView[]>;
  getProofReport(taskId: string): Promise<ProofReportView | undefined>;
  /** the owner's script tokens. Absent, or undefined: script tokens are off here and the page is not found. */
  listScriptTokens?(): Promise<ScriptTokensPageView | undefined>;
  /** The second review's settings page: the model list, the choice, the mode, the evidence and the notice. Absent: the page is not there. */
  getSecondReview?(): Promise<SecondReviewState | undefined>;
}

/** One change of the second review's settings, as the owner made it on the page (every one is the owner's own act, in this browser session). */
export type SecondReviewPageAction =
  | { action: "choose"; primary: SecondReviewModelRef; backup?: SecondReviewModelRef }
  | { action: "clear" }
  | { action: "context"; context: SecondReviewContext }
  | { action: "mode"; scope: "company" | "project"; project?: string; mode: SecondReviewMode | "inherit" }
  | { action: "narrow"; project: string; models: SecondReviewModelRef[] | null }
  | { action: "cancel-mode"; changeId: string }
  | { action: "withdraw"; model: SecondReviewModelRef }
  | { action: "replay"; run: unknown }
  | { action: "verdict"; model: SecondReviewModelRef; replayRunId: string; startedAt: string; endedAt: string }
  | { action: "notice-seen"; key: string };

/** What a page write names. `proof` is built by the server from the page session; the action hands it to the `Approvers` seam. */
export interface PlanDecisionInput {
  taskId: string;
  decision: "approve" | "changes";
  /** What to change, for `changes`. */
  note?: string;
  /** The owner's answer to each decision of a structured plan (every decision, once, with one of its options). Absent for a plan with no decisions or a Markdown plan. */
  answers?: Array<{ decisionId: string; optionId: string; opened: boolean }>;
  approval: ApprovalOffer;
  proof: ApprovalProof;
}
export interface DesignDecisionInput {
  taskId: string;
  decision: "approve" | "reject";
  note?: string;
  approval: ApprovalOffer;
  proof: ApprovalProof;
}

/** The write side. Each call is one request from one verified page form. */
export interface LocalPageActions {
  decidePlan(input: PlanDecisionInput): Promise<LocalActionResult>;
  decideDesign(input: DesignDecisionInput): Promise<LocalActionResult>;
  /** `revision` is the revision of the plan the person was reading; the action may refuse a comment on one that has moved on. */
  addComment(input: { taskId: string; target: string; text: string; revision: number }): Promise<LocalActionResult>;
  /** `wrong`: the lesson did not apply or was harmful; it is retired and the reason kept. */
  lessonAction(input: { lessonId: string; action: "approve" | "retire" | "wrong" }): Promise<LocalActionResult>;
  /** Lane L12: runs a blocked step again. `revision` is the revision the owner was looking at; a task that moved on refuses it. */
  retry?(input: { taskId: string; revision: number }): Promise<LocalActionResult>;
  /** Lane L12: the owner says a task's plan is posted on an issue or pull request, so a writer's comment there can decide it. */
  attachThread?(input: { taskId: string; revision: number; repository: string; number: number }): Promise<LocalActionResult>;
  /** Lane L12: the owner's answers to Understand's questions. */
  answerQuestions?(input: { taskId: string; revision: number; round: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }): Promise<LocalActionResult>;
  /**
   * makes a script token. The server calls it only for a verified form on a page session opened a few minutes ago; the secret in the answer is shown once on the page that answers the form.
   * Like a decision, this is the owner's own act on a page: the API token an AI tool may hold cannot do it.
   */
  createScriptToken?(input: { requestId: string; name: string; projects: string[]; permissions: string[]; days?: number }): Promise<LocalCreateTokenResult>;
  /** revokes a script token. */
  revokeScriptToken?(input: { tokenId: string }): Promise<LocalActionResult>;
  /** A change of the second review's settings. Refused (with its fixed words) when the owner may not or the setting moved. */
  secondReview?(input: SecondReviewPageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
  /** The owner acknowledges that an `on` second review did not run, so the merge may go ahead. `revision` is the task revision on the page; `key` is the acknowledgement the page showed. */
  acknowledgeSecondReview?(input: { taskId: string; revision: number; key: string }): Promise<LocalActionResult>;
}
