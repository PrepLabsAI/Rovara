// Test services choosing what backs a dependency. Deterministic and pure: the same facts always give the same answer, and nothing here reads a clock, a file or a network
// (the time is a parameter). Nothing calls it yet; with the test-services switch off, today's flow is unchanged.
//
// The order, best first: real software (a catalog entry, then an approved project image) > Rovara local AWS > a test account > a fake > nothing. The first backing that is ALLOWED and AVAILABLE wins.
//   - Allowed: the company's "Allowed backings" setting, narrowed (never widened) by every later layer: a project, a lock. `effectiveAllowedBackings` can only turn a backing off.
//   - Available: the catalog has a pinned, live entry for the edition (and the major version asked for), the emulator covers the service, an approved project image or fixture set exists, or a test account
//     is active, approved, for this project and names nothing on the production list.
// Exceptions, each with its reason in fixed words:
//   - tests that fake the dependency themselves win over everything, and nothing is started;
//   - a maintainer may choose a backing (it must still be allowed and available, or the default order applies and says why) or decline one;
//   - a test account is used only in sealed check rounds (task checks and nightly): while coding, in setup and on a team runner it is replaced by a fake, or by "not available while coding" (owner Q2);
//   - "test account for nightly only" (owner Q6): tasks never use the account, the nightly tries it first.
//
// Every word in the answer is fixed here. Nothing a repository or a person wrote (a dependency's name, an account's label) is echoed: the answer holds ids that passed their contract's pattern, and fixed sentences.
import {
  emulatorChoosable,
  isTestAccountUsableAt,
  testAccountProdProblems,
  type CatalogEntry,
  type ServiceCatalog,
  type TestAccount,
  type TestEnvProdDeny,
} from "@agentx/contracts";

// ---- what is allowed

/** The checkboxes of the company's "Allowed backings" setting (design 9.5). */
export interface AllowedBackings {
  /** Real software from Rovara's image catalog. */
  real: boolean;
  /** Rovara local AWS. */
  emulated: boolean;
  /** The project's own images (compose services, model images). */
  projectImages: boolean;
  testAccounts: boolean;
  /** Recorded and written fakes. */
  fakes: boolean;
  /** Fakes may make up answers for unrecorded requests. */
  fakeMakesUpAnswers: boolean;
}

/** The setting as it ships: own images, and fakes that make up answers, are off until a second admin turns them on (9.5). */
export const DEFAULT_ALLOWED_BACKINGS: AllowedBackings = { real: true, emulated: true, projectImages: false, testAccounts: true, fakes: true, fakeMakesUpAnswers: false };
const ALLOWED_KEYS = Object.keys(DEFAULT_ALLOWED_BACKINGS) as Array<keyof AllowedBackings>;

/**
 * The backings allowed after a company's setting and every narrower layer (a project's own setting, a lock). The company's layer sets each box (a missing one is the default); every later layer can only
 * turn a box OFF: a box it leaves out, or turns on, changes nothing. A value that is not exactly `false` or `true` is read as off (a mistake errs on the safe side). The order of the narrower layers does not matter.
 */
export function effectiveAllowedBackings(company: Partial<AllowedBackings> | undefined, ...narrower: ReadonlyArray<Partial<AllowedBackings> | undefined>): AllowedBackings {
  const result = { ...DEFAULT_ALLOWED_BACKINGS };
  for (const key of ALLOWED_KEYS) {
    const set = company?.[key];
    if (set !== undefined) result[key] = set === true;
    for (const layer of narrower) {
      const value = layer?.[key];
      if (value !== undefined && value !== true) result[key] = false;
    }
  }
  return result;
}

// ---- the facts

/** Where the dependency will run. Only the sealed places (a task's check round, the nightly run) may use a test account. */
export const BACKING_PLACES = ["task_check", "nightly", "prove_final", "working", "setup", "team_runner"] as const;
export type BackingPlace = (typeof BACKING_PLACES)[number];
// Prove's final run (`prove_final`) is a sealed place : its test checks run in the sealed check sandbox, so a test account may be used there (6.3: "task checks, Prove's final run, nightly and E2E rounds whose
// plan names the account"). Not here yet: the end-to-end checker's rounds are sealed too but have no place here yet; add it with tests when the E2E checker runs on the service runner, or a test account would be replaced by a
// fake in exactly the rounds meant to prove it. An unknown place is read as NOT sealed (fail closed).
const SEALED_PLACES: readonly BackingPlace[] = ["task_check", "nightly", "prove_final"];

export type BackingStep = "local" | "project_image" | "emulated" | "test_account" | "fake";
/** The order of 3.4. */
export const BACKING_ORDER: readonly BackingStep[] = ["local", "project_image", "emulated", "test_account", "fake"];

/** The dependency kinds a fake cannot stand in for (a database, a cache, a queue, a stream, a search index), unless the family is an AWS one, whose protocol a fake can speak (4.4). */
export const STATEFUL_KINDS: readonly string[] = ["database", "cache", "queue", "stream", "search"];

/** An approved fixture set for a family (the caller passes approved ones only). */
export interface FixtureFact {
  ref: string;
  family: string;
  origin: "recorded" | "hand_written";
  /** `schema_synth` makes up answers for requests with no recording, which a company may switch off. */
  unmatched: "fail" | "schema_synth";
}

export interface BackingChoiceInput {
  dependency: {
    family: string;
    kind: string;
    /** The major version the project uses (`16`), when known. A catalog entry must be of that version. */
    major?: string | undefined;
    /** D6 found an in-process fake in the project's own tests. */
    fakedByTests?: boolean | undefined;
    /** Owner Q6: the test account is for the nightly run only. */
    testAccountNightlyOnly?: boolean | undefined;
    /** A maintainer's choice of backing, or `none` to run without it. */
    maintainerChoice?: BackingStep | "none" | undefined;
  };
  place: BackingPlace;
  edition: "public" | "enterprise";
  /** The result of `effectiveAllowedBackings`. */
  allowed: AllowedBackings;
  catalog: ServiceCatalog;
  projectId: string;
  /** Approved project images (a compose service after review, or a model image). */
  projectImages: ReadonlyArray<{ imageId: string; family: string }>;
  accounts: readonly TestAccount[];
  prodDeny: TestEnvProdDeny;
  /** The list the approved environment had before this change, so removing an entry in the same change hides nothing (as `testAccountProdProblems` reads it). */
  alsoDeny?: TestEnvProdDeny;
  /** Rovara's own AWS account ids: an account whose role is in one of them is refused. */
  rovaraAccountIds?: readonly string[];
  fixtures: readonly FixtureFact[];
  /** The agent can record or write a fixture set for this family. */
  canMakeFake: boolean;
  /** The moment the answer is for. Accounts are checked against it. */
  now: Date | number | string;
}

// ---- the answer

export type ChosenBacking =
  | { kind: "local"; catalogId: string }
  | { kind: "project_image"; imageId: string }
  | { kind: "emulated"; catalogId: string; awsService: string }
  | { kind: "test_account"; accountId: string }
  /** `fixtureSetRef` is absent when the agent is to record or write the fixture set. */
  | { kind: "fake"; fixtureSetRef: string | undefined; origin: "recorded" | "hand_written" | "to_make" }
  | { kind: "none"; reason: "not_supported" | "declined" | "faked_by_tests" };

export const BACKING_REASONS = ["faked_by_tests", "maintainer_declined", "maintainer_choice", "nightly_account", "best_available", "not_available_while_coding", "nothing_available"] as const;
export type BackingReason = (typeof BACKING_REASONS)[number];
export const BACKING_REASON_WORDS: Record<BackingReason, string> = {
  faked_by_tests: "Your tests fake this themselves, so Rovara starts nothing.",
  maintainer_declined: "A maintainer chose to run without it.",
  maintainer_choice: "A maintainer chose this.",
  nightly_account: "The test account is used for the nightly run only.",
  best_available: "The best backing that is allowed and available.",
  not_available_while_coding: "A test account is used only in sealed checks, so nothing backs this while coding.",
  nothing_available: "Nothing that is allowed and available backs this.",
};

export const SKIP_REASONS = [
  "not_allowed", "not_in_catalog", "not_in_edition", "retired", "no_such_version", "not_pinned", "not_aws", "emulator_does_not_cover", "no_project_image",
  "only_in_sealed_checks", "nightly_only", "no_test_account", "account_not_for_project", "account_not_usable", "account_names_production", "production_list_missing",
  "fake_not_for_this_kind", "fake_makes_up_answers_not_allowed", "no_fixture_set", "maintainer_choice_unavailable",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const SKIP_REASON_WORDS: Record<SkipReason, string> = {
  not_allowed: "The company or the project does not allow this kind of backing.",
  not_in_catalog: "Rovara's image catalog has nothing for this.",
  not_in_edition: "The catalog's entry is not offered in this edition.",
  retired: "The catalog's entry is retired.",
  no_such_version: "The catalog has no entry for this major version.",
  not_pinned: "The catalog's entry is not pinned to an image yet.",
  not_aws: "Rovara local AWS backs AWS services only.",
  emulator_does_not_cover: "Rovara local AWS does not support this service yet.",
  no_project_image: "No approved project image backs this.",
  only_in_sealed_checks: "A test account is used only in sealed checks.",
  nightly_only: "The test account is set for the nightly run only.",
  no_test_account: "No test account covers this.",
  account_not_for_project: "The test account is not approved for this project.",
  account_not_usable: "The test account is not active and approved, or it has expired.",
  account_names_production: "The test account names something on the production list.",
  production_list_missing: "The production list is empty, so no test account can be used.",
  fake_not_for_this_kind: "A fake cannot stand in for this kind of dependency.",
  fake_makes_up_answers_not_allowed: "Only a fake that makes up answers exists, and the company does not allow that.",
  no_fixture_set: "No approved fixture set exists, and none can be made.",
  maintainer_choice_unavailable: "The backing a maintainer chose is not allowed or not available.",
};

export interface BackingChoice {
  backing: ChosenBacking;
  reason: BackingReason;
  /** The fixed sentence of `reason`. */
  words: string;
  /** Every step tried and passed over before the answer, in the order tried, each with its fixed reason. */
  skipped: Array<{ step: BackingStep | "maintainer"; reason: SkipReason; words: string }>;
  /** A test account or a project image, or a dependency with nothing behind it, needs a second person's approval (the "less safe" fields of 2.2). */
  lessSafe: boolean;
  /** A test account would have been used, but this place is not sealed: the answer is the fake that replaces it (owner Q2). */
  replacedTestAccount: boolean;
}

// ---- helpers

/** The numbers in a version, compared one by one: `16.4` after `16.10`. */
function compareVersions(a: string, b: string): number {
  const left = a.split(/\D+/u).filter((part) => part !== "").map(Number);
  const right = b.split(/\D+/u).filter((part) => part !== "").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The default entry first, then the newest version, then the id: the same pick every time. */
function bestEntry(entries: readonly CatalogEntry[]): CatalogEntry | undefined {
  return [...entries].sort((a, b) => Number(b.status === "default") - Number(a.status === "default") || compareVersions(b.version, a.version) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

const matchesMajor = (entry: CatalogEntry, major: string | undefined) => major === undefined || entry.version === major || entry.version.startsWith(`${major}.`);

type Step<T> = { pick: T } | { skip: SkipReason };

/** The live, pinned entries of the catalog for an edition, narrowed one rule at a time so the first rule that empties the list is the reason. */
function catalogStep(input: BackingChoiceInput, entries: readonly CatalogEntry[], major: string | undefined): Step<CatalogEntry> {
  if (entries.length === 0) return { skip: "not_in_catalog" };
  const inEdition = entries.filter((entry) => entry.editions.includes(input.edition));
  if (inEdition.length === 0) return { skip: "not_in_edition" };
  const live = inEdition.filter((entry) => entry.status !== "retired");
  if (live.length === 0) return { skip: "retired" };
  const versioned = live.filter((entry) => matchesMajor(entry, major));
  if (versioned.length === 0) return { skip: "no_such_version" };
  // Rovara never starts an image it has not pinned by digest.
  const pinned = versioned.filter((entry) => entry.image.digest !== undefined);
  const best = bestEntry(pinned);
  return best === undefined ? { skip: "not_pinned" } : { pick: best };
}

const awsServiceOf = (family: string): string | undefined => (family.startsWith("aws:") ? family.slice(4) : undefined);

function localStep(input: BackingChoiceInput): Step<ChosenBacking> {
  if (input.allowed.real !== true) return { skip: "not_allowed" };
  const found = catalogStep(input, input.catalog.entries.filter((entry) => entry.backing === "local" && entry.family === input.dependency.family), input.dependency.major);
  return "skip" in found ? found : { pick: { kind: "local", catalogId: found.pick.id } };
}

function projectImageStep(input: BackingChoiceInput): Step<ChosenBacking> {
  if (input.allowed.projectImages !== true) return { skip: "not_allowed" };
  const images = input.projectImages.filter((image) => image.family === input.dependency.family).map((image) => image.imageId).sort();
  const first = images[0];
  return first === undefined ? { skip: "no_project_image" } : { pick: { kind: "project_image", imageId: first } };
}

function emulatedStep(input: BackingChoiceInput): Step<ChosenBacking> {
  if (input.allowed.emulated !== true) return { skip: "not_allowed" };
  const service = awsServiceOf(input.dependency.family);
  if (service === undefined) return { skip: "not_aws" };
  const found = catalogStep(input, input.catalog.entries.filter((entry) => entry.backing === "emulated"), undefined);
  if ("skip" in found) return found;
  // The best entry that covers the service; one that does not is passed over for one that does.
  const emulators = input.catalog.entries.filter((entry) => entry.backing === "emulated" && entry.emulator !== undefined && entry.editions.includes(input.edition) && entry.status !== "retired" && entry.image.digest !== undefined);
  const covering = emulators.filter((entry) => entry.emulator !== undefined && emulatorChoosable(entry.emulator, service));
  const best = bestEntry(covering);
  return best === undefined ? { skip: "emulator_does_not_cover" } : { pick: { kind: "emulated", catalogId: best.id, awsService: service } };
}

/** The optional parts of the production check, passed only when given. */
function prodOptions(input: BackingChoiceInput): { alsoDeny?: TestEnvProdDeny; rovaraAccountIds?: readonly string[] } {
  return { ...(input.alsoDeny === undefined ? {} : { alsoDeny: input.alsoDeny }), ...(input.rovaraAccountIds === undefined ? {} : { rovaraAccountIds: input.rovaraAccountIds }) };
}

/** The test account step, as if the place were sealed; the caller applies the place and the nightly-only rules. */
function testAccountStep(input: BackingChoiceInput): Step<ChosenBacking> {
  if (input.allowed.testAccounts !== true) return { skip: "not_allowed" };
  const covering = input.accounts.filter((account) => account.family === input.dependency.family);
  if (covering.length === 0) return { skip: "no_test_account" };
  const forProject = covering.filter((account) => account.projectIds === "all" || account.projectIds.includes(input.projectId));
  if (forProject.length === 0) return { skip: "account_not_for_project" };
  const usable = forProject.filter((account) => isTestAccountUsableAt(account, input.now));
  if (usable.length === 0) return { skip: "account_not_usable" };
  const problems = usable.map((account) => ({ account, problems: testAccountProdProblems(account, input.prodDeny, prodOptions(input)) }));
  const clean = problems.filter((entry) => entry.problems.length === 0).map((entry) => entry.account.id).sort();
  const first = clean[0];
  if (first !== undefined) return { pick: { kind: "test_account", accountId: first } };
  return { skip: problems.some((entry) => entry.problems.some((problem) => problem.kind === "prod_deny_missing")) ? "production_list_missing" : "account_names_production" };
}

function fakeStep(input: BackingChoiceInput): Step<ChosenBacking> {
  if (input.allowed.fakes !== true) return { skip: "not_allowed" };
  if (STATEFUL_KINDS.includes(input.dependency.kind) && !input.dependency.family.startsWith("aws:")) return { skip: "fake_not_for_this_kind" };
  const ofFamily = input.fixtures.filter((fixture) => fixture.family === input.dependency.family);
  const permitted = ofFamily.filter((fixture) => fixture.unmatched === "fail" || input.allowed.fakeMakesUpAnswers === true);
  // A recording is closer to the real thing than a hand-written fake; then the reference decides.
  const best = [...permitted].sort((a, b) => Number(b.origin === "recorded") - Number(a.origin === "recorded") || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))[0];
  if (best !== undefined) return { pick: { kind: "fake", fixtureSetRef: best.ref, origin: best.origin } };
  if (input.canMakeFake) return { pick: { kind: "fake", fixtureSetRef: undefined, origin: "to_make" } };
  return { skip: ofFamily.length > 0 ? "fake_makes_up_answers_not_allowed" : "no_fixture_set" };
}

const words = (reason: SkipReason) => SKIP_REASON_WORDS[reason];

/**
 * What backs one dependency, with the reason in fixed words and every step passed over. Never throws: facts it cannot read (a time that is not a time) make a step unavailable, never available.
 */
export function chooseBacking(input: BackingChoiceInput): BackingChoice {
  try {
    return choose(input);
  } catch {
    // Facts that are not what the types say (a null, a choice nobody defined) must not break a run: nothing backs the dependency, and the answer says so.
    return { backing: { kind: "none", reason: "not_supported" }, reason: "nothing_available", words: BACKING_REASON_WORDS.nothing_available, skipped: [], lessSafe: true, replacedTestAccount: false };
  }
}

function choose(input: BackingChoiceInput): BackingChoice {
  const done = (backing: ChosenBacking, reason: BackingReason, skipped: BackingChoice["skipped"], replacedTestAccount = false): BackingChoice => ({
    backing, reason, words: BACKING_REASON_WORDS[reason], skipped, replacedTestAccount,
    lessSafe: backing.kind === "test_account" || backing.kind === "project_image" || (backing.kind === "none" && backing.reason !== "faked_by_tests"),
  });
  const { dependency, place } = input;

  // Tests that fake it themselves win over everything, and nothing starts.
  if (dependency.fakedByTests === true) return done({ kind: "none", reason: "faked_by_tests" }, "faked_by_tests", []);
  if (dependency.maintainerChoice === "none") return done({ kind: "none", reason: "declined" }, "maintainer_declined", []);

  const sealed = SEALED_PLACES.includes(place);
  const nightlyOnly = dependency.testAccountNightlyOnly === true;
  let swappedAccount = false;
  const evaluate = (step: BackingStep): Step<ChosenBacking> => {
    switch (step) {
      case "local": return localStep(input);
      case "project_image": return projectImageStep(input);
      case "emulated": return emulatedStep(input);
      case "fake": return fakeStep(input);
      case "test_account": {
        const found = testAccountStep(input);
        if ("skip" in found) return found;
        // A usable account exists, but where it may not be used it is replaced (by a fake, or by nothing).
        if (!sealed) { swappedAccount = true; return { skip: "only_in_sealed_checks" }; }
        if (nightlyOnly && place !== "nightly") return { skip: "nightly_only" };
        return found;
      }
      default: return { skip: "not_allowed" };
    }
  };

  // The order tried: the default, with the nightly account first for a nightly-only account, and a maintainer's choice before all.
  const base: BackingStep[] = nightlyOnly && place === "nightly" ? ["test_account", ...BACKING_ORDER.filter((step) => step !== "test_account")] : [...BACKING_ORDER];
  // A maintainer's choice that is not one of the backings (a typo, a name nobody defined) is unavailable: it is passed over, says so, and the default order applies.
  const asked: unknown = dependency.maintainerChoice;
  const choice: BackingStep | undefined = BACKING_ORDER.find((step) => step === asked);
  const order = choice === undefined ? base : [choice, ...base.filter((step) => step !== choice)];

  const skipped: BackingChoice["skipped"] = [];
  if (asked !== undefined && choice === undefined) skipped.push({ step: "maintainer", reason: "maintainer_choice_unavailable", words: words("maintainer_choice_unavailable") });
  for (const step of order) {
    const found = evaluate(step);
    if ("pick" in found) {
      const reason: BackingReason = step === choice ? "maintainer_choice" : nightlyOnly && place === "nightly" && step === "test_account" ? "nightly_account" : "best_available";
      return done(found.pick, reason, skipped, swappedAccount && step === "fake");
    }
    // A maintainer's choice that cannot be used says so, whatever the step's own reason is.
    skipped.push({ step, reason: found.skip, words: words(found.skip) });
    if (step === choice) skipped.push({ step, reason: "maintainer_choice_unavailable", words: words("maintainer_choice_unavailable") });
  }
  return done({ kind: "none", reason: "not_supported" }, swappedAccount ? "not_available_while_coding" : "nothing_available", skipped);
}
