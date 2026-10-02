// Fakes for the setup modules (phase 15d2). Nothing here reaches AWS, a vendor or the control plane.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { tokenStoreKey, type LoginOptions } from "../../packages/cli/src/auth.js";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { StoredTokens, TokenStore } from "../../packages/cli/src/token-store.js";
import type { AlertsApi, Subscription } from "../../packages/cli/src/setup/alerts.js";
import type { CognitoAdmin, SetupServices } from "../../packages/cli/src/setup/services.js";
import type { LinearTeam, VendorApi } from "../../packages/cli/src/setup/connectors/vendors.js";
import type { GitHubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";
import { SlackRateLimitedError, type SlackChannel, type SlackChannelApi } from "../../packages/cli/src/setup/channel-add.js";
import { fakeGitHubApi } from "./init-fakes.js";

export const CONTROL_PLANE = "https://cp.example.test";
export const ADMIN_EMAIL = "alice@example.com";
/** The staging environment's alerts topic ARN (OperatorAlertsTopicArn), as the control-plane stack
 * reports it; shared so every test that fakes it uses the same value. */
export const ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts";

/** A staging environment's settings (/agentx/staging/settings), with Cognito sign-in. */
export const STAGING_SETTINGS: EnvironmentSettings = {
  schemaVersion: 1, env: "staging", account: "123456789012", region: "us-east-1", engine: "templates", version: "1.2.3", naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: CONTROL_PLANE,
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123", audience: "client123", clientId: "client123" },
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-27T00:00:00.000Z",
};

/** The foundation stack's EC2 worker outputs, as the setupServices default answers them. */
export const FOUNDATION_OUTPUTS = {
  Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
  Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f",
};

/** A JWT-shaped token (unsigned) with the given payload: the CLI only reads claims, never verifies. */
export function accessToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

export function memoryTokenStore(initial: Record<string, StoredTokens> = {}): TokenStore & { values: Map<string, StoredTokens> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, tokens) => { values.set(key, tokens); },
    delete: async (key) => { values.delete(key); },
  };
}

/** `users` maps a username to its status; `members` lists "username:group" memberships already made.
 * `grouped` records every addToGroup call, and a call also makes the user a member. */
export function fakeCognito(users: Record<string, string> = {}, members: string[] = []): CognitoAdmin & { created: string[]; grouped: string[] } {
  const status = new Map(Object.entries(users));
  const membership = new Set(members);
  const created: string[] = [];
  const grouped: string[] = [];
  return {
    created, grouped,
    userStatus: async (_pool, username) => status.get(username),
    createUser: async (_pool, email) => { created.push(email); status.set(email, "FORCE_CHANGE_PASSWORD"); },
    groups: async (_pool, username) => [...membership].filter((entry) => entry.startsWith(`${username}:`)).map((entry) => entry.slice(username.length + 1)),
    addToGroup: async (_pool, username, group) => { grouped.push(`${username}:${group}`); membership.add(`${username}:${group}`); },
  };
}

/** A sign-in that answers with `tokens` and, like loginWithPkce, saves them in the token store first. */
export function fakeLogin(tokens: StoredTokens | (() => StoredTokens)): ((options: LoginOptions) => Promise<StoredTokens>) & { calls: LoginOptions[] } {
  const calls: LoginOptions[] = [];
  const login = async (options: LoginOptions) => {
    calls.push(options);
    const answer = typeof tokens === "function" ? tokens() : tokens;
    await options.tokenStore.set(tokenStoreKey(options), answer);
    return answer;
  };
  return Object.assign(login, { calls });
}

export interface FakeControlPlane {
  fetch: typeof fetch;
  requests: Array<{ method: string; path: string; body?: unknown; token?: string }>;
  /** Answer GET /v1/admin/credentials with 403 for this token. */
  forbidden: Set<string>;
  credentials: Array<Record<string, unknown>>;
  registered: unknown[];
  /** The preflight each registration answers with, by connector name. */
  preflight: Record<string, { status: "connected" | "not_connected" | "unavailable"; problem?: string }>;
  bindings: string[];
  turns: unknown[];
}

/** Serves the admin routes the setup modules call, in memory. */
export function fakeControlPlane(): FakeControlPlane {
  const plane: FakeControlPlane = {
    requests: [], forbidden: new Set(), registered: [], preflight: {}, bindings: [], turns: [],
    credentials: [{ ref: "github-agentx-sdlc", type: "github-app", secretName: "agentx/staging/github-app", builtIn: true, tokenCached: false }],
    fetch: async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const method = init?.method ?? "GET";
      const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, "");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      plane.requests.push({ method, path: parsed.pathname, ...(body === undefined ? {} : { body }), ...(token === undefined ? {} : { token }) });
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (token !== undefined && plane.forbidden.has(token)) return json(403, { error: { code: "FORBIDDEN", message: "administrator role required" } });
      if (parsed.pathname === "/v1/admin/credentials" && method === "GET") return json(200, { credentials: plane.credentials });
      if (parsed.pathname === "/v1/admin/credentials" && method === "POST") { plane.credentials.push(body as Record<string, unknown>); return json(200, { registered: true }); }
      if (parsed.pathname === "/v1/admin/projects" && method === "POST") {
        plane.registered.push(body);
        const definition = (body as { definition: { name: string; revision: number; integrations?: { connectors?: Array<{ name: string }> } } }).definition;
        const connectors = (definition.integrations?.connectors ?? []).map((connector) => ({ name: connector.name, offered: [], skipped: [], ...(plane.preflight[connector.name] ?? { status: "connected" }) }));
        return json(200, { name: definition.name, revision: definition.revision, preflight: { connectors } });
      }
      if (parsed.pathname.startsWith("/v1/admin/slack/bindings/") && method === "PUT") { plane.bindings.push(parsed.pathname.split("/").slice(-2).join("/")); return json(200, { bound: true }); }
      if (parsed.pathname === "/v1/admin/turns") return json(200, { turns: plane.turns });
      return json(404, { error: { code: "NOT_FOUND", message: `no route ${method} ${parsed.pathname}` } });
    },
  };
  return plane;
}

/** `repositories` maps a full name ("owner/repo") to its default branch and build files. Every
 * `file()` read is recorded in `reads` as "owner/repo:path", for tests that check what was fetched. */
export function fakeRepositories(repositories: Record<string, { defaultBranch?: string; files: Record<string, string> }>): GitHubRepositoryApi & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    list: async () => Object.keys(repositories).map((fullName) => ({
      fullName, name: fullName.split("/")[1]!, defaultBranch: repositories[fullName]!.defaultBranch ?? "main", cloneUrl: `https://github.com/${fullName}.git`,
    })),
    file: async (_token, fullName, path) => { reads.push(`${fullName}:${path}`); return repositories[fullName]?.files[path]; },
  };
}

/** A turn record as the control plane exports it (TurnRecordSchema), with the given fields replaced. */
export function turn(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: `Ev${Math.random().toString(36).slice(2, 10).toUpperCase()}`, subject: "T0123456789/C0PAY00001/1.1", receivedAt: "2026-09-27T00:00:01.000Z",
    requestedBy: { teamId: "T0123456789", userId: "U0HUMAN001" }, disposition: "answered", startedAt: "2026-09-27T00:00:01.000Z", finishedAt: "2026-09-27T00:00:09.000Z",
    durationMs: 8000, requestText: "hello", responseText: "hi", offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], ...overrides,
  };
}

/** The channels the bot can see. With `visibleAfterFinds`, finds before that count see nothing,
 * as when a person has not invited the bot yet; the first `rateLimitedFinds` are rate limited. `joined` records every join; `tokens` every token used. */
export function fakeSlackChannels(channels: SlackChannel[], options: { visibleAfterFinds?: number; rateLimitedFinds?: number; retryAfterMs?: number } = {}): SlackChannelApi & { joined: string[]; tokens: string[]; finds: () => number } {
  const joined: string[] = [];
  const tokens: string[] = [];
  let finds = 0;
  return {
    joined, tokens, finds: () => finds,
    async find(token, name) {
      tokens.push(token);
      finds += 1;
      // The first `rateLimitedFinds` finds answer as Slack's HTTP 429 does.
      if (options.rateLimitedFinds !== undefined && finds <= options.rateLimitedFinds) throw new SlackRateLimitedError("conversations.list", options.retryAfterMs ?? 30_000);
      if (options.visibleAfterFinds !== undefined && finds < options.visibleAfterFinds) return undefined;
      return channels.find((channel) => channel.name === name);
    },
    async join(token, channelId) { tokens.push(token); joined.push(channelId); },
  };
}

/** `linearTeams` answers `vendors.linearTeams`; `linearRefuses` makes it throw the way a 401 or a
 * GraphQL error does (a VendorRefused-named Error, matched by name, never by message text).
 * `jiraCloudId` answers `vendors.jiraCloudId`; `jiraInside`/`jiraOutside` answer `vendors.jiraSearch`
 * depending on whether the JQL names the connected project or excludes it; `jiraRefuses` makes
 * `jiraSearch` throw the same VendorRefused shape a 401 from Atlassian does. `asanaProject` answers
 * `vendors.asanaProject` (pass `undefined` for a project the bot cannot see; absent means Payments);
 * `asanaRotates` is the refresh token `asanaAccessToken` returns as rotated; `asanaRefuses` makes the
 * refresh or the project read throw VendorRefused; `asanaReadError` makes the project read throw a
 * plain Error with that message, as a raw SDK or MCP client error would. */
export function fakeVendors(options: {
  linearTeams?: LinearTeam[]; linearRefuses?: boolean; jiraCloudId?: string; jiraInside?: string[]; jiraOutside?: string[]; jiraRefuses?: boolean;
  asanaProject?: { name: string } | undefined; asanaRotates?: string; asanaRefuses?: "refresh" | "read"; asanaReadError?: string;
} = {}): VendorApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async linearTeams() {
      calls.push("linearTeams");
      if (options.linearRefuses === true) throw Object.assign(new Error("401"), { name: "VendorRefused" });
      return options.linearTeams ?? [{ id: "c408e946-78aa-4db8-923e-f78053dd954f", key: "PAY", name: "Payments" }];
    },
    async jiraCloudId(siteUrl) {
      calls.push(`jiraCloudId ${siteUrl}`);
      return options.jiraCloudId ?? "0f1e2d3c-4b5a-4968-8776-655443322110";
    },
    async jiraSearch({ jql, maxResults }) {
      calls.push(`jiraSearch ${jql} max ${maxResults}`);
      if (options.jiraRefuses === true) throw Object.assign(new Error("401"), { name: "VendorRefused" });
      return jql.includes("not in") ? options.jiraOutside ?? [] : options.jiraInside ?? ["PAY-1"];
    },
    async asanaAccessToken() {
      calls.push("asanaAccessToken");
      if (options.asanaRefuses === "refresh") throw Object.assign(new Error("400"), { name: "VendorRefused" });
      return { accessToken: "asana-access", ...(options.asanaRotates === undefined ? {} : { refreshToken: options.asanaRotates }) };
    },
    async asanaProject({ projectGid }) {
      calls.push(`asanaProject ${projectGid}`);
      if (options.asanaRefuses === "read") throw Object.assign(new Error("401"), { name: "VendorRefused" });
      if (options.asanaReadError !== undefined) throw new Error(options.asanaReadError);
      return "asanaProject" in options ? options.asanaProject : { name: "Payments" };
    },
  };
}

/** Secrets Manager as the bot's sign-in sees it (AuthorizeSecrets), in memory; `tags` records each tag call. */
export function memoryAuthorizeSecrets(initial: Record<string, string> = {}): AuthorizeSecrets & { values: Map<string, string>; tags: string[] } {
  const values = new Map(Object.entries(initial));
  const tags: string[] = [];
  return {
    values, tags,
    read: async (name) => values.get(name),
    write: async (name, value) => { values.set(name, value); },
    tag: async (name) => { tags.push(name); },
  };
}

/** SNS, CloudWatch and Budgets as the alerts module sees them. `existing` subscriptions are on the
 * topic from the start; a new one stays "PendingConfirmation" until `confirmAfterPolls` reads have
 * passed since the subscribe, or until `confirmAll()`. `historyEmpty` makes the alarm history show
 * no change to ALARM; `budgetUsd` answers `budget` (absent: no such budget). `subscribed` records
 * each subscribe as "<protocol> <endpoint>", `states` each alarm change as "<alarm> <state>", and
 * `reads` counts the subscription reads. */
export function fakeAlerts(options: { existing?: Subscription[]; confirmAfterPolls?: number; historyEmpty?: boolean; budgetUsd?: number } = {}): AlertsApi & { subscribed: string[]; states: string[]; reads: () => number; confirmAll(): void } {
  const subscribed: string[] = [];
  const states: string[] = [];
  const subscriptions = [...(options.existing ?? [])];
  let polls = 0;
  let reads = 0;
  const confirmed = (entry: Subscription, index: number): Subscription => ({ ...entry, arn: `arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts:${index + 1}` });
  return {
    subscribed, states, reads: () => reads,
    confirmAll() { subscriptions.forEach((entry, index) => { if (entry.arn === "PendingConfirmation") subscriptions[index] = confirmed(entry, index); }); },
    async subscriptions() {
      polls += 1;
      reads += 1;
      return subscriptions.map((entry, index) => (entry.arn === "PendingConfirmation" && polls > (options.confirmAfterPolls ?? 0) ? confirmed(entry, index) : { ...entry }));
    },
    async subscribe(_topic, protocol, endpoint) { subscribed.push(`${protocol} ${endpoint}`); subscriptions.push({ arn: "PendingConfirmation", protocol, endpoint }); polls = 0; },
    async setAlarmState(name, state) { states.push(`${name} ${state}`); },
    async wentToAlarm() { return options.historyEmpty !== true; },
    async budget() { return options.budgetUsd; },
  };
}

/** Every SetupServices field has a default here, with no cast (F20): a task that adds a field must
 * add its fake, or this stops type-checking. */
export function setupServices(overrides: Partial<SetupServices> = {}): SetupServices {
  const plane = fakeControlPlane();
  return {
    tokenStore: memoryTokenStore(),
    cognito: fakeCognito(),
    login: fakeLogin({ accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }), expiresAt: Date.parse("2026-09-27T01:00:00.000Z") }),
    fetch: plane.fetch,
    repositories: fakeRepositories({}),
    github: fakeGitHubApi(),
    stackOutputs: async () => FOUNDATION_OUTPUTS,
    // Tests that write project files pass their own directory.
    configDir: join(tmpdir(), "agentx-setup-unused"),
    slackChannels: fakeSlackChannels([]),
    slackIdentity: async () => ({ teamId: "T0123456789", botUserId: "U0BOT00001" }),
    vendors: fakeVendors(),
    // Task 11: a test that reaches the bot's sign-in passes its own authorize.
    authorize: async () => { throw new Error("test setup: authorize not expected"); },
    authorizeSecrets: memoryAuthorizeSecrets(),
    // Task 12: no subscriptions yet and no budget; tests that reach the alerts pass their own.
    alerts: fakeAlerts(),
    ...overrides,
  };
}
