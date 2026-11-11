// Lane L8: what the local review pages read and do. The pages know nothing about task records, the document store or a code host: the task flow
// (lanes L6a and L6b) implements these two interfaces and hands them to `createLocalPagesServer`. Reads are plain view models; every write names
// the exact revision and digest the person saw, and an approval carries a proof for the W0 `Approvers` seam to check.
import type { ApprovalProof, CreatedScriptToken, ModelSelectionBody, ModelSelectionState, PlanDocument, PlanEvidenceBundle, ScriptTokenView, SecondReviewContext, SecondReviewMode, SecondReviewModelRef, SecondReviewState } from "@agentx/contracts";

/** Why a write did not happen, in words fit to show. `stale`: the content moved on since the page was drawn. */
export type LocalActionResult = { ok: true; message?: string } | { ok: false; reason: "stale" | "refused" | "not_found" | "invalid" | "reauth"; message: string };

/** The approval a page offers. The id, revision and digest are what the person is looking at; the page signs them into its form. */
import type { WorkBreakdownView } from "../work-breakdown/view.js";
import type { HowWeWorkState } from "../playbook/service.js";
import type { PlanSelfCheckView } from "../../developer/plan-self-check.js";

export interface ApprovalOffer {
  /** The decision card or approval request this answers (the `requestId` of the W0 `ApprovalRequest`). */
  requestId: string;
  revision: number;
  artifactDigest: string;
  /** `plan`, `design`, `test-environment`, `setup` (a project's setup commands, or a website for a setup run), `automation` (turning a trigger on, deciding a chain's gate): the W0 approval kind. */
  kind: "plan" | "design" | "test-environment" | "setup" | "automation";
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
  /** What the task is expected to cost, what it has cost so far and the model each step ran on, one fixed line each (model names are data). Absent: none of it is known yet. */
  costAndModels?: string[];
  /** The parts of an ordered run (spec 059): what the plan lists and where each stands. Absent for a plan with no work breakdown. */
  breakdown?: WorkBreakdownView;
  /** The second review of the code the task holds: its lines, and whether the owner must acknowledge that it did not run before the task can be merged. Absent: none to show. */
  secondReview?: { lines: string[]; needsAcknowledgement: boolean; acknowledged: boolean };
  /** The acknowledgement key the form carries (set only while the owner has to acknowledge). */
  secondReviewAck?: string;
  /**
   * Fix with agent for the error the task shows: the button when one is offered (the error as shown, and a request id for this press), why it is not offered, and the diagnosis that is open or was answered, in
   * plain lines. The lines of a proposal are a model's words and are drawn as untrusted; a diagnosis changes nothing, and whatever it suggests is done by the owner with this page's ordinary forms.
   */
  diagnosis?: PlanDiagnosisView;
  /** One plain line when the design's review did not run ("Design review did not run: ..."). Fixed words. Absent when it ran or there was none. */
  designNote?: string;
  /** Design review: present when the task has one. */
  designReview?: DesignReviewPanelView;
}

export interface PlanDiagnosisView {
  /** The error the page shows, by its key, and the request id of this press. Present when a diagnosis can be asked for now. */
  offer?: { requestId: string; errorKey: string };
  /** Why none is offered (fixed words), when the task shows an error and none can be asked for. */
  why?: string;
  /** Where the open or answered diagnosis is. Absent: none was asked for this error. */
  state?: "waiting" | "ready" | "failed";
  /** The fixed words of a failed diagnosis. */
  failure?: string;
  /** One line for each suggestion, in the words every surface uses. */
  lines?: string[];
  /** The answer says the cause is in the code; a deeper look at the repositories is not on this install yet. */
  needsCode?: boolean;
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
  /** The project it belongs to, when the install has several. */
  project?: string;
  /**
   * How the owner may approve it: present for a lesson that waits for a person. The approval is bound to this lesson's own text and version (`artifactDigest`), so what is approved is what was read; the `approvers`
   * point decides whether the page's proof is the owner's.
   */
  offer?: { requestId: string; revision: number; artifactDigest: string; risk: "low" | "medium" | "high" };
  /** A person asked, from a pull request comment, for this lesson to be retired. Nothing changed: pressing Retire on this page confirms it. */
  retireRequest?: { by: string; pullRequest: number };
}

/** One project's `.rovara/lessons.md` switches, as the lessons page shows them. Fixed sentences only. */
export interface LessonReposView {
  project: string;
  canEnable: boolean;
  repos: Array<{ repo: string; enabled: boolean; fileDeleted: boolean; pointer: "not_yet" | "added" | "missing" | "declined"; notices: string[] }>;
  /** The project's repositories not switched on yet. */
  available: string[];
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

/** What the chat page shows: the chat adapters this install runs, the accounts linked to the owner, the spaces bound to projects, and where the owner is told. Never a token or a code. */
export interface ChatPageView {
  adapters: Array<{ name: string; projects: string[]; proactive: boolean; buttons: number; noThread?: string }>;
  links: Array<{ channel: string; tenant: string; userId: string; maskedUserId: string; linkedAt: string }>;
  bindings: Array<{ channel: string; tenant: string; space: string; project: string }>;
  /** The names a space may be bound to. */
  projects: string[];
  notify: { muted: boolean; targets: Array<{ channel: string; tenant: string; space: string; thread: string }> };
}

/** A token the page just made: the secret is shown on the answer to the form, once, and kept nowhere. */
export type LocalCreateTokenResult = { ok: true; created: CreatedScriptToken } | { ok: false; reason: "refused" | "invalid" | "not_found"; message: string };

/** What a project's test environment page shows (see `core/test-env/local-view.ts`). The page never reads the store itself. */
export interface TestEnvironmentPageView {
  project: string;
  approved?: { revision: number; approvedAt: string; approvedBy?: string; lines: string[]; checks: Array<{ id: string; label: string; kind: string }> };
  proposal?: { digest: string; proposedAt: string; risk: "low" | "medium" | "high"; lessSafe: string[]; changes: string[]; proved: boolean; expiresAt?: string };
  /** Present while a proposal that was proved waits for the owner: the revision approving it would make, and the id of this decision. */
  approval?: ApprovalOffer;
  /** More facts a feature adds (the nightly run's last night, the saved image), one plain line each. */
  extra?: string[];
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

/** One website a setup run asked for, as the page shows it: the name, where the ask stands, and the offer to decide it while it is open. */
export interface SetupHostAskView {
  host: string;
  status: "open" | "approved" | "refused";
  /** The repository file and line that led to it, shown quoted and marked as from the repository. */
  from?: { path: string; line: number };
  journalN?: number;
  /** The name has a punycode label: it may look like another name. */
  international: boolean;
  approval?: ApprovalOffer;
}

/** One suggestion of a setup run, in fixed words (its text is the model's, shown untrusted). */
export interface SetupItemView {
  id: string;
  kind: string;
  lines: string[];
  from: string[];
  /** What re-reading its citations found: `verified`, `unverified`, or `unchecked`. */
  verdict: "verified" | "unverified" | "unchecked";
  /** Whether "Use this setup" can use it (a setup or test command). */
  usable: boolean;
}

/** What the setup page shows for a project (the setup agent). */
export interface SetupPageView {
  project: string;
  /** The project's latest revision: what "Use this setup" is bound to. */
  revision: number;
  status: "none" | "running" | "ready" | "failed";
  failure?: string;
  stoppedBy?: string;
  limits: { commands: number; sameStepTries: number; wallClockMin: number; budgetCents: number; hostAsks: number };
  /** Rovara cannot start a run (no model key, or the feature is off): the sentence. */
  cannotStart?: string;
  summary?: { commandsRun: number; spendCents: number; elapsedMin: number; hostAsks: number; partial: boolean; stop: string };
  items: SetupItemView[];
  verified: boolean;
  journal: Array<{ n: number; source: "agent" | "person"; command: string; exitCode: number | null; timedOut: boolean; flagged: boolean; tail: string; blockedHosts: string[] }>;
  hostAsks: SetupHostAskView[];
  /** The project's own setup check. */
  check: { status: "unchecked" | "outdated" | "checking" | "failed" | "ready"; failedStep?: string };
  /** A proposal waiting: the commands, and where the check on them stands. */
  apply?: { candidateRevision: number; setup: string[]; readiness: string[]; check: { status: "unchecked" | "outdated" | "checking" | "failed" | "ready"; failedStep?: string }; approval?: ApprovalOffer };
  /** The websites the owner approved for this project, with when, each to be taken back on the page. */
  approvedHosts: Array<{ host: string; at: string | undefined }>;
}

/** What the Connections page shows about one saved connection: never its secret, its secret's name or the vendor account it belongs to. */
export interface ConnectionRowView {
  connectionId: string;
  type: string;
  label: string;
  access: "read" | "read_write";
  hasCredential: boolean;
  /** Where it points (the site, the endpoint's host, the region): words for the owner. */
  detail: string;
  lastCheck?: { ok: boolean; at: string };
}

/** A registered MCP server as the page shows it: its address (a private server's own) and what it offers; never its token. */
export interface McpServerRowView {
  serverId: string;
  label: string;
  status: string;
  transport: "http" | "stdio";
  address?: string;
  hasToken: boolean;
  tools: Array<{ name: string; description: string; annotation: string }>;
  pausedAt?: string;
}

export interface ConnectionsPageView {
  connections: ConnectionRowView[];
  servers: McpServerRowView[];
  /** The monitoring kinds an adapter is registered for (a kind with none cannot be checked). */
  monitoringKinds: string[];
  /** Whether the operator named the private ranges a registered server may be in (`ROVARA_PRIVATE_MCP_CIDRS`); with none every private server is refused. */
  privateRangesSet: boolean;
  stdioAvailable: boolean;
  projects: string[];
}

/** One source of a project as the Sources page shows it. */
export interface SourceRowView {
  sourceId: string;
  label: string;
  server: string;
  stages: string[];
  tools: Array<{ name: string; role: string; attested: boolean }>;
  quotes: string;
  retention: string;
  sendCodeSnippets: boolean;
}

export interface SourceChangeView {
  changeId: string;
  kind: "set" | "remove";
  sourceId: string;
  label?: string;
  proposedAt: string;
  /** What the owner is asked to read again before confirming. */
  reasons: string[];
}

export interface DiscoveredToolRowView { name: string; description: string; schemaHash: string; annotation: "read_only" | "unannotated" | "unsafe"; nameSuggestsChange: boolean; takesAddress: boolean }

export interface SourcesPageView {
  project: string;
  sources: SourceRowView[];
  pending: SourceChangeView[];
  /** What a source may read from: read-only connections and approved registered servers, as `connection:<id>` or `server:<id>`. */
  serverChoices: Array<{ value: string; label: string }>;
  /** The tools of the server the owner chose to look at (a form posted, nothing saved). */
  discovered?: { server: string; serverLabel: string; tools: DiscoveredToolRowView[] } | { server: string; serverLabel: string; problem: string };
}

/** One of the owner's acts on the Connections and Sources pages. Every one is made on a page, in a session opened a few minutes ago (a token an AI tool may hold never makes one). */
export type ConnectionPageAction =
  | { op: "save"; requestId: string; type: string; fields: Record<string, string>; access: "read" | "read_write" }
  | { op: "remove" | "check"; requestId: string; connectionId: string }
  | { op: "server-add"; label: string; address: string; token: string }
  | { op: "server-approve" | "server-disable" | "server-remove"; serverId: string }
  | { op: "server-reapprove"; serverId: string; toolsHash: string }
  | { op: "source-propose"; project: string; server: string; sourceId: string; label: string; stages: string[]; tools: Array<{ name: string; schemaHash: string; attested: boolean; role: string }>; quotes: string; retention: string; sendCodeSnippets: boolean }
  | { op: "source-remove"; project: string; sourceId: string }
  | { op: "source-confirm" | "source-reject"; project: string; changeId: string };

/** The read side: each method answers undefined for something that is not there. */
export interface LocalPageData {
  /** What waits for the owner. */
  listPending(): Promise<PendingItemView[]>;
  getPlanPage(taskId: string): Promise<PlanPageView | undefined>;
  getDesignReview(taskId: string): Promise<DesignReviewView | undefined>;
  /** An image of a design review; the page checks its type again before sending it. */
  readMockup(taskId: string, mockupId: string): Promise<{ contentType: string; bytes: Uint8Array } | undefined>;
  listLessons(): Promise<LessonView[]>;
  /** The repository lessons file switches of each project. Absent: the page shows none. */
  listLessonRepos?(): Promise<LessonReposView[]>;
  getProofReport(taskId: string): Promise<ProofReportView | undefined>;
  /** the owner's script tokens. Absent, or undefined: script tokens are off here and the page is not found. */
  listScriptTokens?(): Promise<ScriptTokensPageView | undefined>;
  /** The projects that have a test environment page. Absent, or undefined: the test environment is off here and the pages are not found. */
  listTestEnvironments?(): Promise<string[] | undefined>;
  getTestEnvironmentPage?(project: string): Promise<TestEnvironmentPageView | undefined>;
  /** How we work: the project's playbook file and what a draft of it would make. Absent: the page is not found. */
  howWeWork?: HowWeWorkPageData;
  /** The second review's settings page: the model list, the choice, the mode, the evidence and the notice. Absent: the page is not there. */
  getSecondReview?(): Promise<SecondReviewState | undefined>;
  /** The Connections page: the saved connections, the registered MCP servers and the projects. Absent: the page is not there. */
  getConnectionsPage?(): Promise<ConnectionsPageView | undefined>;
  /** A project's Sources page. With `discover`, also the tools of that server (listing them calls the server; nothing is saved). */
  getSourcesPage?(project: string, discover?: string): Promise<SourcesPageView | undefined>;
  /** The model each step uses: the owner's setting, what each step would run on and the models a step could be set to. Absent: the page is not there. */
  getModelSelection?(): Promise<ModelSelectionState | undefined>;
  /** The chat page. Absent, or undefined: no chat adapter is set up here and the page is not found. */
  getChatPage?(): Promise<ChatPageView | undefined>;
  /** The automation page (triggers, chain runs waiting at a gate). Absent, or undefined while automation is off: the page is not found, so nothing about it is shown. */
  getAutomationPage?(): Promise<AutomationPageView | undefined>;
  /** What a code of a chat account names (the channel and the masked account), for the confirmation the owner reads before linking; undefined for an unknown, used or expired code. */
  previewChatLink?(code: string): Promise<{ channel: string; tenant: string; userId: string } | undefined>;
  /** The setup agent's page for a project, and the projects it can be opened for. Absent: the setup agent is off here and its pages are not found. */
  listSetupProjects?(): Promise<string[]>;
  getSetupPage?(project: string): Promise<SetupPageView | undefined>;
}

/** What the automation page shows. Every word is fixed or a name the owner gave; nothing a repository, an event or a model wrote reaches it unredacted. */
export interface AutomationPageView {
  triggers: Array<{
    triggerId: string; target: string; what: string; project: string; enabled: boolean; disabledReason?: string; lastFiredAt?: string;
    /** What the trigger needs and does not have; empty when it can be turned on. */
    problems: string[];
    /** Present for a trigger that is off and qualifies: what the owner's proof is bound to. */
    offer?: ApprovalOffer;
  }>;
  waiting: Array<{ runId: string; chain: string; seq: number; step: string; prompt: string; since: string; /** One offer for each answer: the proof is bound to the answer it is for. */ offers: { approved: ApprovalOffer; declined: ApprovalOffer } }>;
}

/** The owner's own acts on the automation page. The proof is the page session's, signed over exactly the request shown. */
export type AutomationPageAction =
  | { action: "trigger-on"; triggerId: string; approval: ApprovalOffer; proof: ApprovalProof }
  | { action: "trigger-off"; triggerId: string }
  | { action: "gate"; runId: string; seq: number; decision: "approved" | "declined"; approval: ApprovalOffer; proof: ApprovalProof }
  | { action: "run-cancel"; runId: string };

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

/** One change of the per-step model setting, as the owner made it on the page (the owner's own act, in a page opened within ten minutes). */
export type ModelSelectionPageAction = ModelSelectionBody;

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
  lessonAction(input: { lessonId: string; action: "approve" | "retire" | "wrong"; /** For an approval: what the form was bound to, and the proof the page signed over it. */ offer?: NonNullable<LessonView["offer"]>; proof?: ApprovalProof }): Promise<LocalActionResult>;
  /** One switch of a project's repository lessons file. `fresh`: the page session was opened in the last few minutes (switching on needs it). Absent: the switches are not on this page. */
  lessonRepoAction?(input: { project: string; repo: string; action: "on" | "off" | "resume" | "pointer_add" | "pointer_decline"; fresh: boolean }): Promise<LocalActionResult>;
  /** Lane L12: runs a blocked step again. `revision` is the revision the owner was looking at; a task that moved on refuses it. */
  retry?(input: { taskId: string; revision: number }): Promise<LocalActionResult>;
  /** Lane L12: the owner says a task's plan is posted on an issue or pull request, so a writer's comment there can decide it. */
  attachThread?(input: { taskId: string; revision: number; repository: string; number: number }): Promise<LocalActionResult>;
  /** Design review: a choice at the cost hold, through the approval gate. The proof is the page's (a signed local-session proof). */
  designChoice?(input: { taskId: string; choice: "run_unpriced" | "raise_cap" | "lower_tier" | "skip"; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
  /** Design review: picks a paused review up again. */
  designResume?(input: { taskId: string; revision: number }): Promise<LocalActionResult>;
  /** The owner's answers to Understand's questions (and, while a design review waits for them, to its question card). */
  answerQuestions?(input: { taskId: string; revision: number; round: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }): Promise<LocalActionResult>;
  /**
   * makes a script token. The server calls it only for a verified form on a page session opened a few minutes ago; the secret in the answer is shown once on the page that answers the form.
   * Like a decision, this is the owner's own act on a page: the API token an AI tool may hold cannot do it.
   */
  createScriptToken?(input: { requestId: string; name: string; projects: string[]; permissions: string[]; days?: number }): Promise<LocalCreateTokenResult>;
  /** revokes a script token. */
  revokeScriptToken?(input: { tokenId: string }): Promise<LocalActionResult>;
  /** Approves a proved test environment proposal as the project's next revision. Like a plan decision it is the owner's own act on a page: it carries a proof for exactly this request, revision and digest. */
  decideTestEnvironment?(input: { project: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
  /** The owner's acts on the automation page: turn a trigger on (with their proof), off, decide a chain's gate (with their proof), stop a run. */
  automation?(input: AutomationPageAction): Promise<LocalActionResult>;
  /** A change of the per-step model setting. Refused (with its fixed words) when the owner may not, the page was not opened lately, or the setting moved. */
  modelSelection?(input: ModelSelectionPageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
  /** A change of the second review's settings. Refused (with its fixed words) when the owner may not or the setting moved. */
  secondReview?(input: SecondReviewPageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
  /** Fix with agent: the owner asks for a diagnosis of the error the task page showed (`errorKey` names the error as shown; `requestId` is this press). Spends the owner's own model key, so it is the owner's act on a page. */
  diagnose?(input: { taskId: string; requestId: string; errorKey: string }): Promise<LocalActionResult>;
  /** The owner's acts on the Connections and Sources pages (see `ConnectionPageAction`). `fresh`: the page session was opened in the last ten minutes. */
  connectionAction?(input: ConnectionPageAction, context: { fresh: boolean }): Promise<LocalActionResult>;
  /** The owner acknowledges that an `on` second review did not run, so the merge may go ahead. `revision` is the task revision on the page; `key` is the acknowledgement the page showed. */
  acknowledgeSecondReview?(input: { taskId: string; revision: number; key: string }): Promise<LocalActionResult>;
  /**
   * The owner's own acts on the chat page. Like a decision they are made on a page, never through the API token an AI tool may hold: linking a chat account lets that account start work as the owner, binding a space
   * lets its messages start work on a project, and a notice target is a place task titles are sent to.
   */
  linkChatAccount?(input: { code: string }): Promise<LocalActionResult>;
  unlinkChatAccount?(input: { channel: string; tenant: string; userId: string }): Promise<LocalActionResult>;
  bindChatSpace?(input: { channel: string; tenant: string; space: string; project: string }): Promise<LocalActionResult>;
  unbindChatSpace?(input: { channel: string; tenant: string; space: string }): Promise<LocalActionResult>;
  addNoticeTarget?(input: { channel: string; tenant: string; space: string; thread?: string }): Promise<LocalActionResult>;
  removeNoticeTarget?(input: { channel: string; tenant: string; space: string; thread: string }): Promise<LocalActionResult>;
  muteNotices?(input: { muted: boolean }): Promise<LocalActionResult>;
  /** The setup agent (the owner's own acts on the setup page). A command, a website and the use of a setup are never decided by a route or a token. */
  setupStart?(input: { project: string; requestId: string }): Promise<LocalActionResult>;
  setupStop?(input: { project: string; requestId: string }): Promise<LocalActionResult>;
  setupCommand?(input: { project: string; requestId: string; command: string }): Promise<LocalActionResult>;
  setupConfirm?(input: { project: string; requestId: string; expectedRevision: number; itemIds: string[] | undefined }): Promise<LocalActionResult>;
  setupDiscard?(input: { project: string }): Promise<LocalActionResult>;
  /** Takes an approved website back (it narrows what a machine may reach, so it needs only the page's own form). */
  setupForgetHost?(input: { project: string; host: string }): Promise<LocalActionResult>;
  setupCheck?(input: { project: string; requestId: string }): Promise<LocalActionResult>;
  /** Approves or refuses a website a setup run asked for. `proof` is the page session's proof over exactly this ask. */
  setupDecideHost?(input: { project: string; host: string; decision: "approve" | "reject"; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
  /** Approves or rejects the waiting setup proposal of a project. */
  setupDecideProposal?(input: { project: string; decision: "approve" | "reject"; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
}
