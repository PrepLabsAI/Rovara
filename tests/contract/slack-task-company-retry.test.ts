import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { assertTaskProjectCompany } from "../../packages/broker/src/aws/company-check.js";
import { currentWorkflowPublicationAuthorityForTask } from "../../packages/broker/src/aws/developer-tasks.js";
import { getItem } from "../../packages/broker/src/aws/cancellation.js";
import { taskKey, type DeveloperTaskRecord, developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, finishOperation, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_demoaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const USER = "U0SHARED00";
const PERSON = "a".repeat(64);
const PERSON_B = "b".repeat(64);

beforeAll(async () => { await loadSlackBroker(); }, 120_000);

const companyBinding = (company: string) => ({
  pk: `ORG#${company}#SLACK_BINDING#${SLACK_TEAM}`, sk: `CHANNEL#${SLACK_CHANNEL}`, channelId: SLACK_CHANNEL,
  projectName: "demo-tasklog", teamId: SLACK_TEAM, updatedBy: "e".repeat(64), updatedAt: "2026-10-27T15:07:04.991Z", entityType: "SLACK_BINDING",
});

const companyProject = (company: string, name: string) => ({
  pk: `ORG#${company}#PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", companyId: company,
  definition: { name, revision: 1, orchestratorInstructions: "x", setup: [], readiness: [],
    repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }] },
});

async function world() {
  const github = {
    reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
    getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
    getPullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", state: "open", headBranch: "x", baseBranch: "main", headCommit: "d".repeat(40), title: "Fix retry", body: "" })),
    updatePullRequest: vi.fn(),
    getPullRequestFeedback: vi.fn(async () => ({ pullRequest: { number: 42, url: "https://github.com/example/demo/pull/42", state: "open", headBranch: "x", baseBranch: "main", headCommit: "d".repeat(40), title: "Fix retry", body: "", headTreeSha: "b".repeat(40) }, comments: [], threads: [] })),
  };
  const h = await createSingleAnswerPlanBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }), brokerExtra: { githubPullRequests: github } });
  h.db.set(companyProject(A, "demo-tasklog"));
  h.db.set(companyProject(B, "b-project"));
  const store = new MemoryDocumentStore();
  const members = new Map([[PERSON, A], [PERSON_B, B]]);
  const companyOfTeam = vi.fn(async (team: string): Promise<string> => { if (team === SLACK_TEAM) return A; throw Error("private"); });
  const workspaces = { store, getProject: async () => ({ companyId: A }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: companyOfTeam, tokenForEvent: vi.fn(async () => ({ companyId: A, token: "x" })) };
  const code = await issueChannelLinkCode({ store, orgId: A, now: Date.now }, { channel: "slack", tenant: SLACK_TEAM, userId: USER });
  await redeemChannelLinkCode({ store, orgId: A, now: Date.now }, PERSON, code.code);
  const entry: CoreTaskEntry = { route: async () => undefined, recordThread: vi.fn(async () => true) };
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, store, workspaces, companies: { companyOf: async (id: string) => members.get(id) },
    slackWorkspaceLegacyTeamId: SLACK_TEAM, developer: { ...h.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: entry } } as never);
  const start = () => handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" },
    userId: USER, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: randomUUID() });
  return { ...h, handler, start };
}

async function pendingTask() {
  const w = await world();
  const registered = w.db.get("PROJECT#payments", "REV#000000000001")!;
  const definition = registered.definition as Record<string, unknown>;
  w.db.set({ ...registered, pk: "PROJECT#demo-tasklog", sk: "REV#000000000001", companyId: A,
    definition: { ...definition, name: "demo-tasklog", revision: 1 } });
  w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#demo-tasklog", entityType: "PROJECT_CATALOG", name: "demo-tasklog", latestRevision: 1 });
  w.db.set(companyBinding(A));
  w.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "demo-tasklog", role: "developer" });
  const started = await w.start();
  expect(started.statusCode, started.body).toBe(200);
  const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
  expect(task).toMatchObject({ companyId: A });
  const workspaceId = String(task.workspaceId);
  const prepare = w.db.find((item) => item.workspaceId === workspaceId && item.kind === "prepare")[0]!;
  return { w, taskId, workspaceId, prepare };
}

async function startedTask() {
  const { w, taskId, workspaceId, prepare } = await pendingTask();
  await finishOperation(w.handler, w.db, workspaceId, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
  const plan = w.db.find((item) => item.workspaceId === workspaceId && item.kind === "task")[0]!;
  await finishOperation(w.handler, w.db, workspaceId, String(plan.id), "FAILED");
  return { w, taskId, workspaceId };
}

describe("Slack workflow retry project rows are checked against the task company", () => {
  it("the shared helper accepts only a valid task company and its own legacy row", () => {
    const ownRow = { pk: "PROJECT#demo-tasklog", companyId: A };
    expect(() => assertTaskProjectCompany({ companyId: A }, ownRow)).not.toThrow();
    expect(() => assertTaskProjectCompany({}, ownRow)).toThrow("Slack channel is not bound to a project");
    expect(() => assertTaskProjectCompany({ companyId: "bad-company-id" }, ownRow)).toThrow("Slack channel is not bound to a project");
  });

  it.each(["built-in", "company B", "own company", "missing companyId", "malformed companyId"])("retry handles a %s namesake safely", async (caseName) => {
    const { w, taskId, workspaceId } = await startedTask();
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    if (caseName === "missing companyId" || caseName === "malformed companyId") {
      const saved = { ...task };
      if (caseName === "missing companyId") delete saved.companyId;
      else saved.companyId = "bad-company-id";
      w.db.set(saved);
    }
    const base = w.db.get("PROJECT#demo-tasklog", "REV#000000000001")!;
    const { companyId: _companyId, ...legacy } = base;
    void _companyId;
    const foreign = { ...legacy, ...(caseName === "company B" ? { companyId: B } : {}), sk: "REV#000000000002",
      definition: { ...(base.definition as Record<string, unknown>), revision: 2 } };
    const own = { ...base, sk: "REV#000000000002", companyId: A,
      definition: { ...(base.definition as Record<string, unknown>), revision: 2 } };
    w.db.set(caseName === "own company" || caseName === "missing companyId" || caseName === "malformed companyId" ? own : foreign);
    const before = structuredClone(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX"));
    const result = await w.handler({ source: "agentx.slack-ingress", action: "workflow-retry", step: "plan", selectedOptionalCheckIds: [], taskId, userId: USER,
      thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" }, requestId: randomUUID(), expectedRevision: (task.workflow as { revision: number }).revision });
    if (caseName === "own company") {
      expect(result.statusCode, result.body).toBe(200);
      expect(w.db.find((item) => item.workspaceId === workspaceId && item.kind === "task" && item.settingsRevision === 2 && item.workflowMode === "PLAN")).toHaveLength(1);
    } else {
      expect(result.statusCode, result.body).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ refused: true });
      expect(result.body).not.toMatch(/builtin|secret|private/);
      expect(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX")).toEqual(before);
    }
  });
});

function revision(w: Awaited<ReturnType<typeof world>>, number: number, companyId?: string) {
  const base = w.db.get("PROJECT#demo-tasklog", "REV#000000000001")!;
  const row: Record<string, unknown> = { ...base, sk: `REV#${String(number).padStart(12, "0")}`, definition: { ...(base.definition as Record<string, unknown>), revision: number } };
  delete row.companyId;
  if (companyId !== undefined) row.companyId = companyId;
  w.db.set(row);
}

describe("persisted task scope on preparation and pinned planning reads", () => {
  it.each(["built-in", "company B", "missing companyId", "malformed companyId", "own company"])("preparation queues only an own-company latest row: %s", async (caseName) => {
    const { w, taskId, workspaceId, prepare } = await pendingTask();
    const task = { ...w.db.get(`DEVTASK#${taskId}`, "META")! };
    if (caseName === "missing companyId") delete task.companyId;
    if (caseName === "malformed companyId") task.companyId = "bad-company-id";
    w.db.set(task);
    revision(w, 2, caseName === "built-in" ? undefined : caseName === "company B" ? B : A);
    const before = w.db.find(row => row.entityType === "OUTBOX").length;
    await finishOperation(w.handler, w.db, workspaceId, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
    const queued = w.db.find(row => row.workspaceId === workspaceId && row.kind === "task");
    if (caseName === "own company") {
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ settingsRevision: 2, workflowMode: "PLAN" });
    } else {
      expect(queued).toHaveLength(0);
      expect(w.db.find(row => row.entityType === "OUTBOX")).toHaveLength(before);
      expect(w.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${String(prepare.id)}`)).toMatchObject({ status: "FAILED" });
    }
  });

  it.each([undefined, B])("planning refuses a foreign pinned row with own-company latest (%s)", async (companyId) => {
    const { w, taskId, workspaceId } = await startedTask();
    revision(w, 2, A);
    revision(w, 1, companyId);
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    const before = structuredClone(w.db.find(row => row.kind === "task" || row.entityType === "OUTBOX"));
    const result = await w.handler({ source: "agentx.slack-ingress", action: "workflow-retry", step: "plan", selectedOptionalCheckIds: [], taskId, userId: USER,
      thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" }, requestId: randomUUID(), expectedRevision: (task.workflow as { revision: number }).revision });
    expect(JSON.parse(result.body)).toMatchObject({ refused: true });
    expect(w.db.find(row => row.kind === "task" || row.entityType === "OUTBOX")).toEqual(before);
    expect(w.db.find(row => row.workspaceId === workspaceId && row.settingsRevision === 2 && row.kind === "task")).toHaveLength(0);
  });
});

async function approvalReady() {
  const context = await pendingTask();
  const { w, workspaceId, prepare } = context;
  const task = w.db.get(`DEVTASK#${context.taskId}`, "META")!;
  const workflow = task.workflow as Record<string, unknown>;
  w.db.set({ ...task, workflow: { ...workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  await finishOperation(w.handler, w.db, workspaceId, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
  const plan = w.db.find(row => row.workspaceId === workspaceId && row.workflowMode === "PLAN")[0]!;
  const markdown = "# Plan\n\n1. Fix the retry.\n2. Add a regression test.\n";
  const artifactDigest = await finishPlanningWithMarkdown(w, workspaceId, String(plan.id), markdown);
  const approve = () => {
    const task = w.db.get(`DEVTASK#${context.taskId}`, "META")!;
    return w.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId: context.taskId, userId: USER,
      thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" }, requestId: randomUUID(), expectedRevision: (task.workflow as { revision: number }).revision,
      artifactDigest, decision: "APPROVE", reason: "Approved", selectedOptionalCheckIds: [] });
  };
  return { ...context, approve };
}

describe("pinned plan approval, later steps and publication", () => {
  it.each([undefined, B, A])("approval checks the pinned row even with own-company latest (%s)", async (companyId) => {
    const { w, workspaceId, approve } = await approvalReady();
    revision(w, 2, A);
    revision(w, 1, companyId);
    const before = structuredClone(w.db.find(row => row.kind === "task" || row.entityType === "OUTBOX"));
    const response = await approve();
    if (companyId === A) {
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.parse(response.body), response.body).not.toHaveProperty("refused");
      expect(w.db.find(row => row.workspaceId === workspaceId && row.workflowMode === "IMPLEMENT")).toHaveLength(1);
    } else {
      expect(JSON.parse(response.body)).toMatchObject({ refused: true });
      expect(w.db.find(row => row.kind === "task" || row.entityType === "OUTBOX")).toEqual(before);
    }
  });

  it.each([undefined, B, A])("a later CHECKS step uses the persisted company with no Slack caller (%s)", async (companyId) => {
    const { w, workspaceId, taskId } = await startedTask();
    revision(w, 2, companyId);
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    // Deliberately a non-Slack caller: the stored task is still the authority.
    const identity = developerTaskIdentity({ taskId, developerId: PERSON, provider: "slack", developerName: "Rovara member", client: "tool", companyId: B });
    const accept = () => w.actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId: String(task.conversationId), prompt: "Run the checks" }, () => [], { workflowMode: "CHECKS" });
    if (companyId === A) expect((await accept()).operation).toMatchObject({ workflowMode: "CHECKS" });
    else await expect(accept()).rejects.toThrow("Slack channel is not bound to a project");
  });

  it.each([undefined, B, A])("publication checks the pinned row with own-company latest (%s)", async (companyId) => {
    const { w, workspaceId, taskId } = await startedTask();
    const task = { ...w.db.get(`DEVTASK#${taskId}`, "META")! };
    // An existing non-workflow task also reaches publicationProject and must use its persisted company.
    delete task.workflow;
    w.db.set(task);
    revision(w, 2, A);
    revision(w, 1, companyId);
    const before = structuredClone(w.db.find(row => row.kind === "publish" || row.entityType === "OUTBOX"));
    const identity = developerTaskIdentity({ taskId, developerId: PERSON, provider: "slack", developerName: "Rovara member", client: "tool" });
    const publish = () => w.actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix retry", body: "Verified retry fix", draft: true }, () => []);
    if (companyId === A) expect((await publish()).operation).toMatchObject({ kind: "publish" });
    else {
      await expect(publish()).rejects.toThrow("Slack channel is not bound to a project");
      expect(w.db.find(row => row.kind === "publish" || row.entityType === "OUTBOX")).toEqual(before);
    }
  });

  it("catalog repair checks every latest history read against the supplied persisted scope", async () => {
    const { w } = await startedTask();
    w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#demo-tasklog", entityType: "PROJECT_CATALOG", name: "demo-tasklog" });
    revision(w, 2, B);
    await expect(w.actions.ensureProjectCatalogPointer("demo-tasklog", { companyId: A })).rejects.toThrow("Slack channel is not bound to a project");
    expect(w.db.get("PROJECT_CATALOG", "PROJECT#demo-tasklog")).not.toHaveProperty("latestRevision");
  });

  it("own company completes planning, approval, implementation, review and publication", async () => {
    const { w, workspaceId, taskId, approve } = await approvalReady();
    const approval = await approve();
    expect(JSON.parse(approval.body), approval.body).not.toHaveProperty("refused");
    expect(approval.statusCode, approval.body).toBe(200);
    const implementation = w.db.find(row => row.workspaceId === workspaceId && row.workflowMode === "IMPLEMENT")[0]!;
    const repositories = [{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }];
    await finishOperation(w.handler, w.db, workspaceId, String(implementation.id), "SUCCEEDED", {
      workflowCandidateRepositories: repositories, workflowCheckCandidateRepositories: repositories,
      checks: { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
        checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" },
    });
    const review = w.db.find(row => row.workspaceId === workspaceId && row.workflowMode === "REVIEW")[0]!;
    const workflow = w.db.get(`DEVTASK#${taskId}`, "META")!.workflow as { candidate: { digest: string } };
    await finishOperation(w.handler, w.db, workspaceId, String(review.id), "SUCCEEDED", { workflowCandidateRepositories: repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: String(review.id), candidateDigest: workflow.candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() })) });
    const publication = w.db.find(row => row.workspaceId === workspaceId && row.kind === "publish");
    expect(publication).toHaveLength(1);
    expect(publication[0]).toMatchObject({ settingsRevision: 1, kind: "publish" });
    const task = (await getItem<DeveloperTaskRecord>({ documentClient: w.db, tableName: "state" }, taskKey(taskId)))!;
    const authority = () => currentWorkflowPublicationAuthorityForTask({ actions: w.actions, tableName: "state" }, task);
    expect(await authority()).toMatchObject({ mode: "CHECKED_TREE", pinnedRevision: 1 });
    revision(w, 2, A);
    for (const companyId of [undefined, B]) {
      revision(w, 1, companyId);
      await expect(authority()).rejects.toThrow("Slack channel is not bound to a project");
    }
    revision(w, 1, A);
    revision(w, 2, B);
    await expect(authority()).rejects.toThrow("Slack channel is not bound to a project");
    // Restore the exact admitted revision set before the worker's completion.
    w.db.delete("PROJECT#demo-tasklog", "REV#000000000002");
    // Complete through the same result callback; publication's repository is checked again there.
    const p = publication[0]!.publication as { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body?: string };
    await w.callback(workspaceId, String(publication[0]!.id), "pull-request", { repository: p.repository, repositoryUrl: p.repositoryUrl, headBranch: p.headBranch, baseBranch: p.baseBranch, commit: "d".repeat(40), title: p.title, ...(p.body === undefined ? {} : { body: p.body }) });
    await finishOperation(w.handler, w.db, workspaceId, String(publication[0]!.id), "SUCCEEDED", { repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headBranch: p.headBranch, commit: "d".repeat(40), baseBranch: "main", checks: [], reconciled: false });
    expect(w.db.get(`DEVTASK#${taskId}`, "META")!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ number: 42 }] });
  });
});
