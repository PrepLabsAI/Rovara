import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { handleGithubWebhook, listDueGithubWebhookDeliveries, reserveGithubWebhookDelivery } from "../../packages/broker/src/aws/github-webhooks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const NOW = "2026-11-14T12:00:00.000Z";
const ID = "550e8400-e29b-41d4-a716-446655440030";
const EVENT = { kind: "PULL_REQUEST" as const, action: "opened", installationId: 77, repositoryId: 42, fullName: "example/demo", number: 1 };
beforeAll(loadSlackBroker);
function golden(name: string, value: unknown) {
  const path = `tests/fixtures/github-company-goldens/${name}.json`;
  const bytes = JSON.stringify(value) + "\n";
  expect(bytes).toBe(readFileSync(path, "utf8"));
}
it.each([false, true])("pins the base webhook accepted, duplicate and refusal bytes (bindings=%s)", async (enabled) => {
  const db = new FakeDynamoDb();
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const bindings = new GithubInstallationBindings(db, "state");
  if (enabled) await bindings.backfill(async () => [{ installationId: 77, accountLogin: "example" }]);
  const rawBody = JSON.stringify({ action: EVENT.action, installation: { id: 77 }, repository: { id: 42, full_name: EVENT.fullName }, pull_request: { number: 1 } });
  const secret = "fixture-only";
  const input = { documentClient: db, tableName: "state", rawBody, secret,
    ...(enabled ? { companyForInstallation: (id: number) => bindings.ownerOf(id) } : {}),
    headers: { "x-github-delivery": ID, "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` },
    authorizeRepository: async () => true, process: async () => {}, now: () => NOW };
  golden("webhook-accepted", await handleGithubWebhook(input));
  golden("webhook-duplicate", await handleGithubWebhook(input));
  const refused = await handleGithubWebhook({ ...input, authorizeRepository: async () => false }).catch((error: Error) => ({ name: error.name, message: error.message }));
  golden("webhook-refused", refused);
});
it.each([false, true])("pins base recovery results with zero and two rows (bindings=%s)", async (enabled) => {
  const db = new FakeDynamoDb({ seed: 1995640244 });
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const input = { documentClient: db, tableName: "state", now: NOW, ...(enabled ? { companyId: IMPLICIT_COMPANY_ID } : {}) };
  golden("recovery-empty", await listDueGithubWebhookDeliveries(input));
  for (const suffix of ["030", "031"]) await reserveGithubWebhookDelivery({ ...input, deliveryId: ID.slice(0, -3) + suffix, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  golden("recovery-two", await listDueGithubWebhookDeliveries(input));
});
it("pins base empty sweep and missing administrator retry", async () => {
  const { handler, brokerInput } = createBroker();
  golden("sweep-empty", await handler({ source: "agentx.github-webhook-recovery" }));
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const result = await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "operator" } as never, ID)
    .catch((error: { code: string; message: string; statusCode: number }) => ({ code: error.code, message: error.message, statusCode: error.statusCode }));
  golden("retry-missing", result);
});

it("keeps scoped delivery partitions through reserve, claim and retry", async () => {
  const { companyScoped } = await import("@agentx/contracts");
  const { claimGithubWebhookDelivery, retryGithubWebhookDelivery } = await import("../../packages/broker/src/aws/github-webhooks.js");
  const db = new FakeDynamoDb();
  const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
  const base = { documentClient: db, tableName: "state", now: NOW, companyId };
  await reserveGithubWebhookDelivery({ ...base, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  const read = () => db.get(`GITHUB_DELIVERY#${ID}`, "META");
  expect(read()).toMatchObject({ companyId, webhookRecoveryPk: companyScoped(companyId, "GITHUB_WEBHOOK_RECOVERY") });
  expect(db.get("GITHUB_WEBHOOK_COMPANIES", companyId)).toBeDefined();
  expect(await listDueGithubWebhookDeliveries(base)).toHaveLength(1);
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: "org_bbbbbbbbbbbbbbbbbbbb" })).toEqual([]);
  await claimGithubWebhookDelivery({ ...base, deliveryId: ID, leaseToken: ID });
  expect(read()?.webhookRecoveryPk).toBe(companyScoped(companyId, "GITHUB_WEBHOOK_RECOVERY"));
  await retryGithubWebhookDelivery({ ...base, deliveryId: ID, leaseToken: ID });
  expect(read()?.webhookRecoveryPk).toBe(companyScoped(companyId, "GITHUB_WEBHOOK_RECOVERY"));
});
it("includes legacy rows for the implicit company only and refuses poisoned old partitions", async () => {
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const db = new FakeDynamoDb();
  const base = { documentClient: db, tableName: "state", now: NOW };
  await reserveGithubWebhookDelivery({ ...base, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: IMPLICIT_COMPANY_ID })).toHaveLength(1);
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: "org_bbbbbbbbbbbbbbbbbbbb" })).toEqual([]);
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
  await expect(listDueGithubWebhookDeliveries({ ...base, companyId: IMPLICIT_COMPANY_ID })).rejects.toThrow("GitHub delivery scope is unavailable");
});
it("rejects malformed scopes before I/O and never echoes the scope", async () => {
  const db = new FakeDynamoDb();
  for (const companyId of [null, 23, "private-canary", "", {}]) {
    await expect(listDueGithubWebhookDeliveries({ documentClient: db, tableName: "state", now: NOW, companyId: companyId as string })).rejects.toThrow(/^GitHub delivery scope is unavailable$/);
  }
});

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
  const other = await invoke(77);
  expect(other.statusCode).toBe(403);
  expect(other).toEqual(await invoke(78));
  expect(JSON.stringify(other)).not.toMatch(/org_|shared-account/);
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toBeUndefined();
});
function seedLinkedProject(db: FakeDynamoDb, companyId?: string) {
  const url = "https://github.com/example/demo/pull/1";
  db.set({ pk: "GITHUB_PR#example/demo", sk: "PR#0000000001", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 1,
    url, taskId: "task", workspaceId: "workspace", candidateDigest: "a".repeat(64) });
  db.set({ pk: "DEVTASK#task", sk: "META", project: "demo", startingRevision: 1, workflow: { stage: "WAIT_FOR_MERGE",
    pullRequests: [{ repositoryId: "demo", number: 1, url, candidateDigest: "a".repeat(64) }] } });
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", ...(companyId === undefined ? {} : { companyId }), definition: { repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }] } });
}
it("recovery revalidates ownership under the lease and terminates revoked scope", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb();
  const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim("org_bbbbbbbbbbbbbbbbbbbb", 77, "shared-account", "operator");
  seedLinkedProject(db, "org_bbbbbbbbbbbbbbbbbbbb");
  const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
  await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings, githubPullRequests: { verifyWebhookRepository: async () => true } } });
  const response = await handler({ source: "agentx.github-webhook-recovery" });
  expect(JSON.parse(response.body)).toMatchObject({ attempted: 1, processed: 0 });
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")).toMatchObject({ status: "DEAD" });
});
it("administrator company retries hide other-company rows and fail closed on membership", async () => {
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const { db, brokerInput } = createBroker();
  const base = { ...brokerInput, companies: { companyOf: async () => "org_bbbbbbbbbbbbbbbbbbbb" } };
  const admin = { isAdministrator: true, subject: "operator" };
  db.set({ pk: `GITHUB_DELIVERY#${ID}`, sk: "META", status: "DEAD", event: EVENT, companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
  const read = (deps: unknown, id: string) => retryGithubWebhookAsAdministrator(deps as never, admin as never, id).catch((e: { code: string; message: string; statusCode: number }) => ({ code: e.code, message: e.message, statusCode: e.statusCode }));
  expect(await read(base, ID)).toEqual(await read(base, ID.slice(0, -1) + "1"));
  expect(await read(base, ID)).toMatchObject({ code: "NOT_FOUND" });
  for (const companyOf of [async () => undefined, async () => "private-canary", async () => { throw new Error("private-canary"); }]) {
    const response = await read({ ...base, companies: { companyOf } }, ID);
    expect(response).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(JSON.stringify(response)).not.toContain("private-canary");
  }
});

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
    environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`, rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: NOW, updatedAt: NOW });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, id: operationId, workspaceId, kind: "prepare" });
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
it("one sweep has a total delivery cap and explicitly reports remaining work", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  for (let company = 0; company < 5; company++) for (let n = 0; n < 26; n++) {
    await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId: `org_${String(company).padStart(20, "0")}`,
      deliveryId: `550e8400-e29b-41d4-a716-${String(company * 26 + n).padStart(12, "0")}`, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  }
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings } });
  const response = await handler({ source: "agentx.github-webhook-recovery" });
  expect(JSON.parse(response.body)).toMatchObject({ attempted: 100, processed: 0, more: true });
});

it.each(["github/tools?repository=demo", "connectors/github/tools"])("the GitHub MCP route refuses a foreign installation before discovery: %s", async (path) => {
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
  db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  db.set({ pk: "PROJECT#demo", sk: "REV#000000000001", companyId: "org_bbbbbbbbbbbbbbbbbbbb", definition: { name: "demo", revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github" }], integrations: { githubMcp: { tools: [{ name: "get_me", access: "read" }] } } } });
  const response = await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/${path}`, service: { principal: orchestratorPrincipal, thread, slackUser: "U0123456789" } });
  if (path.startsWith("github/")) expect(response.body).toMatchObject({ error: { code: "GITHUB_NOT_CONNECTED" } });
  expect(minted).toBe(0);
});

it("bounds registry enumeration and reports additional companies", async () => {
  const { listGithubWebhookCompanies } = await import("../../packages/broker/src/aws/github-webhooks.js");
  const db = new FakeDynamoDb();
  for (let i = 1; i <= 51; i++) db.set({ pk: "GITHUB_WEBHOOK_COMPANIES", sk: `org_${String(i).padStart(20, "0")}` });
  const result = await listGithubWebhookCompanies({ documentClient: db, tableName: "state" });
  expect(result.companies).toHaveLength(50); expect(result.more).toBe(true);
});
it("a malformed recovery row refuses the whole page without returning its otherwise valid neighbor", async () => {
  const db = new FakeDynamoDb(); const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
  const input = { documentClient: db, tableName: "state", now: NOW, companyId };
  for (const suffix of ["030", "031"]) await reserveGithubWebhookDelivery({ ...input, deliveryId: ID.slice(0, -3) + suffix, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, event: { ...EVENT, kind: "private-canary" } });
  await expect(listDueGithubWebhookDeliveries(input)).rejects.toThrow(/^GitHub delivery scope is unavailable$/);
});

it("registry storage failures use fixed text without an echoed cause", async () => {
  const { listGithubWebhookCompanies } = await import("../../packages/broker/src/aws/github-webhooks.js");
  const documentClient = { send: async () => { throw Object.assign(new Error("private-canary"), { name: "private-canary" }); } };
  await expect(listGithubWebhookCompanies({ documentClient, tableName: "state" })).rejects.toThrow(/^GitHub delivery scope is unavailable$/);
});

it("a scoped administrator retry refuses a malformed stored event with fixed words", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
  await bindings.backfill(async () => []); await bindings.claim(companyId, 77, "shared-account", "operator");
  seedLinkedProject(db, companyId);
  await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, status: "DEAD", event: { ...EVENT, kind: "private-canary" } });
  const { brokerInput } = createBroker({ extra: { documentClient: db, githubBindings: bindings, companies: { companyOf: async () => companyId }, githubPullRequests: { verifyWebhookRepository: async () => true } } });
  const answer = await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person" } as never, ID)
    .catch((e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
  expect(answer).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: webhook delivery not found" });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, event: EVENT, repositoryId: 999 });
  await expect(retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person" } as never, ID)).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: webhook delivery not found" });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, repositoryId: 42 });
  await expect(retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person" } as never, ID)).resolves.toEqual({ deliveryId: ID, status: "RETRY_QUEUED" });
});

it("reservation conflicts and leases cannot be borrowed from another company", async () => {
  const { claimGithubWebhookDelivery, retryGithubWebhookDelivery } = await import("../../packages/broker/src/aws/github-webhooks.js");
  const db = new FakeDynamoDb(); const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
  const input = { documentClient: db, tableName: "state", now: NOW, companyId, deliveryId: ID };
  const delivery = { installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT };
  await reserveGithubWebhookDelivery({ ...input, ...delivery });
  const foreign = { ...input, companyId: "org_bbbbbbbbbbbbbbbbbbbb" };
  expect(await reserveGithubWebhookDelivery({ ...foreign, ...delivery })).toBe("conflict");
  expect(await claimGithubWebhookDelivery({ ...foreign, leaseToken: ID })).toBe(false);
  expect(await claimGithubWebhookDelivery({ ...input, leaseToken: ID })).toBe(true);
  await expect(retryGithubWebhookDelivery({ ...foreign, leaseToken: ID })).rejects.toThrow(/^GitHub delivery scope is unavailable$/);
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")?.status).toBe("PROCESSING");
});


it.each([false, true])("pins full broker sweep and successful retry compatibility (bindings=%s)", async enabled => {
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const db = new FakeDynamoDb();
  const bindings = enabled ? new GithubInstallationBindings(db, "state") : undefined;
  if (bindings !== undefined) await bindings.backfill(async () => [{ installationId: 77, accountLogin: "example" }]);
  const { handler, brokerInput } = createBroker({ extra: { documentClient: db,
    ...(bindings === undefined ? {} : { githubBindings: bindings, companies: { companyOf: async () => IMPLICIT_COMPANY_ID } }),
    githubPullRequests: { verifyWebhookRepository: async () => true } } });
  seedLinkedProject(db, enabled ? IMPLICIT_COMPANY_ID : undefined);
  golden("sweep-empty", await handler({ source: "agentx.github-webhook-recovery" }));
  for (const suffix of ["030", "031"]) await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW,
    ...(enabled ? { companyId: IMPLICIT_COMPANY_ID } : {}), deliveryId: ID.slice(0, -3) + suffix,
    installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  golden("sweep-two", await handler({ source: "agentx.github-webhook-recovery" }));
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, status: "DEAD" });
  golden("retry-success", await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "operator" } as never, ID));
});
