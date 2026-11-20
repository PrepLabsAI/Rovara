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

type Module = {
  NAMED_COMPANY_CANDIDATE_WAITING: string; NAMED_COMPANY_SETUP_APPROVAL_REFUSED: string;
  registerProjectForTests: (input: unknown, identity: unknown, value: unknown, companyId: string | undefined) => Promise<{ duplicate: boolean }>;
  adminChangeHandlersForTests: (input: unknown) => { checkRevision: (identity: unknown, definition: unknown, runtimeBinding: unknown, options?: unknown) => Promise<unknown> };
  clientProjectDependenciesForTests: (input: unknown) => {
  createClientProject: (developerId: string, input: unknown, naming?: unknown) => Promise<{ name: string; latestRevision: number }>;
  createClientProjects: (developerId: string, input: unknown, naming?: unknown) => Promise<{ name: string; latestRevision: number }>;
  createClientProjectsBulk: (developerId: string, input: unknown, naming?: unknown) => Promise<{ results: Array<Record<string, unknown>> }>;
} };
let module: Module;
beforeAll(async () => { module = await loadSlackBroker() as unknown as Module; });

/** One store, two companies (each with its own bound installation); `as(company)` makes the caller a member of that company. */
async function world(options: { bindings?: false } = {}) {
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
  const extra = { documentClient: h.db, linking: h.deps.developer, clientProjects, companies: { companyOf }, ...(options.bindings === false ? {} : { githubBindings: bindings }),
    githubPullRequests: { installationIdFor: vi.fn(async (url: string) => LIVE[ownerOf(url)] ?? 0) },
    githubBindingInstallations: { get: async () => undefined, page: async () => ({ installations: [], more: false }) },
  };
  const broker = createBroker({ extra });
  const deps = module.clientProjectDependenciesForTests(broker.brokerInput);
  const sent: unknown[] = [];
  const send = h.db.send.bind(h.db);
  h.db.send = vi.fn(async (command: unknown) => { sent.push(command); return send(command as never); });
  // DEC 254zzz80: a project's first revision, wherever it is: a named company's own partition (`ORG#<company>#PROJECT#<id>`), else the legacy row.
  const revision = (id: string) => h.db.find((item) => item.sk === "REV#000000000001" && typeof item.pk === "string" && (item.pk === `PROJECT#${id}` || /^ORG#[^#]+#PROJECT#/.test(item.pk) && item.pk.endsWith(`#PROJECT#${id}`)))[0];
  const projectRows = () => h.db.find((item) => typeof item.pk === "string" && (item.pk.startsWith("PROJECT#") || item.pk.includes("#PROJECT_CATALOG") || item.pk.includes("#PROJECT_NAME") || item.pk.startsWith("MEMBER#") || item.pk.includes("#MEMBER#") || item.pk.includes("#PROJECT#")));
  return { ...h, deps, clientProjects, companyOf, sent, revision, projectRows, brokerInput: broker.brokerInput, as: (next: string) => { company = next; } };
}
const reason = async (work: Promise<unknown>) => { try { await work; return "created"; } catch (error) { return error instanceof ClientProjectRefused ? error.reason : (error as { code?: string }).code; } };

describe("same name in two companies", () => {

  it("a name is unique inside the company: A's second web is refused name_taken, in today's words, and nothing is written", async () => {
    const h = await world();
    await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
    const before = h.projectRows().length;
    await expect(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/api"], name: "web" }, PER_COMPANY)).rejects.toMatchObject({ reason: "name_taken", code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named web already exists; choose another name" });
    await expect(h.deps.createClientProject(PERSON, { repository: "acme-a/api", name: "web" }, PER_COMPANY)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named web already exists; choose another name" });
    expect(h.projectRows()).toHaveLength(before);
  });

});

describe("no answer reveals another company's names", () => {

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
    expect(companyNameClaimWrites("state", { companyId: A, name: "web", projectId: "web-abc123", revision: 1, by: PERSON, at: "2026-11-17T00:00:00.000Z" })).toEqual([
      { Put: { TableName: "state", ConditionExpression: "attribute_not_exists(pk)", Item: { pk: `ORG#${A}#PROJECT_NAME`, sk: "NAME#web", entityType: "PROJECT_NAME_CLAIM", companyId: A, name: "web", projectId: "web-abc123", claimedBy: PERSON, claimedAt: "2026-11-17T00:00:00.000Z" } } },
      { ConditionCheck: { TableName: "state", Key: { pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#web" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
    // Only a company's project, and only its first revision, claims a name (registration refuses before any write).
    for (const bad of [{ companyId: "not-a-company" }, { companyId: undefined }, { revision: 2 }]) {
      expect(() => companyNameClaimWrites("state", { companyId: A, name: "web", projectId: "web-abc123", revision: 1, by: PERSON, at: "x", ...bad })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }) as Error);
    }
  });
});

describe("the Rovara administrator's create is unchanged", () => {
  it("without per-company naming: id == name, the global check, no claim row", async () => {
    const h = await world();
    // The create answers the company it wrote in (DEC 254zzz80: the route reads the project back there).
    expect(await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] })).toEqual({ name: "web", latestRevision: 1, companyId: A });
    expect(await h.deps.createClientProject(PERSON, { repository: "acme-a/api" })).toEqual({ name: "api", latestRevision: 1, companyId: A });
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("#PROJECT_NAME"))).toEqual([]);
    // The same company's second web or api: taken, in today's words (its own partition holds them).
    expect(await reason(h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }))).toBe("name_taken");
    await expect(h.deps.createClientProject(PERSON, { repository: "acme-a/api" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: a project named api already exists; choose another name" });
    expect((await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-a/api"] })).results).toEqual([{ repository: "acme-a/api", outcome: "refused", reason: "name_taken" }]);
    // A name in the install's legacy rows (the shared namespace) is still taken for every company.
    h.db.set({ pk: "PROJECT#docs", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "docs", revision: 1 } });
    h.as(B);
    expect(await reason(h.deps.createClientProject(PERSON, { repository: "acme-b/web", name: "docs" }))).toBe("CONFIG_INVALID");
    // DEC 254zzz80 with lane 2 (DEC 254zzz98: grants in the company's own partition): two companies may each hold a project of one name; B's administrator creates B's own.
    expect(await h.deps.createClientProjects(PERSON, { repositories: ["acme-b/web"] })).toEqual({ name: "web", latestRevision: 1, companyId: B });
    expect((await h.deps.createClientProjectsBulk(PERSON, { repositories: ["acme-b/api"] })).results).toEqual([{ repository: "acme-b/api", outcome: "created", project: "api" }]);
    expect(h.db.get(`ORG#${A}#PROJECT#web`, "REV#000000000001")?.companyId).toBe(A);
    expect(h.db.get(`ORG#${B}#PROJECT#web`, "REV#000000000001")?.companyId).toBe(B);
  });
});

describe("fail closed", () => {

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

describe("review fixes (L2-1 Opus review)", () => {
  /** Plants a B-owned revision at the fresh id the create just checked, so registration meets a project that is not the company's. */
  const plantAtFreshId = (h: Awaited<ReturnType<typeof world>>) => async () => {
    const asked = h.sent.map((command) => (command as { input?: { ExpressionAttributeValues?: Record<string, unknown> } }).input?.ExpressionAttributeValues?.[":pk"])
      .filter((pk): pk is string => typeof pk === "string" && /^PROJECT#web-[a-z0-9]{6}$/.test(pk));
    const pk = asked.at(-1)!;
    h.db.set({ pk, sk: "REV#000000000001", entityType: "PROJECT", companyId: B, definition: { name: pk.slice("PROJECT#".length), revision: 1 } });
    return { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
  };

  it("a fresh id taken by another company between the check and registration answers unavailable in fixed words, never 'not found', nothing of A written", async () => {
    for (const single of [false, true]) {
      const h = await world();
      h.clientProjects.workerBinding.mockImplementationOnce(plantAtFreshId(h));
      const work = single ? h.deps.createClientProject(PERSON, { repository: "acme-a/web" }, PER_COMPANY) : h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
      const error = await work.then(() => undefined, (caught: unknown) => caught as { code?: string; message?: string; reason?: string });
      expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE", reason: "unavailable" });
      expect(error?.message).not.toMatch(/not found|org_/);
      expect(h.db.get(orgProjectNameClaimKey(A, "web").pk, orgProjectNameClaimKey(A, "web").sk)).toBeUndefined();
      expect(h.db.find((item) => item.companyId === A && typeof item.pk === "string" && item.pk.startsWith("PROJECT#"))).toEqual([]);
    }
  });

  it("a lookup by name checks the claimed project is still the company's, and an older catalog row must name the same project", async () => {
    const h = await world();
    const a = await h.deps.createClientProjects(PERSON, { repositories: ["acme-a/web"] }, PER_COMPANY);
    expect(await companyProjectIdByName(h.db, "state", A, "web")).toBe(a.name);
    h.db.set({ ...h.revision(a.name)!, companyId: B });
    expect(await companyProjectIdByName(h.db, "state", A, "web")).toBeUndefined();
    // A claim in A's own partition that names another company, or whose project row is missing, resolves nothing.
    h.db.set({ ...h.revision(a.name)!, companyId: A });
    const claim = h.db.get(orgProjectNameClaimKey(A, "web").pk, orgProjectNameClaimKey(A, "web").sk)!;
    h.db.set({ ...claim, companyId: B });
    expect(await companyProjectIdByName(h.db, "state", A, "web")).toBeUndefined();
    h.db.set({ ...claim, projectId: "web-nnnnnn" });
    expect(await companyProjectIdByName(h.db, "state", A, "web")).toBeUndefined();
    h.db.set({ ...orgProjectCatalogKey(A, "old"), entityType: "PROJECT_CATALOG", companyId: A, name: "other", latestRevision: 1 });
    expect(await companyProjectIdByName(h.db, "state", A, "old")).toBeUndefined();
  });
});

describe("R2-F1 review: a named company's registration in its own partition", () => {
  const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
  const identity = { issuer: "sign-in-client", subject: PERSON, ownerKey: PERSON, isAdministrator: true, claims: {}, developer: { developerId: PERSON, provider: "oidc", name: "Person" } };
  const definition = (revision: number, owner = "acme-a", extra: Record<string, unknown> = {}) => ({
    name: "web", revision, orchestratorInstructions: "Delegate.", setup: [], readiness: [],
    repositories: [{ name: "web", url: `https://github.com/${owner}/web.git`, path: "repo/web", defaultBranch: `b${revision}`, credentialRef: "github-app" }], ...extra,
  });
  /** `companyId` null: no company (the legacy namespace). */
  const register = (h: Awaited<ReturnType<typeof world>>, revision: number, companyId: string | null = A, extra: Record<string, unknown> = {}, owner = "acme-a") =>
    module.registerProjectForTests(h.brokerInput, identity, { definition: definition(revision, owner), runtimeBinding: BINDING, ...extra }, companyId ?? undefined);
  const catalog = (h: Awaited<ReturnType<typeof world>>) => h.db.get(orgProjectCatalogKey(A, "web").pk, orgProjectCatalogKey(A, "web").sk)?.latestRevision;
  const rev = (n: number) => `REV#${String(n).padStart(12, "0")}`;

  it("a second revision and a repeat: the own partition and its catalog pointer move, never the legacy rows", async () => {
    const h = await world();
    expect((await register(h, 1)).duplicate).toBe(false);
    expect((await register(h, 2)).duplicate).toBe(false);
    expect(catalog(h)).toBe(2);
    expect(h.db.get(`ORG#${A}#PROJECT#web`, rev(2))).toMatchObject({ companyId: A, definition: { revision: 2 } });
    expect((await register(h, 2)).duplicate).toBe(true);
    expect(catalog(h)).toBe(2);
    expect(h.db.find((item) => item.pk === "PROJECT#web" || item.pk === "PROJECT_CATALOG")).toEqual([]);
  });

  it("M1: a setup change waiting for approval (a candidate the catalog does not point at) refuses another revision; the pointer never moves onto it", async () => {
    const h = await world();
    await register(h, 1); await register(h, 2);
    h.db.set({ pk: `ORG#${A}#PROJECT#web`, sk: rev(3), entityType: "PROJECT", candidate: true, definition: definition(3) });
    await expect(register(h, 4)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: `PROJECT_REVISION_MISMATCH: ${module.NAMED_COMPANY_CANDIDATE_WAITING}` });
    expect(catalog(h)).toBe(2);
    expect(h.db.get(`ORG#${A}#PROJECT#web`, rev(4))).toBeUndefined();
    // Approved (the catalog moved onto 3): the next revision registers.
    h.db.set({ ...h.db.get(orgProjectCatalogKey(A, "web").pk, orgProjectCatalogKey(A, "web").sk)!, latestRevision: 3 });
    expect((await register(h, 4)).duplicate).toBe(false);
    expect(catalog(h)).toBe(4);
  });

  it("the duplicate path's pointer repair never moves the catalog onto a candidate row", async () => {
    const h = await world();
    await register(h, 1); await register(h, 2);
    // A candidate row identical to what is registered again: the duplicate answer, and the pointer stays on 2.
    h.db.set({ pk: `ORG#${A}#PROJECT#web`, sk: rev(3), entityType: "PROJECT", candidate: true, companyId: A, definition: definition(3), runtimeBinding: BINDING });
    expect((await register(h, 3)).duplicate).toBe(true);
    expect(catalog(h)).toBe(2);
    // A behind pointer with a plain stored row: the repeat repairs it forward.
    h.db.set({ ...h.db.get(orgProjectCatalogKey(A, "web").pk, orgProjectCatalogKey(A, "web").sk)!, latestRevision: 1 });
    h.db.delete(`ORG#${A}#PROJECT#web`, rev(3));
    expect((await register(h, 2)).duplicate).toBe(true);
    expect(catalog(h)).toBe(2);
  });

  it("L1: a newest own row with no readable definition is refused in fixed words, never a 500", async () => {
    const h = await world();
    await register(h, 1);
    h.db.set({ pk: `ORG#${A}#PROJECT#web`, sk: rev(2), entityType: "PROJECT", companyId: A });
    await expect(register(h, 3)).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: "PROJECT_REVISION_MISMATCH: registered project revision history is invalid" });
  });

  it("the admin setup-approval run is refused for a named company, before anything is read or written", async () => {
    const h = await world();
    const setupApproval = { proposalRef: `project-setup-proposals/${PERSON}/${"a".repeat(64)}.json`, proposalSha256: "a".repeat(64), decision: "approve" };
    await expect(register(h, 1, A, { setupApproval })).rejects.toMatchObject({ code: "FORBIDDEN", message: `FORBIDDEN: ${module.NAMED_COMPANY_SETUP_APPROVAL_REFUSED}` });
    expect(h.projectRows()).toEqual([]);
  });

  it("review L1 (DEC 254zzz98): a registration with no company over a legacy row stamped with a named company keeps its grant beside the legacy revision, never in that company", async () => {
    // No company: a broker without GitHub installation bindings (with them, a registration with no company is refused before anything is stored).
    const h = await world({ bindings: false });
    // Pre-R2-F1 data: the legacy revision 1, stamped with company A, and its legacy administrator grant.
    h.db.set({ pk: "PROJECT#web", sk: rev(1), entityType: "PROJECT", companyId: A, definition: definition(1), runtimeBinding: BINDING, registeredBy: PERSON, registeredAt: "2026-11-01T00:00:00.000Z" });
    h.db.set({ pk: `MEMBER#${PERSON}`, sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "web", role: "administrator" });
    expect((await register(h, 2, null)).duplicate).toBe(false);
    expect(h.db.get("PROJECT#web", rev(2))).toMatchObject({ companyId: A, definition: { revision: 2 } });
    // The grant read (the administrator check) and anything written are the legacy rows: nothing lands in A's own partition.
    expect(h.db.find((item) => String(item.pk).startsWith(`ORG#${A}#MEMBER#`) || String(item.pk).startsWith(`ORG#${A}#PROJECT_MEMBERS#`))).toEqual([]);
    // Without the legacy grant, the same caller is not this project's administrator (an A grant does not count for a legacy revision).
    h.db.delete(`MEMBER#${PERSON}`, "PROJECT#web");
    h.db.set({ pk: `ORG#${A}#MEMBER#${PERSON}`, sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: PERSON, projectName: "web", role: "administrator" });
    await expect(register(h, 3, null)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the admin change plan's duplicate check reads the registering company's own revision", async () => {
    const h = await world();
    await register(h, 1);
    const handlers = module.adminChangeHandlersForTests(h.brokerInput);
    await expect(handlers.checkRevision(identity, definition(1), BINDING, { preflight: false })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("revision 1 of web is already registered") as unknown });
  });
});
