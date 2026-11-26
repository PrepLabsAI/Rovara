import { createHmac } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const NOW = "2026-11-14T12:00:00.000Z";
const ID = "550e8400-e29b-41d4-a716-446655440030";
beforeAll(loadSlackBroker);
it("the real broker refuses a webhook bound to another company exactly like an unknown installation", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim("org_aaaaaaaaaaaaaaaaaaaa", 77, "shared-account", "operator");
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings,
    githubWebhookSecret: async () => "fixture-only", githubPullRequests: { verifyWebhookRepository: async () => true } } });
  seedLinkedProject(db, "org_bbbbbbbbbbbbbbbbbbbb");
  const invoke = (installationId: number) => {
    const body = JSON.stringify({ action: "opened", installation: { id: installationId }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 1 } });
    return handler({ rawPath: "/v1/github/webhooks", body,
      headers: { "x-github-delivery": ID, "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-only").update(body).digest("hex")}` },
      requestContext: { requestId: "golden", http: { method: "POST" } } });
  };
  // Webhook lane W0: a signed delivery that maps to nothing of this installation's company is 202 IGNORED (nothing written), the same for another company's installation and an unknown one.
  const other = await invoke(77);
  expect(other.statusCode).toBe(202);
  expect(JSON.parse(other.body)).toMatchObject({ delivery: "IGNORED" });
  expect(other).toEqual(await invoke(78));
  expect(JSON.stringify(other)).not.toMatch(/org_|shared-account/);
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeUndefined();
});
function seedLinkedProject(db: FakeDynamoDb, companyId?: string) {
  const url = "https://github.com/example/demo/pull/1";
  db.set({ pk: "GITHUB_PR#example/demo", sk: "PR#0000000001", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 1,
    url, taskId: "task", workspaceId: "workspace", candidateDigest: "a".repeat(64) });
  // A linked task belongs to the same company as its project; only built-in rows may be unstamped.
  db.set({ pk: "DEVTASK#task", sk: "META", ...(companyId === undefined ? {} : { companyId }), project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE",
    pullRequests: [{ repositoryId: "demo", number: 1, url, candidateDigest: "a".repeat(64) }] } });
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", ...(companyId === undefined ? {} : { companyId }), definition: { repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }] } });
}

it("the worker grant exchange refuses a foreign installation before minting", async () => {
  const { RepositoryGrantService } = await import("../../packages/broker/src/repository-access.js");
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const workspaceId = "550e8400-e29b-41d4-a716-446655440010";
  const operationId = "550e8400-e29b-41d4-a716-446655440011";
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim("org_aaaaaaaaaaaaaaaaaaaa", 77, "shared-account", "operator");
  let minted = 0;
  const grants = new RepositoryGrantService(Buffer.alloc(32, 1), async () => { minted++; return { username: "fixture" }; });
  const repository = { credentialRef: "github", repositoryUrl: "https://github.com/example/demo.git", access: "clone" as const };
  const grant = grants.issue({ ownerKey: "owner".repeat(8), projectName: "demo", workspaceId, operationId, repositories: [repository] });
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings, repositoryGrants: grants, githubPullRequests: { installationIdFor: async () => 77 } } });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey: "owner".repeat(8), projectName: "demo", projectRevision: 1,
    environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, activeOperationId: operationId, createdAt: NOW, updatedAt: NOW });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, id: operationId, workspaceId, kind: "prepare", status: "RUNNING", fence: 1 });
  seedLinkedProject(db, "org_bbbbbbbbbbbbbbbbbbbb");
  const invoke = () => handler({ rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/repository-credentials`, body: JSON.stringify(repository),
    headers: { "x-agentx-repository-grant": grant }, requestContext: { requestId: "mint", http: { method: "POST" } } });
  const refused = await invoke();
  expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "GITHUB_NOT_CONNECTED" } });
  expect(minted).toBe(0);
  seedLinkedProject(db, "org_aaaaaaaaaaaaaaaaaaaa");
  expect((await invoke()).statusCode).toBe(200);
  expect(minted).toBe(1);
});

it.each([ "connectors/github/tools"])("the GitHub MCP route refuses a foreign installation before discovery: %s", async (path) => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { ownerKeyForSubject } = await import("../../packages/broker/src/aws/lambda.js");
  const { call, orchestratorPrincipal } = await import("../support/slack-broker.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim("org_aaaaaaaaaaaaaaaaaaaa", 77, "shared-account", "operator");
  let minted = 0;
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings,
    githubPullRequests: { installationIdFor: async () => 77 }, githubMcp: { credentials: async () => { minted++; throw new Error("mint reached"); } } } });
  const workspaceId = "550e8400-e29b-41d4-a716-446655440010";
  const thread = "T0123456789/C0123456789/1758240000.000100";
  const ownerKey = ownerKeyForSubject("slack-thread", thread);
  db.set({ pk: "SLACK_BINDING#T0123456789", sk: "CHANNEL#C0123456789", teamId: "T0123456789", channelId: "C0123456789", projectName: "demo", projectRevision: 1, updatedAt: NOW });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey, projectName: "demo", projectRevision: 1,
    environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: NOW, updatedAt: NOW });
  // DEC 254zzz98 (one rule): this route reads the project's legacy revision, so the grant it reads is the legacy row beside it (whatever company the revision row names).
  db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", companyId: "org_bbbbbbbbbbbbbbbbbbbb", definition: { name: "demo", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github" }], integrations: { githubMcp: { tools: [{ name: "get_me", access: "read" }] } } } });
  const response = await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/${path}`, service: { principal: orchestratorPrincipal, thread, slackUser: "U0123456789" } });
  if (path.startsWith("github/")) expect(response.body).toMatchObject({ error: { code: "GITHUB_NOT_CONNECTED" } });
  expect(minted).toBe(0);
});

it.each(["github/tools?repository=demo"])("DEC 254zzz98, two companies: a grant in a company's own partition never opens the legacy project these MCP routes read: %s", async (path) => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { ownerKeyForSubject } = await import("../../packages/broker/src/aws/lambda.js");
  const { call, orchestratorPrincipal } = await import("../support/slack-broker.js");
  const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(A, 77, "shared-account", "operator");
  let minted = 0;
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings,
    githubPullRequests: { installationIdFor: async () => 77 }, githubMcp: { credentials: async () => { minted++; throw new Error("mint reached"); } } } });
  const workspaceId = "550e8400-e29b-41d4-a716-446655440011";
  const thread = "T0123456789/C0123456789/1758240000.000200";
  const ownerKey = ownerKeyForSubject("slack-thread", thread);
  db.set({ pk: "SLACK_BINDING#T0123456789", sk: "CHANNEL#C0123456789", teamId: "T0123456789", channelId: "C0123456789", projectName: "demo", projectRevision: 1, updatedAt: NOW });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", id: workspaceId, ownerKey, projectName: "demo", projectRevision: 1,
    environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: NOW, updatedAt: NOW });
  // Company A's project "demo" (its legacy revision, A's GitHub connectors). The caller holds grants on "demo" only in company layouts: A's own and B's (a same-named project).
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", companyId: A, definition: { name: "demo", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github" }], integrations: { githubMcp: { tools: [{ name: "get_me", access: "read" }] } } } });
  db.set({ pk: `ORG#${B}#MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  db.set({ pk: `ORG#${A}#MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  const request = () => call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/${path}`, service: { principal: orchestratorPrincipal, thread, slackUser: "U0123456789" } });
  expect((await request()).body).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(minted).toBe(0);
  // Control: the legacy grant beside the legacy revision is what opens it (the route then reaches its own checks, never "not found").
  db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  expect((await request()).body).not.toMatchObject({ error: { code: "NOT_FOUND" } });
});

