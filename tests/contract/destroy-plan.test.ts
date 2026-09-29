import { describe, expect, it } from "vitest";
import { confirmationPrompts, destroyPlanText, inventoryParameterName, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker } from "../../packages/cli/src/destroy/names.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

describe("destroy: the order (docs/architecture-production.md, Tearing down an environment)", () => {
  it("deletes slack, runtime, control-plane, then the workers, then identity, foundation, access", () => {
    expect([...DELETE_BEFORE_WORKERS, "workers", ...DELETE_AFTER_WORKERS]).toEqual(["slack", "runtime", "control-plane", "workers", "identity", "foundation", "access"]);
  });
});

describe("destroy: name guards never reach another environment", () => {
  it("matches this environment's stacks, secrets, parameters and aliases exactly", () => {
    expect(isOwnedStack("prod", "agentx-prod-slack")).toBe(true);
    expect(isOwnedStack("prod", "agentx-prod-eu-slack")).toBe(false);
    expect(isOwnedStack("prod", "AgentXControlPlane")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/prod/slack")).toBe(true);
    expect(isOwnedSecret("prod", "agentx/prod-eu/slack")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/connectors/linear")).toBe(false);
    expect(isOwnedParameter("prod", "/agentx/prod/settings")).toBe(true);
    expect(isOwnedParameter("prod", "/agentx/prod-eu/settings")).toBe(false);
    expect(isOwnedAlias("prod", "alias/agentx/prod/workspaces")).toBe(true);
    expect(isOwnedAlias("prod", "alias/agentx/prod-eu/workspaces")).toBe(false);
    expect(isOwnedAlias("production", "alias/agentx/production-workspaces")).toBe(false);
  });

  it("matches nothing for a name that is not a valid environment name, so an empty or slashed name never widens a prefix", () => {
    expect(isOwnedStack("", "agentx--slack")).toBe(false);
    expect(isOwnedSecret("", "agentx//slack")).toBe(false);
    expect(isOwnedSecret("prod/", "agentx/prod//slack")).toBe(false);
    expect(isOwnedParameter("", "/agentx//settings")).toBe(false);
    expect(isOwnedAlias("", "alias/agentx//workspaces")).toBe(false);
    expect(isOwnedWorker("", { DeploymentMode: "ec2-ebs", Environment: "", "agentx:env": "" })).toBe(false);
    expect(isOwnedRetained("", { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }, { "agentx:env": "" })).toBe(false);
  });

  it("matches a worker only with all three tags, so the legacy deployment's workers (Environment=production, no agentx:env) are never touched", () => {
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production", "agentx:env": "production" })).toBe(true);
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production" })).toBe(false);
    expect(isOwnedWorker("prod", { DeploymentMode: "ec2-ebs", Environment: "prod-eu", "agentx:env": "prod-eu" })).toBe(false);
  });

  it("matches a retained resource only with this environment's tag and, for generated names, its stack's prefix", () => {
    const bucket: RetainedResource = { part: "foundation", logicalId: "Artifacts", type: "AWS::S3::Bucket", physicalId: "agentx-prod-foundation-access-artifactbucket-1a2b" };
    // Env "prod-foundation"'s access bucket starts with env "prod"'s foundation prefix; only the tag tells them apart.
    expect(isOwnedRetained("prod", bucket, { "agentx:env": "prod-foundation" })).toBe(false);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "agentx-prod-foundation-artifacts-9z" }, { "agentx:env": "prod" })).toBe(true);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "agentx-prod-eu-foundation-artifacts-9z" }, { "agentx:env": "prod" })).toBe(false);
    expect(isOwnedRetained("prod", { part: "identity", logicalId: "UserPool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_AbC" }, undefined)).toBe(false);
    expect(isOwnedRetained("prod", { part: "control-plane", logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: "arn:aws:secretsmanager:us-east-1:1:secret:agentx/prod-eu/slack-AbC" }, { "agentx:env": "prod" })).toBe(false);
  });
});

describe("destroy: name guards, prefix overlaps and the older production deployment", () => {
  it("never matches a name that only shares a prefix or differs in case", () => {
    expect(isOwnedStack("live", "agentx-live25b-slack")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/production/slack")).toBe(false);
    expect(isOwnedParameter("prod", "/agentx/production/settings")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/PROD/slack")).toBe(false);
    expect(isOwnedWorker("prod", { DeploymentMode: "ec2-ebs", "agentx:env": "prod" })).toBe(false);
  });

  it("matches the older production deployment's names for env production, so ruling F21 is load-bearing", () => {
    // The older (adopted) production deployment uses /agentx/production/* parameters and this KMS
    // alias (infra/lib/naming.ts). These guards cannot tell it from a named environment called
    // production: only runDestroy's up-front refusal of that deployment (ruling F21) protects it.
    expect(isOwnedAlias("production", "alias/agentx/production/invoke-signing")).toBe(true);
    expect(isOwnedParameter("production", "/agentx/production/worker-image")).toBe(true);
  });

  it("matches a tagged generated-name resource by its stack tag, so a bucket name CloudFormation shortened still matches", () => {
    const bucket: RetainedResource = { part: "control-plane", logicalId: "Artifacts", type: "AWS::S3::Bucket", physicalId: "agentx-a-very-long-envname-contr-artifactsbucket-1x2y3z" };
    expect(isOwnedRetained("a-very-long-envname", bucket, { "agentx:env": "a-very-long-envname", "aws:cloudformation:stack-name": "agentx-a-very-long-envname-control-plane" })).toBe(true);
    expect(isOwnedRetained("a-very-long-envname", bucket, { "agentx:env": "a-very-long-envname", "aws:cloudformation:stack-name": "agentx-a-very-long-envname-foundation" })).toBe(false);
    expect(isOwnedRetained("prod", { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }, { "agentx:env": "prod", "aws:cloudformation:stack-name": "agentx-prod-eu-foundation" })).toBe(false);
    // Without the stack tag, the name prefix still decides.
    expect(isOwnedRetained("a-very-long-envname", bucket, { "agentx:env": "a-very-long-envname" })).toBe(false);
  });
});

describe("destroy: the inventory schema", () => {
  it("refuses a GitHub account that could change the printed URL, and duplicate connectors", async () => {
    const store = new MemoryParameterStore();
    const base = { schemaVersion: 1 as const, env: "staging", resources: [] };
    await expect(writeInventory(store, { ...base, github: { account: "acme/../evil", accountType: "organization", slug: "agentx-acme" } })).rejects.toThrow();
    await expect(writeInventory(store, { ...base, connectors: ["linear", "linear"] })).rejects.toThrow();
    await expect(writeInventory(store, { ...base, github: { account: "Acme-Co", accountType: "organization", slug: "agentx-acme" }, connectors: ["linear", "jira"] })).resolves.toBeUndefined();
  });
});

describe("destroy: the inventory of what the stacks retain", () => {
  const template = JSON.stringify({ Resources: {
    State: { Type: "AWS::DynamoDB::Table", DeletionPolicy: "RetainExceptOnCreate" },
    Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain" },
    Fn: { Type: "AWS::Lambda::Function" },
  } });

  it("lists only resources whose DeletionPolicy retains them", () => {
    const found = retainedResources("control-plane", template, [
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "agentx-staging-control-plane-State-1" },
      { logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" },
      { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "fn" },
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: undefined },
    ]);
    expect(found.map((entry) => entry.logicalId)).toEqual(["State", "Pool"]);
  });

  it("falls back to the retained resource types when the template cannot be parsed", () => {
    expect(retainedResources("foundation", "Resources: yaml", [{ logicalId: "FlowLogs", type: "AWS::Logs::LogGroup", physicalId: "g" }, { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "f" }]).map((entry) => entry.logicalId)).toEqual(["FlowLogs"]);
  });

  it("round-trips through SSM, merges without duplicates, and keeps what an earlier run recorded", async () => {
    const store = new MemoryParameterStore();
    const first = mergeInventory(undefined, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }], launchTemplateId: "lt-0123456789abcdef0", slackAppId: "A0APP" });
    await writeInventory(store, first);
    expect(store.values.has(inventoryParameterName("staging"))).toBe(true);
    const stored = await readInventory(store, "staging");
    const second = mergeInventory(stored, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }, { part: "identity", logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" }] });
    expect(second.resources).toHaveLength(2);
    expect(second.launchTemplateId).toBe("lt-0123456789abcdef0");
    expect(second.slackAppId).toBe("A0APP");
  });
});

describe("destroy: confirmation (question 1)", () => {
  it("asks for the environment's name, and also the account id for production or an environment AgentX has no record of", () => {
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["staging"]);
    expect(confirmationPrompts({ env: "production", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["production", "123456789012"]);
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: false }).map((prompt) => prompt.expected)).toEqual(["staging", "123456789012"]);
  });
});

describe("destroy: what is shown before, and printed after", () => {
  it("shows every stack in order, the workers with the workspace warning, what is kept, and the slow control-plane delete", () => {
    const lines = destroyPlanText({
      env: "staging", account: "123456789012", region: "us-east-1",
      stacks: [{ name: "agentx-staging-slack", status: "UPDATE_COMPLETE" }, { name: "agentx-staging-control-plane", status: "UPDATE_COMPLETE" }],
      instances: 1, volumes: 2, secrets: 5, parameters: 9, localFiles: ["/home/a/.agentx/environments/staging.yaml"], keepData: false,
      resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }, { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }],
    });
    expect(lines[0]).toBe("This deletes AgentX environment staging in account 123456789012, region us-east-1:");
    expect(lines).toContain("  stacks, in this order: agentx-staging-slack (UPDATE_COMPLETE), agentx-staging-control-plane (UPDATE_COMPLETE)");
    expect(lines).toContain("  EC2 workers: 1 instance and 2 workspace volumes; deleting the volumes deletes every worker session's workspace");
    expect(lines).toContain("  what the stacks keep, deleted after them: 1 table and 1 KMS key (deleted after 7 days)");
    expect(lines).toContain("  Deleting agentx-staging-control-plane usually takes 20 to 40 minutes: its Lambda functions release their network interfaces slowly.");
    expect(lines.at(-1)).toBe("Nothing here can be undone.");
    const kept = destroyPlanText({ env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], keepData: true, resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }] });
    expect(kept).toContain("  --keep-data keeps: 1 table and 5 secrets");
  });

  it("counts the stacks' secrets once, with the secrets under agentx/<env>/, and joins lists as a, b and c", () => {
    const resources: RetainedResource[] = [
      { part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" },
      { part: "identity", logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "p" },
      { part: "control-plane", logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: "agentx/staging/slack" },
    ];
    const plan = { env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], resources };
    const all = destroyPlanText({ ...plan, keepData: false });
    expect(all).toContain("  what the stacks keep, deleted after them: 1 table and 1 Cognito user pool");
    expect(all).toContain("  secrets: 5 secrets under agentx/staging/, deleted without recovery");
    expect(destroyPlanText({ ...plan, keepData: true })).toContain("  --keep-data keeps: 1 table, 1 Cognito user pool and 5 secrets");
  });

  it("prints the GitHub App and Slack app pages to delete them, and the connector credentials to revoke", () => {
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "acme", accountType: "organization", slug: "agentx-acme" }, slackAppId: "A0APP", connectors: ["linear"] })).toEqual([
      "Delete the GitHub App agentx-acme: open https://github.com/organizations/acme/settings/apps/agentx-acme/advanced and choose Delete GitHub App.",
      "Delete the Slack app: open https://api.slack.com/apps/A0APP/general and choose Delete App at the bottom of the page.",
      "Revoke the Linear API key AgentX used: Linear, Settings, Security and access, API keys.",
    ]);
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "alice", accountType: "user", slug: "agentx-alice" } })[0]).toBe("Delete the GitHub App agentx-alice: open https://github.com/settings/apps/agentx-alice/advanced and choose Delete GitHub App.");
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [] })).toEqual([
      "Delete the environment's GitHub App, if it had one: https://github.com/settings/apps (for an organization: its Settings, Developer settings, GitHub Apps), then Advanced, Delete GitHub App.",
      "Delete the environment's Slack app, if it had one: https://api.slack.com/apps, the app, then Delete App at the bottom of Basic Information.",
    ]);
  });
});
