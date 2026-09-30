// tests/support/admin-change-broker.ts
// Spec 025 phase 25e: the admin read broker with admin changes on, a clock the changes read, a
// linked Slack user for the admin, and the ingress's press event.
import { randomUUID } from "node:crypto";
import type { AdminChangeInput, ChannelInfoRequest, ChannelInfoResponse, ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { createAdminReadBroker } from "./admin-read-broker.js";
import { SLACK_TEAM, issuer } from "./slack-broker.js";

export const ADMIN_SLACK = "U0ADA00001";
export const TRACE = "trace-test-0001";
/** The admin's bearer token in every call; it must never reach a log line, record or answer. */
export const ADMIN_TOKEN = "Bearer admin-token-for-tests";

export async function createAdminChangeBroker(options: {
  elicitation?: boolean;
  slack?: boolean;
  slackLinked?: boolean;
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  channelMembers?: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
} = {}) {
  let now = Date.now();
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const metrics: string[] = [];
  // 25d's A12: the admin's verified email comes from the issuer's userinfo endpoint.
  const fetch: typeof globalThis.fetch = async (input) => ((typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith("/.well-known/openid-configuration")
    ? Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" })
    : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true, name: "Ada" }));
  /** Set `down` to make DeveloperIdentity's channel-by-name lookup answer that Slack is unreachable. */
  const channelLookup = { down: false };
  const slackUserByEmail = async () => (options.slackLinked === false ? { ok: true as const } : { ok: true as const, userId: ADMIN_SLACK });
  const harness = await createAdminReadBroker({
    ...(options.channelInfo === undefined ? {} : { channelInfo: options.channelInfo }),
    ...(options.channelMembers === undefined ? {} : { channelMembers: options.channelMembers }),
    developerExtra: {
      slackUserByEmail,
      endDeveloperSessions: async () => ({ ok: true }),
      channelByName: async ({ name }) => (channelLookup.down ? { ok: false, error: "slack_unavailable" } : name === "ledger-dev" ? { ok: true, channel: { channelId: "C0LEDGER01", name } } : { ok: true }),
    },
    brokerExtra: {
      // A test's own `me` replaces the production default whole, so it names the lookup too.
      adminReads: { me: { issuer, fetch, slackUserByEmail } },
      // A credential registry, so agentx_admin_register_credential can plan; its secret reads as nothing useful.
      connectorCredentials: { secrets: { read: async () => "{}" }, githubApp: { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-app" } },
      adminChanges: { confirm: { elicitation: options.elicitation ?? true, slack: options.slack ?? true }, now: clock.now, metric: (outcome: string) => metrics.push(outcome) },
    },
  });
  const call = (method: string, path: string, body?: unknown, subject = "admin-subject") => harness.admin(method, path, { subject, headers: { "x-agentx-trace-id": TRACE }, ...(body === undefined ? {} : { body }) });
  const propose = (change: AdminChangeInput, methods: string[] = ["elicitation"], requestId: string = randomUUID(), subject?: string) =>
    call("POST", "/v1/admin/changes", { requestId, change, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods }, subject);
  const press = async (changeId: string, click: "confirm" | "cancel", slackUserId = ADMIN_SLACK, teamId: string | null = SLACK_TEAM) => {
    const response = await harness.handler({ source: "agentx.slack-ingress", action: "admin-change-press", changeId, click, slackUserId, ...(teamId === null ? {} : { teamId }) });
    return JSON.parse(response.body) as { outcome: string; changeId: string; traceId?: string };
  };
  return {
    ...harness, clock, metrics, propose, press, channelLookup,
    get: (id: string, subject?: string) => call("GET", `/v1/admin/changes/${id}`, undefined, subject),
    list: (query = "") => call("GET", `/v1/admin/changes${query}`),
    slack: (id: string, subject?: string) => call("POST", `/v1/admin/changes/${id}/slack`, {}, subject),
    apply: (id: string, method = "elicitation", subject?: string) => call("POST", `/v1/admin/changes/${id}/apply`, { method }, subject),
    decline: (id: string, reason = "declined", subject?: string) => call("POST", `/v1/admin/changes/${id}/decline`, { method: "elicitation", reason }, subject),
    audit: (id: string) => harness.db.get(`CHANGE#${id}`, "AUDIT") as Record<string, unknown> | undefined,
    pending: (id: string) => harness.db.get(`ADMIN_CHANGE#${id}`, "META") as Record<string, unknown> | undefined,
  };
}
