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
async function registerClient(h: Awaited<ReturnType<typeof world>>, _options?: unknown) {
  void _options;
  const response = await h.call("/v1/dev/client/projects", { repository: "example/demo" });
  if (response.statusCode !== 200) throw new Error(response.body);
}
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
    githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) },
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
  // DEC 254zzz80: a named company's project is written in its own partition.
  expect(h.db.get(`ORG#${A}#PROJECT#demo`, "REV#000000000001")?.companyId).toBe(A);
  expect(h.db.get("PROJECT#demo", "REV#000000000001")).toBeUndefined();
  const foreign = await world(true, B);
  const refused = await foreign.call("/v1/dev/client/projects", { repository: "example/demo" });
  expect(refused.statusCode).toBe(400);
  expect((JSON.parse(refused.body) as { error: unknown }).error).toEqual({ code: "CONFIG_INVALID", message: "the GitHub App cannot access example/demo; install it on example with access to that repository" });
  expect(foreign.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
  expect(foreign.db.get("PROJECT#demo", "REV#000000000001")).toBeUndefined();
  expect(foreign.db.find((item) => String(item.pk).includes("#PROJECT#demo"))).toEqual([]);
  expect(foreign.db.get("GITHUB_INSTALLATION#77", "BINDING")?.companyId).toBe(A);
  foreign.extra.githubPullRequests.installationIdFor.mockResolvedValue(99);
  expect(await foreign.call("/v1/dev/client/projects", { repository: "example/demo" })).toEqual(refused);
  foreign.extra.githubPullRequests.installationIdFor.mockRejectedValue(new Error("private-canary"));
  expect(await foreign.call("/v1/dev/client/projects", { repository: "example/demo" })).toEqual(refused);
});
it("client creation refuses occupied names across foreign or malformed stored companies", async () => {
  const h = await world();
  await registerClient(h, { bind: false });
  const own = `ORG#${A}#PROJECT#demo`;
  expect(h.db.get(own, "REV#000000000001")?.companyId).toBe(A);
  for (const companyId of [B, null, "private-canary"]) {
    h.db.set({ ...h.db.get(own, "REV#000000000001")!, companyId });
    await expect(registerClient(h, { bind: false })).rejects.toThrow(/a project named demo already exists/);
    await expect(registerClient(h, { bind: false, revision: 2 })).rejects.toThrow(/a project named demo already exists/);
    expect(h.db.get(own, "REV#000000000002")).toBeUndefined();
    expect(h.db.get("PROJECT#demo", "REV#000000000002")).toBeUndefined();
  }
});
it("registration refuses a foreign installation before writing any project", async () => {
  const h = await world(true, B);
  await expect(registerClient(h, { bind: false })).rejects.toThrow(/the GitHub App cannot access example\/demo/);
  expect(h.db.get("PROJECT#demo", "REV#000000000001")).toBeUndefined();
  expect(h.db.find((item) => String(item.pk).includes("#PROJECT#demo"))).toEqual([]);
});
it("backfill validates a whole page before writes and refuses HTTP invocations", async () => {
  const h = await world(); h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  const page = vi.fn(async (): Promise<unknown> => ({ installations: [{ installationId: 99, accountLogin: "example" }, { installationId: -1, accountLogin: "private-canary" }], more: false }));
  const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: { page, get: async () => undefined } } });
  const event = { source: "agentx.github-binding-backfill" };
  const response = await handler(event);
  expect(response.statusCode).toBe(500); expect(response.body).not.toContain("private-canary");
  expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")).toBeUndefined();
  page.mockResolvedValue({ installations: [{ installationId: 99, accountLogin: "example" }], more: false });
  expect((await handler({ ...event, requestContext: { http: { method: "POST" } } })).statusCode).toBe(500);
  expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")).toBeUndefined();
  expect((await handler(event)).statusCode).toBe(200);
  const calls = page.mock.calls.length;
  expect((await handler(event)).statusCode).toBe(200); expect(page).toHaveBeenCalledTimes(calls);
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
  await registerClient(h, { bind: false });
  h.db.delete("GITHUB_INSTALLATION#77", "BINDING");
  await expect(registerClient(h, { bind: false })).rejects.toThrow(/cannot access example\/demo/);
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
  await expect(registerClient(race, { bind: false })).rejects.toThrow(/registered project not found/);
});

it("client creation refuses an occupied name even when the latest revision belongs to the caller", async () => {
  const h = await world();
  await registerClient(h, { bind: false });
  const first = h.db.get(`ORG#${A}#PROJECT#demo`, "REV#000000000001")!;
  h.db.set({ ...first, companyId: B });
  h.db.set({ ...first, sk: "REV#000000000002", companyId: A, definition: { ...(first.definition as object), revision: 2 } });
  await expect(registerClient(h, { bind: false })).rejects.toThrow(/a project named demo already exists/);
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


it("operator claim validates the installation, refuses every second claim and audits success", async () => {
  const h = await world();
  let lookups = 0;
  const extra = { ...h.extra, githubBindingInstallations: {
    get: async (id: number) => { lookups++; return id === 99 ? { installationId: 99, accountLogin: "checked-account" } : undefined; },
    page: async () => ({ installations: [], more: false }),
  } };
  const { handler } = createBroker({ extra });
  const invoke = (value: unknown) => handler(value);
  const event = { source: "agentx.github-binding-claim", installationId: 99, companyId: B };
  const audit = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const fixedBefore = await invoke({ ...event, installationId: 100 });
    for (const value of [{ ...event, requestContext: { http: { method: "POST" } } }, { ...event, operator: true },
      { ...event, companyId: "private-canary" }, { ...event, installationId: "99" }]) {
      const before = lookups;
      expect(await invoke(value)).toEqual(fixedBefore);
      expect(lookups).toBe(before);
      expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")).toBeUndefined();
    }
    expect((await invoke(event)).statusCode).toBe(200);
    expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")).toMatchObject({ companyId: B, accountLogin: "checked-account", boundBy: "operator-lambda" });
    expect(h.db.get("GITHUB_INSTALLATION#99", "AUDIT#CLAIM")).toMatchObject({ companyId: B, actor: "operator-lambda" });
    expect(audit.mock.calls.some(([line]) => String(line).includes('"event":"github.binding_claimed"'))).toBe(true);
    const fixed = await invoke({ ...event, installationId: 100 });
    expect(fixed.statusCode).toBe(403);
    for (const value of [event, { ...event, companyId: A }, { ...event, installationId: -1 }, { ...event, companyId: "private-canary" },
      { ...event, requestContext: { http: { method: "POST" } } }, { ...event, operator: true }, { ...event, installationId: "99" }]) {
      expect(await invoke(value)).toEqual(fixed);
    }
    expect(fixed.body).not.toMatch(/99|100|org_|private-canary|checked-account/);
  } finally { audit.mockRestore(); }
});

it("operator claim can reserve the pilot before backfill and backfill preserves it", async () => {
  const h = await world(); h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: {
    get: async () => ({ installationId: 99, accountLogin: "pilot" }),
    page: async () => ({ installations: [installation(99)], more: false }),
  } } });
  expect((await handler({ source: "agentx.github-binding-claim", installationId: 99, companyId: B })).statusCode).toBe(200);
  expect((await handler({ source: "agentx.github-binding-backfill" })).statusCode).toBe(200);
  expect(await h.bindings.ownerOf(99)).toBe(B);
});

it("backfill uses one validated installation page per call and returns a usable continuation", async () => {
  const h = await world(); h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  const page = vi.fn(async (n: number) => ({ installations: n === 1 ? Array.from({ length: 25 }, (_, i) => installation(100 + i)) : [installation(125)], more: n === 1 }));
  const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: { page, get: async () => undefined } } });
  const first = await handler({ source: "agentx.github-binding-backfill" });
  expect(first.statusCode).toBe(200); expect(JSON.parse(first.body)).toMatchObject({ more: true, continuation: 2 });
  expect(h.db.get("GITHUB_INSTALLATION_BINDING", "BACKFILL")).toBeUndefined();
  expect(page).toHaveBeenCalledExactlyOnceWith(1);
  expect(h.clientProjects.repositories).not.toHaveBeenCalled();
  expect(JSON.parse((await handler({ source: "agentx.github-binding-backfill", continuation: 2 })).body)).toMatchObject({ more: false });
  expect(await h.bindings.ownerOf(125)).toBe(IMPLICIT_COMPANY_ID);
});


it("legacy administrator registration has no checked developer identity and fails closed with bindings enabled", async () => {
  const h = await world();
  await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow(/AUTH_REQUIRED/);
  expect(h.companyOf).not.toHaveBeenCalled();
  expect(h.db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
});

it("backfill refuses skipped cursors and oversized invalid pages without sealing or capturing installations", async () => {
  const h = await world(); h.db.delete("GITHUB_INSTALLATION_BINDING", "BACKFILL");
  const page = vi.fn(async (): Promise<unknown> => ({ installations: Array.from({ length: 26 }, (_, i) => installation(100 + i)), more: false }));
  const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: { page, get: async () => undefined } } });
  expect((await handler({ source: "agentx.github-binding-backfill", continuation: 2 })).statusCode).toBe(500);
  expect(page).not.toHaveBeenCalled();
  expect((await handler({ source: "agentx.github-binding-backfill" })).statusCode).toBe(500);
  expect(h.db.get("GITHUB_INSTALLATION_BINDING", "BACKFILL")).toBeUndefined();
  expect(h.db.get("GITHUB_INSTALLATION#100", "BINDING")).toBeUndefined();
});


it("operator claim refuses a mismatched or unreadable GitHub installation before binding", async () => {
  const h = await world();
  for (const get of [async () => ({ installationId: 98, accountLogin: "private-canary" }),
    async () => ({ installationId: 99, accountLogin: null }), async () => { throw new Error("private-canary"); }]) {
    const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: { get, page: async () => ({ installations: [], more: false }) } } });
    const response = await handler({ source: "agentx.github-binding-claim", installationId: 99, companyId: B });
    expect(response.statusCode).toBe(403); expect(response.body).not.toContain("private-canary");
    expect(h.db.get("GITHUB_INSTALLATION#99", "BINDING")).toBeUndefined();
    expect(h.db.get("GITHUB_INSTALLATION#98", "BINDING")).toBeUndefined();
  }
});
