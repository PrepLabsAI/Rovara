// DEC 254zzz80 (R2-F1): the broker's Slack start (startSlackWorkflow) reads the channel's binding in the team's company's layout. A NAMED company's binding is only its own row,
// `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>`; a leftover legacy row binds nothing for it. The install team whose operator binding names a NAMED company (staging:
// T0BSHLLUGBD -> org_demo…) starts as that company: its linked person, its own binding, the core. The built-in company keeps the single-workspace start exactly.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, slackAnswerThreadId } from "@agentx/contracts";
import type { SlackThreadAnswerInput } from "../../packages/broker/src/core-host/dev-routes.js";
import { SLACK_WEB_SIGNIN_NOTICE } from "../../packages/broker/src/aws/slack-action-classes.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace, finishOperation, loadSlackBroker, orchestratorPrincipal } from "../support/slack-broker.js";
import { swebenchDeploymentForTests } from "../support/eval-batch-admin.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";

const A = "org_demoaaaaaaaaaaaaaaaa"; // the staging company
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const OTHER_TEAM = "T0OTHER0001";
const USER = "U0SHARED00";
const PERSON = "a".repeat(64);
const USER_B = "U0SHARED0B";
const PERSON_B = "b".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => { await loadSlackBroker(); }, 120_000);

/** The staging binding row, as Cloud wrote it. */
const companyBinding = (company: string, team = SLACK_TEAM, project = "demo-tasklog") => ({
  pk: `ORG#${company}#SLACK_BINDING#${team}`, sk: `CHANNEL#${SLACK_CHANNEL}`, channelId: SLACK_CHANNEL, projectName: project, teamId: team,
  updatedBy: "e".repeat(64), updatedAt: "2026-10-27T15:07:04.991Z", entityType: "SLACK_BINDING",
});

/** A NAMED company's project revision in its own partition (schema-valid, as staging's). */
const companyProject = (company: string, name: string) => ({
  pk: `ORG#${company}#PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", companyId: company,
  definition: { name, revision: 1, orchestratorInstructions: "x", setup: [{ executable: "npm", args: ["ci"], cwd: "repo/r", timeoutSeconds: 900 }],
    readiness: [{ executable: "npm", args: ["test"], cwd: "repo/r", timeoutSeconds: 900 }],
    repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }] },
});

/**
 * A broker with Slack company mode on. `installCompany` is what the install team's (SLACK_TEAM's) operator binding names; OTHER_TEAM is company B's (company mode). The person is
 * linked in the install team's company. `legacyInstall`: the install team takes the legacy view (slackWorkspaceLegacyTeamId), as on staging.
 */
async function world(options: { installCompany: string; legacyInstall?: boolean; core?: false; evals?: boolean }) {
  const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
  h.db.set(companyProject(A, "demo-tasklog"));
  h.db.set(companyProject(B, "b-project"));
  const store = new MemoryDocumentStore();
  const members = new Map([[PERSON, options.installCompany], [PERSON_B, B]]);
  const companyOfTeam = vi.fn(async (team: string): Promise<string> => { if (team === SLACK_TEAM) return options.installCompany; if (team === OTHER_TEAM) return B; throw Error("private"); });
  const workspaces = { store, getProject: async () => ({ companyId: options.installCompany }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: companyOfTeam, tokenForEvent: vi.fn(async () => ({ companyId: options.installCompany, token: "x" })) };
  for (const team of [SLACK_TEAM, OTHER_TEAM]) {
    const company = team === SLACK_TEAM ? options.installCompany : B;
    if (company === IMPLICIT_COMPANY_ID) continue;
    const [user, person] = team === SLACK_TEAM ? [USER, PERSON] : [USER_B, PERSON_B];
    const code = await issueChannelLinkCode({ store, orgId: company, now: Date.now }, { channel: "slack", tenant: team, userId: user });
    await redeemChannelLinkCode({ store, orgId: company, now: Date.now }, person, code.code);
  }
  const starts: Array<Record<string, unknown>> = [];
  const answers = vi.fn(async (input: SlackThreadAnswerInput) => ({ answer: {
    answerId: "a" + "b".repeat(30), threadId: input.threadId, outcome: "answered" as const,
    text: "Review the project plan.", unconfirmed: [], sources: [], wikiPages: [],
  } }));
  const route = vi.fn<(request: { body?: string }, caller?: unknown) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>>(async (request) => { starts.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>); return { statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: TASK } }) }; });
  // `core: false`: the core declines the start (a company the core does not cover answers undefined, engine-boundary.ts), so the legacy start answers it.
  const entry: CoreTaskEntry = { route: options.core === false ? async () => undefined : route, recordThread: vi.fn(async () => true) };
  const module = await loadSlackBroker();
  const swebench = options.evals ? { deployment: async () => swebenchDeploymentForTests(`111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`),
    startExecution: vi.fn(async () => ({ executionArn: "arn:aws:states:us-east-1:111122223333:execution:test:run" })), estimateRunCostUsd: () => 2 } : undefined;
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, ...(swebench === undefined ? {} : { swebench }), store, workspaces, companies: { companyOf: async (id: string) => members.get(id) },
    ...(options.legacyInstall === false ? {} : { slackWorkspaceLegacyTeamId: SLACK_TEAM }),
    developer: { ...h.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: entry, coreApp: { answerForSlackThread: answers } } } as never);
  const start = (team = SLACK_TEAM) => handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: team, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" },
    userId: team === SLACK_TEAM ? USER : USER_B, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: randomUUID() });
  return { ...h, handler, entry, route, starts, start, answers, companyOfTeam, workspaces, members };
}

describe("the Slack start reads the binding in the company's own layout", () => {
  it("staging shape: the install team of a named company starts on the core, as the linked person, for the company's own binding's project", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    const result = await w.start();
    expect(result.statusCode, result.body).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ taskId: TASK });
    expect(w.starts).toEqual([expect.objectContaining({ project: "demo-tasklog", client: "slack", workflowPath: "QUICK" })]);
    expect(w.route).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ developerId: PERSON }));
  });

  it("a named company's leftover legacy row (SLACK_BINDING#<team>) binds nothing: refused, the core is never asked", async () => {
    const w = await world({ installCompany: A });
    // createDeveloperTaskBroker registered the legacy binding of SLACK_TEAM/SLACK_CHANNEL ("payments"); A has no row of its own.
    expect(w.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeDefined();
    const result = await w.start();
    expect(result.statusCode).not.toBe(200);
    expect(w.route).not.toHaveBeenCalled();
  });

  it("two companies: company B's team never starts from A's binding of the same channel, and starts from its own", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A, OTHER_TEAM));
    expect((await w.start(OTHER_TEAM)).statusCode).not.toBe(200);
    expect(w.route).not.toHaveBeenCalled();
    w.db.set(companyBinding(B, OTHER_TEAM, "b-project"));
    const own = await w.start(OTHER_TEAM);
    expect(own.statusCode, own.body).toBe(200);
    expect(w.starts).toEqual([expect.objectContaining({ project: "b-project" })]);
    expect(w.route).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ developerId: PERSON_B }));
  });

  it("the install team's binding row of ANOTHER company is not the install team's company's", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(B));
    expect((await w.start()).statusCode).not.toBe(200);
    expect(w.route).not.toHaveBeenCalled();
  });

  it("a named company's binding to a project that is not in its own partition (another company's, or none) binds nothing", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A, SLACK_TEAM, "b-project"));
    expect((await w.start()).statusCode).not.toBe(200);
    w.db.set(companyBinding(A, SLACK_TEAM, "no-such-project"));
    expect((await w.start()).statusCode).not.toBe(200);
    expect(w.route).not.toHaveBeenCalled();
  });

  it("an administrator's unbind of a named company's channel never deletes a row the read did not find (today it is refused before any write)", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    const before = { own: w.db.get(`ORG#${A}#SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`), legacy: w.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`) };
    const answer = await call(w.handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: { subject: "admin-subject", admin: true } });
    // The install administrator's project check still reads the legacy project (R2-F1 lane 1); until then the unbind is refused and nothing is deleted, never a
    // "deleted" answer that left the company's row in place.
    expect(answer.status).toBe(404);
    expect({ own: w.db.get(`ORG#${A}#SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`), legacy: w.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`) }).toEqual(before);
  });

  it("a person not linked in the named company is refused before anything starts", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    const handler = (await loadSlackBroker()).createAwsBrokerHandler({ ...w.brokerInput, store: new MemoryDocumentStore(),
      workspaces: { store: new MemoryDocumentStore(), getProject: async () => ({ companyId: A }), linkUrl: () => "https://example.test", requireCompany: async () => A, tokenForEvent: async () => ({ companyId: A, token: "x" }) },
      companies: { companyOf: async () => undefined }, slackWorkspaceLegacyTeamId: SLACK_TEAM, developer: { ...w.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: w.entry } } as never);
    const result = await handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000009" },
      userId: USER, instructions: "Fix it", workflowPath: "QUICK", requestId: randomUUID() });
    expect(result.statusCode).toBe(403);
    expect(w.route).not.toHaveBeenCalled();
  });

  it("the built-in company's install team keeps the single-workspace start: the legacy binding and the legacy (Slack-native) caller, exactly as with company mode off", async () => {
    const run = async (companyMode: boolean) => {
      const w = await world({ installCompany: IMPLICIT_COMPANY_ID });
      w.db.set(companyBinding(A)); // another company's row is never read for the built-in company
      const handler = companyMode ? w.handler : (await loadSlackBroker()).createAwsBrokerHandler({ ...w.brokerInput, developer: { ...w.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: w.entry } } as never);
      const result = await handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" },
        userId: USER, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: "33333333-3333-4333-8333-333333333333" });
      const calls = w.route.mock.calls.map(([request, caller]) => ({ body: JSON.parse(request.body ?? "{}") as unknown, caller }));
      return { status: result.statusCode, body: result.body, calls };
    };
    const on = await run(true);
    const off = await run(false);
    expect(on.status, on.body).toBe(off.status);
    expect(on.body).toBe(off.body);
    expect(on.calls).toEqual(off.calls);
    expect(JSON.stringify(on.calls)).toContain('"project":"payments"');
    expect(JSON.stringify(on.calls)).not.toContain(PERSON);
  });
});

describe("DEC 254zzz98 (delta review H1): a named company's Slack thread never reaches a legacy project of the same name that is not its own", () => {
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1758240000.000300`;
  /** The built-in company's own project of the same name (legacy, unstamped), with its own repository and GitHub MCP tools. */
  const builtInNamesake = (companyId?: string) => ({ pk: "PROJECT#demo-tasklog", sk: "REV#000000000001", entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }),
    registeredBy: "c".repeat(64), registeredAt: "2026-11-18T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs" },
    definition: { name: "demo-tasklog", revision: 1, orchestratorInstructions: "built-in", setup: [], readiness: [],
      repositories: [{ name: "builtin", url: "https://github.com/builtin/secret.git", defaultBranch: "main", path: "repo/builtin", credentialRef: "github" }],
      integrations: { githubMcp: { tools: [{ name: "get_me", access: "read" }] } } } });

  it("the thread workspace, the GitHub MCP route and the connector route are refused; nothing is created or granted", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    w.db.set(builtInNamesake());
    const before = w.db.find(() => true).length;
    const workspace = await ensureWorkspace(w.handler, THREAD, USER);
    expect(workspace.status).toBe(403);
    expect(JSON.stringify(workspace.body)).not.toMatch(/builtin|secret/);
    expect(w.db.find(() => true).length).toBe(before);
    // A workspace of the thread's owner on that name (made before the namesake existed, say) and a legacy grant: the MCP routes refuse too.
    const ownerKey = ownerKeyForSubject("slack-thread", THREAD);
    const workspaceId = "550e8400-e29b-41d4-a716-446655440077";
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey, projectName: "demo-tasklog", projectRevision: 1,
      environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z" });
    w.db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey, projectName: "demo-tasklog", role: "developer" });
    for (const path of ["github/tools?repository=builtin", "connectors/github/tools"]) {
      const answer = await call(w.handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/${path}`, service: { principal: (await import("../support/slack-broker.js")).orchestratorPrincipal, thread: THREAD, slackUser: USER } });
      expect(answer.status, path).toBe(403);
      expect(JSON.stringify(answer.body)).not.toMatch(/get_me|builtin|secret/);
    }
  });

  it("another named company's stamped legacy row of that name is refused the same way; only a legacy row of the thread's own company could serve it", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    w.db.set(builtInNamesake(B));
    expect((await ensureWorkspace(w.handler, THREAD, USER)).status).toBe(403);
    // Control: the thread's own company's (pre-R2-F1, stamped A) legacy row is not refused by this check (whatever the workflow route then answers).
    w.db.set(builtInNamesake(A));
    const own = await ensureWorkspace(w.handler, THREAD, USER);
    expect(JSON.stringify(own.body)).not.toContain("Slack channel is not bound to a project");
    // Delta review M1: whatever the workflow wrote beside that legacy revision is the legacy grant, never one in A's own partition.
    expect(w.db.find((item) => String(item.pk).startsWith(`ORG#${A}#MEMBER#`))).toEqual([]);
    if (own.status === 200) expect(w.db.get(`MEMBER#${ownerKeyForSubject("slack-thread", THREAD)}`, "PROJECT#demo-tasklog")).toBeDefined();
  });

  it("delta review M1: a lazily prepared thread workspace beside the company's own stamped legacy revision writes the legacy grant, never one in A's partition", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    w.db.set(builtInNamesake(A));
    const answer = await call(w.handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: (await import("../support/slack-broker.js")).orchestratorPrincipal, thread: THREAD, slackUser: USER },
      body: { requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, lazyPreparation: true } });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(w.db.find((item) => String(item.pk).startsWith(`ORG#${A}#MEMBER#`))).toEqual([]);
    expect(w.db.get(`MEMBER#${ownerKeyForSubject("slack-thread", THREAD)}`, "PROJECT#demo-tasklog")).toMatchObject({ role: "developer" });
  });

  // Each fixture reaches one protected legacy read; its other revision is the company's own.
  const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1758240000.000300" };
  const service = { principal: orchestratorPrincipal, thread: THREAD, slackUser: USER };
  const workspaceId = "550e8400-e29b-41d4-a716-446655440077";
  const conversationId = "550e8400-e29b-41d4-a716-446655440078";
  const model = { provider: "amazon-bedrock", modelId: "us.vendor.batch-v1" };
  type World = Awaited<ReturnType<typeof world>>;

  function ownLegacy(w: World, revision = 1) {
    const registered = w.db.get("PROJECT#payments", "REV#000000000001")!;
    const definition = registered.definition as Record<string, unknown>;
    return { ...registered, pk: "PROJECT#demo-tasklog", sk: `REV#${String(revision).padStart(12, "0")}`, companyId: A,
      definition: { ...definition, name: "demo-tasklog", revision, models: { default: model, approved: [{ ...model, thinkingLevel: "low", label: "Batch" }] } } };
  }

  function foreignRevision(revision = 1) {
    const row = builtInNamesake();
    return { ...row, sk: `REV#${String(revision).padStart(12, "0")}`, definition: { ...row.definition, revision,
      models: { default: model, approved: [{ ...model, thinkingLevel: "low", label: "Batch" }] } } };
  }

  function existingWorkspace(w: World, status = "READY") {
    const ownerKey = ownerKeyForSubject("slack-thread", THREAD);
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey,
      projectName: "demo-tasklog", projectRevision: 1, environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`,
      rootPath: "/mnt/workspace", status, fence: 1, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z" });
    w.db.set({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META", entityType: "SLACK_THREAD", thread: THREAD, workspaceId, requesters: new Set([USER]) });
    w.db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey, projectName: "demo-tasklog", role: "developer" });
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}`, conversationId });
  }

  async function refusedWithoutWrites(w: World, route: { method: string; path: string; body?: unknown }) {
    const before = structuredClone(w.db.find(() => true));
    let writes = 0;
    w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { ...route, service });
    expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    expect(answer.body).toMatchObject({ error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } });
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret|built-in/);
    expect(w.db.find(() => true)).toEqual(before);
    expect(writes).toBe(0);
  }

  // Removing startThreadPreparation's pinned/latest wrap must fail the corresponding case.
  it.each([
    ["pinned", "PREPARATION_FAILED"], ["latest", "UNPREPARED"],
  ])("startThreadPreparation %s refuses the namesake on the prepare route", async (site, status) => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    existingWorkspace(w, status);
    w.db.set(site === "pinned" ? foreignRevision() : ownLegacy(w));
    w.db.set(site === "latest" ? foreignRevision(2) : ownLegacy(w, 2));
    await refusedWithoutWrites(w, { method: "POST", path: "/v1/service/threads/workspace/prepare", body: { requestId: randomUUID() } });
  });

  it("startThreadPreparation latest refuses an UNPREPARED namesake with lazyPreparation false", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); existingWorkspace(w, "UNPREPARED");
    w.db.set(ownLegacy(w)); w.db.set(foreignRevision(2));
    await refusedWithoutWrites(w, { method: "POST", path: "/v1/service/threads/workspace", body: { requestId: randomUUID(), lazyPreparation: false } });
  });

  // READY and PREPARATION_FAILED both reach the two existingThreadWorkspace reads.
  it.each([
    ["pinned", "READY"], ["latest", "READY"], ["pinned", "PREPARATION_FAILED"], ["latest", "PREPARATION_FAILED"],
  ])("existingThreadWorkspace %s refuses the namesake in %s", async (site, status) => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); existingWorkspace(w, status);
    w.db.set(site === "pinned" ? foreignRevision() : ownLegacy(w));
    w.db.set(site === "latest" ? foreignRevision(2) : ownLegacy(w, 2));
    await refusedWithoutWrites(w, { method: "POST", path: "/v1/service/threads/workspace", body: { requestId: randomUUID(), lazyPreparation: true } });
  });

  it("taskOperationParts via acceptTask refuses the latest namesake before queuing work", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); existingWorkspace(w); w.db.set(ownLegacy(w)); w.db.set(foreignRevision(2));
    await refusedWithoutWrites(w, { method: "POST", path: `/v1/service/workspaces/${workspaceId}/tasks`,
      body: { requestId: randomUUID(), conversationId, prompt: "Fix the flaky test" } });
  });

  it.each([
    ["pinned", "pull-requests"], ["latest", "pull-requests"], ["pinned", "pull-request-actions"], ["latest", "pull-request-actions"],
  ])("publicationProject %s refuses the namesake through %s", async (site, route) => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); existingWorkspace(w);
    w.db.set(site === "pinned" ? foreignRevision() : ownLegacy(w));
    w.db.set(site === "latest" ? foreignRevision(2) : ownLegacy(w, 2));
    await refusedWithoutWrites(w, { method: "POST", path: `/v1/service/workspaces/${workspaceId}/${route}`,
      body: { requestId: randomUUID(), repository: "demo", title: "Fix flaky test", ...(route === "pull-request-actions" ? { pullRequestNumber: 1, action: "edit" } : {}) } });
  });

  it.each(["GET", "PUT"])("%s project model refuses the namesake before reading or writing selection", async (method) => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); w.db.set(foreignRevision());
    await refusedWithoutWrites(w, { method, path: method === "GET" ? "/v1/service/project/models" : "/v1/service/project/model", ...(method === "PUT" ? { body: model } : {}) });
  });

  it.each(["swebench", "batches"])("SWE-bench projectModel refuses the namesake through service %s", async (route) => {
    const w = await world({ installCompany: A, evals: true });
    w.db.set(companyBinding(A)); w.db.set(foreignRevision());
    w.db.set({ pk: `SWEBENCH#CHANNEL#${SLACK_TEAM}`, sk: `CHANNEL#${SLACK_CHANNEL}`, teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, maxCostUsd: 5, updatedAt: "2026-11-18T00:00:00.000Z" });
    const body = route === "swebench" ? { requestId: randomUUID(), dataset: "verified", instanceId: "django__django-11099", model }
      : { dataset: "verified", instanceIds: ["django__django-11099"], models: [model], selectors: ["Batch"], repeats: 1 };
    const before = structuredClone(w.db.find(() => true));
    let writes = 0; w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { method: "POST", path: `/v1/service/evals/${route}`, service, body });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } } });
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret|built-in/);
    expect(w.db.find(() => true)).toEqual(before); expect(writes).toBe(0);
  });

  it("SWE-bench projectModel refuses the namesake through the admin batch route", async () => {
    const w = await world({ installCompany: A, evals: true });
    w.db.set(companyBinding(A)); w.db.set(foreignRevision());
    const ownerKey = ownerKeyForSubject("https://identity.example.test", "admin-subject");
    w.db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey, projectName: "demo-tasklog", role: "administrator" });
    w.db.set({ pk: `SWEBENCH#CHANNEL#${SLACK_TEAM}`, sk: `CHANNEL#${SLACK_CHANNEL}`, teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, maxCostUsd: 5, updatedAt: "2026-11-18T00:00:00.000Z" });
    const before = structuredClone(w.db.find(() => true));
    let writes = 0; w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { method: "POST", path: "/v1/admin/evals/batches", user: { subject: "admin-subject", admin: true },
      body: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, file: { benchmark: "verified", tasks: ["django__django-11099"], models: [{ ...model, thinkingLevel: "low" }], repeats: 1, costCapUsd: 30 } } });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } } });
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret|built-in/);
    expect(w.db.find(() => true)).toEqual(before); expect(writes).toBe(0);
  });

  async function startedLegacy() {
    const w = await world({ installCompany: A, core: false });
    w.db.set(companyBinding(A)); w.db.set(ownLegacy(w));
    w.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "demo-tasklog", role: "developer" });
    const answer = await w.start();
    expect(answer.statusCode, answer.body).toBe(200);
    const taskId = String((JSON.parse(answer.body) as { taskId: string }).taskId);
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    expect(task).toMatchObject({ companyId: A });
    return { w, taskId, task, workspaceId: String(task.workspaceId) };
  }

  it.each([true, false])("taskAnswerWorkspace refuses the latest namesake in a real Slack task's own thread (pointer: %s)", async (pointer) => {
    const { w, taskId, workspaceId: id } = await startedLegacy();
    // Old task threads may outlive their workspace pointer; the binding still checks every answer read.
    if (!pointer) w.db.delete(`WORKSPACE#${id}`, "DEVELOPER_TASK");
    const taskThread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1700000000.000001`;
    w.db.set(foreignRevision(2));
    const before = structuredClone(w.db.find(() => true));
    let writes = 0; w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { ...service, thread: taskThread }, body: { requestId: randomUUID(), taskAnswer: { taskId }, includeSharedTask: true } });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } } });
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret|built-in/);
    expect(w.db.find(() => true)).toEqual(before); expect(writes).toBe(0);
  });

  it("sharedThreadWorkspace refuses the latest namesake in continue mode", async () => {
    const { w, workspaceId: id } = await startedLegacy();
    const taskThread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1700000000.000001`;
    const { workflowThread: _workflowThread, ...shared } = w.db.get(`SHARED_TASK#${taskThread}`, "META")!;
    void _workflowThread;
    w.db.set({ ...shared, mode: "continue" });
    w.db.set(foreignRevision(2));
    const before = structuredClone(w.db.find(() => true));
    let writes = 0; w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { ...service, thread: taskThread }, body: { requestId: randomUUID(), includeSharedTask: true } });
    expect(w.db.get(`WORKSPACE#${id}`, "META")).toBeDefined();
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } } });
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret|built-in/);
    expect(w.db.find(() => true)).toEqual(before); expect(writes).toBe(0);
  });

  it.each(["builtin", "other-company", "own-company"])("queuedFirstTask rechecks the latest company after start: %s revision registered during preparation", async (company) => {
    const { w, workspaceId: id, taskId } = await startedLegacy();
    const prepare = w.db.find((item) => item.workspaceId === id && item.kind === "prepare")[0]!;
    const later = company === "own-company" ? ownLegacy(w, 2) : { ...foreignRevision(2), ...(company === "other-company" ? { companyId: B } : {}) };
    w.db.set(later);
    await finishOperation(w.handler, w.db, id, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
    const taskOperations = w.db.find((item) => item.workspaceId === id && item.kind === "task");
    if (company === "own-company") {
      expect(taskOperations).toHaveLength(1);
      expect(w.db.get(`WORKSPACE#${id}`, "META")).toMatchObject({ status: "BUSY", projectRevision: 1 });
    } else {
      expect(taskOperations).toEqual([]);
      expect(w.db.get(`WORKSPACE#${id}`, "META")).toMatchObject({ status: "PREPARATION_FAILED", projectRevision: 1 });
      expect(w.db.get(`WORKSPACE#${id}`, `OPERATION#${String(prepare.id)}`)).toMatchObject({ status: "FAILED" });
      const pointer = w.db.find((item) => item.taskId === taskId && item.pendingPrompt !== undefined);
      expect(pointer).toEqual([]);
      expect(w.db.find((item) => item.entityType === "OUTBOX" && item.operationId !== prepare.id && (item.invocation as { workspaceId?: string })?.workspaceId === id)).toEqual([]);
    }
  });

  it.each(["missing-task", "missing-company", "invalid-company", "null-company", "wrong-workspace"])("queued task scope refuses %s before model/integration resolution", async (kind) => {
    const { w, task, taskId, workspaceId: id } = await startedLegacy();
    const prepare = w.db.find((item) => item.workspaceId === id && item.kind === "prepare")[0]!;
    if (kind === "missing-task") w.db.delete(`DEVTASK#${taskId}`, "META");
    else {
      const saved = { ...task };
      if (kind === "missing-company") delete saved.companyId;
      else if (kind === "wrong-workspace") saved.workspaceId = randomUUID();
      else saved.companyId = kind === "null-company" ? null : "private-invalid-company";
      w.db.set(saved);
    }
    w.db.set(foreignRevision(2));
    const reads: string[] = [];
    const send = w.db.send.bind(w.db);
    vi.spyOn(w.db, "send").mockImplementation(async (command) => {
      const input = (command as { input: { Key?: { pk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (input.Key?.pk === "PROJECT#demo-tasklog" || input.ExpressionAttributeValues?.[":pk"] === "PROJECT#demo-tasklog") reads.push("project");
      return send(command);
    });
    await finishOperation(w.handler, w.db, id, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
    expect(w.db.find((item) => item.workspaceId === id && item.kind === "task")).toEqual([]);
    expect(w.db.get(`WORKSPACE#${id}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(w.db.find((item) => item.entityType === "OUTBOX" && item.operationId !== prepare.id && (item.invocation as { workspaceId?: string })?.workspaceId === id)).toEqual([]);
    expect(w.db.find((item) => item.taskId === taskId && item.pendingPrompt !== undefined)).toEqual([]);
    // An unstamped task needs the persisted project row to distinguish built-in from named ownership.
    expect(reads).toEqual(kind === "missing-company" ? ["project"] : []);
  });

  it.each(["builtin", "other-company", "foreign-pinned", "own-company"])("workflow retry retains its task company against the %s revision", async (kind) => {
    const { w, taskId, workspaceId: id } = await startedLegacy();
    const prepare = w.db.find((item) => item.workspaceId === id && item.kind === "prepare")[0]!;
    await finishOperation(w.handler, w.db, id, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
    const plan = w.db.find((item) => item.workspaceId === id && item.kind === "task")[0]!;
    await finishOperation(w.handler, w.db, id, String(plan.id), "FAILED");
    const task = w.db.get(`DEVTASK#${taskId}`, "META")!;
    w.db.set(kind === "own-company" || kind === "foreign-pinned" ? ownLegacy(w, 2) : { ...foreignRevision(2), ...(kind === "other-company" ? { companyId: B } : {}) });
    if (kind === "foreign-pinned") w.db.set(foreignRevision(1));
    const before = structuredClone(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX"));
    const result = await w.handler({ source: "agentx.slack-ingress", action: "workflow-retry", step: "plan", selectedOptionalCheckIds: [], taskId, userId: USER,
      thread: { ...thread, threadTs: "1700000000.000001" }, requestId: randomUUID(), expectedRevision: (task.workflow as { revision: number }).revision });
    if (kind === "own-company") {
      expect(result.statusCode, result.body).toBe(200);
      expect(w.db.find((item) => item.workspaceId === id && item.kind === "task" && item.status === "ACCEPTED")).toEqual([expect.objectContaining({ settingsRevision: 2, workflowMode: "PLAN" })]);
    } else {
      expect(result.statusCode, result.body).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ refused: true });
      expect(result.body).not.toMatch(/builtin|secret|private/);
      expect(w.db.find((item) => item.kind === "task" || item.entityType === "OUTBOX")).toEqual(before);
    }
  });

  it.each([true, false])("an unstamped task accepted by the old built-in install still queues with company mode %s", async (companyMode) => {
    const w = await world({ installCompany: IMPLICIT_COMPANY_ID, core: false });
    const legacy = (await loadSlackBroker()).createAwsBrokerHandler(w.brokerInput as never);
    const handler = companyMode ? w.handler : legacy;
    const answer = await legacy({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...thread, threadTs: "1700000000.000001" },
      userId: USER, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: randomUUID() });
    expect(answer.statusCode, answer.body).toBe(200);
    const taskId = String((JSON.parse(answer.body) as { taskId: string }).taskId);
    const task = { ...w.db.get(`DEVTASK#${taskId}`, "META")! };
    delete task.companyId; w.db.set(task);
    const id = String(task.workspaceId);
    const prepare = w.db.find((item) => item.workspaceId === id && item.kind === "prepare")[0]!;
    await finishOperation(handler, w.db, id, String(prepare.id), "SUCCEEDED", { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] });
    expect(w.db.find((item) => item.workspaceId === id && item.kind === "task")).toHaveLength(1);
    expect(w.db.get(`WORKSPACE#${id}`, "META")).toMatchObject({ status: "BUSY" });
  });

  it("valid-body availability: a recorded quick-start reaches the core with and without a namesake", async () => {
    const run = async (namesake: boolean) => {
      const w = await world({ installCompany: A }); w.db.set(companyBinding(A));
      if (namesake) w.db.set(builtInNamesake());
      const requestId = randomUUID();
      const recorded = await w.handler({ source: "agentx.slack-ingress", action: "intake-record", choiceId: requestId, thread, userId: USER, text: "Fix the typo in README.md" });
      expect(recorded.statusCode, recorded.body).toBe(200);
      expect(JSON.parse(recorded.body)).toMatchObject({ recorded: true });
      const answer = await call(w.handler, { method: "POST", path: "/v1/service/workflows/quick-start", service, body: { requestId } });
      expect(answer).toMatchObject({ status: 200, body: { started: true, taskId: TASK } });
      expect(w.starts).toHaveLength(1);
      const { requestId: _requestId, ...body } = answer.body; void _requestId;
      return body;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("valid-body availability: a valid answer question reaches the answer service with and without a namesake", async () => {
    const run = async (namesake: boolean) => {
      const w = await world({ installCompany: A }); w.db.set(companyBinding(A));
      if (namesake) w.db.set(builtInNamesake());
      const requestId = randomUUID();
      const answer = await call(w.handler, { method: "POST", path: "/v1/service/answers", service,
        body: { requestId, question: "What is the next step for the project?" } });
      expect(answer).toMatchObject({ status: 200, body: { status: "answered", answer: { text: "Review the project plan." } } });
      expect(w.answers).toHaveBeenCalledExactlyOnceWith({ companyId: A, personId: PERSON, project: "demo-tasklog", threadId: slackAnswerThreadId(thread),
        requestId, question: "What is the next step for the project?" });
      const { requestId: _requestId, ...body } = answer.body; void _requestId;
      return body;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("valid-body availability: a saved note in a real task-answer thread can be marked answered with and without a namesake", async () => {
    const run = async (namesake: boolean) => {
      const { w, taskId } = await startedLegacy();
      const taskThread = { ...thread, threadTs: "1700000000.000001" };
      const messageTs = "1700000000.000009";
      const saved = await w.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, thread: taskThread, userId: USER, messageTs, eventId: "EvSavedNote", text: "Why is this the next step?" });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(JSON.parse(saved.body)).toMatchObject({ outcome: "captured" });
      if (namesake) w.db.set(foreignRevision(2));
      const answer = await call(w.handler, { method: "POST", path: "/v1/service/tasks/thread-notes/answered",
        service: { ...service, thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${taskThread.threadTs}` }, body: { taskId, thread: taskThread, messageTs } });
      expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200, body: { outcome: "ANSWERED" } });
      expect(w.db.find((item) => item.entityType === "WORKFLOW_THREAD_NOTE" && item.answeredAt !== undefined)).toHaveLength(1);
      const { requestId: _requestId, ...body } = answer.body; void _requestId;
      return body;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("the built-in company's thread (legacy binding) is unchanged: no company, no check", async () => {
    const w = await world({ installCompany: IMPLICIT_COMPANY_ID });
    w.db.set(builtInNamesake());
    // The broker's registered legacy binding names "payments" (createDeveloperTaskBroker); the namesake of another name is never read for it.
    const answer = await ensureWorkspace(w.handler, THREAD, USER);
    expect(JSON.stringify(answer.body)).not.toContain("Slack channel is not bound to a project");
  });

  it("project workspace resolution refuses a namesake revision before revealing whether it exists", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    w.db.set(builtInNamesake());
    const ownerKey = ownerKeyForSubject("slack-thread", THREAD);
    w.db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey, projectName: "demo-tasklog", role: "developer" });
    const answer = await call(w.handler, { method: "GET", path: "/v1/service/projects/demo-tasklog/workspace?revision=1",
      service: { principal: (await import("../support/slack-broker.js")).orchestratorPrincipal, thread: THREAD, slackUser: USER } });
    expect(answer.status).toBe(403);
    expect(JSON.stringify(answer.body)).not.toMatch(/builtin|secret/);
  });

  it.each(["outsider", "unlinked-live-member", "linked-former-member"])("companySlackCaller refuses %s in the legacy install-team service view without writes", async (kind) => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); w.db.set(ownLegacy(w));
    const slackUser = kind === "linked-former-member" ? USER : "U0OUTSIDER";
    if (kind === "linked-former-member") w.members.delete(PERSON);
    if (kind === "unlinked-live-member") w.members.set("f".repeat(64), A);
    const before = structuredClone(w.db.find(() => true));
    let writes = 0; w.db.onWrite(() => { writes += 1; });
    const answer = await call(w.handler, { method: "GET", path: "/v1/service/project/models", service: { ...service, slackUser } });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SLACK_WEB_SIGNIN_NOTICE } } });
    expect(w.db.find(() => true)).toEqual(before); expect(writes).toBe(0);
  });

  it("companySlackCaller serves a linked live member, then refuses the same account after membership is removed", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A)); w.db.set(ownLegacy(w));
    const linked = await call(w.handler, { method: "GET", path: "/v1/service/project/models", service });
    expect(linked).toMatchObject({ status: 200, body: { projectName: "demo-tasklog", current: model, source: "default" } });
    w.members.delete(PERSON);
    const before = structuredClone(w.db.find(() => true));
    const removed = await call(w.handler, { method: "GET", path: "/v1/service/project/models", service });
    expect(removed).toMatchObject({ status: 403, body: { error: { message: SLACK_WEB_SIGNIN_NOTICE } } });
    expect(w.db.find(() => true)).toEqual(before);
  });

  it("companySlackCaller built-in golden: service model reads and selection match company mode off for an unlinked Slack user", async () => {
    const run = async (companyMode: boolean) => {
      const w = await world({ installCompany: IMPLICIT_COMPANY_ID });
      const row = w.db.get("PROJECT#payments", "REV#000000000001")!;
      w.db.set({ ...row, definition: { ...row.definition as object, models: { default: model, approved: [{ ...model, thinkingLevel: "low", label: "Batch" }] } } });
      const handler = companyMode ? w.handler : (await loadSlackBroker()).createAwsBrokerHandler(w.brokerInput as never);
      const answers = [];
      for (const method of ["GET", "PUT"]) {
        const answer = await call(handler, { method, path: method === "GET" ? "/v1/service/project/models" : "/v1/service/project/model",
          service: { ...service, slackUser: "U0OUTSIDER" }, ...(method === "PUT" ? { body: model } : {}) });
        expect(answer).toMatchObject({ status: 200, body: { projectName: "payments", current: model, source: method === "GET" ? "default" : "selection" } });
        const { requestId: _requestId, ...body } = answer.body; void _requestId;
        answers.push(body);
      }
      expect(w.db.get("PROJECT#payments", "SELECTION")).toMatchObject({ model, updatedBy: { teamId: SLACK_TEAM, userId: "U0OUTSIDER" } });
      return answers;
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

describe("DEC 254zzz98 (re-review H): a named company's start the core does not take never runs on a legacy project of the same name that is not its own", () => {
  const namesake = (companyId?: string) => ({ pk: "PROJECT#demo-tasklog", sk: "REV#000000000001", entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }),
    registeredBy: "c".repeat(64), registeredAt: "2026-11-18T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs" },
    definition: { name: "demo-tasklog", revision: 1, orchestratorInstructions: "built-in", setup: [], readiness: [],
      repositories: [{ name: "builtin", url: "https://github.com/builtin/secret.git", defaultBranch: "main", path: "repo/builtin", credentialRef: "github" }] } });
  const tasksOf = (w: { db: { find(p: (item: Record<string, unknown>) => boolean): unknown[] } }) =>
    w.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META" && item.project === "demo-tasklog");

  it("the built-in company's unstamped namesake: the legacy start is refused as not found; no task, no workspace on its repositories", async () => {
    const w = await world({ installCompany: A, core: false });
    w.db.set(companyBinding(A));
    // The person's grant on A's own project, in A's partition: the access check passes, so only the project row the start loads can refuse.
    w.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "demo-tasklog", role: "developer" });
    w.db.set(namesake());
    const result = await w.start();
    expect(result.statusCode).not.toBe(200);
    expect(result.body).toContain("PROJECT_NOT_FOUND");
    expect(result.body).not.toMatch(/builtin|secret/);
    expect(tasksOf(w)).toEqual([]);
    expect(w.db.find((item) => JSON.stringify(item).includes("builtin/secret") && item.pk !== "PROJECT#demo-tasklog")).toEqual([]);
  });

  it("another named company's stamped namesake is refused the same way", async () => {
    const w = await world({ installCompany: A, core: false });
    w.db.set(companyBinding(A));
    // The person's grant on A's own project, in A's partition: the access check passes, so only the project row the start loads can refuse.
    w.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#demo-tasklog", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "demo-tasklog", role: "developer" });
    w.db.set(namesake(B));
    const result = await w.start();
    expect(result.statusCode).not.toBe(200);
    expect(result.body).toContain("PROJECT_NOT_FOUND");
    expect(tasksOf(w)).toEqual([]);
  });
});
