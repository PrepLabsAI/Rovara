import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { agentXError, IMPLICIT_COMPANY_ID, type ClientRepositoriesResponse } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { createBroker, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const installation = (id: number) => ({ installationId: id, accountLogin: `account-${id}`, accountType: "Organization" as const, repositorySelection: "selected" as const, status: "active" as const, repositories: [{ fullName: "example/demo", githubRepositoryId: 42, private: true, defaultBranch: "main" }] });
beforeAll(loadSlackBroker);
async function world(enabled = true, company: string = A, mode: "developer" | "linking" = "linking") {
  const h = companyRouteHarness();
  const bindings = new GithubInstallationBindings(h.db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(A, 77, "account-77", "operator");
  await bindings.claim(B, 88, "private-canary", "operator");
  h.deps.developer.clientRoutes = true;
  h.claims.azp = "web-app"; h.claims.amr = "oidc"; h.claims.scope = "projects:create";
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app", amr: "oidc", administrator: true, endsAt: 4_000_000_000 });
  h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, provider: "oidc" });
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web", audience: "web-app", redirectUris: ["https://web.example.test/callback"], loopback: false, scopes: ["projects:create"], createdAt: TIME, updatedAt: TIME, updatedBy: "test" });
  const companyOf = vi.fn(async (): Promise<string | undefined> => company);
  const listed = [installation(77), installation(88), installation(99)];
  const clientProjects = { credentialRef: "github-app", repositories: vi.fn(async (): Promise<ClientRepositoriesResponse["installations"]> => listed),
    repositoryDefaults: vi.fn(async () => ({ owner: "example", name: "demo", defaultBranch: "main" })),
    workerBinding: async () => ({ deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" }),
  };
  const extra = { documentClient: h.db, [mode]: h.deps.developer, clientProjects,
    ...(enabled ? { companies: { companyOf }, githubBindings: bindings } : {}),
    githubPullRequests: { installationIdFor: vi.fn(async () => 77) },
  };
  const broker = createBroker({ extra });
  const token = `Bearer ${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ azp: "web-app" })).toString('base64url')}.test`;
  const call = (path = "/v1/dev/client/repositories", body?: unknown, handler = broker.handler) => handler({ rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { authorization: token, "x-company": B }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "golden", http: { method: body === undefined ? "GET" : "POST" } } });
  return { ...h, ...broker, db: h.db, bindings, companyOf, clientProjects, extra, call };
}
it.each(["developer", "linking"] as const)("filters real client repositories using membership through %s", async (mode) => {
  const h = await world(true, A, mode); h.claims.org = B; h.claims.companyId = B;
  const response = await h.call(`/v1/dev/client/repositories?org=${B}&companyId=${B}`);
  expect(response.statusCode).toBe(200);
  expect((JSON.parse(response.body) as { installations: unknown }).installations).toEqual([installation(77)]);
  expect(h.companyOf).toHaveBeenCalledExactlyOnceWith(PERSON);
  h.companyOf.mockResolvedValue(B);
  expect((JSON.parse((await h.call()).body) as { installations: unknown }).installations).toEqual([installation(88)]);
});
it("fails closed on missing, malformed or throwing membership before provider reads", async () => {
  const h = await world();
  for (const value of [undefined, null, 1, {}, "private-canary"]) {
    h.companyOf.mockResolvedValue(value as string);
    for (const [path, body] of [["/v1/dev/client/repositories", undefined], ["/v1/dev/client/projects", { repository: "example/demo" }]] as const) {
      const response = await h.call(path, body);
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain('"message":"your AgentX sign-in has ended; run agentx login <url> again"');
      expect(response.body).not.toContain("private-canary");
    }
  }
  h.companyOf.mockRejectedValue(new Error("private-canary"));
  expect((await h.call()).statusCode).toBe(401);
  expect(h.clientProjects.repositories).not.toHaveBeenCalled();
  expect(h.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
});
it("requires operator binding before repository defaults/token work and stores the resolved company", async () => {
  const h = await world();
  const response = await h.call("/v1/dev/client/projects", { repository: "example/demo" });
  expect(response.statusCode).toBe(200);
  expect(h.db.get("PROJECT#demo", "REV#000000000001")?.companyId).toBe(A);
  const foreign = await world(true, B);
  const refused = await foreign.call("/v1/dev/client/projects", { repository: "example/demo" });
  expect(refused.statusCode).toBe(400);
  expect((JSON.parse(refused.body) as { error: unknown }).error).toEqual({ code: "CONFIG_INVALID", message: "the GitHub App cannot access example/demo; install it on example with access to that repository" });
  expect(foreign.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
  expect(foreign.db.get("PROJECT#demo", "REV#000000000001")).toBeUndefined();
  expect(foreign.db.get("GITHUB_INSTALLATION#77", "BINDING")?.companyId).toBe(A);
  foreign.extra.githubPullRequests.installationIdFor.mockResolvedValue(99);
  expect(await foreign.call("/v1/dev/client/projects", { repository: "example/demo" })).toEqual(refused);
  foreign.extra.githubPullRequests.installationIdFor.mockRejectedValue(new Error("private-canary"));
  expect(await foreign.call("/v1/dev/client/projects", { repository: "example/demo" })).toEqual(refused);
});
it("registration uses stored project company and refuses foreign or malformed revisions including duplicate registration", async () => {
  const h = await world();
  await registerSlackProject(h.handler, { bind: false });
  expect(h.db.get("PROJECT#payments", "REV#000000000001")?.companyId).toBe(A);
  for (const companyId of [B, null, "private-canary"]) {
    h.db.set({ ...h.db.get("PROJECT#payments", "REV#000000000001")!, companyId });
    await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow(/registered project not found/);
    await expect(registerSlackProject(h.handler, { bind: false, revision: 2 })).rejects.toThrow(/registered project not found/);
    expect(h.db.get("PROJECT#payments", "REV#000000000002")).toBeUndefined();
  }
});
it("registration refuses a foreign installation before writing any project", async () => {
  const h = await world(true, B);
  await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow(/the GitHub App cannot access example\/demo/);
  expect(h.db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
});
it("backfill event is operator-only, bounded, idempotent and never seals a possibly truncated page", async () => {
  const h = await world(); h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  h.clientProjects.repositories.mockResolvedValue([installation(99)]);
  const event = { source: "agentx.github-binding-backfill" };
  const response = await h.handler(event);
  expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toMatchObject({ more: false });
  expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")?.companyId).toBe(IMPLICIT_COMPANY_ID);
  await h.handler(event); expect(h.clientProjects.repositories).toHaveBeenCalledTimes(1);
  h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  h.clientProjects.repositories.mockResolvedValue(Array.from({ length: 100 }, (_, i) => installation(100 + i)));
  expect(JSON.parse((await h.handler(event)).body)).toMatchObject({ more: true });
  expect(h.db.get("GITHUB_INSTALLATION_BINDING", "BACKFILL")).toBeUndefined();
  h.clientProjects.repositories.mockRejectedValue(new Error("private-canary"));
  const failed = await h.handler(event); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain("private-canary");
});
it("pins the absent-dependency repositories response bytes", async () => {
  const h = await world(false); h.clientProjects.repositories.mockResolvedValue([installation(77)]);
  expect(JSON.stringify(await h.call()) + "\n").toBe(readFileSync("tests/fixtures/github-company-goldens/client-repositories-legacy.json", "utf8"));
});

it("pins legacy create and missing-field bytes, including the implicit-company enabled path", async () => {
  const check = (name: string, result: unknown) => {
    const path = `tests/fixtures/github-company-goldens/${name}.json`;
    const bytes = JSON.stringify(result) + "\n";
    expect(bytes).toBe(readFileSync(path, "utf8"));
  };
  const h = await world(false);
  check("client-create-legacy", await h.call("/v1/dev/client/projects", { repository: "example/demo" }));
  check("client-missing-field-legacy", await h.call("/v1/dev/client/projects", {}));
  {
    const scoped = await world(true, IMPLICIT_COMPANY_ID);
    scoped.db.delete("GITHUB_INSTALLATION#77", "BINDING");
    scoped.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
    await scoped.bindings.backfill(async () => [{ installationId: 77, accountLogin: "account-77" }]);
    check("client-create-legacy", await scoped.call("/v1/dev/client/projects", { repository: "example/demo" }));
    check("client-missing-field-legacy", await scoped.call("/v1/dev/client/projects", {}));
  }
});

it("refuses missing membership wiring and unreadable bindings without leaking causes", async () => {
  const h = await world();
  delete h.extra.companies;
  const unwired = createBroker({ extra: h.extra });
  expect((await h.call("/v1/dev/client/repositories", undefined, unwired.handler)).statusCode).toBe(401);
  expect(JSON.parse((await unwired.handler({ source: "agentx.github-binding-backfill" })).body)).toMatchObject({ more: false });
  h.db.set({ pk: "GITHUB_INSTALLATION#77", sk: "BINDING", companyId: "private-canary", entityType: "invalid" });
  const response = await h.call();
  expect(response.statusCode).toBe(403); expect(response.body).not.toContain("private-canary");
});
it("revalidates bindings on duplicate registration and the company of a concurrent winner", async () => {
  const h = await world();
  await registerSlackProject(h.handler, { bind: false });
  h.db.delete("GITHUB_INSTALLATION#77", "BINDING");
  await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow(/cannot access example\/demo/);
  const race = await world();
  const send = race.db.send.bind(race.db);
  race.db.send = async (command) => {
    const actions = (command.input.TransactItems ?? []) as Array<{ Put?: { Item?: Record<string, unknown> } }>;
    const project = actions.find(row => row.Put?.Item?.entityType === "PROJECT")?.Put?.Item;
    if (project !== undefined) {
      race.db.set({ ...project, companyId: B });
      throw Object.assign(new Error("conditional"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    }
    return send(command);
  };
  await expect(registerSlackProject(race.handler, { bind: false })).rejects.toThrow(/registered project not found/);
});

it("checks the exact stored revision even when the latest revision belongs to the caller", async () => {
  const h = await world();
  await registerSlackProject(h.handler, { bind: false });
  const first = h.db.get("PROJECT#payments", "REV#000000000001")!;
  h.db.set({ ...first, companyId: B });
  h.db.set({ ...first, sk: "REV#000000000002", companyId: A, definition: { ...(first.definition as object), revision: 2 } });
  await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow(/registered project not found/);
});

it.each([false, true])("pins active/suspended listing and uninstalled-repository bytes (enabled=%s)", async (enabled) => {
  const h = await world(enabled, IMPLICIT_COMPANY_ID);
  const rows = [installation(77), { ...installation(88), status: "suspended" as const, repositories: [] }];
  h.clientProjects.repositories.mockResolvedValue(rows);
  if (enabled) {
    for (const id of [77, 88]) h.db.delete(`GITHUB_INSTALLATION#${id}`, "BINDING");
    h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
    await h.bindings.backfill(async () => rows);
  }
  expect(JSON.stringify(await h.call()) + "\n").toBe(readFileSync("tests/fixtures/github-company-goldens/client-repositories-two-legacy.json", "utf8"));
  h.clientProjects.repositoryDefaults.mockRejectedValue(agentXError("CONFIG_INVALID", "the GitHub App cannot access example/demo; install it on example with access to that repository"));
  h.extra.githubPullRequests.installationIdFor.mockResolvedValue(99);
  expect(JSON.stringify(await h.call("/v1/dev/client/projects", { repository: "example/demo" })) + "\n").toBe(readFileSync("tests/fixtures/github-company-goldens/client-uninstalled-legacy.json", "utf8"));
});
