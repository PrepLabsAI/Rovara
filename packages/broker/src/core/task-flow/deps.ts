// Lane L6a, task flow core: what the flow is built on. Every dependency is a W0 port or a small seam named here; nothing names DynamoDB, SQS,
// EC2, a chat tool or a code host (decision 51).
import type {
  Admission,
  AgentXErrorCode,
  AuditSink,
  DocumentStore,
  OrgId,
  Principal,
  ProjectDefinition,
  QueueService,
  RegistryView,
  TransactionalOutbox,
  WorkerMachines,
  WorkflowPath,
} from "@agentx/contracts";
import type { RepositoryGrantService } from "../../repository-access.js";

/** Who is acting, as the identity adapter vouched for them. `client` is the surface's own name for itself (an AI tool, the CLI). */
export interface TaskCaller {
  principal: Principal;
  client?: string | undefined;
}

/** A registered project revision, as the flow needs it. */
export interface ProjectRevision {
  definition: ProjectDefinition;
}

/** Where registered projects are read from. `createStoreProjectSource` reads them from the document store. */
export interface ProjectSource {
  latest(project: string): Promise<ProjectRevision | undefined>;
  revision(project: string, revision: number): Promise<ProjectRevision | undefined>;
}

export type StartVerdict = { allowed: true } | { allowed: false; code: AgentXErrorCode; message: string };

/**
 * Who may start work and who may act on a task. Code's default is the local owner (`createOwnerTaskAccess`); a hosted product fills it with
 * project roles. The flow asks again at every step that spends (a start, a dispatch) and never takes a caller's word for a role.
 */
export interface TaskAccess {
  checkStart(principal: Principal, project: string): Promise<StartVerdict>;
  /** Whether this principal may read and drive the task. A task of someone else is "not found" to a principal who may not (no leak). */
  canAct(principal: Principal, task: { developerId: string; project: string }): Promise<boolean>;
}

/** The text of the first request to each step. Cloud builds these in `rovara-code/understand.ts` and `developer-tasks/workflow-inputs.ts` (not ported yet: a 51 gap). */
export interface StepPrompts {
  understand(input: { requestText: string }): string;
  plan(input: { requestText: string; path: WorkflowPath; restatement?: string; assumptions?: readonly string[] }): string;
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
}

export const DEFAULT_DISPATCH_QUEUE = "task-dispatch";
export const DEFAULT_LIMITS = { member: 10, organization: 100 } as const;
