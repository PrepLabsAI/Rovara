// Lane L6a, task flow core: the records the flow keeps in the document store, and the plain-JSON conversion that goes with them.
import type {
  DesignReviewBinding,
  DocumentKey,
  JsonValue,
  Operation,
  SetupAgentLimits,
  SetupProposal,
  SetupRunEndWord,
  SetupRunSummary,
  SetupVerification,
  StoredDocument,
  WorkspaceStatus,
} from "@agentx/contracts";
import type { DeveloperTaskPointerRecord, DeveloperTaskRecord } from "../../developer/task-records.js";
import type { WorkspaceCharge } from "./keys.js";
import type { SecondReviewOperationPlan } from "../second-review/store.js";
import type { OperationModelChoice } from "./step-model.js";

/** The task record: Cloud's `DEVTASK#<id>/META` item. `provider` is the identity adapter's name (a string), not Cloud's closed sign-in list. */
export type TaskRecord = Omit<DeveloperTaskRecord, "provider" | "charge"> & {
  provider: string;
  charge: WorkspaceCharge;
  companyId: string;
  /** The admission reservation the start took; whoever closes the task gives it back. */
  admissionReservationId?: string;
  /** The task's session (lane L6b), created in the same transaction as the task when the install wires sessions. */
  sessionId?: string;
  /** The person asked for the design to be reviewed before any code (`design first`), whatever the project's setting says. */
  designFirst?: { by: string; at: string };
  /** What the task is for, when it is not ordinary work: a run that sets a project up by running its commands (`core/setup-agent`). */
  purpose?: "setup_agent";
  /** A setup run: the limits it started with. */
  setupAgentLimits?: SetupAgentLimits;
  /** A setup run: who pressed Stop and when. Written before the cancel, so the end can tell a person's stop from any other cancel. */
  setupAgentStop?: { by: string; at: string };
  /** A setup run: how many commands the journal holds, for the live view. */
  setupAgentProgress?: { commands: number; at: string };
  /** A setup run's end: the proposal and summary the broker read again from the worker's answer, or the fixed sentence for why there is none. */
  setupAgentResult?:
    | { status: "ready"; stop: SetupRunEndWord; proposal: SetupProposal; summary: SetupRunSummary }
    | { status: "failed"; stop: SetupRunEndWord; failure: string; proposal?: SetupProposal; summary?: SetupRunSummary };
  /** A setup run: what re-reading the proposal's citations from the code host found, kept once every verdict was final. */
  setupAgentVerification?: { at: string; items: Record<string, SetupVerification> };
  /** The end of a setup run, written once with its result. */
  agentRunEnd?: { state: string; at: string };
};

/** Cloud's `WORKSPACE#<id>/DEVELOPER_TASK` pointer: how a worker callback finds the task. The requester names the identity adapter, not a closed sign-in list. */
export type TaskPointerRecord = Omit<DeveloperTaskPointerRecord, "requester" | "pendingWorkflowMode"> & {
  requester: { kind: "developer"; developerId: string; provider: string };
  /** The mode the first run is queued with; a setup run's is its own (`SETUP_AGENT`). */
  pendingWorkflowMode?: "PLAN" | "IMPLEMENT" | "SETUP_AGENT";
};

/** `WORKSPACE#<id>/META`: where a task's worker runs. `machine` is set once a worker machine was started for it. */
export interface WorkspaceRecord {
  pk: string;
  sk: "META";
  entityType: "WORKSPACE";
  id: string;
  companyId: string;
  orgId: string;
  ownerKey: string;
  projectName: string;
  projectRevision: number;
  /** The commit of the project's playbook the task pinned when it started (`StandingInstructionsSeam.pin`): every step of the task reads the file at it. Absent: the head of the default branch. */
  playbookCommit?: string;
  status: WorkspaceStatus;
  /** The one operation that holds the workspace (single writer); null when none does. */
  activeOperationId: string | null;
  /** Raised when a newer holder takes over; every operation and callback carries the fence it was issued under. */
  fence: number;
  machine?: { machineId: string; machineKey: string };
  /** The admission reservation taken when the machine was first started; whoever stops the machine settles or releases it. */
  machineReservationId?: string;
  /** How many machines this workspace has had; the admission key of the next start is made from it, so each machine is admitted once. */
  machineGeneration?: number;
  preparationManifest?: string;
  /** The sparse by-project index keys (WORKSPACE_PROJECT_INDEX). */
  workspaceProject: string;
  workspaceCreatedAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** What a dispatch needs to build the worker's invocation. It never holds a secret: the grant and the capability are issued at delivery. */
export interface DispatchSpec {
  kind: "prepare" | "task" | "publish" | "maintain";
  projectRevision: number;
  /** The invocation payload without `project` and `repositoryGrant` (a prepare gets those at delivery). */
  payload: Record<string, JsonValue>;
  /** Callback actions beyond the three every operation has (`artifacts`, `events`, `result`). */
  extraActions?: readonly string[];
  /** Optional worker features this operation cannot run without; a worker that does not list them fails the operation. */
  requires?: readonly string[];
}

export interface OperationRecord extends Operation {
  pk: string;
  sk: string;
  entityType: "OPERATION";
  companyId: string;
  eventSequence: number;
  dispatch: DispatchSpec;
  /** The workflow revision this operation runs at (set for a workflow step); a result for a revision the owner has moved past is ignored. */
  workflowRevision?: number;
  /** Who asked for it (the identity adapter's person id and name for itself); Cloud's closed `requestedBy` list cannot hold a Code principal. */
  requester?: { personId: string; provider: string };
  /** A `maintain` operation's expectation (lane L10): the push of an approved fix to an open pull request, or the merge of the base branch into it. The update callback is held to it. */
  maintenance?: MaintenanceExpectation;
  /** A publish operation's expectation (lane L10): what the worker may open a pull request with, fixed by the broker when the publication started. The pull request callback is held to it. */
  publication?: PublicationExpectation;
  /**
   * Second review: this REVIEW operation carries a second reviewer (another AI company's model, inside the same operation), or records why it could not: the candidate it is about and the plan (or the fixed
   * reason it did not run). The one REVIEW end reads it (`secondOpinionFromReviewResult`); no other code does and nothing waits on it.
   */
  secondReviewPlan?: SecondReviewOperationPlan;
  /** Design review: the binding the broker stored when it dispatched a design-review round (the reviewers' slots and models, the merge step, the pinned commits). The worker is sent it in the payload; the packets and the keys are served only for the slots it names. */
  designReview?: DesignReviewBinding;
  /** The model the install's rule chose for this step, and why (see `step-model.ts`). Absent: the step ran on the install's one model. */
  modelChoice?: OperationModelChoice;
  /** The source that serves the operation's models (a design-review round records it on each reviewer run). */
  modelSourceId?: string;
  /** The ids of the model keys the operation's calls used (the planner's resolve run, whose spend the review counts). */
  modelKeyIds?: string[];
  /** The worker machine and delivery time, once the operation was handed to a machine. */
  deliveredAt?: string;
  machineId?: string;
}

/** What a push to an open pull request was started with. */
export interface MaintenanceExpectation {
  action: "append" | "sync";
  repository: string;
  pullRequestNumber: number;
  headBranch: string;
  baseBranch: string;
  /** The head the workflow recorded: the push is onto it, and a callback that names another head is stale. */
  expectedHeadCommit: string;
  /** An approved fix: the reviewed tree it must hold, on the base the task pinned (and, for a conflict round, the base commit merged as the second parent). */
  workflowCandidate?: { candidateDigest: string; treeSha: string; baseCommitSha: string; mergeBaseCommit?: string };
  /** A merge of the base branch: exactly this base commit, onto the head named. */
  workflowSync?: { baseCommit: string; expectedHeadCommit: string };
}

/** What a publication was started with: the callback of the worker is refused unless it names exactly this (Cloud's `operation.publication`). */
export interface PublicationExpectation {
  repository: string;
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: true;
  /** The tree the checks and reviews passed on; the host, not the worker, says what the pushed branch holds. */
  expectedTreeSha: string;
  /** The base commit the broker pinned for the task in this repository; the pushed commit must stand on it. */
  expectedBaseCommit?: string;
  candidateDigest: string;
  workflowRevision: number;
}

/** `WORKFLOW_DISPATCH` rows: the intent to start the next workflow step with no one asking, written in the transaction that made it due. */
export type DispatchKind = "UNDERSTAND" | "PLAN" | "REPLAN" | "CRITIQUE" | "CRITIC_REPLAN" | "IMPLEMENT" | "REVIEW" | "PUBLISH" | "SYNC" | "AUTOFIX";
/** The kinds the stage machine's own runner starts (Cloud's `startTaskWorkflowUnderstandFromSystem` and `startTaskWorkflowPlanFromSystem`). */
export const READING_DISPATCH_KINDS: readonly DispatchKind[] = ["UNDERSTAND", "PLAN", "REPLAN"];

export interface DispatchRowRecord {
  pk: string;
  sk: string;
  entityType: "WORKFLOW_DISPATCH";
  companyId: string;
  taskId: string;
  workflowRevision: number;
  kind: DispatchKind;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  /** The due-time index keys. */
  dispatchDuePk: string;
  dispatchDueSk: string;
  indexExpiresAt: number;
  lastError?: string;
  /** A REPLAN row: what the planner is told on its automatic second run (the plan's problems, or what could not be read), kept on the row. */
  planPrompt?: string;
  /** A CRITIQUE row: who approved running the design review without a price (the cost hold's "run it anyway"). Only this lets a round start from the hold. */
  costApprovedBy?: string;
  /** An AUTOFIX row: how the block it looks at came about when no finished run wrote it (the run was lost, or its start was tried until the budget ran out). */
  cause?: "run-lost" | "dispatch-exhausted";
}

/** A record as the store keeps it: plain JSON, with undefined fields dropped. */
export function toDocument<T extends object>(record: T): StoredDocument {
  return JSON.parse(JSON.stringify(record)) as StoredDocument;
}

export function fromDocument<T>(document: StoredDocument | undefined): T | undefined {
  return document === undefined ? undefined : (document as unknown as T);
}

export const keyOf = (document: DocumentKey): DocumentKey => ({ pk: document.pk, sk: document.sk });
