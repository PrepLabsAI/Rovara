// Test services, broker side: Rovara local AWS (`emulated`) for any service of the generated table (S3, SQS and DynamoDB are the ones it also seeds). The approval, the plan (checks and coding), the proposal from detector
// candidates, the approve card, the evidence rows and the pull request lines. A service the table does not know, and any emulated dependency without a pinned local-aws, is "not available yet"; with tx off or with no
// emulated dependency everything reads as it did before.
import { describe, expect, it } from "vitest";
import { AWS_EMULATOR_ENGINE_VERSION, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, TEST_SERVICES_AWS_PLAN_FEATURE, type OrgId, type ProjectCommand, type TestEnvironment, type TestEnvironmentBody, type VerifiedCatalog } from "@agentx/contracts";
import { TEST_SERVICES_MIN_CATALOG_REVISION, dependenciesStartableNow, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { EMULATED_DEFAULT_REGION, proposeDependencies } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { environmentUnusedReason, testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { dependencyEvidenceOf, type PinnedDependency, type RawUsage } from "../../packages/broker/src/core/proof/dependency-evidence.js";
import { packDependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";
import { evidenceNotTestedLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

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

describe("the plan of Rovara local AWS", () => {

  it("carries where the project declares its resources", () => {
    const result = plansOf([aws("dynamodb", { backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: ["dynamodb"], region: "us-east-1", resources: { provider: "cloudformation", path: "template.yaml" } }, connect: AWS_CONNECT })]);
    expect(result.ok && result.dependencies[0]!.aws).toEqual({ services: ["dynamodb"], region: "us-east-1", resources: { provider: "cloudformation", path: "template.yaml" } });
  });

  it("is 'not available yet' for emulated without a pinned local-aws (not in the catalog, an unpinned catalog, or an entry that does not cover the service)", () => {
    expect(reason(plansOf(threeAws(), catalog(withoutLocalAws)))).toBe("not_available_yet");
    expect(reason(plansOf([aws("s3", { connect: AWS_CONNECT, backing: { kind: "emulated", catalogId: "local-aws@r9", awsServices: ["s3"], region: "us-east-1" } })]))).toBe("not_available_yet");
    // An emulator that says it runs another engine release than the table's is refused; one that says nothing (a catalog made before the field) and one that names the table's release are not.
    const withEngine = (engineVersion: string | undefined) => catalog((entries) => {
      for (const entry of entries) {
        if (entry["id"] !== "local-aws@r1") continue;
        const emulator = entry["emulator"] as { engineVersion?: string };
        if (engineVersion === undefined) delete emulator.engineVersion;
        else emulator.engineVersion = engineVersion;
      }
    });
    expect(reason(plansOf(threeAws(), withEngine("1.0.321")))).toBe("not_available_yet");
    expect(reason(plansOf(threeAws(), withEngine(AWS_EMULATOR_ENGINE_VERSION)))).toBe("ok");
    expect(reason(plansOf(threeAws(), withEngine(undefined)))).toBe("ok");
    // Moved to `available` is still the table's service: a person's explicit choice is backed.
    const available = catalog((entries) => {
      for (const entry of entries) if (entry["id"] === "local-aws@r1") {
        const services = (entry["emulator"] as { services: { supported: string[]; available: string[] } }).services;
        services.supported = services.supported.filter((service) => service !== "sqs");
        services.available.push("sqs");
      }
    });
    expect(reason(plansOf(threeAws(), available))).toBe("ok");
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

describe("approval", () => {
  it("refuses emulated without a pinned local-aws, and one whose emulator runs another engine release than the table's", async () => {
    await expect(approved(body(), catalog(withoutLocalAws))).rejects.toThrow(/not available yet/iu);
    await expect(approved(body(), verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION)))).rejects.toThrow(/not available yet/iu);
    const otherEngine = catalog((entries) => {
      for (const entry of entries) if (entry["id"] === "local-aws@r1") (entry["emulator"] as { engineVersion?: string }).engineVersion = "1.0.321";
    });
    await expect(approved(body(), otherEngine)).rejects.toThrow(/not available yet/iu);
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

  it("leaves out, with one fixed note, a service the entry only has as `available` and one the table does not know (never described)", () => {
    const proposal = proposeDependencies([candidate("aws:s3"), candidate("aws:sns"), candidate("aws:kinesis"), candidate("aws:lambda"), candidate("aws:nosuchservice")], context());
    expect(proposal.dependencies.map((entry) => entry.id)).toEqual(["aws-s3", "aws-sns", "aws-lambda"]);
    expect(proposal.notes).toHaveLength(1);
    expect(proposal.notes.join(" ")).not.toMatch(/sns|kinesis|lambda|nosuchservice/iu);
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

});


// ---- evidence and the pull request

const pinnedRows: PinnedDependency[] = [{ id: "postgres", name: "Postgres", backing: "local" }, { id: "aws-s3", name: "S3", backing: "emulated", awsServices: ["s3"] }, { id: "aws-sqs", name: "SQS", backing: "emulated", awsServices: ["sqs"] }, { id: "aws-dynamodb", name: "DynamoDB", backing: "emulated", awsServices: ["dynamodb"] }];
const usageOf = (ids: string[]): RawUsage => ({ schemaVersion: 1, dependencies: ids.map((id) => ({ id, started: true, healthy: true, startMs: 1200, resetCount: 0 })), unknownCalls: { domains: [], otherCount: 0 },
  // a clean run of the emulator: its ledger was read and shows only planned services (the broker also judges this; see test-services-aws-usage-verdict.test.ts)
  aws: { ledger: "read", services: [{ service: "s3", calls: 2, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 } });
const packOf = (dependencies: ReturnType<typeof dependencyEvidenceOf>["dependencies"]) => ({ environment: { dependencies } }) as never;

describe("evidence and the pull request", () => {

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
    expect(evidenceNotTestedLines(pack, 0).filter((line) => /permissions/iu.test(line))).toEqual([]);
  });

  });
