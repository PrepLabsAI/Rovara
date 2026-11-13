// Test services: the backing chooser. Pure and deterministic: the order, what is allowed and available, the exceptions, the working-sandbox swap, "test account for nightly only",
// and the rule that a lock can only be stricter. Every key-shaped value is built at runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ServiceCatalogSchema, type ServiceCatalog } from "../../packages/contracts/src/service-catalog.js";
import { TestEnvDependenciesSchema, readTestEnvDependencies, testEnvDependencyApprovalRisk, testEnvDependencyLessSafeChanges } from "../../packages/contracts/src/test-env-dependency.js";
import { TestEnvServiceSchema } from "../../packages/contracts/src/test-environment.js";
import { testAccountApprovalDigest, testAccountExternalId, testAccountSecretRef, TestAccountSchema, type TestAccount } from "../../packages/contracts/src/test-account.js";
import {
  BACKING_ORDER, BACKING_PLACES, BACKING_REASONS, BACKING_REASON_WORDS, DEFAULT_ALLOWED_BACKINGS, LEGACY_ALLOWED_BACKINGS, SKIP_REASONS, SKIP_REASON_WORDS, chooseBacking, effectiveAllowedBackings,
  type AllowedBackings, type BackingChoiceInput, type FixtureFact,
} from "../../packages/broker/src/core/test-env/backing-choice.js";

const sha = (letter: string) => letter.repeat(64);
const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const person = (letter: string) => letter.repeat(64);

// ---- facts
const rawCatalog = () => JSON.parse(readFileSync("tests/fixtures/service-catalog/catalog.json", "utf8")) as { pinned: boolean; entries: Array<Record<string, unknown> & { id: string; image: Record<string, unknown> }> };
/** The v1 data file with every live entry pinned (a digest, an SBOM and a scan), as it is once pinned. */
function pinnedCatalog(change: (entries: ReturnType<typeof rawCatalog>["entries"]) => void = () => undefined): ServiceCatalog {
  const raw = rawCatalog();
  for (const entry of raw.entries) {
    // a helper that runs from the worker's own image has no image to pin.
    if ((entry as { workerImage?: boolean }).workerImage === true) continue;
    entry.image.digest = sha("a");
    entry.sbomRef = sha("b");
    entry.scan = { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 0 };
  }
  raw.pinned = true;
  change(raw.entries);
  return ServiceCatalogSchema.parse(raw);
}
/** An explicit UNPINNED fixture: the shipped file's entries with every pin taken off, so this does not change when an operator pins an entry in the shipped file. */
const unpinnedCatalog = () => {
  const raw = rawCatalog();
  raw.pinned = false;
  for (const entry of raw.entries) {
    delete entry.image.digest;
    delete entry["sbomRef"];
    delete entry["scan"];
  }
  return ServiceCatalogSchema.parse(raw);
};

const approval = (by: string) => ({ by: person(by), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver", approvedDigest: "" });
function account(over: Record<string, unknown> = {}): TestAccount {
  const base: Record<string, unknown> = {
    id: "payments-test", orgId: ORG, projectIds: ["orders"], family: "http:api.example-pay.com", label: "Payments test mode", kind: "api_key",
    secretRef: testAccountSecretRef("staging", ORG, "payments-test", "apiKey"), hosts: ["api.example-pay.com"], envNames: ["PAYMENTS_API_KEY"],
    limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 }, approvals: [approval("a"), approval("b")], status: "active", expiresAt: "2027-01-30T10:00:00.000Z", ...over,
  };
  const digest = testAccountApprovalDigest(base as never);
  return TestAccountSchema.parse({ ...base, approvals: (base.approvals as Array<Record<string, unknown>>).map((each) => ({ ...each, approvedDigest: digest })) });
}
const dynamoAccount = (over: Record<string, unknown> = {}) => account({
  id: "orders-dev", family: "aws:dynamodb", label: "Dev AWS (orders)", kind: "aws_role", secretRef: undefined, envNames: [], hosts: ["dynamodb.us-west-2.amazonaws.com"],
  aws: { roleArn: "arn:aws:iam::222222222222:role/rovara-test", externalId: testAccountExternalId(ORG, typeof over.id === "string" ? over.id : "orders-dev"), region: "us-west-2", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: ["arn:aws:dynamodb:us-west-2:222222222222:table/orders-test"] }, ...over,
});

const fixture = (ref: string, over: Partial<FixtureFact> = {}): FixtureFact => ({ ref, family: "http:api.example-pay.com", origin: "recorded", unmatched: "fail", ...over });
const PROD = { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] };

type Over = Omit<Partial<BackingChoiceInput>, "dependency"> & { dependency?: Partial<BackingChoiceInput["dependency"]> };
function input(over: Over = {}): BackingChoiceInput {
  const { dependency, ...rest } = over;
  return {
    dependency: { family: "postgres", kind: "database", ...dependency },
    place: "task_check", edition: "public", allowed: DEFAULT_ALLOWED_BACKINGS, catalog: pinnedCatalog(), projectId: "orders", projectImages: [], accounts: [], prodDeny: PROD, fixtures: [], canMakeFake: false,
    now: "2026-11-03T00:00:00.000Z", ...rest,
  };
}
const s3 = (over: Over = {}) => input({ dependency: { family: "aws:s3", kind: "object_store" }, ...over });
const pay = (over: Over = {}) => input({ ...over, dependency: { family: "http:api.example-pay.com", kind: "http_api", ...over.dependency } });
const dynamo = (over: Over = {}) => input({ ...over, dependency: { family: "aws:dynamodb", kind: "database", ...over.dependency } });
const allow = (over: Partial<AllowedBackings>): AllowedBackings => ({ ...DEFAULT_ALLOWED_BACKINGS, ...over });
const steps = (choice: ReturnType<typeof chooseBacking>) => choice.skipped.map((each) => `${each.step}:${each.reason}`);

describe("the order (3.4)", () => {
  it("fixes the order: real > Rovara local AWS > test account > fake", () => {
    expect(BACKING_ORDER).toEqual(["local", "project_image", "emulated", "test_account", "fake"]);
  });
  it("picks real software first: the default entry of the family, at the project's major version", () => {
    const choice = chooseBacking(input({ dependency: { major: "16" } }));
    expect(choice.backing).toEqual({ kind: "local", catalogId: "postgres@16" });
    expect(choice.reason).toBe("best_available");
    expect(choice.skipped).toEqual([]);
    expect(chooseBacking(input({ dependency: { major: "15" } })).backing).toEqual({ kind: "local", catalogId: "postgres@15" });
    expect(chooseBacking(input({ dependency: { major: "1" } })).backing.kind).toBe("none");
  });
  it("without a major version it takes the default entry, then the newest", () => {
    expect(chooseBacking(input()).backing).toEqual({ kind: "local", catalogId: "postgres@16" });
    const noDefault = pinnedCatalog((entries) => { entries.find((entry) => entry.id === "postgres@16")!.status = "available"; });
    expect(chooseBacking(input({ catalog: noDefault })).backing).toEqual({ kind: "local", catalogId: "postgres@17" });
  });
  it("compares versions by their numbers, not as text", () => {
    const catalog = pinnedCatalog((entries) => {
      entries.find((entry) => entry.id === "postgres@16")!.status = "available";
      entries.find((entry) => entry.id === "postgres@16")!.version = "15.2";
      entries.find((entry) => entry.id === "postgres@15")!.version = "15.10";
      entries.find((entry) => entry.id === "postgres@17")!.version = "15.9";
    });
    expect(chooseBacking(input({ catalog })).backing).toEqual({ kind: "local", catalogId: "postgres@15" });
  });
  it("prefers the catalog to an approved project image", () => {
    const choice = chooseBacking(input({ allowed: allow({ projectImages: true }), projectImages: [{ imageId: "my-postgres", family: "postgres" }] }));
    expect(choice.backing).toEqual({ kind: "local", catalogId: "postgres@16" });
  });
  it("uses an approved project image when the catalog has nothing, and the first by id", () => {
    const images = [{ imageId: "zeta-queue", family: "rabbitmq" }, { imageId: "alpha-queue", family: "rabbitmq" }, { imageId: "other", family: "kafka" }];
    const choice = chooseBacking(input({ dependency: { family: "kafka", kind: "stream" }, allowed: allow({ projectImages: true }), projectImages: images }));
    expect(choice.backing).toEqual({ kind: "project_image", imageId: "other" });
    expect(chooseBacking(input({ dependency: { family: "rabbitmq", kind: "queue", major: "9" }, allowed: allow({ projectImages: true }), projectImages: images })).backing).toEqual({ kind: "project_image", imageId: "alpha-queue" });
  });
  it("picks Rovara local AWS for a service it supports, with that service", () => {
    const choice = chooseBacking(s3());
    expect(choice.backing).toEqual({ kind: "emulated", catalogId: "local-aws@r1", awsService: "s3" });
    expect(steps(choice)).toEqual(["local:not_in_catalog", "project_image:not_allowed"]);
  });
  it("serves functions and the model-endpoint front, and passes over a service it only has", () => {
    expect(chooseBacking(input({ dependency: { family: "aws:lambda", kind: "cloud_api" } })).backing.kind).toBe("emulated");
    expect(chooseBacking(input({ dependency: { family: "aws:sagemaker-runtime", kind: "model_endpoint" } })).backing.kind).toBe("emulated");
    const kinesis = chooseBacking(input({ dependency: { family: "aws:kinesis", kind: "stream" } }));
    expect(kinesis.backing.kind).toBe("none");
    expect(steps(kinesis)).toContain("emulated:emulator_does_not_cover");
    expect(chooseBacking(input({ dependency: { family: "aws:nothing-we-know", kind: "other" } })).backing.kind).toBe("none");
  });
  it("picks a test account before a fake, and Rovara local AWS before a test account", () => {
    const withBoth = { accounts: [account()], fixtures: [fixture(sha("1"))] };
    expect(chooseBacking(pay(withBoth)).backing).toEqual({ kind: "test_account", accountId: "payments-test" });
    expect(chooseBacking(dynamo({ accounts: [dynamoAccount()] })).backing.kind).toBe("emulated");
  });
  it("picks a fake last: a recording before a hand-written one, then the lowest reference", () => {
    const fixtures = [fixture(sha("9"), { origin: "hand_written" }), fixture(sha("5")), fixture(sha("3")), fixture(sha("1"), { family: "http:other.example.com" })];
    expect(chooseBacking(pay({ fixtures })).backing).toEqual({ kind: "fake", fixtureSetRef: sha("3"), origin: "recorded" });
    const lowHandWritten = [fixture(sha("1"), { origin: "hand_written" }), fixture(sha("5")), fixture(sha("3"))];
    expect(chooseBacking(pay({ fixtures: lowHandWritten })).backing).toEqual({ kind: "fake", fixtureSetRef: sha("3"), origin: "recorded" });
    expect(chooseBacking(pay({ fixtures: [fixture(sha("9"), { origin: "hand_written" })] })).backing).toEqual({ kind: "fake", fixtureSetRef: sha("9"), origin: "hand_written" });
  });
  it("asks for a fake to be made when none exists and the agent can make one", () => {
    expect(chooseBacking(pay({ canMakeFake: true })).backing).toEqual({ kind: "fake", fixtureSetRef: undefined, origin: "to_make" });
    expect(chooseBacking(pay({ canMakeFake: true, fixtures: [fixture(sha("3"))] })).backing).toEqual({ kind: "fake", fixtureSetRef: sha("3"), origin: "recorded" });
  });
  it("ends with nothing, and says why each step was passed over", () => {
    const choice = chooseBacking(pay());
    expect(choice.backing).toEqual({ kind: "none", reason: "not_supported" });
    expect(choice.reason).toBe("nothing_available");
    expect(steps(choice)).toEqual(["local:not_in_catalog", "project_image:not_allowed", "emulated:not_aws", "test_account:no_test_account", "fake:no_fixture_set"]);
  });
});

describe("allowed", () => {
  it("each box turns off exactly one kind of backing", () => {
    const withEverything = { accounts: [dynamoAccount()], fixtures: [fixture(sha("3"), { family: "aws:dynamodb" })], projectImages: [{ imageId: "my-dynamo", family: "aws:dynamodb" }], canMakeFake: true };
    expect(chooseBacking(dynamo({ ...withEverything, allowed: allow({ projectImages: true }) })).backing).toEqual({ kind: "project_image", imageId: "my-dynamo" });
    expect(chooseBacking(dynamo({ ...withEverything, allowed: allow({ emulated: false }) })).backing).toEqual({ kind: "test_account", accountId: "orders-dev" });
    expect(chooseBacking(dynamo({ ...withEverything, allowed: allow({ emulated: false, testAccounts: false }) })).backing).toMatchObject({ kind: "fake", fixtureSetRef: sha("3") });
    expect(chooseBacking(dynamo({ ...withEverything, allowed: allow({ emulated: false, testAccounts: false, fakes: false }) })).backing).toEqual({ kind: "none", reason: "not_supported" });
    expect(chooseBacking(input({ allowed: allow({ real: false }) })).skipped[0]).toMatchObject({ step: "local", reason: "not_allowed" });
    expect(chooseBacking(dynamo({ ...withEverything, allowed: allow({ emulated: false }) })).skipped.find((each) => each.step === "emulated")?.reason).toBe("not_allowed");
  });
  it("a fake that makes up answers is used by default (TE-A3, O11), and a company can switch it off", () => {
    const synth = [fixture(sha("3"), { unmatched: "schema_synth" })];
    const off = allow({ fakeMakesUpAnswers: false });
    expect(steps(chooseBacking(pay({ fixtures: synth, allowed: off })))).toContain("fake:fake_makes_up_answers_not_allowed");
    expect(chooseBacking(pay({ fixtures: synth, allowed: off })).backing.kind).toBe("none");
    expect(chooseBacking(pay({ fixtures: synth })).backing).toMatchObject({ kind: "fake", fixtureSetRef: sha("3") });
    expect(chooseBacking(pay({ fixtures: synth, allowed: allow({ fakeMakesUpAnswers: true }) })).backing).toMatchObject({ kind: "fake", fixtureSetRef: sha("3") });
    // A fixture set that does not make up answers is used instead, and so is a new one made by the agent.
    expect(chooseBacking(pay({ fixtures: [...synth, fixture(sha("7"))], allowed: off })).backing).toMatchObject({ fixtureSetRef: sha("7") });
    expect(chooseBacking(pay({ fixtures: synth, canMakeFake: true, allowed: off })).backing).toMatchObject({ origin: "to_make" });
  });
  it("a fake cannot stand in for a database, a cache, a queue, a stream or a search index, but can for the same service on AWS", () => {
    for (const kind of ["database", "cache", "queue", "stream", "search"]) {
      const choice = chooseBacking(input({ dependency: { family: "mystery", kind }, fixtures: [fixture(sha("3"), { family: "mystery" })], canMakeFake: true }));
      expect(choice.backing, kind).toEqual({ kind: "none", reason: "not_supported" });
      expect(steps(choice), kind).toContain("fake:fake_not_for_this_kind");
    }
    expect(chooseBacking(input({ dependency: { family: "mystery", kind: "http_api" }, fixtures: [fixture(sha("3"), { family: "mystery" })] })).backing.kind).toBe("fake");
    expect(chooseBacking(dynamo({ allowed: allow({ emulated: false }), fixtures: [fixture(sha("3"), { family: "aws:dynamodb" })] })).backing.kind).toBe("fake");
  });
  it("the edition: an entry the edition does not offer is not available", () => {
    const publicOnly = pinnedCatalog((entries) => { for (const entry of entries) if (entry.family === "postgres") entry.editions = ["public"]; });
    expect(chooseBacking(input({ catalog: publicOnly, edition: "public" })).backing.kind).toBe("local");
    const enterprise = chooseBacking(input({ catalog: publicOnly, edition: "enterprise" }));
    expect(enterprise.backing.kind).toBe("none");
    expect(steps(enterprise)[0]).toBe("local:not_in_edition");
    const noEmulator = pinnedCatalog((entries) => { entries.find((entry) => entry.id === "local-aws@r1")!.editions = ["enterprise"]; });
    expect(steps(chooseBacking(s3({ catalog: noEmulator, edition: "public" })))).toContain("emulated:not_in_edition");
    expect(chooseBacking(s3({ catalog: noEmulator, edition: "enterprise" })).backing.kind).toBe("emulated");
  });
  it("a retired entry, and an entry not pinned to an image, are not available", () => {
    const retired = pinnedCatalog((entries) => { for (const entry of entries) if (entry.family === "postgres") entry.status = "retired"; });
    expect(steps(chooseBacking(input({ catalog: retired })))[0]).toBe("local:retired");
    // A retired entry has no digest, scan or SBOM in the data file, and still is not run.
    expect(steps(chooseBacking(input({ catalog: unpinnedCatalog() })))[0]).toBe("local:not_pinned");
    expect(steps(chooseBacking(s3({ catalog: unpinnedCatalog() })))).toContain("emulated:not_pinned");
    expect(steps(chooseBacking(s3({ catalog: pinnedCatalog((entries) => { entries.find((entry) => entry.id === "local-aws@r1")!.status = "retired"; delete entries.find((entry) => entry.id === "local-aws@r1")!.image.digest; }) })))).toContain("emulated:retired");
  });
  it("breaks a tie of status and version by the id, and passes over an emulator entry that is retired or not offered", () => {
    const tie = pinnedCatalog((entries) => {
      for (const entry of entries) if (entry.family === "postgres") { entry.status = "available"; entry.version = "15.0"; }
    });
    expect(chooseBacking(input({ catalog: tie })).backing).toEqual({ kind: "local", catalogId: "postgres@15" });
    const second = (change: (entry: Record<string, unknown> & { id: string }) => void) => pinnedCatalog((entries) => {
      const first = entries.find((entry) => entry.id === "local-aws@r1")!;
      const copy = JSON.parse(JSON.stringify(first)) as typeof first;
      copy.id = "local-aws@r2";
      copy.status = "available";
      change(first);
      entries.push(copy);
    });
    // The default entry is retired: the other one is used. Likewise when the default is not offered in this edition.
    expect(chooseBacking(s3({ catalog: second((entry) => { entry.status = "retired"; }) })).backing).toMatchObject({ kind: "emulated", catalogId: "local-aws@r2" });
    expect(chooseBacking(s3({ catalog: second((entry) => { entry.editions = ["enterprise"]; }), edition: "public" })).backing).toMatchObject({ catalogId: "local-aws@r2" });
    expect(chooseBacking(s3({ catalog: second(() => undefined) })).backing).toMatchObject({ catalogId: "local-aws@r1" });
    // The emulator entry that covers the service is used, not the default one that does not.
    const covers = second((entry) => { (entry.emulator as { services: Record<string, string[]> }).services.supported = ["dynamodb"]; });
    expect(chooseBacking(s3({ catalog: covers })).backing).toMatchObject({ catalogId: "local-aws@r2" });
    expect(chooseBacking(dynamo({ catalog: covers })).backing).toMatchObject({ catalogId: "local-aws@r1", awsService: "dynamodb" });
  });
  it("an entry of the right kind is needed: a helper or a fake server is never real software", () => {
    expect(steps(chooseBacking(input({ dependency: { family: "dns-helper", kind: "other" } })))[0]).toBe("local:not_in_catalog");
    expect(steps(chooseBacking(input({ dependency: { family: "fake-server", kind: "other" } })))[0]).toBe("local:not_in_catalog");
  });
});

describe("effectiveAllowedBackings: a lock can only be stricter", () => {
  const KEYS = Object.keys(DEFAULT_ALLOWED_BACKINGS) as Array<keyof AllowedBackings>;
  it("starts from the shipped defaults: Rovara-made and made-up answers are allowed (O11), own images are not", () => {
    expect(effectiveAllowedBackings(undefined)).toEqual({ real: true, emulated: true, projectImages: false, testAccounts: true, fakes: true, fakeMakesUpAnswers: true });
    expect(DEFAULT_ALLOWED_BACKINGS.fakeMakesUpAnswers).toBe(true);
  });
  it("keeps the answer a company's stored setting already gave: a stored false stays false, and a stored setting that predates the change and says nothing about made-up answers reads as before (off)", () => {
    expect(effectiveAllowedBackings({ fakeMakesUpAnswers: false }).fakeMakesUpAnswers).toBe(false);
    expect(effectiveAllowedBackings({ real: true, emulated: true, projectImages: false, testAccounts: true, fakes: true }).fakeMakesUpAnswers).toBe(false);
    expect(effectiveAllowedBackings({}).fakeMakesUpAnswers).toBe(false);
    expect(effectiveAllowedBackings({ fakeMakesUpAnswers: true }).fakeMakesUpAnswers).toBe(true);
    expect(effectiveAllowedBackings(undefined).fakeMakesUpAnswers).toBe(true);
    // A project or a lock can still turn it off, never on.
    expect(effectiveAllowedBackings(undefined, { fakeMakesUpAnswers: false }).fakeMakesUpAnswers).toBe(false);
    expect(effectiveAllowedBackings({ fakeMakesUpAnswers: false }, { fakeMakesUpAnswers: true }).fakeMakesUpAnswers).toBe(false);
  });
  it("changes nothing else a setting says", () => {
    expect(LEGACY_ALLOWED_BACKINGS).toEqual({ ...DEFAULT_ALLOWED_BACKINGS, fakeMakesUpAnswers: false });
    expect({ ...DEFAULT_ALLOWED_BACKINGS, fakeMakesUpAnswers: false }).toEqual({ real: true, emulated: true, projectImages: false, testAccounts: true, fakes: true, fakeMakesUpAnswers: false });
  });
  it("the company layer sets any box (own images need a second admin elsewhere)", () => {
    expect(effectiveAllowedBackings({ projectImages: true, testAccounts: false })).toMatchObject({ projectImages: true, testAccounts: false, real: true });
  });
  it("a narrower layer turns boxes off and never on", () => {
    const company = { projectImages: false, fakes: true };
    expect(effectiveAllowedBackings(company, { projectImages: true })).toMatchObject({ projectImages: false });
    expect(effectiveAllowedBackings(company, { fakes: false })).toMatchObject({ fakes: false });
    expect(effectiveAllowedBackings(company, { fakes: true })).toMatchObject({ fakes: true, real: true });
  });
  it("is never wider than the company's layer, whatever the narrower layers say, in any order", () => {
    const company: Partial<AllowedBackings> = { real: true, emulated: false, projectImages: false, testAccounts: true, fakes: true, fakeMakesUpAnswers: false };
    const layers: Array<Partial<AllowedBackings>> = [{ emulated: true, projectImages: true, fakeMakesUpAnswers: true }, { testAccounts: false }, {}, { real: true, fakes: true }];
    const permutations = [layers, [...layers].reverse(), [layers[1]!, layers[3]!, layers[0]!, layers[2]!]];
    const results = permutations.map((order) => effectiveAllowedBackings(company, ...order));
    for (const result of results) {
      expect(result).toEqual(results[0]);
      const base = effectiveAllowedBackings(company);
      for (const key of KEYS) if (!base[key]) expect(result[key], key).toBe(false);
      expect(result.testAccounts).toBe(false);
    }
  });
  it("reads anything that is not exactly true as off in a narrower layer, and in the company layer", () => {
    expect(effectiveAllowedBackings(undefined, { real: "yes" as unknown as boolean, emulated: null as unknown as boolean, fakes: 0 as unknown as boolean })).toMatchObject({ real: false, emulated: false, fakes: false });
    expect(effectiveAllowedBackings({ real: "true" as unknown as boolean })).toMatchObject({ real: false });
  });
  it("does not change its inputs", () => {
    const company = Object.freeze({ real: true });
    const narrower = Object.freeze({ real: false });
    expect(effectiveAllowedBackings(company, narrower).real).toBe(false);
    expect(company).toEqual({ real: true });
  });
});

describe("exceptions", () => {
  it("tests that fake the dependency themselves win over everything, and nothing is started", () => {
    const everything = { accounts: [account()], fixtures: [fixture(sha("3"))], canMakeFake: true };
    const choice = chooseBacking(pay({ ...everything, dependency: { fakedByTests: true } }));
    expect(choice).toMatchObject({ backing: { kind: "none", reason: "faked_by_tests" }, reason: "faked_by_tests", skipped: [], lessSafe: false });
    expect(chooseBacking(s3({ dependency: { fakedByTests: true } })).backing).toEqual({ kind: "none", reason: "faked_by_tests" });
    // Even where nothing at all is allowed.
    expect(chooseBacking(s3({ dependency: { fakedByTests: true }, allowed: allow({ real: false, emulated: false, fakes: false, testAccounts: false }) })).backing.kind).toBe("none");
  });
  it("a maintainer may choose a fake over a test account, which is not less safe", () => {
    const choice = chooseBacking(pay({ accounts: [account()], fixtures: [fixture(sha("3"))], dependency: { maintainerChoice: "fake" } }));
    expect(choice).toMatchObject({ backing: { kind: "fake", fixtureSetRef: sha("3") }, reason: "maintainer_choice", lessSafe: false });
  });
  it("a maintainer may choose a test account over the emulator, which is less safe", () => {
    const choice = chooseBacking(dynamo({ accounts: [dynamoAccount()], dependency: { maintainerChoice: "test_account" } }));
    expect(choice).toMatchObject({ backing: { kind: "test_account", accountId: "orders-dev" }, reason: "maintainer_choice", lessSafe: true });
  });
  it("a maintainer's choice must still be allowed and available, or the default order applies and says so", () => {
    const base = { accounts: [dynamoAccount()] };
    const notAllowed = chooseBacking(dynamo({ ...base, allowed: allow({ testAccounts: false }), dependency: { maintainerChoice: "test_account" } }));
    expect(notAllowed.backing.kind).toBe("emulated");
    expect(steps(notAllowed)).toEqual(["test_account:not_allowed", "test_account:maintainer_choice_unavailable", "local:not_in_catalog", "project_image:not_allowed"]);
    const notThere = chooseBacking(pay({ fixtures: [fixture(sha("3"))], dependency: { maintainerChoice: "project_image" } }));
    expect(notThere.backing.kind).toBe("fake");
    expect(steps(notThere)).toContain("project_image:maintainer_choice_unavailable");
    expect(notThere.reason).toBe("best_available");
    // A maintainer cannot bring a test account into a place that is not sealed.
    expect(chooseBacking(dynamo({ ...base, place: "working", dependency: { maintainerChoice: "test_account" } })).backing.kind).toBe("emulated");
  });
  it("a maintainer may decline a backing: the dependency runs without it, which needs a second person", () => {
    const choice = chooseBacking(s3({ dependency: { maintainerChoice: "none" } }));
    expect(choice).toMatchObject({ backing: { kind: "none", reason: "declined" }, reason: "maintainer_declined", lessSafe: true });
  });
  it("marks what a second person must approve", () => {
    expect(chooseBacking(input()).lessSafe).toBe(false);
    expect(chooseBacking(s3()).lessSafe).toBe(false);
    expect(chooseBacking(pay({ fixtures: [fixture(sha("3"))] })).lessSafe).toBe(false);
    expect(chooseBacking(pay({ canMakeFake: true })).lessSafe).toBe(false);
    expect(chooseBacking(pay({ accounts: [account()] })).lessSafe).toBe(true);
    expect(chooseBacking(input({ dependency: { family: "kafka", kind: "stream" }, allowed: allow({ projectImages: true }), projectImages: [{ imageId: "k", family: "kafka" }] })).lessSafe).toBe(true);
    expect(chooseBacking(pay()).lessSafe).toBe(true);
  });
});

describe("the working sandbox swap (owner Q2)", () => {
  const withAccount = { accounts: [account()] };
  it("uses the test account in the sealed places only", () => {
    for (const place of BACKING_PLACES) {
      const choice = chooseBacking(pay({ ...withAccount, fixtures: [fixture(sha("3"))], place }));
      if (place === "task_check" || place === "nightly" || place === "prove_final") expect(choice.backing.kind, place).toBe("test_account");
      else expect(choice.backing.kind, place).toBe("fake");
    }
  });
  it("replaces the account by a fake where it may not be used, and says so", () => {
    const choice = chooseBacking(pay({ ...withAccount, fixtures: [fixture(sha("3"))], place: "working" }));
    expect(choice.backing).toEqual({ kind: "fake", fixtureSetRef: sha("3"), origin: "recorded" });
    expect(choice.replacedTestAccount).toBe(true);
    expect(steps(choice)).toContain("test_account:only_in_sealed_checks");
    expect(chooseBacking(pay({ ...withAccount, fixtures: [fixture(sha("3"))] })).replacedTestAccount).toBe(false);
  });
  it("is 'not available while coding' when there is no fake either", () => {
    const choice = chooseBacking(pay({ ...withAccount, place: "working" }));
    expect(choice).toMatchObject({ backing: { kind: "none", reason: "not_supported" }, reason: "not_available_while_coding", replacedTestAccount: false });
    expect(chooseBacking(pay({ ...withAccount, place: "setup" })).reason).toBe("not_available_while_coding");
    expect(chooseBacking(pay({ ...withAccount, place: "team_runner" })).reason).toBe("not_available_while_coding");
    // Without a usable account it is simply nothing.
    expect(chooseBacking(pay({ place: "working" })).reason).toBe("nothing_available");
    expect(chooseBacking(pay({ accounts: [account({ status: "suspended", expiresAt: "2027-01-30T10:00:00.000Z" })], place: "working" })).reason).toBe("nothing_available");
  });
  it("a fake can be made while coding", () => {
    expect(chooseBacking(pay({ ...withAccount, place: "working", canMakeFake: true })).backing).toMatchObject({ kind: "fake", origin: "to_make" });
  });
  it("services that run for real are the same while coding", () => {
    expect(chooseBacking(input({ place: "working" })).backing.kind).toBe("local");
    expect(chooseBacking(s3({ place: "working", accounts: [dynamoAccount({ family: "aws:s3", id: "orders-s3", hosts: ["s3.us-west-2.amazonaws.com"], aws: { roleArn: "arn:aws:iam::222222222222:role/rovara-test", externalId: testAccountExternalId(ORG, "orders-s3"), region: "us-west-2", actions: ["s3:GetObject"], resources: ["arn:aws:s3:::orders-test-bucket/*"] } })] })).backing.kind).toBe("emulated");
  });
});

describe("test account for nightly only (owner Q6)", () => {
  it("tasks run on Rovara local AWS and the nightly on the dev account", () => {
    const flagged = { accounts: [dynamoAccount()], dependency: { testAccountNightlyOnly: true } };
    expect(chooseBacking(dynamo({ ...flagged, place: "task_check" })).backing.kind).toBe("emulated");
    expect(chooseBacking(dynamo({ ...flagged, place: "working" })).backing.kind).toBe("emulated");
    // In a task the order is the usual one, with the account passed over at its own place in it.
    expect(steps(chooseBacking(dynamo({ ...flagged, place: "task_check" })))).toEqual(["local:not_in_catalog", "project_image:not_allowed"]);
    expect(steps(chooseBacking(dynamo({ ...flagged, place: "task_check", allowed: allow({ emulated: false }), fixtures: [fixture(sha("3"), { family: "aws:dynamodb" })] })))).toEqual(["local:not_in_catalog", "project_image:not_allowed", "emulated:not_allowed", "test_account:nightly_only"]);
    const nightly = chooseBacking(dynamo({ ...flagged, place: "nightly" }));
    expect(nightly).toMatchObject({ backing: { kind: "test_account", accountId: "orders-dev" }, reason: "nightly_account", lessSafe: true });
  });
  it("without the flag the emulator is first in the nightly too", () => {
    expect(chooseBacking(dynamo({ accounts: [dynamoAccount()], place: "nightly" })).backing.kind).toBe("emulated");
  });
  it("for a service the emulator does not cover, tasks use a fake and the nightly the account", () => {
    const flagged = { accounts: [account()], fixtures: [fixture(sha("3"))], dependency: { testAccountNightlyOnly: true } };
    const task = chooseBacking(pay({ ...flagged, place: "task_check" }));
    expect(task.backing.kind).toBe("fake");
    expect(steps(task)).toContain("test_account:nightly_only");
    expect(chooseBacking(pay({ ...flagged, place: "nightly" })).backing.kind).toBe("test_account");
  });
  it("the nightly falls back to the usual order when the account cannot be used", () => {
    const flagged = { dependency: { testAccountNightlyOnly: true } };
    const choice = chooseBacking(dynamo({ ...flagged, accounts: [dynamoAccount({ status: "suspended" })], place: "nightly" }));
    expect(choice.backing.kind).toBe("emulated");
    expect(steps(choice)).toEqual(["test_account:account_not_usable", "local:not_in_catalog", "project_image:not_allowed"]);
    expect(chooseBacking(dynamo({ ...flagged, allowed: allow({ testAccounts: false }), accounts: [dynamoAccount()], place: "nightly" })).backing.kind).toBe("emulated");
  });
});

describe("test accounts: available only when active, approved, for this project and clean", () => {
  const pick = (accounts: TestAccount[], over: Over = {}) => chooseBacking(pay({ accounts, ...over }));
  it("is active and not expired at the moment asked", () => {
    expect(pick([account()]).backing.kind).toBe("test_account");
    const expired = pick([account()], { now: "2027-02-01T00:00:00.000Z" });
    expect(expired.backing.kind).toBe("none");
    expect(steps(expired)).toContain("test_account:account_not_usable");
    expect(steps(pick([account({ status: "suspended" })]))).toContain("test_account:account_not_usable");
    expect(steps(pick([account({ status: "expired" })]))).toContain("test_account:account_not_usable");
    expect(steps(pick([account()], { now: "not a time" }))).toContain("test_account:account_not_usable");
  });
  it("is approved for this project", () => {
    expect(steps(pick([account({ projectIds: ["billing"] })]))).toContain("test_account:account_not_for_project");
    expect(pick([account({ projectIds: ["billing"] })], { projectId: "billing" }).backing.kind).toBe("test_account");
    expect(pick([account({ projectIds: "all" })], { projectId: "anything" }).backing.kind).toBe("test_account");
  });
  it("covers the family", () => {
    expect(steps(pick([dynamoAccount()]))).toContain("test_account:no_test_account");
  });
  it("names nothing on the production list", () => {
    const named = pick([account()], { prodDeny: { accountIds: [], hosts: ["api.example-pay.com"], arnPrefixes: [] } });
    expect(named.backing.kind).toBe("none");
    expect(steps(named)).toContain("test_account:account_names_production");
    // An empty list is no list: no account is used until production is listed.
    const empty = pick([account()], { prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } });
    expect(steps(empty)).toContain("test_account:production_list_missing");
    // An AWS account whose role is on the list.
    expect(steps(chooseBacking(dynamo({ accounts: [dynamoAccount()], allowed: allow({ emulated: false }), prodDeny: { accountIds: ["222222222222"], hosts: [], arnPrefixes: [] } })))).toContain("test_account:account_names_production");
  });
  it("skips an unclean account for a clean one, and takes the lowest id", () => {
    const first = account({ id: "aaa-test", secretRef: testAccountSecretRef("staging", ORG, "aaa-test", "apiKey") });
    const second = account({ id: "bbb-test", secretRef: testAccountSecretRef("staging", ORG, "bbb-test", "apiKey") });
    expect(pick([second, first]).backing).toEqual({ kind: "test_account", accountId: "aaa-test" });
    expect(pick([first, second], { prodDeny: { accountIds: [], hosts: ["*.nothing.example"], arnPrefixes: [] } }).backing).toEqual({ kind: "test_account", accountId: "aaa-test" });
    const stale = account({ id: "aaa-test", status: "suspended", secretRef: testAccountSecretRef("staging", ORG, "aaa-test", "apiKey") });
    expect(pick([stale, second]).backing).toEqual({ kind: "test_account", accountId: "bbb-test" });
  });
  it("is allowed", () => {
    expect(steps(pick([account()], { allowed: allow({ testAccounts: false }) }))).toContain("test_account:not_allowed");
  });
});

describe("deterministic, pure, fixed words", () => {
  const busy = (): BackingChoiceInput => dynamo({
    accounts: [dynamoAccount(), dynamoAccount({ id: "orders-b", secretRef: undefined })],
    fixtures: [fixture(sha("3"), { family: "aws:dynamodb" }), fixture(sha("1"), { family: "aws:dynamodb", origin: "hand_written" })],
    projectImages: [{ imageId: "b-image", family: "aws:dynamodb" }, { imageId: "a-image", family: "aws:dynamodb" }],
    allowed: allow({ projectImages: true, emulated: false }), canMakeFake: true,
  });
  it("gives the same answer for the same facts, in whatever order they are listed", () => {
    const a = busy();
    const reversed: BackingChoiceInput = { ...a, accounts: [...a.accounts].reverse(), fixtures: [...a.fixtures].reverse(), projectImages: [...a.projectImages].reverse(), catalog: { ...a.catalog, entries: [...a.catalog.entries].reverse() } };
    expect(chooseBacking(reversed)).toEqual(chooseBacking(a));
    expect(chooseBacking(a)).toEqual(chooseBacking(busy()));
    const catalogReversed = { ...input(), catalog: { ...input().catalog, entries: [...input().catalog.entries].reverse() } };
    expect(chooseBacking(catalogReversed)).toEqual(chooseBacking(input()));
  });
  it("does not change its input", () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
      }
      return value;
    };
    const frozen = deepFreeze(busy());
    expect(() => chooseBacking(frozen)).not.toThrow();
    expect(chooseBacking(frozen)).toEqual(chooseBacking(busy()));
  });
  it("has fixed words for every reason, one plain sentence each", () => {
    for (const reason of BACKING_REASONS) expect(BACKING_REASON_WORDS[reason], reason).toMatch(/^[A-Z][^\n—]*\.$/u);
    for (const reason of SKIP_REASONS) expect(SKIP_REASON_WORDS[reason], reason).toMatch(/^[A-Z][^\n—]*\.$/u);
    expect(Object.keys(BACKING_REASON_WORDS).sort()).toEqual([...BACKING_REASONS].sort());
    expect(Object.keys(SKIP_REASON_WORDS).sort()).toEqual([...SKIP_REASONS].sort());
  });
  it("answers in those words and the ids of the facts only: nothing a repository wrote is echoed", () => {
    const hostile = "@everyone ![x](https://evil.example/a.png) <!-- Fixes ENG-123";
    const choice = chooseBacking(input({ dependency: { family: hostile, kind: hostile, major: hostile }, projectId: hostile }));
    const text = JSON.stringify(choice);
    expect(text).not.toContain("everyone");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("ENG-123");
    for (const each of choice.skipped) expect(each.words).toBe(SKIP_REASON_WORDS[each.reason]);
    expect(choice.words).toBe(BACKING_REASON_WORDS[choice.reason]);
  });
  it("never throws on odd facts", () => {
    expect(() => chooseBacking(input({ dependency: { family: "", kind: "" } }))).not.toThrow();
    expect(() => chooseBacking(input({ catalog: { ...pinnedCatalog(), entries: [] } as unknown as ServiceCatalog }))).not.toThrow();
  });
});

describe("hostile and malformed facts (M1, L1, L2)", () => {
  it("an unknown maintainer choice is unavailable, never an error", () => {
    for (const bogus of ["bogus", "__proto__", "constructor", "toString", "hasOwnProperty", "", " local", "LOCAL", 5, {}, [], null, true]) {
      const choice = chooseBacking(pay({ fixtures: [fixture(sha("3"))], dependency: { maintainerChoice: bogus as never } }));
      expect(choice.backing, JSON.stringify(bogus)).toMatchObject({ kind: "fake", fixtureSetRef: sha("3") });
      expect(choice.reason, JSON.stringify(bogus)).toBe("best_available");
      expect(choice.skipped[0], JSON.stringify(bogus)).toEqual({ step: "maintainer", reason: "maintainer_choice_unavailable", words: SKIP_REASON_WORDS.maintainer_choice_unavailable });
    }
    // A choice that is not set at all is not a bad choice.
    expect(chooseBacking(pay({ fixtures: [fixture(sha("3"))] })).skipped.some((each) => each.step === "maintainer")).toBe(false);
    expect(chooseBacking(pay({ fixtures: [fixture(sha("3"))], dependency: { maintainerChoice: undefined } })).skipped.some((each) => each.step === "maintainer")).toBe(false);
  });
  it("returns nothing, and says so, for any input that is not what the types say", () => {
    const nothing = { backing: { kind: "none", reason: "not_supported" }, reason: "nothing_available", skipped: [], lessSafe: true, replacedTestAccount: false };
    // A base that reaches every step: no real software for the family, the company allows own images, and nothing else is available.
    const reach = pay({ allowed: allow({ projectImages: true }) });
    const bad: unknown[] = [
      null, undefined, 5, "text", [], {},
      { ...reach, dependency: null }, { ...reach, dependency: undefined }, { ...reach, allowed: undefined }, { ...reach, allowed: null },
      { ...reach, catalog: undefined }, { ...reach, catalog: { entries: null } }, { ...reach, catalog: { entries: [null] } },
      { ...reach, accounts: null }, { ...reach, accounts: [null] }, { ...reach, projectImages: null }, { ...reach, projectImages: [null] }, { ...reach, fixtures: null }, { ...reach, fixtures: [null] },
      { ...reach, accounts: [account()], prodDeny: null }, { ...reach, accounts: [account()], prodDeny: undefined },
    ];
    for (const value of bad) {
      let choice: ReturnType<typeof chooseBacking> | undefined;
      expect(() => { choice = chooseBacking(value as never); }, JSON.stringify(value)?.slice(0, 80)).not.toThrow();
      expect(choice, JSON.stringify(value)?.slice(0, 80)).toMatchObject(nothing);
      expect(choice?.words).toBe(BACKING_REASON_WORDS.nothing_available);
    }
  });
  it("an unknown place or a hostile family is read as not sealed and finds nothing", () => {
    expect(chooseBacking(pay({ accounts: [account()], place: "bogus" as never })).backing.kind).toBe("none");
    expect(chooseBacking(pay({ accounts: [account()], place: "__proto__" as never })).reason).toBe("not_available_while_coding");
    expect(chooseBacking(input({ dependency: { family: "__proto__", kind: "constructor" } })).backing.kind).toBe("none");
  });
  it("a box counts as allowed only when it is exactly true, in every step", () => {
    const loose = (over: Record<string, unknown>): AllowedBackings => {
      const merged: unknown = { ...DEFAULT_ALLOWED_BACKINGS, ...over };
      return merged as AllowedBackings;
    };
    const images = [{ imageId: "my-dynamo", family: "aws:dynamodb" }];
    expect(steps(chooseBacking(input({ allowed: loose({ real: "yes" }) })))[0]).toBe("local:not_allowed");
    expect(steps(chooseBacking(dynamo({ projectImages: images, allowed: loose({ projectImages: "yes" }) })))).toContain("project_image:not_allowed");
    expect(steps(chooseBacking(dynamo({ accounts: [dynamoAccount()], allowed: loose({ emulated: "yes" }) })))).toContain("emulated:not_allowed");
    expect(steps(chooseBacking(dynamo({ accounts: [dynamoAccount()], fixtures: [fixture(sha("3"), { family: "aws:dynamodb" })], allowed: loose({ emulated: false, testAccounts: 1 }) })))).toContain("test_account:not_allowed");
    expect(steps(chooseBacking(dynamo({ fixtures: [fixture(sha("3"), { family: "aws:dynamodb" })], allowed: loose({ emulated: false, testAccounts: false, fakes: "true" }) })))).toContain("fake:not_allowed");
    expect(steps(chooseBacking(pay({ fixtures: [fixture(sha("3"), { unmatched: "schema_synth" })], allowed: loose({ fakeMakesUpAnswers: "true" }) })))).toContain("fake:fake_makes_up_answers_not_allowed");
  });
  it("an account in Rovara's own AWS account is refused (L2)", () => {
    const own = dynamoAccount();
    const base = dynamo({ accounts: [own], allowed: allow({ emulated: false }) });
    expect(chooseBacking(base).backing.kind).toBe("test_account");
    const refused = chooseBacking({ ...base, rovaraAccountIds: ["222222222222"] });
    expect(refused.backing.kind).toBe("none");
    expect(steps(refused)).toContain("test_account:account_names_production");
    expect(chooseBacking({ ...base, rovaraAccountIds: ["000000000000"] }).backing.kind).toBe("test_account");
  });
  it("the list the environment had before this change is checked too (L2)", () => {
    const base = pay({ accounts: [account()] });
    const removed = { ...base, prodDeny: { accountIds: [], hosts: ["*.nothing.example"], arnPrefixes: [] }, alsoDeny: { accountIds: [], hosts: ["api.example-pay.com"], arnPrefixes: [] } };
    const refused = chooseBacking(removed);
    expect(refused.backing.kind).toBe("none");
    expect(steps(refused)).toContain("test_account:account_names_production");
    // The old list is enough to make a list exist.
    expect(steps(chooseBacking({ ...base, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, alsoDeny: { accountIds: [], hosts: ["*.nothing.example"], arnPrefixes: [] } }))).not.toContain("test_account:production_list_missing");
    expect(chooseBacking(base).backing.kind).toBe("test_account");
  });
});

// TE-A3 audit: the new default is for NEW proposals. An approval that is already stored keeps working exactly as it was approved, and a company's stored setting keeps its answer.
describe("audit: the made-up-answers default changes new approvals only", () => {
  const preprod = { endpointArn: "arn:aws:sagemaker:us-west-2:222222222222:endpoint/partner-scorer", roleArn: "arn:aws:iam::222222222222:role/rovara-invoke", region: "us-west-2" };
  // The approved environments of today are v1 services; each is read as dependencies the way the broker reads a stored body.
  const stored = [
    { name: "Partner scorer", kind: "sagemaker_runtime", match: { endpointName: "partner-scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "schema_synth" } },
    { name: "Payments API", kind: "http", match: { host: "api.example-pay.com" }, mode: "mock", mock: { fixtureSetRef: sha("c"), schemaRef: sha("d"), unmatched: "fail" } },
    { name: "Fraud scorer", kind: "sagemaker_runtime", match: { endpointName: "fraud-scorer" }, mode: "auto", mock: { fixtureSetRef: sha("e"), schemaRef: sha("f"), unmatched: "fail" }, preprod },
  ].map((service) => TestEnvServiceSchema.parse(service));
  const read = () => {
    const result = readTestEnvDependencies({ services: stored });
    if (!result.ok) throw new Error(result.reason);
    return result.dependencies;
  };

  it("reads every stored service as the same dependencies as before, with no provenance or other field added, so a pinned digest still matches", () => {
    const dependencies = read();
    expect(dependencies.map((dependency) => dependency.backing)).toEqual([
      { kind: "fake", fixtureSetRef: sha("a"), unmatched: "schema_synth" },
      { kind: "fake", fixtureSetRef: sha("c"), unmatched: "fail" },
      { kind: "test_account", accountId: "legacy-fraud-scorer" },
    ]);
    expect(dependencies[2]?.fallback).toEqual({ kind: "fake", fixtureSetRef: sha("e"), unmatched: "fail" });
    // What was stored round-trips through the new schema unchanged (nothing is added, nothing dropped).
    expect(TestEnvDependenciesSchema.parse(JSON.parse(JSON.stringify(dependencies)))).toEqual(dependencies);
    expect(JSON.stringify(dependencies)).not.toContain("provenance");
  });
  it("keeps the second-person approval a stored made-up-answers fake and a test account always needed", () => {
    const dependencies = read();
    expect(testEnvDependencyLessSafeChanges(undefined, dependencies)).toEqual(["test_account", "schema_synth"]);
    expect(testEnvDependencyApprovalRisk(dependencies)).toBe("high");
  });
  it("a stored company setting keeps 'off' for the company that never turned it on, whatever it says about other boxes", () => {
    const old = { real: true, emulated: true, projectImages: false, testAccounts: true, fakes: true, fakeMakesUpAnswers: false };
    const synth = [fixture(sha("3"), { unmatched: "schema_synth" })];
    expect(chooseBacking(pay({ fixtures: synth, allowed: effectiveAllowedBackings(old) })).backing.kind).toBe("none");
    expect(chooseBacking(pay({ fixtures: synth, allowed: effectiveAllowedBackings({ fakes: true }) })).backing.kind).toBe("none");
    expect(chooseBacking(pay({ fixtures: synth, allowed: effectiveAllowedBackings(LEGACY_ALLOWED_BACKINGS) })).backing.kind).toBe("none");
  });
  it("a new proposal for a company with no stored setting gets the made-up answers fake", () => {
    const synth = [fixture(sha("3"), { unmatched: "schema_synth" })];
    const choice = chooseBacking(pay({ fixtures: synth, allowed: effectiveAllowedBackings(undefined) }));
    expect(choice.backing).toMatchObject({ kind: "fake", fixtureSetRef: sha("3") });
    expect(steps(choice)).not.toContain("fake:fake_makes_up_answers_not_allowed");
  });
  it("every caller that builds a proposal still passes no stored setting, so the default is the only thing they see", () => {
    for (const file of ["dependency-plan.ts", "dependency-proposal.ts"]) {
      const text = readFileSync(new URL(`../../packages/broker/src/core/test-env/${file}`, import.meta.url), "utf8");
      const calls = text.match(/effectiveAllowedBackings\([^)]*\)/gu) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toBe("effectiveAllowedBackings(undefined)");
    }
  });
});
