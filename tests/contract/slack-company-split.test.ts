// L2-2 PR 18b (DEC 254o b): the broker's per-team split. SLACK_TEAM_ID's team (and a request naming no team) keeps today's legacy path byte for byte; every other team takes
// the company path; with no `workspaces` (Slack company mode off) the broker is today's handler itself.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyThenInstallLinkCodes, installAdapterLinkCodes, slackCompanyServes, slackRequestTeam, splitBySlackTeam, withoutSlackCompanyMode } from "../../packages/broker/src/aws/slack-company-split.js";
import { issueLinkCode } from "../../packages/broker/src/aws/channel-links.js";
import { slackCompanyProject } from "../../packages/broker/src/aws/slack-person.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call, createBroker, loadSlackBroker, orchestratorPrincipal, registerSlackProject, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const OTHER = "T0BBBBBBB", USER = "U0SHARED00", TS = "1700000000.000001";
const WEB = "That needs a web sign-in. Open it in Rovara.";
const http = (headers: Record<string, string>, rawPath = "/v1/service/project/models") => ({ requestContext: { http: { method: "GET" } }, rawPath, headers });

describe("which handler a request reaches", () => {
  it("reads the team only from a direct invoke's thread or teamId, a Slack thread header (any case) or an admin binding path (decoded once)", () => {
    const named = (team: string | undefined) => ({ named: true, team });
    expect(slackRequestTeam({ source: "agentx.slack-ingress", thread: { teamId: OTHER } })).toEqual(named(OTHER));
    expect(slackRequestTeam({ source: "agentx.slack-ingress", teamId: OTHER })).toEqual(named(OTHER));
    expect(slackRequestTeam({ thread: { teamId: OTHER }, teamId: SLACK_TEAM })).toEqual(named(undefined));
    expect(slackRequestTeam(http({ "x-agentx-slack-thread": `${OTHER}/${SLACK_CHANNEL}/${TS}` }))).toEqual(named(OTHER));
    expect(slackRequestTeam(http({ "X-AgentX-Slack-Thread": `${OTHER}/${SLACK_CHANNEL}/${TS}` }))).toEqual(named(OTHER));
    expect(slackRequestTeam(http({}, `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`))).toEqual(named(OTHER));
    expect(slackRequestTeam(http({}, `/v1/admin/slack/bindings/%54${OTHER.slice(1)}/${SLACK_CHANNEL}`))).toEqual(named(OTHER));
    // Named but unreadable: still named (so it never reaches the install's handler).
    expect(slackRequestTeam({ thread: { teamId: 7 } })).toEqual(named(undefined));
    expect(slackRequestTeam({ thread: null })).toEqual(named(undefined));
    expect(slackRequestTeam({ teamId: null })).toEqual(named(undefined));
    expect(slackRequestTeam(http({ "x-agentx-slack-thread": "garbage" }))).toEqual(named(undefined));
    expect(slackRequestTeam(http({}, "/v1/admin/slack/bindings/%E0%A4%A/C1"))).toEqual(named(undefined));
    // A direct-invoke field on an HTTP-shaped event still counts (stricter: it can only send the event to the company handler); other shapes name none.
    expect(slackRequestTeam({ ...http({}), thread: { teamId: OTHER }, teamId: OTHER })).toEqual(named(OTHER));
    for (const none of [null, "x", [], {}, { source: "agentx.github-webhook-recovery" }, http({}, `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}/extra`), http({}, `/x/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`), http({}, `x/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`), http({}, "/v1/dev/projects")]) {
      expect(slackRequestTeam(none), JSON.stringify(none)).toEqual({ named: false });
    }
  });

  it("fails closed: only no team at all, or exactly the install's team, reaches today's handler", () => {
    expect(slackCompanyServes({ thread: { teamId: OTHER } }, SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: SLACK_TEAM } }, SLACK_TEAM)).toBe(false);
    expect(slackCompanyServes({ source: "agentx.github-webhook-recovery" }, SLACK_TEAM)).toBe(false);
    expect(slackCompanyServes(http({}, "/v1/dev/projects"), SLACK_TEAM)).toBe(false);
    expect(slackCompanyServes(http({}, `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`), SLACK_TEAM)).toBe(false);
    // Encoded, Enterprise Grid, mixed-case header and unreadable values all go to the company handler.
    expect(slackCompanyServes(http({}, `/v1/admin/slack/bindings/%54${OTHER.slice(1)}/${SLACK_CHANNEL}`), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes(http({}, `/v1/admin/slack/bindings/%${SLACK_TEAM}/${SLACK_CHANNEL}`), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: "E0GRID0000" } }, SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes(http({ "x-agentx-slack-thread": `E0GRID0000/${SLACK_CHANNEL}/${TS}` }), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes(http({ "X-AGENTX-SLACK-THREAD": `${OTHER}/${SLACK_CHANNEL}/${TS}` }), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: 7 } }, SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ teamId: "" }, SLACK_TEAM)).toBe(true);
    // The link page: company handler, unless a header names the install's team.
    expect(slackCompanyServes(http({}, "/review/link/abc"), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes(http({ "x-agentx-slack-thread": "garbage" }, "/review/link/abc"), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes(http({ "x-agentx-slack-thread": `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}` }, "/review/link/abc"), SLACK_TEAM)).toBe(false);
    // No install team configured: every named team is a company's.
    expect(slackCompanyServes({ teamId: SLACK_TEAM }, undefined)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: 7 } }, undefined)).toBe(true);
    // The path as the broker routes on it (WHATWG URL): backslashes, tabs, fragments.
    for (const path of [`/v1/admin/slack\\bindings/${OTHER}/${SLACK_CHANNEL}`, `/v1\\admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`, `/v1/admin/slack/bin\tdings/${OTHER}/${SLACK_CHANNEL}`, `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}#/x`]) {
      expect(slackCompanyServes(http({}, path), SLACK_TEAM), path).toBe(true);
    }
    expect(slackCompanyServes(http({}, "/review\\link/abc"), SLACK_TEAM)).toBe(true);
    // Disagreeing fields: two header variants, or thread and teamId, are "named, unknown".
    expect(slackCompanyServes(http({ "x-agentx-slack-thread": `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, "X-AgentX-Slack-Thread": `${OTHER}/${SLACK_CHANNEL}/${TS}` }), SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: SLACK_TEAM }, teamId: OTHER }, SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ thread: { teamId: SLACK_TEAM }, teamId: SLACK_TEAM }, SLACK_TEAM)).toBe(false);
    // An HTTP-shaped direct invoke (no requestContext) is read too.
    expect(slackCompanyServes({ rawPath: `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`, headers: {} }, SLACK_TEAM)).toBe(true);
    expect(slackCompanyServes({ headers: { "x-agentx-slack-thread": `${OTHER}/${SLACK_CHANNEL}/${TS}` } }, SLACK_TEAM)).toBe(true);
  });

  it("makes another team's channel binding 'not bound' in the install team's legacy view (defence in depth), and changes nothing off", async () => {
    const view = withoutSlackCompanyMode({ workspaces: undefined as never, tableName: "t" }, SLACK_TEAM);
    expect(view).toStrictEqual({ tableName: "t", slackInstallTeamOnly: SLACK_TEAM });
    expect(withoutSlackCompanyMode({ workspaces: {}, tableName: "t" }, SLACK_TEAM)).toStrictEqual({ tableName: "t", slackInstallTeamOnly: SLACK_TEAM });
    expect(await slackCompanyProject(view, OTHER, "payments")).toBe(false);
    expect(await slackCompanyProject(view, SLACK_TEAM, "payments")).toBe(true);
    expect(await slackCompanyProject({}, OTHER, "payments")).toBe(true);
    // Company mode without SLACK_TEAM_ID: the broker passes "" (never a team), so no team's binding is bound in the legacy view.
    const unset = withoutSlackCompanyMode({ workspaces: undefined as never, tableName: "t" }, "");
    expect(await slackCompanyProject(unset, OTHER, "payments")).toBe(false);
    expect(await slackCompanyProject(unset, SLACK_TEAM, "payments")).toBe(false);
  });

  it("is today's handler itself when company mode is off", () => {
    const legacy = vi.fn(), company = vi.fn();
    expect(splitBySlackTeam(legacy, undefined, SLACK_TEAM)).toBe(legacy);
    expect(splitBySlackTeam(legacy, undefined, undefined)).toBe(legacy);
    const split = splitBySlackTeam(legacy, company, SLACK_TEAM);
    split({ teamId: OTHER }); split({ teamId: SLACK_TEAM });
    expect(company).toHaveBeenCalledTimes(1); expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("drops only the company path from the legacy view", () => {
    const deps = { workspaces: {}, companies: {}, tableName: "t" };
    expect(withoutSlackCompanyMode(deps)).toStrictEqual({ companies: {}, tableName: "t" });
    expect(withoutSlackCompanyMode(deps, SLACK_TEAM)).toStrictEqual({ companies: {}, tableName: "t", slackInstallTeamOnly: SLACK_TEAM });
    expect(deps.workspaces).toStrictEqual({});
  });
});

describe("the link page's codes in the company handler", () => {
  it("serves the install's adapter codes exactly as the legacy page does", async () => {
    const links = { documentClient: new FakeDynamoDb() as never, stateTableName: "state", now: () => Date.parse("2026-11-17T12:00:00.000Z") };
    const { code } = await issueLinkCode(links, { channel: "acme", tenant: "tenant-1", userId: "user-1" });
    const install = installAdapterLinkCodes(links);
    const codes = companyThenInstallLinkCodes({ preview: async () => undefined, redeem: async () => { throw new Error("not company"); } }, install);
    expect(await codes.preview("person", code)).toMatchObject({ channel: "acme" });
    expect(await codes.redeem("person", code)).toMatchObject({ developerId: "person", actor: { channel: "acme", tenant: "tenant-1", userId: "user-1" } });
    expect(await codes.preview("person", code)).toBeUndefined();
  });

  const found = { channel: "slack", maskedUserId: "U0…00" };
  it("finds the company's own code first, then the install's adapter code, never both", async () => {
    const company = { preview: vi.fn(async (_p: string, code: string) => code === "company" ? found : undefined), redeem: vi.fn(async () => "company-link") };
    const install = { preview: vi.fn(async (code: string) => code === "install" ? { channel: "teams", maskedUserId: "x" } : undefined), redeem: vi.fn(async () => "install-link") };
    const codes = companyThenInstallLinkCodes(company, install);
    expect(await codes.preview("p", "company")).toEqual(found);
    expect(await codes.preview("p", "install")).toEqual({ channel: "teams", maskedUserId: "x" });
    expect(await codes.preview("p", "none")).toBeUndefined();
    expect(await codes.redeem("p", "company")).toBe("company-link");
    expect(install.redeem).not.toHaveBeenCalled();
    expect(await codes.redeem("p", "install")).toBe("install-link");
    expect(company.redeem).toHaveBeenCalledTimes(1);
  });
  it("serves only company codes where the deployment has no adapters", async () => {
    const company = { preview: vi.fn(async () => undefined), redeem: vi.fn(async () => { throw new Error("expired"); }) };
    const codes = companyThenInstallLinkCodes(company, undefined);
    expect(await codes.preview("p", "any")).toBeUndefined();
    await expect(codes.redeem("p", "any")).rejects.toThrow("expired");
  });
});

/** Company dependencies for the broker: SLACK_TEAM is the install's team (implicit company), OTHER is company B's. */
function companyWorld() {
  const store = new MemoryDocumentStore();
  return {
    workspaces: { store, getProject: async () => ({ companyId: B }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
      // The install's team is the built-in company's (DEC 254zzz80: a NAMED install company's Slack start is that company's, covered in slack-company-layout-start.test.ts).
      requireCompany: async (team: string): Promise<string> => { if (team === OTHER) return B; if (team === SLACK_TEAM) return IMPLICIT_COMPANY_ID; throw Error("private"); },
      tokenForEvent: async (team: string) => ({ companyId: team === OTHER ? B : IMPLICIT_COMPANY_ID, token: slackTokens(team).bot }) },
    companies: { companyOf: async () => undefined },
    slackWorkspaceLegacyTeamId: SLACK_TEAM,
  };
}

const events = (team: string) => {
  const thread = { teamId: team, channelId: SLACK_CHANNEL, threadTs: TS };
  return [
    { source: "agentx.slack-ingress", action: "task-people-read", thread, userId: USER, taskId: "11111111-1111-4111-8111-111111111111" },
    { source: "agentx.slack-ingress", action: "task-people-confirm", thread, userId: USER, taskId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222" },
    { source: "agentx.slack-ingress", action: "stop-task", thread, userId: USER },
    { source: "agentx.slack-ingress", action: "chatgpt-command", command: { kind: "status" }, teamId: team, userId: USER },
    { source: "agentx.slack-ingress", action: "start-workflow", thread, userId: USER, instructions: "golden", workflowPath: "QUICK", requestId: "33333333-3333-4333-8333-333333333333" },
  ];
};

describe("the broker's link page sources", () => {
  it("in company mode, serves the company's codes and, where adapters exist, the install's adapter codes", async () => {
    await loadSlackBroker();
    // The same module the harness loaded (its environment is set), typed.
    const module = await import("../../packages/broker/src/aws/broker.js");
    const db = new FakeDynamoDb();
    const links = { documentClient: db as never, stateTableName: "state", now: Date.now };
    const { code } = await issueLinkCode(links, { channel: "acme", tenant: "tenant-1", userId: "user-1" });
    const deps = { ...companyWorld(), documentClient: db, tableName: "state", channelAdapters: {} };
    const sources = module.channelLinkRouteDependencies(deps as never);
    expect(sources.channelLinks).toBeUndefined();
    expect(await sources.channelLinkCodes!.preview("person", code)).toMatchObject({ channel: "acme" });
    const { channelAdapters: _none, ...withoutAdapters } = deps; void _none;
    expect(await module.channelLinkRouteDependencies(withoutAdapters as never).channelLinkCodes!.preview("person", code)).toBeUndefined();
  });
});

describe("the install team's legacy view in a company-mode broker", () => {
  it("treats another team's binding as not bound even on a route the split does not read (admin eval channels)", async () => {
    const module = await loadSlackBroker();
    const h = createBroker();
    await registerSlackProject(h.handler, { bind: false });
    const admin = { subject: "admin-subject", admin: true };
    // Today's broker (company mode off) binds OTHER's channel and finds it.
    expect((await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    const path = `/v1/admin/evals/channels/${OTHER}/${SLACK_CHANNEL}`;
    const today = await call(h.handler, { method: "GET", path, user: admin });
    expect(JSON.stringify(today.body), JSON.stringify(today.body)).toContain("SWE-bench runs are not available in this deployment");
    // The same storage, company mode on: the request names no team the split reads, so the legacy view serves it, and OTHER's binding is not bound there.
    const split = module.createAwsBrokerHandler({ ...h.brokerInput, ...companyWorld() } as never);
    const answer = await call(split, { method: "GET", path, user: admin });
    expect(JSON.stringify(answer.body)).toContain("bind the channel to a project first");
  });
});

describe("company mode without SLACK_TEAM_ID", () => {
  it("never serves another team's binding from the legacy view", async () => {
    const module = await loadSlackBroker();
    const h = createBroker();
    await registerSlackProject(h.handler, { bind: false });
    const admin = { subject: "admin-subject", admin: true };
    expect((await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${OTHER}/${SLACK_CHANNEL}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
    const { slackWorkspaceLegacyTeamId: _install, ...world } = companyWorld(); void _install;
    const split = module.createAwsBrokerHandler({ ...h.brokerInput, ...world } as never);
    const answer = await call(split, { method: "GET", path: `/v1/admin/evals/channels/${OTHER}/${SLACK_CHANNEL}`, user: admin });
    expect(JSON.stringify(answer.body)).toContain("bind the channel to a project first");
  });
});

describe("the broker's split (golden)", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  async function run(company: boolean, team: string) {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-11-17T12:00:00.000Z"));
    const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
    const module = await loadSlackBroker();
    // Every storage call's full input, not only its name.
    const inputs: string[] = [];
    const send = h.db.send.bind(h.db);
    vi.spyOn(h.db, "send").mockImplementation(async (command) => { inputs.push(`${(command as object).constructor.name} ${JSON.stringify((command as { input?: unknown }).input)}`); return send(command); });
    // The same deployment both times (company sign-in's membership reader, the install's team); only the company path differs.
    const { workspaces, ...deployment } = companyWorld();
    const touched: string[] = [];
    for (const name of ["requireCompany", "tokenForEvent", "getProject", "linkUrl"] as const) vi.spyOn(workspaces, name).mockImplementation((...args: never[]) => { touched.push(name); return (companyWorld().workspaces[name] as (...a: never[]) => never)(...args); });
    for (const name of ["get", "put", "query", "transact", "delete"] as const) vi.spyOn(workspaces.store, name).mockImplementation(async () => { touched.push(`store.${name}`); throw new Error("no store here"); });
    const handler = module.createAwsBrokerHandler({ ...h.brokerInput, ...deployment, ...(company ? { workspaces } : {}) } as never);
    const answers: unknown[] = [];
    for (const event of events(team)) {
      const response = await handler(event);
      // A started task's id is random; everything else must match.
      answers.push({ ...response, body: response.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>") });
    }
    const service = await call(handler, { method: "GET", path: "/v1/service/project/models", service: { principal: orchestratorPrincipal, thread: `${team}/${SLACK_CHANNEL}/${TS}`, slackUser: USER } });
    vi.useRealTimers();
    const scrub = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>");
    return { answers, service: scrub(JSON.stringify(service.body)), commands: h.db.commandNames(), inputs: inputs.map(scrub), touched };
  }

  it("answers the install's team byte for byte as the broker without company mode does (responses and storage calls)", async () => {
    const legacy = await run(false, SLACK_TEAM);
    const split = await run(true, SLACK_TEAM);
    // DEC 254zzz80 (R2-F1): the install team's company is read once per binding read (its operator binding picks the binding layout); for the built-in company everything else,
    // responses and every storage call, is byte for byte today's.
    expect({ ...split, touched: [] }).toStrictEqual({ ...legacy, touched: [] });
    // The company path was never touched for the install's team (no token, project or store call): only the team's company was asked.
    expect(split.touched.filter((name) => name !== "requireCompany")).toEqual([]);
    expect(split.touched.length).toBeGreaterThan(0);
    expect(legacy.inputs.length).toBeGreaterThan(0);
    // Positive control: the legacy path really ran (nothing said "web sign-in", storage was used), and it differs from the company path's answers for the same events.
    expect(JSON.stringify(legacy.answers)).not.toContain(WEB);
    expect(legacy.commands.length).toBeGreaterThan(0);
    expect((await run(true, OTHER)).answers).not.toStrictEqual(legacy.answers);
  });

  it("sends another team through the company path (its checks refuse an unlinked person)", async () => {
    const split = await run(true, OTHER);
    expect(JSON.stringify(split.answers)).toContain(WEB);
    expect(split.touched).toContain("requireCompany");
    // No task starts for the refused team.
    expect(JSON.stringify(split.answers)).not.toContain("taskId");
  });

  it("a request naming no team reaches the legacy handler", async () => {
    const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
    const module = await loadSlackBroker();
    const world = companyWorld(); const lookup = vi.spyOn(world.workspaces, "requireCompany");
    const handler = module.createAwsBrokerHandler({ ...h.brokerInput, ...world } as never);
    const legacy = await h.handler({ source: "agentx.github-webhook-recovery" });
    expect(await handler({ source: "agentx.github-webhook-recovery" })).toStrictEqual(legacy);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps randomUUID untouched (sanity for the id scrub)", () => { expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/u); });
});
