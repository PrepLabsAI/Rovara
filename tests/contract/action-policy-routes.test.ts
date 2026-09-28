import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createBroker, loadSlackBroker, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const policy = { rules: [
  { tool: "issue_write", connector: "github", whenArguments: ["state"], treatAs: "destructive" },
  { tool: "agentx_create_pull_request", outcome: "ask", reason: "Pull requests need a person." },
] };

beforeAll(async () => { await loadSlackBroker(); });

function register(handler: Handler, revision: number, actionPolicy?: unknown) {
  return call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: {
    definition: {
      name: "payments", revision,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }, { name: "issue_write", access: "write" }] }] },
      ...(actionPolicy === undefined ? {} : { actionPolicy }),
    },
    runtimeBinding: {
      deploymentMode: "ec2-ebs" as const,
      launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
      volumeSizeGiB: 20,
      volumeType: "gp3" as const,
    },
  } });
}

async function bound(actionPolicy?: unknown) {
  const { db, handler } = createBroker();
  expect((await register(handler, 1, actionPolicy)).status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  return { db, handler };
}

function threadWorkspace(handler: Handler, flags: Record<string, boolean>) {
  return call(handler, { method: "POST", path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser: pratik },
    body: { requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true, includeAllConnectorTypes: true, includeRecoverableOperations: true, ...flags } });
}

describe("action policy through the control plane", () => {
  it("sends the latest revision's action policy only to a service that asks for it, for new and existing threads", async () => {
    const { handler } = await bound(policy);
    const created = await threadWorkspace(handler, { includeActionPolicy: true });
    expect(created.status).toBe(200);
    expect(created.body.actionPolicy).toEqual(policy);
    const older = await threadWorkspace(handler, {});
    expect(older.body).not.toHaveProperty("actionPolicy");

    const narrower = { rules: [{ tool: "github__issue_write", outcome: "deny", reason: "Frozen for the audit." }] };
    expect((await register(handler, 2, narrower)).status).toBe(201);
    const existing = await threadWorkspace(handler, { includeActionPolicy: true });
    expect(existing.body).toMatchObject({ created: false, actionPolicy: narrower });
  });

  it("sends the action policy with a new thread's record that has no compute yet, only on opt-in", async () => {
    const { db, handler } = await bound(policy);
    const lazy = await threadWorkspace(handler, { lazyPreparation: true, includeActionPolicy: true });
    expect(lazy.status).toBe(200);
    expect(lazy.body).toMatchObject({ status: "UNPREPARED", created: true, actionPolicy: policy });
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    const secondThread = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: `${team}/${channel}/1695500000.000002`, slackUser: pratik },
      body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true, lazyPreparation: true } });
    expect(secondThread.body).toMatchObject({ status: "UNPREPARED" });
    expect(secondThread.body).not.toHaveProperty("actionPolicy");
  });

  it("sends no action policy when the project has none", async () => {
    const { handler } = await bound();
    expect((await threadWorkspace(handler, { includeActionPolicy: true })).body).not.toHaveProperty("actionPolicy");
  });

  it("refuses to register a rule that can never apply, and stores nothing", async () => {
    const { db, handler } = await bound(policy);
    const refused = await register(handler, 2, { rules: [{ tool: "delete_*", connector: "github", outcome: "deny" }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("action policy rule 1: delete_* matches no approved github tool");
    expect(db.get("PROJECT#payments", "REV#000000000002")).toBeUndefined();
    const both = await register(handler, 2, { rules: [{ tool: "issue_write", connector: "github", outcome: "ask", treatAs: "change" }] });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.body)).toContain("exactly one of outcome and treatAs");
  });
});
