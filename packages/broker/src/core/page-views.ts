// The view types the hosted product and the core share with the laptop's local pages: an approval a page offers, a write's result, and the read models drawn on both (the attention, design review,
// proof report, "how we work" and setup-eval panels). Moved out of `core/local-pages/views.ts` so code outside the local pages names no type there (issue #1538); that file re-exports them.
import type { BrowserEvidencePanel } from "@agentx/contracts";
import type { HowWeWorkState } from "./playbook/service.js";

/** Why a write did not happen, in words fit to show. `stale`: the content moved on since the page was drawn. */
export type LocalActionResult = { ok: true; message?: string } | { ok: false; reason: "stale" | "refused" | "not_found" | "invalid" | "reauth"; message: string };

/** The approval a page offers. The id, revision and digest are what the person is looking at; the page signs them into its form. */
export interface ApprovalOffer {
  /** The decision card or approval request this answers (the `requestId` of the W0 `ApprovalRequest`). */
  requestId: string;
  revision: number;
  artifactDigest: string;
  /** `plan`, `design`, `test-environment`, `setup` (a project's setup commands, or a website for a setup run), `automation` (turning a trigger on, deciding a chain's gate): the W0 approval kind. */
  kind: "plan" | "design" | "test-environment" | "setup" | "setup-eval-spend" | "automation";
  risk?: "low" | "medium" | "high";
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

/** The design review of a task, as the plan page shows it: how the review went, the findings that are still open or contested, what is waiting for the owner and the forms that answer it. Fixed words and model words (shown as untrusted text). */
export interface DesignReviewPanelView {
  /** One line: where the review stands, in Rovara's words. */
  status: string;
  /** Counts and facts: reviewers that ran, open blockers, disagreements, the cost. */
  facts: string[];
  /** The latest round's findings that are not settled, then the settled ones, each with who raised it and what the planner said. */
  findings: Array<{ severity: "blocker" | "major" | "nit"; section: string; text: string; from: string; resolution?: string; open: boolean }>;
  /** The cost hold: the choices the owner may make (each a request through the approval gate). */
  hold?: { why: string; /** How an accepted run with no price is counted, and that the real bill can differ. */ note?: string; offer: ApprovalOffer; choices: Array<{ choice: "run_unpriced" | "raise_cap" | "lower_tier" | "skip"; label: string }> };
  /** The review is paused (waited a week): the owner picks it up again. */
  parked?: { revision: number };
  /** A design with an open blocker is approved only with a one-line reason: the page says so beside the approval. */
  blockerReasonNeeded?: boolean;
}

export interface ProofRowView {
  claim: string;
  check: string;
  status: "passed" | "failed" | "not_run";
  detail?: string;
}

/** One failing test line: its id and the words for its cause, both already plain text. */
export interface ProofFailureView { test: string; cause: string }

export interface ProofFailuresView {
  /** The failed checks that have causes, in the pack's order, each with its failing tests (ten tests across all checks). */
  checks: Array<{ check: string; tests: ProofFailureView[] }>;
  /** Failing tests with a cause that are not listed, over all checks. */
  more: number;
}

export interface ProofReportView {
  taskId: string;
  title: string;
  revision: number;
  summary: string;
  rows: ProofRowView[];
  /** TE-H1: the before and after screenshots of the changed pages (visual evidence only), each picture served by `readEvidenceImage` behind the page session. Absent: none were taken for this code. */
  browserEvidence?: BrowserEvidencePanel;
  /**
   * TE-A6 (DEC 254zzf): the failing tests of the failed checks, each with the change that most likely broke it or "unknown" (the evidence pack's `failureCauses`, made plain text by the broker). At most ten tests in all, the rest counted
   * in `more`. Absent when no failed check carries causes: the report and the page are then exactly what they were.
   */
  failures?: ProofFailuresView;
  /** One line: what the task cost, when the metering seam knows. */
  cost?: string;
  pullRequests: Array<{ url: string; number: number; state: string }>;
}

/** How we work, as the page reads it: the effective view and where it came from (the file in the repository), for each registered project. */
export type HowWeWorkPageState = HowWeWorkState;

export interface HowWeWorkPageData {
  projects(): Promise<string[]>;
  /** `undefined`: no such project. */
  state(project: string): Promise<HowWeWorkPageState | undefined>;
  /** What a draft of the file would make, or what is wrong with it. Nothing is written. */
  preview(project: string, draft: string): Promise<{ problems: Array<{ path: string; message: string }> } | { view: HowWeWorkState["view"] }>;
}

/** The eval definition as the setup page shows it. `waiting`: nobody confirmed it yet; `confirmed`: confirmed and its spend item stands; `reapprove`: confirmed, but its spend approval was rejected, needs renewing or is gone. */
export interface SetupEvalDiscoveryView {
  state: "waiting" | "confirmed" | "reapprove";
  taskId: string;
  reportDigest: string;
  confirmedSelection?: string;
  cannotConfirm?: string;
  suites: Array<{ selection: string; repository?: string; files: string[]; questions: number; categories: string; command: string; commandCwd: string; report: string; model: string; judge: string; caps: string }>;
}
