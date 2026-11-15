// Operator-only workspace directory. No token or identity claim can choose a company.
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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
const bindingRow = z.object({
  pk: z.string().max(43), sk: z.literal("BINDING"), entityType: z.literal("SLACK_WORKSPACE_BINDING"),
  teamId: SlackTeamIdSchema, companyId: OrgIdSchema, boundAt: z.iso.datetime(), boundBy: operator,
}).strict();
const markerKey = { pk: "SLACK_WORKSPACE_BINDING", sk: "BACKFILL" };
const markerRow = z.object({ pk: z.literal("SLACK_WORKSPACE_BINDING"), sk: z.literal("BACKFILL") }).strict();
const teamKey = (teamId: string) => ({ pk: `SLACK_TEAM#${teamId}`, sk: "BINDING" });

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
  const storedCompany = async (send: Send, team: string): Promise<string | undefined> => {
    const row = await read(send, teamKey(team));
    if (row === undefined) return undefined;
    const parsed = bindingRow.safeParse(row);
    if (!parsed.success || parsed.data.teamId !== team || parsed.data.pk !== teamKey(team).pk || !slackWorkspaceTeam(parsed.data.teamId)) throw new SlackWorkspaceRefused();
    return parsed.data.companyId;
  };
  const claim = async (send: Send, company: string, team: string, by: string) => {
    const found = await storedCompany(send, team);
    if (found !== undefined) { if (found !== company) throw new SlackWorkspaceRefused(); return; }
    try {
      await send(new PutCommand({ TableName: deps.tableName, Item: { ...teamKey(team), entityType: "SLACK_WORKSPACE_BINDING", teamId: team, companyId: company, boundAt: new Date(now()).toISOString(), boundBy: by }, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException" || await storedCompany(send, team) !== company) throw new SlackWorkspaceRefused();
    }
  };
  const companyOf = (team: string) => operation(async (send) => {
    if (!slackWorkspaceTeam(team)) throw new SlackWorkspaceRefused();
    const company = await storedCompany(send, team);
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

/** Health enumerates explicit bindings only; old implicit fallback is not an installation list. */
export async function listSlackWorkspaceScopes(deps: SlackBindingDependencies, companyId: string): Promise<SlackWorkspaceScope[]> {
  try {
    if (!OrgIdSchema.safeParse(companyId).success) throw new SlackWorkspaceRefused();
    const started = Date.now(); let items = 0; let bytes = 0; let pages = 0;
    let cursor: Record<string, unknown> | undefined;
    const found: SlackWorkspaceScope[] = [];
    do {
      if (++pages > 10 || Date.now() - started > 3000) throw new SlackWorkspaceRefused();
      const response = await deps.client.send(new ScanCommand({ TableName: deps.tableName, ConsistentRead: true, Limit: 100,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      items += response.Items?.length ?? 0; bytes += Buffer.byteLength(JSON.stringify(response));
      if (items > 1000 || bytes > 1_048_576 || Date.now() - started > 3000) throw new SlackWorkspaceRefused();
      for (const row of response.Items ?? []) {
        if (row.entityType !== "SLACK_WORKSPACE_BINDING") continue;
        const parsed = bindingRow.safeParse(row);
        if (!parsed.success || parsed.data.pk !== teamKey(parsed.data.teamId).pk || !slackWorkspaceTeam(parsed.data.teamId)) throw new SlackWorkspaceRefused();
        if (parsed.data.companyId === companyId) found.push({ companyId, teamId: parsed.data.teamId });
        if (found.length > 32) throw new SlackWorkspaceRefused();
      }
      cursor = response.LastEvaluatedKey;
    } while (cursor !== undefined);
    return found;
  } catch { throw new SlackWorkspaceRefused(); }
}
