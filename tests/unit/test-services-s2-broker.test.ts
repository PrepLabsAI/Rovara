// Test services, broker side: Rovara local AWS (`emulated`) for exactly S3, SQS and DynamoDB. The approval, the plan (checks and coding), the proposal from detector candidates, the approve card, the evidence rows and the
// pull request lines. Everything else AWS offers, and any emulated dependency without a pinned local-aws, is "not available yet"; with tx off or with no emulated dependency everything reads as it did before.
import { describe, expect, it } from "vitest";
import { TestEnvRegionSchema, TestEnvironmentBodySchema, TestEnvTaskPlanSchema, TaskDependencyPlanSchema, WORKER_INVOCATION_FEATURES, TEST_SERVICES_AWS_PLAN_FEATURE, testEnvDigest, type OrgId, type ProjectCommand, type TestEnvironment, type TestEnvironmentBody, type VerifiedCatalog } from "@agentx/contracts";
import { sanitizeTestEnvDraft } from "../../packages/broker/src/core/test-env/draft.js";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, EMULATED_TASK_SERVICES, TEST_SERVICES_MIN_CATALOG_REVISION, dependenciesStartableNow, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { EMULATED_DEFAULT_REGION, proposeDependencies } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { dependencyCardLines } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { UNUSED_WORDS, environmentUnusedReason, testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { AWS_PERMISSIONS_ITEM_ID, AWS_PERMISSIONS_NOT_CHECKED, dependencyEvidenceOf, type PinnedDependency, type RawUsage } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { packDependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";
import { evidenceNotTestedLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS } from "../../packages/broker/src/core/test-env/devcontainer-check.js";
import { digestOfId, pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";
import { projectStore } from "../support/test-env-world.js";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const AWS_CONNECT = { env: [], hostAliases: ["aws"] };
const NO_CONNECT = { env: [], hostAliases: [] };
const postgres = () => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round",
});
const aws = (service: string, over: Record<string, unknown> = {}) => ({
  id: `aws-${service}`, name: { s3: "S3", sqs: "SQS", dynamodb: "DynamoDB" }[service] ?? service, kind: service === "s3" ? "object_store" : service === "sqs" ? "queue" : "database", family: `aws:${service}`,
  found: [{ path: "template.yaml", line: 40 }], usedBy: ["integration"],
  backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1" },
  connect: NO_CONNECT, seeds: [], reset: "fresh_per_round", ...over,
});
/** S3, SQS and DynamoDB the way a proposal gives them: the first carries the helper's name. */
const threeAws = () => [aws("s3", { connect: AWS_CONNECT }), aws("sqs"), aws("dynamodb")];
const body = (dependencies: unknown[] | null = [postgres(), ...threeAws()], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...(dependencies === null ? {} : { dependencies }), ...over,
});
const asEnvironment = (environment: TestEnvironmentBody): TestEnvironment => ({ revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", environment });
const catalog = (change?: (entries: Array<Record<string, unknown>>) => void): VerifiedCatalog => verifiedCatalog(pinnedCatalog(change));
const withoutLocalAws = (entries: Array<Record<string, unknown>>) => { entries.splice(0, entries.length, ...entries.filter((entry) => entry["id"] !== "local-aws@r1")); };
const plansOf = (dependencies: unknown[], from: VerifiedCatalog | null = catalog()) => taskDependencyPlansOf({ body: body(dependencies), catalog: from ?? undefined, edition: "public" });
const reason = (result: ReturnType<typeof plansOf>) => (result.ok ? "ok" : result.reason);

describe("which dependencies are startable now", () => {
  it("is exactly S3, SQS and DynamoDB on Rovara local AWS, beside real software", () => {
    expect([...EMULATED_TASK_SERVICES]).toEqual(["s3", "sqs", "dynamodb"]);
    expect(dependenciesStartableNow([postgres(), ...threeAws()] as never)).toBe(true);
    for (const other of ["sns", "lambda", "kinesis", "ssm"]) expect(dependenciesStartableNow([aws(other)] as never)).toBe(false);
  });
  it("refuses a dependency that also asks for a service outside the three", () => {
    expect(dependenciesStartableNow([aws("s3", { backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["s3", "sns"], region: "us-east-1" } })] as never)).toBe(false);
  });
  it("refuses emulated dependencies that cannot share one helper (another region or another image), and a different working backing or a fake fallback", () => {
    const eu = aws("sqs", { backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["sqs"], region: "eu-west-1" } });
    expect(dependenciesStartableNow([aws("s3"), eu] as never)).toBe(false);
    const other = aws("sqs", { backing: { kind: "emulated", catalogId: "local-aws@r2", awsServices: ["sqs"], region: "us-east-1" } });
    expect(dependenciesStartableNow([aws("s3"), other] as never)).toBe(false);
    expect(dependenciesStartableNow([aws("s3", { workingBacking: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["s3"], region: "us-east-1" } })] as never)).toBe(true);
    expect(dependenciesStartableNow([aws("s3", { workingBacking: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["s3"], region: "eu-west-1" } })] as never)).toBe(false);
    expect(dependenciesStartableNow([aws("s3", { fallback: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } })] as never)).toBe(false);
    expect(dependenciesStartableNow([aws("s3", { fallback: { kind: "none", reason: "declined" } })] as never)).toBe(true);
  });
});

describe("when a task may use an environment with Rovara local AWS", () => {
  it("is used with tx on", () => {
    expect(environmentUnusedReason(asEnvironment(body()), ON)).toBeUndefined();
  });
  it("is not used with tx off (today's reason for any dependency)", () => {
    expect(environmentUnusedReason(asEnvironment(body()), { ROVARA_TEST_ENVIRONMENT: "1" })).toBe("dependencies_not_connected");
  });
  it("is not used for any other AWS service, in the fixed words", () => {
    expect(environmentUnusedReason(asEnvironment(body([aws("sns")])), ON)).toBe("dependencies_not_available_yet");
    expect(UNUSED_WORDS.dependencies_not_available_yet).toMatch(/not .*yet/iu);
  });
});

describe("the plan of Rovara local AWS", () => {
  it("pins S3, SQS and DynamoDB to the local-aws image beside Postgres, and the wire accepts it", () => {
    const result = plansOf([postgres(), ...threeAws()]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.dependencies.map((plan) => [plan.id, plan.backing, plan.catalogId, plan.digest])).toEqual([
      ["postgres", "local", "postgres@16", digestOfId("postgres@16")],
      ["aws-s3", "emulated", "local-aws@r1", digestOfId("local-aws@r1")],
      ["aws-sqs", "emulated", "local-aws@r1", digestOfId("local-aws@r1")],
      ["aws-dynamodb", "emulated", "local-aws@r1", digestOfId("local-aws@r1")],
    ]);
    const [, s3, sqs, dynamodb] = result.dependencies;
    expect(s3).toMatchObject({ repository: "svc/local-aws", aliases: ["aws"], config: {}, aws: { services: ["s3"], region: "us-east-1" } });
    expect(s3!.connect).toEqual([]);
    // The helper is shared, so its name and variables are the first dependency's alone (the plan allows each once).
    expect(sqs).toMatchObject({ aliases: [], connect: [], aws: { services: ["sqs"] } });
    expect(dynamodb).toMatchObject({ aliases: [], connect: [], aws: { services: ["dynamodb"] } });
    // A local entry is exactly what it was before: no `aws` key.
    expect("aws" in result.dependencies[0]!).toBe(false);
    expect(TestEnvTaskPlanSchema.safeParse({ revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: result.dependencies }).success).toBe(true);
  });

  it("carries where the project declares its resources", () => {
    const result = plansOf([aws("dynamodb", { backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["dynamodb"], region: "us-east-1", resources: { provider: "cloudformation", path: "template.yaml" } }, connect: AWS_CONNECT })]);
    expect(result.ok && result.dependencies[0]!.aws).toEqual({ services: ["dynamodb"], region: "us-east-1", resources: { provider: "cloudformation", path: "template.yaml" } });
  });

  it("is 'not available yet' for any other AWS service", () => {
    expect(reason(plansOf([aws("sns", { connect: AWS_CONNECT })]))).toBe("not_available_yet");
    expect(reason(plansOf([aws("s3", { connect: AWS_CONNECT, backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["s3", "lambda"], region: "us-east-1" } })]))).toBe("not_available_yet");
    expect(DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet).toMatch(/not available yet/iu);
  });

  it("is 'not available yet' for emulated without a pinned local-aws (not in the catalog, an unpinned catalog, or an entry that does not cover the service)", () => {
    expect(reason(plansOf(threeAws(), catalog(withoutLocalAws)))).toBe("not_available_yet");
    expect(reason(plansOf([aws("s3", { connect: AWS_CONNECT, backing: { kind: "emulated", catalogId: "local-aws@r9", awsServices: ["s3"], region: "us-east-1" } })]))).toBe("not_available_yet");
    // An emulator that does not list the service as supported (moved to `available`) does not back it.
    const unsupported = catalog((entries) => {
      for (const entry of entries) if (entry["id"] === "local-aws@r1") {
        const services = (entry["emulator"] as { services: { supported: string[]; available: string[] } }).services;
        services.supported = services.supported.filter((service) => service !== "sqs");
        services.available.push("sqs");
      }
    });
    expect(reason(plansOf(threeAws(), unsupported))).toBe("not_available_yet");
    expect(reason(plansOf([aws("s3", { connect: AWS_CONNECT })], unsupported))).toBe("ok");
  });

  it("keeps the catalog rules: no catalog, an unpinned catalog, a retired entry, an edition", () => {
    expect(reason(plansOf(threeAws(), null))).toBe("no_catalog");
    // An unpinned catalog has no pinned local-aws: "not available yet" for a project that asks for local AWS alone, the plain words beside real software.
    expect(reason(plansOf(threeAws(), verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).toBe("not_available_yet");
    expect(reason(plansOf([postgres(), ...threeAws()], verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).toBe("not_pinned");
    const retired = catalog((entries) => { for (const entry of entries) if (entry["id"] === "local-aws@r1") entry["status"] = "retired"; });
    expect(reason(plansOf(threeAws(), retired))).toBe("retired");
    const enterpriseOnly = catalog((entries) => { for (const entry of entries) if (entry["id"] === "local-aws@r1") entry["editions"] = ["enterprise"]; });
    expect(reason(plansOf(threeAws(), enterpriseOnly))).toBe("not_in_edition");
    expect(taskDependencyPlansOf({ body: body(threeAws()), catalog: enterpriseOnly, edition: "enterprise" }).ok).toBe(true);
  });

  // The pre-pull list holds EVERY pinned, non-retired local or emulated entry (not only the defaults), so a pinned non-default local-aws is startable; a retired one keeps its own words.
  it("is available when the pinned local-aws is a non-default entry (the worker image pre-pulls every pinned emulated entry), and not when it is retired", () => {
    const notDefault = catalog((entries) => { for (const entry of entries) if (entry["id"] === "local-aws@r1") entry["status"] = "available"; });
    expect(reason(plansOf(threeAws(), notDefault))).toBe("ok");
    const retired = catalog((entries) => { for (const entry of entries) if (entry["id"] === "local-aws@r1") entry["status"] = "retired"; });
    expect(reason(plansOf(threeAws(), retired))).not.toBe("ok");
  });

  it("wire: an emulated entry names its AWS services, local-aws and an AWS family; a local entry has none", () => {
    const [local, s3] = (plansOf([postgres(), aws("s3", { connect: AWS_CONNECT })]) as { ok: true; dependencies: Array<Record<string, unknown>> }).dependencies;
    expect(TaskDependencyPlanSchema.safeParse(s3).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse({ ...s3, aws: undefined }).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse({ ...s3, aws: { services: ["sqs"], region: "us-east-1" } }).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse({ ...s3, catalogId: "postgres@16" }).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse({ ...s3, family: "postgres" }).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse({ ...local, aws: { services: ["s3"], region: "us-east-1" } }).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse({ ...local, catalogId: "local-aws@r1" }).success).toBe(false);
  });

  it("wire: aws.services is exactly S3, SQS and DynamoDB (at most 3), and a region is a short region name", () => {
    const [, s3] = (plansOf([postgres(), aws("s3", { connect: AWS_CONNECT })]) as { ok: true; dependencies: Array<Record<string, unknown>> }).dependencies;
    const withAws = (value: unknown) => TaskDependencyPlanSchema.safeParse({ ...s3, aws: value }).success;
    expect(withAws({ services: ["s3", "sqs", "dynamodb"], region: "us-east-1" })).toBe(true);
    expect(withAws({ services: ["s3", "sns"], region: "us-east-1" })).toBe(false);
    expect(withAws({ services: ["s3", "s3", "sqs", "dynamodb"], region: "us-east-1" })).toBe(false);
    expect(withAws({ services: ["s3", "lambda"], region: "us-east-1" })).toBe(false);
    expect(withAws({ services: [], region: "us-east-1" })).toBe(false);
    expect(TestEnvRegionSchema.safeParse("us-east-1").success).toBe(true);
    expect(TestEnvRegionSchema.safeParse(`us-${"a".repeat(40)}-1`).success).toBe(false);
    expect(withAws({ services: ["s3"], region: `us-${"a".repeat(40)}-1` })).toBe(false);
  });

  it("is a worker feature of its own", () => {
    expect(TEST_SERVICES_AWS_PLAN_FEATURE).toBe("task.testServices.aws.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_AWS_PLAN_FEATURE);
  });
});

async function approved(environment: TestEnvironmentBody, from?: VerifiedCatalog, devcontainer = false) {
  const h = await bench({ project: PROJECT, env: ON, devcontainer, ...(from === undefined ? {} : { serviceCatalog: async () => from }) });
  const proposal = await h.proposeAndProve(environment);
  expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
  const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
  await h.store.transact([start.pin!]);
  return h;
}
const readiness = [cmd("pytest", ["-q"])];

describe("approval", () => {
  it("approves S3, SQS and DynamoDB with a pinned local-aws, with or without the catalog to ask", async () => {
    await expect(approved(body(), catalog())).resolves.toBeDefined();
    await expect(approved(body())).resolves.toBeDefined();
  });
  it("refuses, in the fixed words, any other AWS service", async () => {
    await expect(approved(body([aws("sns", { connect: AWS_CONNECT })]), catalog())).rejects.toThrow(/not available yet/iu);
    await expect(approved(body([aws("sns", { connect: AWS_CONNECT })]))).rejects.toThrow(/not available yet/iu);
  });
  it("refuses emulated without a pinned local-aws, and one the emulator does not list as supported", async () => {
    await expect(approved(body(), catalog(withoutLocalAws))).rejects.toThrow(/not available yet/iu);
    await expect(approved(body(), verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION)))).rejects.toThrow(/not available yet/iu);
    const unsupported = catalog((entries) => {
      for (const entry of entries) if (entry["id"] === "local-aws@r1") {
        const services = (entry["emulator"] as { services: { supported: string[]; available: string[] } }).services;
        services.supported = services.supported.filter((service) => service !== "dynamodb");
        services.available.push("dynamodb");
      }
    });
    await expect(approved(body(), unsupported)).rejects.toThrow(/not available yet/iu);
  });
  it("is not approvable with tx off", async () => {
    const h = await bench({ project: PROJECT, env: { ROVARA_TEST_ENVIRONMENT: "1" } });
    await expect(h.propose(body())).rejects.toThrow(/not switched on/iu);
  });
});

describe("the plan of a task with Rovara local AWS (checks and coding)", () => {
  it("builds the checks plan with Postgres and the three AWS services, and the coding plan too", async () => {
    const h = await approved(body());
    h.deps.serviceCatalog = async () => catalog();
    const plan = (await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON))!;
    expect(plan.digest).toBe(testEnvDigest(body()));
    expect(plan.dependencies?.map((entry) => [entry.id, entry.backing])).toEqual([["postgres", "local"], ["aws-s3", "emulated"], ["aws-sqs", "emulated"], ["aws-dynamodb", "emulated"]]);
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
    const coding = (await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON))!;
    expect(coding.dependencies).toEqual(plan.dependencies);
  });
  it("refuses the run, in fixed words, when local-aws is not pinned, and never sends a plan without it", async () => {
    const h = await approved(body());
    h.deps.serviceCatalog = async () => catalog(withoutLocalAws);
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet);
    await expect(testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet);
    h.deps.serviceCatalog = async () => undefined;
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.no_catalog);
  });
  it("keeps the dev container rule: refused at approval, and refused at the plan when the project got a dev container after the task started", async () => {
    await expect(approved(body(), undefined, true)).rejects.toThrow(/dev ?container/iu);
    const h = await approved(body());
    await projectStore(ORG, PROJECT, { devcontainer: true, store: h.store });
    h.deps.serviceCatalog = async () => catalog();
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
  });
  it("gives no plan at all with tx off, and never reads the catalog", async () => {
    const h = await approved(body());
    let reads = 0;
    h.deps.serviceCatalog = async () => { reads += 1; return catalog(); };
    expect(await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
    expect(await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, { ROVARA_TEST_ENVIRONMENT: "1" })).toBeUndefined();
    expect(reads).toBe(0);
  });
  it("is the plain plan, byte for byte, for an environment with real software only", async () => {
    const h = await approved(body([postgres()]));
    h.deps.serviceCatalog = async () => catalog();
    const plan = (await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON))!;
    expect(plan.dependencies).toEqual([{
      id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: digestOfId("postgres@16"),
      config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round",
    }]);
  });
});

// ---- the proposal

const candidate = (family: string, over: Record<string, unknown> = {}, hints: Record<string, unknown> = {}) => ({
  family, kind: family === "aws:s3" ? "object_store" : family === "aws:sqs" || family === "aws:sns" ? "queue" : family.startsWith("aws:") ? "database" : "database",
  evidence: [{ path: "template.yaml", line: 40 }], strength: "declared", hints: { ...hints }, ...over,
}) as never;
const context = (from: VerifiedCatalog | undefined = catalog()) => ({ catalog: from, edition: "public" as const, projectId: PROJECT, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } });

describe("the proposal from detector candidates", () => {
  it("proposes Rovara local AWS for S3, SQS and DynamoDB, the first carrying the helper's name", () => {
    const proposal = proposeDependencies([candidate("postgres"), candidate("aws:s3"), candidate("aws:sqs"), candidate("aws:dynamodb")], context());
    expect(proposal.notes).toEqual([]);
    expect(proposal.dependencies.map((entry) => [entry.id, entry.name, entry.backing.kind])).toEqual([["postgres", "Postgres", "local"], ["aws-s3", "S3", "emulated"], ["aws-sqs", "SQS", "emulated"], ["aws-dynamodb", "DynamoDB", "emulated"]]);
    const [, s3, sqs, dynamodb] = proposal.dependencies;
    expect(s3!.backing).toEqual({ kind: "emulated", catalogId: "local-aws@r1", awsServices: ["s3"], region: EMULATED_DEFAULT_REGION });
    // The region variables are Rovara's to set (the contract reserves them), so no variable comes from the catalog's templates.
    expect(s3!.connect).toEqual({ env: [], hostAliases: ["aws"] });
    expect(sqs!.connect).toEqual(NO_CONNECT);
    expect(dynamodb!.connect).toEqual(NO_CONNECT);
    expect(s3).toMatchObject({ usedBy: ["integration"], reset: "fresh_per_round", seeds: [] });
    // The whole proposal is an environment the contract accepts and the task flow can carry out.
    const environment = body(proposal.dependencies);
    expect(environmentUnusedReason(asEnvironment(environment), ON)).toBeUndefined();
    expect(taskDependencyPlansOf({ body: environment, catalog: catalog(), edition: "public" }).ok).toBe(true);
  });

  it("proposes the first emulated one with the helper's name wherever it stands in the list", () => {
    const proposal = proposeDependencies([candidate("aws:sqs"), candidate("postgres"), candidate("aws:s3")], context());
    expect(proposal.dependencies.map((entry) => [entry.id, entry.connect.hostAliases.length])).toEqual([["aws-sqs", 1], ["postgres", 1], ["aws-s3", 0]]);
  });

  it("leaves out, with one fixed note, every other AWS service (never described)", () => {
    const proposal = proposeDependencies([candidate("aws:s3"), candidate("aws:sns"), candidate("aws:kinesis"), candidate("aws:lambda")], context());
    expect(proposal.dependencies.map((entry) => entry.id)).toEqual(["aws-s3"]);
    expect(proposal.notes).toHaveLength(1);
    expect(proposal.notes.join(" ")).not.toMatch(/sns|kinesis|lambda/iu);
  });

  it("proposes no emulated dependency without a pinned local-aws, and not one the tests fake themselves", () => {
    expect(proposeDependencies([candidate("aws:s3")], context(catalog(withoutLocalAws))).dependencies).toEqual([]);
    expect(proposeDependencies([candidate("aws:s3")], context(verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION)))).dependencies).toEqual([]);
    expect(proposeDependencies([candidate("aws:s3", {}, { fakedByTests: true })], context()).dependencies).toEqual([]);
  });

  it("points at the one template or Terraform file the resources are declared in, and at nothing when it cannot tell", () => {
    const one = (path: string, provider: string) => {
      const dependency = proposeDependencies([candidate("aws:dynamodb", { evidence: [{ path, line: 3 }] }, { seenBy: ["iac"] })], context()).dependencies[0]!;
      return dependency.backing.kind === "emulated" ? dependency.backing.resources : provider;
    };
    expect(one("template.yaml", "")).toEqual({ provider: "cloudformation", path: "template.yaml" });
    expect(one("infra/main.tf", "")).toEqual({ provider: "terraform", path: "infra/main.tf" });
    expect(one("infra/stack.ts", "")).toEqual({ provider: "cdk", path: "infra/stack.ts" });
    expect(one("infra/Makefile", "none")).toBeUndefined();
    const two = proposeDependencies([candidate("aws:dynamodb", { evidence: [{ path: "a.yaml", line: 1 }, { path: "b.yaml", line: 1 }] }, { seenBy: ["iac"] })], context()).dependencies[0]!;
    expect(two.backing.kind === "emulated" && two.backing.resources).toBeUndefined();
    const sdk = proposeDependencies([candidate("aws:s3", { evidence: [{ path: "app/storage.py", line: 8 }] }, { seenBy: ["sdk"] })], context()).dependencies[0]!;
    expect(sdk.backing.kind === "emulated" && sdk.backing.resources).toBeUndefined();
  });

  it("proposes the same Postgres it did before when there is nothing from AWS", () => {
    const proposal = proposeDependencies([candidate("postgres")], context());
    expect(proposal.dependencies).toHaveLength(1);
    expect(proposal.dependencies[0]).toEqual({
      id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "template.yaml", line: 40 }], usedBy: ["integration"], reset: "fresh_per_round", seeds: [],
      backing: { kind: "local", catalogId: "postgres@16", config: {} },
      connect: {
        env: [
          { name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }, { name: "PGHOST", template: "{host}" }, { name: "PGPORT", template: "{port}" },
          { name: "PGUSER", template: "{user}" }, { name: "PGPASSWORD", template: "{password}" }, { name: "PGDATABASE", template: "{db}" },
        ],
        hostAliases: ["postgres"],
      },
    });
  });
});

describe("with tx off, or with no emulated dependency, a draft is the plain one", () => {
  const draftOf = (candidates?: unknown[]): unknown => JSON.parse(JSON.stringify({ environment: body(null), valueSources: [], pendingServices: [], notes: ["Found pytest."], questions: [], ...(candidates === undefined ? {} : { dependencies: candidates }) }));
  const options = (env: NodeJS.ProcessEnv) => ({ env, propose: context() });
  it("proposes nothing from AWS candidates with tx off", () => {
    const off = sanitizeTestEnvDraft(draftOf([candidate("aws:s3"), candidate("aws:sqs")]), options({ ROVARA_TEST_ENVIRONMENT: "1" }))!;
    expect(off.environment.dependencies).toBeUndefined();
    expect(off).toEqual(sanitizeTestEnvDraft(draftOf())!);
  });
  it("proposes them with tx on, and a draft with real software only is what was proposed before AWS", () => {
    const on = sanitizeTestEnvDraft(draftOf([candidate("aws:s3"), candidate("aws:sqs"), candidate("aws:dynamodb")]), options(ON))!;
    expect(on.environment.dependencies!.map((entry) => entry.backing.kind)).toEqual(["emulated", "emulated", "emulated"]);
    expect(on.dependencies).toHaveLength(3);
    const real = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options(ON))!;
    expect(real.environment.dependencies!.map((entry) => [entry.id, entry.backing.kind])).toEqual([["postgres", "local"]]);
  });
});

describe("the approve card", () => {
  it("shows them as Rovara local AWS with the plain risk wording", () => {
    const lines = dependencyCardLines(threeAws() as never);
    expect(lines).toContain("S3: runs against Rovara local AWS. Not checked here: AWS permissions and exact AWS behaviour. Found in template.yaml, line 40.");
    expect(lines.filter((line) => line.includes("Rovara local AWS"))).toHaveLength(3);
    expect(lines.join(" ")).not.toMatch(/floci|localstack|moto/iu);
  });
});

// ---- evidence and the pull request

const pinnedRows: PinnedDependency[] = [{ id: "postgres", name: "Postgres", backing: "local" }, { id: "aws-s3", name: "S3", backing: "emulated", awsServices: ["s3"] }, { id: "aws-sqs", name: "SQS", backing: "emulated", awsServices: ["sqs"] }, { id: "aws-dynamodb", name: "DynamoDB", backing: "emulated", awsServices: ["dynamodb"] }];
const usageOf = (ids: string[]): RawUsage => ({ schemaVersion: 1, dependencies: ids.map((id) => ({ id, started: true, healthy: true, startMs: 1200, resetCount: 0 })), unknownCalls: { domains: [], otherCount: 0 },
  // a clean run of the emulator: its ledger was read and shows only planned services (the broker also judges this; see test-services-aws-usage-verdict.test.ts)
  aws: { ledger: "read", services: [{ service: "s3", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 } });
const packOf = (dependencies: ReturnType<typeof dependencyEvidenceOf>["dependencies"]) => ({ environment: { dependencies } }) as never;

describe("evidence and the pull request", () => {
  it("labels them Rovara local AWS from the pinned backing, and says so in one PR line", () => {
    const { dependencies, notTested } = dependencyEvidenceOf(pinnedRows, usageOf(["postgres", "aws-s3", "aws-sqs", "aws-dynamodb"]));
    expect(dependencies.map((row) => [row.name, row.backing, row.label])).toEqual([["Postgres", "local", "real"], ["S3", "emulated", "rovara_local_aws"], ["SQS", "emulated", "rovara_local_aws"], ["DynamoDB", "emulated", "rovara_local_aws"]]);
    expect(notTested.map((item) => item.id)).toEqual([AWS_PERMISSIONS_ITEM_ID]);
    expect(notTested[0]!.text).toBe(AWS_PERMISSIONS_NOT_CHECKED);
    const lines = packDependencyLines(packOf(dependencies), 0);
    expect(lines.lines).toEqual(["Integration tests ran against: Postgres (real), S3, SQS and DynamoDB (Rovara local AWS)."]);
    expect(lines.notTested).toContain(`- ${AWS_PERMISSIONS_NOT_CHECKED}`);
    expect(lines.notTested.filter((line) => line.includes("permissions"))).toHaveLength(1);
    expect(lines.notTested).toContain("- S3 behaviour against real AWS (emulated)");
  });

  it("keeps the permissions line at every shrink level, once", () => {
    const { dependencies } = dependencyEvidenceOf(pinnedRows, usageOf(["postgres", "aws-s3", "aws-sqs", "aws-dynamodb"]));
    for (let level = 0; level <= 4; level += 1) {
      const lines = packDependencyLines(packOf(dependencies), level);
      expect(lines.notTested.filter((line) => /permissions/iu.test(line))).toHaveLength(1);
      expect(lines.lines.join(" ")).toContain("Rovara local AWS");
    }
  });

  it("does not repeat the permissions item among the pack's other not-tested bullets", () => {
    const { dependencies, notTested } = dependencyEvidenceOf(pinnedRows, usageOf(["aws-s3"]));
    const pack = { notTested, environment: { dependencies } } as never;
    expect(evidenceNotTestedLines(pack, 0)).toEqual([]);
  });

  it("shows an emulated dependency that did not start as not available, never as Rovara local AWS", () => {
    const { dependencies, notTested } = dependencyEvidenceOf(pinnedRows, usageOf(["postgres"]));
    const s3 = dependencies.find((row) => row.name === "S3")!;
    expect(s3).toMatchObject({ backing: "none", label: "not_available", fellBack: { from: "emulated", reason: "did_not_start" } });
    // Nothing ran on local AWS, so nothing is said about its permissions.
    expect(notTested.some((item) => item.id === AWS_PERMISSIONS_ITEM_ID)).toBe(false);
    expect(packDependencyLines(packOf(dependencies), 0).lines.join(" ")).not.toContain("Rovara local AWS");
  });

  it("says nothing about local AWS for a run with real software only (the plain lines)", () => {
    const { dependencies, notTested } = dependencyEvidenceOf([pinnedRows[0]!], usageOf(["postgres"]));
    expect(packDependencyLines(packOf(dependencies), 0)).toEqual({ lines: ["Integration tests ran against: Postgres (real)."], notTested: [] });
    expect(notTested).toEqual([]);
  });

  it("builds the pinned rows from the approved environment (the pack's rows are the broker's, never the worker's words)", async () => {
    const h = await approved(body());
    const choice = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(choice.dependencies).toEqual(pinnedRows);
    const realOnly = await approved(body([postgres()]));
    expect((await evidenceEnvironmentOf(realOnly.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON)).dependencies).toEqual([{ id: "postgres", name: "Postgres", backing: "local" }]);
  });
});
