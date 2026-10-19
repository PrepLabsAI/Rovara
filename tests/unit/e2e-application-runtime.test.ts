import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { canonicalJson, ProjectSetupRunnerToolchainSchema } from "@agentx/contracts";
import type { E2EConfig } from "e2e";
import { z } from "zod";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { createCompiledApiApplicationFixture } from "../support/e2e-application-fixture.js";
import type { E2EActualApplicationRun } from "../../packages/verifier/src/application-collection.js";
import type { E2EActualApplicationCliInput } from "../../packages/verifier/src/application-runtime-cli.js";
import { createE2EApplicationRuntimeAssets } from "../../packages/verifier/src/application-runtime-assets.js";

type InstalledBootstrap = { prepareE2EApplicationCliConfig(input: { configUrl: string }): Promise<E2EConfig> };
type InstalledRunner = { runE2EApplicationActualCli(input: E2EActualApplicationCliInput): Promise<E2EActualApplicationRun> };

describe("application actual CLI and lifecycle", () => {
  it("exposes the actual-spawn runtime path and distinct process-local bootstrap", async () => {
    const runtime = await import("../../packages/verifier/src/application-runtime-cli.js").catch(() => null);
    const bootstrap = await import("../../packages/verifier/src/application-runtime-bootstrap.js").catch(() => null);
    expect(runtime).not.toBeNull();
    expect(bootstrap).not.toBeNull();
    if (!runtime || !bootstrap) return;
    expect(runtime.runE2EApplicationActualCli).toBeTypeOf("function");
    expect(bootstrap.registerE2EApplicationCliHost).toBeTypeOf("function");
    expect(bootstrap.installE2EApplicationCliBridge).toBeTypeOf("function");
    expect(bootstrap.prepareE2EApplicationCliConfig).toBeTypeOf("function");
  });

  it("resolves the generated wrapper in fresh parent and fork processes without import/list model effects", async () => {
    expect(process.version).toBe("v22.23.2");
    const repoRoot = process.cwd();
    const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const factorySource = `let factoryCalls = 0; let generationCalls = 0; let runCaseCalls = 0;
export function getCounts() { return { factoryCalls, generationCalls, runCaseCalls }; }
export function createE2EApplicationCliHost({ launchContext }) {
  return { profileId: launchContext.cliHost.profileId, descriptor: launchContext.cliHost.descriptor,
    modelFactory() { factoryCalls += 1; return { provider: "agentx-e2e", modelId: "fixture-route", specificationVersion: "v4", async doGenerate() { generationCalls += 1; return { installedAdapter: true }; } }; },
    async runCase() { runCaseCalls += 1; } };
}`;
    const factoryBytes = Buffer.from(factorySource);
    const fixture = createCompiledApiApplicationFixture({ modelRoute: { routeId: "fixture-route", routeRevision: "fixture-route-r1" }, hostManifestDigest: hash(factoryBytes) });
    const compiled = fixture.compiled; const shard = compiled.shards[0]!;
    const root = await mkdtemp(join(repoRoot, "tests/.tmp-e2e-app-fresh-bootstrap-"));
    const packageRoot = join(root, "packages/verifier"); const projectRoot = join(root, "project");
    const verifierModules = join(packageRoot, "assets/application-runtime-v1");
    const nodeModules = join(root, "node_modules"); const scopedModules = join(nodeModules, "@agentx");
    const launchId = randomUUID();
    try {
      await mkdir(packageRoot, { recursive: true });
      await createE2EApplicationRuntimeAssets({ compiled, shardId: shard.shardId, launchId, ownedDirectory: projectRoot });
      await mkdir(verifierModules, { recursive: true }); await mkdir(scopedModules, { recursive: true });
      const sourceRoot = join(repoRoot, "packages/verifier/src"); const outputRoot = join(packageRoot, "dist");
      const sourceFiles: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) sourceFiles.push(path);
        }
      };
      await visit(sourceRoot);
      for (const sourcePath of sourceFiles) {
        const outputPath = join(outputRoot, relative(sourceRoot, sourcePath).replace(/\.ts$/u, ".js"));
        await mkdir(dirname(outputPath), { recursive: true });
        const source = await readFile(sourcePath, "utf8");
        const output = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
        await writeFile(outputPath, output);
      }
      await symlink(join(repoRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
      await symlink(join(packageRoot), join(scopedModules, "verifier"), "dir");
      await symlink(join(repoRoot, "node_modules/e2e"), join(nodeModules, "e2e"), "dir");
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@agentx/verifier", type: "module", exports: "./dist/index.js" }));
      const descriptor = compiled.cliHost.descriptor; const profileId = compiled.cliHost.profileId;
      const installedHostRoot = join(packageRoot, "assets/application-runtime-v1");
      await mkdir(join(installedHostRoot, "hosts"), { recursive: true });
      await writeFile(join(installedHostRoot, "hosts/api-host.mjs"), factoryBytes);
      await writeFile(join(installedHostRoot, "cli-hosts.json"), JSON.stringify({ schemaVersion: "application-cli-host-registry/v1", hosts: [
        { profileId, entryPointId: descriptor.entryPointId, entryPointManifestDigest: hash(factoryBytes), modulePath: "assets/application-runtime-v1/hosts/api-host.mjs" }] }));

      const privateRoot = join(projectRoot, ".agentx/e2e");
      const runtime = [...compiled.runtimeBindings.values()][0]!;
      const bindingDigest = hash(canonicalJson(fixture.binding));
      const launch = { schemaVersion: "e2e-application-cli-launch/v1", launchId, shardId: shard.shardId,
        compiledInventoryDigest: shard.inventory.digest, groupCompiledInventoryDigest: compiled.inventory.digest,
        bindingDigest, roundId: fixture.binding.roundId, runId: fixture.binding.runId,
        cliHost: compiled.cliHost, selectedTarget: compiled.runtimeAdmissionContext.executionPlan.effectiveTargets.find((target) => target.targetId === shard.targetId)!,
        transportId: "fixture-private-transport", transportCorrelationId: runtime.transportCorrelationId,
        deadlineAt: fixture.round.deadlineAt };
      const inventory = { schemaVersion: "e2e-application-cli-inventory/v1", compiledInventoryDigest: shard.inventory.digest,
        shardId: shard.shardId, inventory: shard.inventory, selection: shard.selection, expectedCases: shard.expectedCases };
      for (const [name, value] of [["application-cli-launch.json", launch], ["application-cli-inventory.json", inventory]] as const) {
        const path = join(privateRoot, name); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600);
      }
      const projectPackageModules = join(projectRoot, "node_modules"); await mkdir(projectPackageModules);
      await symlink(join(nodeModules, "e2e"), join(projectPackageModules, "e2e"), "dir");
      await mkdir(join(projectPackageModules, "@agentx")); await symlink(join(packageRoot), join(projectPackageModules, "@agentx/verifier"), "dir");
      const scriptPath = join(root, "fresh-process.mjs");
const script = `import { fork } from "node:child_process"; import { fileURLToPath, pathToFileURL } from "node:url"; import process from "node:process";
async function resolveListAndGenerate() {
  const imported = await import(pathToFileURL(process.env.E2E_FIXTURE_CONFIG).href); const config = imported.default;
  const { resolveConfig } = await import(process.env.E2E_FIXTURE_RESOLVER);
  const resolved = resolveConfig(config, { projectRoot: process.env.E2E_FIXTURE_PROJECT });
  const { list } = await import("e2e/runner");
  const listed = await list({ cwd: process.env.E2E_FIXTURE_PROJECT, config, files: Array.isArray(config.tests) ? config.tests : [config.tests] });
  const factory = await import(pathToFileURL(process.env.E2E_FIXTURE_FACTORY).href);
  const beforeGenerate = factory.getCounts(); const generated = await config.agents.default.model.doGenerate({ prompt: "conformance" });
  return { configDigest: resolved.configDigest, apiBaseOrigin: resolved.targets[0]?.app?.base?.origin ?? null, listed, beforeGenerate, generated, afterGenerate: factory.getCounts(), execArgv: process.execArgv, version: process.version, execPath: process.execPath };
}
if (process.argv[2] === "worker") { process.send(await resolveListAndGenerate()); process.disconnect(); }
else { const parent = await resolveListAndGenerate(); const child = fork(fileURLToPath(import.meta.url), ["worker"], { cwd: process.env.E2E_FIXTURE_PROJECT, execArgv: [],
  env: process.env, stdio: ["ignore", "ignore", "inherit", "ipc"] }); const worker = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
  await new Promise((resolve, reject) => { child.once("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error("fresh worker exited " + code))); });
  process.send({ parent, worker }); process.disconnect(); }
`;
      await writeFile(scriptPath, script);
      const configPath = join(projectRoot, "e2e.config.mjs");
      await readFile(configPath);
      const factoryPath = join(installedHostRoot, "hosts/api-host.mjs");
      const resolverPath = pathToFileURL(join(repoRoot, "node_modules/e2e/dist/config/resolve.js")).href;
      const childEnv = { PATH: process.env.PATH ?? "", E2E_FIXTURE_CONFIG: configPath, E2E_FIXTURE_PROJECT: projectRoot,
        E2E_FIXTURE_FACTORY: factoryPath, E2E_FIXTURE_RESOLVER: resolverPath };
      const parent = fork(scriptPath, ["parent"], { cwd: projectRoot, execArgv: [], env: childEnv, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const processResultSchema = z.object({ version: z.string(), execPath: z.string(), execArgv: z.array(z.string()), configDigest: z.string(),
        apiBaseOrigin: z.string().nullable(), beforeGenerate: z.object({ factoryCalls: z.number(), generationCalls: z.number(), runCaseCalls: z.number() }).strict(),
        generated: z.object({ installedAdapter: z.literal(true) }).strict(),
        afterGenerate: z.object({ factoryCalls: z.number(), generationCalls: z.number(), runCaseCalls: z.number() }).strict(), listed: z.unknown() }).strict();
      const resultSchema = z.object({ parent: processResultSchema, worker: processResultSchema }).strict();
      const [rawResult] = await new Promise<[unknown]>((resolveMessage, reject) => {
        parent.once("message", (message: unknown) => resolveMessage([message])); parent.once("error", reject);
        parent.once("exit", (code) => { if (code !== 0) reject(new Error(`fresh parent exited before result with ${code}`)); });
      });
      const result = resultSchema.parse(rawResult);
      await new Promise<void>((resolveExit, reject) => { parent.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`fresh parent exited ${code}`))); });
      for (const processResult of [result.parent, result.worker]) {
        expect(processResult.version).toBe("v22.23.2"); expect(processResult.execPath).toBe(process.execPath); expect(processResult.execArgv).toEqual([]);
        expect(processResult.configDigest).toBe(shard.expectedConfigDigest);
        expect(processResult.apiBaseOrigin).toBeNull();
        expect(processResult.beforeGenerate).toEqual({ factoryCalls: 0, generationCalls: 0, runCaseCalls: 0 });
        expect(processResult.generated).toEqual({ installedAdapter: true });
        expect(processResult.afterGenerate).toEqual({ factoryCalls: 1, generationCalls: 1, runCaseCalls: 0 });
      }
      expect(result.parent.listed).toEqual(result.worker.listed);
      const installedBootstrap = (await import(pathToFileURL(join(packageRoot, "dist/application-runtime-bootstrap.js")).href)) as InstalledBootstrap;
      const launchPath = join(privateRoot, "application-cli-launch.json");
      const accountMismatch = { ...launch, selectedTarget: { ...launch.selectedTarget, accountProfileId: "foreign-account-profile" } };
      await writeFile(launchPath, JSON.stringify(accountMismatch), { mode: 0o600 }); await chmod(launchPath, 0o600);
      await expect(installedBootstrap.prepareE2EApplicationCliConfig({ configUrl: pathToFileURL(configPath).href })).rejects.toThrow(/declaration|inventory/u);
      const platformMismatch = { ...launch, selectedTarget: { targetId: launch.selectedTarget.targetId,
        applicationId: launch.selectedTarget.applicationId, runtimeProfileId: launch.selectedTarget.runtimeProfileId,
        accountProfileId: launch.selectedTarget.accountProfileId, kind: "contract", requestedTargetId: "api-target",
        adapterProfileId: "wrong-adapter" } };
      await writeFile(launchPath, JSON.stringify(platformMismatch), { mode: 0o600 }); await chmod(launchPath, 0o600);
      await expect(installedBootstrap.prepareE2EApplicationCliConfig({ configUrl: pathToFileURL(configPath).href })).rejects.toThrow(/target|platform|declaration/u);

      const actualFixture = createCompiledApiApplicationFixture({ now: new Date(Date.now() - 10_000).toISOString(), hostManifestDigest: hash(factoryBytes) });
      const actualCompiled = actualFixture.compiled; const actualShard = actualCompiled.shards[0]!;
      const transportId = "fixed-test-transport"; const transportCorrelationId = randomUUID();
      const assignmentRoot = join(root, "assigned-launches"); const correlationRoot = join(assignmentRoot, transportCorrelationId);
      await mkdir(correlationRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(installedHostRoot, "supervisor-spools.json"), JSON.stringify({ schemaVersion: "e2e-application-supervisor-spools/v1",
        entries: [{ profileId, descriptor, transportId, assignmentRoot, ownerUid: process.getuid!() }] }), { mode: 0o600 });
      const actualBindingDigest = hash(canonicalJson(actualFixture.binding));
      const assignedLaunch = { schemaVersion: "e2e-application-cli-launch/v1", launchId: randomUUID(), shardId: actualShard.shardId,
        compiledInventoryDigest: actualShard.inventory.digest, groupCompiledInventoryDigest: actualCompiled.inventory.digest,
        bindingDigest: actualBindingDigest, roundId: actualFixture.binding.roundId, runId: actualFixture.binding.runId, cliHost: actualCompiled.cliHost,
        selectedTarget: actualCompiled.runtimeAdmissionContext.executionPlan.effectiveTargets.find((target) => target.targetId === actualShard.targetId)!,
        transportId, transportCorrelationId, deadlineAt: actualFixture.round.deadlineAt };
      const assignedLaunches = [assignedLaunch];
      await writeFile(join(correlationRoot, "launch-assignment.json"), canonicalJson({ schemaVersion: "e2e-application-cli-launch-assignment/v1",
        bindingDigest: actualBindingDigest, groupCompiledInventoryDigest: actualCompiled.inventory.digest,
        preparedEnvironmentDigest: actualCompiled.preparedEnvironmentDigest, transportId, transportCorrelationId,
        deadlineAt: actualFixture.round.deadlineAt, launches: assignedLaunches }), { mode: 0o600 });
      const actualEvidenceDirectory = join(root, "actual-default-cli-evidence"); await mkdir(actualEvidenceDirectory, { mode: 0o700 });
      const installedRunner = (await import(pathToFileURL(join(packageRoot, "dist/application-runtime-cli.js")).href)) as InstalledRunner;
      await writeFile(join(correlationRoot, "launch-assignment.json"), canonicalJson({ schemaVersion: "e2e-application-cli-launch-assignment/v1",
        bindingDigest: actualBindingDigest, groupCompiledInventoryDigest: actualCompiled.inventory.digest,
        preparedEnvironmentDigest: actualCompiled.preparedEnvironmentDigest, transportId, transportCorrelationId,
        deadlineAt: actualFixture.round.deadlineAt, launches: [{ ...assignedLaunch, deadlineAt: new Date(Date.parse(actualFixture.round.deadlineAt) - 1_000).toISOString() }] }), { mode: 0o600 });
      await expect(installedRunner.runE2EApplicationActualCli({ compiled: actualCompiled, snapshot: actualFixture.snapshot,
        binding: actualFixture.binding, round: actualFixture.round,
        runnerToolchain: ProjectSetupRunnerToolchainSchema.parse({ execPath: process.execPath, version: process.version,
          platform: process.platform, arch: process.arch }), evidenceDirectory: actualEvidenceDirectory,
        supervisorAssignment: { transportId, transportCorrelationId }, signal: new AbortController().signal })).rejects.toThrow();
      expect(await readdir(actualEvidenceDirectory)).toEqual([]);
      await writeFile(join(correlationRoot, "launch-assignment.json"), canonicalJson({ schemaVersion: "e2e-application-cli-launch-assignment/v1",
        bindingDigest: actualBindingDigest, groupCompiledInventoryDigest: actualCompiled.inventory.digest,
        preparedEnvironmentDigest: actualCompiled.preparedEnvironmentDigest, transportId, transportCorrelationId,
        deadlineAt: actualFixture.round.deadlineAt, launches: assignedLaunches }), { mode: 0o600 });
      const actualRun = await installedRunner.runE2EApplicationActualCli({ compiled: actualCompiled, snapshot: actualFixture.snapshot,
        binding: actualFixture.binding, round: actualFixture.round,
        runnerToolchain: ProjectSetupRunnerToolchainSchema.parse({ execPath: process.execPath, version: process.version,
          platform: process.platform, arch: process.arch }), evidenceDirectory: actualEvidenceDirectory,
        supervisorAssignment: { transportId, transportCorrelationId }, signal: new AbortController().signal });
      expect(actualRun.shards.map((item) => item.shardId)).toEqual([actualShard.shardId]);
      expect(actualRun.shards).toHaveLength(1);
      const actualShardRun = actualRun.shards[0]!;
      expect(actualShardRun.listProcess).toMatchObject({ status: 0, signal: null, timedOut: false, aborted: false });
      expect(actualShardRun.runProcess).toMatchObject({ status: 0, signal: null, timedOut: false, aborted: false });
      const actualListBytes = JSON.parse(Buffer.from(actualShardRun.listStdoutBytes).toString("utf8")) as unknown;
      expect(actualListBytes).toEqual({ pairs: actualShardRun.publicList && typeof actualShardRun.publicList === "object"
        && "pairs" in actualShardRun.publicList ? actualShardRun.publicList.pairs : [] });
      const installedAdapter = await import(pathToFileURL(join(packageRoot, "dist/application-result-adapter.js")).href) as {
        normalizeE2EApplicationPublicList(raw: unknown, targetId: string): unknown;
      };
      expect(installedAdapter.normalizeE2EApplicationPublicList(actualListBytes, actualShard.selection.targetId)).toEqual(actualShardRun.publicList);
      const actualReport = JSON.parse(Buffer.from(actualShardRun.rawReportBytes).toString("utf8")) as {
        run?: { status?: string; exitCode?: number; summary?: { selected?: number; executed?: number; passed?: number };
          results?: Array<{ id?: string; status?: string; selected?: boolean }> };
      };
      expect(actualReport.run).toMatchObject({ status: "passed", exitCode: 0, summary: { selected: 1, executed: 1, passed: 1 } });
      expect(actualReport.run?.results).toHaveLength(1);
      expect(actualReport.run?.results?.[0]).toMatchObject({ id: actualShard.selection.tuples[0]!.upstreamResultId,
        status: "passed", selected: true });
      expect(actualRun.supervisorReadback).toBeNull();
      expect(actualRun.cleanupConfirmed).toBeNull();
      const completeReport = JSON.parse(Buffer.from(actualShardRun.rawReportBytes).toString("utf8")) as {
        run: { environment: { ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string };
          usage: Record<string, number>; limits: Record<string, number> };
      };
      const postCloseJoin = await import("../../packages/verifier/src/application-collection.js");
      const collectActual = (actual: E2EActualApplicationRun) => postCloseJoin.collectE2EApplicationRun({ actual, compiled: actualCompiled, binding: actualFixture.binding,
        round: actualFixture.round, environment: completeReport.run.environment, usage: completeReport.run.usage, limits: completeReport.run.limits,
        expectedSupervisorReceiptRefs: [], ownedResourceInventoryDigest: hash("conformance-owned-resource-inventory"),
        observationBindings: null, assertionAssets: [], governedModelReceipts: null, ownedClosedAt: null });
      const joined = collectActual(actualRun);
      expect(joined.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
      expect(joined.unavailableReason).toMatch(/readback|cleanup|owned/u);
      const mismatchedListRun = { ...actualRun, shards: actualRun.shards.map((shard) => ({ ...shard, publicList: { pairs: [] } })) };
      expect(collectActual(mismatchedListRun).unavailableReason).toMatch(/list bytes do not bind/u);
      const cancelledEvidenceDirectory = join(root, "cancelled-default-cli-evidence"); await mkdir(cancelledEvidenceDirectory, { mode: 0o700 });
      const cancelled = new AbortController(); cancelled.abort();
      await expect(installedRunner.runE2EApplicationActualCli({ compiled: actualCompiled, snapshot: actualFixture.snapshot,
        binding: actualFixture.binding, round: actualFixture.round,
        runnerToolchain: ProjectSetupRunnerToolchainSchema.parse({ execPath: process.execPath, version: process.version,
          platform: process.platform, arch: process.arch }), evidenceDirectory: cancelledEvidenceDirectory,
        supervisorAssignment: { transportId, transportCorrelationId }, signal: cancelled.signal })).rejects.toThrow();
      expect(await readdir(cancelledEvidenceDirectory)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses invalid compiled admission before allocating any runtime resource", async () => {
    const module = await import("../../packages/verifier/src/application-runtime.js").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    const allocate = vi.fn();
    const execute = vi.fn();
    const close = vi.fn();
    const readActualRun = vi.fn();
    await expect(module.runIsolatedE2EApplication({ input: {} as never, compiled: {} as never,
      ports: { allocate, execute, close, readActualRun } as never, signal: new AbortController().signal })).rejects.toThrow();
    expect(allocate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(readActualRun).not.toHaveBeenCalled();
  });

  it("binds the generated first-party reporter bytes to a fresh launch challenge", async () => {
    const assets = await import("../../packages/verifier/src/application-runtime-assets.js");
    expect(assets.expectedE2EApplicationReporterDigest("11111111-1111-4111-8111-111111111111"))
      .not.toBe(assets.expectedE2EApplicationReporterDigest("22222222-2222-4222-8222-222222222222"));
  });

  it("closes the owned generic lease before the parent reads final application proof", async () => {
    const module = await import("../../packages/verifier/src/application-runtime.js");
    const fixture = createCompiledApiApplicationFixture(); const { compiled, binding } = fixture;
    const applicationRef = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
    const app = compiled.applicationBindings.get(applicationRef.applicationId)!; const runtime = compiled.runtimeBindings.get(applicationRef.runtimeProfileId)!;
    const input = { binding, suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: compiled.expectedCases },
      profile: { profileId: runtime.profileId, kind: "api", runtimeManifestDigest: runtime.manifestDigest,
        applications: [{ applicationId: applicationRef.applicationId, appBuildManifestDigest: app.build.manifestDigest,
          appRecipe: app.approval.applications.find((item) => item.applicationId === applicationRef.applicationId)!.recipe }],
        networkPolicyDigest: runtime.capabilities.networkPolicyDigest, seedDigest: "a".repeat(64), limits: runtime.binding,
        capture: compiled.runtimeAdmissionContext.selectionInput.policy.capture }, modelPermit: null };
    const order: string[] = [];
    const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse({ execPath: process.execPath, version: process.version,
      platform: process.platform, arch: process.arch });
    const proof = { protocol: "e2e-actual-application-run/v1" as const, runnerToolchain, shards: [], applicationCaptures: [], supervisorReceiptRefs: [],
      declaredMockComponentIds: [], selected: 1, filtered: 0, supervisorReadback: { schemaVersion: "e2e-application-supervisor-readback/v1" as const,
        receipt: { ref: { artifactId: "r", sha256: "a".repeat(64), byteLength: 1, mediaType: "application/json" }, bytes: new Uint8Array([1]) }, evidence: [] },
      cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: "/offline" };
    const result = await module.runIsolatedE2EApplication({ input: input as never, compiled, signal: new AbortController().signal,
      ports: { allocate: async () => ({ leaseId: "owned-api", execute: async () => { order.push("execute"); return {
        process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: Uint8Array.from([1]), observedUpstreamRunId: "upstream",
        coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: fixture.now, finishedAt: fixture.now, cleanup: "confirmed" as const,
      }; }, close: async () => { order.push("close"); return { confirmed: true }; } }), readActualRun: async (signal: AbortSignal) => {
        expect(signal.aborted).toBe(false); order.push("readback"); return proof;
      } } });
    expect(order).toEqual(["execute", "close", "readback"]);
    expect(result.lifecycle.cleanup).toBe("confirmed");
    expect(result.actualRun).toBe(proof);
  });

  it("does not read after failed close and aborts a late private proof read at its independent cap", async () => {
    const module = await import("../../packages/verifier/src/application-runtime.js");
    const fixture = createCompiledApiApplicationFixture(); const { compiled, binding } = fixture;
    const applicationRef = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
    const app = compiled.applicationBindings.get(applicationRef.applicationId)!; const runtime = compiled.runtimeBindings.get(applicationRef.runtimeProfileId)!;
    const input = { binding, suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: compiled.expectedCases },
      profile: { profileId: runtime.profileId, kind: "api", runtimeManifestDigest: runtime.manifestDigest,
        applications: [{ applicationId: applicationRef.applicationId, appBuildManifestDigest: app.build.manifestDigest,
          appRecipe: app.approval.applications.find((item) => item.applicationId === applicationRef.applicationId)!.recipe }],
        networkPolicyDigest: runtime.capabilities.networkPolicyDigest, seedDigest: "a".repeat(64), limits: runtime.binding,
        capture: compiled.runtimeAdmissionContext.selectionInput.policy.capture }, modelPermit: null };
    const close = async () => ({ confirmed: false }); const readActualRun = vi.fn(async () => { throw new Error("must not read before close"); });
    const failedClose = await module.runIsolatedE2EApplication({ input: input as never, compiled, signal: new AbortController().signal,
      ports: { allocate: async () => ({ leaseId: "failed-close", execute: async () => ({ process: { exitCode: 0, timedOut: false, aborted: false },
        rawReport: Uint8Array.from([1]), observedUpstreamRunId: "upstream", coverageByCase: new Map(), artifacts: [], modelReceiptIds: [],
        startedAt: fixture.now, finishedAt: fixture.now, cleanup: "confirmed" as const }), close }), readActualRun } });
    expect(failedClose.lifecycle.cleanup).toBe("pending"); expect(failedClose.actualRun).toBeNull(); expect(readActualRun).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const controller = new AbortController(); let resolveLate!: (value: never) => void;
      const late = new Promise<never>((resolve) => { resolveLate = resolve; });
      const read = vi.fn((signal: AbortSignal) => { signal.addEventListener("abort", () => undefined, { once: true }); return late; });
      const run = module.runIsolatedE2EApplication({ input: input as never, compiled, signal: controller.signal,
        ports: { allocate: async () => ({ leaseId: "late-read", execute: async () => ({ process: { exitCode: 0, timedOut: false, aborted: false },
          rawReport: Uint8Array.from([1]), observedUpstreamRunId: "upstream", coverageByCase: new Map(), artifacts: [], modelReceiptIds: [],
          startedAt: fixture.now, finishedAt: fixture.now, cleanup: "confirmed" as const }), close: async () => ({ confirmed: true }) }), readActualRun: read } });
      await vi.advanceTimersByTimeAsync(30_000);
      const timedOut = await run;
      expect(read).toHaveBeenCalledOnce(); expect(timedOut.actualRun).toBeNull();
      resolveLate({} as never);
      await Promise.resolve();
      expect(timedOut.actualRun).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
