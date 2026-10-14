import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, realpath, rmdir, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, ProjectSetupRunnerToolchainSchema, type E2ESourceSnapshot, type ProjectSetupRunnerToolchain } from "@agentx/contracts";
import { compareE2EPublicList, type E2ESelectionPacket } from "./selection.js";
import { createE2ERuntimeAssets, createE2ERuntimeLaunchId, parseE2EFirstPartyCapture, type E2EFirstPartyCaptureResult } from "./runtime-assets.js";
import { validateE2ECompiledRuntimeAdmission, type E2ECompiledSuite } from "./scenarios.js";
import { createE2EWorkerSession } from "./runtime-session.js";
import { createE2EAppAdapterPacket } from "./runtime-adapter.js";
import { evaluateE2EAssertions } from "./runtime-assertions.js";
import { runContainedCandidate } from "./contained-candidate.js";
import { CONTAINED_RUNTIME_PROFILE } from "./container-envelope.js";

const MAX_OUTPUT = 4 * 1024 * 1024;
// This module is installed under <runtime-root>/packages/verifier/{src,dist}; derive the packaged
// root from its own location so unsupported test hosts never mistake a mounted candidate for the
// worker installation when no portable runtime profile exists. Keep URL resolution lazy because
// this module is also bundled into CommonJS Lambdas that only import its pure parsers.
function packagedRuntimeRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}
const INSTALL_QUALIFICATION_SOURCE_SHA256 = "a7b170213977472347a52646b1d7980a312fa68d08fc52cbbfb48c0b0571b7cd";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeOwnedFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

function runProcess(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer; startedAt: string; finishedAt: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = new Date().toISOString();
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    const onAbort = () => { aborted = true; child.kill("SIGTERM"); };
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.byteLength; if (outBytes <= MAX_OUTPUT) out.push(Buffer.from(chunk)); else child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.byteLength; if (errBytes <= MAX_OUTPUT) err.push(Buffer.from(chunk)); else child.kill("SIGTERM"); });
    child.once("error", (error) => { clearTimeout(timer); options.signal.removeEventListener("abort", onAbort); rejectRun(error); });
    child.once("close", (status, signal) => { clearTimeout(timer); options.signal.removeEventListener("abort", onAbort); resolveRun({ status, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), startedAt, finishedAt: new Date().toISOString(), timedOut, aborted }); });
  });
}

export type E2EActualCliRun = Readonly<{
  launchId: string;
  runnerToolchain: ProjectSetupRunnerToolchain;
  launchConfigDigest: string;
  fixedAssetDigests: Readonly<Record<string, string>>;
  publicList: unknown;
  listStdoutBytes: Uint8Array;
  listStderrBytes: Uint8Array;
  selected: number;
  filtered: number;
  rawReportBytes: Uint8Array;
  runStderrBytes: Uint8Array;
  runStartCaptureBytes: Uint8Array;
  runStartCapture: E2EFirstPartyCaptureResult;
  assertionReceipts: readonly unknown[];
  declaredMockComponentIds: readonly string[];
  candidateCaptures: readonly Readonly<Record<string, unknown>>[];
  listProcess: Readonly<{ status: number | null; signal: NodeJS.Signals | null; startedAt: string; finishedAt: string; stdoutSha256: string; stderrSha256: string }>;
  runProcess: Readonly<{ status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; startedAt: string; finishedAt: string; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number }>;
  cleanupConfirmed: boolean;
  cleanupServerListening: boolean;
  evidenceDirectory: string;
}>;

/** Launch the pinned public e2e CLI with the immutable generated suite and an authenticated host bridge. */
type E2EActualCliInput = Readonly<{
  compiled: E2ECompiledSuite;
  snapshot: E2ESourceSnapshot;
  selection: E2ESelectionPacket;
  runnerToolchain: ProjectSetupRunnerToolchain;
  hostRequestIds: ReadonlyMap<string, string>;
  /** Host-generated fresh challenge-bound probe payloads for the packaged installation qualifier. */
  hostProbeInputs?: ReadonlyMap<string, unknown>;
  sourceRoot: string;
  evidenceDirectory: string;
  deadlineAt: number;
  signal: AbortSignal;
  /** Host-only observer for a positively owned live candidate process; never sourced from app or invocation data. */
  onOwnedContainerRunning?: (receipt: Readonly<{ containerId: string; requestId: string; sourceDigest: string; observedAt: string; inspectBytes: Uint8Array }>) => Promise<void>;
}>;
export async function runE2EActualCli(input: E2EActualCliInput): Promise<E2EActualCliRun> {
  return runE2EActualCliWithSessionFactory(input, createE2EWorkerSession);
}

/** Links dependencies from the installed worker package root, never from a mounted candidate checkout. */
export async function linkInstalledRuntimeDependencies(project: string, _sourceRoot: string): Promise<string> {
  void _sourceRoot;
  const installedRuntimeRoot = CONTAINED_RUNTIME_PROFILE?.installedRuntimeRoot ?? packagedRuntimeRoot();
  const dependencyRoot = join(installedRuntimeRoot, "node_modules");
  const info = await import("node:fs/promises").then(({ lstat }) => lstat(dependencyRoot));
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dependencyRoot) !== dependencyRoot) throw new Error("installed runner dependencies are unavailable at the fixed runtime root");
  await symlink(dependencyRoot, join(project, "node_modules"), "dir");
  return dependencyRoot;
}

/** Trusted-host-only runner seam for proving cleanup-pending qualification; never receives app data. */
export async function runE2EActualCliWithSessionFactory(input: E2EActualCliInput, sessionFactory: typeof createE2EWorkerSession): Promise<E2EActualCliRun> {
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(input.runnerToolchain);
  if (runnerToolchain.version !== process.version || runnerToolchain.execPath !== process.execPath
    || runnerToolchain.platform !== process.platform || runnerToolchain.arch !== process.arch
    || process.version !== "v22.23.2" || !isAbsolute(runnerToolchain.execPath)) throw new Error("actual E2E runner differs from its exact ready-registry Node toolchain identity");
  const snapshot = validateE2ECompiledRuntimeAdmission(input.compiled, input.snapshot);
  if (input.hostProbeInputs !== undefined) validateInstallQualificationProbeInputs(input.compiled, snapshot, input.hostRequestIds, input.hostProbeInputs);
  const evidenceDirectory = resolve(input.evidenceDirectory);
  const installedRuntimeRoot = CONTAINED_RUNTIME_PROFILE?.installedRuntimeRoot ?? packagedRuntimeRoot();
  if (!isAbsolute(installedRuntimeRoot)) throw new Error("installed runner root must be an absolute trusted runtime path");
  if (await realpath(evidenceDirectory) !== evidenceDirectory) throw new Error("acceptance evidence directory must be canonical");
  const evidenceInfo = await import("node:fs/promises").then(({ lstat }) => lstat(evidenceDirectory));
  if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink() || (evidenceInfo.mode & 0o077) !== 0 || evidenceInfo.uid !== process.getuid?.()) throw new Error("acceptance evidence directory must be a fresh private owned directory");
  if (input.deadlineAt <= Date.now()) throw new Error("actual runner launch deadline has elapsed");
  const launchId = createE2ERuntimeLaunchId();
  const project = join(evidenceDirectory, `project-${randomBytes(6).toString("hex")}`);
  const tmp = join(evidenceDirectory, `tmp-${randomBytes(6).toString("hex")}`);
  const home = join(evidenceDirectory, `home-${randomBytes(6).toString("hex")}`);
  await mkdir(project, { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await linkInstalledRuntimeDependencies(project, input.sourceRoot);
  const capturePath = join(project, `run-start-${launchId}.jsonl`);
  const bridgePath = join(project, "worker-bridge.mjs");
  const assetPaths = { launchId, capturePath, workerBridgePath: bridgePath };
  const assets = createE2ERuntimeAssets(input.compiled, assetPaths);
  for (const [path, content] of input.compiled.files) {
    const output = join(project, path);
    await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
    await writeOwnedFile(output, content);
    if (sha(await readFile(output)) !== sha(Buffer.from(content))) throw new Error("materialized compiler asset failed exact-byte readback before CLI discovery");
  }
  for (const [name, content] of Object.entries(assets.assets)) await writeOwnedFile(join(project, name), content);
  const adapterPackets = new Map<string, ReturnType<typeof createE2EAppAdapterPacket>>();
  const adapterPrimaryPaths = new Map<string, string>();
  for (const expected of input.compiled.expectedCases) {
    const scenario = input.compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    if (!scenario) throw new Error("pre-execution suite case has no immutable scenario");
    const packet = createE2EAppAdapterPacket({ compiled: input.compiled, snapshot, caseId: expected.caseId, mode: scenario.steps[0]?.kind === "inspect-contract" ? "inspect" : "feature", mockSpecs: input.compiled.group.mocks });
    if (packet.status !== "ready" || !packet.packet) throw new Error(packet.reason ?? "candidate adapter is unavailable");
    const packetPrimary = join(evidenceDirectory, `packet-${sha(Buffer.from(expected.caseId)).slice(0, 20)}`);
    await mkdir(packetPrimary, { mode: 0o700 });
    const packetFiles = [] as Array<{ path: string; sha256: string; byteLength: number }>;
    for (const file of packet.packet.files) {
      const absolute = join(packetPrimary, file.path);
      await mkdir(join(absolute, ".."), { recursive: true, mode: 0o700 });
      await writeOwnedFile(absolute, file.bytes);
      const readback = await readFile(absolute);
      if (sha(readback) !== file.sha256 || readback.byteLength !== file.bytes.byteLength) throw new Error("candidate adapter packet byte readback changed before any CLI execution");
      packetFiles.push({ path: file.path, sha256: file.sha256, byteLength: file.bytes.byteLength });
    }
    const packetPrimaryManifest = { schemaVersion: "candidate-adapter-packet-primary/v1", caseId: expected.caseId, originalSourceDigest: packet.originalSourceDigest, adapterDigest: packet.adapterDigest, declaredMockComponentIds: packet.declaredMockComponentIds, groupMockManifestDigest: input.compiled.group.mockManifestDigest, files: packetFiles };
    await writeOwnedFile(join(packetPrimary, "packet-manifest.json"), `${JSON.stringify(packetPrimaryManifest, null, 2)}\n`);
    adapterPackets.set(expected.caseId, packet);
    adapterPrimaryPaths.set(expected.caseId, packetPrimary);
  }
  const harnessSourcePath = process.argv[1];
  const harnessPrimary = harnessSourcePath && resolve(harnessSourcePath) !== harnessSourcePath
    ? null
    : harnessSourcePath ? join(evidenceDirectory, `host-harness-${launchId}${harnessSourcePath.endsWith(".mts") ? ".mts" : ".js"}`) : null;
  let harnessDigest: string | null = null;
  if (harnessSourcePath && harnessPrimary) {
    const harnessBytes = await readFile(harnessSourcePath);
    harnessDigest = sha(harnessBytes);
    await writeOwnedFile(harnessPrimary, harnessBytes);
    if (sha(await readFile(harnessPrimary)) !== harnessDigest) throw new Error("pre-execution harness source primary failed byte readback");
  }
  const declaredMockComponentIds = [...new Set([...adapterPackets.values()].flatMap((packet) => packet.declaredMockComponentIds))].sort();
  const preExecution = { schemaVersion: "e2e-pre-execution-primary/v1", launchId, runnerToolchain, candidate: { candidateDigest: snapshot.candidate.digest, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, planDigest: input.compiled.bundle.planDigest, sourceSnapshot: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256, byteLength: item.bytes.byteLength, kind: item.kind })) }, compiler: { inventory: input.compiled.inventory, files: [...input.compiled.files].map(([path, content]) => ({ path, sha256: sha(Buffer.from(content)), byteLength: Buffer.byteLength(content) })) }, runtime: { launchConfigDigest: assets.launchConfigDigest, fixedAssetDigests: assets.assetDigests }, selection: input.selection, requests: [...input.compiled.hostRequestPayloads].map(([caseId, payload]) => ({ caseId, payload, payloadSha256: sha(Buffer.from(canonicalJson(payload))), logicalRequestId: input.hostRequestIds.get(caseId) ?? null })), assertions: input.compiled.expectedCases.map((expected) => ({ caseId: expected.caseId, assertionDigests: expected.assertionDigests })), adapterPrimaries: [...adapterPrimaryPaths].map(([caseId, path]) => ({ caseId, path })), declaredMockComponentIds, observedConsumedMockComponentIds: [], harnessSource: harnessPrimary ? { path: harnessPrimary, sha256: harnessDigest } : null };
  await writeOwnedFile(join(evidenceDirectory, `pre-execution-${launchId}.json`), `${JSON.stringify(preExecution, null, 2)}\n`);
  const cliPath = join(installedRuntimeRoot, "node_modules/e2e/dist/cli/bin.js");
  const pkg = JSON.parse(await readFile(join(installedRuntimeRoot, "node_modules/e2e/package.json"), "utf8")) as { version?: unknown };
  if (pkg.version !== "0.20.0") throw new Error("installed e2e package does not match pinned 0.20.0");
  const capability = randomBytes(32).toString("hex");
  const sessionDirectory = await import("node:fs/promises").then(async ({ mkdtemp, chmod, realpath }) => { const dir = await mkdtemp("/tmp/e2es-"); await chmod(dir, 0o700); return realpath(dir); });
  const expectedByCase = new Map([...input.compiled.hostRequestPayloads].map(([caseId, payload]) => [caseId, { payload }]));
  const receiptRows: unknown[] = [];
  const captures: Readonly<Record<string, unknown>>[] = [];
  const session = await sessionFactory({ directory: sessionDirectory, capability, expectedByCase, deadlineAt: input.deadlineAt, signal: input.signal, handle: async (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("worker observation request is malformed");
    const record = payload as Record<string, unknown>;
    const caseId = typeof record.caseId === "string" ? record.caseId : "";
    const expected = input.compiled.expectedCases.find((item) => item.caseId === caseId);
    const scenario = expected && input.compiled.bundle.scenarios.find((item) => item.scenarioId === expected.scenarioId);
    const hostRequestId = input.hostRequestIds.get(caseId);
    if (!expected || !scenario || !hostRequestId) throw new Error("worker request has no independently admitted source or request identity");
    const packet = adapterPackets.get(caseId);
    if (!packet || packet.status !== "ready" || !packet.packet) throw new Error(packet?.reason ?? "candidate adapter is unavailable");
    const packetPrimary = adapterPrimaryPaths.get(caseId);
    if (!packetPrimary) throw new Error("candidate adapter evidence primary was not pre-created");
    const execution = await runContainedCandidate(packet.packet, { requestId: hostRequestId, input: input.hostProbeInputs?.has(caseId) ? input.hostProbeInputs.get(caseId) : expected && scenario.steps[0]?.kind === "invoke-contract" ? scenario.steps[0].input : null }, {
      signal: input.signal, ...(input.onOwnedContainerRunning === undefined ? {} : { onOwnedContainerRunning: input.onOwnedContainerRunning }),
    });
    const observation = execution.observation;
    if (!observation || execution.receipt.cleanup !== "confirmed") {
      if (execution.receipt.aborted && execution.receipt.requestWritten === false && execution.receipt.cleanup === "confirmed") {
        await writeOwnedFile(join(evidenceDirectory, `pre-request-abort-${sha(Buffer.from(hostRequestId)).slice(0, 20)}.json`),
          `${JSON.stringify({ evidenceType: "contained-candidate-pre-request-abort/v1", requestId: hostRequestId,
            phase: "owned-container-running-before-candidate-stdin", requestWritten: execution.receipt.requestWritten,
            aborted: execution.receipt.aborted, cleanup: execution.receipt.cleanup, containerId: execution.receipt.containerId,
            sourceDigest: execution.receipt.sourceDigest, recordRef: execution.receipt.recordRef }, null, 2)}\n`);
      }
      throw new Error("contained candidate observation or owned cleanup confirmation is unavailable");
    }
    const rawFrame = observation.capture.stdoutFrame;
    const assertionRows = scenario.assertions.map((assertion, index) => {
      if (!("equals" in assertion)) throw new Error("external every-index oracle does not support this assertion variant");
      return { index, digest: expected.assertionDigests[index] ?? "", expectedResponse: assertion.equals };
    });
    const receipts = evaluateE2EAssertions({ responseBytes: rawFrame, assertions: assertionRows });
    if (receipts.length !== assertionRows.length || assertionRows.length === 0) throw new Error("contained candidate observation or complete independent assertion receipts are unavailable");
    const receiptPath = join(evidenceDirectory, `case-${sha(Buffer.from(caseId)).slice(0, 20)}-receipts.json`);
    const capturePath = join(evidenceDirectory, `case-${sha(Buffer.from(caseId)).slice(0, 20)}-capture.json`);
    await writeOwnedFile(receiptPath, `${JSON.stringify({ caseId, assertionReceipts: receipts }, null, 2)}\n`);
    const capture = { caseId, logicalRequestId: hostRequestId, wireId: observation.capture.wireId, packetSourceDigest: execution.receipt.sourceDigest, originalSourceDigest: packet.originalSourceDigest, adapterDigest: packet.adapterDigest, declaredMockComponentIds: packet.declaredMockComponentIds, packetPrimaryDirectory: packetPrimary, candidateObservation: observation.output, receipt: execution.receipt, capture: { requestBytes: observation.capture.requestBytes, requestSha256: observation.capture.requestSha256, requestFrameBase64: Buffer.from(observation.capture.requestFrame).toString("base64"), stdoutBytes: observation.capture.stdoutBytes, stdoutSha256: observation.capture.stdoutSha256, stdoutFrameBase64: Buffer.from(rawFrame).toString("base64"), stderrBytes: observation.capture.stderrBytes, stderrSha256: observation.capture.stderrSha256, stderrFrameBase64: Buffer.from(observation.capture.stderrFrame).toString("base64"), times: observation.capture.times }, assertionReceiptPath: receiptPath };
    await writeOwnedFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
    receiptRows.push(...receipts.map((item) => ({ caseId, ...item as object })));
    captures.push(capture);
    return observation.output;
  } });
  const env: NodeJS.ProcessEnv = { PATH: CONTAINED_RUNTIME_PROFILE?.commandPath ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, CI: "1", E2E_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", AGENTX_E2E_SOCKET: session.socketPath, AGENTX_E2E_WORKER_CAPABILITY: capability, NODE_OPTIONS: `--import=${bridgePath}` };
  const config = join(project, "runtime-config.mjs");
  const listArgs = [cliPath, "list", "--config", config, "--reporter", "json"];
  const runArgs = [cliPath, "run", "--config", config, "--reporter", "json", "--output", ".agentx-run-output", "--no-cache", "--workers", "1", "--retries", "0"];
  try {
    const list = await runProcess(runnerToolchain.execPath, listArgs, { cwd: project, env, timeoutMs: Math.max(1, Math.min(60_000, input.deadlineAt - Date.now())), signal: input.signal });
    if (list.status !== 0 || list.signal || list.timedOut || list.aborted) throw new Error("actual pinned CLI list did not complete cleanly");
    await writeOwnedFile(join(evidenceDirectory, `public-list-${launchId}.json`), list.stdout);
    await writeOwnedFile(join(evidenceDirectory, `public-list-stderr-${launchId}.bin`), list.stderr);
    const cliList: unknown = JSON.parse(list.stdout.toString("utf8")) as unknown;
    const { list: upstreamList } = await import("e2e/runner");
    const publicList = await upstreamList({ cwd: project, config, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, CI: env.CI } });
    const publicListPath = join(evidenceDirectory, `full-public-list-${launchId}.json`);
    await writeOwnedFile(publicListPath, `${JSON.stringify(publicList, null, 2)}\n`);
    const selectedListRows = (publicList as { pairs?: readonly { disposition?: string }[] }).pairs?.filter((pair) => pair.disposition === "run" || pair.disposition === "skip") ?? [];
    const cliPairs = cliList && typeof cliList === "object" && !Array.isArray(cliList) && Array.isArray((cliList as Record<string, unknown>).pairs)
      ? (cliList as Record<string, unknown>).pairs as unknown[] : undefined;
    const withoutCliSourceLocation = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const { source, ...identity } = value as Record<string, unknown>;
      const row = value as Record<string, unknown>;
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("CLI list source provenance is missing or malformed");
      const location = source as Record<string, unknown>;
      if (location.file !== row.file || !Number.isSafeInteger(location.line) || (location.line as number) < 1
        || !Number.isSafeInteger(location.column) || (location.column as number) < 1
        || typeof row.file !== "string" || !input.compiled.files.has(row.file)) throw new Error("CLI list source file or coordinate is not bound to its materialized generated file");
      return { ...identity, source: { file: location.file } };
    };
    if (!cliPairs || canonicalJson(cliPairs.map(withoutCliSourceLocation)) !== canonicalJson(selectedListRows.map(withoutCliSourceLocation))) {
      const mismatchIndex = cliPairs?.findIndex((row, index) => canonicalJson(withoutCliSourceLocation(row)) !== canonicalJson(withoutCliSourceLocation(selectedListRows[index] ?? null))) ?? -1;
      const cliRow = mismatchIndex >= 0 && cliPairs?.[mismatchIndex] && typeof cliPairs[mismatchIndex] === "object" ? cliPairs[mismatchIndex] as Record<string, unknown> : {};
      const apiRow = mismatchIndex >= 0 && selectedListRows[mismatchIndex] && typeof selectedListRows[mismatchIndex] === "object" ? selectedListRows[mismatchIndex] as Record<string, unknown> : {};
      const differingKeys = [...new Set([...Object.keys(cliRow), ...Object.keys(apiRow)].filter((key) => key !== "source"))].filter((key) => canonicalJson(cliRow[key] ?? null) !== canonicalJson(apiRow[key] ?? null));
      throw new Error(`public CLI list selected tuple identities differ from pinned runner list API (cli=${cliPairs?.length ?? 0},api=${selectedListRows.length},index=${mismatchIndex},keys=${differingKeys.join(",")})`);
    }
    // Reparse the exact persisted API packet so collection receives ordinary JSON data, not runner-owned instances.
    const publicListSnapshot: unknown = JSON.parse(await readFile(publicListPath, "utf8"));
    const selected = compareE2EPublicList(input.selection, publicListSnapshot);
    const execution = await runProcess(runnerToolchain.execPath, runArgs, { cwd: project, env, timeoutMs: Math.max(1, Math.min(60_000, input.deadlineAt - Date.now())), signal: input.signal });
    await writeOwnedFile(join(evidenceDirectory, `raw-report-${launchId}.json`), execution.stdout);
    await writeOwnedFile(join(evidenceDirectory, `raw-run-stderr-${launchId}.bin`), execution.stderr);
    const captureBytes = await readFile(capturePath).catch(() => Buffer.alloc(0));
    const runStartCapture = parseE2EFirstPartyCapture(captureBytes, launchId);
    const cleanupConfirmed = await session.close();
    const cleanupReadback = session.readback();
    const receipt = { evidenceType: "actual-pinned-e2e-cli-runtime/v1", launchId, node: { ...runnerToolchain, argv: process.argv }, cli: { path: cliPath, version: pkg.version, listArgv: listArgs, runArgv: runArgs }, runtime: { launchConfigDigest: assets.launchConfigDigest, compilerConfigDigest: input.compiled.expectedConfigDigest, fixedAssetDigests: assets.assetDigests }, list: { status: list.status, signal: list.signal, stdoutSha256: sha(list.stdout), stderrSha256: sha(list.stderr), selected: selected.selected.length, filtered: selected.filtered.length }, publicList: publicListSnapshot, mockInventory: { groupManifestDigest: input.compiled.group.mockManifestDigest, declaredMockComponentIds, observedConsumedMockComponentIds: [] }, run: { status: execution.status, signal: execution.signal, timedOut: execution.timedOut, aborted: execution.aborted, startedAt: execution.startedAt, finishedAt: execution.finishedAt, stdoutSha256: sha(execution.stdout), stderrSha256: sha(execution.stderr), stdoutBytes: execution.stdout.byteLength, stderrBytes: execution.stderr.byteLength }, workerCleanup: { confirmed: cleanupConfirmed, serverListening: cleanupReadback.serverListening, socketPresent: cleanupReadback.socket, aliasEntryPresent: cleanupReadback.aliasEntryPresent, privateSentinelPresent: cleanupReadback.privateSentinelPresent, path: cleanupReadback.path, privatePath: cleanupReadback.privatePath, socketInode: cleanupReadback.inode, socketDevice: cleanupReadback.device, sentinelInode: cleanupReadback.sentinelInode, sentinelDevice: cleanupReadback.sentinelDevice, parentDevice: cleanupReadback.parentDevice, parentInode: cleanupReadback.parentInode, parentUid: cleanupReadback.parentUid }, runStartCapture: captureBytes.toString("utf8"), runStartCaptureStatus: runStartCapture.status, assertionReceipts: receiptRows, candidateCaptures: captures };
    await writeOwnedFile(join(evidenceDirectory, `actual-cli-receipt-${launchId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    if (execution.signal || execution.timedOut || execution.aborted) throw new Error("actual pinned CLI run was interrupted before clean process completion");
    return Object.freeze({ launchId, runnerToolchain, launchConfigDigest: assets.launchConfigDigest, fixedAssetDigests: assets.assetDigests, publicList: publicListSnapshot, listStdoutBytes: new Uint8Array(list.stdout), listStderrBytes: new Uint8Array(list.stderr), selected: selected.selected.length, filtered: selected.filtered.length, rawReportBytes: new Uint8Array(execution.stdout), runStderrBytes: new Uint8Array(execution.stderr), runStartCaptureBytes: new Uint8Array(captureBytes), runStartCapture, assertionReceipts: Object.freeze(receiptRows), declaredMockComponentIds: Object.freeze(declaredMockComponentIds), candidateCaptures: Object.freeze(captures), listProcess: Object.freeze({ status: list.status, signal: list.signal, startedAt: list.startedAt, finishedAt: list.finishedAt, stdoutSha256: sha(list.stdout), stderrSha256: sha(list.stderr) }), runProcess: Object.freeze({ status: execution.status, signal: execution.signal, timedOut: execution.timedOut, aborted: execution.aborted, startedAt: execution.startedAt, finishedAt: execution.finishedAt, stdoutSha256: sha(execution.stdout), stderrSha256: sha(execution.stderr), stdoutBytes: execution.stdout.byteLength, stderrBytes: execution.stderr.byteLength }), cleanupConfirmed, cleanupServerListening: cleanupReadback.serverListening, evidenceDirectory });
  } finally {
    const closed = await session.close();
    if (closed) await rmdir(sessionDirectory);
  }
}

/** The host-only override is sealed to the immutable packaged install fixture; it cannot alter ordinary runs. */
function validateInstallQualificationProbeInputs(compiled: E2ECompiledSuite, snapshot: E2ESourceSnapshot, requestIds: ReadonlyMap<string, string>, probeInputs: ReadonlyMap<string, unknown>): void {
  const repository = snapshot.candidate.repositories[0];
  const manifest = snapshot.sources.find((source) => source.path === "apps/qualification/package.json");
  const source = snapshot.sources.find((item) => item.path === "apps/qualification/src/rows.js");
  if (snapshot.candidate.repositories.length !== 1 || repository?.repositoryId !== "agentx/runtime-install-qualification"
    || repository.commitSha !== "a".repeat(40) || repository.treeSha !== "b".repeat(40)
    || snapshot.treePaths.length !== 2 || !manifest || !source || manifest.kind !== "blob" || source.kind !== "blob"
    || sha(source.bytes) !== INSTALL_QUALIFICATION_SOURCE_SHA256
    || Buffer.from(manifest.bytes).toString("utf8") !== JSON.stringify({ name: "runtime-install-qualification", exports: { "./rows": "./src/rows.js" } })) throw new Error("challenge-bound host probe inputs are permitted only for the immutable packaged runtime qualification candidate");
  const expectedScenarios = ["runtime-source-interface", "runtime-feature-positive", "runtime-feature-negative"];
  if (compiled.bundle.scenarios.length !== 3 || compiled.expectedCases.length !== 3 || probeInputs.size !== 3 || requestIds.size !== 3
    || compiled.bundle.scenarios.some((scenario, index) => scenario.scenarioId !== expectedScenarios[index])) throw new Error("challenge-bound host probe inputs require the exact three-case installed qualification suite");
  const challengeIds = new Set<string>();
  for (const expectedCase of compiled.expectedCases) {
    const value = probeInputs.get(expectedCase.caseId);
    const requestId = requestIds.get(expectedCase.caseId);
    const scenario = compiled.bundle.scenarios.find((item) => item.scenarioId === expectedCase.scenarioId);
    if (!value || typeof value !== "object" || Array.isArray(value) || !scenario || typeof requestId !== "string") throw new Error("challenge-bound host probe input has no exact admitted case identity");
    const payload = value as Record<string, unknown>;
    const expectedProbe = expectedCase.scenarioId === expectedScenarios[0] ? "source-interface" : expectedCase.scenarioId === expectedScenarios[1] ? "positive" : "negative";
    if (Object.keys(payload).sort().join(",") !== "qualificationChallengeDigest,qualificationChallengeId,qualificationProbe,qualificationRequestId"
      || typeof payload.qualificationChallengeId !== "string" || !/^[0-9a-f-]{36}$/.test(payload.qualificationChallengeId)
      || typeof payload.qualificationChallengeDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.qualificationChallengeDigest)
      || payload.qualificationProbe !== expectedProbe || payload.qualificationRequestId !== requestId || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error("challenge-bound host probe input is malformed, stale, or not bound to its logical request identity");
    challengeIds.add(payload.qualificationChallengeId);
  }
  if (challengeIds.size !== 1) throw new Error("all qualification probes must be bound to one fresh broker challenge");
}
