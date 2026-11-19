// DEC 254zzz80 (R2-F1): the broker's Slack start (startSlackWorkflow) reads the channel's binding in the team's company's layout. A NAMED company's binding is only its own row,
// `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>`; a leftover legacy row binds nothing for it. The install team whose operator binding names a NAMED company (staging:
// T0BSHLLUGBD -> org_demo…) starts as that company: its linked person, its own binding, the core. The built-in company keeps the single-workspace start exactly.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace, loadSlackBroker } from "../support/slack-broker.js";
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
async function world(options: { installCompany: string; legacyInstall?: boolean; core?: false }) {
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
  const route = vi.fn<(request: { body?: string }, caller?: unknown) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>>(async (request) => { starts.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>); return { statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: TASK } }) }; });
  // `core: false`: the core declines the start (a company the core does not cover answers undefined, engine-boundary.ts), so the legacy start answers it.
  const entry: CoreTaskEntry = { route: options.core === false ? async () => undefined : route, recordThread: vi.fn(async () => true) };
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, store, workspaces, companies: { companyOf: async (id: string) => members.get(id) },
    ...(options.legacyInstall === false ? {} : { slackWorkspaceLegacyTeamId: SLACK_TEAM }),
    developer: { ...h.brokerInput.developer!, slackTeamId: SLACK_TEAM, coreTasks: entry } } as never);
  const start = (team = SLACK_TEAM) => handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: team, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" },
    userId: team === SLACK_TEAM ? USER : USER_B, instructions: "Fix the flaky test", workflowPath: "QUICK", requestId: randomUUID() });
  return { ...h, handler, entry, route, starts, start, companyOfTeam };
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

  it("round-3 M1: a built-in namesake never blocks the company's routes that read no legacy revision (the core's quick start, Slack answers, thread notes)", async () => {
    const w = await world({ installCompany: A });
    w.db.set(companyBinding(A));
    const service = { principal: (await import("../support/slack-broker.js")).orchestratorPrincipal, thread: THREAD, slackUser: USER };
    const routes = [
      { method: "POST", path: "/v1/service/workflows/quick-start", body: { requestId: randomUUID(), instructions: "fix it" } },
      { method: "POST", path: "/v1/service/slack/answer", body: { requestId: randomUUID(), text: "hello" } },
      { method: "POST", path: "/v1/service/tasks/thread-notes/answered", body: { taskId: randomUUID(), messageTs: "1695500000.000009" } },
    ];
    const answers = async () => Promise.all(routes.map(async (route) => JSON.stringify((await call(w.handler, { ...route, service })).body)));
    const without = await answers();
    w.db.set(builtInNamesake());
    const withNamesake = await answers();
    for (const [index, answer] of withNamesake.entries()) {
      expect(answer, routes[index]!.path).not.toContain("Slack channel is not bound to a project");
      // The same answer as with no namesake at all (request ids aside).
      expect(answer.replace(/"requestId":"[^"]*"/, ""), routes[index]!.path).toBe(without[index]!.replace(/"requestId":"[^"]*"/, ""));
    }
  });

  it("the built-in company's thread (legacy binding) is unchanged: no company, no check", async () => {
    const w = await world({ installCompany: IMPLICIT_COMPANY_ID });
    w.db.set(builtInNamesake());
    // The broker's registered legacy binding names "payments" (createDeveloperTaskBroker); the namesake of another name is never read for it.
    const answer = await ensureWorkspace(w.handler, THREAD, USER);
    expect(JSON.stringify(answer.body)).not.toContain("Slack channel is not bound to a project");
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
