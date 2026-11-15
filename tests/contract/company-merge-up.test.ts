import { createHash } from "node:crypto";
import { AgentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { routeLinkingRequest } from "../../packages/broker/src/aws/developer-routes.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyRouteHarness, PERSON, TASK, TIME } from "../support/company-route-harness.js";

const projectPath = "/v1/dev/client/projects/shared-project";
const taskPaths = ["messages", "comments", "diff?repository=api&number=1"].map((part) => `/v1/dev/tasks/${TASK}/${part}`);
function harness(companyId?: string) {
  const h = companyRouteHarness();
  h.deps.developer.clientRoutes = true;
  h.claims.azp = "web-app";
  h.claims.amr = "oidc";
  h.claims.scope = "projects:create projects:members";
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app", amr: "oidc", administrator: true });
  h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, provider: "oidc" });
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web", audience: "web-app", redirectUris: ["https://web.example.test/callback"], loopback: false, scopes: ["projects:create", "projects:members"], createdAt: TIME, updatedAt: TIME, updatedBy: "test" });
  const bearer = `Bearer ${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ azp: "web-app" })).toString('base64url')}.test`;
  const companyOf = vi.fn(async () => companyId);
  if (companyId !== undefined) h.deps.companies = { companyOf };
  h.db.set({ ...h.db.get("SESSION#session", "META")!, pk: "SESSION#native", clientId: undefined });
  const call = (path = projectPath, method = "GET", body?: unknown) => {
    if (path.startsWith("/v1/dev/tasks/")) h.claims.sid = "native";
    return h.read(path, { method, headers: { authorization: bearer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const project = (company?: unknown, administrator = false) => {
    h.project(company);
    const row = h.db.get("PROJECT#shared-project", "REV#000000000001")!;
    h.db.set({ ...row, definition: { name: "shared-project", revision: 1, repositories: [{ name: "api", url: "https://github.com/example/api.git", defaultBranch: "main" }] } });
    if (administrator) h.db.set({ pk: `MEMBER#${PERSON}`, sk: "PROJECT#shared-project", projectName: "shared-project", role: "administrator" });
  };
  return { ...h, call, project, bearer, companyOf };
}
const parsed = (response: { body: string }) => JSON.parse(response.body) as { projects: unknown[]; repositories: unknown[] };

describe("merge-up membership-resolved reads", () => {
  it.each([false, true])("filters both grant and administrator project access (admin=%s)", async (administrator) => {
    const h = harness(COMPANY_B.orgId);
    const missing = await h.call();
    h.project(COMPANY_A.orgId, administrator);
    expect(await h.call()).toEqual(missing);
    expect(parsed(await h.call("/v1/dev/access", "POST")).projects).toEqual([]);
    h.project(COMPANY_B.orgId, administrator);
    expect((await h.call()).statusCode).toBe(200);
    expect(parsed(await h.call("/v1/dev/access", "POST")).projects).toHaveLength(1);
  });
  it("resolves membership once after client authentication and ignores token/body/query hints", async () => {
    const h = harness(COMPANY_A.orgId); h.project(COMPANY_A.orgId);
    h.claims.companyId = COMPANY_B.orgId;
    expect((await h.call(`${projectPath}?companyId=${COMPANY_B.orgId}`, "GET", { companyId: COMPANY_B.orgId })).statusCode).toBe(200);
    expect(h.companyOf).toHaveBeenCalledExactlyOnceWith(PERSON);
    h.claims.sid = "missing";
    expect((await h.call()).statusCode).toBe(401);
    expect(h.companyOf).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, 1, {}, "", "canary-membership"])("fails closed for supplied invalid membership %j", async (value) => {
    const h = harness(); h.project(); h.task();
    h.deps.companies = { companyOf: async () => value as string | undefined };
    for (const [path, method] of [[projectPath, "GET"], ["/v1/dev/access", "POST"], ...taskPaths.map((path) => [path, "GET"])] as const) {
      const response = await h.call(path, method);
      expect(response.statusCode, path).toBe(401);
      expect(response.body).toBe(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended; run agentx login <url> again" }, requestId: "company-test" }));
    }
  });
  it("hides thrown membership causes on all new checked routes", async () => {
    const h = harness(); h.project(); h.task();
    h.deps.companies = { companyOf: async () => { throw new Error(COMPANY_A.canary); } };
    for (const [path, method] of [[projectPath, "GET"], ["/v1/dev/access", "POST"], ...taskPaths.map((path) => [path, "GET"])] as const) {
      const response = await h.call(path, method);
      expect(response.statusCode).toBe(401); expect(response.body).not.toContain(COMPANY_A.canary);
    }
  });
  it.each([null, {}, 3, "bad-company"])("hides malformed stored project company %j", async (company) => {
    const h = harness(IMPLICIT_COMPANY_ID); const missing = await h.call();
    h.project(company, true);
    expect(await h.call()).toEqual(missing);
    expect(parsed(await h.call("/v1/dev/access", "POST")).projects).toEqual([]);
  });
  it("checks the final project revision even if it changes after access was read", async () => {
    const h = harness(COMPANY_A.orgId); h.project(COMPANY_A.orgId);
    const send = h.deps.documentClient.send.bind(h.deps.documentClient);
    h.deps.documentClient = { send: async (command: unknown) => {
      const input = (command as { input: { ProjectionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (input.ExpressionAttributeValues?.[":rev"] === "REV#" && input.ProjectionExpression === undefined) h.project(COMPANY_B.orgId);
      return send(command);
    } };
    expect((await h.call()).statusCode).toBe(404);
  });
  it("bounds all access-list and detail reads as one call, without a partial answer", async () => {
    const h = harness(COMPANY_A.orgId); h.project(COMPANY_A.orgId);
    for (let i = 0; i < 2_001; i++) h.db.set({ pk: `MEMBER#${PERSON}`, sk: `PROJECT#p-${i}`, projectName: `p-${i}`, role: "administrator" });
    for (const [path, method] of [[projectPath, "GET"], ["/v1/dev/access", "POST"]] as const) {
      const response = await h.call(path, method);
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('"message":"company read limit exceeded"');
      expect(response.body).not.toContain("repositories");
    }
  });
  it("uses the same company check through the linking dispatcher", async () => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId, true);
    await expect(routeLinkingRequest(h.deps, { method: "GET", path: projectPath, headers: { authorization: h.bearer }, requestId: "test" }, new URL(projectPath, "https://broker.example.test"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("scopes the Basic client access-check form by the requested person's membership", async () => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId, true);
    const secret = ["generated", "test", "secret"].join("-");
    h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, secretHash: createHash("sha256").update(secret).digest("hex") });
    const response = await h.read("/v1/dev/access", { method: "POST", headers: { authorization: `Basic ${Buffer.from(`web-app:${secret}`).toString("base64")}` }, body: JSON.stringify({ developerId: PERSON }) });
    expect(response.statusCode).toBe(200); expect(parsed(response).projects).toEqual([]);
    expect(h.companyOf).toHaveBeenCalledExactlyOnceWith(PERSON);
  });
  it.each(taskPaths)("forwards resolved company to %s and hides foreign tasks before payload reads", async (path) => {
    const h = harness(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
    const own = await h.call(path);
    expect(own.statusCode).toBe(path.includes("diff?") ? 404 : 200);
    if (path.includes("diff?")) expect(own.body).toContain("no such pull request on this task");
    h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
    const foreign = await h.call(path);
    const missing = await h.call(path.replace(TASK, "22222222-2222-4222-8222-222222222222"));
    expect(foreign).toEqual(missing); expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(COMPANY_A.orgId);
  });
  it("pins absent-dependency legacy bytes for project/access and empty task reads", async () => {
    for (const company of [undefined, IMPLICIT_COMPANY_ID]) {
      const h = harness(company); h.project(); h.task();
      expect((await h.call()).body).toBe('{"name":"shared-project","latestRevision":1,"access":"granted","repositories":[{"name":"api","url":"https://github.com/example/api.git","defaultBranch":"main","fullName":"example/api"}],"requestId":"company-test"}');
      expect((await h.call("/v1/dev/access", "POST")).body).toBe(`{"developerId":"${PERSON}","displayName":"Test Person","administrator":true,"projects":[{"name":"shared-project","access":"granted"}],"notices":[],"requestId":"company-test"}`);
      expect((await h.call(taskPaths[0])).body).toBe('{"messages":[],"requestId":"company-test"}');
      expect((await h.call(taskPaths[1])).body).toBe('{"comments":[],"requestId":"company-test"}');
    }
  });
});

describe("named T-lane known gaps (not isolation claims)", () => {
  it("T2/T7 diff reads a workspace PR list without a company argument", async () => {
    const h = harness(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
    const pullRequests = vi.fn(async () => [{ repository: "api", number: 1, url: "https://github.com/foreign-canary/api/pull/1", state: "open" as const }]);
    h.deps.tasks = { ...h.deps.tasks!, pullRequests };
    const response = await h.call(taskPaths[2]);
    expect(pullRequests).toHaveBeenCalledExactlyOnceWith("shared-workspace");
    // The outer dispatcher currently supplies no diff provider; don't claim its future wiring is isolated.
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("foreign-canary");
  });
  it("T5 client callbacks receive the authenticated person for membership-bound AWS checks", async () => {
    const h = harness(COMPANY_B.orgId);
    h.deps.clientRepositories = vi.fn(async () => []);
    expect((await h.call("/v1/dev/client/repositories")).statusCode).toBe(200);
    expect(h.deps.clientRepositories).toHaveBeenCalledExactlyOnceWith(PERSON);
    h.deps.createClientProject = vi.fn(async () => { h.project(); return { name: "shared-project", latestRevision: 1 }; });
    await h.call("/v1/dev/client/projects", "POST", { repository: "example/api" });
    expect(h.deps.createClientProject).toHaveBeenCalledExactlyOnceWith(PERSON, { repository: "example/api" });
  });
  it.each(["GET", "PUT", "DELETE"])("T2/T3 client member %s still operates across company boundaries", async (method) => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId);
    h.db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", developerId: PERSON, displayName: "Test Person", revoked: false });
    expect((await h.call(`${projectPath}/members${method === "GET" ? "" : `/${PERSON}`}`, method)).statusCode).toBe(200);
  });
  it.each(["messages", "comments"])("T2 task POST %s does not resolve supplied membership", async (kind) => {
    const h = harness(); h.task();
    const companyOf = vi.fn(async () => { throw new AgentXError("AUTH_REQUIRED", "membership-canary", 401); });
    h.deps.companies = { companyOf };
    const response = await h.call(`/v1/dev/tasks/${TASK}/${kind}`, "POST", kind === "messages"
      ? { requestId: "gap", kind: "steer", text: "test message" }
      : { requestId: "gap", document: "plan", text: "test comment" });
    expect(response.statusCode).not.toBe(401);
    expect(response.body).not.toContain("membership-canary");
    expect(companyOf).not.toHaveBeenCalled();
  });
});
