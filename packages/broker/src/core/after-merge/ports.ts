// M7 after-merge watcher (first slice, TE-H2 core): what the watcher needs of its neighbours, as narrow seams. Nothing here names a provider, a queue or a Cloud module.
//
// The watcher follows a pull request Rovara merged to its deploy, then watches the project's alarms for a window, and says so on the PR, the task and the chat. It never deploys, never starts paid work and
// never opens a revert on its own: a revert is offered, and only a person's press starts one (owner decision O13). Every seam is filled by the host (Code's local app, Cloud's ingress); this slice is
// proved on fakes only.
import type { AuditSink, DocumentStore, OrgId } from "@agentx/contracts";

/** Where a deploy fact came from. The watcher does not care: both give the same neutral fact. */
export type DeployFactSource = "code_host" | "ci_import";
export const DEPLOY_STATES = ["success", "failure", "in_progress"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

/** One neutral deploy fact (plan: `DeployFact`). `revision` is the commit the deploy ran. The watcher resolves it through the merge-commit index, so a revision Rovara did not merge is ignored. */
export interface DeployFact {
  repository: string;
  revision: string;
  environment: string;
  state: DeployState;
  source: DeployFactSource;
}

/** The part of a task record the watcher reads. The task-flow lane owns the record. */
export interface AfterMergeTask { taskId: string; orgId: OrgId; project: string }
export interface AfterMergeTasks {
  /** The task, or undefined for a task that does not exist in this company (never another company's task). */
  read(orgId: OrgId, taskId: string): Promise<AfterMergeTask | undefined>;
}

/** What `afterMergeWatch` says for a project once checked. Absent, off, unreadable or invalid settings are all "off" (nothing runs). */
export interface AfterMergeSettings {
  windowMinutes: number;
  /** Environment names that count, compared without case. Empty: every environment counts. */
  environments: readonly string[];
  /** `report_only` says what happened; `offer_revert` also offers the revert and the "It's expected" press (the policy field `after_merge_revert`). */
  revert: "report_only" | "offer_revert";
}
/** The project's `afterMergeWatch` setting as the host stores it. Read live on every use; the value is untrusted until `afterMergeSettingsOf` has checked it. */
export interface AfterMergeSettingsReader { read(orgId: OrgId, project: string): Promise<unknown> }

/** Whether a person may act on this task's after-merge watch (the same standing as acting on the task). The host decides; a doubt is a no. */
export interface AfterMergeAuthority { mayAct(orgId: OrgId, personId: string, context: { taskId: string; project: string }): Promise<boolean> }

/** A person's press on Revert. `requestId` is stable for one watch, so a starter that sees it twice starts one task. */
export interface RevertRequest { requestId: string; orgId: OrgId; taskId: string; repository: string; number: number; url: string; mergeCommit: string; requestedBy: string }
/** Starts a revert task through the normal start path (worker revert mode). Idempotent for one `requestId`. */
export interface RevertStarter { start(request: RevertRequest): Promise<{ taskId: string }> }

export type AfterMergeReportKind = "healthy" | "alarm" | "deploy_failed";
/** What the PR, the task and the chat are told. The text is made inert here; the adapters post it as it is. */
export interface AfterMergeReport {
  /** Stable for one fact, so an adapter that sees a retry posts once. */
  reportId: string;
  kind: AfterMergeReportKind;
  taskId: string;
  repository: string;
  number: number;
  url: string;
  environment: string;
  text: string;
  /** The alarm's key, for the "It's expected" press. */
  signalKey?: string;
  actions: { revert: boolean; expected: boolean };
}
export interface AfterMergeReporter { report(orgId: OrgId, report: AfterMergeReport): Promise<void> }

export type AfterMergeLog = (event: string, fields: Record<string, unknown>) => void;

export interface AfterMergeDeps {
  store: DocumentStore;
  audit: AuditSink;
  tasks: AfterMergeTasks;
  /** Absent: the watcher is off for everyone and touches nothing. */
  settings?: AfterMergeSettingsReader | undefined;
  reporter: AfterMergeReporter;
  now: () => Date;
  /** Fixed words and counts only. */
  log?: AfterMergeLog | undefined;
}
export interface AfterMergeActionDeps extends AfterMergeDeps {
  authority: AfterMergeAuthority;
  starter: RevertStarter;
}
