// P1a (A1 re-scoped by owner decision 254zzz434 and the Opus plan check): the broker half of private package registries (N9's `fb9b446fe`, written for today's core), with the credential a COMPANY package
// token (one per registry host, set once, write-only; no project holds a reference). The company store's WRITE side is lane P1b and is not here. Every token is FAKE and built at run time (a literal that
// looks like a key is refused by the public repo's push protection). What is held:
//   - every project of the company gets the company's entries in its PREPARE (one registry per scope), only for a PREPARE that runs its code, only to a worker that lists the feature;
//   - the exchange gives a credential to the live PREPARE of this company's workspace, for a registry the broker itself offered, and to nothing else; the company is the stored record's, never the request's;
//   - the token is read at the moment of use through the company's store, carries NO invented expiry, is AUDITED at every use, and is in no log, error, payload or stored record.
import { describe, expect, it, vi } from "vitest";
import { GENERIC_REGISTRY_REFUSED, PRIVATE_REGISTRY_HOSTS, ProjectRegistriesSchema, REGISTRY_TOKEN_SECONDS, companyRegistryNames, companyRegistrySecretName, isPrivateRegistryHost, orgProjectCatalogKey, prepareRegistriesOfCompany, projectRevisionKey, type AuditEvent, type CompanyRegistryEntry, type JsonValue, type PrivateRegistryHost, type ProjectDefinition, type ProjectRegistry } from "@agentx/contracts";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { companyRegistryTokenReader } from "../../packages/broker/src/core/project-registries/company-token-reader.js";
import { REGISTRY_REQUESTS_MAX_PER_OPERATION } from "../../packages/broker/src/core/project-registries/exchange.js";
import { REGISTRY_UNAVAILABLE_MESSAGE, companyRegistryCredential, mintCodeArtifactCredential, type CompanyRegistryStore } from "../../packages/broker/src/core/project-registries/mint.js";
import { COMPANY_REGISTRIES_UNREADABLE, REGISTRIES_NOT_AVAILABLE, REGISTRIES_TOO_MANY, registriesPrepareFor, type ProjectRegistriesInstall } from "../../packages/broker/src/core/project-registries/prepare.js";

/** A fake classic-token-shaped value, made at run time. */
const fakePat = (seed: string): string => `${"gh"}${"p"}_${Buffer.from(`${seed}-fake-material-${seed.repeat(30)}`).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 36)}`;
const PAT = fakePat("a");
const OTHER_PAT = fakePat("z");

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER_COMPANY = "org_bbbbbbbbbbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const WS2 = "33333333-3333-4333-8333-333333333333";
const OP2 = "44444444-4444-4444-8444-444444444444";
const KEY = "k".repeat(32);
const HOST: PrivateRegistryHost = "npm.pkg.github.com";
const ENTRY: CompanyRegistryEntry = { host: HOST, scopes: ["@acme", "@other"] };
const CODEARTIFACT: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
const REPOSITORY = { name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" };

function project(name: string, extra: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return { name, revision: 1, repositories: [REPOSITORY], setup: [], readiness: [], orchestratorInstructions: "x", ...extra };
}

/** The company's package tokens, over a map of `<company>|<host>` -> token and a map of company -> entries; every read is recorded. */
function companyStore(input: { tokens?: Record<string, string>; entries?: Record<string, CompanyRegistryEntry[]>; failEntries?: boolean } = {}) {
  const tokenReads: Array<{ companyId: string; host: string }> = [];
  const entryReads: string[] = [];
  const tokens = input.tokens ?? { [`${COMPANY}|${HOST}`]: PAT };
  const entries = input.entries ?? { [COMPANY]: [ENTRY], [OTHER_COMPANY]: [ENTRY] };
  const store: CompanyRegistryStore = {
    async entries(companyId) { entryReads.push(companyId); if (input.failEntries === true) throw new Error(`down ${PAT}`); return entries[companyId] ?? []; },
    async token(companyId, host) { tokenReads.push({ companyId, host }); const found = tokens[`${companyId}|${host}`]; return found === undefined ? undefined : { token: found }; },
  };
  return { store, tokenReads, entryReads };
}

describe("a company's package token", () => {
  it("is named from the environment, the company and the fixed host table: one secret per company per host", () => {
    const name = companyRegistrySecretName("production", COMPANY, HOST);
    expect(name).toBe(`agentx/production/org-connectors/${COMPANY}/pkgreg_ghnpm`);
    expect(companyRegistrySecretName("production", OTHER_COMPANY, HOST)).toBe(`agentx/production/org-connectors/${OTHER_COMPANY}/pkgreg_ghnpm`);
    expect(PRIVATE_REGISTRY_HOSTS[HOST].tokenPrefix).toBe("ghp_");
  });
  it("is nothing for a company, an environment or a host that is not valid, or not in the table", () => {
    expect(companyRegistrySecretName("production", "not-a-company", HOST)).toBeUndefined();
    expect(companyRegistrySecretName("../production", COMPANY, HOST)).toBeUndefined();
    expect(companyRegistrySecretName("production", COMPANY, "registry.npmjs.org")).toBeUndefined();
    expect(companyRegistrySecretName("production", COMPANY, "npm.pkg.github.com/../x")).toBeUndefined();
    expect(isPrivateRegistryHost("npm.pkg.github.com")).toBe(true);
    expect(isPrivateRegistryHost("constructor")).toBe(false);
  });
  it("is offered to a worker as one registry per scope, each asked for by a stable name, and an entry with no scope routes nothing", () => {
    expect(companyRegistryNames([{ host: HOST, scopes: ["@other", "@acme", "@acme"] }])).toEqual([{ name: "ghnpm-1", host: HOST, scope: "@acme" }, { name: "ghnpm-2", host: HOST, scope: "@other" }]);
    expect(prepareRegistriesOfCompany([ENTRY])).toStrictEqual([
      { name: "ghnpm-1", kind: "npm", format: "npm", url: "https://npm.pkg.github.com/", scope: "@acme" },
      { name: "ghnpm-2", kind: "npm", format: "npm", url: "https://npm.pkg.github.com/", scope: "@other" },
    ]);
    expect(prepareRegistriesOfCompany([{ host: HOST, scopes: [] }])).toEqual([]);
    expect(prepareRegistriesOfCompany([{ host: HOST, scopes: ["not-a-scope"] }])).toEqual([]);
  });
  it("is not something a project names: a generic registry in a project is refused, with the sentence that says where it is set", () => {
    for (const kind of ["npm", "pypi", "maven"]) {
      const parsed = ProjectRegistriesSchema.safeParse([{ kind, name: "x", url: "https://npm.pkg.github.com/", credentialRef: "mine" }]);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(GENERIC_REGISTRY_REFUSED);
    }
    expect(ProjectRegistriesSchema.safeParse([CODEARTIFACT]).success).toBe(true);
  });
});

describe("the one reader of a stored token", () => {
  const secrets = (values: Record<string, string>) => {
    const reads: Array<{ companyId: string; name: string }> = [];
    return { reads, store: { async read(companyId: string, name: string) { reads.push({ companyId, name }); return values[name]; } } };
  };
  const NAME = companyRegistrySecretName("production", COMPANY, HOST)!;
  it("reads the company's own secret by its name through the company's store, at every use, and never from the generic secrets point", async () => {
    const held = secrets({ [NAME]: PAT });
    const read = companyRegistryTokenReader({ env: "production", secrets: held.store });
    expect(await read(COMPANY, HOST)).toEqual({ token: PAT });
    expect(await read(COMPANY, HOST)).toEqual({ token: PAT });
    expect(held.reads).toEqual([{ companyId: COMPANY, name: NAME }, { companyId: COMPANY, name: NAME }]);
  });
  it("asks for the OTHER company's name when the other company asks, so a store that would answer the first company's name answers nothing", async () => {
    const held = secrets({ [NAME]: PAT });
    const read = companyRegistryTokenReader({ env: "production", secrets: held.store });
    expect(await read(OTHER_COMPANY, HOST)).toBeUndefined();
    expect(held.reads).toEqual([{ companyId: OTHER_COMPANY, name: companyRegistrySecretName("production", OTHER_COMPANY, HOST) }]);
  });
  it("takes a small JSON object when a registry wants a user name, and nothing else that is not a token", async () => {
    const read = (value: string) => companyRegistryTokenReader({ env: "production", secrets: secrets({ [NAME]: value }).store })(COMPANY, HOST);
    expect(await read(JSON.stringify({ token: PAT, username: "reader" }))).toEqual({ token: PAT, username: "reader" });
    for (const bad of ["{not json", JSON.stringify({ token: PAT, extra: 1 }), "", "   "]) expect(await read(bad)).toBeUndefined();
    // A value that is read but is not a usable token is refused by the credential, in one fixed sentence.
    for (const bad of [JSON.stringify({ token: "short" }), "has a space in it, not a token"]) {
      const store: CompanyRegistryStore = { entries: async () => [ENTRY], token: async (company, host) => companyRegistryTokenReader({ env: "production", secrets: secrets({ [NAME]: bad }).store })(company, host) };
      await expect(companyRegistryCredential(store, COMPANY, HOST, "ghnpm-1")).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("ghnpm-1"));
    }
  });
});

describe("making a registry credential", () => {
  it("hands on the company's token with NO expiry made up for it", async () => {
    const company = companyStore();
    const credential = await companyRegistryCredential(company.store, COMPANY, HOST, "ghnpm-1");
    expect(credential).toStrictEqual({ token: PAT });
    expect(Object.hasOwn(credential, "expiresAt")).toBe(false);
  });
  it("says one fixed sentence when no token is saved, the store is missing, or it fails, with no word of what it said", async () => {
    await expect(companyRegistryCredential(companyStore({ tokens: {} }).store, COMPANY, HOST, "ghnpm-1")).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("ghnpm-1"));
    await expect(companyRegistryCredential(undefined, COMPANY, HOST, "ghnpm-1")).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("ghnpm-1"));
    const failing: CompanyRegistryStore = { entries: async () => [], token: async () => { throw new Error(`denied ${PAT}`); } };
    const error = await companyRegistryCredential(failing, COMPANY, HOST, "ghnpm-1").catch((caught: unknown) => caught as Error);
    expect(error.message).toContain(REGISTRY_UNAVAILABLE_MESSAGE("ghnpm-1"));
    expect(error.message).not.toContain(PAT);
  });
  it("still mints a CodeArtifact token, held to its lease: one hour and a minute of skew, never longer", async () => {
    const now = new Date("2026-11-23T10:00:00.000Z");
    const asked: unknown[] = [];
    const minter = (seconds: number) => async (request: unknown) => { asked.push(request); return { token: fakePat("c"), expiresAt: new Date(now.getTime() + seconds * 1_000) }; };
    const credential = await mintCodeArtifactCredential(CODEARTIFACT, minter(REGISTRY_TOKEN_SECONDS), () => now);
    expect(credential).toStrictEqual({ username: "aws", token: fakePat("c"), expiresAt: new Date(now.getTime() + REGISTRY_TOKEN_SECONDS * 1_000).toISOString() });
    expect(asked).toEqual([{ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds: REGISTRY_TOKEN_SECONDS }]);
    await expect(mintCodeArtifactCredential(CODEARTIFACT, minter(REGISTRY_TOKEN_SECONDS + 3_600), () => now)).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
    await expect(mintCodeArtifactCredential(CODEARTIFACT, minter(-5), () => now)).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
    await expect(mintCodeArtifactCredential(CODEARTIFACT, undefined, () => now)).rejects.toThrow(REGISTRY_UNAVAILABLE_MESSAGE("internal-npm"));
  });
});

describe("the registries a prepare carries", () => {
  const base = (company = companyStore()) => ({ companyId: COMPANY, install: { company: company.store } as ProjectRegistriesInstall });
  it("are the company's entries, for a project that names none: where they are, never how to reach them", async () => {
    const answer = await registriesPrepareFor({ ...base(), project: project("payments") });
    expect(answer.registries).toHaveLength(2);
    expect(answer.registries?.[0]).toStrictEqual({ name: "ghnpm-1", kind: "npm", format: "npm", url: "https://npm.pkg.github.com/", scope: "@acme" });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(PAT);
    expect(text).not.toContain("credentialRef");
  });
  it("are the same for every project of the company, and only that company's", async () => {
    const company = companyStore({ entries: { [COMPANY]: [ENTRY] } });
    expect(await registriesPrepareFor({ ...base(company), project: project("one") })).toEqual(await registriesPrepareFor({ ...base(company), project: project("two") }));
    expect(await registriesPrepareFor({ companyId: OTHER_COMPANY, install: { company: company.store }, project: project("one") })).toEqual({});
    expect(company.entryReads).toEqual([COMPANY, COMPANY, OTHER_COMPANY]);
    expect(company.tokenReads).toEqual([]);
  });
  it("are none for a preparation that only reads, and none when the company set none or the install has no company store", async () => {
    expect(await registriesPrepareFor({ ...base(), project: project("payments"), readOnly: true })).toEqual({});
    expect(await registriesPrepareFor({ ...base(companyStore({ entries: {} })), project: project("payments") })).toEqual({});
    expect(await registriesPrepareFor({ companyId: COMPANY, install: undefined, project: project("payments") })).toEqual({});
  });
  it("need no approved website of the project and no edition for a company's host", async () => {
    const withNothing = project("payments", { network: { allowedDomains: [] } });
    expect((await registriesPrepareFor({ companyId: COMPANY, install: { company: companyStore().store, edition: "public" }, project: withNothing })).registries).toHaveLength(2);
  });
  it("refuse the start in fixed words when the store cannot list, or there are too many", async () => {
    await expect(registriesPrepareFor({ ...base(companyStore({ failEntries: true })), project: project("payments") })).rejects.toThrow(COMPANY_REGISTRIES_UNREADABLE);
    const many = companyStore({ entries: { [COMPANY]: [{ host: HOST, scopes: Array.from({ length: 9 }, (_, index) => `@s${String(index)}`) }] } });
    await expect(registriesPrepareFor({ ...base(many), project: project("payments") })).rejects.toThrow(REGISTRIES_TOO_MANY);
    // The sentence never carries what the store said.
    const error = await registriesPrepareFor({ ...base(companyStore({ failEntries: true })), project: project("payments") }).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(PAT);
  });
  it("keep CodeArtifact to an enterprise install that bound the domain to this company, and add the company's entries beside it", async () => {
    const withCodeArtifact = project("payments", { registries: [CODEARTIFACT], network: { allowedDomains: ["acme-123456789012.d.codeartifact.us-west-2.amazonaws.com"] } });
    const minter = async () => ({ token: PAT, expiresAt: new Date() });
    const bound = [{ name: "acme", owner: "123456789012", region: "us-west-2", orgId: COMPANY as never, repositories: ["shared"] }];
    await expect(registriesPrepareFor({ companyId: COMPANY, install: { codeArtifact: minter, edition: "public", boundDomains: bound }, project: withCodeArtifact })).rejects.toThrow("does not support project package registries");
    await expect(registriesPrepareFor({ companyId: OTHER_COMPANY, install: { codeArtifact: minter, edition: "enterprise", boundDomains: bound }, project: withCodeArtifact })).rejects.toThrow("CodeArtifact domain");
    await expect(registriesPrepareFor({ companyId: COMPANY, install: { edition: "enterprise", boundDomains: bound }, project: withCodeArtifact })).rejects.toThrow(REGISTRIES_NOT_AVAILABLE);
    const both = await registriesPrepareFor({ companyId: COMPANY, install: { codeArtifact: minter, edition: "enterprise", boundDomains: bound, company: companyStore().store }, project: withCodeArtifact });
    expect(both.registries?.map((entry) => entry.name)).toEqual(["internal-npm", "ghnpm-1", "ghnpm-2"]);
  });
});

/** The callback service over a store with both companies' records, a grant service and the company's package tokens. */
function world(options: { install?: "company" | "none"; company?: ReturnType<typeof companyStore>; projectOverride?: ProjectDefinition; operation?: Record<string, unknown>; workspace?: Record<string, unknown>; failAudit?: boolean; codeArtifact?: boolean; noRequester?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const company = options.company ?? companyStore();
  const grants = new RepositoryGrantService(Buffer.alloc(32, 7), async () => ({ token: "unused" }));
  const log = vi.fn();
  const audit: AuditEvent[] = [];
  const auditSink = { stage: () => [], record: async (event: AuditEvent) => { if (options.failAudit === true) throw new Error(`ledger down ${PAT}`); audit.push(event); } };
  const projects = { payments: options.projectOverride ?? project("payments"), billing: project("billing") };
  const seeded = (async () => {
    for (const owner of [COMPANY, OTHER_COMPANY]) {
      for (const definition of Object.values(projects)) {
        await store.put({ item: { ...projectRevisionKey(owner, definition.name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
        await store.put({ item: { ...orgProjectCatalogKey(owner, definition.name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
      }
      for (const [workspace, operation, name] of [[WS, OP, "payments"], [WS2, OP2, "billing"]] as const) {
        const own = owner === COMPANY && workspace === WS;
        await store.put({ item: { ...workspaceKey(owner, workspace), companyId: owner, orgId: owner, id: workspace, projectName: name, projectRevision: 1, status: "PREPARING", activeOperationId: operation, fence: 1, ...(own ? options.workspace ?? {} : {}) } });
        await store.put({ item: { ...operationKey(owner, workspace, operation), companyId: owner, id: operation, workspaceId: workspace, kind: "prepare", status: "RUNNING", fence: 1, ...(own && options.noRequester === true ? {} : { requester: { personId: "person-1", provider: "local-owner" } }), ...(own ? options.operation ?? {} : {}) } });
      }
    }
  })();
  const minted: unknown[] = [];
  const install: ProjectRegistriesInstall | undefined = options.install === "none" ? undefined : {
    company: company.store,
    ...(options.codeArtifact === true ? { codeArtifact: async (request: unknown) => { minted.push(request); return { token: fakePat("c"), expiresAt: new Date(Date.now() + 3_600_000) }; }, edition: "enterprise" as const, boundDomains: [{ name: "acme", owner: "123456789012", region: "us-west-2", orgId: COMPANY, repositories: ["shared"] }] } : {}),
  };
  const handlerFor = (owner: string) => createCallbackHandler({ flow: { store, companyId: owner, callbackSigningKey: KEY, projects: createStoreProjectSource(store, owner), projectRegistries: install, audit: auditSink, log } as never, blobs: {} as never, grants });
  const grant = (input: { project?: string; workspaceId?: string; operationId?: string } = {}) => grants.issue({ ownerKey: "owner", projectName: input.project ?? "payments", workspaceId: input.workspaceId ?? WS, operationId: input.operationId ?? OP, repositories: [{ credentialRef: "github-app", repositoryUrl: REPOSITORY.url, access: "clone" }] });
  const ask = async (input: { company?: string; registry?: string; grantValue?: string | null; workspaceId?: string; operationId?: string; body?: unknown } = {}) => {
    await seeded;
    const workspaceId = input.workspaceId ?? WS;
    const operationId = input.operationId ?? OP;
    const grantValue = input.grantValue === undefined ? grant({ project: workspaceId === WS2 ? "billing" : "payments", workspaceId, operationId }) : input.grantValue;
    return await handlerFor(input.company ?? COMPANY)({
      method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/registry-credentials`,
      headers: grantValue === null ? {} : { "x-agentx-repository-grant": grantValue }, body: JSON.stringify(input.body ?? { registry: input.registry ?? "ghnpm-1" }),
    });
  };
  const everythingStored = async (): Promise<string> => {
    await seeded;
    const items: unknown[] = [];
    for (let cursor: string | undefined, page = await store.scanPage({ limit: 500 }); ; page = await store.scanPage({ limit: 500, cursor })) {
      items.push(...page.items);
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
    return JSON.stringify(items);
  };
  return { store, company, grants, grant, ask, log, audit, minted, everythingStored };
}
const errorOf = (answer: { body?: string | undefined }): string => (JSON.parse(answer.body ?? "{}") as { error?: { message?: string } }).error?.message ?? "";

describe("the registry credential route", () => {
  it("gives the company's token to a running preparation, with no expiry, no cache, and a line that names no secret", async () => {
    const w = world();
    const answer = await w.ask();
    expect(answer.statusCode, answer.body).toBe(200);
    expect(JSON.parse(answer.body ?? "")).toStrictEqual({ credential: { token: PAT } });
    expect(answer.headers?.["cache-control"]).toBe("no-store");
    expect(w.company.tokenReads).toEqual([{ companyId: COMPANY, host: HOST }]);
    expect(w.log).toHaveBeenCalledTimes(1);
    expect(w.log.mock.calls[0]?.[0]).toMatchObject({ event: "registry.credential_issued", registry: "ghnpm-1", kind: "npm", workspaceId: WS, operationId: OP });
    const everything = JSON.stringify(w.log.mock.calls) + JSON.stringify(w.audit) + await w.everythingStored();
    expect(everything).not.toContain(PAT);
    expect(everything).not.toContain("pkgreg_");
  });

  it("gives every project of the company the same company token, and a second scope the same one", async () => {
    const w = world();
    expect(JSON.parse((await w.ask({ workspaceId: WS2, operationId: OP2 })).body ?? "")).toStrictEqual({ credential: { token: PAT } });
    expect(JSON.parse((await w.ask({ registry: "ghnpm-2" })).body ?? "")).toStrictEqual({ credential: { token: PAT } });
  });

  it("reads the token at every use, never from a cache", async () => {
    const w = world();
    for (let count = 0; count < 3; count += 1) expect((await w.ask()).statusCode).toBe(200);
    expect(w.company.tokenReads).toHaveLength(3);
  });

  it("gives company B's preparation B's token or nothing, never A's, even when the store would answer A's host for A", async () => {
    const both = world({ company: companyStore({ tokens: { [`${COMPANY}|${HOST}`]: PAT, [`${OTHER_COMPANY}|${HOST}`]: OTHER_PAT } }) });
    expect(JSON.parse((await both.ask({ company: OTHER_COMPANY })).body ?? "")).toStrictEqual({ credential: { token: OTHER_PAT } });
    expect(both.company.tokenReads).toEqual([{ companyId: OTHER_COMPANY, host: HOST }]);
    const notSet = world({ company: companyStore({ tokens: { [`${COMPANY}|${HOST}`]: PAT } }) });
    const answer = await notSet.ask({ company: OTHER_COMPANY });
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(answer.body).not.toContain(PAT);
    expect(notSet.company.tokenReads).toEqual([{ companyId: OTHER_COMPANY, host: HOST }]);
    expect(notSet.audit).toEqual([]);
  });

  it("takes the company from the stored record: a workspace of company A is not found through company B's flow", async () => {
    const w = world();
    const otherWorkspace = "55555555-5555-4555-8555-555555555555";
    const otherOperation = "66666666-6666-4666-8666-666666666666";
    await w.store.put({ item: { ...workspaceKey(COMPANY, otherWorkspace), companyId: COMPANY, orgId: COMPANY, id: otherWorkspace, projectName: "payments", projectRevision: 1, status: "PREPARING", activeOperationId: otherOperation, fence: 1 } });
    await w.store.put({ item: { ...operationKey(COMPANY, otherWorkspace, otherOperation), companyId: COMPANY, id: otherOperation, workspaceId: otherWorkspace, kind: "prepare", status: "RUNNING", fence: 1 } });
    const answer = await w.ask({ company: OTHER_COMPANY, workspaceId: otherWorkspace, operationId: otherOperation, grantValue: w.grant({ workspaceId: otherWorkspace, operationId: otherOperation }) });
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.company.tokenReads).toEqual([]);
  });

  it("offers each company only the registries ITS company set", async () => {
    const w = world({ company: companyStore({ entries: { [COMPANY]: [ENTRY], [OTHER_COMPANY]: [{ host: HOST, scopes: ["@only"] }] }, tokens: { [`${COMPANY}|${HOST}`]: PAT, [`${OTHER_COMPANY}|${HOST}`]: OTHER_PAT } }) });
    expect((await w.ask({ registry: "ghnpm-2" })).statusCode).toBe(200);
    expect((await w.ask({ company: OTHER_COMPANY, registry: "ghnpm-1" })).statusCode).toBe(200);
    expect((await w.ask({ company: OTHER_COMPANY, registry: "ghnpm-2" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("records every use in the company's audit ledger BEFORE the credential leaves: who, when, which host and scope, never the value", async () => {
    const w = world();
    await w.ask();
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ companyId: COMPANY, action: "registry_secret.used", actor: { type: "person", id: "person-1" }, details: { registry: "ghnpm-1", host: HOST, scope: "@acme", project: "payments", workspaceId: WS, operationId: OP } });
    expect(typeof w.audit[0]?.at).toBe("string");
    expect(JSON.stringify(w.audit)).not.toContain(PAT);
    const system = world({ noRequester: true });
    await system.ask();
    expect(system.audit[0]?.actor).toEqual({ type: "system", id: "prepare" });
  });

  it("gives nothing when the use cannot be recorded", async () => {
    const w = world({ failAudit: true });
    const answer = await w.ask();
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(answer.body).not.toContain(PAT);
    expect(w.log).not.toHaveBeenCalled();
  });

  it("still gives a project's CodeArtifact token, minted for an hour, beside the company's", async () => {
    const withCodeArtifact = project("payments", { registries: [CODEARTIFACT], network: { allowedDomains: ["acme-123456789012.d.codeartifact.us-west-2.amazonaws.com"] } });
    const w = world({ projectOverride: withCodeArtifact, codeArtifact: true });
    const answer = await w.ask({ registry: "internal-npm" });
    expect(answer.statusCode, answer.body).toBe(200);
    const credential = (JSON.parse(answer.body ?? "") as { credential: { username: string; token: string; expiresAt: string } }).credential;
    expect(credential.username).toBe("aws");
    expect(Date.parse(credential.expiresAt) - Date.now()).toBeLessThanOrEqual((REGISTRY_TOKEN_SECONDS + 60) * 1_000);
    expect(w.minted).toEqual([{ domain: "acme", domainOwner: "123456789012", region: "us-west-2", durationSeconds: REGISTRY_TOKEN_SECONDS }]);
    expect(w.company.tokenReads).toEqual([]);
  });

  it.each([
    ["a request with no grant", { grantValue: null }],
    ["a grant that is not signed", { grantValue: "forged.value" }],
    ["a registry the broker did not offer", { registry: "other-registry" }],
    ["a registry name past the company's scopes", { registry: "ghnpm-3" }],
    ["a request with another field in it", { body: { registry: "ghnpm-1", extra: true } }],
    ["a request with a host in it", { body: { registry: "ghnpm-1", host: "npm.pkg.github.com" } }],
    ["a request with no registry", { body: {} }],
  ])("refuses %s, and reads no token", async (_name, input) => {
    const w = world();
    const answer = await w.ask(input);
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.company.tokenReads).toEqual([]);
    expect(answer.body).not.toContain(PAT);
    expect(w.audit).toEqual([]);
  });

  it("refuses a grant issued for another workspace, operation or project", async () => {
    for (const grantValue of [world().grant({ workspaceId: WS2, operationId: OP2 }), world().grant({ operationId: OP2 }), world().grant({ project: "billing" })]) {
      const w = world();
      const answer = await w.ask({ grantValue });
      expect(answer.statusCode, answer.body).toBeGreaterThanOrEqual(400);
      expect(w.company.tokenReads).toEqual([]);
    }
  });

  it.each([
    ["a task", { operation: { kind: "task" } }],
    ["a publication", { operation: { kind: "publish" } }],
    ["a preparation that has ended", { operation: { status: "SUCCEEDED" } }],
    ["a preparation that failed", { operation: { status: "FAILED" } }],
    ["an operation that is no longer the workspace's own", { workspace: { activeOperationId: "77777777-7777-4777-8777-777777777777" } }],
    ["a workspace that is not preparing", { workspace: { status: "BUSY" } }],
    ["an operation of an older fence", { operation: { fence: 0 } }],
  ])("refuses %s, and reads no token", async (_name, options) => {
    const w = world(options);
    const answer = await w.ask();
    expect(answer.statusCode, answer.body).toBeGreaterThanOrEqual(400);
    expect(w.company.tokenReads).toEqual([]);
    expect(answer.body).not.toContain(PAT);
  });

  it("refuses everything on an install that serves no registry", async () => {
    const w = world({ install: "none" });
    const answer = await w.ask();
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorOf(answer)).toBe(REGISTRIES_NOT_AVAILABLE);
  });

  it("gives at most one batch of answers to a preparation", async () => {
    const w = world();
    for (let count = 0; count < REGISTRY_REQUESTS_MAX_PER_OPERATION; count += 1) expect((await w.ask()).statusCode).toBe(200);
    const refused = await w.ask();
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.company.tokenReads).toHaveLength(REGISTRY_REQUESTS_MAX_PER_OPERATION);
  });

  it("answers a token that is not saved and a failing store in one fixed sentence that quotes neither the secret's name nor its value", async () => {
    const missing = world({ company: companyStore({ tokens: {} }) });
    const answer = await missing.ask();
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorOf(answer)).toContain(REGISTRY_UNAVAILABLE_MESSAGE("ghnpm-1"));
    expect(answer.body).not.toContain("pkgreg_");
    const failing = world();
    failing.company.store.token = async () => { throw new Error(`denied pkgreg_ghnpm ${PAT}`); };
    const failed = await failing.ask();
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(failed.body).not.toContain(PAT);
    expect(failed.body).not.toContain("pkgreg_");
    expect(JSON.stringify(failing.log.mock.calls)).not.toContain(PAT);
    expect(failing.audit).toEqual([]);
  });
});
