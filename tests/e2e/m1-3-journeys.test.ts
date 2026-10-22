import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  E2EApplicationPlanIntentSchema, E2EPolicySchema, WorkerInvocationSchema, createCandidateManifest, canonicalJson, e2eAnonymousRuntimeAccountRef, e2eApiSchemaComponentId, isSafeE2ESourcePath,
  readE2EApplicationProjectContract, workflowSendBackOffered, workspaceSessionKey, type E2EScenario, type E2ESourceSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { accountRegistryEntriesFromRows, latestAccountRef } from "../../packages/broker/src/e2e/application-account-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { createDispatcherHandler, createWorkflowE2EReadinessCompleter, createWorkflowE2EReadinessValidator } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerCli } from "@agentx/verifier";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { workflowE2EApplicationHostDeps, type WorkflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { call } from "../support/slack-broker.js";
import { collectOnThisHost } from "../support/linux-web-api-probes.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import type { binding as projectBinding} from "../support/e2e-application-plan-fixtures.js";
import { PROFILE, shaCanonical, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { ACCOUNTS_APP_FILES, ACCOUNTS_FIXTURE_ROOT, webAccountScenarios } from "../support/e2e-accounts-fixture.js";
import { INFERRED_APP_FILES, INFERRED_FIXTURE_ROOT, anonymousWebScenarios } from "../support/e2e-inferred-fixture.js";

// M1.3 native journeys. Each case is a whole path of an application round on a real Docker host, gated like `m1-web-journey.test.ts`: it needs Docker and the executor image, so it runs
// where the CI `linux-runtime` job provides them (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE) and skips cleanly everywhere else. Locally, colima's Docker works too
// (DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock), with TMPDIR and CONTAINED_FOUNDATION_EVIDENCE_DIR under the home folder, because the run directories are shared with the VM.
const dockerReady = process.env.ROVARA_DOCKER === "1";
/** The process Docker CLI, with each command's arguments shown to `observe` just before it runs. */
const observed = (cli: DockerCli, observe: ((args: string[]) => void) | undefined): DockerCli => (observe === undefined ? cli : { run: (args, opts) => { observe(args); return cli.run(args, opts); } });
const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/e2e-web-api-app");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** The collector compares the toolchain the executor reported (a Linux Node) with the process reading the result; a Mac differs in platform as well as path, a CI runner only in path. */
const collectLikeTheWorker: typeof collectOnThisHost = (input) => {
  if (process.platform === "linux") return collectOnThisHost(input);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: input.actual.runnerToolchain.platform });
  try { return collectOnThisHost(input); } finally { Object.defineProperty(process, "platform", platform); }
};

/** The files of the fixture app a candidate carries: the app itself, and the inventory service's OpenAPI document and mock fixture that the project approves. */
const APP_FILES = ["package.json", "server.mjs", "public", "fixtures", "defects", "inventory", "e2e"];
/** The fixture app with one of its fixed defect records as its default, as a coder's candidate carries a defect: in its source. */
const DEFECT_HOOK = "const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE);";
const withDefaultDefect = (name: "dependency-route" | "extra-order") => (server: string) => {
  if (!server.includes(DEFECT_HOOK)) throw new Error("the fixture's defect hook moved; update the journey's candidates");
  return server.replace(DEFECT_HOOK, `const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE) ?? JSON.parse(readFileSync(join(root, "defects/${name}.json"), "utf8"));`);
};
/**
 * The viewer's refused export answers 401 instead of 403: the fixture's own `viewer-access` defect would let the viewer download a file that no assertion of a refusal references
 * (the collector rightly calls that round incomplete), but a different refusal status fails the viewer's `text` assertion cleanly, with no download.
 */
const VIEWER_REFUSAL = 'if (account.role !== "owner" && !viewerBypass) return json(403, { error: "owner role required" });';
const withViewerRefusedAs401 = (server: string) => {
  if (!server.includes(VIEWER_REFUSAL)) throw new Error("the fixture's viewer refusal moved; update the journey's candidates");
  return server.replace(VIEWER_REFUSAL, VIEWER_REFUSAL.replace("json(403", "json(401"));
};
/** Every spelling an encoder could leave of a secret: as is, base64 and base64url, percent-encoded, hex (either case), and JSON-escaped. */
const spellingsOf = (secret: string) => [["as is", secret], ["base64", Buffer.from(secret).toString("base64")], ["base64url", Buffer.from(secret).toString("base64url")],
  ["percent-encoded", encodeURIComponent(secret)], ["hex", Buffer.from(secret).toString("hex")], ["HEX", Buffer.from(secret).toString("hex").toUpperCase()], ["JSON", JSON.stringify(secret).slice(1, -1)]] as const;
/**
 * The plan file the host mounts into the executor holds the run's accounts, passwords included. The arguments of the executor's `docker run` name it (`-v <host path>:/run/rovara/plan.json:ro`),
 * and the host wrote it before it ran the command: the passwords are read from it at that moment, by the journey and not by the code under test, so the journey has an oracle of its own.
 */
const PLAN_MOUNT_SUFFIX = ":/run/rovara/plan.json:ro";
const seededPasswordsOf = (args: string[]): string[] => {
  const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(PLAN_MOUNT_SUFFIX));
  if (mount === undefined) return [];
  const plan = JSON.parse(readFileSync(mount.slice(0, -PLAN_MOUNT_SUFFIX.length), "utf8")) as { accounts?: Array<{ password?: unknown }> };
  return (plan.accounts ?? []).flatMap((account) => (typeof account.password === "string" && account.password.length > 0 ? [account.password] : []));
};
/** A candidate that copies the password of the last sign-in into the first row of the owner's export: a bare credential value in an asserted observation. */
const SIGN_IN_FAILURE = 'if (!matches) return json(401, { error: "invalid credentials" });';
const OWNER_ROWS = "let rows = orders.orders.filter((item) => item.tenantId === account.tenantId);";
const withPasswordEchoedIntoExport = (server: string) => {
  if (!server.includes(SIGN_IN_FAILURE) || !server.includes(OWNER_ROWS)) throw new Error("the fixture's sign-in or export moved; update the journey's candidates");
  return server.replace(SIGN_IN_FAILURE, `${SIGN_IN_FAILURE} globalThis.lastSignInPassword = body.password;`)
    .replace(OWNER_ROWS, "let rows = orders.orders.filter((item) => item.tenantId === account.tenantId).map((item, index) => (index === 0 && globalThis.lastSignInPassword ? { ...item, customer: globalThis.lastSignInPassword } : item));");
};
async function stageCandidate(root: string, name: string, edit?: (server: string) => string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const file of APP_FILES) await cp(join(FIXTURE_ROOT, file), join(dir, file), { recursive: true });
  if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
  return dir;
}

type PlanningContext = Extract<ReturnType<typeof buildFeatureE2EPlanningContext>, { status: "available" }>;
/** What a journey varies: the fixture app whose files the repository holds, the task, and the plan the planner writes for it. */
type JourneyInput = Readonly<{ fixtureRoot: string; planningFiles: readonly string[]; instructions: string;
  /** Called with the arguments of every docker command the worker's host issues, just before it runs (a test reads what a mount holds at that moment). */
  observeDocker?: (args: string[]) => void;
  /**
   * The baseline round (owner decision D2). Absent: the project is registered with it switched off (`developerTasks.e2eBaselineRound: false`), because the round is on by default and runs
   * right after the coding run as the first CHECKS operation, so a journey that counts rounds, or whose base commit holds no app, would see it as its round 1. Present: the project keeps it
   * on, and `stageBase` stages the app as the task starts (the unchanged code the baseline runs).
   */
  baseline?: { stageBase(root: string): Promise<string> };
  plan(context: PlanningContext): { title: string; claims: Array<{ id: string; text: string }>; plannerIntent: object } | Promise<{ title: string; claims: Array<{ id: string; text: string }>; plannerIntent: object }> }>;

describe.runIf(dockerReady)("M1.3 native journeys", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }, 120_000);

  /**
   * Everything the journeys share, up to a planned and approved task waiting for its coder: a repository with the app's project contract (and whatever else setup approval reads), the broker
   * with the project registered and its setup approved on the qualified web profile, a task whose plan is the one `input.plan` writes from the planning context, and the worker (the real task
   * runner behind the real server, delivery and callbacks; only the model transport is scripted). It hands back the closures that drive an operation through the ordinary route.
   */
  async function startJourney(journeyInput: JourneyInput) {
    const input = journeyInput;
    const base = await realpath(process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR ?? tmpdir());
    const root = await mkdtemp(join(await realpath(tmpdir()), "m1-3-journey-"));
    roots.push(root);
    const runBase = await mkdtemp(join(base, "m1-3-journey-runs-"));
    roots.push(runBase);
    const runRoot = join(runBase, "runs");
    await mkdir(runRoot, { mode: 0o700 });

    // The repository the project is about: one commit holding the app's project contract and the inventory service's OpenAPI document and mock fixture, which setup approval reads.
    const workerWorkspace = join(root, "worker-workspace");
    const repository = join(workerWorkspace, "repo", "demo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    const planningFiles = [...input.planningFiles];
    // A journey that runs the baseline round (owner decision D2) starts from the whole app as the task starts, with its defects: that is the unchanged code the baseline runs. The others
    // start from the project contract alone, and say so to the broker by switching the baseline off (below), so each proves what it was written for.
    const baseApp = input.baseline === undefined ? undefined : await input.baseline.stageBase(root);
    if (baseApp !== undefined) await cp(baseApp, repository, { recursive: true });
    else for (const file of planningFiles) { await mkdir(join(repository, file, ".."), { recursive: true }); await cp(join(input.fixtureRoot, file), join(repository, file)); }
    git(repository, "add", ...(baseApp === undefined ? planningFiles : ["-A"]));
    git(repository, "commit", "--quiet", "-m", baseApp === undefined ? "project contract and what setup approval reads" : "the app as the task starts");
    git(repository, "remote", "add", "origin", "https://github.com/example/demo.git");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
    const treeFiles = baseApp === undefined ? [...planningFiles].sort() : git(repository, "ls-files").split("\n").filter((path) => path !== "").sort();
    const sources = await Promise.all(treeFiles.filter((path) => isSafeE2ESourcePath(path)).map(async (path) => { const bytes = await readFile(join(repository, path));
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes, kind: "blob" as const }; }));
    const snapshot: E2ESourceSnapshot = { candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: baseCommit, treeSha: baseTree }]), commitSha: baseCommit, treeSha: baseTree,
      treeComplete: true, treePaths: treeFiles, sources };

    // The broker, with the project registered and its setup approved on the qualified web profile (one admin proposal, approval and registration, as `agentx admin` makes them).
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture: async () => snapshot }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const runtimeBinding = projectRow().runtimeBinding as typeof projectBinding;
    const webRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    const runner = JSON.parse(docker("run", "--rm", "--entrypoint", "node", EXECUTOR_IMAGE, "-p",
      "JSON.stringify({ os: process.platform + ' ' + require('os').release(), arch: process.arch, runtime: 'node ' + process.version, execPath: process.execPath, version: process.version, platform: process.platform })")) as
      { os: string; arch: string; runtime: string; execPath: string; version: "v22.23.2"; platform: string };
    const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: runner.os, arch: runner.arch, runtime: runner.runtime };
    const runnerToolchain = { execPath: runner.execPath, version: runner.version, platform: runner.platform, arch: runner.arch };
    harness.db.set({ ...webRowKey, ...webApiRow("web", { runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain) }),
      binding: runtimeBinding, bindingDigest: shaCanonical(runtimeBinding) });
    const admin = { subject: "admin-subject", admin: true };
    const proposalResponse = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposalResponse.status, JSON.stringify(proposalResponse.body)).toBe(200);
    const proposalRef = String(proposalResponse.body.proposalRef);
    const proposalSha256 = String(proposalResponse.body.proposalSha256);
    const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const definition = projectRow().definition as Record<string, unknown> & { revision: number };
    const registration = await call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy,
        ...(input.baseline === undefined ? { developerTasks: { ...((definition as { developerTasks?: object }).developerTasks ?? {}), e2eBaselineRound: false } } : {}) },
      runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const policy = E2EPolicySchema.parse(proposalResponse.body.policy);

    // Plan and approve one web scenario for the owner account: open the page, ask for the stock status of an order, and the page must show what the inventory service says.
    const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: input.instructions, client: "m1-3-journeys", workflow: true, workflowPath: "QUICK" });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const taskId = String((start.body.task as { taskId: string }).taskId);
    const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const workspaceId = String((harness.db.get(taskKey.pk, taskKey.sk) as { workspaceId: string }).workspaceId);
    const operationRows = (match: (row: Record<string, unknown>) => boolean) => harness.db.find((row) => row.pk === `WORKSPACE#${workspaceId}` && row.entityType === "OPERATION" && match(row));
    const preparation = operationRows((row) => row.kind === "prepare")[0]!;
    await harness.finish(workspaceId, String(preparation.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } });
    const planning = operationRows((row) => row.workflowMode === "PLAN")[0]!;
    const readyWeb = { kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
      supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions };
    // The accounts the setup approval registered, as the broker shows them to the planner: a plan's account references are the registry's (Task 3.1).
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [readyWeb],
      accountRegistry: accountRegistryEntriesFromRows("payments", harness.db.find((row) => row.pk === "PROJECT#payments")) });
    if (context.status !== "available") throw new Error(context.reason);
    const planned = await input.plan(context);
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ title: planned.title, claims: planned.claims, e2e: planned.plannerIntent as never })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflowNow = () => (harness.db.get(taskKey.pk, taskKey.sk) as { workflow: { revision: number; stage: string; state: string; blockReason?: string; artifacts: Array<{ sha256: string }>;
      candidate?: { digest: string }; e2e?: Record<string, unknown> } }).workflow;
    const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, decision: "APPROVE",
      reason: "Approve the exact browser scenario", artifactDigest: workflowNow().artifacts.at(-1)!.sha256 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(workflowNow()).toMatchObject({ stage: "IMPLEMENT" });

    // The worker: the real task runner behind the real server, delivery and callbacks. Only the model transport is scripted (it is untrusted by design).
    const workerKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const journal = new OperationJournal(join(root, "worker-journal"));
    const evidenceRoot = join(root, "worker-evidence");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(join(workerWorkspace, ".agentx"), { recursive: true, mode: 0o700 });
    const workerFetch: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const response = await call(harness.handler, { method: init?.method ?? "GET", path: parsed.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(body === undefined ? {} : { body }) });
      if (response.status >= 400) throw new Error(`worker callback ${parsed.pathname} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const sinksFor = (invocation: WorkerInvocation) => createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: workerFetch });
    const { modelRuntime, faux } = await fauxModelRuntime();
    /** The runs this journey started, by the labels its host put on their resources: another session's runs on the same Docker are none of this journey's business. */
    const seenRuns = new Set<string>();
    // The host's own credential scan (it holds the run's passwords, which nothing else does), kept to ask it about what the broker stored once the run is over.
    let hostCredentialScan: ((bytes: Uint8Array) => boolean) | undefined;
    // What the run's raw output showed of an echoed credential, read before the host handed anything out (the run directory is read in place; nothing in it is changed).
    let withheldCredential: { carriedCredential: boolean; executorRefusal: boolean } | undefined;
    // What the executor leaves when it withholds a credential: it refuses to record evidence that carries one, and its last scan removes any output file that does (it then ends the run
    // with exit code 2 and reason "credential-leak", and writes this log line).
    const EXECUTOR_REFUSAL = "evidence contains an account credential and cannot be stored";
    const EXECUTOR_REMOVED_FILE = "removed an output file that carried an account credential";
    const executorWithheld = (bytes: Buffer) => bytes.includes(EXECUTOR_REFUSAL) || bytes.includes(EXECUTOR_REMOVED_FILE) || /"reason":\s*"credential-leak"/u.test(bytes.toString("utf8"));
    const scanOutput = async (directory: string, containsCredential: (bytes: Uint8Array) => boolean): Promise<{ carriedCredential: boolean; executorRefusal: boolean }> => {
      const seen = { carriedCredential: false, executorRefusal: false };
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const inner = await scanOutput(path, containsCredential);
          seen.carriedCredential ||= inner.carriedCredential;
          seen.executorRefusal ||= inner.executorRefusal;
        } else if (entry.isFile()) {
          const bytes = await readFile(path);
          if (bytes.byteLength > 16 * 1024 * 1024) continue;
          seen.carriedCredential ||= containsCredential(bytes);
          seen.executorRefusal ||= executorWithheld(bytes);
        }
      }
      return seen;
    };
    const applicationRuntime: WorkflowE2EApplicationRuntime = { runRoot, collect: collectLikeTheWorker,
      createHost: (hostInput) => {
        const hostDeps = workflowE2EApplicationHostDeps({ executorImage: EXECUTOR_IMAGE, buildImage: WEB_API_BUILD_IMAGE, runRoot } satisfies WorkflowE2EApplicationRuntimeConfig,
          observed(createProcessDockerCli(), (args) => { for (const value of args) if (value.startsWith("rovara.run=")) seenRuns.add(value.slice("rovara.run=".length)); journeyInput.observeDocker?.(args); }), () => Date.now(), hostInput);
        return createDockerApplicationHost({ ...hostDeps, onRunOutput: async (run) => {
          hostCredentialScan = (bytes) => run.containsCredential(bytes);
          const seen = await scanOutput(run.outDir, (bytes) => run.containsCredential(bytes));
          withheldCredential = { carriedCredential: (withheldCredential?.carriedCredential ?? false) || seen.carriedCredential, executorRefusal: (withheldCredential?.executorRefusal ?? false) || seen.executorRefusal };
          await hostDeps.onRunOutput?.(run);
        } });
      } };
    const workerState = createWorkerServerState(journal, {
      execute: async (invocation) => {
        const sinks = sinksFor(invocation);
        return runTaskInvocation(invocation, { rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
          eventSink: sinks.eventSink, artifactSink: sinks.artifactSink, workflowE2EAdmissionReader: sinks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: sinks.workflowE2EEvidenceSink,
          workflowE2EEvidenceRoot: evidenceRoot, workflowE2ERuntimeRoot: process.cwd(), workflowE2EApplicationRuntime: applicationRuntime });
      },
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(sinksFor(invocation), result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId, generation: 1 });
    const guard = async (record: Parameters<typeof guardTaskDispatch>[1]) => {
      const admission = createTaskAuthorityAdmission({ now: Date.now, lambdaRemainingMs: 60_000 });
      try { return await guardTaskDispatch({ documentClient: harness.db, tableName: "state", admission }, record); } finally { admission.close(); }
    };
    const delivery = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true as const, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => runtimeBinding,
      sign: async (message) => cryptoSign("sha256", message, workerKeys.privateKey),
      post: async (_url, init) => {
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization: init.authorization, "content-type": "application/json" }, body: init.body }), workerState);
        return { status: response.status, body: await response.text() };
      },
      workerFeatures: async () => ((await (await handleWorkerRequest(new Request("http://worker/ping"), workerState)).json()) as { invocationFeatures: string[] }).invocationFeatures,
      guardTaskDispatch: guard, validateWorkflowE2EReadiness: createWorkflowE2EReadinessValidator({ documentClient: harness.db as never, tableName: "state" }), progress: async () => undefined,
    });
    const dispatcher = createDispatcherHandler({
      guardTaskDispatch: guard,
      markDispatching: async (record) => {
        try {
          await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
            UpdateExpression: "SET #status = :dispatching, updatedAt = :now", ConditionExpression: "#status = :accepted OR #status = :dispatching",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":now": new Date().toISOString() } }));
          return true;
        } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
      },
      markDelivered: async (id) => { await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date().toISOString() } })); },
      markFailed: async () => undefined, deliverEc2: delivery,
      completeWorkflowE2EReadiness: createWorkflowE2EReadinessCompleter({ documentClient: harness.db as never, tableName: "state" }),
    });
    const publisher = createOutboxPublisherHandler({ send: async () => undefined, markQueued: async (id) => {
      await harness.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `OUTBOX#${id}`, sk: "OUTBOX" }, UpdateExpression: "SET #status = :queued",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":queued": "QUEUED" } }));
    } });
    /** The ordinary route a queued operation takes: publish its outbox row, dispatch it to the worker, and wait for the worker's terminal result. */
    async function runOperation(workflowMode: "IMPLEMENT" | "CHECKS", after?: string) {
      const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId && item.operationId !== after
        && (item.invocation as { kind?: string; payload?: { workflowMode?: string } } | undefined)?.kind === "task"
        && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === workflowMode
        && item.status === "PENDING").at(-1);
      if (outbox === undefined) throw new Error(`no pending ${workflowMode} outbox: ${JSON.stringify(workflowNow())}`);
      const invocation = WorkerInvocationSchema.parse(outbox.invocation);
      expect((await publisher({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(outbox) } }] as never })).published).toBe(1);
      const queued = harness.db.get(String(outbox.pk), String(outbox.sk))!;
      const dispatched = await dispatcher({ Records: [{ messageId: String(outbox.id), body: JSON.stringify(queued) }] });
      expect(dispatched.batchItemFailures).toEqual([]);
      for (let index = 0; index < 6_000; index += 1) {
        const operation = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${invocation.operationId}`);
        if (operation?.status === "SUCCEEDED" || operation?.status === "FAILED" || operation?.status === "CANCELLED") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const operation = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${invocation.operationId}`)!;
      return { invocation, operation };
    }
    async function writePreparationManifest(projectRevision: number) {
      await writeFile(join(workerWorkspace, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision,
        repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: baseCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
        completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${taskId}`, complete: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    }
    /** The candidate warm-up the broker waits for before it admits a round, completed as the compute service reports it. */
    async function completeReadiness() {
      await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
      const readiness = harness.db.find((item) => item.entityType === "OPERATION" && item.workflowE2EReadiness !== undefined && (item.workflowE2EReadiness as { taskId?: string }).taskId === taskId
        && (item.workflowE2EReadiness as { workflowRevision?: number }).workflowRevision === workflowNow().revision)[0];
      expect(readiness, JSON.stringify(workflowNow())).toBeDefined();
      const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === readiness!.id)[0]!;
      harness.db.set({ ...readiness!, status: "SUCCEEDED", updatedAt: new Date().toISOString(), workflowE2EReadiness: { ...(readiness!.workflowE2EReadiness as object), readyGeneration: 7 } });
      harness.db.set({ ...outbox, status: "DELIVERED" });
      const workspace = harness.db.get(`WORKSPACE#${workspaceId}`, "META")!;
      const { activeOperationId: _active, ...ready } = workspace;
      void _active;
      harness.db.set({ ...ready, status: "READY", updatedAt: new Date().toISOString() });
      harness.db.set({ ...workspaceSessionKey(workspaceId), entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 7, privateIp: "10.42.128.10", lastActivityAt: new Date().toISOString() });
      await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    }
    /** Nothing of the round is left behind: no container (the mocks and the sinkhole included), network or volume still carries the label of a run this journey started, and the run directory is empty. */
    const nothingLeftBehind = async () => {
      expect(seenRuns.size, "the journey's host started at least one run").toBeGreaterThan(0);
      const labelled = (kind: "ps" | "network" | "volume") => [...seenRuns].map((runId) => docker(...(kind === "ps" ? ["ps", "-a", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Names}}"]
        : [kind, "ls", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Name}}"]))).filter((names) => names !== "").join("\n");
      expect({ containers: labelled("ps"), networks: labelled("network"), volumes: labelled("volume") }).toEqual({ containers: "", networks: "", volumes: "" });
      expect(await readdir(runRoot)).toEqual([]);
    };
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });
    return { root, runRoot, repository, baseCommit, snapshot, harness, policy, taskId, taskKey, workspaceId, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind, evidenceRoot, hostCredentialScan: () => hostCredentialScan, withheldCredential: () => withheldCredential, executorRemovedFile: EXECUTOR_REMOVED_FILE };
  }

  /**
   * One planned scenario on the owner account of the fixture app, whose inventory service is an external origin: the plan approves the app's own OpenAPI document and mock fixture for
   * that service, the coder's candidate is the fixture app (optionally with a defect in the call it makes to the service), the broker admits one round, the worker runs it on the
   * production Docker host with the approved mock and the sinkhole, and the broker verifies what came back on its own.
   */
  async function inventoryJourney(variant: "mocked-origin" | "unmocked-call" | "results" | "credential-echo") {
    // `credential-echo`: the passwords the host seeded, read from the plan file it mounts into the executor (see `seededPasswordsOf`), for the oracle of the journey's own.
    const seededPasswords: string[] = [];
    const journey = await startJourney({ fixtureRoot: FIXTURE_ROOT, planningFiles: ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"],
      instructions: "Show each order's stock status from the inventory service",
      ...(variant === "credential-echo" ? { observeDocker: (args: string[]) => { seededPasswords.push(...seededPasswordsOf(args)); } } : {}),
      ...(variant === "results" ? { baseline: { stageBase: (root: string) => stageCandidate(root, "base", (server) => withViewerRefusedAs401(withDefaultDefect("extra-order")(server))) } } : {}),
      plan: async (context) => {
        const targetOf = (profileId: string) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId);
        const target = targetOf("orders-owner");
        expect(target, JSON.stringify(context.targets)).toBeDefined();
        const viewerTarget = variant === "results" ? targetOf("orders-viewer") : undefined;
        if (variant === "results") expect(viewerTarget, JSON.stringify(context.targets)).toBeDefined();
        // The planner is offered the inventory mock because the app's OpenAPI document and a source-backed fixture for it are in the repository.
        const mock = context.mockFixtures.find((item) => item.requestedTargetId === target!.targetId);
        expect(mock, JSON.stringify(context.mockFixtures)).toMatchObject({ componentId: e2eApiSchemaComponentId("inventory/openapi.json"), contractPath: "inventory/openapi.json", sourcePath: "e2e/mocks/inventory-v1.json" });
        const scenario: E2EScenario = { scenarioId: "show-stock-status", requirementId: "orders-stock-status", requestedTargetIds: [target!.targetId], required: true, accountProfileId: target!.accountProfileId,
          minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }, { kind: "click", testId: "check-inventory" }],
          assertions: [{ kind: "text", testId: "inventory-status", equals: "in-stock" }] };
        const ordersOfOwner = (JSON.parse(await readFile(join(FIXTURE_ROOT, "fixtures/orders.json"), "utf8")) as { orders: Array<{ id: string; tenantId: string; customer: string; total: number; state: string }> }).orders
          .filter((order) => order.tenantId === "tenant-a").map((order) => [order.id, order.customer, String(order.total), order.state]);
        // `results`: five scenarios of the export, on the owner's account and the viewer's, with no external origin.
        const web = (scenarioId: string, requirementId: string, who: NonNullable<typeof target>, steps: E2EScenario["steps"], assertions: E2EScenario["assertions"]): E2EScenario =>
          ({ scenarioId, requirementId, requestedTargetIds: [who.targetId], required: true, accountProfileId: who.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [], steps, assertions });
        const openAndExport: E2EScenario["steps"] = [{ kind: "navigate", path: "/" }, { kind: "click", testId: "download-orders" }];
        const resultsScenarios: E2EScenario[] = variant !== "results" ? [] : [
          web("owner-export", "orders-export", target!, openAndExport, [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"], rows: ordersOfOwner }]),
          web("viewer-access", "orders-export-viewer", viewerTarget!, openAndExport, [{ kind: "text", testId: "orders-access-error", equals: "Access refused (403)" }]),
          web("owner-sees-export-button", "orders-export-visible-owner", target!, [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "download-orders", equals: true }]),
          web("viewer-sees-export-button", "orders-export-visible", viewerTarget!, [{ kind: "navigate", path: "/" }], [{ kind: "visible", testId: "download-orders", equals: true }]),
          web("owner-export-status", "orders-export-status", target!, openAndExport, [{ kind: "text", testId: "orders-export-status", equals: "Orders exported" }]),
        ];
        const planTargets = variant === "results" ? [target!, viewerTarget!] : [target!];
        // `credential-echo`: the owner's export, whose first row the candidate fills with the password the owner signed in with.
        const echoScenarios = variant !== "credential-echo" ? [] : [web("owner-export", "orders-export", target!, openAndExport, [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "customer", "total", "state"], rows: ordersOfOwner }])];
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: planTargets.map((item) => item.targetId), portableOperationRefs: [],
          mockFixtureRefs: variant === "results" || variant === "credential-echo" ? [] : [{ componentId: mock!.componentId, requestedTargetId: mock!.requestedTargetId, operationId: mock!.operationId, sourcePath: mock!.sourcePath, sourceSha256: mock!.sourceSha256 }],
          accountContextRefs: planTargets.flatMap((who) => context.accountContextRefs.filter((ref) => ref.applicationId === who.applicationId && ref.profileId === who.accountProfileId)),
          scenarios: variant === "results" ? resultsScenarios : variant === "credential-echo" ? echoScenarios : [scenario], semanticExportDeltas: [],
          applicationRuntimeRefs: planTargets.flatMap((who) => context.runtimeRefs!.filter((ref) => ref.targetId === who.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
          runtimeAccountRefs: planTargets.flatMap((who) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === who.applicationId && ref.profileId === who.accountProfileId)), unavailableTargetRefs: [] });
        const { portableOperationRefs: _portable, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _unavailable;
        return { title: "Show each order's stock status", claims: [{ id: "1", text: "The orders page shows an order's stock status from the inventory service." }], plannerIntent };
      } });
    const { root, harness, taskId, taskKey, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    const candidate = variant === "mocked-origin" || variant === "results" ? await stageCandidate(root, "candidate")
      : variant === "credential-echo" ? await stageCandidate(root, "candidate", withPasswordEchoedIntoExport)
      // The coder's call to the inventory service goes to a path that service's contract does not have (the fixture app's own dependency-route defect, as its default).
      : await stageCandidate(root, "candidate", withDefaultDefect("dependency-route"));
    if (variant === "unmocked-call") expect(await readFile(join(candidate, "server.mjs"), "utf8")).toContain("defects/dependency-route.json");

    /**
     * `results`: what the task page and Slack show, round by round, in real Chromium on the Docker host. The same five scenarios run on three states of the code:
     *  - the unchanged code, the app as the task starts with two defects (the extra order in the owner's export, and the viewer's refusal answering 401 where the plan approved 403).
     *    The broker's baseline round (owner decision D2) runs it by itself, once, right after the coding run and before the candidate's CHECKS: two rows FAILED, each with a screenshot.
     *    It is for information only: it sets no `failedRound` or `qualifiedRound`, offers no send-back, and the candidate's CHECKS go on as if it were not there;
     *  - candidate 1, whose export is right but whose refusal of the viewer's export still answers 401: FAILED on `viewer-access`, on the viewer's account, with a screenshot and expected
     *    versus actual (see `withViewerRefusedAs401` for why it is not the fixture's own `viewer-access` defect), and the baseline beside it;
     *  - candidate 2, as the fixture ships: PASS, publishable; the baseline recorded beside it changed nothing.
     */
    async function resultsFlow() {
      const brokerModule = await import("../../packages/broker/src/aws/broker.js");
      const notifierModule = await import("../../packages/broker/src/aws/developer-task-notifier.js");
      const taskNow = () => harness.db.get(taskKey.pk, taskKey.sk) as never;
      const resultsNow = () => brokerModule.loadWorkflowE2EScenarioResults(harness.brokerInput as never, taskNow(), operationRows(() => true), "owner");
      const presentation = () => brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, taskNow(), operationRows(() => true), "owner");
      const byScenario = (rows: Array<{ scenarioId: string }>) => Object.fromEntries(rows.map((row) => [row.scenarioId, row])) as Record<string, (typeof rows)[number] & { status: string; reason?: string; screenshotRef?: { sha256: string; contentType: string }; failedAssertion?: { kind: string; expected: string; actual: string }; mockedOrigins: string[] }>;
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: MAYA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
      const getArtifact = async (sha256: string) => (await harness.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task/api/e2e/artifacts/${sha256}`, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } })) as unknown as
        { statusCode: number; body: string; headers: Record<string, string> };
      /** The coding run, and the compute warm-up the broker waits for before it admits a round. */
      const implementCode = async (dir: string, message: string) => {
        faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${dir}/." repo/demo/` })]), fauxAssistantMessage(message)]);
        const done = await runOperation("IMPLEMENT");
        expect(done.operation.status, JSON.stringify(done.operation)).toBe("SUCCEEDED");
        expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
        await completeReadiness();
      };
      const purposeOf = (run: Awaited<ReturnType<typeof runOperation>>) => (run.invocation as { payload: { workflowE2EAdmission?: { purpose?: string } } }).payload.workflowE2EAdmission?.purpose;
      const implement = async (dir: string, message: string) => {
        await implementCode(dir, message);
        const checks = await runOperation("CHECKS");
        expect(purposeOf(checks)).toBeUndefined();
        expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
        return checks;
      };
      const e2eNow = () => workflowNow().e2e as { contractDigest: string; failedRound?: { status: string }; qualifiedRound?: unknown; displayRef?: unknown };
      const sendBack = async (instructions: string) => {
        const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, instructions });
        expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
        expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "IMPLEMENT" });
      };
      const first = await stageCandidate(root, "candidate-1", withViewerRefusedAs401);
      const fixed = await stageCandidate(root, "candidate-2");
      const baselineKey = { pk: `DEVTASK#${taskId}`, sk: `E2E_BASELINE#${e2eNow().contractDigest}` };

      // Approval asked for the informational round, once, for this plan, and the coding run was asked to export the unchanged code.
      expect(harness.db.get(baselineKey.pk, baselineKey.sk)).toMatchObject({ state: "REQUESTED", purpose: "baseline", attempt: 1 });
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));

      // Candidate 1's coding run ends; the broker runs the baseline on the unchanged code first, in a round of its own kind.
      await implementCode(first, "I fixed the export.");
      const baselineRun = await runOperation("CHECKS");
      expect(purposeOf(baselineRun)).toBe("baseline");
      expect(baselineRun.operation.status, JSON.stringify({ operation: baselineRun.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
      const recorded = harness.db.get(baselineKey.pk, baselineKey.sk) as { state: string; baseline: { status: string; scenarios: Array<{ scenarioId: string; status: string; screenshotRef?: { sha256: string } }> } };
      expect(recorded.state, JSON.stringify(recorded)).toBe("RECORDED");
      expect(recorded.baseline.status).toBe("FAILED");
      expect(recorded.baseline.scenarios.filter((row) => row.status === "FAILED").map((row) => row.scenarioId).sort()).toEqual(["owner-export", "viewer-access"]);
      for (const row of recorded.baseline.scenarios.filter((item) => item.status === "FAILED")) {
        expect(row.screenshotRef, `a screenshot of ${row.scenarioId}`).toBeDefined();
        expect((await getArtifact(row.screenshotRef!.sha256)).statusCode).toBe(200);
      }
      // Review Focus 6: a baseline with failures never gates. No failed or qualified round, no display of its own, no send-back, nothing for publication; the workflow goes on to the candidate.
      expect(e2eNow().failedRound).toBeUndefined();
      expect(e2eNow().qualifiedRound).toBeUndefined();
      expect(e2eNow().displayRef).toBeUndefined();
      expect(workflowNow().blockReason).toBeUndefined();
      expect(workflowSendBackOffered(workflowNow() as never)).toBe(false);
      expect(await brokerModule.loadWorkflowE2EPublicationChecks(harness.brokerInput as never, taskNow(), operationRows(() => true))).toBeUndefined();
      expect(JSON.stringify(workflowNow())).not.toMatch(/baseline/iu);
      // And the page already says what the unchanged code did, with no row of the candidate's yet.
      const beforeCandidate = (await resultsNow())!;
      expect(beforeCandidate.scenarios).toEqual([]);
      expect(beforeCandidate.baseline?.status).toBe("FAILED");
      const firstRun = await runOperation("CHECKS");
      expect(purposeOf(firstRun)).toBeUndefined();
      expect(firstRun.operation.status, JSON.stringify({ operation: firstRun.operation, workflow: workflowNow() })).toBe("SUCCEEDED");

      // Candidate 1: the export is right, but the viewer's refusal answers 401 where 403 is approved. FAILED on that one row, on the viewer's account, with expected versus actual
      // and a screenshot of the page as it was.
      expect(workflowNow().blockReason).toBe("one or more admitted E2E groups failed");
      expect(e2eNow().failedRound).toMatchObject({ status: "FAILED" });
      expect(e2eNow().qualifiedRound).toBeUndefined();
      const firstRows = (await resultsNow())!;
      expect(firstRows.scenarios).toHaveLength(5);
      const stateRow = byScenario(firstRows.scenarios)["viewer-access"]!;
      expect(stateRow).toMatchObject({ status: "FAILED", kind: "web", accountLabel: "orders-viewer",
        reason: 'expected "Access refused (403)", received "Access refused (401)"', failedAssertion: { kind: "text", expected: "Access refused (403)", actual: "Access refused (401)" } });
      expect(stateRow.screenshotRef).toMatchObject({ contentType: "image/jpeg" });
      expect(firstRows.scenarios.filter((row) => row.status === "FAILED").map((row) => row.scenarioId)).toEqual(["viewer-access"]);
      expect(byScenario(firstRows.scenarios)["owner-export"]).toMatchObject({ status: "PASSED", accountLabel: "orders-owner" });
      expect(firstRows.baseline?.status).toBe("FAILED");
      expect(byScenario(firstRows.baseline!.scenarios)["owner-export"]!.screenshotRef).toBeDefined();
      // The screenshots are behind the page's session: the owner reads them as JPEGs, someone else is refused.
      const shot = await getArtifact(stateRow.screenshotRef!.sha256);
      expect(shot.statusCode, shot.body.slice(0, 200)).toBe(200);
      expect(shot.headers["content-type"]).toBe("image/jpeg");
      expect(Buffer.from(shot.body, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect((await getArtifact("0".repeat(64))).statusCode).toBe(404);
      const slackText = JSON.stringify(await notifierModule.workflowE2ENotifierBlocks({ task: taskNow(), taskPageUrl: `https://agentx.example.test/review/${taskId}/task`,
        readPrivateObject: async (key) => { const text = harness.s3.objects.get(key); return text === undefined ? undefined : Buffer.from(text, "utf8"); } }));
      expect(slackText).toContain("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
      expect(slackText).toContain("Viewer access — failed: expected");
      expect(slackText).toContain("Access refused (401)");
      expect(slackText).toContain("(orders-viewer)");
      expect(slackText).toContain("Before the change: 2 of 5 failed, as expected for new behaviour.");
      // The baseline's failures did not make the candidate's round a failure, and the candidate's failure is the candidate's alone: the send-back is offered for it.
      expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
      await sendBack("The viewer's refused export must answer 403.");

      // Candidate 2: as the fixture ships. Every row passes; the page lists five rows and the baseline apart; the task goes on to review. The baseline changed nothing about that.
      await implement(fixed, "I made the refusal a 403 again.");
      expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
      expect(e2eNow().qualifiedRound).toBeDefined();
      expect(e2eNow().failedRound).toBeUndefined();
      const lastRows = (await resultsNow())!;
      expect(lastRows.scenarios.map((row) => row.status)).toEqual(Array(5).fill("PASSED"));
      expect(lastRows.baseline?.status).toBe("FAILED");
      const page = (await presentation())!.pageHtml;
      expect(page.match(/<tr[^>]*data-e2e-row=/gu)).toHaveLength(5);
      expect(page.match(/<tr[^>]*data-e2e-baseline-row=/gu)).toHaveLength(5);
      expect(page).toContain("Browser and API checks: 5 passed, 0 failed, 0 incomplete");
      expect((await presentation())!.shared.e2e.status).toBe("PASS");
      // The baseline's screenshot is still the task's to read.
      const baselineShot = byScenario(lastRows.baseline!.scenarios)["owner-export"]!.screenshotRef!;
      expect((await getArtifact(baselineShot.sha256)).statusCode).toBe(200);
    }

    /**
     * `credential-echo`: the broker redacts by pattern and cannot know a run's passwords; what keeps a bare password out of a row, the stored display and Slack is the chain upstream
     * of it, in two layers. First the executor, which refuses to record evidence that carries an account credential (so the case has no value to show), then the Docker host's own
     * scan, which holds back the operator evidence (captures, log heads) that does. Both hold the run's passwords, which nothing else does. A candidate copies the password the owner
     * signed in with into the first row of the owner's export, which the CSV assertion observes.
     * Two things are proved. The echo reached the run's output and was withheld: the run's raw output carries the credential or the executor's refusal of it (a round that failed for
     * another reason, and so never put a credential through the chain, would otherwise pass for a proof). And whatever the round makes of that, no surface the broker stores or shows
     * carries the password, by the host's own predicate (every spelling it knows, base64 included).
     */
    async function credentialEchoFlow() {
      const brokerModule = await import("../../packages/broker/src/aws/broker.js");
      const notifierModule = await import("../../packages/broker/src/aws/developer-task-notifier.js");
      faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the export.")]);
      await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
      const implemented = await runOperation("IMPLEMENT");
      expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
      await completeReadiness();
      const checks = await runOperation("CHECKS");
      expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
      const scan = journey.hostCredentialScan();
      // N1: positive evidence that a credential was withheld, from whichever layer withheld it. (1) The run's raw output, as the host saw it before anything was handed out, shows the
      // echo: the credential itself (which the host's scan then held back from the operator evidence), the executor's refusal to record evidence that carries one, its removal of an
      // output file that did, or its result file's "credential-leak". (2) A run the executor ended for a leak (exit code 2) is not read by the host at all, so there is no raw output
      // to see; the broker's stored evidence of the group then keeps the executor's log line. One of the two must show it.
      const groupRuns = ((checks.operation.workflowE2EGroupEvidenceRefs ?? []) as Array<{ evidenceRef: { key: string } }>).map((ref) =>
        JSON.parse(harness.s3.objects.get(ref.evidenceRef.key) ?? "{}") as { groupRun?: { diagnostics?: { executorLogTail?: string } | null } });
      const storedLogShowsIt = groupRuns.some((item) => (item.groupRun?.diagnostics?.executorLogTail ?? "").includes(journey.executorRemovedFile));
      const withheldCredential = journey.withheldCredential();
      expect(withheldCredential?.carriedCredential === true || withheldCredential?.executorRefusal === true || storedLogShowsIt,
        `nothing shows a credential reached the run and was withheld: ${JSON.stringify({ withheldCredential, storedLogShowsIt })}`).toBe(true);
      // The echo took effect: the export no longer holds the owner's orders, so the round is not a pass.
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeUndefined();
      const task = harness.db.get(taskKey.pk, taskKey.sk) as never;
      const operations = operationRows(() => true);
      const rows = await brokerModule.loadWorkflowE2EScenarioResults(harness.brokerInput as never, task, operations, "owner");
      expect(rows?.scenarios.map((row) => row.status), JSON.stringify(rows)).not.toContain("PASSED");
      const presentation = (await brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, task, operations, "owner"))!;
      const displayRef = (workflowNow().e2e as { displayRef?: { key: string } }).displayRef;
      const slack = await notifierModule.workflowE2ENotifierBlocks({ task, taskPageUrl: `https://agentx.example.test/review/${taskId}/task`,
        readPrivateObject: async (key) => { const text = harness.s3.objects.get(key); return text === undefined ? undefined : Buffer.from(text, "utf8"); } });
      const surfaces: Record<string, string> = { rows: JSON.stringify(rows), page: presentation.pageHtml, slack: JSON.stringify(slack), presentationSlack: JSON.stringify(presentation.slackBlocks),
        shared: JSON.stringify(presentation.shared), workflow: JSON.stringify(workflowNow()), display: displayRef === undefined ? "" : harness.s3.objects.get(displayRef.key) ?? "" };
      expect(surfaces.display, "a display was stored").not.toBe("");
      // The host's predicate exists only for a run it read; a run the executor ended for a leak has none, and then the executor's removal of the file is the proof.
      if (scan !== undefined) for (const [name, text] of Object.entries(surfaces)) expect(scan(Buffer.from(text, "utf8")), `the ${name} carries a run credential`).toBe(false);
      // The journey's own oracle, which does not depend on the host's scan (that scan exists only for a run the host read, and it is the code under test). The passwords are the ones the host
      // wrote to the plan file it mounted into the executor. At least one was captured, or the check below would pass for nothing; and none, in any spelling, is in anything the broker stored
      // or shows: the rows, the page, Slack, the stored display, and the stored evidence of each group.
      const passwords = [...new Set(seededPasswords)];
      expect(passwords.length, "the plan file the host mounted into the executor was read, and it held a password").toBeGreaterThan(0);
      const groupEvidence = ((checks.operation.workflowE2EGroupEvidenceRefs ?? []) as Array<{ evidenceRef: { key: string } }>).map((ref) => harness.s3.objects.get(ref.evidenceRef.key) ?? "");
      expect(groupEvidence.length, "the round stored evidence for at least one group").toBeGreaterThan(0);
      expect(groupEvidence.every((text) => text.length > 0), "every group's stored evidence was read").toBe(true);
      const oracleSurfaces: Record<string, string> = { rows: surfaces.rows!, page: surfaces.page!, slack: surfaces.slack!, "stored display": surfaces.display!,
        ...Object.fromEntries(groupEvidence.map((text, index) => [`stored group evidence ${index + 1}`, text])) };
      for (const password of passwords) {
        for (const [form, spelling] of spellingsOf(password)) {
          for (const [name, text] of Object.entries(oracleSurfaces)) expect(text.includes(spelling), `the ${name} holds a seeded password (${password.length} characters) as ${form}`).toBe(false);
        }
      }
    }

    if (variant === "credential-echo") {
      await credentialEchoFlow();
      await nothingLeftBehind();
      return;
    }

    if (variant === "results") {
      await resultsFlow();
      await nothingLeftBehind();
      return;
    }

    // The coder implements the feature (the fixture app as it ships, or with its dependency-route defect); the broker admits one round; the worker runs it; the broker verifies the evidence itself.
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the stock status.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const implemented = await runOperation("IMPLEMENT");
    expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    await completeReadiness();
    const checks = await runOperation("CHECKS");
    expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    const refs = checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>;
    const stored = refs.map((ref) => JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { diagnostics: unknown; collection: { result: { status: string; reason: string; mockedOrigins?: string[]; cases: Array<{
      status: string; reason: string; mockedOrigins?: string[]; assertionReceipts: Array<{ assertionIndex: number; status: string }>; coverage: { observedMockedComponentIds: string[] } }> } } } });
    const brokerModule = await import("../../packages/broker/src/aws/broker.js");
    const presentation = () => brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, harness.db.get(taskKey.pk, taskKey.sk) as never, operationRows(() => true), "owner");

    if (variant === "mocked-origin") {
      // PASS: the page showed what the inventory mock answered, the mock is named on the case and on the round, and the broker's own verdict stands on the ledger of the mock itself.
      expect(workflowNow(), JSON.stringify({ blockReason: workflowNow().blockReason, diagnostics: stored.map((item) => item.groupRun.diagnostics) })).toMatchObject({ stage: "REVIEW" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeDefined();
      const result = stored[0]!.groupRun.collection.result;
      expect(result).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({ status: "passed", mockedOrigins: ["inventory-v1"] });
      expect(result.cases[0]!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "passed"]]);
      const shared = (await presentation())?.shared.e2e;
      expect(shared?.status).toBe("PASS");
      expect(shared?.mockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
      expect(shared?.observedMockedComponentIds).toEqual([e2eApiSchemaComponentId("inventory/openapi.json")]);
    } else {
      // UNKNOWN, never PASS and never FAILED: a call that no approved mock matched blocks publication, and names its reason; no round is recorded as failed or as qualified.
      const result = stored[0]!.groupRun.collection.result;
      expect(result.cases[0]).toMatchObject({ status: "unavailable", reason: "unmocked-external-call" });
      expect(workflowNow().blockReason, JSON.stringify(workflowNow())).not.toBe("one or more admitted E2E groups failed");
      expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect((workflowNow().e2e as { qualifiedRound?: unknown; failedRound?: unknown }).qualifiedRound).toBeUndefined();
      expect((workflowNow().e2e as { failedRound?: unknown }).failedRound).toBeUndefined();
      expect(JSON.stringify(workflowNow())).toContain("unmocked-external-call");
      expect((await presentation())?.shared.e2e.status).toBe("UNKNOWN");
    }
    await nothingLeftBehind();
  }

  /** A copy of the accounts fixture app a coder would produce, optionally edited (the viewer-access defect on by default is how candidate 1 differs from candidate 2). */
  async function stageAccountsCandidate(root: string, name: string, edit?: (server: string) => string) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    for (const file of ACCOUNTS_APP_FILES) await cp(join(ACCOUNTS_FIXTURE_ROOT, file), join(dir, file), { recursive: true });
    if (edit) await writeFile(join(dir, "server.mjs"), edit(await readFile(join(dir, "server.mjs"), "utf8")));
    return dir;
  }

  /**
   * Task 3.2, whole: three accounts in two tenants (a viewer and an owner of tenant-a, the owner of tenant-b) planned as three scenarios of one application, all in one group of one round.
   * The accounts are seeded by the app's own recipe from the accounts file the host writes, and sign in through the app's own form. Candidate 1 lets a viewer export (the
   * viewer-access defect): the viewer's case is FAILED on its visible assertion, the other two pass, and the broker offers send-back. Candidate 2 is fixed: PASS. Each case's account ref
   * is the one the registry resolves for (applicationId, accountProfileId). No byte the broker or the worker stored holds a seeded password, email or email local part.
   */
  async function accountsJourney() {
    const secrets: string[] = [];
    const accountsFileOf = (args: string[]): string | null => {
      if (!args.some((value, index) => args[index - 1] === "--name" && value.startsWith("rovara-seed-"))) return null;
      const mount = args.find((value, index) => args[index - 1] === "-v" && value.endsWith(":/app/.owned:ro"));
      return mount === undefined ? null : join(mount.slice(0, -":/app/.owned:ro".length), "rovara-accounts.json");
    };
    let plannedRefs: Array<{ applicationId: string; profileId: string; revision: number; definitionDigest: string }> = [];
    const journey = await startJourney({ fixtureRoot: ACCOUNTS_FIXTURE_ROOT, planningFiles: ["package.json"], instructions: "Only owners may export orders, and each tenant sees only its own",
      // What the seeded accounts are, read from the accounts file at the moment the seed container is started (the host removes the file with the run).
      observeDocker: (args) => {
        const file = accountsFileOf(args);
        if (file === null) return;
        for (const account of (JSON.parse(readFileSync(file, "utf8")) as { accounts: Array<{ email: string; password: string }> }).accounts) secrets.push(account.password, account.email, account.email.slice(0, account.email.indexOf("@")));
      },
      plan: (context) => {
        const profiles = ["orders-viewer", "orders-owner", "orders-owner-b"] as const;
        const targets = profiles.map((profileId) => context.targets.find((item) => item.kind === "web" && item.accountProfileId === profileId));
        for (const target of targets) expect(target, JSON.stringify(context.targets)).toBeDefined();
        const scenarios = [webAccountScenarios.viewer, webAccountScenarios.owner, webAccountScenarios.ownerB].map((item, index) => item.scenario(targets[index]!.targetId));
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item!.targetId), portableOperationRefs: [], mockFixtureRefs: [],
          accountContextRefs: targets.flatMap((item) => context.accountContextRefs.filter((ref) => ref.applicationId === item!.applicationId && ref.profileId === item!.accountProfileId)),
          scenarios, semanticExportDeltas: [],
          applicationRuntimeRefs: targets.flatMap((item) => context.runtimeRefs!.filter((ref) => ref.targetId === item!.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
          runtimeAccountRefs: targets.flatMap((item) => context.runtimeAccountRefs!.filter((ref) => ref.applicationId === item!.applicationId && ref.profileId === item!.accountProfileId)), unavailableTargetRefs: [] });
        plannedRefs = [...intent.runtimeAccountRefs];
        const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _mocks; void _unavailable;
        return { title: "Only owners export orders", claims: [{ id: "1", text: "A viewer cannot export orders; an owner exports its tenant's orders; one tenant never sees another's." }], plannerIntent };
      } });
    const { root, harness, snapshot, taskKey, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind, evidenceRoot } = journey;
    // Candidate 1: the app with the viewer-access defect as its default; candidate 2: the app as it ships.
    const defective = await stageAccountsCandidate(root, "candidate-defective", (server) => server.replace("defect: readDefect() });", 'defect: readDefect() ?? JSON.parse(readFileSync(join(root, "defects/viewer-access.json"), "utf8")) });'));
    expect(await readFile(join(defective, "server.mjs"), "utf8")).toContain("defects/viewer-access.json");
    const fixed = await stageAccountsCandidate(root, "candidate-fixed");
    const implementation = (candidate: string) => fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]);
    const brokerModule = await import("../../packages/broker/src/aws/broker.js");
    const presentation = () => brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, harness.db.get(taskKey.pk, taskKey.sk) as never, operationRows(() => true), "owner");
    type CaseResult = { caseId: string; status: string; reason: string; accountContextId: string; accountContextDigest: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> };
    const casesOf = (operation: Record<string, unknown>): CaseResult[] => (operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>).flatMap((ref) =>
      (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: CaseResult[] } } } }).groupRun.collection.result.cases);

    // Round 1: candidate 1.
    faux.setResponses([implementation(defective), fauxAssistantMessage("I added the orders export.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const first = await runOperation("IMPLEMENT");
    expect(first.operation.status, JSON.stringify(first.operation)).toBe("SUCCEEDED");
    const firstCandidateDigest = workflowNow().candidate!.digest;
    await completeReadiness();
    const checks1 = await runOperation("CHECKS");
    expect(checks1.operation.status, JSON.stringify({ operation: checks1.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow().blockReason, "round 1 must be FAILED by the broker (an assertion mismatch), not UNKNOWN").toBe("one or more admitted E2E groups failed");
    expect(workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const e2e1 = workflowNow().e2e as { failedRound?: { status: string; candidateDigest: string; roundId: string }; qualifiedRound?: unknown };
    expect(e2e1.failedRound).toMatchObject({ status: "FAILED", candidateDigest: firstCandidateDigest });
    expect(e2e1.qualifiedRound).toBeUndefined();
    expect(workflowSendBackOffered(workflowNow() as never)).toBe(true);
    const cases1 = casesOf(checks1.operation);
    expect(cases1, "three accounts, three cases, one group").toHaveLength(3);
    expect((checks1.operation.workflowE2EGroupEvidenceRefs as unknown[]), "one group").toHaveLength(1);
    // Exactly one case failed, on its one assertion; the other two (the owner exporting, the other tenant's owner seeing none of tenant-a's rows) passed.
    expect(cases1.filter((item) => item.status === "failed").map((item) => item.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status]))).toEqual([[[0, "failed"]]]);
    expect(cases1.filter((item) => item.status === "passed")).toHaveLength(2);
    expect((await presentation())?.shared.e2e.status).toBe("FAILED");

    // Each case's account ref is the registry's own for (applicationId, accountProfileId): three different accounts of one application.
    const contract = readE2EApplicationProjectContract(snapshot, plannedRefs[0]!.applicationId)!;
    const entries = accountRegistryEntriesFromRows("payments", harness.db.find((row) => row.pk === "PROJECT#payments"));
    expect(plannedRefs.map((ref) => ref.profileId).sort()).toEqual(["orders-owner", "orders-owner-b", "orders-viewer"]);
    expect(new Set(plannedRefs.map((ref) => ref.applicationId)).size).toBe(1);
    for (const ref of plannedRefs) {
      expect(latestAccountRef({ contract, entries, applicationId: ref.applicationId, profileId: ref.profileId, now: Date.now() }), ref.profileId).toEqual(ref);
    }
    expect(new Set(plannedRefs.map((ref) => ref.definitionDigest)).size).toBe(3);
    expect(new Set(cases1.map((item) => item.accountContextId)).size, "each case has its own account context").toBe(3);
    // And each is the context of the right account: the registry's ref for (applicationId, accountProfileId) gives the context id the collector must attribute to that account's case.
    // The failed case is the viewer's (and no one else's), and the three contexts are exactly the three accounts' own, so no two cases were given each other's.
    const contextIdOf = (ref: { applicationId: string; profileId: string; revision: number; definitionDigest: string }) =>
      `app-account-${createHash("sha256").update(canonicalJson([ref.applicationId, ref.profileId, ref.revision, ref.definitionDigest])).digest("hex")}`.slice(0, 120);
    const refOf = (profileId: string) => plannedRefs.find((ref) => ref.profileId === profileId)!;
    expect(cases1.find((item) => item.status === "failed")!.accountContextId, "the failed case is the viewer's").toBe(contextIdOf(refOf("orders-viewer")));
    expect(cases1.filter((item) => item.status === "passed").map((item) => item.accountContextId).sort(), "the two passing cases are the two owners'")
      .toEqual([contextIdOf(refOf("orders-owner")), contextIdOf(refOf("orders-owner-b"))].sort());

    // Round 2: send it back, and candidate 2 passes all three.
    const sentBack = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${journey.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision,
      instructions: "A viewer can export. Only an owner may." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    faux.setResponses([implementation(fixed), fauxAssistantMessage("Only owners can export now.")]);
    const second = await runOperation("IMPLEMENT");
    expect(second.operation.status, JSON.stringify(second.operation)).toBe("SUCCEEDED");
    const secondCandidateDigest = workflowNow().candidate!.digest;
    expect(secondCandidateDigest).not.toBe(firstCandidateDigest);
    await completeReadiness();
    const checks2 = await runOperation("CHECKS", checks1.invocation.operationId);
    expect(checks2.operation.status, JSON.stringify({ operation: checks2.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e2 = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string; roundId: string } };
    expect(e2e2.qualifiedRound).toMatchObject({ candidateDigest: secondCandidateDigest });
    expect(e2e2.failedRound).toBeUndefined();
    const cases2 = casesOf(checks2.operation);
    expect(cases2).toHaveLength(3);
    expect(cases2.every((item) => item.status === "passed" && item.assertionReceipts.every((receipt) => receipt.status === "passed"))).toBe(true);
    expect(cases2.map((item) => item.accountContextId).sort(), "round 2 attributes the same three accounts").toEqual(plannedRefs.map(contextIdOf).sort());
    expect([...new Set(cases2.map((item) => item.accountContextId))].sort()).toEqual([...new Set(cases1.map((item) => item.accountContextId))].sort());
    expect((await presentation())?.shared.e2e.status).toBe("PASS");

    // The credentials the host seeded appear in no byte either round stored: not in the group evidence, not in any row, not in the worker's own evidence files.
    expect(secrets.length, "the seed's accounts file was read for both rounds").toBeGreaterThanOrEqual(12);
    const stored = [JSON.stringify(harness.db.find(() => true)), ...[...harness.s3.objects.values()].map((value) => (typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("latin1")))];
    for (const entry of await readdir(evidenceRoot, { recursive: true, withFileTypes: true })) if (entry.isFile()) stored.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
    expect(stored.join("\n").length).toBeGreaterThan(10_000);
    for (const secret of new Set(secrets)) {
      for (const [form, spelling] of spellingsOf(secret)) {
        for (const text of stored) expect(text.includes(spelling), `a stored byte holds a seeded credential (${secret.length} characters, ${secret.startsWith("rovara-") ? "an email part" : "a password"}) as ${form}`).toBe(false);
      }
    }
    await nothingLeftBehind();
  }

  /**
   * Task 3.3 (Ruling AZ), whole: an application with no `agentx.e2e` project contract (a start script and a lockfile; Rovara infers `npm ci` and `npm start`) planned with two signed-out
   * scenarios on the implicit `rovara-anonymous` variant of its web target. The base target of the same app stays unavailable with `needs-project-contract`, so a signed-in scenario
   * could not run there. The anonymous cases have no account binding: one account context, the fixed anonymous reference, no seed and no data volume. The round is PASS, the task
   * goes on to review, and publication has checks.
   */
  async function anonymousInferredJourney() {
    let plannedRef: { applicationId: string; profileId: string; revision: number; definitionDigest: string } | undefined;
    const journey = await startJourney({ fixtureRoot: INFERRED_FIXTURE_ROOT, planningFiles: ["package.json", "package-lock.json"], instructions: "Show every visitor a welcome page",
      plan: (context) => {
        const anonymous = context.targets.find((item) => item.kind === "web" && item.accountProfileId === "rovara-anonymous");
        expect(anonymous, JSON.stringify(context.targets)).toBeDefined();
        // The inferred app's own (signed-in) target is not executable, and the planner is told why; only its signed-out variant is.
        expect(context.unavailableReasons, JSON.stringify(context)).toEqual([{ targetId: "web-1", reason: "needs-project-contract" }]);
        const scenarios = [anonymousWebScenarios.welcome, anonymousWebScenarios.noAdmin].map((item) => item.scenario(anonymous!.targetId));
        const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [anonymous!.targetId], portableOperationRefs: [], mockFixtureRefs: [],
          accountContextRefs: context.accountContextRefs.filter((ref) => ref.applicationId === anonymous!.applicationId && ref.profileId === "rovara-anonymous"),
          scenarios, semanticExportDeltas: [],
          applicationRuntimeRefs: context.runtimeRefs!.filter((ref) => ref.targetId === anonymous!.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! })),
          runtimeAccountRefs: context.runtimeAccountRefs!.filter((ref) => ref.applicationId === anonymous!.applicationId && ref.profileId === "rovara-anonymous"), unavailableTargetRefs: [] });
        plannedRef = intent.runtimeAccountRefs[0];
        const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
        void _portable; void _mocks; void _unavailable;
        return { title: "Welcome every visitor", claims: [{ id: "1", text: "A signed-out visitor sees the welcome page and no admin link." }], plannerIntent };
      } });
    const { root, harness, taskKey, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind } = journey;
    expect(plannedRef, "the plan carries the fixed anonymous reference").toEqual(e2eAnonymousRuntimeAccountRef(plannedRef!.applicationId));
    // The coder's candidate: the fixture app as it ships (the repository held only its manifest and lockfile).
    const candidate = join(root, "candidate-inferred");
    await mkdir(candidate, { recursive: true });
    for (const file of INFERRED_APP_FILES) await cp(join(INFERRED_FIXTURE_ROOT, file), join(candidate, file), { recursive: true });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `cp -R "${candidate}/." repo/demo/` })]), fauxAssistantMessage("I added the welcome page.")]);
    await writePreparationManifest(Number((harness.db.get(taskKey.pk, taskKey.sk) as { startingRevision?: number }).startingRevision ?? 1));
    const implemented = await runOperation("IMPLEMENT");
    expect(implemented.operation.status, JSON.stringify(implemented.operation)).toBe("SUCCEEDED");
    const candidateDigest = workflowNow().candidate!.digest;
    await completeReadiness();
    const checks = await runOperation("CHECKS");
    expect(checks.operation.status, JSON.stringify({ operation: checks.operation, workflow: workflowNow() })).toBe("SUCCEEDED");
    expect(workflowNow(), JSON.stringify(workflowNow())).toMatchObject({ stage: "REVIEW" });
    const e2e = workflowNow().e2e as { failedRound?: unknown; qualifiedRound?: { candidateDigest: string } };
    expect(e2e.qualifiedRound).toMatchObject({ candidateDigest });
    expect(e2e.failedRound).toBeUndefined();
    type CaseResult = { caseId: string; status: string; accountContextId: string; assertionReceipts: Array<{ assertionIndex: number; status: string }> };
    const cases = (checks.operation.workflowE2EGroupEvidenceRefs as Array<{ evidenceRef: { key: string } }>).flatMap((ref) =>
      (JSON.parse(harness.s3.objects.get(ref.evidenceRef.key)!) as { groupRun: { collection: { result: { cases: CaseResult[] } } } }).groupRun.collection.result.cases);
    expect(cases, "two scenarios, two cases, one group").toHaveLength(2);
    expect(cases.every((item) => item.status === "passed" && item.assertionReceipts.every((receipt) => receipt.status === "passed"))).toBe(true);
    // Both cases are the anonymous profile's: one account context, the one the fixed reference gives, since a signed-out visitor is nobody's account.
    const contextId = `app-account-${createHash("sha256").update(canonicalJson([plannedRef!.applicationId, plannedRef!.profileId, plannedRef!.revision, plannedRef!.definitionDigest])).digest("hex")}`.slice(0, 120);
    expect(cases.map((item) => item.accountContextId)).toEqual([contextId, contextId]);
    const brokerModule = await import("../../packages/broker/src/aws/broker.js");
    const task = harness.db.get(taskKey.pk, taskKey.sk) as never;
    const presentation = await brokerModule.loadWorkflowE2EPresentation(harness.brokerInput as never, task, operationRows(() => true), "owner");
    expect(presentation?.shared.e2e.status).toBe("PASS");
    const publicationChecks = await brokerModule.loadWorkflowE2EPublicationChecks(harness.brokerInput as never, task, operationRows(() => true));
    expect(publicationChecks?.length, "a passing signed-out round gives publication checks").toBeGreaterThan(0);
    // The app has no seed, no account and no volume: nothing of it is left on the Docker host.
    await nothingLeftBehind();
  }

  it("mocked-origin: the round is PASS with the inventory origin served by its approved mock, named on the result as mockedOrigins [inventory-v1]", async () => {
    await inventoryJourney("mocked-origin");
  }, 600_000);

  it("unmocked-call: a candidate that calls a path the inventory contract does not have gets UNKNOWN for unmocked-external-call, never PASS", async () => {
    await inventoryJourney("unmocked-call");
  }, 600_000);

  it("credential-echo: a password the candidate copies into an observed export reaches no row, no stored display and no Slack text (the executor's refusal and the host's scan, end to end, with proof the echo reached them)", async () => {
    await inventoryJourney("credential-echo");
  }, 600_000);

  it("results: five scenarios on three states of the code show a row each with its account and kind, a failure with a screenshot and expected versus actual, the baseline apart, and a passing round publishes", async () => {
    await inventoryJourney("results");
  }, 1_800_000);

  it("anonymous-inferred: an app with no project contract runs two signed-out scenarios on its anonymous variant; the plan is approved, the round is PASS with no account binding, and publication has checks", async () => {
    await anonymousInferredJourney();
  }, 1_800_000);

  it("accounts: three accounts in two tenants in one group; the viewer-access defect is FAILED and sent back, the fixed candidate is PASS, and no seeded credential is stored anywhere", async () => {
    await accountsJourney();
  }, 1_800_000);
});
