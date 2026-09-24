import { createHash } from "node:crypto";
import { ProjectDefinitionSchema } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import { adminCall, adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const account = "111122223333";

describe("registration preflight", () => {
  it("does not contact the vendor unless the request asks for preflight", async () => {
    const connect = vi.fn(); const credentials = vi.fn();
    const { handler } = await createAdminBroker({ githubMcp: { credentials, connect } });
    const registered = await register(handler, githubConnector(["list_issues"]));
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it("reports offered, missing and skipped tools per connector and names them in warnings", async () => {
    // Vendor offers list_issues with a plain schema and issue_write with an unrepresentable oneOf; approvals are list_issues, issue_write, retired_tool.
    const { handler } = await createAdminBroker({ githubMcp: vendor([plainTool("list_issues"), oneOfTool("issue_write")]) });
    const registered = await register(handler, githubConnector(["list_issues", "issue_write", "retired_tool"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "github", status: "connected", offered: ["github__list_issues"],
      skipped: [{ tool: "retired_tool", reason: "not offered by the vendor" }, { tool: "issue_write", reason: "schema is not a plain object" }],
    }] });
    expect(registered.body.warnings).toEqual([
      "connector github: tool retired_tool skipped: not offered by the vendor",
      "connector github: tool issue_write skipped: schema is not a plain object",
    ]);
  });

  it("registers when the vendor rejects the credential and reports the connector not connected", async () => {
    const { McpUnauthorized } = await import("@agentx/gateway");
    const { handler, db } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "installation-secret" }), connect: vi.fn(async () => { throw new McpUnauthorized(); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "not_connected", offered: [], skipped: [] }] });
    expect((registered.body.warnings as string[])[0]).toMatch(/^connector github: GitHub is not connected: GitHub rejected the credential twice/);
    expect(JSON.stringify(registered.body)).not.toContain("installation-secret");
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });

  it("reports an unreachable vendor as unavailable without failing registration", async () => {
    const { handler } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "t" }), connect: vi.fn(async () => { throw new Error("ECONNRESET"); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "unavailable" }] });
  });

  it("reports a deployment without GitHub MCP as not connected", async () => {
    const { handler } = await createAdminBroker({});
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.body.preflight).toEqual({ connectors: [{ name: "github", status: "not_connected", problem: "GitHub MCP is not configured in this deployment", offered: [], skipped: [] }] });
  });

  it("refuses a new revision whose multi-repository tool already has a target argument, naming it", async () => {
    const { handler, db } = await createAdminBroker({ githubMcp: vendor([toolWithTarget("list_issues")]) });
    const refused = await register(handler, githubConnector(["list_issues"]), { preflight: true, repositories: ["demo", "docs"] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector github tool list_issues already has a target argument and the connector has several scopes; remove its approval" } });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses a new revision with a presented name over 64 characters, but re-accepts an identical registered revision", async () => {
    const { handler, db } = await createAdminBroker({});
    const long = "t".repeat(57);
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    // Seed a revision registered before this check existed; re-submitting it stays idempotent.
    seedRegisteredRevision(db, githubConnector([long]));
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ duplicate: true });
  });

  it("warns when the model could see more than 20 tools", async () => {
    const { handler } = await createAdminBroker({});
    const names = Array.from({ length: 15 }, (_, index) => `tool_${index}`);
    expect((await register(handler, githubConnector(names))).body.warnings).toEqual(["the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools."]);
  });
});

type Overrides = Record<string, unknown>;

function githubConnector(names: string[]): Overrides {
  return { integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: names.map((name) => ({ name, access: "read" })) }] } };
}

interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

/** Fakes serving `tools`; the credential names the repository its URL points at. */
function vendor(tools: ToolDefinition[]): GitHubMcpDependencies {
  return {
    credentials: vi.fn(async (repository: { url: string }) => ({ owner: "example", repo: /\/([^/]+?)(?:\.git)?$/.exec(repository.url)![1]!, token: "installation-token" })),
    connect: vi.fn(async () => ({ tools, call: vi.fn(), close: async () => undefined })),
  };
}

function boundProperties(): Record<string, unknown> {
  return { owner: { type: "string" }, repo: { type: "string" } };
}

function plainTool(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object", properties: { ...boundProperties(), state: { type: "string" } }, required: ["owner", "repo"] } };
}

function oneOfTool(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: {
    type: "object",
    properties: { ...boundProperties(), title: { type: "string" }, issue_number: { type: "number" } },
    required: ["owner", "repo"],
    oneOf: [{ required: ["title"] }, { required: ["issue_number"] }],
  } };
}

function toolWithTarget(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object", properties: { ...boundProperties(), target: { type: "string" } }, required: ["owner", "repo"] } };
}

function definition(overrides: Overrides, repositories: string[] = ["demo"]): Record<string, unknown> {
  return {
    name: "payments",
    revision: 1,
    repositories: repositories.map((name) => ({ name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app" })),
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate work (revision 1).",
    ...overrides,
  };
}

const runtimeBinding = {
  runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx_production_worker-YVirjlFgvk`,
  endpointQualifier: "DEFAULT",
  deploymentMode: "instances-ebs",
  capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
};

function register(handler: AdminHandler, overrides: Overrides, options: { preflight?: boolean; repositories?: string[] } = {}) {
  return adminCall(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    body: { definition: definition(overrides, options.repositories), runtimeBinding, ...(options.preflight ? { preflight: true } : {}) },
  });
}

/** The revision and membership a registration made before the static checks existed would have stored. */
function seedRegisteredRevision(db: FakeDynamoDb, overrides: Overrides): void {
  const ownerKey = createHash("sha256").update(adminIssuer).update("\0").update("admin-subject").digest("hex");
  db.set({
    pk: "PROJECT#payments", sk: "REV#000000000001", entityType: "PROJECT",
    definition: ProjectDefinitionSchema.parse(definition(overrides)), runtimeBinding,
    registeredBy: ownerKey, registeredAt: "2026-01-01T00:00:00.000Z",
  });
  db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey, projectName: "payments", role: "administrator" });
}
