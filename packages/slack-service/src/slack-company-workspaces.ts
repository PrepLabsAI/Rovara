// DEC 254o (b), L2-2 PR 18d: Slack company mode in the hosted Slack service (ECS). The service cannot import the broker, so this is the same read-only reader the broker's
// slack-workspace-binding.ts / slack-workspace-tokens.ts implement, kept to what the service needs and checked against them in
// tests/contract/slack-company-rest.test.ts. Nothing is built unless SLACK_COMPANY_WORKSPACES=enabled AND COMPANY_SIGNIN=enabled with STATE_TABLE_NAME, AGENTX_ENV and a
// valid SLACK_TEAM_ID present. The install's team never reaches it (createWorkspaceSlackClients keeps it on the install token); every other team needs its binding
// (SLACK_TEAM#<team>/BINDING) and its company's own secret (agentx/<env>/slack-workspaces/<company>/<team>). No fallback to another token, no write.
//
// R5 step 1 (DEC 254zzz444): with SLACK_COMPANY_TOKEN_ROLE_ARN set, the secret is read through a SESSION tagged with the company the BINDING names (rovara:org, 900 s, cached per company), whose only
// grant is that company's own token path (infra/lib/slack-company-token-reader.ts): the company is taken from the binding row inside tokenForCompany, never from a caller's or a turn's value, and
// an AI turn only ever holds a token reader that has already done this. Release 1 (SLACK_COMPANY_TOKEN_FALLBACK=shared) falls back to the task role's own family-wide read when the session cannot be
// made or read; release 2 drops the variable, and then a failed scoped read is a refusal. Variable unset: the service reads through its own role, exactly as before.
import { randomBytes } from "node:crypto";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ServiceSlackWorkspaces } from "./slack-workspace-clients.js";

type Sender = { send(command: never): Promise<unknown> };
/** The session the host's STS call returns (aws-adapters secrets-manager/tagged-session.ts CompanySession; the service cannot import it). */
export interface CompanySession { credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; expiresAt: number }
export interface ScopedSecrets {
  /** The host's STS call: assume `roleArn` with exactly `tags`. */
  assumeRole(request: { roleArn: string; sessionName: string; tags: Array<{ Key: string; Value: string }>; durationSeconds: number }): Promise<CompanySession>;
  clientFrom(credentials: CompanySession["credentials"]): Sender;
}
export const COMPANY_TAG_KEY = "rovara:org";
const ROLE_ARN = /^arn:aws(?:-[^:]+)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u;
const TEAM = /^T[A-Z0-9]{2,31}$/u;
const ORG = /^org_[0-9a-z]{20}$/u;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/u;
const TOKEN = /^xoxb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const refused = () => new Error("This Slack workspace is not available.");
const BINDING_FIELDS = ["boundAt", "boundBy", "companyId", "entityType", "pk", "sk", "teamId"].join(",");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const OPERATOR = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/u;
const PERSON = /^[a-f0-9]{64}$/u;

const notFound = (error: unknown) => error instanceof Error && error.name === "ResourceNotFoundException";
const validSession = (session: CompanySession, now: number): boolean => {
  const { accessKeyId, secretAccessKey, sessionToken } = session.credentials;
  return Number.isFinite(session.expiresAt) && session.expiresAt > now + 60_000 && [accessKeyId, secretAccessKey, sessionToken].every((value) => typeof value === "string" && value !== "");
};

/**
 * One session per company, minted from the company the binding named (a value that already passed ORG), never from a turn: the tag is that company's, 900 s, cached until a minute before it
 * expires, one mint in flight per company.
 */
function companySessionClients(roleArn: string, scoped: ScopedSecrets | undefined, now: () => number): (company: string) => Promise<Sender> {
  const sessions = new Map<string, { client: Sender; expiresAt: number }>();
  const pending = new Map<string, Promise<Sender>>();
  const mint = async (scopedSecrets: ScopedSecrets, company: string): Promise<Sender> => {
    sessions.delete(company);
    const session = await scopedSecrets.assumeRole({ roleArn, sessionName: `rovara-slack-${company}-${randomBytes(8).toString("hex")}`, tags: [{ Key: COMPANY_TAG_KEY, Value: company }], durationSeconds: 900 });
    if (!validSession(session, now())) throw refused();
    const client = scopedSecrets.clientFrom(session.credentials);
    if (sessions.size >= 1000) { const oldest = sessions.keys().next().value; if (oldest !== undefined) sessions.delete(oldest); }
    sessions.set(company, { client, expiresAt: session.expiresAt });
    return client;
  };
  return async (company) => {
    if (scoped === undefined || !ROLE_ARN.test(roleArn) || !ORG.test(company)) throw refused();
    const held = sessions.get(company);
    if (held !== undefined && now() < held.expiresAt - 60_000) return held.client;
    const active = pending.get(company);
    if (active !== undefined) return active;
    const task = mint(scoped, company);
    pending.set(company, task);
    try { return await task; } finally { pending.delete(company); }
  };
}

/** The bot token in a stored secret's text, or undefined (too big, not an object, not a bot token). */
function botTokenOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return undefined;
  const value: unknown = JSON.parse(raw);
  const token = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { botToken?: unknown }).botToken : undefined;
  return typeof token === "string" && token.length <= 4096 && TOKEN.test(token) ? token : undefined;
}

/**
 * Reads the secret text through the company's session when there is one (scoped), else through the task role. Release 1 (fallbackShared): a failed scoped read logs an error NAME only and
 * uses the task role; a missing secret is none either way. Without the fallback a failed scoped read throws (the caller refuses).
 */
async function readCompanySecret(input: { client: Sender; sessionClient: (() => Promise<Sender>) | undefined; fallbackShared: boolean; log: ((event: string, fields: Record<string, unknown>) => void) | undefined; secretId: string }): Promise<string | undefined> {
  const read = async (client: Sender): Promise<string | undefined> => ((await client.send(new GetSecretValueCommand({ SecretId: input.secretId }) as never)) as { SecretString?: string }).SecretString;
  const orNone = async (client: () => Promise<Sender>): Promise<string | undefined> => {
    try { return await read(await client()); } catch (error) { if (notFound(error)) return undefined; throw error; }
  };
  if (input.sessionClient === undefined) return orNone(async () => input.client);
  try {
    return await read(await input.sessionClient());
  } catch (error) {
    if (notFound(error)) return undefined;
    if (!input.fallbackShared) throw error;
    input.log?.("slack.company_token_scoped_failed", { error: error instanceof Error ? error.name : "unknown" });
    return orNone(async () => input.client);
  }
}

export function serviceSlackWorkspacesFromEnvironment(env: NodeJS.ProcessEnv, clients: { documentClient: Sender; secrets: Sender; now?: () => number; scoped?: ScopedSecrets; log?: (event: string, fields: Record<string, unknown>) => void }): { workspaces: ServiceSlackWorkspaces; legacyTeamId: string } | undefined {
  if (env.SLACK_COMPANY_WORKSPACES !== "enabled" || env.COMPANY_SIGNIN !== "enabled") return undefined;
  const tableName = env.STATE_TABLE_NAME ?? "";
  const environment = env.AGENTX_ENV ?? "";
  const legacyTeamId = env.SLACK_TEAM_ID ?? "";
  if (tableName === "" || !ENVIRONMENT.test(environment) || !TEAM.test(legacyTeamId)) return undefined;
  const now = clients.now ?? Date.now;
  const cache = new Map<string, { token: string; expires: number }>();
  const roleArn = env.SLACK_COMPANY_TOKEN_ROLE_ARN ?? "";
  const scopedOn = roleArn !== "";
  const fallbackShared = env.SLACK_COMPANY_TOKEN_FALLBACK === "shared";
  const sessionClient = companySessionClients(roleArn, clients.scoped, now);
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
          // The company is the BINDING's, and the argument must agree with it; the session tag and the secret path both come from the bound value.
          if (typeof companyId !== "string" || !ORG.test(companyId)) return undefined;
          const company = await requireCompany(teamId);
          if (company !== companyId) return undefined;
          const cacheKey = `${company}/${teamId}`;
          const found = cache.get(cacheKey);
          if (found !== undefined && found.expires > now()) return found.token;
          cache.delete(cacheKey);
          const raw = await readCompanySecret({ client: clients.secrets, sessionClient: scopedOn ? () => sessionClient(company) : undefined, fallbackShared, log: clients.log, secretId: `agentx/${environment}/slack-workspaces/${company}/${teamId}` });
          const token = botTokenOf(raw);
          if (token === undefined) return undefined;
          if (cache.size >= 1000) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
          cache.set(cacheKey, { token, expires: now() + 300_000 });
          return token;
        } catch { return undefined; }
      },
    },
  };
}
