// Opus review of cd28c6fcf (browser testing Code A+B): probes of the authority and continuity edges the lane's own tests do not reach.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WEB_API_RUNTIME_PROFILE_ID, createWorkflowSnapshot, projectPk, projectRevisionKey, type E2ESourceSnapshot, type JsonValue } from "@agentx/contracts";
import type { BrowserTestingView } from "../../packages/broker/src/core/setup-agent/browser-testing.js";
import { createApplicationPlanningContext } from "../../packages/broker/src/core/e2e/application-planning.js";
import { setupApplyDigest, setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { setupDecisionRequestId } from "../../packages/broker/src/core-host/setup-approval.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { browserGet, browserPost, browserWorld, type BrowserWorld } from "../support/browser-testing-world.js";
import { snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";

const accountsApp = readFileSync(new URL("../fixtures/e2e-accounts-app/package.json", import.meta.url), "utf8");
const ACCOUNTS = snapshotOf({ "package.json": accountsApp, "seed.mjs": "// seeds from the accounts file\n" });
const uuid = () => randomUUID();
const view = async (w: BrowserWorld, caller = w.owner) => (await w.call(browserGet(), caller)).body as unknown as BrowserTestingView;

async function waitingReady(w: BrowserWorld): Promise<void> {
  await w.refresh();
  const revision = (await view(w)).draft!.revision;
  expect((await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: revision }), w.owner)).status).toBe(200);
  await w.passCheck();
}
async function approveBrowser(w: BrowserWorld): Promise<void> {
  await waitingReady(w);
  const offer = (await view(w)).candidate!.approval!;
  const answer = await w.call(browserPost("decision", { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), w.owner);
  expect(answer.status, answer.raw).toBe(200);
}

function planningTask(w: BrowserWorld, revision: number, snapshot: E2ESourceSnapshot): ApplicationTask {
  const workflow = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: new Date(w.world.clock.now).toISOString() });
  return { pk: `DEVTASK#${workflow.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: workflow.taskId, companyId: FAKE_COMPANY, project: "payments", startingRevision: revision, workflow,
    preparedBase: [{ repositoryId: "demo", baseCommitSha: snapshot.commitSha }], developerId: "developer-a", provider: "local-owner", developerName: "Owner", client: "test", title: "Change", workspaceId: "22222222-2222-4222-8222-222222222222",
    ownerKey: "a".repeat(64), conversationId: "33333333-3333-4333-8333-333333333333", shared: false, createdAt: new Date(w.world.clock.now).toISOString(), updatedAt: new Date(w.world.clock.now).toISOString(),
    charge: { member: { pk: "m", sk: "LIMIT" }, organization: { pk: "o", sk: "LIMIT" } } };
}
function planningPorts(w: BrowserWorld) {
  const row = webApiRow("web");
  return {
    project: async (task: ApplicationTask) => await w.world.store.get(projectRevisionKey(FAKE_COMPANY, task.project, task.startingRevision)) as never,
    readText: async (key: string) => { const bytes = w.objects.map.get(key); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); },
    readyRuntimes: async () => [{ kind: "web" as const, profileId: WEB_API_RUNTIME_PROFILE_ID, supportedSteps: row.capabilities.supportedSteps, supportedAssertions: row.capabilities.supportedAssertions }],
    accounts: async () => [],
    paused: async () => (await w.world.store.get({ pk: projectPk(FAKE_COMPANY, "payments"), sk: "E2E_BROWSER_STATE" }))?.["paused"] === true,
  };
}

describe("OPUS R1: every change to browser testing is a live company owner or admin, on every route", () => {
  it("a project administrator cannot drop a waiting browser testing change through the ordinary setup route's discard", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await waitingReady(w);
    const discarded = await w.call({ method: "POST", path: "/v1/app/projects/payments/setup-agent/discard", headers: {}, body: JSON.stringify({ requestId: uuid() }) }, w.projectAdmin);
    // Rejecting it is refused to them (the decision's own rule); dropping it must be too: it is the same outcome by another door.
    expect(discarded.status, discarded.raw).toBe(403);
    expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toMatchObject({ state: "checking" });
  });
});

describe("OPUS R2: an approved browser testing setup survives a later ordinary setup approval", () => {
  it("after a setup run's commands change is approved on top, the page still reads 'on' and new plans still get the approved, source-backed context", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await approveBrowser(w);
    expect(await w.latestRevision()).toBe(2);
    expect((await view(w)).state).toBe("on");
    // A setup run's ordinary candidate on top of revision 2 (its definition carries the approved e2e policy forward, as confirmSetupAgent does).
    const base = (await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2)))!["definition"] as Record<string, unknown>;
    const definition = { ...base, revision: 3, setup: [{ cwd: "repo/demo", executable: "npm", args: ["install"], timeoutSeconds: 600 }] } as Record<string, unknown> & { setup: never; readiness: never };
    await w.world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 3), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
    const workspaceId = uuid();
    await w.world.store.put({ item: { ...workspaceKey(FAKE_COMPANY, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: FAKE_COMPANY, orgId: FAKE_COMPANY, status: "READY" } });
    const digest = setupApplyDigest(definition.setup, definition.readiness);
    const at = new Date(w.world.clock.now).toISOString();
    await w.world.store.put({ item: { ...setupApplyKey(FAKE_COMPANY, "payments"), entityType: "SETUP_APPLY", orgId: FAKE_COMPANY, project: "payments", taskId: "", requestId: uuid(), by: "p-owner", digest, baseRevision: 2, candidateRevision: 3,
      state: "checking", check: { workspaceId, revision: 3, startedAt: at, startedBy: "p-owner" }, reply: {}, createdAt: at } });
    const decided = await w.call({ method: "POST", path: "/v1/app/projects/payments/setup-agent/decide", headers: {}, body: JSON.stringify({ requestId: setupDecisionRequestId(digest, 3), outcome: "approve", seen: { revision: 3, artifactDigest: digest } }) }, w.owner);
    expect(decided.status, decided.raw).toBe(200);
    expect(await w.latestRevision()).toBe(3);
    // The policy is still in force (revision 3's definition carries it): the page must say so, and the planning seam must still have the approved setup to plan and renew from.
    const after = await view(w);
    expect(after.state).toBe("on");
    expect(after.faults).not.toContain("sandbox-unavailable");
    const { preparedBase: _prepared, ...unprepared } = planningTask(w, 3, ACCOUNTS);
    void _prepared;
    expect(await createApplicationPlanningContext(planningPorts(w))(unprepared)).toMatchObject({ status: "available", source: { origin: "approved-setup" } });
  });
});

describe("OPUS missing tests (pass on cd28c6fcf; each kills a mutant the lane's tests let through)", () => {
  it("the page offers Approve only to a live company owner or admin: a project administrator reads the waiting change with canApprove false", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await waitingReady(w);
    expect((await view(w, w.owner)).candidate).toMatchObject({ status: "ready", canApprove: true });
    expect((await view(w, w.admin)).candidate).toMatchObject({ status: "ready", canApprove: true });
    expect((await view(w, w.projectAdmin)).candidate).toMatchObject({ status: "ready", canApprove: false });
    expect((await view(w, w.developer)).candidate).toMatchObject({ status: "ready", canApprove: false });
  });

  it("the digest the approver signs is bound to the stored proposal: the same commands with other choices are another digest, so an old decision id cannot answer for a new candidate", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await waitingReady(w);
    const first = (await view(w)).candidate!.approval!;
    expect((await w.call(browserPost("discard", { requestId: uuid() }), w.owner)).status).toBe(200);
    const draft = (await view(w)).draft!;
    expect((await w.call({ method: "PUT", path: "/v1/app/projects/payments/browser-testing/draft", headers: {}, body: JSON.stringify({ requestId: uuid(), expectedDraftRevision: draft.revision, proof: { screenshotMode: "all", video: true } }) }, w.owner)).status).toBe(200);
    const next = (await view(w)).draft!.revision;
    expect((await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: next }), w.owner)).status).toBe(200);
    await w.passCheck();
    const second = (await view(w)).candidate!.approval!;
    // Same base, same commands, same candidate revision: only the proposal differs, and the digest (and so the decision id) must follow it.
    expect(second.revision).toBe(first.revision);
    expect(second.artifactDigest).not.toBe(first.artifactDigest);
    expect(second.requestId).not.toBe(first.requestId);
    const stale = await w.call(browserPost("decision", { requestId: first.requestId, outcome: "approve", seen: { revision: first.revision, artifactDigest: first.artifactDigest } }), w.owner);
    expect(stale.status).toBe(409);
    expect(await w.latestRevision()).toBe(1);
  });
});
