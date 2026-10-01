// Issue #49: Linear's team check guards only the tools it knows. An approved tool outside that set
// whose input names an item can reach another team, so registration's preflight warns about it.
import { ProjectDefinitionSchema } from "@agentx/contracts";
import { LINEAR_GUARDED_ITEM_TOOLS, issueInTeamGuard, linearConnector } from "@agentx/gateway";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { preflightConnectors } from "../../packages/broker/src/aws/registration-preflight.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { LINEAR_FIXTURE_TOOLS } from "../support/fake-linear-mcp.js";

const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const DELETE_COMMENT_WARNING = "connector linear: tool delete_comment names an item (id) the Linear team check does not cover, so it can reach other teams; remove its approval";

const linear = (tools: string[]) => ({
  name: "linear", type: "linear", credentialRef: "linear-key",
  scopes: [{ alias: "charterarc", teamId: TEAM }],
  tools: tools.map((name) => ({ name, access: name.startsWith("list_") || name.startsWith("get_") ? "read" : "write" })),
});
const project = (revision: number, connectors: unknown[]) => ({
  name: "ledger", revision,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.", integrations: { connectors },
});

/** The production linear type over a registered key, whose vendor answers with the recorded Linear tools. */
function linearOverFixture(options: { keepCredential: boolean; tools?: typeof LINEAR_FIXTURE_TOOLS }): ConnectorType {
  const db = new FakeDynamoDb();
  db.set({ pk: "CREDENTIALS", sk: "REF#linear-key", entityType: "CREDENTIAL", ref: "linear-key", type: "static-secret", secretName: "agentx/connectors/linear-key", registeredBy: "admin", registeredAt: "2026-09-24T00:00:00.000Z" });
  const credentialRegistry = new CredentialRegistry({
    secrets: { read: vi.fn(async () => JSON.stringify({ apiKey: "lin_api_fixture" })) },
    githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    documentClient: db as never, tableName: "state",
  });
  const connect = vi.fn(async () => ({ tools: options.tools ?? LINEAR_FIXTURE_TOOLS, call: vi.fn(), close: async () => undefined }));
  return {
    type: "linear",
    resolve: (config, definition) => {
      const resolved = linearConnectorType.resolve(config, definition, { credentialRegistry, connect });
      if ("unusable" in resolved || options.keepCredential) return resolved;
      // The change broker's own registry does not hold this key, so its registration check is left out.
      const withoutCredential = { ...resolved };
      delete withoutCredential.credential;
      return withoutCredential;
    },
  };
}

describe("the Linear guarded tool set (#49)", () => {
  it("is exported from the gateway and declared on the connector, matching the tools the guard reads", () => {
    expect(LINEAR_GUARDED_ITEM_TOOLS).toEqual({ tools: ["get_issue", "save_issue", "list_comments", "save_comment"], targetArguments: ["id", "issueId", "commentId"] });
    expect(linearConnector({ issue: async () => { throw new Error("not used"); } }).guardedItemTools).toBe(LINEAR_GUARDED_ITEM_TOOLS);
    // Each guarded tool, given its item, needs get_issue first; a tool outside the set needs nothing.
    expect(issueInTeamGuard.requiredTools("get_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("list_comments", { issueId: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_comment", { issueId: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("delete_comment", { id: "comment-1" })).toEqual([]);
  });
});

describe("registration preflight for a Linear tool outside the guarded set (#49)", () => {
  it("warns about an approved tool that names an item, and not about guarded tools or tools without one", async () => {
    const definition = ProjectDefinitionSchema.parse(project(1, [linear(["list_issues", "get_issue", "save_comment", "list_teams", "delete_comment"])]));
    const connector = linearOverFixture({ keepCredential: true }).resolve(definition.integrations!.connectors![0]!, definition, {});
    if ("unusable" in connector) throw new Error(connector.unusable);
    const result = await preflightConnectors([connector], definition, "owner-key");
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([DELETE_COMMENT_WARNING]);
    expect(result.report.connectors).toEqual([{ name: "linear", status: "connected", offered: ["linear__list_issues", "linear__get_issue", "linear__save_comment", "linear__list_teams", "linear__delete_comment"], skipped: [] }]);
  });

  it("gives no second warning for a tool the presentation already skips", async () => {
    // A vendor schema with its own `target` argument is skipped before the model sees it.
    const tools = LINEAR_FIXTURE_TOOLS.map((tool) => tool.name === "delete_comment"
      ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), target: { type: "string" } } } }
      : tool);
    const definition = ProjectDefinitionSchema.parse(project(1, [linear(["list_issues", "delete_comment"])]));
    const connector = linearOverFixture({ keepCredential: true, tools }).resolve(definition.integrations!.connectors![0]!, definition, {});
    if ("unusable" in connector) throw new Error(connector.unusable);
    const result = await preflightConnectors([connector], definition, "owner-key");
    expect(result.report.connectors[0]!.skipped.map((entry) => entry.tool)).toEqual(["delete_comment"]);
    expect(result.warnings).toEqual([]);
  });

  it("gives no warning when every approved tool is guarded or names no item", async () => {
    const definition = ProjectDefinitionSchema.parse(project(1, [linear(["list_issues", "list_teams", "save_issue"])]));
    const connector = linearOverFixture({ keepCredential: true }).resolve(definition.integrations!.connectors![0]!, definition, {});
    if ("unusable" in connector) throw new Error(connector.unusable);
    expect((await preflightConnectors([connector], definition, "owner-key")).warnings).toEqual([]);
  });
});

describe("registering and planning a revision that approves such a tool (#49)", () => {
  const runtimeBinding = {
    deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const,
  };

  it("registers the revision and names the tool in the response's warnings, also as a duplicate, only with preflight", async () => {
    const broker = await createAdminChangeBroker({ connectorTypes: { linear: linearOverFixture({ keepCredential: false }) } });
    const body = { definition: project(1, [linear(["list_issues", "delete_comment"])]), runtimeBinding };
    const registered = await broker.admin("POST", "/v1/admin/projects", { body: { ...body, preflight: true } });
    expect(registered.status).toBe(201);
    expect(registered.body.warnings).toEqual([DELETE_COMMENT_WARNING]);
    const duplicate = await broker.admin("POST", "/v1/admin/projects", { body: { ...body, preflight: true } });
    expect(duplicate.body).toMatchObject({ duplicate: true, warnings: [DELETE_COMMENT_WARNING] });
    const withoutPreflight = await broker.admin("POST", "/v1/admin/projects", { body });
    expect(withoutPreflight.body.warnings).toBeUndefined();
  });

  it("keeps the warning when the registration lost the write race and answers as a duplicate", async () => {
    const broker = await createAdminChangeBroker({ connectorTypes: { linear: linearOverFixture({ keepCredential: false }) } });
    const body = { definition: project(1, [linear(["list_issues", "delete_comment"])]), runtimeBinding, preflight: true };
    const send = broker.db.send;
    let raced = false;
    // Another writer stores the same revision between this request's read and its conditional write.
    broker.db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command).includes("PROJECT#ledger")) {
        raced = true;
        await send(command);
        throw Object.assign(new Error("transaction cancelled"), { name: "TransactionCanceledException" });
      }
      return send(command);
    };
    const registered = await broker.admin("POST", "/v1/admin/projects", { body });
    expect(raced).toBe(true);
    expect(registered.body).toMatchObject({ duplicate: true, warnings: [DELETE_COMMENT_WARNING] });
  });

  it("lists the warning in a revision change's plan", async () => {
    const broker = await createAdminChangeBroker({ connectorTypes: { linear: linearOverFixture({ keepCredential: false }) } });
    expect((await broker.admin("POST", "/v1/admin/projects", { body: { definition: project(1, [linear(["list_issues"])]), runtimeBinding } })).status).toBe(201);
    const proposed = await broker.propose({ kind: "register_project_revision", definition: project(2, [linear(["list_issues", "delete_comment"])]) });
    expect(proposed.status).toBe(201);
    expect((proposed.body.change as { effect: string }).effect).toContain(`The preflight found: ${DELETE_COMMENT_WARNING}.`);
  });
});
