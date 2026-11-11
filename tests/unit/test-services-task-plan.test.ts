// Test services: which dependencies a task's plan starts (pinned from the signed catalog), when an approved environment with dependencies may be used by a task, and what happens when it cannot be planned.
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, TestEnvTaskPlanSchema, testEnvDigest, type OrgId, type ProjectCommand, type TestEnvironment, type TestEnvironmentBody, type VerifiedCatalog } from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, TEST_SERVICES_MIN_CATALOG_REVISION, dependenciesStartableNow, serviceCatalogSourceOf, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS } from "../../packages/broker/src/core/test-env/devcontainer-check.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { UNUSED_WORDS, environmentUnusedReason, testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { loaderTrusting, pinnedCatalog, testSigner, unpinnedCatalog, verifiedCatalog, digestOfId } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";
import { projectStore } from "../support/test-env-world.js";
import { CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, parseBundlePublicKey, sha256HexOf } from "@agentx/contracts";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const postgres = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round", ...over,
});
const body = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  dependencies: [postgres()], ...over,
});
const asEnvironment = (environment: TestEnvironmentBody, revision = 1): TestEnvironment => ({ revision, approvedAt: "2026-11-03T10:00:00.000Z", environment });
const catalog = (): VerifiedCatalog => verifiedCatalog(pinnedCatalog());

describe("which dependencies a plan starts", () => {
  it("pins a Postgres from the catalog: its repository, digest and the project's own names", async () => {
    const result = taskDependencyPlansOf({ body: body(), catalog: catalog(), edition: "public" });
    expect(result).toEqual({ ok: true, dependencies: [{
      id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: digestOfId("postgres@16"),
      config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round",
    }] });
    // What it sends is a plan the wire accepts.
    if (!result.ok) throw new Error("not planned");
    expect(TestEnvTaskPlanSchema.safeParse({ revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: result.dependencies }).success).toBe(true);
  });

  it("takes the catalog entry's default names when the dependency lists none", () => {
    const result = taskDependencyPlansOf({ body: body({ dependencies: [postgres({ connect: { env: [], hostAliases: [] } })] }), catalog: catalog(), edition: "public" });
    expect(result.ok && result.dependencies[0]!.aliases.length).toBeGreaterThan(0);
  });

  it("refuses, in fixed words, whatever it cannot pin", () => {
    const refusal = (over: Parameters<typeof taskDependencyPlansOf>[0]) => { const result = taskDependencyPlansOf(over); return result.ok ? "ok" : result.reason; };
    expect(refusal({ body: body(), catalog: undefined, edition: "public" })).toBe("no_catalog");
    expect(refusal({ body: body(), catalog: verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION)), edition: "public" })).toBe("not_pinned");
    expect(refusal({ body: body(), catalog: verifiedCatalog(pinnedCatalog((entries) => { for (const entry of entries) if (entry["id"] === "postgres@16") entry["status"] = "retired"; })), edition: "public" })).toBe("retired");
    expect(refusal({ body: body({ dependencies: [postgres({ backing: { kind: "local", catalogId: "postgres@99", config: {} } })] }), catalog: catalog(), edition: "public" })).toBe("not_in_catalog");
    expect(refusal({ body: body({ dependencies: [postgres({ family: "mysql", kind: "database", connect: { env: [], hostAliases: [] } })] }), catalog: catalog(), edition: "public" })).toBe("not_in_catalog");
    // An older catalog than the release's minimum is refused: a rolled-back catalog could pin a digest later found critical (TS-IMG-2).
    expect(refusal({ body: body(), catalog: verifiedCatalog(pinnedCatalog()), edition: "public", minCatalogRevision: TEST_SERVICES_MIN_CATALOG_REVISION + 1 })).toBe("catalog_too_old");
  });

  it("cannot even load a catalog marked pinned that holds an entry with no digest (the catalog's own schema refuses it, so no plan is ever made from one)", () => {
    expect(() => pinnedCatalog((entries) => { for (const entry of entries) if (entry["id"] === "postgres@16") delete (entry["image"] as { digest?: string }).digest; })).toThrow(/pinned entry has a digest/u);
  });

  it("starts real software from the catalog only (every other backing is not available yet)", () => {
    const refusal = (dependency: Record<string, unknown>) => { const result = taskDependencyPlansOf({ body: body({ dependencies: [dependency] }), catalog: catalog(), edition: "public" }); return result.ok ? "ok" : result.reason; };
    expect(refusal(postgres({ backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" }, connect: { env: [], hostAliases: [] } }))).toBe("not_available_yet");
    expect(refusal(postgres({ backing: { kind: "project_image", imageId: "mine" } }))).toBe("not_available_yet");
    expect(refusal(postgres({ backing: { kind: "none", reason: "declined" }, connect: { env: [], hostAliases: [] } }))).toBe("not_available_yet");
    expect(refusal(postgres({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: "c".repeat(64), catalogDigest: digestOfId("postgres@16"), approvalRef: "approval-123456" } } }))).toBe("not_available_yet");
    expect(refusal(postgres({ workingBacking: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } }))).toBe("not_available_yet");
    expect(refusal(postgres({ fallback: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } }))).toBe("not_available_yet");
    expect(refusal(postgres({ workingBacking: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } } }))).toBe("ok");
    for (const words of Object.values(DEPENDENCY_PLAN_REFUSAL_WORDS)) expect(words).not.toMatch(/postgres|digest|sha256/iu);
  });

  it("refuses an edition the entry is not offered in", () => {
    const only = verifiedCatalog(pinnedCatalog((entries) => { for (const entry of entries) if (entry["id"] === "postgres@16") entry["editions"] = ["enterprise"]; }));
    expect(taskDependencyPlansOf({ body: body(), catalog: only, edition: "public" })).toMatchObject({ ok: false, reason: "not_in_edition" });
    expect(taskDependencyPlansOf({ body: body(), catalog: only, edition: "enterprise" }).ok).toBe(true);
  });

  it("has a minimum catalog revision of the release", () => {
    expect(TEST_SERVICES_MIN_CATALOG_REVISION).toBeGreaterThanOrEqual(1);
  });
});

describe("the signed catalog source", () => {
  async function signed(change: (raw: ReturnType<typeof pinnedCatalog>) => unknown = (raw) => raw) {
    const signer = testSigner();
    const catalogBytes = Buffer.from(`${JSON.stringify(change(pinnedCatalog()), null, 2)}\n`, "utf8");
    const signature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64") };
    return { signer, catalogBytes, signatureBytes: Buffer.from(JSON.stringify(signature)) };
  }
  const trust = { runningAccountId: undefined };

  it("loads the catalog once, verified, and refuses a bad signature, an untrusted key and a catalog older than the minimum", async () => {
    const good = await signed();
    let reads = 0;
    const source = serviceCatalogSourceOf({ read: async () => { reads += 1; return good; }, trust, load: loaderTrusting(good.signer.publicKeyPem), minRevision: 1 });
    expect((await source())?.pinned).toBe(true);
    await source();
    expect(reads).toBe(1);
    const other = serviceCatalogSourceOf({ read: async () => good, trust, load: loaderTrusting(testSigner().publicKeyPem), minRevision: 1 });
    expect(await other()).toBeUndefined();
    const old = serviceCatalogSourceOf({ read: async () => good, trust, load: loaderTrusting(good.signer.publicKeyPem), minRevision: TEST_SERVICES_MIN_CATALOG_REVISION + 1 });
    expect(await old()).toBeUndefined();
    const broken = serviceCatalogSourceOf({ read: async () => { throw new Error("no file"); }, trust, load: loaderTrusting(good.signer.publicKeyPem), minRevision: 1 });
    expect(await broken()).toBeUndefined();
    const tampered = serviceCatalogSourceOf({ read: async () => ({ ...good, catalogBytes: Buffer.concat([good.catalogBytes, Buffer.from(" ")]) }), trust, load: loaderTrusting(good.signer.publicKeyPem), minRevision: 1 });
    expect(await tampered()).toBeUndefined();
  });

  it("takes its keys from the contract's trust lists and nothing else: with them empty (today) nothing verifies, and the reason is said", async () => {
    const good = await signed();
    const reasons: string[] = [];
    const source = serviceCatalogSourceOf({ read: async () => good, trust: { runningAccountId: "123456789012" }, onRefused: (reason) => reasons.push(reason) });
    expect(await source()).toBeUndefined();
    expect(reasons).toEqual(["no trusted catalog key"]);
  });

  it("asks for the trust when it loads, so an account learned later is used", async () => {
    const good = await signed();
    const seen: Array<string | undefined> = [];
    const source = serviceCatalogSourceOf({ read: async () => good, trust: () => { const context = { runningAccountId: seen.length === 0 ? undefined : "123456789012" }; seen.push(context.runningAccountId); return context; }, load: loaderTrusting(good.signer.publicKeyPem) });
    expect((await source())?.pinned).toBe(true);
    expect(seen).toEqual([undefined]);
  });
});

describe("when a task may use an environment with dependencies", () => {
  it("is used with tx on and a real Postgres from the catalog", () => {
    expect(environmentUnusedReason(asEnvironment(body()), ON)).toBeUndefined();
  });

  it("is not used with tx off, whatever else is on (today's behaviour for anything it did not know)", () => {
    expect(environmentUnusedReason(asEnvironment(body()), { ROVARA_TEST_ENVIRONMENT: "1" })).toBe("dependencies_not_connected");
    expect(environmentUnusedReason(asEnvironment(body()), { ROVARA_TEST_SERVICES: "true" })).toBe("dependencies_not_connected");
    expect(environmentUnusedReason(asEnvironment(body({ dependencies: undefined })), {})).toBeUndefined();
  });

  it("is not used when a dependency is backed by anything but real catalog software", () => {
    const fake = postgres({ backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" }, connect: { env: [], hostAliases: [] } });
    expect(environmentUnusedReason(asEnvironment(body({ dependencies: [fake] })), ON)).toBe("dependencies_not_available_yet");
    expect(environmentUnusedReason(asEnvironment(body({ dependencies: [postgres(), fake, ].map((entry, index) => index === 1 ? { ...fake, id: "other", connect: { env: [], hostAliases: [] } } : entry) })), ON)).toBe("dependencies_not_available_yet");
    expect(dependenciesStartableNow([postgres()] as never)).toBe(true);
    expect(dependenciesStartableNow([fake] as never)).toBe(false);
  });

  it("keeps v1 services refused, and the tier and account rules as they were", () => {
    const withService = body({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    expect(environmentUnusedReason(asEnvironment(withService), ON)).toBe("services_not_connected");
    expect(UNUSED_WORDS.dependencies_not_connected).toMatch(/dependenc/iu);
    expect(UNUSED_WORDS.dependencies_not_available_yet).toMatch(/not .*yet/iu);
  });
});

/** The environment approved through the gate, the task's pin written as a task start would write it, and the project (with or without a dev container) in the store. */
async function pinned(environment = body(), env: NodeJS.ProcessEnv = ON, options: { devcontainer?: boolean; registered?: boolean } = {}) {
  const h = await bench({ project: PROJECT, env, ...options });
  const proposal = await h.proposeAndProve(environment);
  expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
  const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, env);
  if (start.pin !== undefined) await h.store.transact([start.pin]);
  return Object.assign(h, { start });
}
type Pinned = Awaited<ReturnType<typeof pinned>>;
const readiness = [cmd("pytest", ["-q"])];
const planOf = (h: Pinned, env: NodeJS.ProcessEnv = ON) => testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, env);
const withDevcontainer = (h: Pinned) => projectStore(ORG, PROJECT, { devcontainer: true, store: h.store });

describe("the plan of a run with dependencies", () => {
  it("carries the pinned dependencies, and the environment's digest", async () => {
    const h = await pinned();
    h.deps.serviceCatalog = async () => catalog();
    const plan = (await planOf(h))!;
    expect(plan.digest).toBe(testEnvDigest(body()));
    expect(plan.dependencies?.map((entry) => [entry.id, entry.catalogId, entry.digest])).toEqual([["postgres", "postgres@16", digestOfId("postgres@16")]]);
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("is the plain plan, with no `dependencies` key, for an environment without any", async () => {
    const h = await pinned(body({ dependencies: undefined }));
    expect("dependencies" in (await planOf(h))!).toBe(false);
  });

  it("refuses the run, in fixed words, when the catalog cannot pin a dependency (never a plan without it)", async () => {
    const h = await pinned();
    await expect(planOf(h)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.no_catalog);
    h.deps.serviceCatalog = async () => verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION));
    await expect(planOf(h)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.not_pinned);
    h.deps.serviceCatalog = async () => { throw new Error("boom: secret-looking text"); };
    await expect(planOf(h)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.no_catalog);
  });

  it("gives no plan at all with test services off, and never reads the catalog", async () => {
    const h = await pinned();
    let reads = 0;
    h.deps.serviceCatalog = async () => { reads += 1; return catalog(); };
    expect(await planOf(h, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("the plan a coding run is sent (the working sandbox gets the dependencies)", () => {
  const implementPlan = (h: Pinned, env: NodeJS.ProcessEnv = ON) => testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, env);

  it("carries the pinned dependencies, with the same pinning as the checks, and needs no readiness commands", async () => {
    const h = await pinned();
    h.deps.serviceCatalog = async () => catalog();
    const plan = (await implementPlan(h))!;
    expect(plan.digest).toBe(testEnvDigest(body()));
    expect(plan.dependencies?.map((entry) => [entry.id, entry.catalogId, entry.digest])).toEqual([["postgres", "postgres@16", digestOfId("postgres@16")]]);
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.lastNightlyFailures).toBeUndefined();
  });

  it("is nothing with test services off (and nothing is read), and nothing for an environment without dependencies or a task without a pin", async () => {
    const h = await pinned();
    h.deps.serviceCatalog = async () => catalog();
    const reads = vi.fn();
    const counting = new Proxy(h.store, { get: (target, name, receiver) => { const value: unknown = Reflect.get(target, name, receiver); return typeof value === "function" ? (...args: unknown[]) => { reads(name); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value; } });
    h.deps.store = counting;
    expect(await implementPlan(h, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
    expect(await implementPlan(h, { ROVARA_TEST_ENVIRONMENT: "0", ROVARA_TEST_SERVICES: "1" })).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    const without = await pinned(body({ dependencies: undefined }));
    expect(await implementPlan(without)).toBeUndefined();
    const none = await pinned();
    expect(await testEnvImplementPlanFor(none.deps, { orgId: ORG, project: PROJECT, taskId: "t9" }, ON)).toBeUndefined();
  });

  it("refuses the run, in fixed words, when the catalog cannot pin it or the project has a dev container", async () => {
    const h = await pinned();
    await expect(implementPlan(h)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.no_catalog);
    h.deps.serviceCatalog = async () => verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION));
    await expect(implementPlan(h)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.not_pinned);
    h.deps.serviceCatalog = async () => catalog();
    await withDevcontainer(h);
    await expect(implementPlan(h)).rejects.toThrow(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
  });
});

describe("dependencies and a dev container (not available yet)", () => {
  const propose = async (options: { devcontainer?: boolean; registered?: boolean; env?: NodeJS.ProcessEnv }, environment: TestEnvironmentBody) => {
    const h = await bench({ project: PROJECT, ...(options.env === undefined ? {} : { env: options.env }), ...(options.devcontainer === undefined ? {} : { devcontainer: options.devcontainer }), ...(options.registered === undefined ? {} : { registered: options.registered }) });
    return h.propose(environment);
  };

  it("refuses to propose dependencies for a project with a dev container, in fixed words", async () => {
    await expect(propose({ devcontainer: true }, body())).rejects.toThrow(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
    // A project whose settings cannot be read counts as using one.
    await expect(propose({ registered: false }, body())).rejects.toThrow(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
    expect((await propose({ devcontainer: false }, body())).digest).toBe(testEnvDigest(body()));
  });

  it("does not change the behaviour for a project with a dev container and no dependencies", async () => {
    const plain = body({ dependencies: undefined });
    expect((await propose({ devcontainer: true }, plain)).digest).toBe(testEnvDigest(plain));
    expect((await propose({ registered: false }, plain)).digest).toBe(testEnvDigest(plain));
  });

  it("refuses at approval too (a dev container added after the proposal)", async () => {
    const h = await bench({ project: PROJECT });
    const proposal = await h.proposeAndProve(body());
    await projectStore(ORG, PROJECT, { devcontainer: true, store: h.store });
    expect(await h.approve(proposal.digest)).toMatchObject({ status: "refused", reason: "invalid", detail: DEPENDENCIES_WITH_DEVCONTAINER_WORDS });
  });

  it("also refuses test services off, and a backing that is not real catalog software, at proposal", async () => {
    await expect(propose({ env: { ROVARA_TEST_ENVIRONMENT: "1" } }, body())).rejects.toThrow(/not switched on/u);
    const fake = postgres({ backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" }, connect: { env: [], hostAliases: [] } });
    await expect(propose({}, body({ dependencies: [fake] }))).rejects.toThrow(/not available yet/u);
  });

  it("starts no task on it: the pin says why", async () => {
    const h = await bench({ project: PROJECT });
    const proposal = await h.proposeAndProve(body());
    expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
    await projectStore(ORG, PROJECT, { devcontainer: true, store: h.store });
    const started = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t2" }, ON);
    expect(started.used).toBeUndefined();
    expect((started.pin as { item: { unused?: string } }).item.unused).toBe("dependencies_with_devcontainer");
    expect(UNUSED_WORDS.dependencies_with_devcontainer).toBe(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
  });

  it("refuses the plan at dispatch when the project got a dev container after the task started", async () => {
    const h = await pinned();
    expect(h.start.used).toBeDefined();
    h.deps.serviceCatalog = async () => catalog();
    await withDevcontainer(h);
    await expect(planOf(h)).rejects.toThrow(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
  });
});
