// Token material never enters an event, stored directory row or diagnostic.
import { IMPLICIT_COMPANY_ID, OrgIdSchema, SlackWorkspaceScopeSchema, type SlackWorkspaceScope } from "@agentx/contracts";
import { SlackWorkspaceRefused, slackWorkspaceTeam, type SlackWorkspaceBindings } from "./slack-workspace-binding.js";

export interface SlackWorkspaceTokens {
  tokenForEvent(teamId: string): Promise<{ companyId: string; token: string } | undefined>;
  tokenForCompany(companyId: string, teamId: string): Promise<string | undefined>;
}
export interface SlackTokenDependencies {
  bindings: Pick<SlackWorkspaceBindings, "requireCompany">;
  environment: string;
  /** undefined means the secret does not exist; a failed read must throw. */
  readSecret(name: string): Promise<string | undefined>;
  legacyTeamId?: string;
  legacyToken?: () => Promise<string | undefined>;
  now?: () => number;
}
const validToken = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && /^xoxb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);

export function createSlackWorkspaceTokens(deps: SlackTokenDependencies): SlackWorkspaceTokens {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { token: string; expires: number }>();
  const load = async (team: string, askingCompany?: string): Promise<{ companyId: string; token: string } | undefined> => {
    const started = now();
    try {
      if (!slackWorkspaceTeam(team) || typeof deps.environment !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(deps.environment)) return undefined;
      const company = await deps.bindings.requireCompany(team);
      if (!OrgIdSchema.safeParse(company).success || (askingCompany !== undefined && askingCompany !== company) || now() - started > 10_000) return undefined;
      // Both path and cache scope come from the binding, never from the caller's company argument.
      const key = `${company}/${team}`;
      const found = cache.get(key);
      if (found !== undefined && found.expires > now()) return { companyId: company, token: found.token };
      if (found !== undefined) cache.delete(key);
      const raw = await deps.readSecret(`agentx/${deps.environment}/slack-workspaces/${company}/${team}`);
      if (now() - started > 10_000) return undefined;
      let token: unknown;
      if (raw === undefined) {
        if (company !== IMPLICIT_COMPANY_ID || team !== deps.legacyTeamId) return undefined;
        token = await deps.legacyToken?.();
      } else {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return undefined;
        const value: unknown = JSON.parse(raw);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
        token = (value as { botToken?: unknown }).botToken;
      }
      if (!validToken(token) || now() - started > 10_000) return undefined;
      if (cache.size >= 1000) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
      cache.set(key, { token, expires: now() + 300_000 });
      return { companyId: company, token };
    } catch { return undefined; }
  };
  return {
    tokenForEvent: (team) => load(team),
    async tokenForCompany(company, team) {
      if (!OrgIdSchema.safeParse(company).success) return undefined;
      return (await load(team, company))?.token;
    },
  };
}

/** A remote adapter selects only the explicitly named workspace; no installation fallback. */
export type SlackWorkspaceDelivery = Pick<SlackWorkspaceBindings, "requireCompany"> & Pick<SlackWorkspaceTokens, "tokenForEvent">;
export async function slackWorkspaceToken(workspaces: SlackWorkspaceDelivery, team: unknown): Promise<string> {
  try {
    if (!slackWorkspaceTeam(team)) throw new Error();
    const company = await workspaces.requireCompany(team);
    const found = await workspaces.tokenForEvent(team);
    if (!OrgIdSchema.safeParse(company).success || found === undefined || found.companyId !== company || !validToken(found.token)) throw new Error();
    return found.token;
  } catch { throw new SlackWorkspaceRefused(); }
}

/** Internal senders carry record-derived scope; never derive a company from a raw channel or user. */
export type SlackCallerWorkspaces = Pick<SlackWorkspaceBindings, "requireCompany"> & Pick<SlackWorkspaceTokens, "tokenForCompany">;
export async function slackCallerToken(workspaces: SlackCallerWorkspaces, scope: unknown): Promise<string> {
  try {
    const parsed = SlackWorkspaceScopeSchema.safeParse(scope);
    if (!parsed.success) throw new Error();
    const { companyId, teamId } = parsed.data;
    if (await workspaces.requireCompany(teamId) !== companyId) throw new Error();
    const token = await workspaces.tokenForCompany(companyId, teamId);
    if (!validToken(token)) throw new Error();
    return token;
  } catch { throw new SlackWorkspaceRefused(); }
}

/** Old records belong only to the implicit company. Invalid stored values never become defaults. */
export function slackRecordScope(record: unknown, teamId: unknown): SlackWorkspaceScope {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new SlackWorkspaceRefused();
  const row = record as { companyId?: unknown; orgId?: unknown };
  const parsed = SlackWorkspaceScopeSchema.safeParse({ companyId: row.companyId ?? row.orgId ?? IMPLICIT_COMPANY_ID, teamId });
  if (!parsed.success || row.companyId === null || row.orgId === null) throw new SlackWorkspaceRefused();
  return parsed.data;
}

/** Scope carried by Slack adapter callers, exported at the token adapter boundary. */
export type { SlackWorkspaceScope } from "@agentx/contracts";
