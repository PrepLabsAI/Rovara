import { createHash } from "node:crypto";
import { AgentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_KEY_SCOPE, scopedProjectPk } from "../../packages/broker/src/e2e/legacy-key-scope.js";
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
      expect((await h.call("/v1/dev/access", "POST")).body).toBe(`{"developerId":"${PERSON}","displayName":"Test Person","nameChosen":false,"administrator":true,"projects":[{"name":"shared-project","access":"granted"}],"notices":[],"requestId":"company-test"}`);
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
  it("T3/T5 client repositories and project creation callbacks have no company argument", async () => {
    const h = harness(COMPANY_B.orgId);
    h.deps.clientRepositories = vi.fn(async () => []);
    expect((await h.call("/v1/dev/client/repositories")).statusCode).toBe(200);
    expect(h.deps.clientRepositories).toHaveBeenCalledExactlyOnceWith();
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

describe("merge-up 2 membership-resolved reads", () => {
  const path = `/v1/dev/tasks/${TASK}`;
  const reader = (company: string | undefined = COMPANY_A.orgId) => {
    const h = harness(company); h.project(company);
    h.db.set({ ...h.task(TASK, company), developerId: "e".repeat(64) });
    h.db.set({ pk: `DEVTASK#${TASK}`, sk: `READER#${PERSON}`, schemaVersion: 1, developerId: PERSON, role: "viewer", grantedBy: "e".repeat(64), grantedAt: TIME });
    return h;
  };
  it.each(["", "/events", "/readers"])("keeps the task company check on the shared-reader fallback %s", async (suffix) => {
    const h = reader();
    const own = await h.call(path + suffix);
    expect(own.statusCode).toBe(suffix === "/readers" ? 403 : 200);
    h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
    const foreign = await h.call(path + suffix);
    h.db.delete(`DEVTASK#${TASK}`, "META");
    expect(foreign).toEqual(await h.call(path + suffix));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(COMPANY_A.orgId);
  });
  it.each(["/events", "/readers"])("checks the owner's new read path %s", async (suffix) => {
    const h = harness(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
    expect((await h.call(path + suffix)).statusCode).toBe(200);
    h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
    expect((await h.call(path + suffix)).statusCode).toBe(404);
    h.deps.companies = { companyOf: async () => { throw new Error(COMPANY_A.canary); } };
    const failed = await h.call(path + suffix);
    expect(failed.statusCode).toBe(401); expect(failed.body).not.toContain(COMPANY_A.canary);
  });
  it.each([undefined, null, {}, 1, "bad-company"])("fails closed on invalid membership for the new reads %j", async (company) => {
    const h = reader(); h.deps.companies = { companyOf: async () => company as string | undefined };
    for (const suffix of ["/events", "/readers"]) expect((await h.call(path + suffix)).statusCode).toBe(401);
  });
  it("checks the linking project catalog and preserves the chosen-name access answer", async () => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId, true);
    h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: true });
    h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, displayNameChosen: true });
    const request = { method: "GET", path: "/v1/dev/projects", headers: { authorization: h.bearer }, requestId: "test" };
    const url = new URL(request.path, "https://broker.example.test");
    expect(await routeLinkingRequest(h.deps, request, url)).toMatchObject({ projects: [] });
    h.project(COMPANY_B.orgId, true);
    expect(await routeLinkingRequest(h.deps, request, url)).toMatchObject({ projects: [{ name: "shared-project" }] });
    expect(JSON.parse((await h.call("/v1/dev/access", "POST")).body)).toMatchObject({ nameChosen: true, projects: [{ name: "shared-project", access: "administrator" }] });
    h.deps.companies = { companyOf: async () => { throw new Error(COMPANY_A.canary); } };
    await expect(routeLinkingRequest(h.deps, request, url)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it("full-access tokens retain the original project/task company gates", async () => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId, true); h.task(TASK, COMPANY_A.orgId);
    h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: true });
    const get = (url: string) => h.read(url, { headers: { authorization: h.bearer } });
    expect(parsed(await get("/v1/dev/projects")).projects).toEqual([]);
    expect((await get(path)).statusCode).toBe(404);
    h.deps.companies = { companyOf: async () => COMPANY_A.orgId };
    expect(parsed(await get("/v1/dev/projects")).projects).toHaveLength(1);
    expect((await get(path)).statusCode).toBe(200);
  });
  it("legacy shared-reader event and reader-list bytes stay unchanged with companies absent", async () => {
    const h = reader(undefined); delete h.deps.companies;
    expect((await h.call(path + "/events")).body).toBe('{"events":[],"requestId":"company-test"}');
    const owner = harness(); owner.task();
    expect((await owner.call(path + "/readers")).body).toBe('{"readers":[],"requestId":"company-test"}');
  });
});

describe("merge-up 2 named T-lane known gaps (not isolation claims)", () => {
  it.each(["PUT", "DELETE"])("T2/T3 task-reader %s writer still has no membership/writer fence", async (method) => {
    const h = harness(COMPANY_B.orgId); h.project(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
    const id = "e".repeat(64);
    h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: "Reader" });
    h.db.set({ pk: `MEMBER#${id}`, sk: "PROJECT#shared-project", projectName: "shared-project", role: "developer" });
    expect((await h.call(`/v1/dev/tasks/${TASK}/readers/${id}`, method, { requestId: TASK, role: "viewer" })).statusCode).toBe(200);
    expect(h.companyOf).not.toHaveBeenCalled();
  });
  it("T2/T3 linking workspace catalog is still bound to person rather than company", async () => {
    const h = harness(COMPANY_B.orgId);
    h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: true });
    h.project(COMPANY_A.orgId);
    const request = { method: "GET", path: "/v1/dev/workspaces", headers: { authorization: h.bearer }, requestId: "test" };
    expect(await routeLinkingRequest(h.deps, request, new URL(request.path, "https://broker.example.test"))).toMatchObject({ projects: [{ name: "shared-project" }], workspaces: [] });
    expect(h.companyOf).not.toHaveBeenCalled();
  });
});

// These helper/metadata limitations are deliberately conservative inventory entries, not isolation passes.
it("known gap T1: scopedProjectPk legacy selector relies on its caller for company admission", () => {
  expect(scopedProjectPk(COMPANY_A.orgId, "shared-project")).not.toBe(scopedProjectPk(COMPANY_B.orgId, "shared-project"));
  expect(scopedProjectPk(LEGACY_KEY_SCOPE, "shared-project")).toBe("PROJECT#shared-project");
});

it("known gap T2/T3: reader list returns person/project grants without recipient company membership", async () => {
  const h = harness(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
  const other = "e".repeat(64);
  const companyOf = vi.fn(async (personId: string) => personId === PERSON ? COMPANY_A.orgId : COMPANY_B.orgId);
  h.deps.companies = { companyOf };
  h.db.set({ pk: `DEVELOPER#${other}`, sk: "META", displayName: "Foreign reader" });
  h.db.set({ pk: `MEMBER#${other}`, sk: "PROJECT#shared-project", projectName: "shared-project", role: "developer" });
  h.db.set({ pk: `DEVTASK#${TASK}`, sk: `READER#${other}`, schemaVersion: 1, developerId: other, role: "viewer", grantedBy: PERSON, grantedAt: TIME });
  expect(JSON.parse((await h.call(`/v1/dev/tasks/${TASK}/readers`)).body)).toMatchObject({ readers: [{ name: "Foreign reader", projectMember: true }] });
  expect(companyOf).toHaveBeenCalledExactlyOnceWith(PERSON);
});

it("merge-up 2 bounds the linking catalog and reader list as whole calls", async () => {
  const h = harness(COMPANY_A.orgId); h.project(COMPANY_A.orgId); h.task(TASK, COMPANY_A.orgId);
  h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: true });
  for (let i = 0; i < 2_001; i++) {
    h.db.set({ pk: `MEMBER#${PERSON}`, sk: `PROJECT#p-${i}`, projectName: `p-${i}`, role: "developer" });
    const developerId = i.toString(16).padStart(64, "0");
    h.db.set({ pk: `DEVTASK#${TASK}`, sk: `READER#${developerId}`, developerId, role: "viewer", grantedAt: TIME });
  }
  const request = { method: "GET", path: "/v1/dev/projects", headers: { authorization: h.bearer }, requestId: "test" };
  await expect(routeLinkingRequest(h.deps, request, new URL(request.path, "https://broker.example.test"))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: company read limit exceeded" });
  // Native caller for the reader list; no full-access session is substituted by the helper.
  h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: false });
  const response = await h.call(`/v1/dev/tasks/${TASK}/readers`);
  expect(response.statusCode).toBe(400);
  expect(response.body).toContain('"message":"company read limit exceeded"');
  expect(response.body).not.toContain('"readers"');
});

it("merge-up 2 checks the linking deadline after the last provider read", async () => {
  const h = harness(COMPANY_A.orgId); h.project(COMPANY_A.orgId);
  h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, fullAccess: true });
  h.db.set({ pk: "SLACK_BINDING#T0SHARED", sk: "CHANNEL#C0SHARED", teamId: "T0SHARED", channelId: "C0SHARED", projectName: "shared-project", updatedAt: TIME });
  let elapsed = 0; let slow = false;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
  h.deps.developer.channelInfo = vi.fn(async () => { if (slow) elapsed = 10_001; return { ok: true as const, channels: [] }; });
  const request = { method: "GET", path: "/v1/dev/projects", headers: { authorization: h.bearer }, requestId: "test" };
  const call = () => routeLinkingRequest(h.deps, request, new URL(request.path, "https://broker.example.test"));
  try {
    expect(await call()).toMatchObject({ projects: [{ name: "shared-project" }] });
    slow = true;
    await expect(call()).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: company read limit exceeded" });
    expect(h.deps.developer.channelInfo).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});
