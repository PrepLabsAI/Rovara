// gh-bindings (batch 20): the hosted broker's client project routes (repository list, picker, creates) get the company GitHub bindings through
// `clientProjects.bindings` and the sign-in configuration's own membership reader, exactly as buildBrokerHandler wires them: no top-level
// `githubBindings` and no top-level `companies`. The staging shape: one installation bound to one company (backfill marker written), that
// company's owner, admin and member, and a legacy member of the implicit company; plus a second company with its own installation.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, type ClientRepositoriesResponse } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { REPOSITORIES_NOT_AVAILABLE } from "../../packages/broker/src/aws/client-project-create.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { createBroker, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const STAGING_COMPANY = "org_stagingshape00000000";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const STAGING_INSTALLATION = 700001;
const OTHER_INSTALLATION = 88;
const repo = (fullName: string, id: number) => ({ fullName, githubRepositoryId: id, private: true, defaultBranch: "main" });
const installation = (id: number, login: string, repositories: ReturnType<typeof repo>[]) =>
  ({ installationId: id, accountLogin: login, accountType: "Organization" as const, repositorySelection: "selected" as const, status: "active" as const, repositories });
const LISTED = [
  installation(STAGING_INSTALLATION, "acme-staging", [repo("acme-staging/web", 1), repo("acme-staging/docs", 2)]),
  installation(OTHER_INSTALLATION, "other-co", [repo("other-co/payroll", 3)]),
  installation(99, "unbound", [repo("unbound/x", 4)]),
];
const INSTALLATION_OF: Record<string, number> = { "acme-staging": STAGING_INSTALLATION, "other-co": OTHER_INSTALLATION, unbound: 99 };
const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/]+)\//.exec(url)![1]!;

beforeAll(loadSlackBroker);

type Role = "owner" | "admin" | "member";
async function hosted(options: { company?: string; role?: Role; administrator?: boolean; mode?: "developer" | "linking"; companyLayer?: boolean } = {}) {
  const h = companyRouteHarness();
  const bindings = new GithubInstallationBindings(h.db, "State");
  // Staging: the backfill marker is written, so an installation with no binding row belongs to nobody.
  await bindings.backfill(async () => []);
  await bindings.claim(STAGING_COMPANY, STAGING_INSTALLATION, "acme-staging", "operator-lambda");
  await bindings.claim(OTHER, OTHER_INSTALLATION, "other-co", "operator-lambda");
  // As the PR 19 tests sign in: the Rovara administrator by OIDC, a company owner/admin/member by Slack.
  // The install administrator signs in through the install's own OIDC: a session the sign-in server marked as the shared method, in their company.
  const amr = options.administrator === true ? "oidc" : "slack";
  const company = options.company ?? STAGING_COMPANY;
  const sharedMethod = amr === "oidc" && company !== IMPLICIT_COMPANY_ID ? { sessionId: "22222222-2222-4222-8222-222222222222", companyId: company, installMethod: true } : {};
  h.claims.azp = "web-app"; h.claims.amr = amr; h.claims.scope = "projects:create";
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app", amr, administrator: options.administrator ?? false, endsAt: 4_000_000_000, ...sharedMethod });
  h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, provider: "oidc" });
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web", audience: "web-app", redirectUris: ["https://web.example.test/callback"],
    loopback: false, scopes: ["projects:create"], createdAt: TIME, updatedAt: TIME, updatedBy: "test", installLevel: true });
  h.db.set({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, joinedAt: TIME, joinedVia: "import",
    companyId: company, role: options.role ?? "owner" });
  // Production's reader over the sign-in table, held only by the sign-in configuration (as buildBrokerHandler does with COMPANY_SIGNIN=enabled).
  const reader = companyMembershipFromDynamo(h.db, "SignIn");
  const membershipOf = vi.fn((personId: string) => reader.membershipOf!(personId));
  const companyOf = vi.fn((personId: string) => reader.companyOf(personId));
  if (options.companyLayer !== false) h.deps.developer.companies = { companyOf, membershipOf };
  const clientProjects = {
    credentialRef: "github-app",
    repositories: vi.fn(async (): Promise<ClientRepositoriesResponse["installations"]> => structuredClone(LISTED)),
    repositoryDefaults: vi.fn(async (url: string) => { const [, owner, name] = /^https:\/\/github\.com\/([^/]+)\/(.+)\.git$/.exec(url)!; return { owner: owner!, name: name!, defaultBranch: "main" }; }),
    repositoryInstallation: vi.fn(async (url: string) => ({ installationId: INSTALLATION_OF[ownerOf(url)]!, suspended: false })),
    workerBinding: async () => ({ deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" }),
    bindings,
  };
  // The deployed root's shape: NO top-level githubBindings or companies.
  const extra = { documentClient: h.db, [options.mode ?? "developer"]: h.deps.developer, clientProjects,
    githubPullRequests: { installationIdFor: vi.fn(async (url: string) => INSTALLATION_OF[ownerOf(url)]!) },
    githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) },
  };
  const broker = createBroker({ extra });
  const token = `Bearer ${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ azp: "web-app" })).toString("base64url")}.test`;
  const call = (path: string, body?: unknown) => broker.handler({ rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { authorization: token, "x-company": OTHER },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "hosted", http: { method: body === undefined ? "GET" : "POST" } } });
  return { ...h, bindings, clientProjects, extra, broker, call, membershipOf };
}
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const ids = (response: { body: string }) => (json(response)["installations"] as Array<{ installationId: number }>).map((row) => row.installationId);
const choiceNames = (response: { body: string }) => (json(response)["repositories"] as Array<{ fullName: string }>).map((row) => row.fullName);
const FORBIDDEN = { code: "FORBIDDEN", message: "only a Rovara administrator can create a project" };
const ROUTES = [["/v1/dev/client/repositories", undefined], ["/v1/dev/client/repositories/available", undefined],
  ["/v1/dev/client/projects", { repository: "acme-staging/web" }], ["/v1/dev/client/projects/bulk", { repositories: ["acme-staging/docs"] }]] as const;

describe("hosted client project routes with the company GitHub bindings", () => {
  it.each([["owner", "developer"], ["admin", "developer"], ["owner", "linking"]] as const)("the staging shape: a company %s (%s) lists, picks and creates from its own installation only", async (role, mode) => {
    const h = await hosted({ role, mode });
    const listed = await h.call("/v1/dev/client/repositories");
    expect(listed.statusCode).toBe(200);
    expect(ids(listed)).toEqual([STAGING_INSTALLATION]);
    const picker = await h.call("/v1/dev/client/repositories/available");
    expect(picker.statusCode).toBe(200);
    expect(choiceNames(picker)).toEqual(["acme-staging/docs", "acme-staging/web"]);
    const created = await h.call("/v1/dev/client/projects", { repository: "acme-staging/web" });
    expect(created.statusCode).toBe(200);
    const name = (json(created) as { name: string }).name;
    expect(h.db.get(`PROJECT#${name}`, "REV#000000000001")?.companyId).toBe(STAGING_COMPANY);
    const bulk = await h.call("/v1/dev/client/projects/bulk", { repositories: ["acme-staging/docs"] });
    expect(bulk.statusCode).toBe(200);
    expect((json(bulk)["results"] as Array<{ outcome: string }>).map((row) => row.outcome)).toEqual(["created"]);
  });

  it("another company's installation never shows and cannot be created from", async () => {
    const h = await hosted({ company: OTHER, role: "owner" });
    expect(ids(await h.call("/v1/dev/client/repositories"))).toEqual([OTHER_INSTALLATION]);
    expect(choiceNames(await h.call("/v1/dev/client/repositories/available"))).toEqual(["other-co/payroll"]);
    const refused = await h.call("/v1/dev/client/projects", { repository: "acme-staging/web" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).not.toContain(STAGING_COMPANY);
    expect(h.db.get("PROJECT#web", "REV#000000000001")).toBeUndefined();
    expect(h.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
    // And the other way round: the staging company sees nothing of the second company's.
    const staging = await hosted({ role: "owner" });
    expect(ids(await staging.call("/v1/dev/client/repositories"))).not.toContain(OTHER_INSTALLATION);
    expect((await staging.call("/v1/dev/client/projects", { repository: "other-co/payroll" })).statusCode).toBe(400);
    expect(staging.db.get("PROJECT#payroll", "REV#000000000001")).toBeUndefined();
  });

  it("the multi-repository and bulk creates refuse another company's repository and write nothing", async () => {
    const h = await hosted({ company: OTHER, role: "admin" });
    const many = await h.call("/v1/dev/client/projects", { repositories: ["other-co/payroll", "acme-staging/web"], name: "mixed" });
    expect(json(many)["error"]).toEqual({ code: "CONFIG_INVALID", message: REPOSITORIES_NOT_AVAILABLE });
    const bulk = await h.call("/v1/dev/client/projects/bulk", { repositories: ["acme-staging/docs"] });
    expect(JSON.stringify(json(bulk))).not.toContain("\"created\"");
    expect(bulk.body).not.toContain(STAGING_COMPANY);
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("PROJECT#"))).toEqual([]);
  });

  it("a revoked owner membership or a revoked sign-in cannot create", async () => {
    const revoked = await hosted({ role: "owner" });
    revoked.db.set({ ...revoked.db.get(`COMPANY_MEMBER#${PERSON}`, "COMPANY")!, revokedAt: TIME, revokedBy: "test" });
    // A removed membership ends the sign-in's company at once (the token check); a revoked sign-in record fails companyMayCreateProjects.
    expect(json(await revoked.call("/v1/dev/client/projects", { repository: "acme-staging/web" }))["error"]).toMatchObject({ code: "AUTH_REQUIRED" });
    const signedOut = await hosted({ role: "owner" });
    signedOut.db.set({ ...signedOut.db.get(`DEVELOPER#${PERSON}`, "META")!, revoked: true });
    expect(json(await signedOut.call("/v1/dev/client/projects", { repository: "acme-staging/web" }))["error"]).toEqual(FORBIDDEN);
    for (const h of [revoked, signedOut]) {
      expect(h.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("PROJECT#"))).toEqual([]);
      expect(h.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
    }
  });

  it("a company member cannot list, pick or create, and no provider read happens", async () => {
    const h = await hosted({ role: "member" });
    for (const [path, body] of ROUTES) {
      const response = await h.call(path, body);
      expect(response.statusCode).toBe(403);
      expect(json(response)["error"]).toEqual(FORBIDDEN);
    }
    expect(h.clientProjects.repositories).not.toHaveBeenCalled();
    expect(h.clientProjects.repositoryDefaults).not.toHaveBeenCalled();
  });

  it("the install administrator still lists and creates, filtered to their own company", async () => {
    const h = await hosted({ administrator: true, role: "member" });
    expect(ids(await h.call("/v1/dev/client/repositories"))).toEqual([STAGING_INSTALLATION]);
    const created = await h.call("/v1/dev/client/projects", { repository: "acme-staging/web" });
    expect(created.statusCode).toBe(200);
    expect(h.db.get("PROJECT#web", "REV#000000000001")?.companyId).toBe(STAGING_COMPANY);
    // The legacy member of the implicit company (staging's fourth row): the marker is written, so no installation is the implicit company's.
    const legacy = await hosted({ administrator: true, company: IMPLICIT_COMPANY_ID, role: "member" });
    expect(ids(await legacy.call("/v1/dev/client/repositories"))).toEqual([]);
    expect((await legacy.call("/v1/dev/client/projects", { repository: "acme-staging/web" })).statusCode).toBe(400);
  });

  it("a removed membership is refused at once, before any provider read", async () => {
    const h = await hosted({ administrator: true });
    h.db.set({ ...h.db.get(`COMPANY_MEMBER#${PERSON}`, "COMPANY")!, revokedAt: TIME, revokedBy: "test" });
    expect((await h.call("/v1/dev/client/repositories")).statusCode).toBe(401);
    expect(h.clientProjects.repositories).not.toHaveBeenCalled();
  });

  it("without a company layer nothing changes: the App's installations are listed as before and the bindings are not read", async () => {
    const h = await hosted({ administrator: true, companyLayer: false });
    const send = vi.spyOn(h.db, "send");
    expect(ids(await h.call("/v1/dev/client/repositories"))).toEqual([STAGING_INSTALLATION, OTHER_INSTALLATION, 99]);
    const bindingReads = send.mock.calls.filter(([command]) => JSON.stringify((command as { input?: unknown }).input ?? {}).includes("GITHUB_INSTALLATION"));
    expect(bindingReads).toEqual([]);
    // A create too: the administrator's legacy create from an installation bound to no company, unscoped as before.
    expect((await h.call("/v1/dev/client/projects", { repository: "unbound/x" })).statusCode).toBe(200);
    expect(h.db.get("PROJECT#x", "REV#000000000001")?.companyId).toBeUndefined();
  });

  it("only the client project routes get the bindings: the administrator's own project registration keeps its path", async () => {
    const h = await hosted({ administrator: true });
    // example/demo's installation (456 in the support's GitHub double) is bound to no company; registration through /v1/admin/projects does not check bindings.
    await registerSlackProject(h.broker.handler, { bind: false });
    expect(h.db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });
});

describe("the deployed broker's root wiring", () => {
  const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
  const root = broker.slice(broker.indexOf("function buildBrokerHandler("), broker.indexOf("type BrokerHandler = ReturnType<typeof createAwsBrokerHandler>;"));
  it("passes the State table's GitHub bindings to the client project routes", () => {
    const block = root.slice(root.indexOf("clientProjects: {"), root.indexOf("} } : {}),", root.indexOf("clientProjects: {")));
    expect(block).toContain("bindings: new GithubInstallationBindings(documentClient, requiredEnvironment(\"STATE_TABLE_NAME\"))");
    expect(broker).toMatch(/function clientProjectRouteDependencies\(brokerDependencies_: AwsBrokerDependencies\)[^\n]*\n\s*const dependencies = withClientGithubBindings\(brokerDependencies_\);/);
  });
  it("does not turn on the broker-wide bindings (webhooks, recovery, mints and admin registration keep their own switch)", () => {
    expect(root).not.toMatch(/^\s*githubBindings\s*:/m);
    expect(root).not.toMatch(/[{,]\s*githubBindings\s*:/);
  });
});
