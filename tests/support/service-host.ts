// A host that is not the local app: the host-neutral services composed over fake adapters (the in-memory store and queue, a fake code host, a fake chat channel, the fake worker machines of the task-flow harness).
// One task waits for the merge of one pull request, with a session of its own and a tracking row.
import { IMPLICIT_COMPANY_ID, WorkflowSnapshotSchema, type CodeHost, change, createCandidateManifest, createWorkflowSnapshot, type ConversationRef, type OrgId, type WorkflowProgram } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createTaskSessionItems, developerIdOf, taskSessionId, type SessionTaskFacts } from "../../packages/broker/src/core/sessions/index.js";
import { fixedCodeSettings, type MergePeople } from "../../packages/broker/src/core/merge/index.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { createMergeTrackingService, createMilestoneService, createNoticeService, createSessionService } from "../../packages/broker/src/services/index.js";
import { TASK_ID, mergeWorld } from "./merge-world.js";
import { createHarness } from "./task-flow-harness.js";

export const ORG = IMPLICIT_COMPANY_ID as OrgId;
export const OWNER = localOwnerPrincipal();
export const OWNER_ID = developerIdOf(OWNER);
export const SESSION = taskSessionId(TASK_ID);
export const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
export const FOOTER = "Open it in the host's own page.";

/** A code host that serves several fake repositories: each call goes to the host of the repository its first argument names (a change request, a repository). */
function routedHost(hosts: ReadonlyMap<string, CodeHost>): CodeHost {
  const first = [...hosts.values()][0]!;
  return new Proxy(first, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const arg = args[0] as { repository?: { url?: string }; url?: string } | undefined;
        const routed = hosts.get(arg?.repository?.url ?? arg?.url ?? "") ?? first;
        return (Reflect.get(routed, property) as (...rest: unknown[]) => unknown).apply(routed, args);
      };
    },
  });
}

export async function host(options: { repositories?: readonly string[] } = {}) {
  const repositories = options.repositories ?? ["app"];
  // One store holds everything; the harness builds the task flow's ports over it.
  const world = await mergeWorld({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "indexExpiresAt" }), pullRequests: repositories.map((repositoryId) => ({ repositoryId, number: 1 })) });
  const h = createHarness({ audit: "recording", backend: (clock) => ({ store: world.store, queues: new MemoryQueueService({ now: () => clock.now }) }) });
  await h.registerProject({
    name: "web", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    repositories: repositories.map((name) => ({ name, url: `https://github.com/acme/${name}`, path: `repo/${name}`, defaultBranch: "main", credentialRef: `host-${name}` })),
  });
  // The task as the flow reads it (the merge world writes the merge core's own shape), with a session of its own.
  const at = "2026-11-09T10:00:00.000Z";
  const candidate = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) })));
  const workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_ID, now: at, definitionVersion: "1.1.0", program: PROGRAM }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: world.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head, candidateDigest: candidate.digest, required: true, state: "OPEN", url: pr.model.crUrl(String(pr.number)) })),
  });
  await world.store.update({ key: taskKey(TASK_ID), ops: [change.set(["companyId"], ORG), change.set(["developerId"], OWNER_ID), change.set(["sessionId"], SESSION), change.set(["createdAt"], at), change.set(["charge"], { member: { pk: "LIMIT#member", sk: OWNER_ID }, organization: { pk: "LIMIT#organization", sk: ORG } }), change.set(["workflow"], JSON.parse(JSON.stringify(workflow)) as never)] });
  await world.store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK_ID, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: at }));
  await world.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
  const registry = createAdapterRegistry();
  const evidenceObjects = new Map<string, Uint8Array>();
  registry.register("object-storage", "test", {
    async put(key: string, bytes: Uint8Array) { evidenceObjects.set(key, new Uint8Array(bytes)); },
    async get(key: string, maxBytes: number) { const value = evidenceObjects.get(key); return value === undefined || value.byteLength > maxBytes ? undefined : new Uint8Array(value); },
    async stat(key: string) { const value = evidenceObjects.get(key); return value === undefined ? undefined : { size: value.byteLength, contentType: "application/octet-stream", metadata: {} }; },
    async delete(key: string) { evidenceObjects.delete(key); },
    async deletePrefix(prefix: string) { for (const key of evidenceObjects.keys()) if (key.startsWith(prefix)) evidenceObjects.delete(key); return true; },
  } as never);
  const codeHosts = new Map<string, CodeHost>();
  for (const name of repositories) codeHosts.set(`https://github.com/acme/${name}`, (await world.host.repository("web", 1, name, ORG))!.codeHost);
  registry.register("code-host", "github", codeHosts.size === 1 ? [...codeHosts.values()][0]! : routedHost(codeHosts));
  const chat = new FakeChannelAdapter();
  registry.register("channel", "examplechat", chat);
  const clock = { ms: Date.parse(at) };
  const now = () => clock.ms;
  const requested: string[] = [];
  // The host's own rule for who a person is: nobody is linked, and it records that it was asked.
  const people: MergePeople = {
    requestersOf: async () => { requested.push("requestersOf"); return "unlinked"; },
    linkedAmong: async () => new Set(), nonWritersAmong: async () => new Set(), hostAccountOf: async () => undefined,
  };
  const milestones = createMilestoneService({ store: h.store, now });
  const tracking = createMergeTrackingService({
    flow: h.deps, registry, companyId: ORG, milestones, people, settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now,
  });
  const notices = createNoticeService({ store: h.store, registry, now: () => new Date(clock.ms), footer: FOOTER, link: (session) => `https://host.example.test/sessions/${session.sessionId}` });
  const state = { facts: { companyId: ORG, taskId: TASK_ID, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: at } as SessionTaskFacts };
  const sessions = createSessionService({ store: h.store, facts: { read: async () => state.facts }, cost: { costUsd: async () => 0 }, notices, now: () => new Date(clock.ms) });
  return { world, h, registry, chat, clock, tracking, sessions, notices, state, people, requested };
}

