// DEC 254zzz80 (R2-F1): a NAMED company's Slack channel bindings live only in its own partition, `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (the staging shape:
// org_demo…'s binding of T0BSHLLUGBD/C0DEMOCHAN1 to demo-tasklog, and SLACK_TEAM#T0BSHLLUGBD/BINDING naming that company). The Slack Lambda reads the binding there, for the install
// team (its legacy view knows the team's company: installTeamCompany) and for a company-mode team (the verified request's company). The built-in company, and company mode off,
// read the legacy key exactly as before. A NAMED company's typed @mention in an unbound channel is answered once in its thread, never dropped in silence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { namedCompanySlackBinding, slackChannelBindingKeyFor, slackChannelBindingPkFor } from "../../packages/broker/src/aws/company-layout.js";
import { slackBindingCompany, slackBindingInCompany, slackRequestWorkspace } from "../../packages/broker/src/aws/slack-person.js";
import {
  SLACK_CHANNEL_NOT_BOUND_NOTICE, awsSlackRouterDependencies, createSlackMentionRouter, type SlackMention, type SlackRouterTransport,
} from "../../packages/broker/src/aws/slack-ingress.js";

const A = "org_demoaaaaaaaaaaaaaaaa" as OrgId; // the staging company
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TEAM = "T0BSHLLUGBD";
const OTHER_TEAM = "T0OTHERTEAM";
const CHANNEL = "C0DEMOCHAN1";
const UNBOUND = "C0UNBOUND00";
const STATE = "state";

/** The staging row, exactly as Cloud wrote it (no companyId field). */
const stagingRow = (company: string, project = "demo-tasklog", team = TEAM, channel = CHANNEL) => ({
  pk: `ORG#${company}#SLACK_BINDING#${team}`, sk: `CHANNEL#${channel}`, channelId: channel, projectName: project, teamId: team,
  updatedBy: "e".repeat(64), updatedAt: "2026-10-27T15:07:04.991Z", entityType: "SLACK_BINDING",
});
const legacyRow = (project = "legacy-project", team = TEAM, channel = CHANNEL) => ({
  pk: `SLACK_BINDING#${team}`, sk: `CHANNEL#${channel}`, channelId: channel, projectName: project, teamId: team, updatedAt: "2026-10-01T00:00:00.000Z", entityType: "SLACK_BINDING",
});

/** A one-table fake: GetItem by key on any table name, everything else a recorded no-op with the answers the router expects. */
function fakeTable(rows: Array<Record<string, unknown>>) {
  const items = new Map(rows.map((row) => [`${STATE}|${String(row.pk)}|${String(row.sk)}`, row]));
  const gets: Array<{ table: string; pk: string; sk: string }> = [];
  const claims = new Set<string>();
  const puts: string[] = [];
  const send = async (command: unknown) => {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      gets.push({ table: TableName, pk: Key.pk, sk: Key.sk });
      return { Item: items.get(`${TableName}|${Key.pk}|${Key.sk}`) };
    }
    if (command instanceof PutCommand) {
      const key = String((command.input.Item as { pk: string }).pk);
      puts.push(key);
      if (claims.has(key)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      claims.add(key);
      return {};
    }
    if (command instanceof UpdateCommand) return { Attributes: { turns: 1, pendingRequests: 1 } };
    if (command instanceof DeleteCommand) return {};
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };
  return { send, gets, puts };
}

const transport = () => ({
  postMessage: vi.fn(async () => ({})), update: vi.fn(async () => undefined), postEphemeral: vi.fn(async () => undefined), checkMember: vi.fn(),
  enqueue: vi.fn(async () => undefined), route: vi.fn(async () => undefined), enqueueAnswer: vi.fn(async () => undefined),
}) satisfies SlackRouterTransport;

const mention = (channelId = CHANNEL, overrides: Partial<SlackMention> = {}): SlackMention => ({
  kind: "mention", eventId: `Ev${channelId}${overrides.kind ?? ""}`, thread: { teamId: overrides.thread?.teamId ?? TEAM, channelId, threadTs: "1700000000.000001" }, userId: "U0PERSON00",
  text: "<@U0BOTUSER0> please fix the flaky test", messageTs: "1700000000.000001", isThreadReply: false, botUserId: "U0BOTUSER0", appPosted: false, ...overrides,
});

beforeEach(() => {
  vi.stubEnv("AWS_REGION", "us-west-2");
  vi.stubEnv("STATE_TABLE_NAME", STATE);
  vi.stubEnv("SLACK_THREADS_TABLE_NAME", "threads");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** The Slack Lambda's real router dependencies over the fake table. `company` is the view: the install team's legacy view, or the company handler's. */
function lambda(rows: Array<Record<string, unknown>>, company: Parameters<typeof awsSlackRouterDependencies>[1] = {}) {
  const table = fakeTable(rows);
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(table.send as never);
  const wire = transport();
  const deps = awsSlackRouterDependencies(wire, company);
  return { table, wire, deps, route: createSlackMentionRouter(deps) };
}
const installView = (company: string | (() => Promise<string>)) => ({
  slackInstallTeamOnly: TEAM, installTeamCompany: vi.fn(typeof company === "string" ? async () => company : company),
});

describe("namedCompanySlackBinding: one named company's own partition, by key", () => {
  it("reads the exact staging row and names the company it was read for", async () => {
    const table = fakeTable([stagingRow(A)]);
    expect(await namedCompanySlackBinding(table, STATE, A, TEAM, CHANNEL)).toEqual({ teamId: TEAM, channelId: CHANNEL, projectName: "demo-tasklog", updatedAt: "2026-10-27T15:07:04.991Z", companyId: A });
    expect(table.gets).toEqual([{ table: STATE, pk: `ORG#${A}#SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` }]);
  });

  it("two companies: B's row for the same team and channel, and the legacy row, are never A's binding", async () => {
    const table = fakeTable([stagingRow(B, "b-project"), legacyRow()]);
    expect(await namedCompanySlackBinding(table, STATE, A, TEAM, CHANNEL)).toBeUndefined();
    expect(await namedCompanySlackBinding(table, STATE, B, TEAM, CHANNEL)).toMatchObject({ projectName: "b-project", companyId: B });
  });

  it.each([
    ["a row naming another channel", { ...stagingRow(A), channelId: "C0ELSEWHERE" }],
    ["a row naming another team", { ...stagingRow(A), teamId: "T0ELSEWHERE" }],
    ["a row naming another company", { ...stagingRow(A), companyId: B }],
    ["a row whose project is not a project name", { ...stagingRow(A), projectName: "Not A Name!" }],
    ["a row with no updatedAt", { ...stagingRow(A), updatedAt: undefined }],
  ])("%s is absent, never a guess", async (_name, row) => {
    expect(await namedCompanySlackBinding(fakeTable([row]), STATE, A, TEAM, CHANNEL)).toBeUndefined();
  });

  it("a stored row under another key (a store answering the wrong key) is absent", async () => {
    const client = { send: async () => ({ Item: { ...stagingRow(A), pk: `ORG#${B}#SLACK_BINDING#${TEAM}` } }) };
    expect(await namedCompanySlackBinding(client, STATE, A, TEAM, CHANNEL)).toBeUndefined();
  });

  it("the built-in company, or a team or channel that is not one, reads nothing", async () => {
    const table = fakeTable([stagingRow(IMPLICIT_COMPANY_ID)]);
    expect(await namedCompanySlackBinding(table, STATE, IMPLICIT_COMPANY_ID as OrgId, TEAM, CHANNEL)).toBeUndefined();
    expect(await namedCompanySlackBinding(table, STATE, A, "not-a-team", CHANNEL)).toBeUndefined();
    expect(await namedCompanySlackBinding(table, STATE, A, TEAM, "C0#WEIRD")).toBeUndefined();
    expect(table.gets).toEqual([]);
  });
});

describe("slackChannelBindingKeyFor / slackChannelBindingPkFor: the one key choice for readers, writers and deleters", () => {
  it("a named company's own partition; the built-in company, no company and a malformed id the legacy key; a bad ref throws", () => {
    expect(slackChannelBindingKeyFor(A, TEAM, CHANNEL)).toEqual({ pk: `ORG#${A}#SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` });
    expect(slackChannelBindingPkFor(A, TEAM)).toBe(`ORG#${A}#SLACK_BINDING#${TEAM}`);
    for (const legacy of [undefined, IMPLICIT_COMPANY_ID, "not-an-org"]) {
      expect(slackChannelBindingKeyFor(legacy, TEAM, CHANNEL)).toEqual({ pk: `SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` });
      expect(slackChannelBindingPkFor(legacy, TEAM)).toBe(`SLACK_BINDING#${TEAM}`);
    }
    expect(() => slackChannelBindingKeyFor(A, TEAM, "C0#WEIRD")).toThrow();
  });
});

describe("slackBindingCompany: which company's layout a team's bindings are read in", () => {
  it("the verified request's company for its own team; never for another team", async () => {
    await slackRequestWorkspace.run({ teamId: TEAM, companyId: A, token: "x" }, async () => {
      expect(await slackBindingCompany({}, TEAM)).toBe(A);
      expect(await slackBindingCompany({}, OTHER_TEAM)).toBeUndefined();
    });
  });

  it("the install team's legacy view asks the team's operator binding, for the install team only", async () => {
    const view = installView(A);
    expect(await slackBindingCompany(view, TEAM)).toBe(A);
    expect(await slackBindingCompany(view, OTHER_TEAM)).toBeUndefined();
    expect(view.installTeamCompany).toHaveBeenCalledTimes(1);
    // Without slackInstallTeamOnly (a view that is not the install team's), the reader is not used.
    expect(await slackBindingCompany({ installTeamCompany: view.installTeamCompany }, TEAM)).toBeUndefined();
  });

  it("the built-in company and company mode off are the legacy layout; a binding that cannot be read throws", async () => {
    expect(await slackBindingCompany(installView(IMPLICIT_COMPANY_ID), TEAM)).toBeUndefined();
    expect(await slackBindingCompany({}, TEAM)).toBeUndefined();
    await expect(slackBindingCompany(installView(async () => { throw new Error("refused"); }), TEAM)).rejects.toThrow();
  });

  it("slackBindingInCompany: a company-partition binding must name the team's company now; a legacy binding keeps the project check", async () => {
    expect(await slackBindingInCompany(installView(A), TEAM, { projectName: "demo-tasklog", companyId: A })).toBe(true);
    expect(await slackBindingInCompany(installView(B), TEAM, { projectName: "demo-tasklog", companyId: A })).toBe(false);
    expect(await slackBindingInCompany(installView(async () => { throw new Error("x"); }), TEAM, { projectName: "demo-tasklog", companyId: A })).toBe(false);
    expect(await slackBindingInCompany(installView(A), TEAM, { projectName: "demo-tasklog", companyId: IMPLICIT_COMPANY_ID })).toBe(false);
    // A legacy binding (no companyId): today's rule, unchanged (the install team's view: its own team only).
    expect(await slackBindingInCompany(installView(A), TEAM, { projectName: "demo-tasklog" })).toBe(true);
    expect(await slackBindingInCompany(installView(A), OTHER_TEAM, { projectName: "demo-tasklog" })).toBe(false);
  });
});

describe("the Slack Lambda's binding read and the not-bound answer", () => {
  it("staging shape: the install team of a named company reads its own partition, and a mention in the bound channel is taken", async () => {
    const h = lambda([stagingRow(A)], installView(A));
    const response = await h.route(mention());
    expect(response.statusCode).toBe(200);
    expect(h.table.gets.filter((get) => get.table === STATE)).toEqual([{ table: STATE, pk: `ORG#${A}#SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` }]);
    expect(h.wire.enqueue).toHaveBeenCalledTimes(1);
    expect(h.wire.postMessage).toHaveBeenCalledTimes(1);
    expect(h.wire.postMessage.mock.calls[0]).not.toEqual([expect.objectContaining({ text: SLACK_CHANNEL_NOT_BOUND_NOTICE })]);
  });

  it("a named company never reads the legacy key: a leftover legacy row binds nothing", async () => {
    const h = lambda([legacyRow("demo-tasklog")], installView(A));
    await h.route(mention());
    expect(h.table.gets.some((get) => get.pk.startsWith("SLACK_BINDING#"))).toBe(false);
    expect(h.wire.enqueue).not.toHaveBeenCalled();
  });

  it("an unbound channel of a named company gets one clear reply in its thread, once per event (Slack's retry is not answered again)", async () => {
    const h = lambda([stagingRow(A)], installView(A));
    expect((await h.route(mention(UNBOUND))).statusCode).toBe(200);
    expect((await h.route(mention(UNBOUND))).statusCode).toBe(200);
    expect(h.wire.postMessage.mock.calls).toEqual([[{ channel: UNBOUND, threadTs: "1700000000.000001", text: SLACK_CHANNEL_NOT_BOUND_NOTICE }]]);
    expect(h.wire.enqueue).not.toHaveBeenCalled();
    expect(SLACK_CHANNEL_NOT_BOUND_NOTICE).not.toMatch(/demo-tasklog|org_|C0|T0/u);
  });

  it.each([
    ["a plain message", { kind: "message" as const }],
    ["an app-posted mention", { appPosted: true }],
  ])("%s in an unbound channel of a named company stays silent (nothing claimed or posted)", async (_name, overrides) => {
    const h = lambda([], installView(A));
    await h.route(mention(UNBOUND, overrides));
    expect(h.wire.postMessage).not.toHaveBeenCalled();
    expect(h.wire.enqueue).not.toHaveBeenCalled();
  });

  it("two companies: a company-mode team of company B reads B's partition only, and never A's binding of the same channel", async () => {
    const h = lambda([stagingRow(A, "demo-tasklog", OTHER_TEAM)], { workspaces: { requireCompany: async () => B } as never });
    await slackRequestWorkspace.run({ teamId: OTHER_TEAM, companyId: B, token: "x" }, () => h.deps.getBinding(OTHER_TEAM, CHANNEL)).then((binding) => expect(binding).toBeUndefined());
    expect(h.table.gets.filter((get) => get.table === STATE)).toEqual([{ table: STATE, pk: `ORG#${B}#SLACK_BINDING#${OTHER_TEAM}`, sk: `CHANNEL#${CHANNEL}` }]);
    // B's own row is read and named as B's.
    const own = lambda([stagingRow(B, "b-project", OTHER_TEAM)], { workspaces: { requireCompany: async () => B } as never });
    expect(await slackRequestWorkspace.run({ teamId: OTHER_TEAM, companyId: B, token: "x" }, () => own.deps.getBinding(OTHER_TEAM, CHANNEL))).toMatchObject({ projectName: "b-project", companyId: B });
  });

  it("a team-to-company read that fails is an error (Slack retries), never a guess at the legacy layout", async () => {
    const h = lambda([legacyRow()], installView(async () => { throw new Error("refused"); }));
    await expect(h.route(mention())).rejects.toThrow();
    expect(h.table.gets).toEqual([]);
    expect(h.wire.enqueue).not.toHaveBeenCalled();
  });

  describe("the built-in company and company mode off: byte-identical to before", () => {
    for (const [name, company] of [["company mode off (no team reader)", {}], ["the install team of the built-in company", installView(IMPLICIT_COMPANY_ID)]] as const) {
      it(`${name}: the legacy key is read, a bound mention is taken, and an unbound one is ignored in silence`, async () => {
        const h = lambda([legacyRow()], company);
        await h.route(mention());
        expect(h.table.gets.filter((get) => get.table === STATE)).toEqual([{ table: STATE, pk: `SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}` }]);
        expect(h.wire.enqueue).toHaveBeenCalledTimes(1);
        const quiet = lambda([legacyRow()], company);
        expect(await quiet.route(mention(UNBOUND))).toEqual({ statusCode: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
        expect(quiet.wire.postMessage).not.toHaveBeenCalled();
        expect(quiet.table.puts).toEqual([]);
      });
    }
  });
});
