// The host-neutral service layer composed by a host that is not the local app: fake adapters only (the in-memory store and queue, a fake code host, a fake chat channel, the fake worker machines of the task-flow
// harness), no `local/app` code. One merge is tracked and recorded, one session sweep runs and one notice is delivered, and the host's own rules (who a person is on the code host, the words of a notice) are
// the ones it passed in.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WorkflowSnapshotSchema, change, createCandidateManifest, createWorkflowSnapshot, type ConversationRef, type OrgId, type WorkflowProgram } from "@agentx/contracts";
import * as broker from "../../packages/broker/src/index.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createTaskSessionItems, developerIdOf, taskSessionId, type SessionTaskFacts } from "../../packages/broker/src/core/sessions/index.js";
import { writeNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { fixedCodeSettings, type MergePeople } from "../../packages/broker/src/core/merge/index.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { createMergeTrackingService, createMilestoneService, createNoticeService, createSessionService } from "../../packages/broker/src/services/index.js";
import { TASK_ID, mergeWorld } from "../support/merge-world.js";
import { createHarness } from "../support/task-flow-harness.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const SESSION = taskSessionId(TASK_ID);
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const FOOTER = "Open it in the host's own page.";

async function host() {
  // One store holds everything; the harness builds the task flow's ports over it.
  const world = await mergeWorld({ store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "indexExpiresAt" }) });
  const h = createHarness({ audit: "recording", backend: (clock) => ({ store: world.store, queues: new MemoryQueueService({ now: () => clock.now }) }) });
  await h.registerProject({
    name: "web", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "app", url: "https://github.com/acme/app", path: "repo/app", defaultBranch: "main", credentialRef: "host-app" }],
  });
  // The task as the flow reads it (the merge world writes the merge core's own shape), with a session of its own.
  const at = "2026-11-09T10:00:00.000Z";
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const pr = world.prs[0]!;
  const workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_ID, now: at, definitionVersion: "1.1.0", program: PROGRAM }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: [{ repositoryId: "app", number: pr.number, headSha: pr.head, candidateDigest: candidate.digest, required: true, state: "OPEN", url: pr.model.crUrl(String(pr.number)) }],
  });
  await world.store.update({ key: taskKey(TASK_ID), ops: [change.set(["companyId"], ORG), change.set(["developerId"], OWNER_ID), change.set(["sessionId"], SESSION), change.set(["workflow"], JSON.parse(JSON.stringify(workflow)) as never)] });
  await world.store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK_ID, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: at }));
  await world.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
  const registry = createAdapterRegistry();
  registry.register("code-host", "github", (await world.host.repository("web", 1, "app", ORG))!.codeHost);
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
  return { world, h, registry, chat, clock, tracking, sessions, notices, state, people, requested, milestones };
}

describe("the service layer, composed with fake adapters and no local-app code", () => {
  it("is exported from the package's public entry", () => {
    for (const name of ["createMergeTrackingService", "createSessionService", "createNoticeService", "createDecisionService", "createCallbackService", "createMilestoneService"]) {
      expect(typeof (broker as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("tracks one merge: the pull request merged on the code host is recorded in the workflow with its milestone, and the tracking row ends", async () => {
    const w = await host();
    const pr = w.world.prs[0]!;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
    expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
    const task = (await w.world.store.get(taskKey(TASK_ID)))!;
    expect(task["workflow"]).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: [expect.objectContaining({ number: pr.number, state: "MERGED" })] });
    // The milestone is a row of the task, written once, in the merge's own commit.
    const rows = (await w.world.store.query({ pk: `DEVTASK#${TASK_ID}` })).items.filter((item) => String(item.sk).startsWith("CODE_MILESTONE#"));
    expect(rows.filter((row) => row["kind"] === "merged")).toHaveLength(1);
    expect(await w.world.store.get(recoveryRowKey(TASK_ID))).toBeUndefined();
    // A second sweep has nothing to read.
    expect(await w.tracking.sweep()).toEqual({ attempted: 0 });
  });

  it("reads who a person is through the seam the host passed, not a sole owner", async () => {
    const w = await host();
    expect(w.tracking.deps.people).toBe(w.people);
    // The pull request is open and approved: the pass asks the host's seam who asked for the task.
    await w.tracking.sweep();
    expect(w.requested).toContain("requestersOf");
  });

  it("runs one session sweep and delivers one notice through the host's own words", async () => {
    const w = await host();
    await writeNotifyPrefs({ store: w.h.store, now: () => new Date(w.clock.ms) }, ORG, OWNER_ID, { targets: [{ channel: "examplechat", conversation: CONVERSATION }], muted: false });
    // The summary written at creation has no status-model words: its first refresh is not announced.
    await w.sessions.refresh(ORG, SESSION);
    w.clock.ms += 1_000;
    w.state.facts = { ...w.state.facts, workflow: { stage: "PLAN_REVIEW", state: "WAITING" }, step: "Waiting for approval" };
    expect(await w.sessions.sweep()).toMatchObject({ visited: 1, updated: 1, failed: 0 });
    w.clock.ms += 6 * 60_000;
    expect(await w.notices.deliver()).toMatchObject({ people: 1, sent: 1 });
    expect(w.chat.delivered).toHaveLength(1);
    const text = (w.chat.delivered[0]!.data as { text: string }).text;
    expect(text).toContain("Add retry");
    expect(text).toContain(`https://host.example.test/sessions/${SESSION}`);
    expect(text).toContain(FOOTER);
  });

  it("queues and delivers nothing when no chat or email adapter can tell anyone", async () => {
    const w = await host();
    const none = createNoticeService({ store: w.h.store, registry: createAdapterRegistry() });
    expect(none.canNotify()).toBe(false);
    expect(await none.deliver()).toBeUndefined();
  });
});
