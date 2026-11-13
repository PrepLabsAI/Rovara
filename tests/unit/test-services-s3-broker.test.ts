// Test services, broker side: a fake backing in the plan, only for an APPROVED fixture set of the task's own company; the fixture-set delivery callback and who may call it; the evidence label
// and the unmatched count; and the Prove usage step. With tx off, or with no fake, everything reads as it did.
import { describe, expect, it } from "vitest";
import {
  FixtureSetSchema, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, fixtureEntry, fixtureSetDigest, TEST_SERVICES_FAKE_USAGE_WORDS, testEnvDigest,
  type FixtureSet, type OrgId, type ProjectCommand, type TestEnvironment, type TestEnvironmentBody, type TestServicesUsageRecord, type VerifiedCatalog,
} from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, TEST_SERVICES_MIN_CATALOG_REVISION, dependenciesStartableNow, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { approvedFixturesOf, fixtureDigestsOfEnvironment, fixtureDigestsOfPlan, recordsOf, type FixtureStoreFactory } from "../../packages/broker/src/core/test-env/fixture-lookup.js";
import { createFixtureStore, createMemoryFixturePorts, verifiedFixtureDecision, type FixtureStore } from "../../packages/broker/src/core/test-env/fixture-store.js";
import { environmentUnusedReason, testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { testEnvPlanFor, testEnvImplementPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { pinnedFakeOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { FAKE_USAGE_ITEM_ID, dependencyEvidenceOf, type PinnedDependency, type RawUsage } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { packDependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { dependencyStepsOf } from "../../packages/broker/src/core/test-env/prove-from-setup-check.js";
import { dependencyCardLines } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const ORG: OrgId = BENCH_ORG;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const NOW = new Date("2026-11-03T10:00:00.000Z");
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });

// ---- a fixture set, and a store that holds it (approved for ORG)

const dependencyOfSet = { id: "payments", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const makeSet = (over: Record<string, unknown> = {}): FixtureSet => FixtureSetSchema.parse({
  schemaVersion: 2, dependency: dependencyOfSet, origin: "written", writtenBy: "Priya", revision: 3, syntheticOnly: true, match,
  entries: [fixtureEntry({ dependency: dependencyOfSet, match }, { method: "GET", path: "/v1/ping", contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body: '{"ok":true}', latencyMs: 0 })],
  faults: [], ...over,
});
const recordedSet = (): FixtureSet => makeSet({ origin: "recorded", writtenBy: undefined, recordedAt: "2026-10-20T08:00:00.000Z", revision: 5 });
const DENY = { accountIds: [], hosts: [], arnPrefixes: [] };
function storeOf(options: { enabled?: () => boolean; signUrl?: (key: string, seconds: number) => string } = {}) {
  const ports = createMemoryFixturePorts(options.signUrl === undefined ? { signUrl: (key, seconds) => `https://fixtures.example.test/${key}?X-Amz-Expires=${String(seconds)}` } : { signUrl: options.signUrl });
  return createFixtureStore({ enabled: options.enabled ?? (() => true), objects: ports.objects, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
}
async function approvedSet(store: FixtureStore, set: FixtureSet, org: OrgId = ORG, project: string = PROJECT): Promise<string> {
  const digest = fixtureSetDigest(set);
  const stored = await store.submit(org, project, set, { actor: "maya", recordedFrom: "written" });
  if (!stored.ok) throw new Error(stored.reason);
  const decision = verifiedFixtureDecision({ orgId: org, project, actor: "maya", role: "maintainer", action: "approve", digest, signedInAt: new Date(NOW.getTime() - 60_000), schemaSynth: false });
  const approved = await store.approve(org, project, digest, decision!);
  if (!approved.ok) throw new Error(approved.reason);
  return digest;
}

// ---- an environment with Postgres and a fake

const postgres = () => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
});
const payments = (digest: string, over: Record<string, unknown> = {}) => ({
  id: "payments", name: "Payments API", kind: "http_api", family: "http:api.example-pay.com", found: [{ path: "src/pay.ts", line: 3 }], usedBy: ["integration"],
  backing: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" },
  connect: { env: [{ name: "PAYMENTS_API_URL", template: "http://{host}:{port}" }], hostAliases: ["fake-payments"] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] | null): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: DENY, capture: { screenshots: "failed", video: false, traces: false }, ...(dependencies === null ? {} : { dependencies }),
});
const asEnvironment = (environment: TestEnvironmentBody): TestEnvironment => ({ revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", environment });
const catalog = (change?: (entries: Array<Record<string, unknown>>) => void): VerifiedCatalog => verifiedCatalog(pinnedCatalog(change));
const plansOf = (dependencies: unknown[], fixtures: Awaited<ReturnType<typeof approvedFixturesOf>> | undefined, from: VerifiedCatalog | null = catalog()) =>
  taskDependencyPlansOf({ body: body(dependencies), catalog: from ?? undefined, edition: "public", ...(fixtures === undefined ? {} : { fixtures }) });
const reason = (result: ReturnType<typeof plansOf>) => (result.ok ? "ok" : result.reason);

describe("which dependencies are startable now", () => {
  it("includes a fake that fails on a request with no recording and is made new each round, and nothing else about fakes", () => {
    const digest = "a".repeat(64);
    expect(dependenciesStartableNow([payments(digest)] as never)).toBe(true);
    // A made-up answer is not available yet; a restart between checks would lose the fake's ledger.
    expect(dependenciesStartableNow([payments(digest, { backing: { kind: "fake", fixtureSetRef: digest, unmatched: "schema_synth" } })] as never)).toBe(false);
    expect(dependenciesStartableNow([payments(digest, { reset: "between_checks" })] as never)).toBe(false);
    // The coding sandbox gets the same fake, or nothing different.
    expect(dependenciesStartableNow([payments(digest, { workingBacking: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" } })] as never)).toBe(true);
    expect(dependenciesStartableNow([payments(digest, { workingBacking: { kind: "fake", fixtureSetRef: "b".repeat(64), unmatched: "fail" } })] as never)).toBe(false);
    // A fallback is never a thing yet.
    expect(dependenciesStartableNow([payments(digest, { fallback: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" } })] as never)).toBe(false);
  });
  it("is carried out with tx on and refused with tx off (an environment with dependencies is not used at all)", () => {
    const environment = asEnvironment(body([payments("a".repeat(64))]));
    expect(environmentUnusedReason(environment, ON)).toBeUndefined();
    expect(environmentUnusedReason(environment, { ROVARA_TEST_ENVIRONMENT: "1" })).toBe("dependencies_not_connected");
  });
});

describe("the plan of a fake", () => {
  it("pins the approved set by digest, with no image digest and no address", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, PROJECT, body([payments(digest)]));
    const result = plansOf([postgres(), payments(digest)], fixtures);
    expect(reason(result)).toBe("ok");
    if (!result.ok) throw new Error("no plan");
    const fake = result.dependencies.find((entry) => entry.id === "payments")!;
    expect(fake).toMatchObject({ backing: "fake", catalogId: "fake-server@r1", repository: "svc/fake-server", fake: { fixtureSetRef: digest, unmatched: "fail" }, aliases: ["fake-payments"], seeds: [], reset: "fresh_per_round" });
    expect("digest" in fake).toBe(false);
    expect(JSON.stringify(fake)).not.toMatch(/https?:\/\/fixtures|X-Amz|expires/iu);
    expect(TestEnvTaskPlanSchema.safeParse({ revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: result.dependencies }).success).toBe(true);
    expect(fixtureDigestsOfPlan({ dependencies: result.dependencies })).toEqual([digest]);
    // The real software beside it is exactly what it was without a fake.
    expect(result.dependencies.find((entry) => entry.id === "postgres")).toMatchObject({ backing: "local" });
    expect(result.dependencies.find((entry) => entry.id === "postgres")?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("needs no pinned catalog for a fake alone (it starts no catalog image), and still needs one beside real software", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, PROJECT, body([payments(digest)]));
    expect(reason(plansOf([payments(digest)], fixtures, verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).toBe("ok");
    expect(reason(plansOf([postgres(), payments(digest)], fixtures, verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).toBe("not_pinned");
  });
  it("refuses a set that is not approved for this company: another company's, a pending one, a withdrawn one, one nobody holds, and a store that is not there", async () => {
    const store = storeOf();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    const environment = body([payments(digest)]);
    // nobody holds it
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, PROJECT, environment)))).toBe("fixture_not_approved");
    // pending
    await store.submit(ORG, PROJECT, set, { actor: "maya", recordedFrom: "written" });
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, PROJECT, environment)))).toBe("fixture_not_approved");
    // approved for ORG, asked for by OTHER_ORG
    await approvedSet(store, set);
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, PROJECT, environment)))).toBe("ok");
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, OTHER_ORG, PROJECT, environment)))).toBe("fixture_not_approved");
    // H1: another project of the same company cannot name this project's approved set in its environment
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, "billing", environment)))).toBe("fixture_not_approved");
    expect((await approvedFixturesOf(store, ORG, "billing", environment)).size).toBe(0);
    // withdrawn
    const withdraw = verifiedFixtureDecision({ orgId: ORG, project: PROJECT, actor: "maya", role: "maintainer", action: "withdraw", digest, signedInAt: undefined, schemaSynth: false })!;
    expect((await store.withdraw(ORG, PROJECT, digest, withdraw)).ok).toBe(true);
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, PROJECT, environment)))).toBe("fixture_not_approved");
    // no store at all, and no lookup passed to the plan
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(undefined, ORG, PROJECT, environment)))).toBe("fixture_not_approved");
    expect(reason(plansOf([payments(digest)], undefined))).toBe("fixture_not_approved");
    expect(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved).toMatch(/approved/iu);
  });
  it("refuses a set approved for another kind of dependency, a store that throws, and a fake that cannot stand in for a database", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const other = await approvedFixturesOf(store, ORG, PROJECT, body([payments(digest, { family: "http:api.other-pay.com" })]));
    expect(reason(plansOf([payments(digest, { family: "http:api.other-pay.com" })], other))).toBe("fixture_not_approved");
    const broken = { record: () => Promise.reject(new Error("boom")) };
    expect((await approvedFixturesOf(broken, ORG, PROJECT, body([payments(digest)]))).size).toBe(0);
    const fixtures = await approvedFixturesOf(store, ORG, PROJECT, body([payments(digest)]));
    expect(reason(plansOf([payments(digest, { kind: "database", family: "http:api.example-pay.com" })], fixtures))).toBe("not_available_yet");
  });
  it("needs a name to be reached by, no seeds, and the catalog's marked fake server", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, PROJECT, body([payments(digest)]));
    expect(reason(plansOf([payments(digest, { connect: { env: [], hostAliases: [] } })], fixtures))).toBe("not_available_yet");
    expect(reason(plansOf([payments(digest, { seeds: [{ command: cmd("node", ["seed.js"]) }] })], fixtures))).toBe("not_available_yet");
    const without = catalog((entries) => { entries.splice(0, entries.length, ...entries.filter((entry) => entry["family"] !== "fake-server")); });
    expect(reason(plansOf([payments(digest)], fixtures, without))).toBe("not_available_yet");
    const retired = catalog((entries) => { for (const entry of entries) if (entry["family"] === "fake-server") entry["status"] = "retired"; });
    expect(reason(plansOf([payments(digest)], fixtures, retired))).toBe("not_available_yet");
    const enterpriseOnly = catalog((entries) => { for (const entry of entries) if (entry["family"] === "fake-server") entry["editions"] = ["enterprise"]; });
    expect(reason(plansOf([payments(digest)], fixtures, enterpriseOnly))).toBe("not_in_edition");
  });
  it("lists the digests an environment names, once each, for the checks and for the coding sandbox", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const environment = body([payments(a, { workingBacking: { kind: "fake", fixtureSetRef: a, unmatched: "fail" } }), payments(b, { id: "geo", name: "Geo", family: "http:api.example-pay.com", connect: { env: [{ name: "GEO_URL", template: "http://{host}:{port}" }], hostAliases: ["fake-geo"] } })]);
    expect(fixtureDigestsOfEnvironment(environment)).toEqual([a, b]);
    expect(fixtureDigestsOfEnvironment(body(null))).toEqual([]);
  });
});

// ---- the task's plan, from an approved environment

async function approvedWith(environment: TestEnvironmentBody, store: FixtureStore | undefined) {
  const h = await bench({ project: PROJECT, env: ON, serviceCatalog: async () => catalog(), ...(store === undefined ? {} : { fixtureStore: () => store }) });
  const proposal = await h.proposeAndProve(environment);
  expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
  const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
  await h.store.transact([start.pin!]);
  return h;
}
const readiness = [cmd("pytest", ["-q"])];

describe("approving an environment with a fake", () => {
  it("needs the fixture set to be approved for the company; without a store, or for a set nobody approved, it is refused in fixed words", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    await expect(approvedWith(body([payments(digest)]), store)).resolves.toBeDefined();
    await expect(approvedWith(body([payments(digest)]), undefined)).rejects.toThrow(/approved set of answers/iu);
    await expect(approvedWith(body([payments("c".repeat(64))]), store)).rejects.toThrow(/approved set of answers/iu);
  });
});

describe("the plan of a task with a fake (checks and coding)", () => {
  it("builds the checks plan and the coding plan with the fake, from the approved set", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const h = await approvedWith(body([postgres(), payments(digest)]), store);
    const plan = (await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON))!;
    expect(plan.digest).toBe(testEnvDigest(body([postgres(), payments(digest)])));
    expect(plan.dependencies?.map((entry) => [entry.id, entry.backing])).toEqual([["postgres", "local"], ["payments", "fake"]]);
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
    const coding = (await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON))!;
    expect(coding.dependencies).toEqual(plan.dependencies);
    expect(fixtureDigestsOfPlan(plan)).toEqual([digest]);
  });
  it("refuses the run, in fixed words, when the set was withdrawn after the approval, and never sends a plan without the fake", async () => {
    const store = storeOf();
    const set = makeSet();
    const digest = await approvedSet(store, set);
    const h = await approvedWith(body([payments(digest)]), store);
    const withdraw = verifiedFixtureDecision({ orgId: ORG, project: PROJECT, actor: "maya", role: "maintainer", action: "withdraw", digest, signedInAt: undefined, schemaSynth: false })!;
    await store.withdraw(ORG, PROJECT, digest, withdraw);
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
    await expect(testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
    // no store wired in the dispatching broker
    delete h.deps.fixtureStore;
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
  });
  it("with tx off, nothing is read and no plan is built", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const h = await approvedWith(body([payments(digest)]), store);
    expect(await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
    expect(await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
  });
});

// ---- evidence and Prove

const pinnedFake = (fake: PinnedDependency["fake"]): PinnedDependency[] => [{ id: "postgres", name: "Postgres", backing: "local" }, { id: "payments", name: "payments API", backing: "fake", ...(fake === undefined ? {} : { fake }) }];
const fakeRow = (over: Record<string, unknown> = {}) => ({ id: "payments", ledger: "read", matched: 4, unmatched: 0, synthesized: 0, faults: 0, foreign: 0, ...over });
const usageOf = (fakes?: unknown[]): RawUsage => ({
  schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }, { id: "payments", started: true, healthy: true, startMs: 300, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, ...(fakes === undefined ? {} : { fakes }),
}) as RawUsage;
const packOf = (dependencies: ReturnType<typeof dependencyEvidenceOf>["dependencies"]) => ({ environment: { dependencies } }) as never;

describe("what the evidence says about a fake", () => {
  it("says hand-written for a written set and recorded for a recorded one, from the store, in the fixed words", () => {
    const written = dependencyEvidenceOf(pinnedFake({ origin: "hand_written", revision: 3 }), usageOf([fakeRow()]));
    expect(written.dependencies[1]).toMatchObject({ backing: "fake", label: "hand_written_fake", fixtureRevision: 3, startedMs: 300, usage: { requests: 4, unmatched: 0, faults: 0 } });
    expect(packDependencyLines(packOf(written.dependencies), 0).lines).toEqual(["Integration tests ran against: Postgres (real), payments API (hand-written fake, rev 3)."]);
    const recorded = dependencyEvidenceOf(pinnedFake({ origin: "recorded", revision: 5, recordedAt: "2026-10-20T08:00:00.000Z" }), usageOf([fakeRow()]));
    expect(recorded.dependencies[1]).toMatchObject({ label: "recorded_fake", fixtureRevision: 5, recordedAt: "2026-10-20T08:00:00.000Z" });
    expect(packDependencyLines(packOf(recorded.dependencies), 0).lines[0]).toBe("Integration tests ran against: Postgres (real), payments API (recorded fake, rev 5).");
    expect(packDependencyLines(packOf(recorded.dependencies), 0).notTested).toContain("- payments API: answers were recorded on 2026-10-20; real behaviour may have changed");
    expect(packDependencyLines(packOf(written.dependencies), 0).notTested).toContain("- payments API: answers were written by hand, not recorded");
  });
  it("never lets the worker set the label: a recorded set whose date is not known reads as the less trusted word, and so does a store that could not be read", () => {
    expect(dependencyEvidenceOf(pinnedFake({ origin: "recorded" }), usageOf([fakeRow()])).dependencies[1]!.label).toBe("hand_written_fake");
    expect(dependencyEvidenceOf(pinnedFake(undefined), usageOf([fakeRow()])).dependencies[1]!.label).toBe("hand_written_fake");
  });
  it("never shows a fake Rovara made as a recording, whatever the store says (review M3)", () => {
    const made = dependencyEvidenceOf(pinnedFake({ origin: "recorded", revision: 5, recordedAt: "2026-10-20T08:00:00.000Z", madeByRovara: true }), usageOf([fakeRow({ synthesized: 2 })]));
    expect(made.dependencies[1]).toMatchObject({ backing: "fake", label: "rovara_made_fake", fixtureRevision: 5, madeUpAnswers: 2 });
    expect(made.dependencies[1]).not.toHaveProperty("recordedAt");
    expect(packDependencyLines(packOf(made.dependencies), 0).notTested).toContain("- payments API: answers were made by Rovara, not recorded from the real service");
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written", madeByRovara: true }), usageOf([fakeRow()])).dependencies[1]!.label).toBe("rovara_made_fake");
    // a Rovara-made fake that did not start is not available, like any other
    const down = { ...usageOf([]), dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }, { id: "payments", started: false, healthy: false, startMs: 0, resetCount: 0 }] } as RawUsage;
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written", madeByRovara: true }), down).dependencies[1]!.label).toBe("not_available");
  });
  it("reads the pinned fake's origin from the approved backing's provenance, and never lets a recording that Rovara made keep its day (review M3)", () => {
    const backing = (provenance?: Record<string, unknown>) => ({ kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail", ...(provenance === undefined ? {} : { provenance }) }) as never;
    const set = { origin: "recorded", revision: 4, recordedAt: "2026-10-20T08:00:00.000Z" };
    const mockSet = { setId: "m1", version: 1, store: "rovara" };
    expect(pinnedFakeOf(backing(), set)).toEqual({ origin: "recorded", revision: 4, recordedAt: "2026-10-20T08:00:00.000Z" });
    expect(pinnedFakeOf(backing({ origin: "customer" }), set)).toEqual({ origin: "recorded", revision: 4, recordedAt: "2026-10-20T08:00:00.000Z" });
    for (const origin of ["rovara_setup", "rovara_task"]) expect(pinnedFakeOf(backing({ origin, mockSet }), set)).toEqual({ origin: "hand_written", revision: 4, madeByRovara: true });
    expect(pinnedFakeOf(backing({ origin: "rovara_task", mockSet }), undefined)).toEqual({ origin: "hand_written", madeByRovara: true });
    expect(pinnedFakeOf(backing(), undefined)).toEqual({ origin: "hand_written" });
  });
  it("counts an unmatched request, and does not show the result as a clean run", () => {
    const result = dependencyEvidenceOf(pinnedFake({ origin: "hand_written", revision: 3 }), usageOf([fakeRow({ unmatched: 2 })]));
    expect(result.dependencies[1]!.usage).toEqual({ requests: 6, unmatched: 2, faults: 0 });
    expect(result.notTested).toContainEqual({ kind: "environment", id: FAKE_USAGE_ITEM_ID, text: `${TEST_SERVICES_FAKE_USAGE_WORDS.unmatched}: payments API`, reason: "no recording" });
  });
  it("says a fake's requests could not be checked when its ledger was not read, and when the record has no row for it; a clean fake adds nothing", () => {
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([fakeRow({ ledger: "unreadable", matched: 0 })])).notTested.map((item) => item.id)).toEqual([FAKE_USAGE_ITEM_ID]);
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([])).notTested.map((item) => item.id)).toEqual([FAKE_USAGE_ITEM_ID]);
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([fakeRow()])).notTested).toEqual([]);
  });
  it("shows a fake that did not start as not available, never as a fake that ran", () => {
    const record = { ...usageOf([fakeRow()]), dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }, { id: "payments", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "start_failed" }] } as RawUsage;
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), record).dependencies[1]).toEqual({ name: "payments API", backing: "none", label: "not_available" });
  });
  it("reads the label from the store for the organisation of the task, by the pinned digest", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, recordedSet());
    const h = await approvedWith(body([payments(digest)]), store);
    const chosen = await evidenceEnvironmentOf({ ...h.deps, fixtureStore: () => store }, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.dependencies).toEqual([{ id: "payments", name: "Payments API", backing: "fake", fake: { origin: "recorded", revision: 5, recordedAt: "2026-10-20T08:00:00.000Z" } }]);
    // Another company's task sees nothing of it.
    const elsewhere = await evidenceEnvironmentOf({ ...h.deps, fixtureStore: () => store }, { orgId: OTHER_ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(elsewhere.dependencies).toBeUndefined();
  });
});

describe("the Prove usage step with a fake", () => {
  const planned = (digest = "a".repeat(64)) => body([payments(digest)]);
  const record = (fakes?: unknown[]): TestServicesUsageRecord => ({ ...usageOf(fakes), dependencies: [{ id: "payments", started: true, healthy: true, startMs: 300, resetCount: 0 }] }) as TestServicesUsageRecord;
  const stepOf = (name: string, steps: ReturnType<typeof dependencyStepsOf>) => (steps === "not_checked" ? "not_checked" : steps.find((step) => step.step === name)?.status);
  it("passes for a fake whose ledger was read and shows no unmatched and no foreign call", () => {
    expect(stepOf("dependency_usage", dependencyStepsOf(planned(), record([fakeRow()])))).toBe("passed");
  });
  it("fails on an unmatched request, a foreign call, an unreadable ledger and a record with no row", () => {
    for (const fakes of [[fakeRow({ unmatched: 1 })], [fakeRow({ foreign: 1 })], [fakeRow({ ledger: "unreadable", matched: 0 })], []]) expect(stepOf("dependency_usage", dependencyStepsOf(planned(), record(fakes)))).toBe("failed");
    expect(stepOf("dependency_usage", dependencyStepsOf(planned(), { ...record(), fakes: undefined }))).toBe("failed");
  });
  it("still starts the fake as a dependency, and an environment without a fake gets the steps it had", () => {
    expect(stepOf("dependencies", dependencyStepsOf(planned(), record([fakeRow()])))).toBe("passed");
    const postgresOnly = body([postgres()]);
    expect(stepOf("dependency_usage", dependencyStepsOf(postgresOnly, { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 1, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } }))).toBe("passed");
  });
});

// ---- tx off, or no fake: today, byte for byte; and the one-line hunks of the hot files

describe("with no fake in the plan nothing is added", () => {
  it("names no fixture set", () => {
    expect(fixtureDigestsOfPlan(undefined)).toEqual([]);
    expect(fixtureDigestsOfPlan({ dependencies: [] })).toEqual([]);
  });
  it("is the plan for real software and Rovara local AWS: no fixture lookup is made", async () => {
    let asked = 0;
    const counting = { record: () => { asked += 1; return Promise.reject(new Error("never")); } };
    expect((await approvedFixturesOf(counting, ORG, PROJECT, body([postgres()]))).size).toBe(0);
    expect(asked).toBe(0);
    const result = taskDependencyPlansOf({ body: body([postgres()]), catalog: catalog(), edition: "public" });
    expect(result.ok && result.dependencies.map((entry) => [entry.id, "fake" in entry])).toEqual([["postgres", false]]);
  });
});

describe("the approve card", () => {
  it("says whether a fake's answers were recorded or written by hand when the store is asked, and 'a fake' when it is not", async () => {
    const store = storeOf();
    const written = await approvedSet(store, makeSet());
    const recorded = await approvedSet(store, recordedSet());
    const environment = body([payments(written), payments(recorded, { id: "geo", name: "Geo API", connect: { env: [], hostAliases: ["fake-geo"] } })]);
    const origins = await approvedFixturesOf(store, ORG, PROJECT, environment);
    const lines = dependencyCardLines(environment.dependencies!, origins);
    expect(lines).toContain("Payments API: answers from a hand-written fake. Found in src/pay.ts, line 3.");
    expect(lines).toContain("Geo API: answers from a recorded fake. Found in src/pay.ts, line 3.");
    expect(dependencyCardLines(environment.dependencies!)[0]).toBe("Payments API: answers from a fake. Found in src/pay.ts, line 3.");
    // the other company's store answer is no origin
    expect(dependencyCardLines(environment.dependencies!, await approvedFixturesOf(store, OTHER_ORG, PROJECT, environment))[0]).toBe("Payments API: answers from a fake. Found in src/pay.ts, line 3.");
  });
});

describe("the install's store is a factory over the production list", () => {
  it("a read of rows asks for no production list at all (it would fail closed if it did), and a delivery asks for the project's approved list", async () => {
    const ports = createMemoryFixturePorts({ signUrl: (key, seconds) => `https://fixtures.example.test/${key}?X-Amz-Expires=${String(seconds)}` });
    const asked: string[] = [];
    const factory: FixtureStoreFactory = (denyFor) => createFixtureStore({ enabled: () => true, objects: ports.objects, index: ports.index, denyFor: (org, project) => { asked.push(`${org}/${project}`); return denyFor(org, project); }, now: () => NOW });
    // set up through a store with an empty list, then read rows through the factory with a list that cannot be had
    const digest = await approvedSet(factory(() => Promise.resolve(DENY)) as FixtureStore, makeSet());
    asked.length = 0;
    const found = await approvedFixturesOf(recordsOf((denyFor) => factory(denyFor)), ORG, PROJECT, body([payments(digest)]));
    expect(found.get(digest)?.origin).toBe("hand_written");
    expect(asked).toEqual([]);
    expect(recordsOf(undefined)).toBeUndefined();
    const reader = recordsOf(() => factory(() => Promise.reject(new Error("no list"))));
    expect((await reader!.record(ORG, PROJECT, digest)).ok).toBe(true);
  });
});
