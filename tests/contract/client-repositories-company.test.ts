import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, type ClientRepositoriesResponse } from "@agentx/contracts";
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


// DEC 254zzz81 (CLIENT-ROUTES-BEFORE-ON 3): without the company GitHub bindings the App's installations cannot be filtered to a company. With a company layer, both repository reads refuse in fixed
// words (never the whole unfiltered list, never another company's account); with no company layer (one company, a Rovara administrator) they are as before.
it("refuses the repository list and picker when a company layer has no GitHub bindings to filter by, before any installation is read", async () => {
  // The company layer on, the Rovara administrator in the install's own (implicit) company: the one caller who reaches the list there.
  const h = await world(false, IMPLICIT_COMPANY_ID);
  // Both places a host gives the company layer: the deployed broker sets it on the sign-in configuration only (developer.companies); a test host may set it on the dependencies.
  const onDependencies = createBroker({ extra: { ...h.extra, companies: { companyOf: h.companyOf } } });
  const onSignIn = createBroker({ extra: { ...h.extra, linking: { ...h.deps.developer, companies: { companyOf: h.companyOf } } } });
  for (const [path, created] of [["/v1/dev/client/repositories", onDependencies], ["/v1/dev/client/repositories/available", onDependencies], ["/v1/dev/client/repositories", onSignIn], ["/v1/dev/client/repositories/available", onSignIn]] as const) {
    const refused = await h.call(path, undefined, created.handler);
    expect(refused.statusCode, path).not.toBe(200);
    expect(refused.body, path).toContain('"code":"GITHUB_NOT_CONNECTED"');
    expect(refused.body, path).not.toContain("account-88");
    expect(refused.body, path).not.toContain("private-canary");
  }
  expect(h.clientProjects.repositories).not.toHaveBeenCalled();
  // No company layer: the Rovara administrator's list is as before.
  const unchanged = await h.call();
  expect(unchanged.statusCode).toBe(200);
  expect((JSON.parse(unchanged.body) as { installations: unknown[] }).installations).toHaveLength(3);
});

// DEC 254zzz81 (CLIENT-ROUTES-BEFORE-ON 2): a sign-in client's project create registers with the registration preflight ON, as every other registration does (it had `preflight: false`).
it("registers every client-created project with the registration preflight on", () => {
  const source = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
  const start = source.indexOf("function clientProjectRouteDependencies(");
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end);
  expect(start).toBeGreaterThan(0);
  expect(body.match(/registerProject\(/gu)).toHaveLength(2);
  expect(body.match(/preflight: true/gu)).toHaveLength(2);
  expect(body).not.toContain("preflight: false");
});

it("logs an operator event's refusal reason without putting it in the answer", async () => {
  const h = await world(false);
  const { handler } = createBroker({ extra: { ...h.extra, githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) } } });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const refused = await handler({ source: "agentx.github-binding-claim", installationId: 555, companyId: B });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain("reason");
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes("github.binding_claim_refused") && line.includes("\"reason\""))).toBe(true);
  } finally { log.mockRestore(); }
});
