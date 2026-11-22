import { developerCharge } from "../../packages/broker/src/core/task-flow/keys.js";
import { randomUUID } from "node:crypto";
import { vi, type Mock, type MockInstance } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { createAdminBroker } from "./admin-broker.js";

export const READ_COMPANY = "org_corehost00000000000a";
export const READ_OTHER = "org_corehost00000000000b";
export const READ_AT = "2026-11-20T10:00:00.000Z";
export const READ_PERSON = ownerKeyForSubject("https://idp.example.test", "Ada");
export async function serverReadWorld() {
  const requestId = randomUUID(); const taskId = randomUUID(); const sessionId = randomUUID();
  const claims = { sub: READ_PERSON, sid: sessionId, amr: "oidc", env: "staging", azp: "read-web", aud: "read-web" };
  const authorization = `Bearer e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
  const channelMembers: Mock<DeveloperApiConfiguration["channelMembers"]> = vi.fn(async () => { throw new Error("remote identity I/O is forbidden in this fixture"); });
  const config: DeveloperApiConfiguration = {
    issuer: "https://api.example.test/v1/auth", env: "staging", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers,
    verifyAccessToken: vi.fn(async () => claims),
  };
  const { db, handler } = await createAdminBroker({ developer: config });
  config.companies = companyMembershipFromDynamo(db, "signin");
  const setMember = (personId = READ_PERSON, companyId = READ_COMPANY, role = "owner") => db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: READ_AT });
  setMember();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#read-web", entityType: "SIGN_IN_CLIENT", clientId: "read-web", name: "Website", audience: "read-web", redirectUris: ["https://example.test/callback"], loopback: false, secretHash: "f".repeat(64), fullAccess: true, webApp: true, installLevel: true, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: READ_AT, updatedBy: "admin" });
  db.set({ pk: `DEVELOPER#${READ_PERSON}`, sk: "META", developerId: READ_PERSON, provider: "oidc", issuer: "https://idp.example.test", subject: "Ada", displayName: "Ada", firstSignInAt: READ_AT, lastSignInAt: READ_AT, revoked: false });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, companyId: READ_COMPANY, installMethod: true, developerId: READ_PERSON, amr: "oidc", clientId: "read-web", administrator: true, startedAt: READ_AT, endsAt: 4_000_000_000 });
  const task = { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: READ_PERSON, provider: "oidc", developerName: "Ada", client: "web", project: "payments", companyId: READ_COMPANY, title: "Private task", workspaceId: randomUUID(), ownerKey: READ_PERSON, conversationId: randomUUID(), startingRevision: 1, charge: developerCharge({ companyId: READ_COMPANY, developerId: READ_PERSON }), shared: false, createdAt: READ_AT, updatedAt: READ_AT };
  db.set(task);
  db.set({ pk: `IDEMPOTENCY#${READ_PERSON}#DEVTASK`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", taskId, payloadHash: "f".repeat(64) });
  db.set({ pk: `TASK_ENGINE#${taskId}`, sk: "STAMP", entityType: "TASK_ENGINE", orgId: READ_COMPANY, taskId, coreEngine: { engine: "core", areas: { flow: "core", build: "workflow", merge: "workflow" }, flags: "on", stampedAt: READ_AT } });
  const identity = { developerId: READ_PERSON, name: "Ada", method: "oidc", issuer: "https://idp.example.test", subject: "Ada" };
  db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: READ_PERSON, name: "Ada", method: "oidc", role: "owner" }] });
  const personId = randomUUID();
  db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${READ_PERSON}`, schemaVersion: 1, personId, developerId: READ_PERSON, createdAt: READ_AT });
  db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...identity, createdAt: READ_AT });
  db.set({ ...orgProjectCatalogKey(READ_COMPANY, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  db.set({ ...projectRevisionKey(READ_COMPANY, "payments", 1), entityType: "PROJECT", definition: { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", developerTasks: { enabled: true }, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app", host: { kind: "github", installationId: 7 } }] } });
  db.set({ pk: `ORG#${READ_COMPANY}#MEMBER#${READ_PERSON}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
  const addWebPerson = (subject: string, role: string) => {
    const id = ownerKeyForSubject("https://idp.example.test", subject); const personId = randomUUID();
    setMember(id);
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", issuer: "https://idp.example.test", subject, displayName: subject, firstSignInAt: READ_AT, lastSignInAt: READ_AT, revoked: false });
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${id}`, schemaVersion: 1, personId, developerId: id, createdAt: READ_AT });
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: id, name: subject, method: "oidc", issuer: "https://idp.example.test", subject, createdAt: READ_AT });
    db.set({ pk: `ORG#${READ_COMPANY}#MEMBER#${id}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
    return { developerId: id, name: subject, method: "oidc", role };
  };
  const rawSend: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> = db.send.bind(db);
  const send: MockInstance<(command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>> = vi.spyOn(db, "send");
  const call = async (method: string, path: string, body?: unknown, auth = authorization, headers: Record<string, string> = {}) => {
    const [rawPath, rawQueryString] = path.split("?");
    const result = await handler({ rawPath, ...(rawQueryString === undefined ? {} : { rawQueryString }), headers: { ...headers, authorization: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "transport-different", http: { method } } });
    return { status: result.statusCode, headers: (result as { headers?: Record<string, string> }).headers ?? {}, body: JSON.parse(result.body) as Record<string, unknown> };
  };
  const start = () => call("GET", `/v1/dev/tasks/start-requests/${requestId}`);
  const addInstallation = (id = 7, extra: Record<string, unknown> = {}) => {
    db.set({ pk: `ORG#${READ_COMPANY}#GITHUB_INSTALLATIONS`, sk: `INSTALLATION#${id}`, entityType: "GITHUB_COMPANY_INSTALLATION", companyId: READ_COMPANY, installationId: id, accountLogin: "example", boundAt: READ_AT, boundBy: READ_PERSON });
    db.set({ pk: `GITHUB_INSTALLATION#${id}`, sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", companyId: READ_COMPANY, installationId: id, accountLogin: "example", boundAt: READ_AT, boundBy: READ_PERSON, ...extra });
  };
  const impact = () => call("POST", "/v1/dev/company/connections/impact", { provider: "github", operation: "disconnect", target: { installationId: 7 } });
  return { db, rawSend, addWebPerson, channelMembers, config, claims, call, start, impact, send, task, taskId, requestId, personId, setMember, addInstallation };
}
