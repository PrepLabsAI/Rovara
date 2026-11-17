// DEC 254o (b), L2-2 PR 18d: Slack company mode in the hosted Slack service (ECS). The service cannot import the broker, so this is the same read-only reader the broker's
// slack-workspace-binding.ts / slack-workspace-tokens.ts implement, kept to what the service needs and checked against them in
// tests/contract/slack-company-rest.test.ts. Nothing is built unless SLACK_COMPANY_WORKSPACES=enabled AND COMPANY_SIGNIN=enabled with STATE_TABLE_NAME, AGENTX_ENV and a
// valid SLACK_TEAM_ID present. The install's team never reaches it (createWorkspaceSlackClients keeps it on the install token); every other team needs its binding
// (SLACK_TEAM#<team>/BINDING) and its company's own secret (agentx/<env>/slack-workspaces/<company>/<team>). No fallback, no write.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ServiceSlackWorkspaces } from "./slack-workspace-clients.js";

type Sender = { send(command: never): Promise<unknown> };
const TEAM = /^T[A-Z0-9]{2,31}$/u;
const ORG = /^org_[0-9a-z]{20}$/u;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/u;
const TOKEN = /^xoxb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const refused = () => new Error("This Slack workspace is not available.");
const BINDING_FIELDS = ["boundAt", "boundBy", "companyId", "entityType", "pk", "sk", "teamId"].join(",");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const OPERATOR = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/u;
const PERSON = /^[a-f0-9]{64}$/u;

export function serviceSlackWorkspacesFromEnvironment(env: NodeJS.ProcessEnv, clients: { documentClient: Sender; secrets: Sender; now?: () => number }): { workspaces: ServiceSlackWorkspaces; legacyTeamId: string } | undefined {
  if (env.SLACK_COMPANY_WORKSPACES !== "enabled" || env.COMPANY_SIGNIN !== "enabled") return undefined;
  const tableName = env.STATE_TABLE_NAME ?? "";
  const environment = env.AGENTX_ENV ?? "";
  const legacyTeamId = env.SLACK_TEAM_ID ?? "";
  if (tableName === "" || !ENVIRONMENT.test(environment) || !TEAM.test(legacyTeamId)) return undefined;
  const now = clients.now ?? Date.now;
  const cache = new Map<string, { token: string; expires: number }>();
  const requireCompany = async (teamId: string): Promise<string> => {
    if (typeof teamId !== "string" || !TEAM.test(teamId)) throw refused();
    const key = { pk: `SLACK_TEAM#${teamId}`, sk: "BINDING" };
    const row = ((await clients.documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }) as never)) as { Item?: Record<string, unknown> } | undefined)?.Item;
    // The broker's parseBinding, field for field: exactly these fields, each of its shape (slack-workspace-binding.ts bindingRow, strict).
    if (row === undefined || Object.keys(row).sort().join(",") !== BINDING_FIELDS || row.pk !== key.pk || key.pk.length > 43 || row.sk !== "BINDING" || row.entityType !== "SLACK_WORKSPACE_BINDING"
      || row.teamId !== teamId || typeof row.companyId !== "string" || !ORG.test(row.companyId)
      || typeof row.boundAt !== "string" || !ISO.test(row.boundAt) || Number.isNaN(Date.parse(row.boundAt)) || new Date(row.boundAt).toISOString().slice(0, 10) !== row.boundAt.slice(0, 10)
      || typeof row.boundBy !== "string" || !(OPERATOR.test(row.boundBy) && row.boundBy.length <= 64 || PERSON.test(row.boundBy))) throw refused();
    return row.companyId;
  };
  return {
    legacyTeamId,
    workspaces: {
      requireCompany,
      async tokenForCompany(companyId, teamId) {
        try {
          if (typeof companyId !== "string" || !ORG.test(companyId) || await requireCompany(teamId) !== companyId) return undefined;
          const cacheKey = `${companyId}/${teamId}`;
          const found = cache.get(cacheKey);
          if (found !== undefined && found.expires > now()) return found.token;
          cache.delete(cacheKey);
          let raw: string | undefined;
          try {
            raw = ((await clients.secrets.send(new GetSecretValueCommand({ SecretId: `agentx/${environment}/slack-workspaces/${companyId}/${teamId}` }) as never)) as { SecretString?: string }).SecretString;
          } catch (error) {
            if (error instanceof Error && error.name === "ResourceNotFoundException") return undefined;
            throw error;
          }
          if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return undefined;
          const value: unknown = JSON.parse(raw);
          const token = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { botToken?: unknown }).botToken : undefined;
          if (typeof token !== "string" || token.length > 4096 || !TOKEN.test(token)) return undefined;
          if (cache.size >= 1000) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
          cache.set(cacheKey, { token, expires: now() + 300_000 });
          return token;
        } catch { return undefined; }
      },
    },
  };
}
