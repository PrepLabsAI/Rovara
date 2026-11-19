import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
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
  const result = await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "operator", developer: { developerId: "checked-person" } } as never, ID)
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
it("includes legacy rows for the implicit company only and counts poisoned old partitions", async () => {
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const db = new FakeDynamoDb();
  const base = { documentClient: db, tableName: "state", now: NOW };
  await reserveGithubWebhookDelivery({ ...base, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: IMPLICIT_COMPANY_ID })).toHaveLength(1);
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: "org_bbbbbbbbbbbbbbbbbbbb" })).toEqual([]);
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
  expect(await listDueGithubWebhookDeliveries({ ...base, companyId: IMPLICIT_COMPANY_ID })).toMatchObject({ length: 0, skipped: 1 });
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
  const base = { ...brokerInput, companies: { companyOf: async (id: string) => id === "checked-person" ? "org_bbbbbbbbbbbbbbbbbbbb" : undefined } };
  const admin = { isAdministrator: true, subject: "operator", developer: { developerId: "checked-person" } };
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
  for (let company = 0; company < 6; company++) for (let n = 0; n < 20; n++) {
    await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId: `org_${String(company).padStart(20, "0")}`,
      deliveryId: `550e8400-e29b-41d4-a716-${String(company * 20 + n).padStart(12, "0")}`, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
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
  // DEC 254zzz80 (lane 2): the grant of a project of named company B lives in B's own partition.
  db.set({ pk: `ORG#org_bbbbbbbbbbbbbbbbbbbb#MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
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
  const answer = await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person", developer: { developerId: "checked-person" } } as never, ID)
    .catch((e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
  expect(answer).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: webhook delivery not found" });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, event: EVENT, repositoryId: 999 });
  await expect(retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person", developer: { developerId: "checked-person" } } as never, ID)).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: webhook delivery not found" });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, repositoryId: 42 });
  await expect(retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "person", developer: { developerId: "checked-person" } } as never, ID)).resolves.toEqual({ deliveryId: ID, status: "RETRY_QUEUED" });
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
  golden("retry-success", await retryGithubWebhookAsAdministrator(brokerInput as never, { isAdministrator: true, subject: "operator", developer: { developerId: "checked-person" } } as never, ID));
});

it("pins enabled missing and foreign retry NOT_FOUND bytes (ANSWER-2)", async () => {
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const { db, brokerInput } = createBroker();
  const deps = { ...brokerInput, companies: { companyOf: async () => "org_bbbbbbbbbbbbbbbbbbbb" } };
  const read = (id: string) => retryGithubWebhookAsAdministrator(deps as never, { isAdministrator: true, subject: "operator", developer: { developerId: "checked-person" } } as never, id)
    .catch((error: { code: string; message: string; statusCode: number }) => ({ code: error.code, message: error.message, statusCode: error.statusCode }));
  golden("retry-missing-enabled", await read(ID));
  db.set({ pk: `GITHUB_DELIVERY#${ID}`, sk: "META", companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
  golden("retry-missing-enabled", await read(ID));
});


it("authorized two-company recovery drains 50 deliveries exactly once across continuations without spending its read budget on processing", async () => {
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  const companies = [IMPLICIT_COMPANY_ID, "org_bbbbbbbbbbbbbbbbbbbb"];
  const ids: string[] = [];
  for (const [c, companyId] of companies.entries()) {
    await bindings.claim(companyId, 77 + c, "example", "operator");
    seedLinkedProject(db, companyId);
    for (const [pk, sk] of [["GITHUB_PR#example/demo", "PR#0000000001"], ["DEVTASK#task", "META"], ["PROJECT#demo", "REV#000000000001"]]) {
      const row = db.get(pk!, sk!)!;
      db.set(JSON.parse(JSON.stringify(row).replaceAll("demo", `demo${c}`).replaceAll('"task"', `"task${c}"`).replaceAll("#task", `#task${c}`)) as Record<string, unknown>);
    }
    for (let i = 0; i < 25; i++) {
      const deliveryId = `550e8400-e29b-41d4-a716-${String(c * 25 + i).padStart(12, "0")}`; ids.push(deliveryId);
      await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId, deliveryId,
        installationId: 77 + c, repositoryId: 42, eventHash: "a".repeat(64), event: { ...EVENT, installationId: 77 + c, fullName: `example/demo${c}` } });
    }
  }
  // Each authorized event reaches the real reconciler. A closed task is a successful no-op,
  // after the checked project/link reads, and lets us isolate delivery lease completion.
  for (let c = 0; c < 2; c++) db.set({ ...db.get(`DEVTASK#task${c}`, "META")!, closedAt: NOW });
  let reads = 0;
  const send = db.send.bind(db);
  db.send = async command => { reads++; return send(command); };
  let clock = Date.now(); const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings,
    githubPullRequests: { verifyWebhookRepository: async () => { clock += 1_000; return true; }, getPullRequestFeedback: async () => { throw new Error("closed task must not fetch"); } } } });
  try {
  let continuation: unknown; let completed = 0;
  for (let run = 0; run < 10; run++) {
    const response = await handler({ source: "agentx.github-webhook-recovery", ...(continuation === undefined ? {} : { continuation }) });
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as { processed: number; more?: boolean; continuation?: string }; completed += result.processed;
    expect(ids.map(id => db.get(`GITHUB_DELIVERY#${id}`, "META")?.status)).not.toContain("PROCESSING");
    if (!result.more) break;
    expect(result.continuation).toBeDefined(); continuation = result.continuation;
  }
  expect(reads).toBeGreaterThan(512);
  expect(completed).toBe(50);
  for (const id of ids) expect(db.get(`GITHUB_DELIVERY#${id}`, "META")).toMatchObject({ status: "COMPLETED", attempts: 1 });
  } finally { now.mockRestore(); }
});

it("retry fails closed without membership wiring or a checked developer identity", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { retryGithubWebhookAsAdministrator } = await import("../../packages/broker/src/aws/broker.js");
  const { db, brokerInput } = createBroker(); const bindings = new GithubInstallationBindings(db, "state");
  db.set({ pk: `GITHUB_DELIVERY#${ID}`, sk: "META", status: "DEAD", event: EVENT });
  const companyOf = vi.fn(async () => "org_aaaaaaaaaaaaaaaaaaaa");
  for (const companies of [undefined, { companyOf }]) {
    await expect(retryGithubWebhookAsAdministrator({ ...brokerInput, githubBindings: bindings, companies } as never,
      { isAdministrator: true, subject: "private-canary", ownerKey: "private-canary" } as never, ID)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")?.status).toBe("DEAD");
  }
  expect(companyOf).not.toHaveBeenCalled();
  await expect(retryGithubWebhookAsAdministrator({ ...brokerInput, githubBindings: bindings } as never,
    { isAdministrator: true, subject: "private-canary", developer: { developerId: "checked-person" } } as never, ID)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

it("recovery skips and counts one bad legacy row and still reaches other companies", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, deliveryId: ID, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  db.set({ ...db.get(`GITHUB_DELIVERY#${ID}`, "META")!, companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
  for (let n = 0; n < 52; n++) await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW,
    companyId: n === 0 ? IMPLICIT_COMPANY_ID : `org_${String(n).padStart(20, "0")}`, deliveryId: `550e8400-e29b-41d4-a716-${String(n + 100).padStart(12, "0")}`,
    installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings } });
  let continuation: unknown; let attempted = 0; let skipped = 0; let done = false;
  for (let run = 0; run < 10; run++) {
    const response = await handler({ source: "agentx.github-webhook-recovery", ...(continuation === undefined ? {} : { continuation }) });
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as { attempted: number; skipped?: number; more?: boolean; continuation?: string }; attempted += result.attempted; skipped += result.skipped ?? 0;
    if (!result.more) { done = true; break; }
    expect(result.continuation).toBeTypeOf("string"); continuation = result.continuation;
  }
  expect(done).toBe(true); expect(attempted).toBe(52); expect(skipped).toBe(1);
  expect(db.get(`GITHUB_DELIVERY#${ID}`, "META")?.status).toBe("RECEIVED");
});

it("pins the broker webhook route absent-mode accepted duplicate and refused bytes", async () => {
  const { db, handler } = createBroker({ extra: { githubWebhookSecret: async () => "fixture-only",
    githubPullRequests: { verifyWebhookRepository: async () => true, getPullRequestFeedback: async () => { throw new Error("closed task"); } } } });
  seedLinkedProject(db);
  db.set({ ...db.get("DEVTASK#task", "META")!, closedAt: NOW });
  const invoke = (installationId = 77) => {
    const body = JSON.stringify({ action: "opened", installation: { id: installationId }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 1 } });
    return handler({ rawPath: "/v1/github/webhooks", body,
      headers: { "x-github-delivery": ID, "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-only").update(body).digest("hex")}` },
      requestContext: { requestId: "golden", http: { method: "POST" } } });
  };
  golden("webhook-route-accepted", await invoke());
  golden("webhook-route-duplicate", await invoke());
  db.delete("GITHUB_PR#example/demo", "PR#0000000001");
  golden("webhook-route-refused", await invoke(78));
});

it("read-budget exhaustion stops before claiming and returns a continuation", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  let clock = Date.now(); const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const send = db.send.bind(db); let slow = true;
  db.send = async command => { const result = await send(command); if (slow) { clock += 10_001; slow = false; } return result; };
  try {
    const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings } });
    const response = await handler({ source: "agentx.github-webhook-recovery" });
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as { continuation?: string };
    expect(JSON.parse(response.body)).toMatchObject({ attempted: 0, processed: 0, more: true });
    expect(result.continuation).toBeDefined();
    expect(JSON.parse((await handler({ source: "agentx.github-webhook-recovery", continuation: result.continuation })).body)).toMatchObject({ attempted: 0 });
  } finally { now.mockRestore(); }
});

it("recovery continuation rejects wrong shapes and cross-partition keys with fixed words", async () => {
  const { readGithubRecoveryContinuation } = await import("../../packages/broker/src/aws/github-webhooks.js");
  for (const value of [null, 42, "private-canary", "x".repeat(2_001), Buffer.from(JSON.stringify({ companyId: "private-canary" })).toString("base64url")]) {
    expect(() => readGithubRecoveryContinuation(value)).toThrow(/^GitHub delivery scope is unavailable$/);
  }
  const db = new FakeDynamoDb();
  await expect(listDueGithubWebhookDeliveries({ documentClient: db, tableName: "state", companyId: "org_aaaaaaaaaaaaaaaaaaaa", now: NOW,
    continuation: { partition: 0, after: { pk: `GITHUB_DELIVERY#${ID}`, sk: "META", webhookRecoveryPk: "private-canary", webhookRecoverySk: `${NOW}#${ID}` } } })).rejects.toThrow(/^GitHub delivery scope is unavailable$/);
});

it("recovery resumes past a full delivery page without skipping the remaining rows", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  for (let i = 0; i < 60; i++) await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, companyId: "org_bbbbbbbbbbbbbbbbbaaa",
    deliveryId: `550e8400-e29b-41d4-a716-${String(i + 200).padStart(12, "0")}`, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings } });
  let continuation: string | undefined; let attempted = 0; let done = false;
  for (let run = 0; run < 5; run++) {
    const response = await handler({ source: "agentx.github-webhook-recovery", ...(continuation === undefined ? {} : { continuation }) });
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as { attempted: number; more?: boolean; continuation?: string };
    attempted += result.attempted;
    if (!result.more) { done = true; break; }
    expect(attempted).toBeLessThan(60); expect(result.continuation).toBeDefined(); continuation = result.continuation;
  }
  expect(done).toBe(true); expect(attempted).toBe(60);
  expect(db.find(row => row.entityType === "GITHUB_WEBHOOK_DELIVERY" && row.status === "DEAD")).toHaveLength(60);
});

it("legacy skip continuation advances past an entire poisoned page", async () => {
  const { GithubInstallationBindings } = await import("../../packages/broker/src/aws/github-credentials.js");
  const db = new FakeDynamoDb(); const bindings = new GithubInstallationBindings(db, "state");
  await bindings.backfill(async () => []);
  for (let i = 0; i < 26; i++) {
    const deliveryId = `550e8400-e29b-41d4-a716-${String(i + 400).padStart(12, "0")}`;
    await reserveGithubWebhookDelivery({ documentClient: db, tableName: "state", now: NOW, deliveryId, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64), event: EVENT });
    db.set({ ...db.get(`GITHUB_DELIVERY#${deliveryId}`, "META")!, companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
  }
  const { handler } = createBroker({ extra: { documentClient: db, githubBindings: bindings } });
  const first = JSON.parse((await handler({ source: "agentx.github-webhook-recovery" })).body) as { continuation?: string };
  expect(first).toMatchObject({ attempted: 0, skipped: 25, more: true });
  expect(first.continuation).toBeDefined();
  const second = JSON.parse((await handler({ source: "agentx.github-webhook-recovery", continuation: first.continuation })).body) as { more?: boolean };
  expect(second).toMatchObject({ attempted: 0, skipped: 1 }); expect(second.more).toBeUndefined();
});
