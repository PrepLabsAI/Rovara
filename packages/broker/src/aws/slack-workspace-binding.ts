// Operator-only workspace directory. No token or identity claim can choose a company.
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, SlackTeamIdSchema, type SlackWorkspaceScope } from "@agentx/contracts";
import { z } from "zod";
import type { ChannelCompanyOf } from "../core/channel/company.js";

export class SlackWorkspaceRefused extends Error {
  constructor() { super("This Slack workspace is not available."); this.name = "SlackWorkspaceRefused"; }
}

/** Team ids only: Enterprise Grid org tokens are not workspace credentials. */
export function slackWorkspaceTeam(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && value.startsWith("T") && SlackTeamIdSchema.safeParse(value).success;
}

// Labels are identifiers, not free text. In particular the grammar admits no token separators ('-').
const operator = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/);
/** Guided onboarding PR 4 (slack-company-install.ts): a company owner or admin who added Rovara to Slack is recorded by their person id. */
const person = z.string().regex(/^[a-f0-9]{64}$/);
const bindingRow = z.object({
  pk: z.string().max(43), sk: z.literal("BINDING"), entityType: z.literal("SLACK_WORKSPACE_BINDING"),
  teamId: SlackTeamIdSchema, companyId: OrgIdSchema, boundAt: z.iso.datetime(), boundBy: z.union([operator, person]),
}).strict();
export const markerKey = { pk: "SLACK_WORKSPACE_BINDING", sk: "BACKFILL" };
const markerRow = z.object({ pk: z.literal("SLACK_WORKSPACE_BINDING"), sk: z.literal("BACKFILL") }).strict();
export const teamKey = (teamId: string) => ({ pk: `SLACK_TEAM#${teamId}`, sk: "BINDING" });
export const companyWorkspaceKey = (companyId: string, teamId: string) => ({ pk: `ORG#${companyId}#SLACK_WORKSPACES`, sk: `TEAM#${teamId}` });
export type BindingRow = z.infer<typeof bindingRow>;
export function parseBinding(value: unknown): BindingRow {
  const row = bindingRow.parse(value);
  if (!slackWorkspaceTeam(row.teamId) || row.pk !== teamKey(row.teamId).pk) throw new SlackWorkspaceRefused();
  return row;
}
export function companyWorkspaceView(row: BindingRow) {
  return { ...companyWorkspaceKey(row.companyId, row.teamId), entityType: "COMPANY_SLACK_WORKSPACE_VIEW",
    teamId: row.teamId, companyId: row.companyId, boundAt: row.boundAt, boundBy: row.boundBy };
}
/** The condition covers every authoritative field, including the non-secret metadata.
 * A stale backfill/bind snapshot can never install a view of a different binding. */
function indexTransaction(tableName: string, row: BindingRow, create: boolean) {
  const authoritative = create
    ? { Put: { TableName: tableName, Item: row, ConditionExpression: "attribute_not_exists(pk)" } }
    : { ConditionCheck: { TableName: tableName, Key: teamKey(row.teamId),
      ConditionExpression: "entityType = :kind AND teamId = :team AND companyId = :company AND boundAt = :at AND boundBy = :by",
      ExpressionAttributeValues: { ":kind": "SLACK_WORKSPACE_BINDING", ":team": row.teamId, ":company": row.companyId, ":at": row.boundAt, ":by": row.boundBy } } };
  return new TransactWriteCommand({ TransactItems: [authoritative,
    { Put: { TableName: tableName, Item: companyWorkspaceView(row) } },
  ] });
}


export interface SlackWorkspaceBindings {
  companyOf(teamId: string): Promise<string | undefined>;
  requireCompany(teamId: string): Promise<string>;
  channelCompanyOf: ChannelCompanyOf;
  bind(companyId: string, teamId: string, by: string): Promise<void>;
  backfill(): Promise<{ teamsRead: 0 | 1 }>;
}

export interface SlackBindingDependencies {
  client: { send(command: unknown): Promise<unknown> };
  tableName: string;
  legacyTeamId?: string | undefined;
  now?: () => number;
}

/** One budget across each operation, including a conditional-write race's reread.
 * The host owns the I/O timeout: no detached timeout race may write after return. */
export function createSlackWorkspaceBindings(deps: SlackBindingDependencies): SlackWorkspaceBindings {
  const now = deps.now ?? Date.now;
  const legacy = slackWorkspaceTeam(deps.legacyTeamId) ? deps.legacyTeamId : undefined;
  const operation = <T>(body: (send: (command: unknown) => Promise<unknown>) => Promise<T>): Promise<T> => {
    const started = now(); let commands = 0; let bytes = 0;
    const check = () => { if (commands > 8 || bytes > 65_536 || now() - started > 10_000) throw new SlackWorkspaceRefused(); };
    if (deps.legacyTeamId !== undefined && deps.legacyTeamId !== "" && legacy === undefined) return Promise.reject(new SlackWorkspaceRefused());
    return body(async (command) => {
      commands++; check();
      const answer = await deps.client.send(command);
      bytes += Buffer.byteLength(JSON.stringify(answer) ?? ""); check();
      return answer;
    }).catch(() => { throw new SlackWorkspaceRefused(); });
  };
  type Send = (command: unknown) => Promise<unknown>;
  const read = async (send: Send, key: { pk: string; sk: string }): Promise<unknown> => {
    const response = await send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown } | undefined;
    if (response === null || typeof response !== "object" || Array.isArray(response)) throw new SlackWorkspaceRefused();
    return response.Item;
  };
  const complete = async (send: Send): Promise<boolean> => {
    const row = await read(send, markerKey);
    if (row === undefined) return false;
    if (!markerRow.safeParse(row).success) throw new SlackWorkspaceRefused();
    return true;
  };
  const storedBinding = async (send: Send, team: string): Promise<BindingRow | undefined> => {
    const row = await read(send, teamKey(team));
    if (row === undefined) return undefined;
    const parsed = parseBinding(row);
    if (parsed.teamId !== team) throw new SlackWorkspaceRefused();
    return parsed;
  };
  const claim = async (send: Send, company: string, team: string, by: string) => {
    const found = await storedBinding(send, team);
    if (found !== undefined) {
      if (found.companyId !== company) throw new SlackWorkspaceRefused();
      await send(indexTransaction(deps.tableName, found, false));
      return;
    }
    const row: BindingRow = { ...teamKey(team), sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: team, companyId: company, boundAt: new Date(now()).toISOString(), boundBy: by };
    try {
      await send(indexTransaction(deps.tableName, row, true));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw new SlackWorkspaceRefused();
      const winner = await storedBinding(send, team);
      if (winner?.companyId !== company) throw new SlackWorkspaceRefused();
      await send(indexTransaction(deps.tableName, winner, false));
    }
  };
  const companyOf = (team: string) => operation(async (send) => {
    if (!slackWorkspaceTeam(team)) throw new SlackWorkspaceRefused();
    const company = (await storedBinding(send, team))?.companyId;
    if (company !== undefined) return company;
    return !await complete(send) && team === legacy ? IMPLICIT_COMPANY_ID : undefined;
  });
  return {
    companyOf,
    async requireCompany(team) { const company = await companyOf(team); if (company === undefined) throw new SlackWorkspaceRefused(); return company; },
    channelCompanyOf: (where) => where !== null && typeof where === "object" && where.channel === "slack" ? companyOf(where.tenant) : undefined,
    bind: (company, team, by) => operation(async (send) => {
      if (!OrgIdSchema.safeParse(company).success || !slackWorkspaceTeam(team) || !operator.safeParse(by).success) throw new SlackWorkspaceRefused();
      if (!await complete(send) && company !== IMPLICIT_COMPANY_ID) throw new SlackWorkspaceRefused();
      await claim(send, company, team, by);
    }),
    backfill: () => operation(async (send) => {
      if (await complete(send)) return { teamsRead: 0 };
      if (legacy !== undefined) await claim(send, IMPLICIT_COMPANY_ID, legacy, "backfill");
      try {
        await send(new PutCommand({ TableName: deps.tableName, Item: markerKey, ConditionExpression: "attribute_not_exists(pk)" }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException" || !await complete(send)) throw new SlackWorkspaceRefused();
      }
      return { teamsRead: legacy === undefined ? 0 : 1 };
    }),
  };
}

/** Operator Lambda payloads carry identifiers only. Unexpected fields refuse before storage. */
export const SlackWorkspaceOperatorEventSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("agentx.slack-workspace-bind"), teamId: z.string().max(32).refine(slackWorkspaceTeam), companyId: OrgIdSchema, by: operator }).strict(),
  z.object({ source: z.literal("agentx.slack-workspace-backfill") }).strict(),
]);
export type SlackWorkspaceOperatorEvent = z.infer<typeof SlackWorkspaceOperatorEventSchema>;
export function isSlackWorkspaceOperatorEvent(event: unknown): event is SlackWorkspaceOperatorEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const source = (event as { source?: unknown }).source;
  // Recognise malformed payloads too so they receive the same fixed refusal, not HTTP parsing.
  return source === "agentx.slack-workspace-bind" || source === "agentx.slack-workspace-backfill";
}

const cursorSchema = z.object({ pk: z.string().min(1).max(2048), sk: z.string().min(1).max(1024) }).strict();
const pageSchema = z.object({
  Items: z.array(z.record(z.string(), z.unknown())).optional(),
  LastEvaluatedKey: cursorSchema.optional(),
  ScannedCount: z.number().int().nonnegative().optional(),
}).passthrough();

/** Explicit bindings only. Query never reads another company's partition, or falls back to Scan.
 * One TOTAL budget, including empty pages and response metadata. The host retains its I/O timeout. */
export async function listSlackWorkspaceScopes(deps: SlackBindingDependencies, companyId: string): Promise<SlackWorkspaceScope[]> {
  try {
    if (!OrgIdSchema.safeParse(companyId).success) throw new SlackWorkspaceRefused();
    const now = deps.now ?? Date.now;
    const started = now(); let items = 0; let bytes = 0; let pages = 0;
    const pk = companyWorkspaceKey(companyId, "").pk;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    const found: SlackWorkspaceScope[] = [];
    const seen = new Set<string>();
    do {
      if (++pages > 10 || now() - started > 3000) throw new SlackWorkspaceRefused();
      const answer = await deps.client.send(new QueryCommand({ TableName: deps.tableName, ConsistentRead: true, Limit: 33 - items,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :team)", ExpressionAttributeValues: { ":pk": pk, ":team": "TEAM#" },
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) }));
      bytes += Buffer.byteLength(JSON.stringify(answer) ?? "");
      if (bytes > 65_536 || now() - started > 3000) throw new SlackWorkspaceRefused();
      const response = pageSchema.parse(answer);
      items += Math.max(response.Items?.length ?? 0, response.ScannedCount ?? 0);
      if (items > 32) throw new SlackWorkspaceRefused();
      for (const row of response.Items ?? []) {
        if (!slackWorkspaceTeam(row.teamId)) throw new SlackWorkspaceRefused();
        const expected = companyWorkspaceKey(companyId, row.teamId);
        if (row.pk !== expected.pk || row.sk !== expected.sk || row.entityType !== "COMPANY_SLACK_WORKSPACE_VIEW" || row.companyId !== companyId || seen.has(row.teamId)) throw new SlackWorkspaceRefused();
        const parsed = parseBinding({ ...row, ...teamKey(row.teamId), entityType: "SLACK_WORKSPACE_BINDING" });
        seen.add(parsed.teamId);
        found.push({ companyId, teamId: parsed.teamId });
      }
      cursor = response.LastEvaluatedKey;
      if (cursor !== undefined && (cursor.pk !== pk || !cursor.sk.startsWith("TEAM#") || !slackWorkspaceTeam(cursor.sk.slice(5)))) throw new SlackWorkspaceRefused();
    } while (cursor !== undefined);
    return found;
  } catch { throw new SlackWorkspaceRefused(); }
}

const indexBackfillOptions = z.object({ dryRun: z.boolean(), cursor: cursorSchema.optional() }).strict();
/** Operator-only, resumable one-off migration. Each call evaluates at most 100 table items,
 * 2 MiB total request/response bytes and 10 seconds. A continuation explicitly means unfinished.
 * Deploy all transactional writers first; keep company enumeration off until complete.
 * On refusal, previously committed rows are safe; retry the same cursor (idempotent).
 * No detached timeout race: the operator host must bound/abort and await its SDK I/O. */
export async function backfillSlackWorkspaceIndex(deps: SlackBindingDependencies, input: z.infer<typeof indexBackfillOptions>): Promise<{
  evaluated: number; bindings: number; written: number; complete: boolean; cursor?: z.infer<typeof cursorSchema>;
}> {
  try {
    const options = indexBackfillOptions.parse(input);
    const now = deps.now ?? Date.now; const started = now(); let bytes = 0; let commands = 0;
    const check = () => { if (commands > 101 || bytes > 2_097_152 || now() - started > 10_000) throw new SlackWorkspaceRefused(); };
    const send = async (command: ScanCommand | TransactWriteCommand) => {
      commands++; bytes += Buffer.byteLength(JSON.stringify(command.input)); check();
      const answer = await deps.client.send(command);
      bytes += Buffer.byteLength(JSON.stringify(answer) ?? ""); check(); return answer;
    };
    const answer = await send(new ScanCommand({ TableName: deps.tableName, ConsistentRead: true, Limit: 100,
      ProjectionExpression: "pk, sk, entityType, teamId, companyId, boundAt, boundBy",
      ...(options.cursor === undefined ? {} : { ExclusiveStartKey: options.cursor }) }));
    if (Buffer.byteLength(JSON.stringify(answer) ?? "") > 1_048_576) throw new SlackWorkspaceRefused();
    const page = pageSchema.parse(answer);
    const evaluated = Math.max(page.Items?.length ?? 0, page.ScannedCount ?? 0);
    if (evaluated > 100) throw new SlackWorkspaceRefused();
    const bindings = (page.Items ?? []).filter((row) => row.entityType === "SLACK_WORKSPACE_BINDING" || (typeof row.pk === "string" && row.pk.startsWith("SLACK_TEAM#") && row.sk === "BINDING")).map(parseBinding);
    let written = 0;
    for (const row of bindings) {
      check();
      if (!options.dryRun) { await send(indexTransaction(deps.tableName, row, false)); written++; }
    }
    check();
    return { evaluated, bindings: bindings.length, written, complete: page.LastEvaluatedKey === undefined,
      ...(page.LastEvaluatedKey === undefined ? {} : { cursor: page.LastEvaluatedKey }) };
  } catch { throw new SlackWorkspaceRefused(); }
}

/**
 * #1300: an operator move of a Slack workspace's binding between the built-in company and one named company (aws/legacy-install-move.ts). One side is always the built-in company,
 * so a workspace can never move from one named company to another. A preview by default: the plan names the rows it would write and writes nothing. Applied, one conditional
 * transaction moves the binding (only while it still holds exactly what was read) and its company views; anything else refuses in fixed words.
 */
export interface WorkspaceMove { teamId: string; from: string; to: string; by: string; apply?: boolean }
export interface WorkspaceMovePlan { teamId: string; from: string; to: string; applied: boolean; writes: string[] }
export async function moveSlackWorkspace(deps: SlackBindingDependencies, move: WorkspaceMove): Promise<WorkspaceMovePlan> {
  const { teamId, from, to, by } = move;
  if (!slackWorkspaceTeam(teamId) || !OrgIdSchema.safeParse(from).success || !OrgIdSchema.safeParse(to).success || from === to
    || (from !== IMPLICIT_COMPANY_ID && to !== IMPLICIT_COMPANY_ID) || !operator.safeParse(by).success) throw new SlackWorkspaceRefused();
  const read = async (key: { pk: string; sk: string }) => (await deps.client.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown }).Item;
  const marker = await read(markerKey);
  if (marker === undefined || !markerRow.safeParse(marker).success) throw new SlackWorkspaceRefused();
  const found = parseBinding(await read(teamKey(teamId)));
  if (found.teamId !== teamId || found.companyId !== from) throw new SlackWorkspaceRefused();
  const moved: BindingRow = { ...found, companyId: to, boundAt: new Date((deps.now ?? Date.now)()).toISOString(), boundBy: by };
  const writes = [`${teamKey(teamId).pk} ${from} -> ${to}`, `delete ${companyWorkspaceKey(from, teamId).pk}`, `put ${companyWorkspaceKey(to, teamId).pk}`];
  if (move.apply !== true) return { teamId, from, to, applied: false, writes };
  await deps.client.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: deps.tableName, Item: moved, ConditionExpression: "entityType = :kind AND teamId = :team AND companyId = :company AND boundAt = :at AND boundBy = :by",
      ExpressionAttributeValues: { ":kind": "SLACK_WORKSPACE_BINDING", ":team": found.teamId, ":company": found.companyId, ":at": found.boundAt, ":by": found.boundBy } } },
    { Delete: { TableName: deps.tableName, Key: companyWorkspaceKey(from, teamId) } },
    { Put: { TableName: deps.tableName, Item: companyWorkspaceView(moved) } },
  ] }));
  return { teamId, from, to, applied: true, writes };
}
