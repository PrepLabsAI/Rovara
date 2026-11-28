// L2-2 PR 18d (DEC 254o b): Slack company mode for the notifier, TaskPersonProof and the hosted Slack service (the reconciler's sweeps are in
// stuck-cancels / unwaited-tasks / session-reconciler tests). Off: each export is today's handler. On: the install's own work keeps today's path; anything else, or anything
// unreadable, takes the company path.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { noticeServedByCompany, slackNoteIsInstalls, splitNoticesBySlackCompany } from "../../packages/broker/src/aws/slack-company-notices.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { serviceSlackWorkspacesFromEnvironment } from "../../packages/slack-service/src/slack-company-workspaces.js";
import { createWorkspaceSlackClients } from "../../packages/slack-service/src/slack-workspace-clients.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const INSTALL = "T0INSTALL0", OTHER = "T0BBBBBBB";
const TASK = "11111111-1111-4111-8111-111111111111", WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ON = { SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", STATE_TABLE_NAME: "state", AGENTX_ENV: "staging", SLACK_TEAM_ID: INSTALL };

describe("the notifier's routing", () => {
  const world = () => {
    const db = new FakeDynamoDb();
    const serves = (body: unknown) => noticeServedByCompany({ documentClient: db, tableName: "state", legacyTeamId: INSTALL }, body);
    const task = (fields: Record<string, unknown>) => db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", ...fields });
    return { db, serves, task };
  };
  const notice = (fields: Record<string, unknown>) => JSON.stringify({ id: "n", at: "2026-11-17T00:00:00.000Z", kind: "start", ...fields });

  it("keeps the install's own work on today's handler and sends everything else to the company handler", async () => {
    const { serves, task } = world();
    task({ share: { teamId: INSTALL, channelId: "C1", threadTs: "1.1" } });
    expect(await serves(notice({ taskId: TASK }))).toBe(false);
    task({ companyId: IMPLICIT_COMPANY_ID });
    expect(await serves(notice({ taskId: TASK }))).toBe(false);
    for (const fields of [{ share: { teamId: OTHER } }, { companyId: B }, { orgId: B }, { companyId: IMPLICIT_COMPANY_ID, orgId: B }, { share: null }, { companyId: 7 }]) {
      task(fields);
      expect(await serves(notice({ taskId: TASK })), JSON.stringify(fields)).toBe(true);
    }
  });

  it("reads a workspace-only notice's workspace, and keeps install-only or empty notices on today's handler", async () => {
    const { db, serves } = world();
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE" });
    expect(await serves(notice({ workspaceId: WORKSPACE }))).toBe(false);
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", companyId: B });
    expect(await serves(notice({ workspaceId: WORKSPACE }))).toBe(true);
    for (const kind of ["admin_change_dm", "admin_change_outcome", "admin_change_expiry"]) expect(await serves(notice({ kind, taskId: TASK }))).toBe(false);
    expect(await serves(notice({}))).toBe(false);
    expect(await serves("{not json")).toBe(false);
    // A named task that is missing: the company handler (which refuses), never the install token.
    expect(await serves(notice({ taskId: TASK }))).toBe(true);
    // An id that is not one is not trusted.
    expect(await serves(notice({ taskId: "x/../y" }))).toBe(true);
    expect(await serves(notice({ workspaceId: 7 }))).toBe(true);
  });

  it("checks the task a workspace-only notice posts from, and a ChatGPT fallback's own thread", async () => {
    const { db, serves, task } = world();
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE" });
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: TASK });
    task({ share: { teamId: INSTALL } });
    expect(await serves(notice({ kind: "ready", workspaceId: WORKSPACE }))).toBe(false);
    task({ share: { teamId: OTHER } });
    expect(await serves(notice({ kind: "ready", workspaceId: WORKSPACE }))).toBe(true);
    task({ share: { teamId: INSTALL } });
    const OPERATION = "33333333-3333-4333-8333-333333333333";
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, chatgptThread: { teamId: INSTALL, channelId: "C1", threadTs: "1.1" } });
    expect(await serves(notice({ kind: "chatgpt_fallback", workspaceId: WORKSPACE, operationId: OPERATION }))).toBe(false);
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, chatgptThread: { teamId: OTHER, channelId: "C1", threadTs: "1.1" } });
    expect(await serves(notice({ kind: "chatgpt_fallback", workspaceId: WORKSPACE, operationId: OPERATION }))).toBe(true);
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, chatgptThread: null });
    expect(await serves(notice({ kind: "chatgpt_fallback", workspaceId: WORKSPACE, operationId: OPERATION }))).toBe(true);
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: "not-an-id" });
    expect(await serves(notice({ kind: "ready", workspaceId: WORKSPACE }))).toBe(true);
  });

  it("splits only queued notices, merges the failures, and retries (never posts) a notice whose record cannot be read", async () => {
    const legacy = vi.fn(async (event: { Records?: unknown[] }) => ({ batchItemFailures: (event.Records ?? []).map((record) => ({ itemIdentifier: `legacy:${(record as { messageId: string }).messageId}` })) }));
    const company = vi.fn(async (event: { Records?: unknown[] }) => ({ batchItemFailures: (event.Records ?? []).map((record) => ({ itemIdentifier: `company:${(record as { messageId: string }).messageId}` })) }));
    expect(splitNoticesBySlackCompany(legacy, undefined, async () => true)).toBe(legacy);
    const split = splitNoticesBySlackCompany(legacy, company, async (body) => { if (body === "boom") throw new Error("read failed"); return body === "company"; });
    const sqs = (messageId: string, body: string) => ({ eventSource: "aws:sqs", messageId, body });
    const answer = await split({ Records: [sqs("1", "own"), sqs("2", "company"), sqs("3", "boom")] });
    expect(answer.batchItemFailures).toEqual([{ itemIdentifier: "3" }, { itemIdentifier: "legacy:1" }, { itemIdentifier: "company:2" }]);
    // Stream records (they only queue notices) stay on today's handler whole.
    const stream = { Records: [{ eventSource: "aws:dynamodb", eventID: "s" }] };
    await split(stream);
    expect(legacy).toHaveBeenLastCalledWith(stream, undefined);
    expect(company).toHaveBeenCalledTimes(1);
  });

  it("the export is two handlers once the company factory's inputs are there, whatever the retired switches say (#1614)", async () => {
    const { notifierFromEnvironment } = await import("../../packages/broker/src/aws/developer-task-notifier.js");
    const made: unknown[] = [];
    const make = (workspaces?: unknown) => { made.push(workspaces); return (async () => ({ batchItemFailures: [] })) as never; };
    notifierFromEnvironment({ ...ON, AGENTX_ENV: "" }, make);
    expect(made).toEqual([undefined]);
    made.length = 0;
    notifierFromEnvironment({ ...ON, COMPANY_SIGNIN: undefined, SLACK_COMPANY_WORKSPACES: undefined }, make);
    expect(made).toHaveLength(2);
    expect(made[0]).toBeUndefined();
    expect(made[1]).toBeDefined();
  });
});

describe("the reconciler's install rule", () => {
  it("counts only the install's team with a record of the implicit company", () => {
    expect(slackNoteIsInstalls(INSTALL, {}, INSTALL)).toBe(true);
    expect(slackNoteIsInstalls(INSTALL, { orgId: IMPLICIT_COMPANY_ID }, INSTALL)).toBe(true);
    expect(slackNoteIsInstalls(INSTALL, { orgId: B }, INSTALL)).toBe(false);
    expect(slackNoteIsInstalls(INSTALL, {}, OTHER)).toBe(false);
    expect(slackNoteIsInstalls(undefined, {}, INSTALL)).toBe(false);
    expect(slackNoteIsInstalls(INSTALL, null, INSTALL)).toBe(false);
    expect(slackNoteIsInstalls(INSTALL, { entityType: "WORKSPACE_COMPANY_POINTER" }, INSTALL)).toBe(false);
  });
});

describe("the hosted Slack service", () => {
  async function stores() {
    const db = new FakeDynamoDb();
    const bindings = createSlackWorkspaceBindings({ client: db, tableName: "state", legacyTeamId: INSTALL });
    await bindings.backfill();
    await bindings.bind(B, OTHER, "operator");
    const secrets = new Map([[`agentx/staging/slack-workspaces/${B}/${OTHER}`, JSON.stringify({ botToken: slackTokens("b").bot })]]);
    const send = async (command: { input: { SecretId?: string } }) => {
      const value = secrets.get(command.input.SecretId ?? "");
      if (value === undefined) throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
      return { SecretString: value };
    };
    return { db, bindings, secrets, send };
  }

  it("builds nothing unless it is fully configured (#1614: no switch to turn it off)", () => {
    expect(serviceSlackWorkspacesFromEnvironment({ ...ON, SLACK_COMPANY_WORKSPACES: "disabled", COMPANY_SIGNIN: undefined }, { documentClient: { send: vi.fn() }, secrets: { send: vi.fn() } })).toBeDefined();
    for (const off of [{ STATE_TABLE_NAME: "" }, { AGENTX_ENV: "" }, { SLACK_TEAM_ID: "" }, { SLACK_TEAM_ID: "E0GRID000" }]) {
      expect(serviceSlackWorkspacesFromEnvironment({ ...ON, ...off }, { documentClient: { send: vi.fn() }, secrets: { send: vi.fn() } }), JSON.stringify(off)).toBeUndefined();
    }
  });

  it("agrees with the broker's binding and token readers for every case", async () => {
    const { db, bindings, send } = await stores();
    const service = serviceSlackWorkspacesFromEnvironment(ON, { documentClient: db, secrets: { send } })!;
    const broker = createSlackWorkspaceTokens({ bindings, environment: "staging", readSecret: async (name) => { try { return (await send({ input: { SecretId: name } })).SecretString; } catch { return undefined; } } });
    for (const [company, team] of [[B, OTHER], ["org_aaaaaaaaaaaaaaaaaaaa", OTHER], [B, "T0NOBINDING"], ["bad", OTHER], [B, "bad"]] as const) {
      expect(await service.workspaces.tokenForCompany(company, team), `${company} ${team}`).toBe(await broker.tokenForCompany(company, team));
    }
    expect(await service.workspaces.requireCompany(OTHER)).toBe(B);
    // The broker's strict binding shape: an extra field, or a missing or malformed boundAt, is no binding, as there.
    const row = db.get(`SLACK_TEAM#${OTHER}`, "BINDING")!;
    for (const change of [{ extra: 1 }, { boundAt: undefined }, { boundAt: "yesterday" }, { boundAt: "2026-02-30T00:00:00.000Z" }, { boundAt: "2026-11-17 00:00:00Z" }, { boundBy: "Not An Operator" }]) {
      const changed: Record<string, unknown> = { ...row, ...change };
      for (const [name, value] of Object.entries(changed)) if (value === undefined) delete changed[name];
      db.set(changed);
      await expect(service.workspaces.requireCompany(OTHER), JSON.stringify(change)).rejects.toThrow();
      await expect(bindings.requireCompany(OTHER), JSON.stringify(change)).rejects.toThrow();
    }
    db.set(row);
    await expect(service.workspaces.requireCompany("T0NOBINDING")).rejects.toThrow("This Slack workspace is not available.");
    // A dropped token (#836 leaves {removed:true}) gives none.
    const { secrets } = await stores();
    secrets.set(`agentx/staging/slack-workspaces/${B}/${OTHER}`, JSON.stringify({ removed: true }));
    expect(await serviceSlackWorkspacesFromEnvironment(ON, { documentClient: db, secrets: { send: async (c: { input: { SecretId?: string } }) => ({ SecretString: secrets.get(c.input.SecretId ?? "") }) } })!.workspaces.tokenForCompany(B, OTHER)).toBeUndefined();
  });

  it("keeps the install's team on the install token and gives other teams their own client", async () => {
    const legacyToken = vi.fn(async () => slackTokens("legacy").bot);
    const workspaces = { requireCompany: vi.fn(async () => B), tokenForCompany: vi.fn(async () => slackTokens("b").bot) };
    const clients = createWorkspaceSlackClients({ legacyToken, workspaces, legacyTeamId: INSTALL });
    const own = await clients.forThread({ teamId: INSTALL });
    const other = await clients.forThread({ teamId: OTHER });
    expect(own).not.toBe(other);
    expect(workspaces.requireCompany).toHaveBeenCalledTimes(1);
    expect(workspaces.requireCompany).toHaveBeenCalledWith(OTHER);
    // Without a legacy team (as before), the install's team is a company team too.
    await createWorkspaceSlackClients({ legacyToken, workspaces }).forThread({ teamId: INSTALL });
    expect(workspaces.requireCompany).toHaveBeenCalledWith(INSTALL);
  });
});
