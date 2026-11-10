// Port lane L7a: a small world for the merge core's tests. One company (Code's implicit one) with one owner, a task waiting for its merge, one or two pull requests on a fake code host that
// answers as a GitHub-shaped one (kind "github", GitHub addresses), the document store (W0's in-memory one), the local owner's Approvers, and in-memory versions of the neighbouring lanes'
// seams (milestones, timeline, bindings, the audit sink). Nothing here reads a clock or the network.
import { randomUUID } from "node:crypto";
import {
  IMPLICIT_COMPANY_ID, change, codeMilestoneKey, companyScoped, mergeTrackingDecisionDigest, mergeTrackingKey, when,
  type ApprovalProof, type AuditEvent, type AuditSink, type CodeHost, type CodeMilestone, type MergeTrackingItem, type TransactItem, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import {
  fixedCodeSettings, plain, prepareMerge, soleOwnerPeople, storeLinkedChangeRequests, taskRecordKey,
  type CodeMergeHost, type CodeMilestones, type MergeDependencies, type MergeTask, type MergeTrackingDependencies, type PreparedMerge, type SessionTimeline,
} from "../../packages/broker/src/core/merge/index.js";
import { linkedChangeRequestStep } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";

export const ORG = IMPLICIT_COMPANY_ID;
export const TASK_ID = "11111111-1111-4111-8111-111111111111";
export const SESSION_ID = "ses_22222222222222222222";
export const OWNER_SESSION = ["owner", "session", "for", "tests"].join("-");
export const CLOCK = Date.parse("2026-11-09T10:00:00.000Z");
const CANDIDATE = "c".repeat(64);

/** A fake code host that calls itself `github`, so the keys and addresses are the ones Cloud writes. */
export function githubShapedHost(model: FakeHostModel): FakeCodeHost & CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, { kind: { value: "github" } }) as FakeCodeHost & CodeHost;
}

export class MemoryMilestones implements CodeMilestones {
  readonly written: CodeMilestone[] = [];
  readonly delivered: string[] = [];
  items(milestone: CodeMilestone, n: number): TransactItem[] {
    this.written.push(milestone);
    return [{ kind: "put", item: plain({ ...codeMilestoneKey(milestone.taskId, milestone.kind, n), entityType: "CODE_MILESTONE", ...milestone }), condition: when.absent() }];
  }
  async deliver(taskId: string): Promise<void> { this.delivered.push(taskId); }
}

export class MemoryTimeline implements SessionTimeline {
  readonly lines: string[] = [];
  statusLine(session: { orgId: string; sessionId: string }, event: { eventId: string; at: string; text: string }): TransactItem {
    this.lines.push(event.text);
    return { kind: "put", item: plain({ pk: companyScoped(session.orgId, `SESSION_EVENT#${session.sessionId}`), sk: event.eventId, text: event.text, at: event.at }) };
  }
}

export class CapturingAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  stage(event: AuditEvent): readonly TransactItem[] {
    this.events.push(event);
    return [{ kind: "put", item: plain({ pk: companyScoped(event.companyId, "AUDIT"), sk: event.eventId, action: event.action, actor: event.actor.id }), condition: when.absent() }];
  }
  async record(): Promise<void> { return undefined; }
}

export interface MergeWorldOptions {
  /** The pull requests of the task: repository id and number. Default one, `app` #7. */
  pullRequests?: Array<{ repositoryId: string; number: number }>;
  allowSelfApproval?: boolean;
  mergeMethod?: "squash" | "merge";
  /** A code host to use instead of the fake one (the repositories keep their GitHub addresses). */
  codeHost?: (model: FakeHostModel) => CodeHost;
}

export interface MergeWorld {
  store: MemoryDocumentStore;
  models: Map<string, FakeHostModel>;
  host: CodeMergeHost;
  deps: MergeDependencies;
  tracking: MergeTrackingDependencies;
  milestones: MemoryMilestones;
  timeline: MemoryTimeline;
  audit: CapturingAudit;
  now: { value: number };
  scopes: unknown[];
  prs: Array<{ repositoryId: string; number: number; head: string; model: FakeHostModel }>;
  task(): Promise<MergeTask & { workflow: WorkflowSnapshot }>;
  setWorkflow(change: Record<string, unknown>): Promise<void>;
  /** A fresh request and a proof of it from the owner's session. */
  proofFor(prepared: PreparedMerge, overrides?: Partial<ApprovalProof>): ApprovalProof;
  prepare(): Promise<PreparedMerge>;
  /** Writes the tracking item the way a pass would for a healthy, approved pull request (or with the given changes). */
  seedTracking(overrides?: Partial<MergeTrackingItem>): Promise<void>;
  trackingOf(pr: { repositoryId: string; number: number }): Promise<Record<string, unknown> | undefined>;
  requestId(): string;
  syncRequests: string[];
  /** The audit rows that were COMMITTED (the sink also records what it was asked to stage). */
  auditRows(): Promise<unknown[]>;
}

const urlOf = (repositoryId: string): string => `https://github.com/acme/${repositoryId}`;

export async function mergeWorld(options: MergeWorldOptions = {}): Promise<MergeWorld> {
  const store = new MemoryDocumentStore({ ttlAttribute: "indexExpiresAt" });
  const now = { value: CLOCK };
  const prList = options.pullRequests ?? [{ repositoryId: "app", number: 1 }];
  const models = new Map<string, FakeHostModel>();
  const hosts = new Map<string, CodeHost>();
  const prs: MergeWorld["prs"] = [];
  const workflowPrs: Array<Record<string, unknown>> = [];
  for (const [index, pr] of prList.entries()) {
    const model = new FakeHostModel({ url: urlOf(pr.repositoryId), id: String(4_242 + index), fullName: `acme/${pr.repositoryId}`, webBase: "https://github.com" });
    model.setAccount("priya", "write");
    const branch = `agentx/00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const head = model.commit(branch, { "src/a.ts": "export const a = 1;\n" });
    const { cr } = model.reconcile({ sourceBranch: branch, targetBranch: "main", title: "Add a" });
    // The fake numbers its change requests from 1: the world's pull request is the one it made.
    pr.number = Number(cr.id);
    model.setChecks(head, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" }]);
    model.addReview(cr.id, { login: "priya", state: "APPROVED" });
    models.set(pr.repositoryId, model);
    hosts.set(pr.repositoryId, (options.codeHost ?? githubShapedHost)(model));
    prs.push({ repositoryId: pr.repositoryId, number: Number(cr.id), head, model });
    workflowPrs.push({ repositoryId: pr.repositoryId, number: Number(cr.id), url: model.crUrl(cr.id), headSha: head, headTreeSha: "d".repeat(40), candidateDigest: CANDIDATE, required: true, state: "OPEN" });
  }
  const stamp = new Date(now.value).toISOString();
  const workflow = {
    schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.1.0", taskId: TASK_ID, revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", path: "QUICK",
    pullRequests: workflowPrs, updatedAt: stamp, risk: { level: "low", reasons: ["A small change with no sensitive paths."], candidateDigest: CANDIDATE },
  };
  await store.put({ item: plain({
    ...taskRecordKey(TASK_ID), entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: ORG, project: "web", startingRevision: 1, workspaceId: "ws-1", sessionId: SESSION_ID,
    ownerId: "owner-1", ownerName: "Priya", workflow,
  }) });
  for (const pr of prs) {
    const item = linkedChangeRequestStep({
      hostKind: "github", repositoryAddress: urlOf(pr.repositoryId), changeRequestId: String(pr.number), repositoryId: pr.repositoryId, number: pr.number, url: pr.model.crUrl(String(pr.number)),
      taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: CANDIDATE, createdAt: stamp,
    })!;
    await store.transact([item]);
  }

  const scopes: unknown[] = [];
  const syncRequests: string[] = [];
  const host: CodeMergeHost = {
    repository: async (_project, _revision, repositoryId) => {
      const codeHost = hosts.get(repositoryId);
      return codeHost === undefined ? undefined : { url: urlOf(repositoryId), codeHost };
    },
    scope: (orgId) => { const scope = { orgId }; scopes.push(scope); return scope; },
    loadTask: async (taskId) => {
      const stored = await store.get(taskRecordKey(taskId));
      return stored === undefined ? undefined : stored as unknown as MergeTask;
    },
    recordedBase: async () => "main",
    requireSyncForMerge: async (task) => { syncRequests.push(task.taskId); },
  };
  const milestones = new MemoryMilestones();
  const timeline = new MemoryTimeline();
  const audit = new CapturingAudit();
  const owner = localOwnerPrincipal();
  const approvers = createLocalOwnerApprovers({ owner, verifySession: (token) => token === OWNER_SESSION, now: () => new Date(now.value) });
  const settings = fixedCodeSettings({ allowSelfApproval: options.allowSelfApproval ?? true, mergeMethod: options.mergeMethod ?? "squash", codeReviewers: [], revision: 1 });
  const links = storeLinkedChangeRequests(store);
  const deps: MergeDependencies = { store, host, approvers, audit, people: soleOwnerPeople, settings, milestones, timeline, links, now: () => now.value, requirePresserAccount: false };
  const tracking: MergeTrackingDependencies = {
    store, now: () => now.value, settings, milestones, timeline, people: soleOwnerPeople, links,
    scope: (orgId) => ({ orgId }),
    loadTask: async (taskId) => host.loadTask(taskId),
    repositoryUrl: async (_project, _revision, repositoryId) => urlOf(repositoryId),
    repository: host.repository,
    recordedHead: async (_workspaceId, repositoryId) => prs.find((pr) => pr.repositoryId === repositoryId)?.head,
  };
  const requestId = () => randomUUID();
  const world: MergeWorld = {
    store, models, host, deps, tracking, milestones, timeline, audit, now, scopes, prs, syncRequests, requestId,
    task: async () => (await host.loadTask(TASK_ID)) as MergeTask & { workflow: WorkflowSnapshot },
    async setWorkflow(patch) {
      const stored = await store.get(taskRecordKey(TASK_ID));
      await store.update({ key: taskRecordKey(TASK_ID), ops: [change.set(["workflow"], JSON.parse(JSON.stringify({ ...(stored!["workflow"] as object), ...patch })) as never)] });
    },
    proofFor(prepared, overrides = {}) {
      return {
        proofId: randomUUID(), method: "local-session", requestId: prepared.request.requestId, revision: prepared.request.revision, artifactDigest: prepared.request.artifactDigest,
        token: OWNER_SESSION, ...overrides,
      };
    },
    prepare: () => prepareMerge(deps, { taskId: TASK_ID, requestId: requestId() }),
    async seedTracking(overrides = {}) {
      for (const pr of prs) {
        const fields = {
          orgId: ORG, taskId: TASK_ID, repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const,
          ciBasis: "all_checks" as const, checksEverSeen: true, failingChecks: [], review: "approved" as const, approval: { hostUserId: pr.model.accounts.get("priya")!.hostUserId, login: "priya", commitId: pr.head },
          branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-09", count: 0 }, readyAt: stamp, ...overrides,
        };
        const item: MergeTrackingItem = { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: stamp };
        await store.put({ item: plain({ ...mergeTrackingKey(TASK_ID, pr.repositoryId, pr.number), entityType: "MERGE_TRACKING", ...item }) });
      }
    },
    trackingOf: async (pr) => store.get(mergeTrackingKey(TASK_ID, pr.repositoryId, pr.number)),
    auditRows: async () => (await store.query({ pk: companyScoped(ORG, "AUDIT") })).items,
  };
  return world;
}

/** A store that behaves as `store` does except for the members given (the in-memory store keeps private state, so a prototype link will not do). */
export function wrapStore<S extends object>(store: S, overrides: Record<string, unknown>): S {
  return new Proxy(store, {
    get: (target, property) => (property in overrides ? overrides[property as string] : typeof (target as Record<string | symbol, unknown>)[property] === "function"
      ? ((target as Record<string | symbol, unknown>)[property] as (...args: unknown[]) => unknown).bind(target) : (target as Record<string | symbol, unknown>)[property]),
  });
}
