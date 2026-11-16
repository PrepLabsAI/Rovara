// Token material never enters an event, stored directory row or diagnostic.
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
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
