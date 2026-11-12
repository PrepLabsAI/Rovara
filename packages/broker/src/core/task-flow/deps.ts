// Lane L6a, task flow core: what the flow is built on. Every dependency is a W0 port or a small seam named here; nothing names DynamoDB, SQS,
// EC2, a chat tool or a code host (decision 51).
import type { TaskTestEnvironment } from "../test-env/seam.js";
import type {
  Admission,
  AgentXErrorCode,
  Autonomy,
  AuditSink,
  CheckEntry,
  DocumentStore,
  OrgId,
  PlanDocument,
  InvocationModelRoute,
  ModelIdentifier,
  Principal,
  ProjectDefinition,
  QueueService,
  RegistryView,
  StandingInstructionsPayload,
  TransactItem,
  TransactionalOutbox,
  WorkerMachines,
  WorkflowPath,
  WorkflowIntent,
  WorkflowReviewPhase,
  WorkflowSnapshot,
} from "@agentx/contracts";
import type { RepositoryGrantService } from "../../repository-access.js";
import type { OperationRecord, DispatchRowRecord, TaskRecord } from "./records.js";
import type { StepOutcome } from "./outcome.js";
import type { CodeMilestones, SessionBindingsReader } from "../merge/seams.js";
import type { PlaybookMode } from "../playbook/service.js";
import type { CiDefinitionReader } from "../../rovara-code/ci-checks.js";
import type { StructuredPlanContext, StructuredPlanInput } from "../plan/prompts.js";
import type { SecondReview } from "../second-review/service.js";
import type { ModelSelectionService } from "../model-selection/service.js";
import type { UsableModels } from "../model-selection/usable-models.js";
import type { ProofContext } from "../proof/proof-section.js";
import type { E2EVerificationDeps } from "../e2e/authority.js";
import type { LearnedContext } from "@agentx/contracts";
import type { LessonsUsedSection } from "../proof/pull-request-body.js";

/** Who is acting, as the identity adapter vouched for them. `client` is the surface's own name for itself (an AI tool, the CLI). */
export interface TaskCaller {
  principal: Principal;
  client?: string | undefined;
  /**
   * Set only by intake, never by a request body: the task starts from this ticket, so the request text is the ticket's (the plan's "why" credits it to the ticket, not to the person who started the task).
   */
  ticket?: { system: string; id: string; url: string } | undefined;
  /**
   * Set only by the script token check: the request is a script token's, scoped to these projects and permissions. The start gives such a task the fixed client "Script token", whatever
   * the body says. It is never an approval proof: nothing that decides anything reads it as one, and no route a token may reach decides anything.
   */
  scriptToken?: { tokenId: string; name: string; permissions: readonly ("read" | "start" | "lessons")[]; projects: readonly string[] } | undefined;
}

/** A registered project revision, as the flow needs it. */
export interface ProjectRevision {
  definition: ProjectDefinition;
  /** The project is archived: it accepts no new work (Cloud's PROJECT_ARCHIVED). */
  archived?: boolean;
}

/** Where registered projects are read from. `createStoreProjectSource` reads them from the document store. */
export interface ProjectSource {
  latest(project: string): Promise<ProjectRevision | undefined>;
  revision(project: string, revision: number): Promise<ProjectRevision | undefined>;
}

export type StartVerdict = { allowed: true } | { allowed: false; code: AgentXErrorCode; message: string };

/**
 * The answer to "may the system start this task's next step now". `items` are steps the adapter needs in the step's own transaction (Cloud's
 * People-revision fence), so a change of who may act between the check and the commit refuses the step.
 */
export type StepVerdict = { allowed: true; items?: readonly TransactItem[] } | { allowed: false; message: string };

/**
 * Who may start work and who may act on a task. Code's default is the local owner (`createOwnerTaskAccess`); a hosted product fills it with
 * project roles. The flow asks `checkStart` at a start and `checkStep` before every step the system starts on its own, and never takes a caller's word for a role.
 */
export interface TaskAccess {
  checkStart(principal: Principal, project: string): Promise<StartVerdict>;
  /** Whether this principal may read and drive the task. A task of someone else is "not found" to a principal who may not (no leak). */
  canAct(principal: Principal, task: { developerId: string; project: string }): Promise<boolean>;
  /** Asked before the system starts any step of a task with no one asking (a dispatch row, the first run): the person it runs for must still be allowed. */
  checkStep(task: { taskId: string; developerId: string; project: string }): Promise<StepVerdict>;
}

/**
 * The text of the first request to each step. Understand's is Cloud's (`rovara-code/understand.ts`, ported); the plan's asks for the Markdown document Code keeps (`step-prompts.ts`).
 * `intent` is the workflow's stored understanding (its answers and what Understand found); `phase` is the Full path's current document.
 */
export interface StepPrompts {
  understand(input: { requestText: string; intent?: WorkflowIntent | undefined }): string;
  plan(input: {
    requestText: string; path: WorkflowPath; phase?: WorkflowReviewPhase | undefined; restatement?: string; assumptions?: readonly string[];
    /** What the owner asked to change in the earlier plans, oldest first (lane L9-wire writes them with the decision). */ feedback?: readonly string[];
    intent?: WorkflowIntent | undefined;
    /** The documents of earlier phases the owner approved (a Full task's design is written from its requirements), oldest first. */ earlier?: ReadonlyArray<{ kind: "requirements" | "design" | "plan"; markdown: string }>;
    /** The earlier version of the document being written again after the owner asked for changes. */ previous?: string | undefined;
    /** Present when the planner is asked for a structured plan document (the default): the rules and the document it builds on, as data (`core/plan/prompts.ts`). */
    structured?: { rules: StructuredPlanInput; previous?: StructuredPlanContext | undefined } | undefined;
    /** The planner's automatic second run: what is wrong with its last answer (said by Rovara, from fixed words and plan ids), after the rules. */ revision?: string | undefined;
  }): string;
}

/**
 * What the wiring lane adds to a start: more steps for the start's own transaction (the task's session, whose records must exist if and only if the task does)
 * and the session's id, which the task record then carries so the projector can find it.
 */
export interface StartExtras {
  items: readonly TransactItem[];
  sessionId?: string;
}

export interface StartExtrasInput {
  taskId: string;
  project: string;
  title: string;
  principal: Principal;
  client: string;
  receivedAt: string;
  /** The ticket the task starts from (intake only): the session is bound to it in the same transaction, so the task and its ticket follow each other or the start does not commit. */
  ticket?: { system: string; id: string; url: string } | undefined;
}

/** Reads what a worker saved (a plan, a document) by its object key. At most `maxBytes` are read; undefined when it is not there. Lane L9a's object-storage port fills it. */
export interface ArtifactReader {
  get(objectKey: string, maxBytes: number): Promise<Uint8Array | undefined>;
}

/**
 * The steps after the plan is approved (lane L10): coding, the checks, the reviews and the publication. The stage machine's own runner starts the steps that read (Understand, Plan);
 * a row of any other kind, and the end of any other operation, is handed here. Kept behind this seam so the stage machine does not import the steps that import it.
 */
export interface BuildSteps {
  /** Starts the step a dispatch row stands for. Same answers as the stage machine's own runner: STARTED, DUPLICATE, STALE (the row is no longer wanted), WAITING (try again). */
  runRow(deps: TaskFlowDeps, row: Pick<DispatchRowRecord, "taskId" | "workflowRevision" | "kind">): Promise<"STARTED" | "DUPLICATE" | "STALE" | "WAITING">;
  /** After a coding run, a rerun of the checks, the reviews or a publication ended (the operation's result is committed). Idempotent; never throws for a task that moved on. */
  onEnded(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined; outcome?: StepOutcome | undefined }): Promise<void>;
}

/**
 * Standing instructions: the block one operation carries in its system prompt (the company's rules and the project's How we work). `core/instructions` fills it. Read at every dispatch, so a step
 * started after the rules changed carries the newest ones. A rejection with `CONFIG_INVALID` or `PROCESS_UNAVAILABLE` ends the operation with its sentence; any other waits and tries again.
 */
export interface StandingInstructionsSeam {
  forOperation(input: { project: string; mode: PlaybookMode | undefined; purpose?: string | undefined; playbookCommit?: string | undefined }): Promise<StandingInstructionsPayload | undefined>;
  /** The playbook commit a task starting now is pinned to, kept on its workspace; the task's steps read the file at it. Refuses (as `forOperation`) when the rules cannot be read, so a task does not start under rules it cannot be given. */
  pin(project: string): Promise<string | undefined>;
}

/**
 * The design review stage: a fresh-context review of a Full task's design document, run in the plan-check stage (PLAN_CRITIQUE) with its own rows (`CRITIQUE`, `CRITIC_REPLAN`). Kept behind this seam so the
 * stage machine does not import the review that imports it; `createDesignReviewSteps` (core/design-review/steps.ts) fills it, and a flow without it never enters the stage.
 */
export interface DesignReviewSteps {
  /** Starts the step a `CRITIQUE` or `CRITIC_REPLAN` row stands for. Same answers as the stage machine's own runner. */
  runRow(deps: TaskFlowDeps, row: Pick<DispatchRowRecord, "taskId" | "workflowRevision" | "kind">): Promise<"STARTED" | "DUPLICATE" | "STALE" | "WAITING">;
  /** After an operation of the review ended (a round, or the planner's answer to the findings). True when it was this review's (the stage machine then does nothing more). Idempotent; never throws for a task that moved on. */
  onEnded(deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord, ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined; outcome?: StepOutcome | undefined }): Promise<boolean>;
  /** Understand answered `ready`: the workflow with the design review switched on when the mode says so (Full path forced), else as it was. */
  afterUnderstand(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot, assessment: unknown, now: string): Promise<WorkflowSnapshot>;
  /** The row the workflow's new state makes due (a design handed to the reviewers, the planner's turn to answer them), or undefined. */
  rowFor(workflow: WorkflowSnapshot): "CRITIQUE" | "CRITIC_REPLAN" | undefined;
  /** What the planner is told beside its prompt while the design review is on and the phase is the design (the fixed template), or undefined. */
  planInstructions(workflow: WorkflowSnapshot): string | undefined;
  /** The owner's Retry of a blocked review step. True when it was the review's (a round, or the planner's answer to the findings); false: not this review's, the ordinary retry applies. */
  retryBlocked(deps: TaskFlowDeps, task: TaskRecord, expectedRevision: number | undefined): Promise<boolean>;
  /** The `design first:` prefix of a request, read only while the stage exists for the company. `rest` is the request without it. */
  designFirst(text: string): Promise<{ designFirst: boolean; rest: string }>;
  /** Whether this operation is the planner's answer to the reviewers' findings (a PLAN run while the review is resolving): its saved file is read by `onEnded`, not as a plan. */
  isResolveRun(workflow: WorkflowSnapshot | undefined, operation: Pick<OperationRecord, "workflowMode">): boolean;
  /** The Proof section's input when the task's design was approved (the design line, and the links to the approved design), or undefined: the pull request is then described as for any task. Informational; never throws. */
  proofContext?(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<ProofContext | undefined>;
}

export interface TaskFlowDeps {
  /** Code's one company (`IMPLICIT_COMPANY_ID`); every port call carries it. */
  companyId: OrgId;
  store: DocumentStore;
  queues: QueueService;
  outbox: TransactionalOutbox;
  machines: WorkerMachines;
  admission: Admission;
  audit: AuditSink;
  projects: ProjectSource;
  access: TaskAccess;
  /** Issues the short-lived repository grant a prepare carries. Called when the invocation is built, so a retried delivery gets a fresh one. */
  repositoryGrants: Pick<RepositoryGrantService, "issue">;
  /** Signs the callback capability (HMAC-SHA256, the format the callback API checks). At least 32 bytes. */
  callbackSigningKey: string | Buffer;
  /** When present, a start is refused for a repository whose code host nobody registered. */
  codeHosts?: RegistryView;
  /** Open workspaces one person may hold, and all together. Default 10 and 100. */
  limits?: { member: number; organization: number };
  /** Whether a workflow task starts by understanding the request (workflow 1.1.0). Default: Cloud's `ROVARA_CODE_V2_FOR_NEW_ORGS`. */
  understandFirst?: boolean;
  /**
   * Whether a task on workflow version 1.0.0 may start its approved ordered plan (spec 059). Default off. A version 1.1.0 task (every task `rovara up` starts)
   * does not need it: it exists only where the install started tasks on 1.1.0.
   */
  workflowDependenciesEnabled?: boolean;
  /** The queue operations are dispatched on. Default `task-dispatch`. */
  dispatchQueue?: string;
  /**
   * The project's read-only context sources (MCP servers and monitoring connections the owner has ticked). Asked when a workflow step starts: a stage that may read sources and has some is
   * dispatched with the `context-tools` capability and `contextSources: true`, and so only on a worker that lists `task.contextSources.v1`. Absent: no stage has sources.
   */
  contextSources?: { stageHasSources(task: { project: string }, mode: string): Promise<boolean> };
  /** Told, best effort, after a task was closed and its machines and allowances given back (what a task kept only for its own lifetime, such as live-only source text, goes now). Never fails the close. */
  taskEnded?: (event: { orgId: OrgId; taskId: string }) => Promise<void>;
  /** How long (seconds) a worker machine may be lost or unhealthy before the operation running on it is ended INTERRUPTED (`sweepLostRuns`). Default `RUN_LOST_GRACE_SECONDS`. */
  runLostGraceSeconds?: number;
  now?: () => Date;
  newId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
  prompts?: StepPrompts;
  /**
   * The document a planning run is asked to write: a structured plan (claims with evidence, decisions, checks; Cloud's format, the default) or the Markdown plan an older worker takes. A structured
   * answer is read, judged and stored by `core/plan`; a Markdown one is kept as the worker wrote it.
   */
  planFormat?: "structured" | "markdown";
  /** Whether a plan the planner wrote is held to Rovara's own checks before the owner sees it, and an unreadable one sent back once (Cloud's `planSelfCheck`). Default on. */
  planSelfCheck?: boolean;
  /**
   * A read-only view of a repository's CI definition (its workflow files), when the install's code host can give one: the checks the CI requires then join a coding plan's proposed checks. The CodeHost
   * port has file reads but no directory listing, so a host that cannot list leaves this out and the plan's checks stay as the planner proposed them.
   */
  ciDefinitionReader?: (repository: { name: string; path: string; url: string }) => Promise<CiDefinitionReader | undefined>;
  /** Whether a coding plan is read by a second step before a person sees it (the plan check). Default on. */
  planCheck?: boolean;
  /** The model the install runs its steps on (every step runs on it, so the plan check says the same model checked the plan). Absent: the critique records it as unknown. */
  installModel?: () => Promise<ModelIdentifier | undefined>;
  /**
   * Called once after a structured plan that cites code was committed: reads the cited code (through the code host of each repository) and attaches it beside the plan. Best effort; never throws into the flow.
   * Absent: the plan page shows the citations as they are.
   */
  afterPlanStored?: (input: { task: TaskRecord; workflow: WorkflowSnapshot; artifactId: string; artifactSha256: string; plan: PlanDocument; prefix: string }) => Promise<void>;
  /** Environment every worker machine of this install is started with (lane L9-wire: where the model proxy is). Never a secret. */
  machineEnvironment?: Readonly<Record<string, string>>;
  /** Lane L10: reads the documents workers saved (the approved plan the coding step is given, the plan the reviewers are shown). */
  artifacts?: ArtifactReader;
  /**
   * Lane L10, Rovara's own fixing of a block (the owner's rule: a code fault is sent back to coding by itself at most twice, one hiccup of the checks is retried once, anything unclear is asked
   * about). `capUsd` bounds what automatic rounds may add to a task whose spend is known; `taskSpendUsd` says what it is (undefined: nothing is priced, which Code treats as 0 so the
   * count limits alone bound the rounds, and a Cloud install that cannot read it fills this with a function that throws, which asks the owner instead).
   */
  autofix?: { enabled?: boolean; capUsd?: number; roundEstimateUsd?: number };
  taskSpendUsd?: (taskId: string) => Promise<number | undefined>;
  /**
   * Decision 70(c): how far Rovara may act on its own for this task NOW (the stricter of the task's frozen recipe and the company's limit), read again where a merged base's checks would be re-run by themselves and
   * before the reviews that follow. `suggest` asks the owner instead; `unreadable` and `noCompany` say why a `suggest` is not the owner's setting, so the ask is true. Absent: `suggest` (nothing is re-run by
   * itself) and the reviews are never stopped; an install that lets its owner's machine act on its own says so here (`rovara up` answers `prepare`, as merge tracking does).
   */
  autonomy?: (task: TaskRecord) => Promise<{ autonomy: Autonomy; unreadable?: true; noCompany?: true }>;
  /** Lane L10: records a milestone ("fixing", "stuck") in the transaction of the change that caused it. Absent: none is recorded (the workflow change still is). */
  milestones?: CodeMilestones;
  /**
   * Lane L12: keeps the evidence of a run whose checks were just recorded for a candidate (the proof page and the pull request read it). Informational: called best effort after the verification is recorded, and
   * a fault or a slow store changes nothing about the task. Absent: no evidence is kept.
   */
  keepEvidence?: (input: { task: TaskRecord; operation: OperationRecord; workflow: WorkflowSnapshot; candidateDigest: string; checks: readonly CheckEntry[] }) => Promise<unknown>;
  /** The design review stage. Absent: no task enters it. */
  designReview?: DesignReviewSteps;
  /**
   * The browser and API checks (E2E): what a finished round is verified with (the stored admission and evidence, and the install's authority over the owner, the project, the source and the runtime).
   * Absent: a task that needs the checks cannot have a round verified, so it stays at the checks and never passes them.
   */
  e2e?: E2EVerificationDeps;
  /** Lane L10: the steps after the plan is approved. `createTaskFlow` fills it with the build step when absent. */
  buildSteps?: BuildSteps;
  /**
   * Lane L9a / L9-wire: the model a task step calls, through the install's model proxy (the worker holds no key). The route is what the worker is told (`modelRoute`); the capability it
   * gets lists the `model-access` action. Undefined from `route()`: no provider key is set up, and the step gets neither (the worker then has no model access and fails with its own reason).
   */
  modelAccess?: { route(): Promise<InvocationModelRoute | undefined> };
  /**
   * The install's per-step model rule: the model each workflow step runs on, chosen as the step is handed to a worker and kept on the operation. Absent: every step runs on `modelAccess`'s one model, as before.
   * Where it answers, its route replaces `modelAccess.route()` for that step (the worker is told that route, and the model proxy's grant names it).
   */
  stepModels?: Pick<ModelSelectionService, "choose">;
  /** Called once after a task was closed (its machine and allowances went back): the install records what the run cost, for the estimates of the next runs. Never throws into the close. */
  onTaskClosed?: (task: TaskRecord, closedAt: string) => Promise<void>;
  /** The record of models a call to which was refused: told when a step fails for its model, so the next choice leaves it out. Absent: nothing is learned. */
  usableModels?: UsableModels;
  /** The model aliases an operation's calls went out on, from the model proxy (the second opinion counts only when its model was really called). Present: an operation the proxy saw no call for has an empty answer. Absent: the install cannot tell. */
  modelCalls?: (operationId: string) => ReadonlySet<string> | undefined;
  /** Called once an operation reached a terminal status (the model proxy frees its tokens and spend record). Never throws into the flow. */
  onOperationEnded?: (operationId: string) => void;
  /** The outside places a task's session follows, read when a pull request's description is made (the ticket a task started from is closed by the pull request that fixes it). A read that fails leaves the line out; the next rewrite adds it. */
  sessionBindings?: SessionBindingsReader;
  /**
   * Second review by another AI company: asked when the REVIEW step starts (does this review carry a second reviewer?) and when it ends (what is the opinion of this code?). Absent: no second review, the
   * review is exactly what it was. It only ADDS an opinion beside the reviews; it never changes what the first reviews decide, except that an `on` opinion that blocks holds the step.
   */
  secondReview?: Pick<SecondReview, "prepare" | "opinionOf" | "prLines" | "mergeWait" | "operationEnded" | "releaseHold">;
  /** Lane L9-wire: called once per start, before the transaction is built. Its items join the start's transaction. */
  startExtras?: (input: StartExtrasInput) => StartExtras;
  /**
   * The project's approved test environment, as the flow uses it: a starting task pins the newest usable revision, and a coding or verification run is told the plan of the revision it pinned (its checks, selection,
   * budget and dependencies). Absent: no task uses an environment and every payload is what it was.
   */
  testEnvironment?: TaskTestEnvironment;
  /** The company's rules and the project's How we work, put in front of every step that reads them. Absent: no block (the step is exactly what it was before). */
  standingInstructions?: StandingInstructionsSeam;
  /** Whether a message to a running step is handed to the worker as it is sent (the kill switch, default on). Off: a message is a note, read by the next step. */
  liveSteer?: boolean;
  /** Whether the planning, understanding and coding steps read the people's notes (the flip-back setting, default on). Off: notes are saved and no step reads them. */
  stepNotes?: boolean;
  /**
   * The "Lessons used" section of the description of the task's pull request in one repository: what the task was given and, where that repository's readers may read it, which lessons. `undefined`: no section. Absent: the
   * install has no lessons, and the description says so.
   */
  lessonsUsed?: (task: { taskId: string; project: string; startingRevision: number }, repositoryId: string) => Promise<LessonsUsedSection | undefined>;
  /**
   * The lessons a step is given: asked when the step's invocation is built, only for a task step. `features` are the worker's. The answer is the worker's `learnedContext` or none; it never throws into the dispatch, and a slow
   * answer is none (the step then runs as it would without lessons). Absent: no step is given a lesson.
   */
  learned?: (input: { workspaceId: string; operationId: string; workflowMode: string | undefined; features: readonly string[] }) => Promise<{ learnedContext?: LearnedContext }>;
}

export const DEFAULT_DISPATCH_QUEUE = "task-dispatch";
export const DEFAULT_LIMITS = { member: 10, organization: 100 } as const;
