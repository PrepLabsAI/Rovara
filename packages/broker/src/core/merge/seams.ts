// Port lane L7a: what the merge core needs of its neighbours, as narrow types the neighbours' lanes fill. Nothing here names DynamoDB, SQS, a Cloud module or a provider.
//
// Cloud's merge code reached the task record, the session timeline, the milestone hook, the team's members and the audit ledger through Cloud modules. In Code each of them is a seam:
//  - the task record: `MergeTask`, read through `MergeHost.loadTask` (the task-flow lane owns the record);
//  - the session timeline and the milestone hook: `SessionTimeline` and `CodeMilestones` (the sessions and notification lanes own them; the items they make are `TransactItem`s of the
//    document-store port, so they commit in the same transaction as the merge state);
//  - who a person is on the code host, and whether they may approve: `MergePeople` (people.ts), filled by the identity port in Code and by the team's members in Cloud;
//  - the audit ledger: W0's `AuditSink`; the approval of a merge: W0's `Approvers`.
import type {
  Autonomy, ChangeRequestStatus, CodeMilestone, CodeSettings, CodeHost, CheckRunner, HostScope, MergeTrackingItem, OrgId, PluginKind, TransactItem, WorkflowSnapshot,
} from "@agentx/contracts";

/** The part of a task record the merge code reads. The record itself is the task-flow lane's. */
export interface MergeTask {
  taskId: string;
  orgId?: OrgId | undefined;
  project: string;
  startingRevision: number;
  workspaceId: string;
  sessionId?: string | undefined;
  closedAt?: string | undefined;
  releasedAt?: string | undefined;
  workflow?: WorkflowSnapshot | undefined;
  /** The person who owns the task now (its creator, or whoever took it over): the first requester. */
  ownerId: string;
  /** The name the owner is called by in the words of a refusal. Never an email address. */
  ownerName: string;
  /** Who started the task and who created it, when they are not the owner. */
  startedBy?: { developerId?: string | undefined } | undefined;
  creatorId?: string | undefined;
  /** The task's frozen agent: its recipe's digest, which an automatic decision is bound to. */
  agent?: { agentId?: string | undefined; version?: number | "draft" | undefined; digest?: string | undefined } | undefined;
}

/** One repository of a task's project, as the merge code reads it (see host-port.ts). */
export interface ConsumerRepositoryRef { url: string; codeHost: CodeHost; checkRunner?: CheckRunner | undefined }

/** A line on a session's timeline. The sessions lane makes the items; they commit with the caller's transaction. */
export interface SessionTimeline {
  statusLine(session: { orgId: OrgId; sessionId: string }, event: { eventId: string; at: string; text: string }): TransactItem;
}

/** The milestone hook (Cloud `milestones.ts`): items written in the transaction of the change that caused the milestone, and the delivery to handlers after the commit. */
export interface CodeMilestones {
  items(milestone: CodeMilestone, n: number, options?: { definitionVersion?: string }): TransactItem[];
  /** Tells the handlers of the notification lane about the task's new milestones. Never throws for a handler's failure. */
  deliver(taskId: string): Promise<void>;
}

/** The outside places a session follows (a chat thread, a tracker item), read for the `merged` milestone. A read that fails throws. */
export interface SessionBindingsReader {
  read(orgId: OrgId, sessionId: string | undefined): Promise<NonNullable<CodeMilestone["bindings"]>>;
}

/** A project's code settings. Code reads them from the project's playbook file; Cloud from the settings item. A project with none has `defaults`. */
export interface CodeSettingsReader {
  read(orgId: OrgId, project: string): Promise<CodeSettings>;
}

/** The pull request of a task, found from the repository and number a host reports (the reverse link `publish` writes). */
export interface LinkedChangeRequestFinder {
  find(query: { hostKind: PluginKind; connectionKind?: PluginKind | undefined; repositoryAddress: string; id: string }): Promise<{ taskId: string; repositoryId: string; url: string } | undefined>;
}

/** What a tracking pass saw of one change request, for the optional hooks below. */
export interface PassObservation {
  task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot };
  pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number];
  fields: Omit<MergeTrackingItem, "version" | "decisionDigest" | "observedAt">;
  prior: MergeTrackingItem | undefined;
  now: number;
  /** The reviewers' standing, read live (once a pass for each person). */
  permissionOf(login: string): Promise<"admin" | "write" | "read" | "none">;
  /** The status the host gave, as the port types it. */
  status: ChangeRequestStatus;
  ci: MergeTrackingItem["ci"];
}

/**
 * Optional hooks a pass calls at its end, best effort: a failure is logged and never fails the pass. The track record (a person's request for changes, a close without a merge) and the
 * review reminders live behind them, outside the merge core (Cloud's `outcome-hooks.ts` and `nudges.ts`).
 */
export interface MergePassHooks {
  /** Track record: what the pass saw. */
  observe?(observation: PassObservation): Promise<void>;
  /** Reminders for the requested reviewers; answers when the row must be looked at again. */
  remind?(input: { task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }; pullRequest: { repositoryId: string; number: number; url: string }; item: MergeTrackingItem; requested: readonly string[] }): Promise<{ recheckAt?: number }>;
}

export type { Autonomy, HostScope };
