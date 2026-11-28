// SIGNIN-STATE-TABLE (0.5.34): the sign-in function's company audit rows go to the real State table (STATE_TABLE_NAME is never a switch). #1614: company mode is the only mode, so
// there is no "company layer off" init any more; the old switch variables, set or not, change nothing. infra/lib/developer-signin.ts sets the
// variable always; tests/contract/developer-signin-infrastructure.test.ts pins the synthesized value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type * as DynamoModule from "@aws-sdk/lib-dynamodb";
import type * as AuditModule from "../../packages/broker/src/developer/company-signin-audit.js";

const seen = vi.hoisted<{ db: unknown; auditTables: string[] }>(() => ({ db: undefined, auditTables: [] }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({ ...await original<typeof DynamoModule>(), DynamoDBDocumentClient: { from: () => seen.db } }));
vi.mock("../../packages/broker/src/developer/company-signin-audit.js", async (original) => {
  const actual = await original<typeof AuditModule>();
  return { ...actual, createCompanySignInAuditWriter: (options: Parameters<typeof actual.createCompanySignInAuditWriter>[0]) => { seen.auditTables.push(options.tableName); return actual.createCompanySignInAuditWriter(options); } };
});
afterEach(() => vi.unstubAllEnvs());

const BASE = {
  AGENTX_ENV: "test", AWS_REGION: "us-east-1", DEVELOPER_TOKEN_ISSUER: "https://signin.example.test/v1/auth", DEVELOPER_SIGNIN_TABLE_NAME: "signin",
  DEVELOPER_TOKEN_KEY_ARN: "test-key", SLACK_SECRET_ARN: "test-slack", TASK_TOKEN_KEY_ARN: "", DEVELOPER_OIDC_ISSUER: "",
};

async function init(env: Record<string, string>) {
  vi.resetModules(); seen.db = new FakeDynamoDb(); seen.auditTables = [];
  for (const [key, value] of Object.entries({ ...BASE, ...env })) vi.stubEnv(key, value);
  const { createAwsDeveloperIdentityHandler, handler } = await import("../../packages/broker/src/aws/developer-identity.js");
  return { createAwsDeveloperIdentityHandler, handler };
}

describe("DeveloperIdentity's init and the State table", () => {
  it.each([["disabled"], [""]])("CompanySignIn on, SlackCompanyWorkspaces %j: init succeeds and audit writes go to the real State table", async (slack) => {
    const { handler } = await init({ COMPANY_SIGNIN: "enabled", SLACK_COMPANY_WORKSPACES: slack, STATE_TABLE_NAME: "agentx-staging-state" });
    // The handler's own init (Slack company mode stays off): a company-layer request is served.
    expect(await handler({ kind: "company-invite-create", codeHash: "a".repeat(64), expiresInHours: 24 } as never)).toMatchObject({ ok: true });
    expect(seen.auditTables).toEqual(["agentx-staging-state"]);
  });

  it("CompanySignIn on, Slack company mode on: the same real State table", async () => {
    const { createAwsDeveloperIdentityHandler } = await init({ COMPANY_SIGNIN: "enabled", SLACK_COMPANY_WORKSPACES: "enabled", STATE_TABLE_NAME: "agentx-staging-state", SLACK_TEAM_ID: "T0INSTALL1" });
    createAwsDeveloperIdentityHandler(process.env);
    expect(seen.auditTables).toEqual(["agentx-staging-state"]);
  });

  it("company layer on without a State table is still a loud init failure (a misconfiguration, not a switch)", async () => {
    const { createAwsDeveloperIdentityHandler } = await init({ COMPANY_SIGNIN: "enabled", STATE_TABLE_NAME: "" });
    expect(() => createAwsDeveloperIdentityHandler(process.env)).toThrow(/STATE_TABLE_NAME/u);
  });
});
