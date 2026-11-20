// DEC 254zzz80 (R2-F1): a NAMED company's Slack channel bindings live only in its own partition, `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (the staging shape:
// org_demo…'s binding of T0BSHLLUGBD/C0DEMOCHAN1 to demo-tasklog, and SLACK_TEAM#T0BSHLLUGBD/BINDING naming that company). The Slack Lambda reads the binding there, for the install
// team (its legacy view knows the team's company: installTeamCompany) and for a company-mode team (the verified request's company). The built-in company, and company mode off,
// read the legacy key exactly as before. A NAMED company's typed @mention in an unbound channel is answered once in its thread, never dropped in silence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { namedCompanySlackBinding, slackChannelBindingKeyFor, slackChannelBindingPkFor } from "../../packages/broker/src/aws/slack-company-layout.js";
import { slackBindingInCompany } from "../../packages/broker/src/aws/slack-person.js";
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

  it.each([
    ["a row naming another channel", { ...stagingRow(A), channelId: "C0ELSEWHERE" }],
  ])("%s is absent, never a guess", async (_name, row) => {
    expect(await namedCompanySlackBinding(fakeTable([row]), STATE, A, TEAM, CHANNEL)).toBeUndefined();
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

  it("an unbound channel of a named company gets one clear reply in its thread, once per event (Slack's retry is not answered again)", async () => {
    const h = lambda([stagingRow(A)], installView(A));
    expect((await h.route(mention(UNBOUND))).statusCode).toBe(200);
    expect((await h.route(mention(UNBOUND))).statusCode).toBe(200);
    expect(h.wire.postMessage.mock.calls).toEqual([[{ channel: UNBOUND, threadTs: "1700000000.000001", text: SLACK_CHANNEL_NOT_BOUND_NOTICE }]]);
    expect(h.wire.enqueue).not.toHaveBeenCalled();
    expect(SLACK_CHANNEL_NOT_BOUND_NOTICE).not.toMatch(/demo-tasklog|org_|C0|T0/u);
  });

  it.each([
    ["an app-posted mention", { appPosted: true }],
  ])("%s in an unbound channel of a named company stays silent (nothing claimed or posted)", async (_name, overrides) => {
    const h = lambda([], installView(A));
    await h.route(mention(UNBOUND, overrides));
    expect(h.wire.postMessage).not.toHaveBeenCalled();
    expect(h.wire.enqueue).not.toHaveBeenCalled();
  });

  describe("the built-in company and company mode off: byte-identical to before", () => {
    for (const [name, company] of [["company mode off (no team reader)", {}]] as const) {
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
