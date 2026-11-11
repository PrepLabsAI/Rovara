// Test services which dependencies a task's run starts, pinned from the signed catalog.
//
// The approved environment says WHAT backs a dependency (a catalog id, chosen when it was proposed). This says what the run may start NOW: the catalog entry must be in the signed catalog this release ships, live,
// offered in this edition, and pinned to an image digest; the catalog must be newer than the release's minimum (a rolled-back catalog could pin a digest that was later found critical). Anything else is refused
// with a fixed reason, never a plan that leaves a dependency out (a run with no database would only fail its tests in a confusing way). Pure apart from the catalog source; it never reads a clock, a network or a file itself.
//
// starts real software from the catalog only (backing `local`, no substitute image). adds Rovara local AWS (backing `emulated`, entry `local-aws`) for exactly S3, SQS and DynamoDB. adds a fake (backing `fake`,
// entry `fake-server`, which runs from the worker's own image) for an APPROVED, digest-pinned fixture set of this organisation, answering requests with no recording with an error (`fail`). Every other backing, and every
// other AWS service, is "not available yet", at approval (`dependenciesStartableNow`) and again here.
import { TEST_SERVICES_AWS_PLAN_SERVICES, emulatorServiceTier, loadSignedCatalog, type CatalogEntry, type CatalogTrustContext, type TaskDependencyPlan, type TestEnvDependency, type TestEnvironmentBody, type VerifiedCatalog, TaskDependencyPlanSchema, TASK_DEPENDENCY_PLAN_MAX, catalogEntryById, catalogIdName, catalogPrepullList } from "@agentx/contracts";
import { STATEFUL_KINDS, chooseBacking, effectiveAllowedBackings, type BackingPlace, type SkipReason } from "./backing-choice.js";
import type { ApprovedFixture } from "./fixture-lookup.js";

/**
 * The oldest catalog revision this release will start images from. Raise it with every catalog release that retires or replaces a pinned digest. It is a constant of the release, not a setting: the broker's
 * environment has no room for another variable, and a rollback of the catalog file must not be a matter of configuration.
 */
export const TEST_SERVICES_MIN_CATALOG_REVISION = 3;

export const DEPENDENCY_PLAN_REFUSALS = ["no_catalog", "catalog_too_old", "not_available_yet", "not_in_catalog", "not_in_edition", "retired", "not_pinned", "not_allowed", "too_many", "invalid", "fixture_not_approved", "seed_file_unbound"] as const;
export type DependencyPlanRefusal = (typeof DEPENDENCY_PLAN_REFUSALS)[number];
/** What a person reads when a run cannot start its dependencies. Fixed words: no catalog id, digest or error text of any kind. */
export const DEPENDENCY_PLAN_REFUSAL_WORDS: Record<DependencyPlanRefusal, string> = {
  no_catalog: "The service images this run needs could not be checked, so its test services were not started.",
  catalog_too_old: "The service image list is older than this release allows, so test services were not started.",
  not_available_yet: "This project asks for a kind of test service that is not available yet.",
  not_in_catalog: "A test service this project asks for is not in Rovara's image list.",
  not_in_edition: "A test service this project asks for is not offered in this edition.",
  retired: "A test service this project asks for has been retired.",
  not_pinned: "A test service this project asks for has no checked image yet.",
  not_allowed: "A test service this project asks for is not allowed by the company's settings.",
  too_many: "This project asks for more test services than a run starts.",
  invalid: "The plan for this project's test services could not be built.",
  fixture_not_approved: "A fake this project asks for has no approved set of answers.",
  seed_file_unbound: "The test data file of this project's test environment is not bound to its approval. Check it works and approve the test environment again.",
};

/** Review I3: the seed files an approval bound, by dependency and path, with the sha256 its check loaded. */
export type SeedFileHashes = ReadonlyArray<{ id: string; path: string; sha256: string }>;

export type DependencyPlanResult = { ok: true; dependencies: TaskDependencyPlan[] } | { ok: false; reason: DependencyPlanRefusal };

/**
 * The AWS services Rovara local AWS backs on a task . The emulator has more, and the contract allows more; every other service is "not available yet" until its own slice (design 5.2 tiers, the compatibility suite).
 * The names are AWS service ids (`aws:s3` is the family of `s3`).
 */
export const EMULATED_TASK_SERVICES: readonly string[] = TEST_SERVICES_AWS_PLAN_SERVICES;

type DependencyBacking = TestEnvDependency["backing"];
type EmulatedBacking = Extract<DependencyBacking, { kind: "emulated" }>;
type FakeBacking = Extract<DependencyBacking, { kind: "fake" }>;

const startableLocal = (backing: DependencyBacking): boolean => backing.kind === "local" && backing.substituteImage === undefined;
/** Rovara local AWS for S3, SQS or DynamoDB only: the family and every service the backing lists are among them. */
const startableEmulated = (family: string, backing: DependencyBacking): backing is EmulatedBacking =>
  backing.kind === "emulated" && family.startsWith("aws:") && EMULATED_TASK_SERVICES.includes(family.slice(4)) && backing.awsServices.every((service) => EMULATED_TASK_SERVICES.includes(service)) && backing.awsServices.includes(family.slice(4));
/**
 * A fake : the policy for a request with no recording is `fail` (a made-up answer is not available yet), and the dependency is reset by a new fake each round (`fresh_per_round`): a restart between checks would lose the
 * fake's request ledger, and with it the count of what the tests asked it. Whether the set is approved is asked at the plan (`planFake`), which has the store.
 */
const startableFake = (dependency: Pick<TestEnvDependency, "kind" | "family" | "reset">, backing: DependencyBacking): boolean =>
  backing.kind === "fake" && backing.unmatched === "fail" && dependency.reset === "fresh_per_round" && !(STATEFUL_KINDS.includes(dependency.kind) && !dependency.family.startsWith("aws:"));
const startableBacking = (dependency: Pick<TestEnvDependency, "kind" | "family" | "reset">, backing: DependencyBacking): boolean => startableLocal(backing) || startableEmulated(dependency.family, backing) || startableFake(dependency, backing);

/**
 * Whether every dependency is something this release can start: real software from the catalog (no substitute image), or Rovara local AWS for S3, SQS and DynamoDB; the same while coding, and a fallback of nothing at most.
 * The emulated ones share one helper, so they must agree on the image and the region. Pure; no catalog needed.
 */
export function dependenciesStartableNow(dependencies: readonly TestEnvDependency[]): boolean {
  const emulated = dependencies.flatMap((dependency) => (dependency.backing.kind === "emulated" ? [dependency.backing] : []));
  if (emulated.some((backing) => backing.catalogId !== emulated[0]!.catalogId || backing.region !== emulated[0]!.region)) return false;
  return dependencies.every((dependency) =>
    startableBacking(dependency, dependency.backing)
    && (dependency.workingBacking === undefined || (startableBacking(dependency, dependency.workingBacking) && sameBacking(dependency.workingBacking, dependency.backing)))
    && (dependency.fallback === undefined || dependency.fallback.kind === "none"));
}

const sameBacking = (left: DependencyBacking, right: DependencyBacking): boolean =>
  (left.kind === "local" && right.kind === "local" && left.catalogId === right.catalogId) || (left.kind === "emulated" && right.kind === "emulated" && JSON.stringify(left) === JSON.stringify(right))
  || (left.kind === "fake" && right.kind === "fake" && left.fixtureSetRef === right.fixtureSetRef && left.unmatched === right.unmatched);

const REFUSAL_OF_SKIP: Partial<Record<SkipReason, DependencyPlanRefusal>> = {
  not_allowed: "not_allowed", not_in_catalog: "not_in_catalog", not_in_edition: "not_in_edition", retired: "retired", no_such_version: "not_in_catalog", not_pinned: "not_pinned",
};

/** Whether a `local-aws` catalog entry serves every one of the services in its `supported` tier (the tier the compatibility suite covers). */
export function emulatorServesAll(entry: CatalogEntry, services: readonly string[]): boolean {
  return entry.backing === "emulated" && catalogIdName(entry.id) === "local-aws" && entry.emulator !== undefined && services.every((service) => emulatorServiceTier(entry.emulator!, service) === "supported");
}

/** The refusals for Rovara local AWS: an entry that is missing, unpinned or not covering the service is "not available yet"; the company's setting, the edition and a retired entry keep their own words. */
const REFUSAL_OF_EMULATED_SKIP: Partial<Record<SkipReason, DependencyPlanRefusal>> = { not_allowed: "not_allowed", not_in_edition: "not_in_edition", retired: "retired" };

/**
 * A worker pulls (as root, at boot) only the images in the pre-pull list baked into its image, and that list holds EVERY pinned, non-retired local or emulated entry plus the pinned defaults and always-used helpers
 * (`catalogPrepullList`), so a pinned non-default entry (postgres@15, postgres@17) is startable once the catalog pins it. An entry that is NOT in the list (not pinned, retired, or a kind the list leaves out) would pass
 * approval and then always fail on the worker, so it stays "not available yet" at approval and at plan time.
 */
export function isPrepulledEntry(catalog: VerifiedCatalog, catalogId: string): boolean {
  // A list that cannot be made (more images than a worker pre-pulls) is "not pre-pulled", never a thrown error at approval: the worker would not have pulled it either.
  try {
    return catalogPrepullList(catalog).images.some((image) => image.id === catalogId);
  } catch {
    return false;
  }
}

const majorOf = (entry: CatalogEntry): string => entry.version.split(".")[0] ?? entry.version;

/**
 * one dependency backed by Rovara local AWS. The `local-aws` entry must be in the signed catalog, live, offered in this edition, pinned to a digest, in the pre-pull list the worker image carries, and the emulator must
 * list every service the dependency needs in its `supported` tier. Without a pinned local-aws every emulated dependency is "not available yet" (the same fixed words as at approval), never started without an image.
 * The alias is the dependency's own and is NOT filled from the entry's default: the dependencies that share the one helper would all claim `aws` (the plan allows a name once), so the proposal gives it to the first. The region variables (`AWS_REGION`)
 * are Rovara's to set (the contract reserves them), so no connection variable comes from the entry either; the worker sets them from `aws.region`.
 */
function planEmulated(dependency: TestEnvDependency, backing: EmulatedBacking, catalog: VerifiedCatalog, edition: "public" | "enterprise", projectId: string, prodDeny: TestEnvironmentBody["prodDeny"]): { ok: true; plan: unknown } | { ok: false; reason: DependencyPlanRefusal } {
  const entry = catalogEntryById(catalog, backing.catalogId);
  if (entry === undefined || !emulatorServesAll(entry, backing.awsServices)) return { ok: false, reason: "not_available_yet" };
  for (const place of ["task_check", "working"] as const satisfies readonly BackingPlace[]) {
    const chosen = chooseBacking({
      dependency: { family: dependency.family, kind: dependency.kind, maintainerChoice: "emulated" }, place, edition, allowed: effectiveAllowedBackings(undefined),
      catalog: { ...catalog, entries: [entry] }, projectId, projectImages: [], accounts: [], prodDeny, fixtures: [], canMakeFake: false, now: 0,
    });
    if (chosen.backing.kind !== "emulated") {
      const skipped = chosen.skipped.find((step) => step.step === "emulated");
      return { ok: false, reason: (skipped === undefined ? undefined : REFUSAL_OF_EMULATED_SKIP[skipped.reason]) ?? "not_available_yet" };
    }
  }
  if (entry.image.digest === undefined || !isPrepulledEntry(catalog, backing.catalogId)) return { ok: false, reason: "not_available_yet" };
  return { ok: true, plan: {
    id: dependency.id, name: dependency.name, kind: dependency.kind, family: dependency.family, backing: "emulated", catalogId: backing.catalogId, repository: entry.image.repository, digest: entry.image.digest,
    config: {}, aliases: dependency.connect.hostAliases, connect: dependency.connect.env, seeds: dependency.seeds, reset: dependency.reset,
    aws: { services: backing.awsServices, region: backing.region, ...(backing.resources === undefined ? {} : { resources: backing.resources }) },
  } };
}

/** The refusals for a fake that the chooser skips: the company's setting and a dependency a fake cannot stand in for keep their own words. */
const REFUSAL_OF_FAKE_SKIP: Partial<Record<SkipReason, DependencyPlanRefusal>> = { not_allowed: "not_allowed", fake_not_for_this_kind: "not_available_yet" };

/**
 * one dependency backed by a fake. The fake server is the catalog's `fake-server` entry (a helper that runs from the worker's own image: it has no digest, and it is not in the pre-pull list), offered in this
 * edition. The fixture set must be one of THIS organisation's approved sets (`fixtures`, from `approvedFixturesOf`), for the dependency's own family, and the chooser applies the company's "fakes" setting and the kinds a fake
 * cannot stand in for in each place the dependency runs. The plan carries the set's DIGEST, never a URL: a read address would expire before the round, so the worker asks for a fresh one when a phase starts.
 * The fake needs a name to be reached by (an alias): without one the connection variables have no host.
 */
function planFake(dependency: TestEnvDependency, backing: FakeBacking, catalog: VerifiedCatalog, edition: "public" | "enterprise", projectId: string, prodDeny: TestEnvironmentBody["prodDeny"], fixtures: ReadonlyMap<string, ApprovedFixture>): { ok: true; plan: unknown } | { ok: false; reason: DependencyPlanRefusal } {
  const approved = fixtures.get(backing.fixtureSetRef);
  if (approved === undefined || approved.family !== dependency.family) return { ok: false, reason: "fixture_not_approved" };
  if (!startableFake(dependency, backing) || dependency.seeds.length > 0 || dependency.connect.hostAliases.length === 0) return { ok: false, reason: "not_available_yet" };
  const entry = catalog.entries.find((candidate) => candidate.backing === "fake" && catalogIdName(candidate.id) === "fake-server" && candidate.workerImage === true && candidate.status !== "retired");
  if (entry === undefined) return { ok: false, reason: "not_available_yet" };
  if (!entry.editions.includes(edition)) return { ok: false, reason: "not_in_edition" };
  for (const place of ["task_check", "working"] as const satisfies readonly BackingPlace[]) {
    const chosen = chooseBacking({
      dependency: { family: dependency.family, kind: dependency.kind, maintainerChoice: "fake" }, place, edition, allowed: effectiveAllowedBackings(undefined),
      catalog: { ...catalog, entries: [entry] }, projectId, projectImages: [], accounts: [], prodDeny, fixtures: [{ ref: approved.digest, family: approved.family, origin: approved.origin, unmatched: "fail" }], canMakeFake: false, now: 0,
    });
    if (chosen.backing.kind !== "fake" || chosen.backing.fixtureSetRef !== backing.fixtureSetRef) {
      const skipped = chosen.skipped.find((step) => step.step === "fake");
      return { ok: false, reason: (skipped === undefined ? undefined : REFUSAL_OF_FAKE_SKIP[skipped.reason]) ?? "not_available_yet" };
    }
  }
  return { ok: true, plan: {
    id: dependency.id, name: dependency.name, kind: dependency.kind, family: dependency.family, backing: "fake", catalogId: entry.id, repository: entry.image.repository,
    fake: { fixtureSetRef: backing.fixtureSetRef, unmatched: "fail" }, config: {}, aliases: dependency.connect.hostAliases, connect: dependency.connect.env, seeds: [], reset: dependency.reset,
  } };
}

/** One dependency's plan, or the reason it cannot be pinned. */
function planOne(dependency: TestEnvDependency, catalog: VerifiedCatalog, edition: "public" | "enterprise", projectId: string, prodDeny: TestEnvironmentBody["prodDeny"], fixtures: ReadonlyMap<string, ApprovedFixture>): { ok: true; plan: unknown } | { ok: false; reason: DependencyPlanRefusal } {
  const backing = dependency.backing;
  if (!dependenciesStartableNow([dependency])) return { ok: false, reason: "not_available_yet" };
  if (backing.kind === "fake") return planFake(dependency, backing, catalog, edition, projectId, prodDeny, fixtures);
  if (backing.kind === "emulated") return planEmulated(dependency, backing, catalog, edition, projectId, prodDeny);
  if (backing.kind !== "local") return { ok: false, reason: "not_available_yet" };
  const entry = catalogEntryById(catalog, backing.catalogId);
  if (entry === undefined || entry.backing !== "local" || entry.family !== dependency.family) return { ok: false, reason: "not_in_catalog" };
  // The chooser decides allowed / edition / retired / pinned for THIS entry in each place the dependency runs (checks, and the working sandbox), so the rules live in one function.
  for (const place of ["task_check", "working"] as const satisfies readonly BackingPlace[]) {
    const chosen = chooseBacking({
      dependency: { family: dependency.family, kind: dependency.kind, major: majorOf(entry), maintainerChoice: "local" }, place, edition, allowed: effectiveAllowedBackings(undefined),
      catalog: { ...catalog, entries: [entry] }, projectId, projectImages: [], accounts: [], prodDeny, fixtures: [], canMakeFake: false, now: 0,
    });
    if (chosen.backing.kind !== "local") {
      const skipped = chosen.skipped.find((step) => step.step === "local");
      return { ok: false, reason: (skipped === undefined ? undefined : REFUSAL_OF_SKIP[skipped.reason]) ?? "not_available_yet" };
    }
  }
  if (entry.image.digest === undefined) return { ok: false, reason: "not_pinned" };
  if (!isPrepulledEntry(catalog, backing.catalogId)) return { ok: false, reason: "not_available_yet" };
  return { ok: true, plan: {
    id: dependency.id, name: dependency.name, kind: dependency.kind, family: dependency.family, backing: "local", catalogId: backing.catalogId, repository: entry.image.repository, digest: entry.image.digest,
    config: backing.config, aliases: dependency.connect.hostAliases.length > 0 ? dependency.connect.hostAliases : entry.connect.defaultAliases, connect: dependency.connect.env, seeds: dependency.seeds, reset: dependency.reset,
  } };
}

/**
 * The pinned plans of every dependency of an approved environment, or the first reason one cannot be started. `catalog` is what `serviceCatalogSourceOf` loaded (undefined: it could not be). Never throws.
 */
export function taskDependencyPlansOf(input: { body: TestEnvironmentBody; catalog: VerifiedCatalog | undefined; edition: "public" | "enterprise"; projectId?: string; minCatalogRevision?: number; /** The approved fixture sets of the task's organisation, by digest (`approvedFixturesOf`). Absent: no set is approved, so every fake is refused. */ fixtures?: ReadonlyMap<string, ApprovedFixture>; /** Review I3: the plan is of an APPROVED environment, so every file seed carries the sha256 its approval bound (one with none is refused). Absent for a candidate check: the worker reports what it loaded. */ approvedSeedFiles?: SeedFileHashes }): DependencyPlanResult {
  try {
    const dependencies = input.body.dependencies ?? [];
    if (dependencies.length > TASK_DEPENDENCY_PLAN_MAX) return { ok: false, reason: "too_many" };
    if (input.catalog === undefined) return { ok: false, reason: "no_catalog" };
    if (input.catalog.revision < (input.minCatalogRevision ?? TEST_SERVICES_MIN_CATALOG_REVISION)) return { ok: false, reason: "catalog_too_old" };
    // An unpinned catalog names no image to start. For a project that asks for Rovara local AWS alone that is the same "not available yet" as at approval (there is no pinned local-aws); otherwise the plain words.
    // A fake starts no catalog image (it runs from the worker's own), so only the other dependencies need a pinned catalog.
    const imaged = dependencies.filter((dependency) => dependency.backing.kind !== "fake");
    if (!input.catalog.pinned && imaged.length > 0) return { ok: false, reason: imaged.every((dependency) => dependency.backing.kind === "emulated") ? "not_available_yet" : "not_pinned" };
    const plans: TaskDependencyPlan[] = [];
    for (const dependency of dependencies) {
      const one = planOne(dependency, input.catalog, input.edition, input.projectId ?? "", input.body.prodDeny, input.fixtures ?? new Map());
      if (!one.ok) return one;
      const bound = boundSeeds((one.plan as { seeds: TaskDependencyPlan["seeds"] }).seeds, dependency.id, input.approvedSeedFiles);
      if (bound === undefined) return { ok: false, reason: "seed_file_unbound" };
      const parsed = TaskDependencyPlanSchema.safeParse({ ...(one.plan as object), seeds: bound });
      if (!parsed.success) return { ok: false, reason: "invalid" };
      plans.push(parsed.data);
    }
    // The emulated dependencies share one helper: one image (the digest too) and one region, or the plan is not one the worker can start.
    const emulatedPlans = plans.filter((plan) => plan.backing === "emulated");
    if (emulatedPlans.some((plan) => plan.digest !== emulatedPlans[0]!.digest || plan.catalogId !== emulatedPlans[0]!.catalogId || plan.aws?.region !== emulatedPlans[0]!.aws?.region)) return { ok: false, reason: "not_available_yet" };
    return { ok: true, dependencies: plans };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** A plan's seeds with each file seed bound to its approved sha256 (`approved` given), or as they are (a candidate check). Undefined when an approved file seed has no bound sha256. */
function boundSeeds(seeds: TaskDependencyPlan["seeds"], dependencyId: string, approved: SeedFileHashes | undefined): TaskDependencyPlan["seeds"] | undefined {
  if (approved === undefined) return seeds;
  const out: TaskDependencyPlan["seeds"] = [];
  for (const seed of seeds) {
    if ("command" in seed) { out.push(seed); continue; }
    const hash = approved.find((entry) => entry.id === dependencyId && entry.path === seed.fixturePath)?.sha256;
    if (hash === undefined) return undefined;
    out.push({ fixturePath: seed.fixturePath, sha256: hash });
  }
  return out;
}

// ---- the signed catalog the release ships

/** Where the bytes of the shipped, signed catalog come from (the release's files). The reader is a port: this module reads no file. */
export type ServiceCatalogSource = () => Promise<VerifiedCatalog | undefined>;

/**
 * A catalog source over a reader of the shipped catalog and its signature. It verifies the signature over the exact bytes with the keys the CONTRACT trusts for the account the process runs in (`loadSignedCatalog` with
 * `trust`, catalog-trust.ts: compiled-in key lists), refuses a revision under the minimum, and keeps the first good answer for the life of the
 * process. `trust` is the running account from the process's own identity (never a setting, a variable or a request); it may be a function, because a Lambda learns its account from its first invocation. Nothing here takes
 * a key: `load` is a port for tests (they give `loadSignedCatalogWithKeys` of `@agentx/contracts/testing`, in test code only; the catalog-trust seam guard keeps that entry point out of production), and production passes none. A failure is not kept (the next call tries again) and says nothing but undefined; `onRefused` gets the fixed reason
 * `loadSignedCatalog` gave (for a log). Never throws.
 */
export function serviceCatalogSourceOf(input: {
  read: () => Promise<{ catalogBytes: Uint8Array; signatureBytes: Uint8Array }>;
  trust: CatalogTrustContext | (() => CatalogTrustContext);
  minRevision?: number;
  /** The loader. Default: the contract's `loadSignedCatalog`, with the compiled-in keys. Only tests give another. */
  load?: typeof loadSignedCatalog;
  onRefused?: (reason: string) => void;
}): ServiceCatalogSource {
  let kept: VerifiedCatalog | undefined;
  return async () => {
    if (kept !== undefined) return kept;
    try {
      const files = await input.read();
      const trust = typeof input.trust === "function" ? input.trust() : input.trust;
      const loaded = (input.load ?? loadSignedCatalog)({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, trust });
      if (!loaded.ok) { input.onRefused?.(loaded.reason); return undefined; }
      if (loaded.catalog.revision < (input.minRevision ?? TEST_SERVICES_MIN_CATALOG_REVISION)) { input.onRefused?.("the catalog is older than this release allows"); return undefined; }
      kept = loaded.catalog;
      return kept;
    } catch {
      return undefined;
    }
  };
}
