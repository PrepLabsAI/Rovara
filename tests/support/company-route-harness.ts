import { AgentXError, IMPLICIT_COMPANY_ID, type WorkspaceInstance } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { namedCompany } from "../../packages/broker/src/aws/company-layout.js";
import { companyProjectRow } from "./company-layout-projects.js";

export const COMPANY_CHECKED_ROUTES = ["GET /v1/dev/tasks/{taskId}", "GET /v1/dev/tasks", "GET /v1/dev/projects",
  "GET /v1/dev/client/repositories", "POST /v1/dev/client/projects", "POST /v1/dev/client/projects/bulk", "GET /v1/dev/client/repositories/available",
  "GET /v1/dev/client/projects/{id}", "POST /v1/dev/access",
  "GET /v1/dev/tasks/{taskId}/events", "GET /v1/dev/tasks/{taskId}/readers",
  "GET /v1/dev/tasks/{taskId}/messages", "GET /v1/dev/tasks/{taskId}/comments", "GET /v1/dev/tasks/{taskId}/diff",
  "GET /v1/admin/sign-in-clients", "POST /v1/dev/company/preapprovals", "DELETE /v1/dev/company/preapprovals/", "DELETE /v1/dev/company/preapprovals/{id}",
  "GET /v1/dev/projects/{id}/settings", "PUT /v1/dev/projects/{id}/settings", "GET /v1/dev/company/settings-compliance",
  "GET /v1/dev/company/members", "GET /v1/dev/company/members/{id}/removal-preview", "POST /v1/dev/company/members/{id}/removal", "PUT /v1/dev/company/members/{id}/role",
  "POST /v1/dev/company/github/connect", "POST /v1/dev/company/github/claim", "POST /v1/dev/company/github/choose", "GET /v1/dev/company/github", "DELETE /v1/dev/company/github/{id}",
  "POST /v1/dev/company/slack/install", "POST /v1/dev/company/slack/install/complete", "POST /v1/dev/company/slack/disconnect", "GET /v1/dev/company/slack",
  "GET /v1/dev/company/slack/channels", "GET /v1/dev/company/slack/projects/{id}/channel", "PUT /v1/dev/company/slack/projects/{id}/channel", "DELETE /v1/dev/company/slack/projects/{id}/channel",
  "POST /v1/dev/company/slack/projects/{id}/channel/check",
  "GET /v1/dev/company/linear", "POST /v1/dev/company/linear/connect", "POST /v1/dev/company/linear/complete", "DELETE /v1/dev/company/linear",
  "GET /v1/dev/company/linear/projects/{id}", "PUT /v1/dev/company/linear/projects/{id}", "DELETE /v1/dev/company/linear/projects/{id}",
  "GET /v1/dev/company/engine-model", "PUT /v1/dev/company/engine-model",
  // DEC 254zzz63: two-company cases in tests/contract/company-learning-model-routes.test.ts.
  "GET /v1/dev/company/learning-model", "PUT /v1/dev/company/learning-model",
  // L4-EGR: two-company cases in tests/contract/company-egress-routes.test.ts.
  "GET /v1/dev/company/egress-addresses",
  "POST /v1/dev/tasks/{taskId}/merge", "GET /v1/dev/client/projects/{id}/code-settings", "PUT /v1/dev/client/projects/{id}/code-settings",
  "GET /v1/dev/client/projects/{id}/setup-status", "PUT /v1/dev/client/projects/{id}/setup-status/skips", "PUT /v1/dev/client/projects/{id}/setup-status/eval-none",
  // Guided onboarding PR 16: two-company cases in tests/contract/project-lifecycle-routes.test.ts.
  "GET /v1/dev/client/projects/{id}/archive-preview", "POST /v1/dev/client/projects/{id}/archive", "GET /v1/dev/client/projects/{id}/restore-preview", "POST /v1/dev/client/projects/{id}/restore",
] as const;
export const PERSON = "d".repeat(64);
export const TASK = "11111111-1111-4111-8111-111111111111";
export const TIME = "2026-11-14T12:00:00.000Z";

/** Same response serialization as the AWS host, exercising the real developer dispatcher and SDK double. */
export function companyRouteHarness() {
  const db = new FakeDynamoDb({ seed: 42 });
  const claims: Record<string, unknown> = { iss: "https://signin.example.test", aud: "agentx-developer", env: "test", sub: PERSON, sid: "session", amr: "slack" };
  db.set({ pk: "SESSION#session", sk: "META", developerId: PERSON, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 3600 });
  db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", displayName: "Test Person", slackUserId: "U0SHARED" });
  const actions = {
    workspace: async () => ({ status: "READY" }) as WorkspaceInstance,
    operations: async () => [],
    pullRequests: async () => [],
  } as unknown as DeveloperTaskActions;
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => Date.parse(TIME), tasks: actions,
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn", slackTeamId: "T0SHARED",
      verifyAccessToken: async () => claims,
      channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    },
  };
  const task = (id = TASK, companyId?: unknown, title = "ordinary task") => {
    const item = { pk: `DEVTASK#${id}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: id, developerId: PERSON,
      provider: "slack", developerName: "Test Person", client: "test", project: "shared-project", title, workspaceId: "shared-workspace",
      ownerKey: PERSON, conversationId: "shared-conversation", startingRevision: 1, shared: false, createdAt: TIME, updatedAt: TIME,
      ...(companyId === undefined ? {} : { companyId }),
    };
    db.set(item);
    db.set({ pk: `DEVELOPER#${PERSON}`, sk: `TASK#${TIME}#${id}`, entityType: "DEVELOPER_TASK_INDEX", taskId: id, title, project: "shared-project", status: "STARTING", shared: false, createdAt: TIME, updatedAt: TIME });
    return item;
  };
  const project = (companyId?: unknown, access: "grant" | "channel" | "none" = "grant", name = "shared-project") => {
    db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name, revision: 1 }, ...(companyId === undefined ? {} : { companyId }) });
    // DEC 254zzz80 (R2-F1): a NAMED company's project readers read its own partition; the legacy row above stays for the readers that still read the install's rows.
    if (typeof companyId === "string" && namedCompany(companyId) !== undefined) db.set(companyProjectRow(companyId, name, 1));
    // DEC 254zzz80: the grant lives where the project's company keeps grants (a named company's own partition; the built-in company and none: the legacy row).
    const named = typeof companyId === "string" && companyId !== IMPLICIT_COMPANY_ID && /^org_[0-9a-z]{20}$/.test(companyId);
    if (access === "grant") db.set({ pk: named ? `ORG#${companyId}#MEMBER#${PERSON}` : `MEMBER#${PERSON}`, sk: `PROJECT#${name}`, projectName: name, role: "developer" });
    if (access === "channel") db.set({ pk: "SLACK_BINDING#T0SHARED", sk: "CHANNEL#C0SHARED", teamId: "T0SHARED", channelId: "C0SHARED", projectName: name, updatedAt: TIME });
  };
  const read = async (path: string, extras: Partial<AdaptedHttpRequest> = {}) => {
    const request = { method: "GET", path, headers: {}, requestId: "company-test", ...extras };
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    try {
      const value = await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test"));
      return { statusCode: 200, headers, body: JSON.stringify({ ...(value as object), requestId: request.requestId }) };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { statusCode: error.statusCode, headers, body: JSON.stringify({ error: { code: error.code, message: error.message.replace(`${error.code}: `, "") }, requestId: request.requestId }) };
    }
  };
  return { db, deps, claims, task, project, read };
}
