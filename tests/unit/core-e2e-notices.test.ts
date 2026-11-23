import { describe, expect, it } from "vitest";
import { buildE2ESharedView, createCandidateManifest, createWorkflowSnapshot, IMPLICIT_COMPANY_ID, type ChannelEvent, type OrgId } from "@agentx/contracts";
import { createWorkflowE2EDisplayObject } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { applicationE2ENotice, applicationNoticeText } from "../../packages/broker/src/core/e2e/application-notices.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import { createNoticeService, type NoticeServiceOptions } from "../../packages/broker/src/services/notices.js";
import { failedBaseline, fiveScenarios, row } from "../support/e2e-scenario-results.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const AT = "2026-11-21T12:00:00.000Z";
const TASK = "44444444-4444-4444-8444-444444444444";
const d = (char: string) => char.repeat(64);
async function world(rows = fiveScenarios()) {
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: ORG });
  const workflow = createWorkflowSnapshot({ taskId: TASK, ownerId: d("a"), now: AT });
  workflow.stage = "VERIFY";
  workflow.candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const task: ApplicationTask = { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, developerId: "owner", provider: "local", developerName: "Owner", client: "web", project: "demo", companyId: ORG, title: "Orders", workspaceId: "workspace", ownerKey: "owner", conversationId: "conversation", startingRevision: 1, charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "org", sk: "counter" } }, shared: false, createdAt: AT, updatedAt: AT, workflow };
  const current = { candidateDigest: workflow.candidate.digest, roundId: "11111111-1111-4111-8111-111111111111", groupRunIds: ["22222222-2222-4222-8222-222222222222"], admissionSha256: d("b"), evidenceSha256: d("c") };
  workflow.e2e = { required: true, contractDigest: d("a"), policyDigest: d("b"), bundleDigest: d("c"), executionPlanDigest: d("d"), currentRoundId: current.roundId, currentGroupRunIds: current.groupRunIds, resultRefs: [] };
  const display = createWorkflowE2EDisplayObject({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, current, capturedAt: AT,
    view: buildE2ESharedView({ plan: null, currentRound: null, results: [], setup: null, actor: "viewer" }), scenarioResults: { scenarios: rows, baseline: failedBaseline() } })!;
  await objects.put(display.ref.key, display.bytes, { contentType: "application/json", metadata: {}, retention: "task-document" });
  task.workflow.e2e!.displayRef = display.ref;
  return { task, store, objects, display };
}

async function delivery(options: { allowed?: boolean; otherCompany?: boolean; projectionFails?: boolean } = {}) {
  const w = await world();
  const owner = localOwnerPrincipal();
  const ownerId = developerIdOf(owner);
  const sessionId = taskSessionId(TASK);
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  const events: ChannelEvent[] = [];
  adapter.deliver = async (event) => { events.push(event); };
  registry.register("channel", "examplechat", adapter);
  let projectionReads = 0;
  const extra: Pick<NoticeServiceOptions, "e2e"> = { e2e: async () => { projectionReads += 1; if (options.projectionFails) throw new Error("unavailable"); return applicationE2ENotice(w.objects, w.task); } };
  const notices = createNoticeService({ store: w.store, registry, now: () => new Date(AT), access: async () => options.allowed === false ? undefined : { owner: true },
    companyOf: () => options.otherCompany === true ? "org_11111111111111111111" : ORG,
    log: () => undefined, thread: async () => ({ personId: ownerId, conversation: { channel: "examplechat", tenant: "team", space: "room", thread: "thread" } }), ...extra });
  await w.store.transact(createTaskSessionItems({ orgId: ORG, sessionId, taskId: TASK, project: "demo", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Orders", owner, origin: "app", payer: { kind: "member", developerId: ownerId }, now: AT }));
  let facts: SessionTaskFacts = { companyId: ORG, taskId: TASK, project: "demo", ownerDeveloperId: ownerId, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: AT };
  const deps: SummaryDependencies = { store: w.store, facts: { read: async () => facts }, cost: { costUsd: async () => 0 }, now: () => new Date(AT), onChange: [(change) => notices.queue(change)] };
  await refreshSessionSummary(deps, ORG, sessionId);
  facts = { ...facts, workflow: { stage: "VERIFY", state: "BLOCKED" }, step: "Verification" };
  await refreshSessionSummary(deps, ORG, sessionId);
  return { ...w, notices, events, reads: () => projectionReads };
}

describe("core E2E notice projection", () => {
  it("renders a nonempty per-scenario summary with a separate baseline and snapshot label", async () => {
    const w = await world();
    const blocks = await applicationE2ENotice(w.objects, w.task, "https://example.test/task");
    expect(blocks?.length).toBeGreaterThan(0);
    expect(JSON.stringify(blocks)).toContain("4 passed");
    expect(JSON.stringify(blocks)).toContain("1 failed");
    expect(JSON.stringify(blocks)).toContain("Before the change: 2 of 5 failed");
    expect(JSON.stringify(blocks)).toContain("snapshot, not a recheck");
  });

  it("suppresses stale and coding displays and refuses changed object bytes", async () => {
    const w = await world();
    w.task.workflow.stage = "IMPLEMENT";
    expect(await applicationE2ENotice(w.objects, w.task)).toBeUndefined();
    w.task.workflow.stage = "VERIFY";
    w.task.workflow.e2e!.currentRoundId = "33333333-3333-4333-8333-333333333333";
    expect(await applicationE2ENotice(w.objects, w.task)).toBeUndefined();
    w.task.workflow.e2e!.currentRoundId = w.display.ref.roundId;
    expect(await applicationE2ENotice({ ...w.objects, get: async () => new Uint8Array(w.display.bytes.length) }, w.task)).toBeUndefined();
  });

  it("redacts labelled encoded credentials in every displayed free-text field without an empty projection", async () => {
    const secret = "SyntheticProjectionCredential734";
    const spellings = [...new Set([secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), encodeURIComponent(secret), Buffer.from(secret).toString("hex"), Buffer.from(secret).toString("hex").toUpperCase(), [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")])];
    const w = await world(spellings.map((value, index) => row({ scenarioId: `credential-${index}`, status: "UNKNOWN", reason: `password=${value}`, title: `password=${value}` })));
    const blocks = await applicationE2ENotice(w.objects, w.task);
    expect(blocks?.length).toBeGreaterThan(0);
    expect(w.display.bytes.length).toBeGreaterThan(500);
    const surfaces = [JSON.stringify(blocks), Buffer.from(w.display.bytes).toString("utf8")];
    for (const value of spellings) for (const surface of surfaces) expect(surface.includes(value)).toBe(false);
  });

  it("delivers results with the existing attention notice once", async () => {
    const w = await delivery();
    expect(await w.notices.deliver()).toMatchObject({ sent: 1 });
    expect(JSON.stringify(w.events)).toContain("4 passed");
    expect(JSON.stringify(w.events)).toContain("Before the change: 2 of 5 failed");
    expect(await w.notices.deliver()).toMatchObject({ sent: 0 });
    expect(w.events).toHaveLength(1);
  });

  it("does not load private results for revoked access or a foreign chat tenant", async () => {
    for (const options of [{ allowed: false }, { otherCompany: true }]) {
      const w = await delivery(options);
      await w.notices.deliver();
      expect(w.events).toHaveLength(0);
      expect(w.reads()).toBe(0);
    }
  });

  it("still delivers the attention notice when its results cannot be read", async () => {
    const w = await delivery({ projectionFails: true });
    expect(await w.notices.deliver()).toMatchObject({ sent: 1 });
    expect(w.events).toHaveLength(1);
  });
});

it("drops malformed channel blocks before reading their text", () => {
  expect(applicationNoticeText([null, false, "text", {}, { text: null }, { text: { text: 12 } }, { text: { text: "Current result" } }])).toBe("Current result");
});
