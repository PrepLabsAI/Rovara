// Test services, slice 1 (design test-services.md 4.0 and 8; round plan ROUND-2026-11-03-test-services-hookup.md, s1-worker-round T1): the orchestrator that turns a task's pinned dependency plan into a running set of real
// services for the whole task, and puts the pieces built earlier together:
//
//   - the helpers (service-helpers.ts) start through the ServiceRunner (service-runner.ts) on the run's own services network, from images the worker's own signed catalog pins (the plan's digest must AGREE with it);
//   - the WORKING sandbox joins the services network at .3 and every command it runs gets the run's connection variables LAST, as an env file (service-env.ts), so a repository's own `DATABASE_URL` never wins;
//   - the seeds run once the helpers are healthy (`seedRun`), in the working sandbox;
//   - every official check round (the normal round, the CHECKS retry, the TESTPROOF rerun, the baseline scans: all of them go through `runChecks`) is SEALED: the working sandbox leaves the network, the sealed check
//     sandbox starts only through s1-sealed's `withSealedCheckRound` (= `withDetachedWorking`), the helpers are put back to their seeded state first, and the sandbox is removed and the working sandbox put back when
//     `runChecks` returns, whatever happened (`CheckRunners.endRound`);
//   - the run is torn down on every exit path (TS-RUN-4): `TaskSandbox.dispose()` calls `teardown()` first, and run-task disposes its sandboxes in a `finally`, so success, failure, cancel and a throw all end the same way: the
//     check sandbox and the sealed name server removed, the sandbox off the network, the helpers and the network removed, the run's directory deleted. A killed worker leaves labelled objects only; the worker-start sweep
//     (`testServicesAtWorkerBoot`, TS-RN-3 rule 3) removes those, and nothing that is not labelled.
//
// Rules this module keeps, each with a test (tests/unit/worker-test-services-run.test.ts):
//   - NOTHING HAPPENS WITHOUT A PLAN WITH DEPENDENCIES. With `tx` off the broker sends none; `startTaskTestServices` returns undefined at once (no Docker call, no file), `withTestServices(undefined, runners)` is the same object,
//     and `testServicesAtWorkerBoot` sweeps nothing (it only logs the worker_start report) when the worker is not configured for test services.
//   - NO SECRET IN ANY LOG, ARGUMENT OR ERROR. A per-run password is made here, used in the env files (0600, on the run's tmpfs directory, removed after each exec) and nowhere else; `helperSecretValues` goes to the redactor, and
//     to `neverValues` except for a password that a connection template deliberately delivers to the sandbox (service-env.ts refuses a variable that holds a never value). Every error this module throws is a fixed sentence.
//   - FAIL CLOSED. A worker without the sealed round (s1-sealed) or without configuration refuses a plan with dependencies before it starts anything. A dependency whose repository, digest or family differs from the worker's
//     signed catalog is refused. A check that is asked for with no sealed round open is refused (it never falls back to the working sandbox).
//
// SLICE 3, FAKES: a plan dependency with `backing: "fake"` starts the fake server from the WORKER'S OWN image (service-helpers.ts, fake-helper.ts) serving an approved fixture set the plan names by DIGEST. At the start of
// each phase that serves one (the coding phase, and every sealed round: a new fake each, like Postgres) the set is fetched through `FixtureDelivery` (fixture-delivery.ts: a fresh read address from the broker's `fixture-set`
// callback, the bytes held to the digest) and written into THAT helper's own run directory, mounted read-only into that one helper. It is in no env file, no argument, no log and no sandbox mount, and nothing keeps it between
// phases (a set withdrawn after one round is not served in the next). A round's fake answers the check sandbox's address alone, and sits on the round's own network that the working sandbox is never on. Its ledger summary is
// read while it runs (fake-usage.ts) and goes into the usage record as five bucketed counts per fake.
//
// FILE SEEDS (TS-UX-1 item 9): `seeds[].fixturePath` is loaded by the database's own client inside its container (service-seed-file.ts: repository files only, no link escape, a size cap, a time limit, no network, no
// secret). Postgres only; any other family is refused.
// WHAT IS NOT HERE (listed in the lane report): a sinkhole container (slice 3: the sealed name server still counts every unknown name, which is what the
// usage record reads), a fake that makes up answers (`schema_synth`), a fake that is restarted between checks, and any backing but `local`, `emulated` and `fake`.
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  CATALOG_REGISTRY_ROOT, PrepullListSchema, ServiceCatalogSchema, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_FAKE_PLAN_FEATURE, TEST_SERVICES_FILE_SEED_FEATURE, TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_SEED_LOCK_FEATURE, TEST_SERVICES_USAGE_LIMITS, TEST_SERVICES_USAGE_RESULT_KEY, TestServicesUsageRecordSchema, agentXError, catalogEntryById, catalogRepositoryName,
  type CatalogEdition, type CatalogEntry, type ServiceCatalog, type TaskAwsResource, type TaskDependencyPlan, type TestEnvTaskPlan, type TestServicesStartFailure, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, type TaskSandbox } from "./task-sandbox.js";
import { SANDBOX_TARGET, executionFor } from "./execution-target.js";
import type { ArtifactSink } from "./artifacts.js";
import type { WorkerCancellationController } from "./cancel.js";
import type { CommandResult } from "./readiness.js";
import {
  checkSandboxPlan, isPinnedImage, waitForSealedDnsHelper, writeCheckSandboxFiles,
  type CheckSandboxNetwork, type CheckSandboxPlan,
} from "./check-sandbox.js";
import type { ContainerExec } from "./devcontainer.js";
import { runNetworkHelperIp, runNetworkLabelArgs, servicesNetworkStaleAfterMs } from "./run-network.js";
import {
  HELPER_CREDENTIAL_PATTERNS, HelperStartError, newLocalAwsCredentials, sweepServicesNetworksAtWorkerStart,
  type HelperFiles, type HelperRequest,
} from "./service-helpers.js";
import {
  buildServiceEnvironment, createRunDirectoryFiles, createServiceRedactor, helperSecretValues, removeRunDirectory, unbackedAwsServices, withServiceEnvFile,
  type ServiceEnvDependency, type ServiceEnvironment, type ServiceRedactor,
} from "./service-env.js";
import { EmulatorControlError, type EmulatorControlTarget } from "./emulator-control.js";
import { emulatorLedgerPort, type EmulatorLedgerPort } from "./emulator-ledger.js";
import { EmulatorSeedError, SEEDED_AWS_SERVICES, readAwsResourcesFromIac, seedEmulator } from "./service-seed-aws.js";
import { SeedError, createResetHooks, resetForNextCheck, seedRun, type ResetDependency, type SeedPorts } from "./service-reset.js";
import { SeedFileError, loadSeedFile, readSeedFile, seedFileDigest } from "./service-seed-file.js";
import { seedLockHoldsInCheckout } from "./service-seed-lock.js";
import { createFixtureDelivery, type FixtureDelivery, type FixtureSetCallback } from "./fixture-delivery.js";
import { fakeUsagePort, type FakeUsagePort } from "./fake-usage.js";
import {
  createDockerServiceRunner, type SandboxAttachment, type ServiceRunner, type ServiceSession,
} from "./service-runner.js";
import { refuseTestServicesWithDevcontainer, withSealedCheckRound } from "./check-round-runners.js";
import { UNREADABLE_AWS_USAGE, buildServiceUsageRecord, countResets, mergeAwsUsage, mergeFakeUsage } from "./service-usage-record.js";
import { setupWorkspaceKey } from "./setup-network.js";
import { TEST_SERVICES_BOOT_FACTS_ENVIRONMENT, emitReport, type ReportOutcome } from "./test-services-report.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";
import type { CheckRunners } from "./verification/checks.js";
import { hiddenWorkspaceDirectories } from "./workspace-state.js";

/** The artifact the usage record is written to after every sealed round (latest wins). s1-broker's evidence step reads it by this name. */
export const TEST_SERVICES_USAGE_ARTIFACT = "test-services-usage.json";
/**
 * How long the run's objects count as live for OTHER runs' allocation sweeps: they remove an object only once its own expiry has come (run-network.ts). A task can code for hours, so the budget stamped on a task's
 * run is generous (12 hours); a killed worker's leftovers go at the worker-start sweep, not at this expiry.
 */
export const TEST_SERVICES_RUN_LIFETIME_MS = 12 * 60 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
const SEED_LIMIT_MS = 10 * 60_000;
/** Slice 1 has no sinkhole container; the sealed name server needs an address for it, and this one belongs to no helper (the last of the 32). */
const SINKHOLE_HELPER_INDEX = 31;
const SINKHOLE_URL = "http://sinkhole";
const DEFAULT_USER = "rovara";
const DEFAULT_DATABASE = "app";
const DEFAULT_MAX_MEM_MIB = 3072;
const MODES_WITH_SERVICES: ReadonlySet<string | undefined> = new Set([undefined, "IMPLEMENT", "CHECKS"]);

// ---- errors

export type TestServicesFailureReason =
  | "not_configured" | "unsupported" | "nightly" | "init_file" | "catalog" | "mismatch" | "sealed_unavailable" | "pull_failed" | "start_failed" | "not_healthy" | "seed_failed" | "seed_changed" | "seed_meta_command" | "seed_program" | "seed_not_allowed" | "setup_failed" | "fixtures";

/** The one sentence for an image the worker cannot use: it is not one of the digests pinned INSIDE this worker image, or it was not pre-pulled onto this worker at boot. The worker never pulls. */
export const PULL_FAILED_SENTENCE = "Dependency image not available on this worker";

const SENTENCES: Record<TestServicesFailureReason, string> = {
  not_configured: "This worker is not set up to run test services",
  init_file: "A test service's init file is not a plain SQL file inside the workspace",
  nightly: "Test services are not available yet for a nightly run",
  unsupported: "Test services need the task sandbox, and this task does not run in one",
  catalog: "The test services catalog could not be used",
  mismatch: "A test service in the plan is not the one this worker's catalog pins",
  sealed_unavailable: "This worker cannot run sealed check rounds, so it did not start the test services",
  pull_failed: PULL_FAILED_SENTENCE,
  start_failed: "The test services could not be started",
  not_healthy: "A test service did not become healthy",
  seed_failed: "A test service's seeds did not complete",
  seed_changed: "A test service's seed file changed since the test environment was approved; check it works and approve it again",
  seed_meta_command: "A test service's seed file holds a psql command (a backslash, as in \\copy, \\! or a pg_dump COPY FROM stdin block); a seed file is plain SQL only",
  seed_program: "A test service's seed file uses COPY ... PROGRAM, which a seed file may not run",
  seed_not_allowed: "A test service's seed file runs a statement the seed role may not run: it has no superuser rights (no file reads, server programs or extensions)",
  setup_failed: "The sealed check round's name server could not be set up",
  fixtures: "The approved answers a test service needs could not be fetched",
};

/** The one error of this module. `message` is a fixed sentence (never a command's output, a path or a value); `failures` is what the usage record says per dependency. */
export class TestServicesError extends Error {
  constructor(readonly reason: TestServicesFailureReason, readonly failures: ReadonlyMap<string, TestServicesStartFailure> = new Map()) {
    super(SENTENCES[reason]);
    this.name = "TestServicesError";
  }
}

// ---- the ports and the configuration

/** What a sealed round needs from the caller (s1-sealed's `SealedCheckRoundInput`; `withSealedCheckRound` accepts exactly this). */
export interface SealedRoundSetup {
  docker: DockerCli;
  /** The project has a dev container: the round is refused. Always false here (a task with a dev container never starts services). */
  hasDevcontainer: boolean;
  /** The working sandbox's working-phase network and its address: the sealed round checks it is there afterwards and NEVER connects it to the round's own network. */
  workingPhaseNetwork: { name: string; ip: string } | null;
  plan: CheckSandboxPlan;
  rootPath: string;
  files: HelperFiles;
  environment: ServiceEnvironment;
  redactor: ServiceRedactor;
  /** The task's signal, passed down to the resolver guard's docker calls when the check sandbox starts: a cancelled task does not wait for them (check-sandbox.ts). */
  signal?: AbortSignal;
}

/** What the usage record is built from (s1-sealed's `ServiceUsageRecordInput`). */
export interface UsageRecordSetup {
  planned: readonly string[];
  session?: Pick<ServiceSession, "helpers" | "probe">;
  startMs?: ReadonlyMap<string, number> | number;
  resetCounts?: ReadonlyMap<string, number>;
  failures?: ReadonlyMap<string, TestServicesStartFailure>;
  dns?: { docker: DockerCli; dnsHelperName: string };
  redactor: ServiceRedactor;
  /** Slice 2: the emulator's ledger, read now (the round's own emulator, while it still runs). */
  emulator?: EmulatorLedgerPort;
  /** Slice 3: the round's fake servers' ledger summaries, read now (while they still run). */
  fakes?: FakeUsagePort;
}

/**
 * s1-sealed's two exports, as this module needs them. A config without them (`config.sealedRound` undefined) refuses a plan with dependencies before anything starts;
 * `SEALED_ROUND_PORTS` binds them. Tests stub them.
 */
export interface SealedRoundPorts {
  withSealedCheckRound<T>(input: SealedRoundSetup, round: (runners: CheckRunners) => Promise<T>): Promise<T>;
  buildServiceUsageRecord(input: UsageRecordSetup): Promise<unknown>;
}

/** s1-sealed's two exports, bound. This is the only file besides run-task.ts and prepare.ts that may import the sealed round or the usage-record builder (tests/unit/worker-sealed-source-guards.test.ts). */
export const SEALED_ROUND_PORTS: SealedRoundPorts = { withSealedCheckRound, buildServiceUsageRecord };

export interface TestServicesConfig {
  docker: DockerCli;
  /** The install's registry host (and optional port). */
  registry: string;
  /** The named environment in `rovara-catalog/<env>/svc/...`. */
  catalogEnv: string;
  edition: CatalogEdition;
  /** The worker's own image (digest or id): the health probes and the sealed sandbox run from it. */
  probeImage: string;
  /** The worker's own image from AGENTX_WORKER_IMAGE (pinned), for the sealed round's resolver guard: a root NET_ADMIN container that must never run a sandbox image (check-sandbox.ts, "THE GUARD'S IMAGE"). */
  guardImage: string;
  maxMemMiB: number;
  /** A directory on the worker's tmpfs, at the same path on the host (Docker bind-mounts from it), where each run's directory is made. */
  runDirectoryParent: string;
  /** The worker's verified catalog (`loadSignedCatalog`). */
  catalog(): Promise<ServiceCatalog>;
  sealedRound?: SealedRoundPorts;
  runner?: ServiceRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One JSON line per event, fixed words only. Default: the worker's console. */
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>): void => console.log(JSON.stringify({ component: "worker", ...event }));

// ---- the configuration a worker makes from its environment

export const TEST_SERVICES_REGISTRY_ENVIRONMENT = "AGENTX_TEST_SERVICES_REGISTRY";
export const TEST_SERVICES_ENV_ENVIRONMENT = "AGENTX_TEST_SERVICES_ENV";
export const TEST_SERVICES_RUN_DIR_ENVIRONMENT = "AGENTX_TEST_SERVICES_RUN_DIR";
export const TEST_SERVICES_EDITION_ENVIRONMENT = "AGENTX_TEST_SERVICES_EDITION";
export const TEST_SERVICES_MAX_MEM_ENVIRONMENT = "AGENTX_TEST_SERVICES_MAX_MEM_MIB";
/** The worker's own image, pinned by digest (boot-stage2.sh writes it into the worker's environment beside AGENTX_SANDBOX_IMAGE). The resolver guard runs from this one and from nothing a sandbox's configuration names. */
export const WORKER_IMAGE_ENVIRONMENT = "AGENTX_WORKER_IMAGE";
/** The catalog the worker image ships, beside `dist/` (the same relative place from `src/` and from `dist/`). It is copied into the image at build time (environments/base/Dockerfile) from the release's committed catalog. */
export const BAKED_CATALOG_URL = new URL("../service-catalog/catalog.json", import.meta.url);
const BAKED_CATALOG_MAX_BYTES = 512 * 1024;

/**
 * The catalog that is PART OF THIS WORKER IMAGE (H4): the worker verifies no signature at run time and trusts no key. The image comes from the release pipeline, so its files (this catalog, with the digests it pins, and
 * `prepull.json`) are exactly the release's; a worker runs a dependency only if the plan's digest is the one pinned here AND that exact digest is already on this host (`requireLocalImages`). The path is compiled in (no
 * environment variable, no setting, nothing writable), and the broker keeps the signed-catalog check, with the staging or release trust, before it ever puts a digest in a plan. A file that cannot be read or is not a catalog
 * is the fixed `catalog` error.
 */
export async function loadBakedCatalog(file: URL | string = BAKED_CATALOG_URL): Promise<ServiceCatalog> {
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > BAKED_CATALOG_MAX_BYTES) throw new Error("too large");
    return ServiceCatalogSchema.parse(JSON.parse(text));
  } catch {
    throw new TestServicesError("catalog");
  }
}

/**
 * The worker's configuration for test services, or undefined when it has none (every variable that is needed must be set; a worker with `tx` off has none of them, so it never makes a Docker call for this). The sealed
 * ports come from `test-services-sealed.ts`. The probe image is the sandbox image (boot.sh sets it to the worker's own image).
 */
export function testServicesConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env, docker: DockerCli = createDockerCli(), roundPorts: SealedRoundPorts | undefined = SEALED_ROUND_PORTS,
): TestServicesConfig | undefined {
  const registry = environment[TEST_SERVICES_REGISTRY_ENVIRONMENT];
  const catalogEnv = environment[TEST_SERVICES_ENV_ENVIRONMENT];
  const runDirectoryParent = environment[TEST_SERVICES_RUN_DIR_ENVIRONMENT];
  const probeImage = environment[TASK_SANDBOX_IMAGE_ENVIRONMENT];
  const guardImage = environment[WORKER_IMAGE_ENVIRONMENT];
  // No worker image, or one that is not pinned: no configuration, so no sealed round (it could not close the embedded resolver from a trusted image).
  if (!registry || !catalogEnv || !runDirectoryParent || !probeImage || !guardImage || !isPinnedImage(guardImage)) return undefined;
  // Root withheld test services on this host (boot-stage2.sh writes `all`, also when the IPv6 wall failed and the images ARE here): no configuration, so no entry point can start a run, whatever the plan.
  if (notPulledRepositories(environment) === "all") return undefined;
  const edition = environment[TEST_SERVICES_EDITION_ENVIRONMENT] === "enterprise" ? "enterprise" : "public";
  const mem = Number(environment[TEST_SERVICES_MAX_MEM_ENVIRONMENT] ?? DEFAULT_MAX_MEM_MIB);
  return {
    docker, registry, catalogEnv, edition, probeImage, guardImage, runDirectoryParent, maxMemMiB: Number.isSafeInteger(mem) && mem > 0 ? mem : DEFAULT_MAX_MEM_MIB,
    catalog: () => loadBakedCatalog(), ...(roundPorts === undefined ? {} : { sealedRound: roundPorts }),
  };
}

// ---- the worker's start (TS-RN-3 rule 3 and TS19)

/**
 * Called once when the worker starts, before it takes any work: removes what a killed worker left (every container and network that carries the run-network family label AND this workspace's key, and nothing else).
 * A worker with no test services configuration sweeps nothing and only logs its worker_start report. Never throws. (The catalog images are pulled by root at boot, not here: the worker never pulls.)
 */
export async function testServicesAtWorkerBoot(input: { rootPath: string; config?: TestServicesConfig | undefined; environment?: NodeJS.ProcessEnv; docker?: DockerCli; log?: (event: Record<string, unknown>) => void }): Promise<void> {
  const log = input.log ?? defaultLog;
  try {
    const config = input.config ?? testServicesConfigFromEnvironment(input.environment ?? process.env, input.docker ?? createDockerCli());
    if (config === undefined) {
      // Not configured for test services (for instance root's pre-pull failed, so the settings were not written): the worker still says so, with root's boot facts (`prepull: "failed"` shows there), so an operator sees WHY.
      const unconfiguredWorkspace = await setupWorkspaceKey(input.rootPath);
      await emitReport({ docker: input.docker ?? createDockerCli(), workspace: unconfiguredWorkspace, phase: "worker_start", outcome: "booted", bootFactsText: (input.environment ?? process.env)[TEST_SERVICES_BOOT_FACTS_ENVIRONMENT] }, log);
      return;
    }
    const workspace = await setupWorkspaceKey(input.rootPath);
    const swept = await sweepServicesNetworksAtWorkerStart(config.docker, workspace);
    if (swept.containers + swept.networks > 0) log({ event: "test-services.leftovers.removed", ...swept });
    // The worker's self-report at start, after the sweep: what is left (should be nothing), the run directory, and the facts root wrote at boot.
    await emitReport({ docker: config.docker, workspace, runDirectoryParent: config.runDirectoryParent, phase: "worker_start", outcome: "booted", swept, bootFactsText: (input.environment ?? process.env)[TEST_SERVICES_BOOT_FACTS_ENVIRONMENT] }, log);
    // No pre-pull here: the worker container has no registry login and no AWS credentials, so it never pulls. Root pulls the pinned digests before the worker starts (packages/worker/ec2/boot-stage2.sh).
  } catch {
    log({ event: "test-services.boot.failed" });
  }
}

// ---- the plan to helper requests and the run's environment

/** One dependency of the plan checked against the worker's own signed catalog; credentials and requests are made per phase (`materialize`). */
interface Base {
  plan: TaskDependencyPlan;
  entry: CatalogEntry;
  aliases: string[];
  host: string;
  port: number;
  user: string;
  database: string;
  resetDependency: ResetDependency;
  /** The dependency's init files (read once, checked), mounted into ITS helper alone, in the working phase and in every round. */
  files: NonNullable<HelperRequest["files"]>;
  /** Slice 2: this base is the ONE Rovara local AWS helper that all of the plan's emulated entries share (`plan` is the first of them). */
  emulator?: EmulatorBase;
  /** Slice 3: this base is a fake server, serving the fixture set with this digest (the plan's pin). */
  fake?: { digest: string };
}

/** What the plan's emulated entries add up to: their ids (each reports its own usage row), the AWS services they need, the region the code is told, and the infrastructure files that declare the resources. */
interface EmulatorBase {
  ids: string[];
  services: string[];
  region: string;
  refs: Array<{ path: string }>;
}

/** A dependency with one phase's own helper request and credentials (the working phase's, or one sealed round's). The emulator's has no `env`: its variables come from the `aws` block of the environment. */
interface Resolved extends Base {
  request: HelperRequest;
  env?: ServiceEnvDependency;
}

/** The most an init file may hold (the launcher's own limit for a helper's file). */
const INIT_FILE_MAX_BYTES = 1_048_576;
const INIT_FILE_FAMILIES: ReadonlySet<string> = new Set(["postgres", "mysql"]);

/**
 * A dependency's `config.initFiles` (init SQL from the repository), as files for ITS helper alone. The broker only checks that each is a relative path without `..`; a symlink inside the repository can still point anywhere,
 * so here each path is resolved to its real path, which must be a regular file under one of the REPOSITORIES' own folders (the manifest's paths, resolved), never under a hidden folder of the workspace (the worker's state,
 * the agent's sessions, the Docker data root), ending in `.sql` (the image runs a `.sh` it finds there), and small. It is opened without following a link, and the opened file must be the very file that was resolved (same device and
 * inode), then read through that handle. The content goes into the launcher's `HelperRequest.files`: the launcher writes it to the run's directory and mounts it read-only into that one helper. Anything else is one fixed error
 * (`init_file`) and nothing has been started yet.
 */
async function initFilesOf(plan: TaskDependencyPlan, root: string, repositoryPaths: readonly string[]): Promise<NonNullable<HelperRequest["files"]>> {
  const paths = plan.config.initFiles ?? [];
  if (paths.length === 0) return [];
  if (!INIT_FILE_FAMILIES.has(plan.family)) throw new TestServicesError("init_file");
  const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);
  let repositories: string[];
  let hidden: string[];
  try {
    repositories = (await Promise.all(repositoryPaths.map((path) => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    hidden = await Promise.all((await hiddenWorkspaceDirectories(root)).map((path) => realpath(path).catch(() => path)));
  } catch {
    throw new TestServicesError("init_file");
  }
  const files: Array<{ name: string; content: string; to: string }> = [];
  for (const [index, path] of paths.entries()) {
    try {
      const real = await realpath(resolve(root, path));
      if (!real.endsWith(".sql") || !repositories.some((folder) => real.startsWith(`${folder}${sep}`)) || hidden.some((folder) => within(real, folder))) throw new Error("outside");
      const resolvedInfo = await stat(real);
      const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > INIT_FILE_MAX_BYTES || info.dev !== resolvedInfo.dev || info.ino !== resolvedInfo.ino) throw new Error("not the file that was resolved");
        const number = String(index + 1).padStart(2, "0");
        files.push({ name: `init-${number}.sql`, content: await handle.readFile("utf8"), to: `/docker-entrypoint-initdb.d/init-${number}.sql` });
      } finally {
        await handle.close();
      }
    } catch {
      throw new TestServicesError("init_file");
    }
  }
  return files;
}

/** Every base's image, by digest, must already be on this host (the launcher runs with `--pull=never`, and the worker has no registry login). Otherwise: the fixed `pull_failed`, naming the dependencies, with nothing made yet. */
async function requireLocalImages(docker: DockerCli, config: Pick<TestServicesConfig, "registry" | "catalogEnv">, bases: readonly Base[], signal: AbortSignal | undefined): Promise<void> {
  const missing = new Map<string, TestServicesStartFailure>();
  for (const base of bases) {
    if (signal?.aborted === true) throw new TestServicesError("start_failed");
    // A fake runs from the worker's own image (the probe image), which is on this host by being the worker's: it has no catalog image to pull.
    if (base.fake !== undefined) continue;
    const reference = `${config.registry}/${catalogRepositoryName(config.catalogEnv, base.plan.repository)}@sha256:${base.plan.digest}`;
    const present = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: DOCKER_CALL_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }).catch(() => undefined);
    if (present === undefined || present.exitCode !== 0) for (const id of base.emulator?.ids ?? [base.plan.id]) missing.set(id, "pull_failed");
  }
  if (missing.size > 0) throw new TestServicesError("pull_failed", missing);
}

const randomAlphanumeric = (length: number): string => randomBytes(length).toString("hex").slice(0, length);

/**
 * The plan's dependencies against the worker's own signed catalog: the plan names an entry, a repository and a digest, and the catalog must say the same (family, backing, pinned digest, edition, not retired). Anything else
 * is `mismatch`: the broker's plan is never trusted to name an image. The user and the database come from the plan's config or fixed defaults, and must have the launcher's plain form.
 */
function resolveDependencies(catalog: ServiceCatalog, dependencies: readonly TaskDependencyPlan[], config: Pick<TestServicesConfig, "edition">): Base[] {
  const emulated = dependencies.filter((plan) => plan.backing === "emulated");
  const bases: Base[] = [];
  let group: Base | undefined;
  for (const plan of dependencies) {
    if (plan.backing === "emulated") {
      if (group === undefined) {
        group = resolveEmulator(catalog, emulated, config);
        bases.push(group);
      }
      continue;
    }
    bases.push(plan.backing === "fake" ? resolveFake(catalog, plan, config) : resolveLocal(catalog, plan, config));
  }
  return bases;
}

/**
 * A fake against the worker's own catalog: the entry must be the catalog's fake server (a helper that runs from the worker's image: marked `workerImage`, no digest), offered in this edition and not retired, for the repository
 * the plan names; the plan carries no image digest, a fixture set digest, no seeds and a reset that makes a new fake each round, and a name to be reached by. Anything else is `mismatch`: the broker's plan is never trusted to
 * name an image or a policy. A catalog this worker image does not have the entry in at all is the fixed `pull_failed` ("not available on this worker").
 */
function resolveFake(catalog: ServiceCatalog, plan: TaskDependencyPlan, config: Pick<TestServicesConfig, "edition">): Base {
  const entry = catalogEntryById(catalog, plan.catalogId);
  if (entry === undefined) throw new TestServicesError("pull_failed", new Map([[plan.id, "pull_failed" as const]]));
  if (entry.backing !== "fake" || entry.family !== "fake-server" || entry.workerImage !== true || entry.status === "retired" || !entry.editions.includes(config.edition) || entry.image.repository !== plan.repository) throw new TestServicesError("mismatch");
  if (plan.digest !== undefined || plan.fake === undefined || plan.fake.unmatched !== "fail" || plan.seeds.length > 0 || plan.reset !== "fresh_per_round" || plan.aws !== undefined || (plan.config.initFiles?.length ?? 0) > 0) throw new TestServicesError("mismatch");
  const aliases = [...plan.aliases];
  const host = aliases[0];
  const port = entry.run.ports[0];
  if (host === undefined || port === undefined) throw new TestServicesError("mismatch");
  return { plan, entry, aliases, host, port, user: DEFAULT_USER, database: DEFAULT_DATABASE, resetDependency: { id: plan.id, seeds: [], reset: "fresh_per_round" }, files: [], fake: { digest: plan.fake.fixtureSetRef } };
}

/**
 * The fixture sets of the plan's fakes for ONE phase, as JSON text by digest. Each is fetched now through the run's delivery (a fresh read address, the bytes held to the digest) and returned to the caller, which hands it to
 * the one helper that serves it: nothing here keeps a set. A plan with a fake and no delivery (a worker started without the callback), or any fetch that fails, is the fixed `fixtures`.
 */
async function fetchFixtures(bases: readonly Base[], delivery: FixtureDelivery | undefined, signal: AbortSignal | undefined): Promise<ReadonlyMap<string, string>> {
  const texts = new Map<string, string>();
  for (const base of bases) {
    const digest = base.fake?.digest;
    if (digest === undefined || texts.has(digest)) continue;
    if (delivery === undefined) throw new TestServicesError("fixtures");
    try {
      texts.set(digest, JSON.stringify(await delivery(digest, signal)));
    } catch {
      throw new TestServicesError("fixtures");
    }
  }
  return texts;
}

/** The plan's allowed region words: the contract's AWS shape is checked by the broker; this is the worker's own, looser-but-closed form (it never relies on the broker alone). */
const EMULATOR_REGION = /^[a-z0-9-]{1,32}$/u;
/** ... and the AWS shape the sandboxes' `AWS_REGION` takes (service-env.ts), so a region the environment would refuse is refused here, before anything is made. */
const AWS_REGION_SHAPE = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/u;
const MAX_EMULATOR_SEEDS = 8;

/**
 * The plan's emulated entries against the worker's own catalog: ONE Rovara local AWS helper for all of them. Each entry must name the same pinned image the catalog pins (a digest the image does not pin is the fixed
 * `pull_failed`), the same region, AWS services of the three this slice serves and nothing else, no connection variables and no init files (the sandboxes' variables come from the `aws` block). Anything else is `mismatch`:
 * the broker's plan is never trusted to name an image, a service or a region.
 */
function resolveEmulator(catalog: ServiceCatalog, emulated: readonly TaskDependencyPlan[], config: Pick<TestServicesConfig, "edition">): Base {
  const first = emulated[0]!;
  const allIds = emulated.map((plan) => plan.id);
  const notAvailable = (): never => { throw new TestServicesError("pull_failed", new Map(allIds.map((id) => [id, "pull_failed" as const]))); };
  const entry = catalogEntryById(catalog, first.catalogId);
  if (entry === undefined) return notAvailable();
  if (entry.backing !== "emulated" || entry.family !== "local-aws" || entry.status === "retired" || !entry.editions.includes(config.edition) || entry.image.repository !== first.repository) throw new TestServicesError("mismatch");
  if (entry.image.digest !== first.digest) return notAvailable();
  const services = new Set<string>();
  const refs = new Map<string, { path: string }>();
  const seeds: TaskDependencyPlan["seeds"] = [];
  for (const plan of emulated) {
    if (plan.catalogId !== first.catalogId || plan.repository !== first.repository || plan.digest !== first.digest || plan.aws === undefined || plan.aws.region !== first.aws?.region) throw new TestServicesError("mismatch");
    if (!EMULATOR_REGION.test(plan.aws.region) || !AWS_REGION_SHAPE.test(plan.aws.region) || plan.connect.length > 0 || (plan.config.initFiles?.length ?? 0) > 0) throw new TestServicesError("mismatch");
    for (const service of plan.aws.services) {
      if (!Object.hasOwn(SEEDED_AWS_SERVICES, service)) throw new TestServicesError("mismatch");
      services.add(service);
    }
    if (plan.aws.resources !== undefined) refs.set(plan.aws.resources.path, { path: plan.aws.resources.path });
    seeds.push(...plan.seeds);
  }
  if (seeds.length > MAX_EMULATOR_SEEDS || refs.size > MAX_EMULATOR_SEEDS) throw new TestServicesError("mismatch");
  const aliases = first.aliases.length > 0 ? [...first.aliases] : [...entry.connect.defaultAliases];
  const host = aliases[0];
  const port = entry.run.ports[0];
  if (host === undefined || port === undefined) throw new TestServicesError("mismatch");
  return {
    plan: first, entry, aliases, host, port, user: DEFAULT_USER, database: DEFAULT_DATABASE, files: [],
    resetDependency: { id: first.id, seeds, reset: emulated.some((plan) => plan.reset === "between_checks") ? "between_checks" : "fresh_per_round" },
    emulator: { ids: allIds, services: [...services], region: first.aws!.region, refs: [...refs.values()] },
  };
}

function resolveLocal(catalog: ServiceCatalog, plan: TaskDependencyPlan, config: Pick<TestServicesConfig, "edition">): Base {
  const entry = catalogEntryById(catalog, plan.catalogId);
  // A catalog id this worker image does not carry at all (the broker approved a newer catalog than the image): the same "not available on this worker" sentence as a digest it does not pin.
  if (entry === undefined) throw new TestServicesError("pull_failed", new Map([[plan.id, "pull_failed" as const]]));
  if (entry.backing !== "local" || entry.status === "retired" || entry.family !== plan.family || !entry.editions.includes(config.edition)
    || entry.image.repository !== plan.repository) throw new TestServicesError("mismatch");
  // The digest must be one PINNED IN THIS WORKER IMAGE (the broker may have approved a newer catalog than the image the worker was built from): the fixed "not available on this worker" sentence, never a generic error.
  if (entry.image.digest !== plan.digest) throw new TestServicesError("pull_failed", new Map([[plan.id, "pull_failed" as const]]));
  const user = plan.config.user ?? DEFAULT_USER;
  const database = plan.config.database ?? DEFAULT_DATABASE;
  if (!HELPER_CREDENTIAL_PATTERNS.user.test(user) || !HELPER_CREDENTIAL_PATTERNS.database.test(database)) throw new TestServicesError("mismatch");
  const aliases = plan.aliases.length > 0 ? [...plan.aliases] : [...entry.connect.defaultAliases];
  const host = aliases[0];
  const port = entry.run.ports[0];
  if (host === undefined || port === undefined) throw new TestServicesError("mismatch");
  return { plan, entry, aliases, host, port, user, database, resetDependency: { id: plan.id, seeds: plan.seeds, reset: plan.reset }, files: [] };
}

/**
 * One phase's helper request and variables, with a password made now: the working phase and every sealed round have their own, so no phase's helpers or password are another's. A fake's request carries its phase's set (fetched
 * for this phase) and which sandbox it answers; it has no password.
 */
function materialize(base: Base, phase: "working" | "check", fixtures: ReadonlyMap<string, string>): Resolved {
  if (base.fake !== undefined) {
    const fixtureJson = fixtures.get(base.fake.digest);
    if (fixtureJson === undefined) throw new TestServicesError("fixtures");
    return {
      ...base, request: { id: base.plan.id, name: base.plan.name, entry: base.entry, aliases: base.aliases, fake: { phase, digest: base.fake.digest, fixtureJson } },
      env: { id: base.plan.id, host: base.host, port: base.port, credentials: {}, connect: { env: base.plan.connect, hostAliases: base.aliases } },
    };
  }
  if (base.emulator !== undefined) {
    // Rovara local AWS: THREE fresh, different secrets for each emulator that starts (the working phase's and every sealed round's own): the presign secret as `password`, the control token and the SQS receipt-handle secret.
    return { ...base, request: { id: base.plan.id, name: base.plan.name, entry: base.entry, aliases: base.aliases, credentials: newLocalAwsCredentials(), region: base.emulator.region, awsServices: base.emulator.services } };
  }
  const credentials = { user: base.user, password: randomAlphanumeric(32), database: base.database };
  return {
    ...base,
    request: { id: base.plan.id, name: base.plan.name, entry: base.entry, aliases: base.aliases, credentials, ...(base.files.length === 0 ? {} : { files: base.files }) },
    env: { id: base.plan.id, host: base.host, port: base.port, credentials, connect: { env: base.plan.connect, hostAliases: base.aliases } },
  };
}

/**
 * The values the sandboxes' variables must never hold: every secret of the helpers (`helperSecretValues`) EXCEPT a password that one of the dependency's own connection templates delivers on purpose (`{password}` in
 * `DATABASE_URL`). The control token and a password no template uses are never let through.
 */
export function neverValuesFor(resolved: ReadonlyArray<Pick<Resolved, "request" | "env">>): string[] {
  return resolved.flatMap((item) => {
    // The emulator's three values are never delivered to a sandbox: it has no connection variables at all.
    if (item.env === undefined) return helperSecretValues([item.request]);
    const delivered = item.env.connect.env.some((variable) => variable.template.includes("{password}"));
    const password = item.request.credentials?.password;
    return helperSecretValues([{ credentials: { ...(delivered || password === undefined ? {} : { password }), ...(item.request.credentials?.controlToken === undefined ? {} : { controlToken: item.request.credentials.controlToken }) } }]);
  });
}

/**
 * The variables of one sandbox for a phase's helpers: the connection variables of the real-software dependencies, and, when the plan has an emulator, the `aws` block: `AWS_ENDPOINT_URL_S3` / `_SQS` / `_DYNAMODB` at the
 * emulator's first alias, every other AWS service the table knows (and, in both sandboxes, the global endpoint) at the EMULATOR too (it has them switched off: it refuses the call and records it in its ledger, so the broker flags it; the sinkhole is used only where no emulator runs), `AWS_REGION` and `AWS_DEFAULT_REGION` from the plan's region (only a label inside the emulator:
 * every endpoint is overridden, so no SDK call goes to the region's real AWS), fake credentials. The emulator's control token and secrets are `neverValues`: a variable holding one is refused.
 */
function environmentFor(sandbox: "working" | "check", resolved: readonly Resolved[]): ServiceEnvironment {
  const emulator = resolved.find((item) => item.emulator !== undefined);
  return buildServiceEnvironment({
    sandbox, sinkholeUrl: SINKHOLE_URL, dependencies: resolved.flatMap((item) => (item.env === undefined ? [] : [item.env])), neverValues: neverValuesFor(resolved),
    ...(emulator?.emulator === undefined ? {} : {
      aws: { alias: emulator.host, port: emulator.port, region: emulator.emulator.region, emulatedServices: emulator.emulator.services, unbackedServices: unbackedAwsServices(emulator.emulator.services) },
    }),
  });
}

// ---- the working sandbox's place on the network

/**
 * The working sandbox joins the run's network at .3 and leaves it at the end. the sealed round takes it off the network again for every official check round
 * (`withDetachedWorking`, with proof), so `enterCheckRound` has nothing to do.
 */
function workingSandboxAttachment(docker: DockerCli, sandboxName: string): SandboxAttachment {
  let joined: { network: string; ip: string } | undefined;
  return {
    async attach(view) {
      const connected = await docker.run(["network", "connect", "--ip", view.workingSandboxIp, view.name, sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      if (connected === undefined || connected.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES.start_failed);
      joined = { network: view.name, ip: view.workingSandboxIp };
    },
    async detach() {
      if (joined === undefined) return;
      await docker.run(["network", "disconnect", "--force", joined.network, sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
    },
    // The sealed round detaches the working sandbox itself (withDetachedWorking, with proof) before `freshServices` runs, so there is nothing left to do here.
    enterCheckRound() { return Promise.resolve(); },
  };
}

/** `docker exec [--env-file F] [--env K=V ...] <sandbox> <command>`: the run's variables come from the env file, and a name the run sets is taken out of the command's own `env` (Docker lets `--env` win over `--env-file`). */
function workingExec(docker: DockerCli, files: HelperFiles, sandboxName: string, environment: ServiceEnvironment, active: () => boolean): (inner: ContainerExec) => ContainerExec {
  const owned = new Set(environment.entries.map(([name]) => name));
  const prefix = randomAlphanumeric(12);
  let counter = 0;
  return (inner) => async (command, options) => {
    if (!active()) return inner(command, options);
    counter += 1;
    const own = Object.entries(options.env ?? {}).filter(([name]) => !owned.has(name));
    return withServiceEnvFile(files, `wrk-${prefix}-${String(counter)}`, environment, (envFileArgs) => docker.run([
      "exec", ...envFileArgs, ...own.flatMap(([name, value]) => ["--env", `${name}=${value}`]), sandboxName, ...command,
    ], {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    }));
  };
}

// ---- the run

export interface TestServicesRun {
  /** The dependency ids of the run, in the plan's order. */
  readonly ids: readonly string[];
  /** The runners of an official check round: sealed. `base` (the working sandbox's runners) is not used for any check. */
  checkRunners(base: CheckRunners): CheckRunners;
  /** The usage record as of now (health asked again, the name server's record read), or undefined when it cannot be built. */
  usageRecord(): Promise<TestServicesUsageRecord | undefined>;
  /** Tears the run down (idempotent, never throws). `TaskSandbox.dispose()` calls it. */
  dispose(): Promise<void>;
}

/** `runners` for a task with test services, or the same object for one without (the golden path: nothing changes). */
export function withTestServices(run: TestServicesRun | undefined, runners: CheckRunners): CheckRunners {
  return run === undefined ? runners : run.checkRunners(runners);
}

export interface StartTestServicesInput {
  dependencies: readonly TaskDependencyPlan[];
  /** The operation's id: labels the check sandbox like every task sandbox, and (with a random suffix) names the run. */
  operationId: string;
  /** The canonical workspace root. */
  rootPath: string;
  /** The repositories' folders (absolute, as the manifest has them): a dependency's init files may come only from under them. */
  repositoryPaths: readonly string[];
  /** The task's working sandbox, already started. */
  sandbox: TaskSandbox;
  /** The project has a dev container. Refused before anything is made (the first step). */
  hasDevcontainer: boolean;
  /**
   * Start the working phase (Postgres for the agent's own commands, joined to the working sandbox, with the seeds). Default true. False for CHECKS and Prove: they run no agent, and the only code that touches the
   * database is the sealed rounds', so no working-phase helper exists beside a sealed round (nothing for a relay to reach, nothing to seed).
   */
  workingPhase?: boolean;
  /** Where the usage record is written after each sealed round. */
  artifactSink?: ArtifactSink | undefined;
  /** Stops the start (pulls, helper starts, seeds) when the task is cancelled. */
  signal?: AbortSignal;
  /** Slice 3: fetches the approved fixture set of a fake by digest, at the start of each phase that serves one (fixture-delivery.ts). Absent: a plan with a fake is refused (`fixtures`) before anything starts. */
  fixtureDelivery?: FixtureDelivery;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function failureOf(error: unknown): TestServicesError {
  if (error instanceof TestServicesError) return error;
  if (error instanceof HelperStartError) {
    const failures = new Map<string, TestServicesStartFailure>();
    const failure: TestServicesStartFailure = error.reason === "health_timeout" || error.reason === "exited" ? "not_healthy" : "start_failed";
    if (error.dependencyId !== undefined) failures.set(error.dependencyId, failure);
    return new TestServicesError(failure === "not_healthy" ? "not_healthy" : "start_failed", failures);
  }
  return new TestServicesError("start_failed");
}

/** Adds two usage records of one run: the later record's health and failures, the resets of both, and the unknown names of both (counts are lower bounds, so their sums are too). */
function mergeUsageRecords(earlier: TestServicesUsageRecord | undefined, later: TestServicesUsageRecord): TestServicesUsageRecord {
  if (earlier === undefined) return later;
  const limits = TEST_SERVICES_USAGE_LIMITS;
  const before = new Map(earlier.dependencies.map((entry) => [entry.id, entry]));
  const domains = new Map<string, number>();
  for (const row of [...earlier.unknownCalls.domains, ...later.unknownCalls.domains]) domains.set(row.domain, Math.min(limits.count, (domains.get(row.domain) ?? 0) + row.count));
  const ranked = [...domains].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const overflow = ranked.slice(limits.unknownDomains).reduce((sum, [, count]) => sum + count, 0);
  const aws = mergeAwsUsage(earlier.aws, later.aws);
  const fakes = mergeFakeUsage(earlier.fakes, later.fakes);
  return {
    schemaVersion: 1,
    dependencies: later.dependencies.map((entry) => ({ ...entry, resetCount: Math.min(limits.resets, entry.resetCount + (before.get(entry.id)?.resetCount ?? 0)) })),
    unknownCalls: {
      domains: ranked.slice(0, limits.unknownDomains).map(([domain, count]) => ({ domain, count })),
      otherCount: Math.min(limits.count, earlier.unknownCalls.otherCount + later.unknownCalls.otherCount + overflow),
    },
    ...(aws === undefined ? {} : { aws }),
    ...(fakes === undefined ? {} : { fakes }),
  };
}

/** What one sealed round holds while it is open. Everything in it is the round's own: its network, its helpers, its passwords, its name server and its directory. */
interface RoundState {
  number: number;
  session: ServiceSession;
  counted: ServiceSession;
  resets: ReadonlyMap<string, number>;
  plan: CheckSandboxPlan;
  files: HelperFiles & { directory: string };
  redactor: ServiceRedactor;
  startMs: number;
  dnsStarted: boolean;
  /** TS-UX-1 item 9: loads a seed file into THIS round's helpers (for the seeds and every reseed after a reset). */
  applyFixture: SeedPorts["applyFixture"];
  /** The round's dependencies as they are seeded and put back (the emulator's carry its `prepare` step, bound to THIS round's emulator and token). */
  resetDeps: readonly ResetDependency[];
  /** Slice 2: reads this round's emulator's request ledger (absent when the plan has no emulator). */
  ledger: EmulatorLedgerPort | undefined;
  /** Slice 3: reads this round's fake servers' ledger summaries (absent when the plan has no fake). */
  fakes: FakeUsagePort | undefined;
  /** Absent while the round is still starting. */
  runners: CheckRunners | undefined;
  /** Ends the sealed round (the check sandbox removed, the working sandbox put back). */
  sealedClose(): Promise<void>;
}

/**
 * Starts the run's WORKING PHASE: pulls the pinned images, makes the network, starts and health-waits the helpers, joins the working sandbox, and runs the seeds there. This is where the agent codes; the helpers here
 * are for the working phase ONLY. Every official check round (`checkRunners`) starts BRAND-NEW helpers of its own from the same pinned digests, on a network of its own that the working sandbox is never on, with new
 * passwords and its own name server, seeds them INSIDE the round from the candidate code, and removes all of it when the round ends (design 4.0 and 8.1): nothing the agent did to the working-phase database (a table, an
 * `ALTER SYSTEM`, a template, a file written by `COPY ... PROGRAM`) can reach a round. The working-phase helpers keep running between rounds. The working-phase Postgres user is the image's superuser (the catalog has
 * no field for a lesser role); that is why no round reuses it. On ANY failure everything made so far is removed before this throws a `TestServicesError`. On success the sandbox's `dispose()` tears the run down.
 */
export async function startTestServicesRun(config: TestServicesConfig, input: StartTestServicesInput): Promise<TestServicesRun> {
  // The very first step: a project with a dev container is "not available yet", before a directory, a network, a name server or a helper exists.
  refuseTestServicesWithDevcontainer({ dependencies: input.dependencies, devcontainer: input.hasDevcontainer });
  const ports = config.sealedRound;
  if (ports === undefined) throw new TestServicesError("sealed_unavailable");
  const log = config.log ?? defaultLog;
  const now = config.now ?? Date.now;
  const docker = config.docker;
  const catalog = await config.catalog().catch(() => { throw new TestServicesError("catalog"); });
  const bases = resolveDependencies(catalog, input.dependencies, config);
  const root = await realpath(resolve(input.rootPath));
  // Before anything is made: the init files of each dependency, checked against the repositories' real folders.
  for (const base of bases) base.files = await initFilesOf(base.plan, root, input.repositoryPaths);
  // The worker NEVER pulls: root pulled the pinned digests at boot (boot-stage2.sh), and a digest that is not on this host now is the fixed pull_failed, before anything is made (the files above touch no Docker).
  await requireLocalImages(docker, config, bases, input.signal);
  const runId = `${input.operationId.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 48)}-${randomAlphanumeric(8)}`;
  const workspace = await setupWorkspaceKey(root);
  const files = await createRunDirectoryFiles(config.runDirectoryParent, `rsv-${sha(runId).slice(0, 16)}`).catch(() => { throw new TestServicesError("start_failed"); });
  const runner = config.runner ?? createDockerServiceRunner(docker);

  const failures = new Map<string, TestServicesStartFailure>();
  const ids = input.dependencies.map((dependency) => dependency.id);
  const emulatorBase = bases.find((base) => base.emulator !== undefined);
  const secrets: string[] = [];
  const pendingStarts = new Set<Promise<ServiceSession>>();
  let workSession: ServiceSession | undefined;
  let workStartMs = 0;
  let active = true;
  let torndown: Promise<void> | undefined;
  let runOutcome: ReportOutcome = "completed";
  /** A check command of a sealed round ended non-zero or timed out (the seeds and the between-check resets use the round's own runners and are not counted). */
  let checkFailed = false;
  let round: RoundState | undefined;
  let opening: Promise<unknown> | undefined;
  let rounds = 0;
  let cumulative: TestServicesUsageRecord | undefined;
  /** A round's record could not be built: the run's record says so (nothing started, nothing checked) from then on. */
  let recordLost = false;
  const lostRecord = (): TestServicesUsageRecord => ({ ...failedStartRecord(ids, new Map(ids.map((id) => [id, "not_healthy" as const]))), ...(emulatorBase === undefined ? {} : { aws: UNREADABLE_AWS_USAGE }) });
  let redactor: ServiceRedactor = createServiceRedactor([]);

  /** One teardown step: a failure is a warning with the step's name and a redacted reason, and the next step still runs. */
  const step = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action(); } catch (error) { log({ event: "test-services.teardown.warning", step: name, reason: redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
  };
  /** A start that teardown can still find: if `dispose` comes while it is pending, the session it returns is stopped. */
  const trackedStart = (input2: Parameters<ServiceRunner["start"]>[0]): Promise<ServiceSession> => {
    const pending = runner.start(input2);
    pendingStarts.add(pending);
    void pending.then(() => undefined, () => undefined).finally(() => { pendingStarts.delete(pending); });
    return pending;
  };
  const registry = `${config.registry}/${CATALOG_REGISTRY_ROOT}/${config.catalogEnv}`;
  const startInput = (phaseRunId: string, resolved: readonly Resolved[], phaseFiles: HelperFiles, extra: Partial<Parameters<ServiceRunner["start"]>[0]>): Parameters<ServiceRunner["start"]>[0] => ({
    runId: phaseRunId, workspace, roundBudgetMs: TEST_SERVICES_RUN_LIFETIME_MS, registry, edition: config.edition, probeImage: config.probeImage, maxMemMiB: config.maxMemMiB,
    helpers: resolved.map((item) => item.request), files: phaseFiles, resetHooks: createResetHooks({ http: { files: phaseFiles, probeImage: config.probeImage } }),
    ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }), ...extra,
  });

  /**
   * How to talk to one phase's emulator: its network (name, gateway, and labels so the sweep finds a call's container), its helper, the phase's own files seam and THE PHASE'S OWN control token. The token is read from the
   * helper's request here and goes nowhere but `emulator-control.ts` (an env file for the one call).
   */
  const controlTargetOf = (item: Resolved, session: ServiceSession, phaseFiles: HelperFiles, phaseRunId: string): EmulatorControlTarget => {
    const helper = session.helpers.find((candidate) => candidate.id === item.plan.id);
    const controlToken = item.request.credentials?.controlToken;
    if (helper === undefined || controlToken === undefined) throw new EmulatorControlError("refused");
    const createdAt = now();
    const expiresAt = createdAt + servicesNetworkStaleAfterMs(TEST_SERVICES_RUN_LIFETIME_MS);
    return {
      docker, network: { name: session.network.name, gateway: session.network.gateway, labelArgs: () => runNetworkLabelArgs({ runId: phaseRunId, workspace, createdAt, expiresAt }) },
      helper, probeImage: config.probeImage, files: phaseFiles, controlToken,
    };
  };
  /**
   * The dependency as one phase seeds it. A real-software dependency is its plan's. The emulator gets a `prepare` step that runs before its seed commands, after the start and after every reset: it reads the resources the
   * project's infrastructure code declares AS THEY ARE NOW (the candidate tree) and creates them through `POST /_rovara/seed` (TS22). Fail closed: an unreadable file, a resource that is not in its strict form or an emulator that
   * does not confirm every resource is a failed seed.
   */
  const dependencyOf = (item: Resolved, session: ServiceSession, phaseFiles: HelperFiles, phaseRunId: string): ResetDependency => {
    const emulator = item.emulator;
    if (emulator === undefined) return item.resetDependency;
    return {
      ...item.resetDependency,
      prepare: async (signal) => {
        const read = await Promise.all(emulator.refs.map((ref) => readAwsResourcesFromIac({ ref, services: emulator.services, rootPath: root, repositoryPaths: input.repositoryPaths }))).catch((error: unknown) => {
          // The reason is a fixed note, never a name or a path; the run sees only the fixed seed sentence.
          if (error instanceof EmulatorSeedError && error.note !== undefined) log({ event: "test-services.seed.refused", note: error.note });
          throw error;
        });
        const unique = new Map<string, TaskAwsResource>();
        for (const resource of read.flat()) unique.set(`${resource.kind}\0${resource.name}`, resource);
        await seedEmulator({ target: { ...controlTargetOf(item, session, phaseFiles, phaseRunId), signal }, region: emulator.region, resources: [...unique.values()] });
      },
    };
  };
  /** The session as the usage record sees it: each emulated entry of the plan reports its own row (aws-s3, aws-sqs, aws-dynamodb), all of them the one emulator helper's health, start time and resets. */
  const usageViewOf = (session: Pick<ServiceSession, "helpers" | "probe">, resets: ReadonlyMap<string, number>): { session: Pick<ServiceSession, "helpers" | "probe">; resets: ReadonlyMap<string, number> } => {
    const emulator = emulatorBase?.emulator;
    if (emulator === undefined || emulatorBase === undefined) return { session, resets };
    const helperId = emulatorBase.plan.id;
    const helper = session.helpers.find((candidate) => candidate.id === helperId);
    const extra = emulator.ids.filter((id) => id !== helperId);
    if (helper === undefined) return { session, resets };
    const expanded = new Map(resets);
    for (const id of extra) expanded.set(id, resets.get(helperId) ?? 0);
    return {
      session: { helpers: [...session.helpers, ...extra.map((id) => ({ ...helper, id }))], probe: (id, limitMs) => session.probe(extra.includes(id) ? helperId : id, limitMs) },
      resets: expanded,
    };
  };

  const recordOf = async (open: RoundState): Promise<TestServicesUsageRecord | undefined> => {
    try {
      const view = usageViewOf(open.session, open.resets);
      const built = await ports.buildServiceUsageRecord({
        planned: ids, session: view.session, startMs: open.startMs, resetCounts: view.resets, failures, redactor: open.redactor, dns: { docker, dnsHelperName: open.plan.dnsHelperName },
        ...(open.ledger === undefined ? {} : { emulator: open.ledger }),
        ...(open.fakes === undefined ? {} : { fakes: open.fakes }),
      });
      const parsed = TestServicesUsageRecordSchema.safeParse(built);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  /** Ends the open round: the sealed round first (the check sandbox removed), then (when asked) its usage record while its helpers and name server still run, then everything the round made. */
  const closeRound = async (emit: boolean): Promise<void> => {
    const open = round;
    round = undefined;
    if (open === undefined) return;
    await step("sealed-round", () => open.sealedClose());
    // The working sandbox is never connected to a round's network (the sealed round only checks it is on its working-phase network); this disconnect is a safety net that finds nothing to do.
    await step("working-sandbox", () => docker.run(["network", "disconnect", "--force", open.plan.network.name, input.sandbox.name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }));
    if (emit && active) {
      const record = await recordOf(open);
      // A round whose record could not be built or parsed makes the WHOLE run's record unreadable (never dropped, never a run that looks clean on its other rounds): it stays so for the rest of the run.
      if (record === undefined) { recordLost = true; cumulative = lostRecord(); }
      else if (!recordLost) cumulative = mergeUsageRecords(cumulative, record);
      if (cumulative !== undefined && input.artifactSink !== undefined) await input.artifactSink({ name: TEST_SERVICES_USAGE_ARTIFACT, mediaType: "application/json", content: JSON.stringify(cumulative) }).catch(() => log({ event: "test-services.usage.save.failed" }));
    }
    await cleanupRound(open);
  };
  const cleanupRound = async (open: Pick<RoundState, "plan" | "session" | "files" | "dnsStarted">): Promise<void> => {
    // Safety net: the working sandbox is not on the round's network (the sealed round never connects it); if it somehow were, it leaves before the network is removed.
    await step("working-sandbox", () => docker.run(["network", "disconnect", "--force", open.plan.network.name, input.sandbox.name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }));
    if (open.dnsStarted) await step("name-server", () => docker.run(["rm", "--force", open.plan.dnsHelperName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }));
    await step("round-helpers", () => open.session.stop());
    await step("round-directory", () => removeRunDirectory(open.files.directory));
  };

  const teardown = (): Promise<void> => {
    torndown ??= (async () => {
      active = false;
      await step("opening", async () => { await opening?.catch(() => undefined); });
      await closeRound(false);
      // A start that was still pending when the run was disposed: its session is stopped as soon as it exists.
      for (const pending of [...pendingStarts]) await step("pending-start", async () => { await (await pending.catch(() => undefined))?.stop(); });
      await step("helpers", async () => { await workSession?.stop(); });
      await step("directory", () => removeRunDirectory(files.directory));
      // The worker's self-report (staging workers cannot be reached by SSM): what is left, in fixed fields, after every run ends.
      if (input.signal?.aborted === true && runOutcome === "completed") runOutcome = "cancelled";
      else if (runOutcome === "completed" && checkFailed) runOutcome = "checks_failed";
      await step("report", () => emitReport({ docker, workspace, runDirectoryParent: config.runDirectoryParent, sandboxName: input.sandbox.name, phase: "run_end", outcome: runOutcome }, log));
    })();
    return torndown;
  };

  /** Review I3: the seed files this run loaded, with the sha256 of what it loaded (the approval of a candidate check binds them). Declared before the working phase, whose seeds note into it. */
  const loadedSeedFiles: Array<{ id: string; path: string; sha256: string }> = [];
  function noteSeedFile(entry: { id: string; path: string; sha256: string }): void {
    if (loadedSeedFiles.length < 16 && !loadedSeedFiles.some((seen) => seen.id === entry.id && seen.path === entry.path && seen.sha256 === entry.sha256)) loadedSeedFiles.push(entry);
  }

  // ---- the working phase

  try {
    if (input.workingPhase === false) {
      // No working phase: the sandbox keeps its commands as they are, and `dispose()` still tears the rounds down.
      input.sandbox.attachServices({ wrapExec: (inner) => inner, teardown });
    } else {
      const working = materializeAll(bases, "working", await fetchFixtures(bases, input.fixtureDelivery, input.signal));
      const workingEnv = environmentFor("working", working);
      secrets.push(...helperSecretValues(working.map((item) => item.request)), ...workingEnv.secretValues);
      redactor = createServiceRedactor(secrets);
      // The sandbox runs every command with the run's variables from here on, and tears the run down when it is disposed, even if the start below fails.
      input.sandbox.attachServices({ wrapExec: workingExec(docker, files, input.sandbox.name, workingEnv, () => active), teardown });

      const startedAt = now();
      try {
        workSession = await trackedStart(startInput(runId, working, files, { sandboxes: workingSandboxAttachment(docker, input.sandbox.name), ...(input.signal === undefined ? {} : { signal: input.signal }) }));
      } catch (error) {
        const failure = failureOf(error);
        for (const id of ids) if (!failure.failures.has(id)) failures.set(id, failure.reason === "not_healthy" ? "not_healthy" : "start_failed");
        for (const [id, reason] of failure.failures) failures.set(id, reason);
        throw new TestServicesError(failure.reason, failures);
      }
      workStartMs = Math.max(0, now() - startedAt);
      if (!active) throw new TestServicesError("start_failed");

      // The seeds, in the working sandbox (attached, with the run's variables), one dependency at a time so a failure names its dependency.
      const seedSignal = AbortSignal.any([AbortSignal.timeout(SEED_LIMIT_MS), ...(input.signal === undefined ? [] : [input.signal])]);
      const workingSeeds: SeedPorts = seedPorts((command, signal) => executionFor(SANDBOX_TARGET, { sandbox: input.sandbox }).runCommand(command, signal),
        seedFileApplier({ docker, rootPath: root, repositoryPaths: input.repositoryPaths, items: working, helpers: workSession.helpers, log, onLoaded: noteSeedFile }), root, input.repositoryPaths);
      for (const item of working) {
        try {
          await seedRun(countResets(workSession).session, [dependencyOf(item, workSession, files, runId)], workingSeeds, seedSignal);
        } catch (error) {
          for (const id of item.emulator?.ids ?? [item.plan.id]) failures.set(id, "seed_failed");
          throw new TestServicesError(seedStartFailureOf(error), failures);
        }
      }
    }
  } catch (error) {
    runOutcome = "failed";
    await teardown();
    const failure = failureOf(error);
    log({ event: "test-services.start.failed", reason: failure.reason });
    throw failure;
  }

  // ---- one sealed round

  /** Brand-new helpers, a network of its own, a name server of its own, the sealed check sandbox, and the seeds run INSIDE it from the candidate code. */
  const startRound = async (signal: AbortSignal): Promise<RoundState> => {
    const check = (): void => { if (!active) throw new TestServicesError("start_failed"); };
    check();
    await closeRound(false);
    rounds += 1;
    const number = rounds;
    // The init files are read again from the candidate tree as it is NOW (the agent may have edited them), with the same checks as at the start.
    const current = await Promise.all(bases.map(async (base) => ({ ...base, files: await initFilesOf(base.plan, root, input.repositoryPaths) })));
    let fixtures: ReadonlyMap<string, string>;
    try {
      fixtures = await fetchFixtures(current, input.fixtureDelivery, signal);
    } catch (error) {
      for (const id of ids) failures.set(id, "start_failed");
      throw error;
    }
    const resolved = materializeAll(current, "check", fixtures);
    const environment = environmentFor("check", resolved);
    secrets.push(...helperSecretValues(resolved.map((item) => item.request)), ...environment.secretValues);
    redactor = createServiceRedactor(secrets);
    const roundRedactor = redactor;
    const roundFiles = await createRunDirectoryFiles(files.directory, `round-${String(number)}`).catch(() => { throw new TestServicesError("start_failed"); });
    const startedAt = now();
    let session: ServiceSession | undefined;
    let plan: CheckSandboxPlan | undefined;
    let dnsStarted = false;
    let closeSealed: (() => Promise<void>) | undefined;
    const partial = (): Pick<RoundState, "plan" | "session" | "files" | "dnsStarted"> | undefined => (session === undefined || plan === undefined ? undefined : { plan, session, files: roundFiles, dnsStarted });
    try {
      session = await trackedStart(startInput(`${runId}-r${String(number)}`, resolved, roundFiles, { signal }));
      check();
      const startMs = Math.max(0, now() - startedAt);
      const view = session.network;
      const slot = Number(/^172\.30\.(\d{1,3})\.0\/24$/u.exec(view.subnet)?.[1]);
      const createdAt = now();
      const expiresAt = createdAt + servicesNetworkStaleAfterMs(TEST_SERVICES_RUN_LIFETIME_MS);
      const net: CheckSandboxNetwork = {
        name: view.name, slot, subnet: view.subnet, dnsHelperIp: view.dnsHelperIp, workingSandboxIp: view.workingSandboxIp, checkSandboxIp: view.checkSandboxIp,
        labelArgs: () => runNetworkLabelArgs({ runId: `${runId}-r${String(number)}`, workspace, createdAt, expiresAt }),
      };
      const roundHelpers = session.helpers;
      plan = checkSandboxPlan({
        net, taskId: input.operationId, image: config.probeImage, guardImage: config.guardImage, rootPath: root, maskedPaths: await hiddenWorkspaceDirectories(root), filesDir: roundFiles.directory,
        helpers: roundHelpers.flatMap((helper) => helper.aliases.map((alias) => ({ alias, address: helper.address }))), sinkholeIp: runNetworkHelperIp(slot, SINKHOLE_HELPER_INDEX),
        workingSandboxName: input.sandbox.name,
      });
      await writeCheckSandboxFiles(plan);
      dnsStarted = true;
      const dns = await docker.run(plan.dnsHelperRunArgs, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      if (dns === undefined || dns.exitCode !== 0) throw new TestServicesError("setup_failed");
      // The check sandbox starts only once the name server listens: before that, every lookup in the round would fail at once, unrecorded.
      await waitForSealedDnsHelper(docker, plan.dnsHelperName, { signal, now, ...(config.sleep === undefined ? {} : { sleep: config.sleep }) }).catch(() => { throw new TestServicesError("setup_failed"); });
      check();

      // The sealed round: the working sandbox was never on this network; the check sandbox starts inside `withSealedCheckRound`.
      // The working phase's network is where the working sandbox belongs (none when the run has no working phase).
      const setup: SealedRoundSetup = { docker, hasDevcontainer: false, workingPhaseNetwork: workSession === undefined ? null : { name: workSession.network.name, ip: workSession.network.workingSandboxIp }, plan, rootPath: root, files: roundFiles, environment, redactor: roundRedactor, signal };
      let release!: () => void;
      const closed = new Promise<void>((done) => { release = done; });
      let handOver!: (runners: CheckRunners) => void;
      let failStart!: (error: unknown) => void;
      const ready = new Promise<CheckRunners>((done, fail) => { handOver = done; failStart = fail; });
      const running = ports.withSealedCheckRound(setup, async (runners) => {
        handOver(runners);
        await closed;
      });
      // A rejection before the round was handed over is the start's failure; after it, `sealedClose` reports it.
      running.then(() => undefined, (error: unknown) => failStart(error));
      closeSealed = async () => { release(); await running; };
      const runners = await ready;

      // The round's own emulator: its prepare step (the project's declared resources, created through the control API with THIS round's token) and its ledger port.
      const roundRunId = `${runId}-r${String(number)}`;
      const roundDeps = resolved.map((item) => dependencyOf(item, session!, roundFiles, roundRunId));
      const emulatorItem = resolved.find((item) => item.emulator !== undefined);
      const roundLedger = emulatorItem === undefined ? undefined : emulatorLedgerPort(controlTargetOf(emulatorItem, session, roundFiles, roundRunId));
      const countedRound = countResets(session);
      const roundFakes = resolved.flatMap((item) => (item.fake === undefined ? [] : [{ id: item.plan.id, digest: item.fake.digest }]));
      const applyFixture = seedFileApplier({ docker, rootPath: root, repositoryPaths: input.repositoryPaths, items: resolved, helpers: session.helpers, log, onLoaded: noteSeedFile });
      const state: RoundState = {
        applyFixture, number, session, counted: countedRound.session, resets: countedRound.resets, plan, files: roundFiles, redactor: roundRedactor, startMs, dnsStarted, runners, sealedClose: closeSealed,
        resetDeps: roundDeps, ledger: roundLedger, fakes: roundFakes.length === 0 ? undefined : fakeUsagePort(docker, session, roundFakes),
      };
      round = state;

      // The seeds run INSIDE the round, in the sealed sandbox, from the candidate code: the agent's own migrations are applied, and the helpers hold nothing but what the seeds made.
      const seedSignal = AbortSignal.any([AbortSignal.timeout(SEED_LIMIT_MS), signal]);
      const roundSeeds = seedPorts((command, seedsSignal) => runners.runProjectCommand(command, seedsSignal), applyFixture, root, input.repositoryPaths);
      for (const item of resolved) {
        try {
          await seedRun(state.counted, state.resetDeps.filter((dependency) => dependency.id === item.plan.id), roundSeeds, seedSignal);
        } catch (error) {
          for (const id of item.emulator?.ids ?? [item.plan.id]) failures.set(id, "seed_failed");
          throw new TestServicesError(seedStartFailureOf(error), failures);
        }
      }
      return state;
    } catch (error) {
      const failure = failureOf(error);
      if (!SEED_START_FAILURES.has(failure.reason)) for (const id of ids) failures.set(id, failure.failures.get(id) ?? (failure.reason === "not_healthy" ? "not_healthy" : "start_failed"));
      if (round === undefined || round.session !== session) {
        // Not yet recorded as the open round: this attempt's own parts are removed here.
        await step("sealed-round", async () => { await closeSealed?.(); });
        const parts = partial();
        if (parts !== undefined) await cleanupRound(parts);
        else {
          await step("round-helpers", async () => { await session?.stop(); });
          await step("round-directory", () => removeRunDirectory(roundFiles.directory));
        }
      }
      throw failure;
    }
  };
  const currentRound = (): CheckRunners => {
    const runners = round?.runners;
    if (runners === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check round is not open, so no check was run");
    return runners;
  };

  const usageRecord = async (): Promise<TestServicesUsageRecord | undefined> => {
    const record = await baseUsageRecord();
    if (record === undefined || loadedSeedFiles.length === 0) return record;
    const parsed = TestServicesUsageRecordSchema.safeParse({ ...record, seedFiles: [...loadedSeedFiles] });
    return parsed.success ? parsed.data : record;
  };
  const baseUsageRecord = async (): Promise<TestServicesUsageRecord | undefined> => {
    if (!active) return undefined;
    if (round !== undefined) {
      if (recordLost) return cumulative;
      const live = await recordOf(round);
      return live === undefined ? lostRecord() : mergeUsageRecords(cumulative, live);
    }
    if (cumulative !== undefined) return cumulative;
    // No round has run: the working phase's own answer, with whatever failed since. A run with no working phase whose first round could not start says what failed (a record of facts, not a guess).
    if (workSession === undefined) {
      if (failures.size === 0) return undefined;
      return { schemaVersion: 1, dependencies: ids.map((id) => ({ id, started: false, healthy: false, startMs: 0, resetCount: 0, failure: failures.get(id) ?? "start_failed" })), unknownCalls: { domains: [], otherCount: 0 } };
    }
    try {
      const built = await ports.buildServiceUsageRecord({ planned: ids, session: usageViewOf(workSession, new Map()).session, startMs: workStartMs, failures, redactor });
      const parsed = TestServicesUsageRecordSchema.safeParse(built);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const run: TestServicesRun = {
    ids,
    checkRunners() {
      return {
        runProjectCommand: async (command, signal) => {
          const result = await currentRound().runProjectCommand(command, signal);
          if (result.exitCode !== 0 || result.timedOut) checkFailed = true;
          return result;
        },
        runAgentCommand: async (replay, timeoutMs, signal) => {
          const result = await currentRound().runAgentCommand(replay, timeoutMs, signal);
          if (result.exitCode !== 0 || result.timedOut) checkFailed = true;
          return result;
        },
        async freshServices(signal) {
          opening = startRound(signal);
          await opening;
        },
        async resetBetweenChecks(signal) {
          const open = round;
          if (open === undefined || open.runners === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check round is not open, so no check was run");
          const runners = open.runners;
          try {
            await resetForNextCheck(open.counted, open.resetDeps, seedPorts((command, seedsSignal) => runners.runProjectCommand(command, seedsSignal), open.applyFixture, root, input.repositoryPaths), signal);
          } catch (error) {
            for (const id of ids) failures.set(id, "reset_failed");
            throw error;
          }
        },
        async endRound() {
          await closeRound(true);
        },
      };
    },
    usageRecord,
    dispose: teardown,
  };
  return run;
}

function materializeAll(bases: readonly Base[], phase: "working" | "check", fixtures: ReadonlyMap<string, string>): Resolved[] {
  return bases.map((base) => materialize(base, phase, fixtures));
}

/** The start failures that are a seed's (the dependency started; its seeds did not complete), each with its own message. */
const SEED_START_FAILURES: ReadonlySet<string> = new Set(["seed_failed", "seed_changed", "seed_meta_command", "seed_program", "seed_not_allowed"]);
/** The start failure a seed error is told as: a file seed's own reason, or the generic one. */
function seedStartFailureOf(error: unknown): "seed_failed" | "seed_changed" | "seed_meta_command" | "seed_program" | "seed_not_allowed" {
  const reason = error instanceof SeedError ? error.reason : undefined;
  return reason === "seed_changed" || reason === "seed_meta_command" || reason === "seed_program" || reason === "seed_not_allowed" ? reason : "seed_failed";
}

/** The seeds' ports: a command runs where the caller says; a seed FILE is loaded by `applyFixture` (TS-UX-1 item 9, `service-seed-file.ts`), which the caller binds to the phase's own helpers. */
function seedPorts(runCommand: (command: Parameters<SeedPorts["runCommand"]>[0], signal: AbortSignal) => Promise<{ exitCode: number | null; timedOut?: boolean | undefined }>, applyFixture: SeedPorts["applyFixture"], rootPath: string, repositoryPaths: readonly string[]): SeedPorts {
  return {
    runCommand: async (command, signal) => {
      const result = await runCommand(command, signal);
      return { exitCode: result.exitCode, timedOut: result.timedOut === true };
    },
    applyFixture,
    // SEED-RISK-1: a locked seed's script is hashed again from the workspace (the candidate tree as it is now) before each run; a difference refuses it.
    lockHolds: (command, lock) => seedLockHoldsInCheckout(rootPath, repositoryPaths, command, lock),
  };
}

/**
 * TS-UX-1 item 9: loads a dependency's seed file into THIS phase's helper (the working phase's, or a sealed round's own): the file is read from the repositories as they are now (the candidate tree), with every
 * containment and size rule of `readSeedFile`, and loaded by the database's own client inside its container (`loadSeedFile`). A dependency this phase does not have, or one with no started helper, is refused.
 * A refusal is logged as its fixed reason only (never a path or a name); the run sees the seeds' fixed sentence.
 */
export function seedFileApplier(input: {
  docker: Pick<DockerCli, "execBytes" | "run">; rootPath: string; repositoryPaths: readonly string[]; items: ReadonlyArray<Pick<Resolved, "plan" | "request">>; helpers: ReadonlyArray<{ id: string; container: string }>;
  log?: (entry: { event: string; reason: string }) => void;
  /** Review I3: told the sha256 of each file loaded (the usage record carries it, so an approval can bind it). */
  onLoaded?: (entry: { id: string; path: string; sha256: string }) => void;
  fdPath?: (fd: number) => Promise<string | undefined>;
}): SeedPorts["applyFixture"] {
  return async (dependencyId, seed, signal) => {
    try {
      const item = input.items.find((candidate) => candidate.plan.id === dependencyId);
      const helper = input.helpers.find((candidate) => candidate.id === dependencyId);
      if (item === undefined || helper === undefined) throw new SeedFileError("unsupported");
      const bytes = await readSeedFile({ rootPath: input.rootPath, repositoryPaths: input.repositoryPaths, hiddenPaths: await hiddenWorkspaceDirectories(input.rootPath), fixturePath: seed.fixturePath, family: item.plan.family, ...(input.fdPath === undefined ? {} : { fdPath: input.fdPath }) });
      // Review I3 (SEED-FILE-LOCK): a plan of an approved environment names the content its approval bound; a file that differs (in the checkout or the candidate tree) is not loaded, and the run asks for a new approval.
      const sha256 = seedFileDigest(bytes);
      if (seed.sha256 !== undefined && seed.sha256 !== sha256) throw new SeedFileError("changed");
      await loadSeedFile(input.docker, { container: helper.container, family: item.plan.family, user: item.request.credentials?.user, database: item.request.credentials?.database }, bytes, signal);
      input.onLoaded?.({ id: dependencyId, path: seed.fixturePath, sha256 });
    } catch (error) {
      input.log?.({ event: "test-services.seed-file.refused", reason: error instanceof SeedFileError ? error.reason : "load_failed" });
      throw error;
    }
  };
}

// ---- what run-task calls

export interface StartTaskTestServicesInput {
  plan: TestEnvTaskPlan | undefined;
  mode: string | undefined;
  /** The task's working sandbox, started; undefined for a task in a dev container or on the local shell (refused: no sandbox, no services). */
  sandbox: TaskSandbox | undefined;
  /** The task runs in a dev container (refused with the fixed "not available yet" sentence, before anything else). */
  devcontainer: boolean;
  /** The invocation is a nightly run: refused with a fixed "not available yet" (the nightly with dependencies is TS31, later). */
  nightly: boolean;
  operationId: string;
  rootPath: string;
  /** The repositories' folders (absolute): init files come only from under them. */
  repositoryPaths: readonly string[];
  config?: TestServicesConfig | undefined;
  artifactSink: ArtifactSink;
  /** The worker's cancellation controller: a cancel while the services start stops the pulls, the helper starts and the seeds. */
  cancellation?: Pick<WorkerCancellationController, "register"> | undefined;
  /** Slice 3: the run's `fixture-set` callback (callback-client.ts), for a plan with a fake. */
  fixtureSet?: FixtureSetCallback | undefined;
}

/**
 * The one call run-task makes after the working sandbox has started. Returns undefined, having done nothing at all (no Docker call, no file), when the task's plan has no dependencies, or the step does not run code.
 * Otherwise starts the run or throws one fixed-sentence error (the task then fails before the agent runs, as a sandbox that cannot start does). A plan with dependencies on a task with no sandbox, on a dev container or
 * in a nightly run is refused.
 */
export async function startTaskTestServices(input: StartTaskTestServicesInput): Promise<TestServicesRun | undefined> {
  const dependencies = input.plan?.dependencies;
  if (dependencies === undefined) return undefined;
  const refuse = (reason: TestServicesFailureReason): never => { throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES[reason]); };
  if (input.nightly) return refuse("nightly");
  if (!MODES_WITH_SERVICES.has(input.mode)) return undefined;
  refuseTestServicesWithDevcontainer({ dependencies, devcontainer: input.devcontainer });
  if (input.sandbox === undefined) return refuse("unsupported");
  const config = input.config ?? testServicesConfigFromEnvironment();
  if (config === undefined) return refuse("not_configured");
  // A cancel that arrives while the services start stops the start. The registration ends before the task registers its own.
  const stop = new AbortController();
  const unregister = input.cancellation?.register(input.operationId, { abort: () => { stop.abort(); return Promise.resolve(); } });
  try {
    return await startTestServicesRun(config, {
      dependencies, operationId: input.operationId, rootPath: input.rootPath, repositoryPaths: input.repositoryPaths, sandbox: input.sandbox, hasDevcontainer: input.devcontainer,
      artifactSink: input.artifactSink, signal: stop.signal,
      ...(input.fixtureSet === undefined ? {} : { fixtureDelivery: createFixtureDelivery(input.fixtureSet) }),
      // A CHECKS run has no agent and no use for a working-phase Postgres: only the sealed rounds start services (H3).
      workingPhase: input.mode !== "CHECKS",
    });
  } catch (error) {
    const failure = failureOf(error);
    throw agentXError("RUNTIME_UNAVAILABLE", failure.message);
  } finally {
    unregister?.();
  }
}

/** The features this worker adds to /ping for test services: the plan feature only when the worker has a test-services configuration (a worker without one would only refuse such a plan). */
export function testServicesAdvertisedFeatures(environment: NodeJS.ProcessEnv = process.env, shipped: ShippedCatalogFiles = SHIPPED_CATALOG_FILES): Array<typeof TEST_SERVICES_PLAN_FEATURE | typeof TEST_SERVICES_AWS_PLAN_FEATURE | typeof TEST_SERVICES_FAKE_PLAN_FEATURE | typeof TEST_SERVICES_FILE_SEED_FEATURE | typeof TEST_SERVICES_SEED_LOCK_FEATURE> {
  if (testServicesConfigFromEnvironment(environment, undefined, undefined) === undefined) return [];
  if (notPulledRepositories(environment) === "all") return [];
  // Slice 3: a worker whose image carries the catalog's fake server (a helper that runs from the worker's own image) can run a plan with a fake; it needs no image pulled.
  // TS-UX-1 item 9: every worker with test services loads a seed file (service-seed-file.ts). SEED-RISK-1: and checks a locked seed command's script before it runs it (service-seed-lock.ts).
  const features: Array<typeof TEST_SERVICES_PLAN_FEATURE | typeof TEST_SERVICES_AWS_PLAN_FEATURE | typeof TEST_SERVICES_FAKE_PLAN_FEATURE | typeof TEST_SERVICES_FILE_SEED_FEATURE | typeof TEST_SERVICES_SEED_LOCK_FEATURE> = [TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_FILE_SEED_FEATURE, TEST_SERVICES_SEED_LOCK_FEATURE];
  if (emulatorImagePrepulled(shipped, environment)) features.push(TEST_SERVICES_AWS_PLAN_FEATURE);
  if (fakeServerBaked(shipped)) features.push(TEST_SERVICES_FAKE_PLAN_FEATURE);
  return features;
}

/** Whether the catalog baked into this worker image holds the fake server as a worker-image helper that is offered (any edition) and not retired. Read synchronously from the image's own file; any problem is false. */
export function fakeServerBaked(shipped: ShippedCatalogFiles = SHIPPED_CATALOG_FILES): boolean {
  try {
    const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(shipped.catalog, "utf8")));
    return catalog.entries.some((entry) => entry.backing === "fake" && entry.family === "fake-server" && entry.workerImage === true && entry.status !== "retired");
  } catch {
    return false;
  }
}

/** The two files the worker image ships beside `dist/`: the pinned catalog and the list root pulled at boot. */
export interface ShippedCatalogFiles { catalog: URL | string; prepull: URL | string }
export const SHIPPED_CATALOG_FILES: ShippedCatalogFiles = { catalog: BAKED_CATALOG_URL, prepull: new URL("../service-catalog/prepull.json", import.meta.url) };

/**
 * Root's note of the catalog repositories that did NOT pre-pull at boot (boot-stage2.sh): a comma list of `svc/<name>`, or `all`. FAIL CLOSED: `all`, and any non-empty value that is not a well-formed list (a value that cannot be
 * read cannot be trusted to name what is missing), mean every image counts as not pulled and no test-services feature is offered. Absent or empty means nothing is missing.
 */
export const TEST_SERVICES_NOT_PULLED_ENVIRONMENT = "AGENTX_TEST_SERVICES_NOT_PULLED";
export function notPulledRepositories(environment: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | "all" {
  const value = environment[TEST_SERVICES_NOT_PULLED_ENVIRONMENT];
  if (value === undefined || value === "") return new Set();
  if (!/^svc\/[a-z0-9][a-z0-9._-]{0,62}(,svc\/[a-z0-9][a-z0-9._-]{0,62}){0,15}$/u.test(value)) return "all";
  return new Set(value.split(","));
}

/** The emulator image the shipped files pin and list, read from the image's own (immutable) files ONCE per path pair: /ping asks on every call and must not read two files each time. Tests clear it with `forgetEmulatorImageCache`. */
const emulatorImageCache = new Map<string, { repository: string } | undefined>();
export function forgetEmulatorImageCache(): void { emulatorImageCache.clear(); }
function shippedEmulatorImage(shipped: ShippedCatalogFiles): { repository: string } | undefined {
  const key = `${String(shipped.catalog)}\n${String(shipped.prepull)}`;
  if (emulatorImageCache.has(key)) return emulatorImageCache.get(key);
  let found: { repository: string } | undefined;
  try {
    const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(shipped.catalog, "utf8")));
    const list = PrepullListSchema.parse(JSON.parse(readFileSync(shipped.prepull, "utf8")));
    const entry = catalog.entries.find((item) => item.backing === "emulated" && item.family === "local-aws" && item.status !== "retired" && item.image.digest !== undefined
      && list.images.some((image) => image.repository === item.image.repository && image.digest === item.image.digest));
    found = entry === undefined ? undefined : { repository: entry.image.repository };
  } catch {
    found = undefined;
  }
  emulatorImageCache.set(key, found);
  return found;
}

/**
 * Whether this worker can run an emulated (Rovara local AWS) plan: the catalog baked into its image pins a `local-aws` entry, root's boot pre-pull list holds exactly that digest, AND root did not report that image as not
 * pulled (per image: one image failing to pre-pull takes only itself out). Read from the image's own files (cached) and the environment; never a Docker call per ping; any problem is false.
 */
export function emulatorImagePrepulled(shipped: ShippedCatalogFiles = SHIPPED_CATALOG_FILES, environment: NodeJS.ProcessEnv = process.env): boolean {
  const image = shippedEmulatorImage(shipped);
  const missing = notPulledRepositories(environment);
  return image !== undefined && missing !== "all" && !missing.has(image.repository);
}

// ---- the candidate check (Prove, worker side): prepare.ts

/** What a candidate check's preparation is given besides the project: the plan's dependencies (pinned, from the broker), which readiness commands are test checks, and where the usage record goes. */
export interface PrepareTestServices {
  dependencies: readonly TaskDependencyPlan[];
  /** The indexes of the readiness commands that are test checks and run SEALED (each in a round of its own, on fresh helpers). Absent: every readiness command. The others run in the working sandbox, with the run's variables. */
  testChecks?: readonly number[];
  config?: TestServicesConfig;
  /** The invocation's operation id and the worker's cancellation controller: a cancel of the operation stops the start and the sealed rounds (the registration ends with `finish`). Absent: not cancellable, as a preparation is today. */
  operationId?: string;
  cancellation?: Pick<WorkerCancellationController, "register">;
  /** Receives the usage record once, after the readiness commands and before the services stop (also when the start failed: then every dependency is `started: false` with its fixed failure). */
  onUsageRecord?(record: TestServicesUsageRecord): void | Promise<void>;
  /** Slice 3: the preparation's `fixture-set` callback, for a plan with a fake. */
  fixtureSet?: FixtureSetCallback;
}

type ReadinessRunner = (command: Parameters<SeedPorts["runCommand"]>[0], index: number, rootPath: string) => Promise<CommandResult>;

export interface PrepareServices {
  /** The readiness runner for the preparation: a test check runs sealed, anything else as `inner` runs it. */
  sealedReadiness(inner: ReadinessRunner): ReadinessRunner;
  /** Hands the usage record on (once). Never throws. The services stop when the preparation's sandbox is disposed. */
  finish(): Promise<void>;
}

function failedStartRecord(ids: readonly string[], failures: ReadonlyMap<string, TestServicesStartFailure>): TestServicesUsageRecord {
  return { schemaVersion: 1, dependencies: ids.map((id) => ({ id, started: false, healthy: false, startMs: 0, resetCount: 0, failure: failures.get(id) ?? "start_failed" })), unknownCalls: { domains: [], otherCount: 0 } };
}

/**
 * Called by `prepareWorkspace` after the repositories are in place and before the setup commands. Does nothing (undefined) for a preparation with no `testServices`. Otherwise starts the dependencies for the preparation's
 * sandbox (setup and readiness commands then run with the run's variables, and a test check runs sealed); a dev container is refused first, a start that fails reports a failed-start record and throws a fixed sentence
 * (the preparation then fails and removes everything). The sandbox's `dispose()` (prepare's `finally`) tears the run down on every exit path.
 */
export async function startPrepareTestServices(input: { options: PrepareTestServices | undefined; sandbox: TaskSandbox | undefined; devcontainer: boolean; operationId: string; rootPath: string; repositoryPaths: readonly string[] }): Promise<PrepareServices | undefined> {
  const options = input.options;
  if (options === undefined) return undefined;
  refuseTestServicesWithDevcontainer({ dependencies: options.dependencies, devcontainer: input.devcontainer });
  const ids = options.dependencies.map((dependency) => dependency.id);
  const report = async (failures: ReadonlyMap<string, TestServicesStartFailure>): Promise<void> => { await Promise.resolve(options.onUsageRecord?.(failedStartRecord(ids, failures))).catch(() => undefined); };
  const refuse = async (reason: TestServicesFailureReason): Promise<never> => { await report(new Map()); throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES[reason]); };
  if (input.sandbox === undefined) return refuse("unsupported");
  const config = options.config ?? testServicesConfigFromEnvironment();
  if (config === undefined) return refuse("not_configured");
  // A cancel of the operation stops the start and every round. The registration ends when the preparation's services are finished with (`finish`) or the start fails.
  const stop = new AbortController();
  let unregister: (() => void) | undefined;
  if (options.cancellation !== undefined && options.operationId !== undefined) {
    try { unregister = options.cancellation.register(options.operationId, { abort: () => { stop.abort(); return Promise.resolve(); } }); } catch { unregister = undefined; }
  }
  let run: TestServicesRun;
  try {
    await input.sandbox.start();
    run = await startTestServicesRun(config, { dependencies: options.dependencies, operationId: input.operationId, rootPath: input.rootPath, sandbox: input.sandbox, hasDevcontainer: false, repositoryPaths: input.repositoryPaths, signal: stop.signal, workingPhase: false, ...(options.fixtureSet === undefined ? {} : { fixtureDelivery: createFixtureDelivery(options.fixtureSet) }) });
  } catch (error) {
    unregister?.();
    const failure = failureOf(error);
    await report(failure.failures);
    throw agentXError("RUNTIME_UNAVAILABLE", failure.message);
  }
  let finished = false;
  const unusedBase: CheckRunners = {
    runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners run no check")),
    runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners run no check")),
  };
  return {
    sealedReadiness(inner) {
      return async (command, index, rootPath) => {
        if (options.testChecks !== undefined && !options.testChecks.includes(index)) return inner(command, index, rootPath);
        const runners = run.checkRunners(unusedBase);
        const signal = stop.signal;
        try {
          try {
            await runners.freshServices?.(signal);
          } catch {
            return { exitCode: -1, stdout: "", stderr: "AgentX did not run this check: the test services could not be put back as they were seeded." };
          }
          const result = await runners.runProjectCommand(command, signal);
          return { exitCode: result.exitCode ?? -1, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
        } finally {
          await runners.endRound?.().catch(() => undefined);
        }
      };
    },
    async finish() {
      if (finished) return;
      finished = true;
      unregister?.();
      const record = await run.usageRecord().catch(() => undefined);
      if (record !== undefined) await Promise.resolve(options.onUsageRecord?.(record)).catch(() => undefined);
    },
  };
}

/**
 * Collects the usage record a candidate check's preparation reports, and answers the fields to add to the prepare result: the record under the contract's key `testServicesUsage` (the broker reads it and validates it with
 * `TestServicesUsageRecordSchema`), or nothing when no record was reported (no plan, or the preparation failed, which has no result). main.ts holds one per prepare invocation.
 */
export function collectTestServicesUsage(): { collect: (record: TestServicesUsageRecord) => void; result: () => Record<string, TestServicesUsageRecord> } {
  let collected: TestServicesUsageRecord | undefined;
  return {
    collect: (record) => { collected = record; },
    result: () => (collected === undefined ? {} : { [TEST_SERVICES_USAGE_RESULT_KEY]: collected }),
  };
}
