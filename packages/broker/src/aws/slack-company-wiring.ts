// DEC 254o (b), L2-2 PR 18c: Slack company mode's one factory. Every Slack consumer that takes part builds its company dependencies here, and only here, from its own
// environment: nothing unless SLACK_COMPANY_WORKSPACES=enabled AND COMPANY_SIGNIN=enabled, with the State table, the environment's name and the install's team all present.
// Off, consumers keep their legacy exports exactly (each export checks for undefined and builds today's handler).
// The token is read by the consumer's own role (agentx/<env>/slack-workspaces/<company>/<team>, 18a's grants), always through the team's binding; the install's team stays
// on the legacy path in every consumer (slack-company-split.ts), so its token, notices and checks are today's.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DocumentStore } from "@agentx/contracts";
import { createDynamoStoreFromSettings } from "@rovara/aws-adapters/dynamodb";
import { companyMembershipFromDynamo, type CompanyMembershipReader } from "./company-check.js";
import { createSlackWorkspaceBindings, slackWorkspaceTeam } from "./slack-workspace-binding.js";
import { createSlackWorkspaceTokens, type SlackWorkspaceTokens } from "./slack-workspace-tokens.js";
import { slackLinkNotice, type SlackWorkspaceAccess } from "./slack-person.js";

type Sender = { send(command: never): Promise<unknown> };
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/u;
const PROJECT_NAME_MAX = 200;

export interface SlackCompanyWiring {
  /** The install's own team: always the legacy path. */
  legacyTeamId: string;
  workspaces: SlackWorkspaceAccess & Pick<SlackWorkspaceTokens, "tokenForCompany">;
  companies?: CompanyMembershipReader;
  /** Drop this process's cached token for a removed workspace (#836's verified removal). */
  forget(teamId: string): void;
}

export interface SlackCompanyClients {
  /** DynamoDB document client (binding, project and membership reads). */
  documentClient: Sender;
  /** Raw DynamoDB client for the document store (link rows). */
  dynamo: Sender;
  secrets: Sender;
  /** Where a link notice's code is confirmed: `${linkOrigin}/review/link/<code>`. */
  linkOrigin?: string;
  /** Replaces the store's writes for a consumer with no State write (the Slack Lambda: #126): the broker issues the notice. */
  linkNotice?: (teamId: string, userId: string) => Promise<string | undefined>;
}

/** Whether this process's environment asks for company mode at all (the two switches). */
export function slackCompanyModeRequested(env: NodeJS.ProcessEnv): boolean {
  return env.SLACK_COMPANY_WORKSPACES === "enabled" && env.COMPANY_SIGNIN === "enabled";
}

export function slackCompanyDependenciesFromEnvironment(env: NodeJS.ProcessEnv, clients: SlackCompanyClients): SlackCompanyWiring | undefined {
  if (!slackCompanyModeRequested(env)) return undefined;
  const tableName = env.STATE_TABLE_NAME ?? "";
  const environment = env.AGENTX_ENV ?? "";
  const legacyTeamId = env.SLACK_TEAM_ID ?? env.SLACK_ADAPTER_TEAM_ID ?? "";
  // A half-configured consumer stays legacy rather than guessing: no table, no environment name, or no install team means no company mode here.
  if (tableName === "" || !ENVIRONMENT.test(environment) || !slackWorkspaceTeam(legacyTeamId)) return undefined;
  const bindings = createSlackWorkspaceBindings({ client: clients.documentClient, tableName, legacyTeamId });
  const tokens = createSlackWorkspaceTokens({
    bindings, environment, legacyTeamId,
    // The install's team never reaches a company token read (the split keeps it legacy), so there is no install-token fallback here.
    async readSecret(name) {
      try {
        const answer = await clients.secrets.send(new GetSecretValueCommand({ SecretId: name }) as never) as { SecretString?: string };
        return answer.SecretString;
      } catch (error) {
        if (error instanceof Error && error.name === "ResourceNotFoundException") return undefined;
        throw error;
      }
    },
  });
  let store: DocumentStore | undefined;
  const storeOnce = (): DocumentStore => (store ??= createDynamoStoreFromSettings({ tableName, ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }) }, clients.dynamo));
  const lazyStore = new Proxy({} as DocumentStore, { get: (_target, field) => {
    const value = (storeOnce() as unknown as Record<PropertyKey, unknown>)[field];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(storeOnce()) : value;
  } });
  const signInTable = env.DEVELOPER_SIGNIN_TABLE_NAME ?? "";
  let origin: string | undefined;
  try { origin = clients.linkOrigin === undefined ? undefined : new URL(clients.linkOrigin).origin; } catch { origin = undefined; }
  return {
    legacyTeamId,
    forget: (teamId) => tokens.forget?.(teamId),
    ...(signInTable === "" ? {} : { companies: companyMembershipFromDynamo(clients.documentClient, signInTable) }),
    workspaces: {
      requireCompany: (teamId) => bindings.requireCompany(teamId),
      tokenForEvent: (teamId) => tokens.tokenForEvent(teamId),
      tokenForCompany: (companyId, teamId) => tokens.tokenForCompany(companyId, teamId),
      store: lazyStore,
      // Only the newest revision's company (18a grants exactly pk, sk, companyId on PROJECT#*).
      async getProject(name) {
        if (typeof name !== "string" || name.length === 0 || name.length > PROJECT_NAME_MAX || name.includes("#")) return undefined;
        const answer = await clients.documentClient.send(new QueryCommand({
          TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)", ExpressionAttributeValues: { ":pk": `PROJECT#${name}`, ":revision": "REV#" },
          ProjectionExpression: "pk, sk, companyId", ScanIndexForward: false, Limit: 1, ConsistentRead: true,
        }) as never) as { Items?: unknown[] };
        return answer.Items?.[0];
      },
      linkUrl(code) {
        if (origin === undefined) throw new Error("no link origin");
        return `${origin}/review/link/${encodeURIComponent(code)}`;
      },
      ...(clients.linkNotice === undefined ? {} : { linkNotice: clients.linkNotice }),
    },
  };
}

/** The Slack Lambda's request for one person's link notice (a direct invoke, protected by IAM). Identifiers only. */
export interface SlackLinkNoticeEvent { source: "agentx.slack-link-notice"; teamId: string; userId: string }
export function isSlackLinkNoticeEvent(event: unknown): event is SlackLinkNoticeEvent {
  return event !== null && typeof event === "object" && !Array.isArray(event) && (event as { source?: unknown }).source === "agentx.slack-link-notice"
    && (event as { requestContext?: unknown }).requestContext === undefined;
}

/** The broker's half: the notice from its own store and binding, or `{}` when none is due (or anything is wrong: one answer, no cause). */
export async function answerSlackLinkNotice(deps: { workspaces?: SlackWorkspaceAccess; companies?: CompanyMembershipReader }, event: SlackLinkNoticeEvent): Promise<{ text?: string }> {
  const keys = Object.keys(event).sort().join(",");
  if (keys !== "source,teamId,userId" || deps.workspaces === undefined || !slackWorkspaceTeam(event.teamId) || typeof event.userId !== "string" || !/^[UW][A-Z0-9]{2,31}$/u.test(event.userId)) return {};
  try {
    // The broker's own store writes the claim and the code (its State grant); its workspaces never delegate (no linkNotice there).
    const own: SlackWorkspaceAccess = { ...deps.workspaces };
    delete own.linkNotice;
    const text = await slackLinkNotice({ workspaces: own, ...(deps.companies === undefined ? {} : { companies: deps.companies }) }, event.teamId, event.userId);
    return text === undefined ? {} : { text };
  } catch { return {}; }
}
