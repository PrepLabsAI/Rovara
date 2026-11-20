// Guided onboarding PR 6: several repositories in one project, one project per repository (bulk), and the repository picker, with company
// isolation: two companies, each with its own GitHub installation; an unbound, a suspended and an unknown repository too.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey, type ClientRepositoriesResponse } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { REPOSITORIES_NOT_AVAILABLE } from "../../packages/broker/src/aws/client-project-create.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
/** Owner -> the installation GitHub says serves it, and whether it is suspended. ghost: GitHub knows no such repository. */
const LIVE: Record<string, { installationId: number; suspended: boolean }> = {
  "acme-a": { installationId: 77, suspended: false }, "acme-a2": { installationId: 78, suspended: false },
  "acme-b": { installationId: 88, suspended: false }, loose: { installationId: 99, suspended: false }, paused: { installationId: 66, suspended: true },
};
const repo = (fullName: string, id: number) => ({ fullName, githubRepositoryId: id, private: true, defaultBranch: "main" });
const installation = (id: number, login: string, repositories: ReturnType<typeof repo>[], status: "active" | "suspended" = "active") =>
  ({ installationId: id, accountLogin: login, accountType: "Organization" as const, repositorySelection: "selected" as const, status, repositories });
const LISTED = [
  installation(77, "acme-a", [repo("acme-a/web", 1), repo("acme-a/api", 2), repo("acme-a/docs", 3)]),
  installation(88, "acme-b", [repo("acme-b/secret", 4), repo("acme-b/web", 5)]),
  installation(99, "loose", [repo("loose/x", 6)]),
  installation(66, "paused", [], "suspended"),
];
const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/]+)\//.exec(url)![1]!;

beforeAll(loadSlackBroker);

/** Guided onboarding PR 19: a live company membership row, read by the production reader (the sign-in table). */
type Membership = { companyId: string; role: "owner" | "admin" | "member"; revokedAt?: string };
async function world(company: string = A, options: { live?: boolean; administrator?: boolean; membership?: Membership; bindings?: boolean; amr?: "oidc" | "slack" } = {}) {
  const h = companyRouteHarness();
  const bindings = new GithubInstallationBindings(h.db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(A, 77, "acme-a", "operator");
  await bindings.claim(A, 78, "acme-a2", "operator");
  await bindings.claim(A, 66, "paused", "operator");
  await bindings.claim(B, 88, "acme-b", "operator");
  const amr = options.amr ?? "oidc";
  h.claims.azp = "web-app"; h.claims.amr = amr; h.claims.scope = "projects:create";
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app", amr, administrator: options.administrator ?? true, endsAt: 4_000_000_000 });
  h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, provider: "oidc" });
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web", audience: "web-app", redirectUris: ["https://web.example.test/callback"], loopback: false, scopes: ["projects:create"], createdAt: TIME, updatedAt: TIME, updatedBy: "test",
    ...(options.membership === undefined ? {} : { installLevel: true }) });
  const companyOf = vi.fn(async (): Promise<string | undefined> => company);
  // PR 19: with a membership row, both the route (sign-in) and the create (isolation) read it live, through the production reader.
  const reader = companyMembershipFromDynamo(h.db, "SignIn");
  const membershipOf = vi.fn((personId: string) => reader.membershipOf!(personId));
  if (options.membership !== undefined) {
    h.db.set({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, joinedAt: TIME, ...options.membership });
    companyOf.mockImplementation(async () => (await membershipOf(PERSON))?.companyId);
    h.deps.developer.companies = { companyOf, membershipOf };
  }
  const repositoryInstallation = vi.fn(async (url: string) => {
    const found = LIVE[ownerOf(url)];
    if (found === undefined) throw new Error("ghost-canary");
    return found;
  });
  const clientProjects = {
    credentialRef: "github-app",
    repositories: vi.fn(async (): Promise<ClientRepositoriesResponse["installations"]> => structuredClone(LISTED)),
    repositoryDefaults: vi.fn(async (url: string) => { const [, owner, name] = /^https:\/\/github\.com\/([^/]+)\/(.+)\.git$/.exec(url)!; return { owner: owner!, name: name!, defaultBranch: "main" }; }),
    workerBinding: async () => ({ deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" }),
    ...(options.live === false ? {} : { repositoryInstallation }),
  };
  const extra = { documentClient: h.db, linking: h.deps.developer, clientProjects, companies: { companyOf, membershipOf }, ...(options.bindings === false ? {} : { githubBindings: bindings }),
    githubPullRequests: { installationIdFor: vi.fn(async (url: string) => { const found = LIVE[ownerOf(url)]; if (found === undefined) throw new Error("ghost-canary"); return found.installationId; }) },
    githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) },
  };
  const broker = createBroker({ extra });
  const token = `Bearer ${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ azp: "web-app" })).toString("base64url")}.test`;
  const call = (path: string, body?: unknown) => broker.handler({ rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: { authorization: token, "x-company": B },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "golden", http: { method: body === undefined ? "GET" : "POST" } } });
  // DEC 254zzz80: a named company's revisions are in its own partition (`ORG#<company>#PROJECT#<id>`).
  const projectRows = () => h.db.find((item) => typeof item.pk === "string" && (item.pk.startsWith("PROJECT#") || item.pk.includes("#PROJECT#") || item.pk === "PROJECT_CATALOG" || item.pk.includes("#PROJECT_CATALOG") || item.pk.startsWith("MEMBER#")));
  return { ...h, bindings, companyOf, membershipOf, clientProjects, repositoryInstallation, extra, call, projectRows };
}
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const REFUSED = { code: "CONFIG_INVALID", message: REPOSITORIES_NOT_AVAILABLE };

describe("one project from several repositories", () => {
  it("creates ONE project holding every repository, in the caller's company", async () => {
    const h = await world();
    const response = await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-a/api", "acme-a2/web"], setupCommands: ["npm ci"] });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toMatchObject({ name: "web", latestRevision: 1, access: "administrator" });
    const stored = h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")!;
    expect(stored.companyId).toBe(A);
    const definition = stored.definition as { repositories: Array<{ name: string; url: string; path: string }>; setup: Array<{ cwd: string; executable: string }> };
    expect(definition.repositories.map((entry) => [entry.name, entry.url, entry.path])).toEqual([
      ["web", "https://github.com/acme-a/web.git", "repo/web"], ["api", "https://github.com/acme-a/api.git", "repo/api"], ["web-2", "https://github.com/acme-a2/web.git", "repo/web-2"]]);
    expect(definition.setup).toEqual([expect.objectContaining({ cwd: "repo/web", executable: "npm" })]);
    expect(h.repositoryInstallation).toHaveBeenCalledTimes(3);
  });

  it("fails closed without the live lookup, and on malformed lookups", async () => {
    const h = await world(A, { live: false });
    expect(json(await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web"] }))).toEqual({ error: REFUSED, requestId: "golden" });
    const m = await world(A);
    for (const value of [null, {}, { installationId: 77 }, { installationId: "77", suspended: false }, { installationId: 0, suspended: false }, { installationId: 77, suspended: "no" }]) {
      m.repositoryInstallation.mockResolvedValueOnce(value as never);
      expect(json(await m.call("/v1/dev/client/projects", { repositories: ["acme-a/web"] }))).toEqual({ error: REFUSED, requestId: "golden" });
    }
    expect(m.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")).toBeUndefined(); expect(m.db.get(`PROJECT#web`, "REV#000000000001")).toBeUndefined();
  });

  it("refuses a repository GitHub's App cannot see in the same words, and a GitHub outage in fixed words", async () => {
    const h = await world();
    h.clientProjects.repositoryDefaults.mockRejectedValueOnce(Object.assign(new Error("acme-a/api canary"), { code: "NOT_FOUND" }));
    expect(json(await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-a/api"] }))).toEqual({ error: REFUSED, requestId: "golden" });
    h.clientProjects.repositoryDefaults.mockRejectedValueOnce(new Error("canary"));
    const outage = await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-a/api"] });
    expect(outage.statusCode).toBe(503);
    expect(outage.body).not.toContain("canary");
    expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#web`, "REV#000000000001")).toBeUndefined();
  });

  it("writes nothing when registration would start after the request's wall-clock limit", async () => {
    const h = await world();
    const real = Date.now.bind(Date);
    let skew = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    try {
      // Slow just before registration (after every budgeted read): only the request's own limit stops it.
      const binding = h.clientProjects.workerBinding;
      h.clientProjects.workerBinding = async () => { skew += 16_000; return binding(); };
      const late = await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-a/api"] });
      expect(late.statusCode).toBe(503);
      expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#web`, "REV#000000000001")).toBeUndefined();
      expect(json(await h.call("/v1/dev/client/projects/bulk", { repositories: ["acme-a/web"] })).results).toEqual([{ repository: "acme-a/web", outcome: "refused", reason: "unavailable" }]);
      expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#web`, "REV#000000000001")).toBeUndefined();
    } finally { now.mockRestore(); }
  });

  it("validates the body whole: 1 to 32, no repeats, not with repository, each owner/name", async () => {
    const h = await world();
    const many = Array.from({ length: 33 }, (_, index) => `acme-a/r${index}`);
    for (const body of [{ repositories: [] }, { repositories: many }, { repositories: ["acme-a/web", "ACME-A/WEB"] }, { repositories: ["acme-a/web", "acme-a/web.git"] }, { repositories: ["acme-a/web"], repository: "acme-a/web" },
      { repositories: ["not a repo"] }, { repositories: "acme-a/web" }, { repositories: ["acme-a/web"], companyId: A }]) {
      const response = await h.call("/v1/dev/client/projects", body);
      expect(response.statusCode).toBe(400);
      expect(json(response).error).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(h.repositoryInstallation).not.toHaveBeenCalled();
    expect((await h.call("/v1/dev/client/projects", { repositories: Array.from({ length: 32 }, (_, index) => `acme-a/r${index}`) })).statusCode).toBe(200);
    expect((h.db.get(`ORG#${A}#PROJECT#r0`, "REV#000000000001")!.definition as { repositories: unknown[] }).repositories).toHaveLength(32);
  });
});

describe("one project per repository (bulk)", () => {
  it("answers one row per repository, in order: created, or refused with a fixed reason", async () => {
    const h = await world();
    h.db.set({ pk: "PROJECT#docs", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "docs", revision: 1 } });
    const response = await h.call("/v1/dev/client/projects/bulk", { repositories: ["acme-a/web", "acme-b/secret", "loose/x", "paused/y", "ghost/z", "acme-a/api", "acme-a/docs"] });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ results: [
      { repository: "acme-a/web", outcome: "created", project: "web" },
      { repository: "acme-b/secret", outcome: "refused", reason: "not_available" },
      { repository: "loose/x", outcome: "refused", reason: "not_available" },
      { repository: "paused/y", outcome: "refused", reason: "not_available" },
      { repository: "ghost/z", outcome: "refused", reason: "not_available" },
      { repository: "acme-a/api", outcome: "created", project: "api" },
      { repository: "acme-a/docs", outcome: "refused", reason: "name_taken" },
    ], requestId: "golden" });
    expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")?.companyId).toBe(A);
    expect(h.db.get(`ORG#${A}#PROJECT#api`, "REV#000000000001")?.companyId).toBe(A);
    expect(h.db.get(`ORG#${A}#PROJECT#secret`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#secret`, "REV#000000000001")).toBeUndefined();
    expect(response.body).not.toContain("canary");
    expect(h.clientProjects.repositoryDefaults.mock.calls.map(([url]) => url).sort()).toEqual(["https://github.com/acme-a/api.git", "https://github.com/acme-a/docs.git", "https://github.com/acme-a/web.git"]);
  });

  it("caps the call at 32 repositories and validates it whole", async () => {
    const h = await world();
    for (const body of [{ repositories: Array.from({ length: 33 }, (_, index) => `acme-a/r${index}`) }, { repositories: [] }, { repositories: ["acme-a/web", "acme-a/WEB"] }, { repositories: ["acme-a/web"], name: "x" }]) {
      const response = await h.call("/v1/dev/client/projects/bulk", body);
      expect(response.statusCode).toBe(400);
    }
    expect(h.repositoryInstallation).not.toHaveBeenCalled();
    const full = json(await h.call("/v1/dev/client/projects/bulk", { repositories: Array.from({ length: 32 }, (_, index) => `acme-a/r${index}`) })).results as Array<{ outcome: string }>;
    expect(full.filter((row) => row.outcome === "created")).toHaveLength(32);
  });

});

describe("the repository picker", () => {
  async function withProjects() {
    const h = await world(A);
    expect((await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-a/api"], name: "storefront" })).statusCode).toBe(200);
    expect((await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web"] })).statusCode).toBe(200);
    // B's project holding A's repository (by URL), and a row in A's catalog whose project is B's: neither is shown to A.
    h.db.set({ ...orgProjectCatalogKey(B, "b-shadow"), entityType: "PROJECT_CATALOG", name: "b-shadow" });
    h.db.set({ pk: "PROJECT#b-shadow", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "b-shadow", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme-a/web.git" }] } });
    h.db.set({ ...orgProjectCatalogKey(A, "b-planted"), entityType: "PROJECT_CATALOG", name: "b-planted" });
    h.db.set({ pk: "PROJECT#b-planted", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "b-planted", revision: 1, repositories: [{ name: "docs", url: "https://github.com/acme-a/docs.git" }] } });
    return h;
  }

  it("ignores a catalog row from another partition, a revision naming another project, and refuses more than 500 projects whole", async () => {
    const h = await withProjects();
    h.db.set({ ...orgProjectCatalogKey(A, "renamed"), entityType: "PROJECT_CATALOG" });
    h.db.set({ pk: "PROJECT#renamed", sk: "REV#000000000001", entityType: "PROJECT", companyId: A, definition: { name: "other", revision: 1, repositories: [{ name: "docs", url: "https://github.com/acme-a/docs.git" }] } });
    const docs = (json(await h.call("/v1/dev/client/repositories/available")).repositories as Array<{ fullName: string; projects: string[] }>).find((row) => row.fullName === "acme-a/docs");
    expect(docs?.projects).toEqual([]);
    const query = h.db.send.bind(h.db);
    const spy = vi.spyOn(h.db, "send").mockImplementation(async (command: unknown) => {
      const answer = await query(command as never) as { Items?: Array<Record<string, unknown>> };
      const input = (command as { input?: { ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (input?.ExpressionAttributeValues?.[":pk"] === `ORG#${A}#PROJECT_CATALOG` && answer.Items !== undefined) answer.Items = answer.Items.map((item) => ({ ...item, pk: `ORG#${B}#PROJECT_CATALOG` }));
      return answer;
    });
    expect((await h.call("/v1/dev/client/repositories/available")).statusCode).toBe(503);
    spy.mockRestore();
    for (let index = 0; index < 501; index++) h.db.set({ ...orgProjectCatalogKey(A, `p${index}`), entityType: "PROJECT_CATALOG" });
    const many = await h.call("/v1/dev/client/repositories/available");
    expect(many.statusCode).toBe(503);
  });

  it("searches and pages, with a page cap", async () => {
    const h = await withProjects();
    expect((json(await h.call("/v1/dev/client/repositories/available?q=AP")).repositories as Array<{ fullName: string }>).map((row) => row.fullName)).toEqual(["acme-a/api"]);
    const first = json(await h.call("/v1/dev/client/repositories/available?limit=2"));
    expect((first.repositories as Array<{ fullName: string }>).map((row) => row.fullName)).toEqual(["acme-a/api", "acme-a/docs"]);
    expect(first.next).toBe("acme-a/docs");
    const second = json(await h.call("/v1/dev/client/repositories/available?limit=2&after=acme-a/docs"));
    expect((second.repositories as Array<{ fullName: string }>).map((row) => row.fullName)).toEqual(["acme-a/web"]);
    expect(second.next).toBeUndefined();
    for (const query of ["limit=101", "limit=0", "q=%3Cscript%3E", "other=1", "q=a&q=b", "after=x"]) {
      const response = await h.call(`/v1/dev/client/repositories/available?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("script");
    }
  });

});

describe("who may create", () => {
  it("keeps today's rule: only a Rovara administrator, on every new route", async () => {
    const h = await world(A, { administrator: false });
    for (const [path, body] of [["/v1/dev/client/projects", { repositories: ["acme-a/web"] }], ["/v1/dev/client/projects/bulk", { repositories: ["acme-a/web"] }], ["/v1/dev/client/repositories/available", undefined]] as const) {
      const response = await h.call(path, body);
      expect(response.statusCode).toBe(403);
      expect(json(response).error).toEqual({ code: "FORBIDDEN", message: "only a Rovara administrator can create a project" });
    }
    expect(h.repositoryInstallation).not.toHaveBeenCalled();
  });
});

describe("the single-repository create", () => {

  it("now also refuses a suspended installation, in its own unchanged words", async () => {
    const h = await world();
    const refused = await h.call("/v1/dev/client/projects", { repository: "paused/y" });
    expect(json(refused)).toEqual({ error: { code: "CONFIG_INVALID", message: "the GitHub App cannot access paused/y; install it on paused with access to that repository" }, requestId: "golden" });
    expect(h.db.get(`ORG#${A}#PROJECT#y`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#y`, "REV#000000000001")).toBeUndefined();
    const created = await h.call("/v1/dev/client/projects", { repository: "acme-a/web" });
    expect(json(created)).toEqual({ name: "web", latestRevision: 1, access: "administrator", repositories: [{ name: "web", url: "https://github.com/acme-a/web.git", defaultBranch: "main", fullName: "acme-a/web" }], requestId: "golden" });
  });
});

// Guided onboarding PR 19 (design section 4, DEC 254l): a live owner or admin of the caller's own company creates projects too; a member does not.
describe("company owners and admins create projects", () => {
  const signedIn = (membership: Membership, options: { bindings?: boolean } = {}) => world(membership.companyId, { administrator: false, amr: "slack", membership, ...options });


  it("A's admin cannot create from B's repository on any route, nor see B's repositories or projects in the picker", async () => {
    const h = await signedIn({ companyId: A, role: "admin" });
    h.db.set({ ...orgProjectCatalogKey(B, "b-own"), entityType: "PROJECT_CATALOG", name: "b-own" });
    h.db.set({ pk: "PROJECT#b-own", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "b-own", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme-a/web.git" }] } });
    const single = await h.call("/v1/dev/client/projects", { repository: "acme-b/secret" });
    expect(json(single)).toEqual({ error: { code: "CONFIG_INVALID", message: "the GitHub App cannot access acme-b/secret; install it on acme-b with access to that repository" }, requestId: "golden" });
    expect(json(await h.call("/v1/dev/client/projects", { repositories: ["acme-a/web", "acme-b/secret"] }))).toEqual({ error: REFUSED, requestId: "golden" });
    expect(json(await h.call("/v1/dev/client/projects/bulk", { repositories: ["acme-b/secret"] })).results).toEqual([{ repository: "acme-b/secret", outcome: "refused", reason: "not_available" }]);
    expect(h.db.get(`ORG#${A}#PROJECT#secret`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#secret`, "REV#000000000001")).toBeUndefined();
    expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")).toBeUndefined(); expect(h.db.get(`PROJECT#web`, "REV#000000000001")).toBeUndefined();
    for (const path of ["/v1/dev/client/repositories/available", "/v1/dev/client/repositories"]) {
      const response = await h.call(path);
      expect(response.statusCode).toBe(200);
      for (const leak of ["acme-b", "b-own", "loose", B]) expect(response.body).not.toContain(leak);
    }
    // And B's admin, the other way round.
    const b = await signedIn({ companyId: B, role: "admin" });
    expect(json(await b.call("/v1/dev/client/projects", { repositories: ["acme-a/web"] }))).toEqual({ error: REFUSED, requestId: "golden" });
    const bWeb = await b.call("/v1/dev/client/projects", { repositories: ["acme-b/web"] });
    expect(bWeb.statusCode).toBe(200);
    expect(b.db.get(`ORG#${B}#PROJECT#${json(bWeb).name as string}`, "REV#000000000001")?.companyId).toBe(B);
  });

  it("leaves the Rovara administrator byte-identical, and lets one whose company role is only member create as before", async () => {
    const { readFileSync } = await import("node:fs");
    const h = await world(A);
    h.repositoryInstallation.mockImplementation(async () => ({ installationId: 77, suspended: false }));
    h.extra.githubPullRequests.installationIdFor.mockImplementation(async () => 77);
    const created = await h.call("/v1/dev/client/projects", { repository: "example/demo" });
    expect(JSON.stringify(created) + "\n").toBe(readFileSync("tests/fixtures/github-company-goldens/client-create-legacy.json", "utf8"));
    expect(JSON.stringify(await h.call("/v1/dev/client/projects", {})) + "\n").toBe(readFileSync("tests/fixtures/github-company-goldens/client-missing-field-legacy.json", "utf8"));
    // On a company-layout install the Rovara administrator signs in to the install's own company; a member role there changes nothing.
    const member = await world(IMPLICIT_COMPANY_ID, { membership: { companyId: IMPLICIT_COMPANY_ID, role: "member" } });
    await member.bindings.claim(IMPLICIT_COMPANY_ID, 99, "loose", "operator");
    for (const [path, body] of [["/v1/dev/client/projects", { repository: "loose/x" }], ["/v1/dev/client/projects", { repositories: ["loose/y"] }], ["/v1/dev/client/projects/bulk", { repositories: ["loose/z"] }],
      ["/v1/dev/client/repositories/available", undefined], ["/v1/dev/client/repositories", undefined]] as const) {
      expect((await member.call(path, body)).statusCode).toBe(200);
    }
    expect(member.db.get("PROJECT#x", "REV#000000000001")?.companyId).toBe(IMPLICIT_COMPANY_ID);
    expect(member.db.get(`MEMBER#${PERSON}`, "PROJECT#y")).toMatchObject({ role: "administrator" });
  });
});
