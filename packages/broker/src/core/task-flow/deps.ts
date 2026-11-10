// Lane L6a, task flow core: what the flow is built on. Every dependency is a W0 port or a small seam named here; nothing names DynamoDB, SQS,
// EC2, a chat tool or a code host (decision 51).
import type {
  Admission,
  AgentXErrorCode,
  AuditSink,
  CheckEntry,
  DocumentStore,
  OrgId,
  InvocationModelRoute,
  Principal,
  ProjectDefinition,
  QueueService,
  RegistryView,
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
import type { CodeMilestones } from "../merge/seams.js";

/** Who is acting, as the identity adapter vouched for them. `client` is the surface's own name for itself (an AI tool, the CLI). */
export interface TaskCaller {
  principal: Principal;
  client?: string | undefined;
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
  /** The queue operations are dispatched on. Default `task-dispatch`. */
  dispatchQueue?: string;
  now?: () => Date;
  newId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
  prompts?: StepPrompts;
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
  /** Lane L10: records a milestone ("fixing", "stuck") in the transaction of the change that caused it. Absent: none is recorded (the workflow change still is). */
  milestones?: CodeMilestones;
  /**
   * Lane L12: keeps the evidence of a run whose checks were just recorded for a candidate (the proof page and the pull request read it). Informational: called best effort after the verification is recorded, and
   * a fault or a slow store changes nothing about the task. Absent: no evidence is kept.
   */
  keepEvidence?: (input: { task: TaskRecord; operation: OperationRecord; workflow: WorkflowSnapshot; candidateDigest: string; checks: readonly CheckEntry[] }) => Promise<unknown>;
  /** Lane L10: the steps after the plan is approved. `createTaskFlow` fills it with the build step when absent. */
  buildSteps?: BuildSteps;
  /**
   * Lane L9a / L9-wire: the model a task step calls, through the install's model proxy (the worker holds no key). The route is what the worker is told (`modelRoute`); the capability it
   * gets lists the `model-access` action. Undefined from `route()`: no provider key is set up, and the step gets neither (the worker then has no model access and fails with its own reason).
   */
  modelAccess?: { route(): Promise<InvocationModelRoute | undefined> };
  /** Called once an operation reached a terminal status (the model proxy frees its tokens and spend record). Never throws into the flow. */
  onOperationEnded?: (operationId: string) => void;
  /** Lane L9-wire: called once per start, before the transaction is built. Its items join the start's transaction. */
  startExtras?: (input: StartExtrasInput) => StartExtras;
}

export const DEFAULT_DISPATCH_QUEUE = "task-dispatch";
export const DEFAULT_LIMITS = { member: 10, organization: 100 } as const;
