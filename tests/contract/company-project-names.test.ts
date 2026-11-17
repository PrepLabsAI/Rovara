// Guided onboarding L2-1 (DEC 254o a): per-company project names. Two companies can each have a project named X; no name check, refusal, bulk outcome
// or read reveals whether another company has a name. The Rovara administrator's create keeps today's global names (id == name), byte-identical.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENTX_NAME_PATTERN, orgProjectCatalogKey, orgProjectNameClaimKey, type ClientRepositoriesResponse } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { companyNameClaimWrites, companyNameTaken, companyProjectId, companyProjectIdByName, companyProjectNaming, PROJECT_ID_ATTEMPTS } from "../../packages/broker/src/aws/company-project-names.js";
import { ClientProjectRefused } from "../../packages/broker/src/aws/client-project-create.js";
import { companyRouteHarness, PERSON } from "../support/company-route-harness.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const LIVE: Record<string, number> = { "acme-a": 77, "acme-b": 88 };
const repo = (fullName: string, id: number) => ({ fullName, githubRepositoryId: id, private: true, defaultBranch: "main" });
const LISTED: ClientRepositoriesResponse["installations"] = [
  { installationId: 77, accountLogin: "acme-a", accountType: "Organization", repositorySelection: "selected", status: "active", repositories: [repo("acme-a/web", 1), repo("acme-a/api", 2)] },
  { installationId: 88, accountLogin: "acme-b", accountType: "Organization", repositorySelection: "selected", status: "active", repositories: [repo("acme-b/web", 3), repo("acme-b/api", 4)] },
];
const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/]+)\//.exec(url)![1]!;
const PER_COMPANY = { perCompany: true } as const;
const ID = /^[a-z][a-z0-9-]*-[a-z0-9]{6}$/;

type Module = { clientProjectDependenciesForTests: (input: unknown) => {
  createClientProject: (developerId: string, input: unknown, naming?: unknown) => Promise<{ name: string; latestRevision: number }>;
  createClientProjects: (developerId: string, input: unknown, naming?: unknown) => Promise<{ name: string; latestRevision: number }>;
  createClientProjectsBulk: (developerId: string, input: unknown, naming?: unknown) => Promise<{ results: Array<Record<string, unknown>> }>;
} };
let module: Module;
beforeAll(async () => { module = await loadSlackBroker() as unknown as Module; });

/** One store, two companies (each with its own bound installation); `as(company)` makes the caller a member of that company. */
async function world() {
  const h = companyRouteHarness();
  const bindings = new GithubInstallationBindings(h.db, "state");
  await bindings.backfill(async () => []);
  await bindings.claim(A, 77, "acme-a", "operator");
  await bindings.claim(B, 88, "acme-b", "operator");
  let company = A;
  const companyOf = vi.fn(async (): Promise<string | undefined> => company);
  const clientProjects = {
    credentialRef: "github-app",
    repositories: vi.fn(async () => structuredClone(LISTED)),
    repositoryDefaults: vi.fn(async (url: string) => { const [, owner, name] = /^https:\/\/github\.com\/([^/]+)\/(.+)\.git$/.exec(url)!; return { owner: owner!, name: name!, defaultBranch: "main" }; }),
    workerBinding: vi.fn(async () => ({ deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" })),
    repositoryInstallation: vi.fn(async (url: string) => ({ installationId: LIVE[ownerOf(url)] ?? 0, suspended: false })),
  };
  const extra = { documentClient: h.db, linking: h.deps.developer, clientProjects, companies: { companyOf }, githubBindings: bindings,
    githubPullRequests: { installationIdFor: vi.fn(async (url: string) => LIVE[ownerOf(url)] ?? 0) },
    githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) },
  };
  const broker = createBroker({ extra });
  const deps = module.clientProjectDependenciesForTests(broker.brokerInput);
  const sent: unknown[] = [];
  const send = h.db.send.bind(h.db);
  h.db.send = vi.fn(async (command: unknown) => { sent.push(command); return send(command as never); });
  const revision = (id: string) => h.db.get(`PROJECT#${id}`, "REV#000000000001");
  const projectRows = () => h.db.find((item) => typeof item.pk === "string" && (item.pk.startsWith("PROJECT#") || item.pk.includes("#PROJECT_CATALOG") || item.pk.includes("#PROJECT_NAME") || item.pk.startsWith("MEMBER#") || item.pk.includes("#PROJECT#")));
  return { ...h, deps, clientProjects, companyOf, sent, revision, projectRows, as: (next: string) => { company = next; } };
}
const reason = async (work: Promise<unknown>) => { try { await work; return "created"; } catch (error) { return error instanceof ClientProjectRefused ? error.reason : (error as { code?: string }).code; } };

describe("same name in two companies", () => {
  it("A and B each create a project named web (one-project create): two different ids, each in its own company, each with its own claim", async () => {
    const h = await world();
    const a = await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
    h.as(B);
    const b = await h.deps.createClientProjects(PERSON, { repositories: ["acme-b/web"] }, PER_COMPANY);
    for (const [created, company] of [[a, A], [b, B]] as const) {
      expect(created.name).toMatch(ID);
      expect(created.name.startsWith("web-")).toBe(true);
      expect(created.latestRevision).toBe(1);
      expect(h.revision(created.name)?.companyId).toBe(company);
      expect((h.revision(created.name)?.definition as { name?: string } | undefined)?.name).toBe(created.name);
      expect(h.db.get(orgProjectNameClaimKey(company, "web").pk, orgProjectNameClaimKey(company, "web").sk)).toMatchObject({ entityType: "PROJECT_NAME_CLAIM", companyId: company, name: "web", projectId: created.name, claimedBy: PERSON });
      expect(h.db.get(`MEMBER#${PERSON}`, `PROJECT#${created.name}`)).toMatchObject({ role: "administrator" });
    }
    expect(a.name).not.toBe(b.name);
    expect(h.revision("web")).toBeUndefined();
  });

  it("the single-repository create and the named create behave the same way", async () => {
    const h = await world();
    h.as(B);
    const b = await h.deps.createClientProject(PERSON, { repository: "acme-b/web", name: "storefront" }, PER_COMPANY);
    h.as(A);
    const a = await h.deps.createClientProject(PERSON, { repository: "acme-a/web", name: "storefront" }, PER_COMPANY);
    expect([a.name, b.name].every((name) => /^storefront-[a-z0-9]{6}$/.test(name))).toBe(true);
    expect(h.revision(a.name)?.companyId).toBe(A);
    expect(h.revision(b.name)?.companyId).toBe(B);
  });

  it("a name is unique inside the company: A's second web is refused name_taken, in today's words, and nothing is written", async () => {
    const h = await world();
    await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
    const before = h.projectRows().length;
    await expect(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/api"], name: "web" }, PER_COMPANY)).rejects.toMatchObject({ reason: "name_taken", code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named web already exists; choose another name" });
    await expect(h.deps.createClientProject(PERSON, { repository: "acme-a/api", name: "web" }, PER_COMPANY)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named web already exists; choose another name" });
    expect(h.projectRows()).toHaveLength(before);
  });

  it("an older project of the company whose id IS the name (its own catalog row) takes the name too; another company's never does", async () => {
    const h = await world();
    h.db.set({ ...orgProjectCatalogKey(A, "api"), entityType: "PROJECT_CATALOG", companyId: A, name: "api", latestRevision: 1 });
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/api"] }, PER_COMPANY))).toBe("name_taken");
    h.as(B);
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-b/api"] }, PER_COMPANY))).toBe("created");
  });
});

describe("no answer reveals another company's names", () => {
  it("A's refusal for a name only B has is impossible: B's global, claimed and catalogued web never refuses A", async () => {
    const h = await world();
    h.as(B);
    await h.deps.createClientProjects(PERSON, { repositories: ["acme-b/web"] }, PER_COMPANY);
    // B also holds an older project whose id is literally "web" (the shared namespace's row), in its own catalog.
    h.db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "web", revision: 1 } });
    h.db.set({ ...orgProjectCatalogKey(B, "web"), entityType: "PROJECT_CATALOG", companyId: B, name: "web", latestRevision: 1 });
    h.as(A);
    for (const create of [() => h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY), () => h.deps.createClientProject(PERSON, { repository: "acme-a/api", name: "api" }, PER_COMPANY)]) {
      h.sent.length = 0;
      const created = await create();
      expect(created.name).toMatch(ID);
      // A's create read nothing of B's: no key, partition or value of B, and never the bare shared name.
      const reads = JSON.stringify(h.sent);
      expect(reads).not.toContain(B);
      expect(reads).not.toMatch(/"(:)?pk":"PROJECT#(web|api)"/);
    }
  });

  it("bulk outcomes are identical whether or not B has the names", async () => {
    const outcomes = async (bHasNames: boolean) => {
      const h = await world();
      if (bHasNames) {
        h.as(B);
        await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-b/web", "acme-b/api"] }, PER_COMPANY);
        h.db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: "web", revision: 1 } });
        h.as(A);
      }
      h.db.set({ ...orgProjectCatalogKey(A, "api"), entityType: "PROJECT_CATALOG", companyId: A, name: "api", latestRevision: 1 });
      h.sent.length = 0;
      const answer = await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-a/web", "acme-a/api", "acme-b/web"] }, PER_COMPANY);
      expect(JSON.stringify(h.sent)).not.toContain(B);
      return answer.results.map((row) => ({ ...row, ...(typeof row.project === "string" ? { project: ID.test(row.project) && row.project.startsWith("web-") ? "web-<id>" : row.project } : {}) }));
    };
    const without = await outcomes(false);
    expect(without).toEqual([
      { repository: "acme-a/web", outcome: "created", project: "web-<id>" },
      { repository: "acme-a/api", outcome: "refused", reason: "name_taken" },
      { repository: "acme-b/web", outcome: "refused", reason: "not_available" },
    ]);
    expect(await outcomes(true)).toEqual(without);
  });

  it("two repositories of one bulk call with the same name: the first makes the project, the second is name_taken (the company's own claim)", async () => {
    const h = await world();
    // Repeats ignoring case are refused by the route's body schema; here two rows naming the same project reach the create, one after another.
    const answer = await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-a/web", "acme-a/Web"] }, PER_COMPANY);
    expect(answer.results.map((row) => row.outcome === "created" ? "created" : row.reason)).toEqual(["created", "name_taken"]);
  });
});

describe("the claim is taken in the registration's own transaction", () => {
  it("a claim that appears after the check (a concurrent create of the same name) cancels the whole registration: name_taken, nothing else written", async () => {
    const h = await world();
    const before = h.projectRows().length;
    h.clientProjects.workerBinding.mockImplementationOnce(async () => {
      h.db.set({ ...orgProjectNameClaimKey(A, "web"), entityType: "PROJECT_NAME_CLAIM", companyId: A, name: "web", projectId: "web-zzzzzz", claimedBy: "rival", claimedAt: "2026-11-17T00:00:00.000Z" });
      return { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
    });
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY))).toBe("name_taken");
    expect(h.projectRows()).toHaveLength(before + 1);
  });

  it("an older project row of the same name that appears after the check cancels it too (single create)", async () => {
    const h = await world();
    const before = h.projectRows().length;
    h.clientProjects.workerBinding.mockImplementationOnce(async () => {
      h.db.set({ ...orgProjectCatalogKey(A, "web"), entityType: "PROJECT_CATALOG", companyId: A, name: "web", latestRevision: 1 });
      return { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
    });
    await expect(h.deps.createClientProject(PERSON, { repository: "acme-a/web" }, PER_COMPANY)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named web already exists; choose another name" });
    expect(h.projectRows()).toHaveLength(before + 1);
  });

  it("the claim items: a conditional Put of the company's claim and a check of the company's own catalog, nothing else", () => {
    expect(companyNameClaimWrites("state", { companyId: A, name: "web", projectId: "web-abc123", by: PERSON, at: "2026-11-17T00:00:00.000Z" })).toEqual([
      { Put: { TableName: "state", ConditionExpression: "attribute_not_exists(pk)", Item: { pk: `ORG#${A}#PROJECT_NAME`, sk: "NAME#web", entityType: "PROJECT_NAME_CLAIM", companyId: A, name: "web", projectId: "web-abc123", claimedBy: PERSON, claimedAt: "2026-11-17T00:00:00.000Z" } } },
      { ConditionCheck: { TableName: "state", Key: { pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#web" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
    expect(() => companyNameClaimWrites("state", { companyId: "not-a-company", name: "web", projectId: "web-abc123", by: PERSON, at: "x" })).toThrow();
  });
});

describe("the Rovara administrator's create is unchanged", () => {
  it("without per-company naming: id == name, the global check, no claim row", async () => {
    const h = await world();
    expect(await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] })).toEqual({ name: "web", latestRevision: 1 });
    expect(await h.deps.createClientProject(PERSON, { repository: "acme-a/api" })).toEqual({ name: "api", latestRevision: 1 });
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("#PROJECT_NAME"))).toEqual([]);
    h.as(B);
    // Today's shared namespace, for the administrator only: B's administrator is refused A's web.
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-b/web"] }))).toBe("name_taken");
    const bulk = await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-b/api"] });
    expect(bulk.results).toEqual([{ repository: "acme-b/api", outcome: "refused", reason: "name_taken" }]);
  });
});

describe("fail closed", () => {
  it("per-company naming without a company is refused, nothing written", async () => {
    const h = await world();
    h.companyOf.mockResolvedValue(undefined);
    const before = h.projectRows().length;
    // No membership: the create's own company read refuses first (AUTH_REQUIRED); the naming's FORBIDDEN is the fallback (unit test below).
    for (const work of [() => h.deps.createClientProject(PERSON, { repository: "acme-a/web" }, PER_COMPANY), () => h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY)]) {
      expect(["FORBIDDEN", "AUTH_REQUIRED"]).toContain(await reason(work()));
    }
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY))).not.toBe("created");
    expect(h.projectRows()).toHaveLength(before);
  });

  it("a fresh id already in use is drawn again; after the attempts, unavailable", async () => {
    const naming = companyProjectNaming(vi.fn(async () => true), vi.fn(async () => false));
    await expect(naming.idFor(A, "web")).rejects.toMatchObject({ reason: "unavailable" });
    let calls = 0;
    const exists = vi.fn(async () => ++calls < PROJECT_ID_ATTEMPTS);
    expect(await companyProjectNaming(exists, vi.fn(async () => false)).idFor(A, "web")).toMatch(/^web-[a-z0-9]{6}$/);
    expect(exists).toHaveBeenCalledTimes(PROJECT_ID_ATTEMPTS);
    expect(await companyProjectNaming(exists, vi.fn()).idFor(undefined, "web")).toBe("web");
    expect(companyProjectNaming(exists, vi.fn()).owner(undefined, A)).toBeUndefined();
    expect(() => companyProjectNaming(exists, vi.fn()).owner(PER_COMPANY, "org_short")).toThrow();
  });
});

describe("ids and lookups", () => {
  it("an id is the name (cut to fit) plus six unbiased random characters, always a valid project name", () => {
    expect(companyProjectId("web", () => Uint8Array.from([0, 1, 25, 26, 35, 251, 0, 0, 0, 0, 0, 0]))).toBe("web-abz099");
    // Bytes at or above 252 are drawn again (no bias towards the first four characters).
    expect(companyProjectId("web", () => Uint8Array.from([252, 253, 254, 255, 36, 37, 38, 39, 40, 41, 0, 0]))).toBe("web-abcdef");
    const long = `a${"b".repeat(61)}c`;
    const id = companyProjectId(long);
    expect(id).toHaveLength(63);
    expect(id).toMatch(AGENTX_NAME_PATTERN);
    expect(companyProjectId(`a${"b".repeat(54)}-cc`)).toMatch(/^ab{54}-[a-z0-9]{6}$/);
    expect(() => companyProjectId("Web")).toThrow();
    expect(new Set(Array.from({ length: 200 }, () => companyProjectId("web"))).size).toBe(200);
  });

  it("a name resolves to an id only inside the company: its claim, or its own older project; never another company's", async () => {
    const h = await world();
    const a = await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
    h.db.set({ ...orgProjectCatalogKey(A, "legacy"), entityType: "PROJECT_CATALOG", companyId: A, name: "legacy", latestRevision: 1 });
    expect(await companyProjectIdByName(h.db, "state", A, "web")).toBe(a.name);
    expect(await companyProjectIdByName(h.db, "state", A, "legacy")).toBe("legacy");
    expect(await companyProjectIdByName(h.db, "state", B, "web")).toBeUndefined();
    expect(await companyProjectIdByName(h.db, "state", B, "legacy")).toBeUndefined();
    expect(await companyNameTaken(h.db, "state", B, "web")).toBe(false);
    expect(await companyNameTaken(h.db, "state", A, "web")).toBe(true);
    // A planted row that names another company, another name or a bad id resolves nothing.
    for (const forged of [{ companyId: B }, { name: "other" }, { projectId: "BAD ID" }, { entityType: "PROJECT_CATALOG" }]) {
      h.db.set({ ...orgProjectNameClaimKey(B, "web"), entityType: "PROJECT_NAME_CLAIM", companyId: B, name: "web", projectId: a.name, ...forged, ...("companyId" in forged ? { companyId: A } : {}) });
      expect(await companyProjectIdByName(h.db, "state", B, "web")).toBeUndefined();
    }
    h.db.set({ ...orgProjectCatalogKey(B, "legacy"), entityType: "PROJECT_CATALOG", companyId: A, name: "legacy", latestRevision: 1 });
    expect(await companyProjectIdByName(h.db, "state", B, "legacy")).toBeUndefined();
  });
});
