// Lane L8: what the local review pages read and do. The pages know nothing about task records, the document store or a code host: the task flow
// (lanes L6a and L6b) implements these two interfaces and hands them to `createLocalPagesServer`. Reads are plain view models; every write names
// the exact revision and digest the person saw, and an approval carries a proof for the W0 `Approvers` seam to check.
import type { ApprovalProof, PlanDocument, PlanEvidenceBundle } from "@agentx/contracts";

/** Why a write did not happen, in words fit to show. `stale`: the content moved on since the page was drawn. */
export type LocalActionResult = { ok: true; message?: string } | { ok: false; reason: "stale" | "refused" | "not_found" | "invalid"; message: string };

/** The approval a page offers. The id, revision and digest are what the person is looking at; the page signs them into its form. */
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
}

export interface CommentView {
  id: string;
  author: string;
  at: string;
  /** What it is about: a claim id such as `2.1`, a check id, or empty for the plan as a whole. */
  target: string;
  text: string;
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
}

/** What a page write names. `proof` is built by the server from the page session; the action hands it to the `Approvers` seam. */
export interface PlanDecisionInput {
  taskId: string;
  decision: "approve" | "changes";
  /** What to change, for `changes`. */
  note?: string;
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
}
