// A broker with the production linear type pointed at a fresh fake Linear MCP server, a registered
// static-secret credential, a project whose latest revision approves four Linear tools, the test
// channel bound, and a ready thread workspace.
import { expect, vi } from "vitest";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "./fake-linear-mcp.js";
import { call, createBroker, ensureWorkspace, markReady } from "./slack-broker.js";

export const LINEAR_TEAM = "T0BSHLLUGBD";
export const LINEAR_CHANNEL = "C0123456789";
export const LINEAR_THREAD_TS = "1695500000.000001";
export const LINEAR_THREAD = `${LINEAR_TEAM}/${LINEAR_CHANNEL}/${LINEAR_THREAD_TS}`;
export const LINEAR_MEMBER = "U0123456789";
export const LINEAR_KEY = "lin_api_fixture_key_0123456789abcdef";
const admin = { subject: "admin-subject", admin: true };
export const LINEAR_CONNECTOR = {
  name: "linear", type: "linear", credentialRef: "linear-charterarc",
  scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }],
  tools: [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }, { name: "save_comment", access: "write" }],
};

export async function setupLinearBroker(options: { preflight: boolean }) {
  const fake = await startFakeLinearMcp();
  const { type, requested } = linearViaFake(fake);
  const secrets = { read: vi.fn(async (name: string) => name === "agentx/connectors/linear-charterarc" ? JSON.stringify({ apiKey: LINEAR_KEY }) : undefined) };
  const { db, handler } = createBroker({
    connectorTypes: { github: githubConnectorType, linear: type },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
  });
  expect((await call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
  const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [LINEAR_CONNECTOR] },
    },
    runtimeBinding: {
      deploymentMode: "ec2-ebs" as const,
      launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
      volumeSizeGiB: 20,
      volumeType: "gp3" as const,
    },
    ...(options.preflight ? { preflight: true } : {}),
  } });
  expect(registered.status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${LINEAR_TEAM}/${LINEAR_CHANNEL}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  const workspaceId = (await ensureWorkspace(handler, LINEAR_THREAD, LINEAR_MEMBER)).body.workspaceId as string;
  markReady(db, workspaceId);
  return { db, handler, fake, requested, registered, workspaceId, path: `/v1/service/workspaces/${workspaceId}/connectors/linear` };
}
