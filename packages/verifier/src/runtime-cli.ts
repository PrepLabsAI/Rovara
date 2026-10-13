import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, realpath, rmdir, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { list as upstreamList } from "e2e/runner";
import { join, resolve } from "node:path";
import { canonicalJson, type E2ESourceSnapshot } from "@agentx/contracts";
import { compareE2EPublicList, type E2ESelectionPacket } from "./selection.js";
import { createE2ERuntimeAssets, createE2ERuntimeLaunchId, parseE2EFirstPartyCapture, type E2EFirstPartyCaptureResult } from "./runtime-assets.js";
import { validateE2ECompiledRuntimeAdmission, type E2ECompiledSuite } from "./scenarios.js";
import { createE2EWorkerSession } from "./runtime-session.js";
import { createE2EAppAdapterPacket } from "./runtime-adapter.js";
import { evaluateE2EAssertions } from "./runtime-assertions.js";
import { runContainedCandidate } from "./contained-candidate.js";

const MAX_OUTPUT = 4 * 1024 * 1024;
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
  launchConfigDigest: string;
  fixedAssetDigests: Readonly<Record<string, string>>;
  publicList: unknown;
  selected: number;
  filtered: number;
  rawReportBytes: Uint8Array;
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
  hostRequestIds: ReadonlyMap<string, string>;
  sourceRoot: string;
  evidenceDirectory: string;
  deadlineAt: number;
  signal: AbortSignal;
}>;
export async function runE2EActualCli(input: E2EActualCliInput): Promise<E2EActualCliRun> {
  return runE2EActualCliWithSessionFactory(input, createE2EWorkerSession);
}

/** Trusted-host-only runner seam for proving cleanup-pending qualification; never receives app data. */
export async function runE2EActualCliWithSessionFactory(input: E2EActualCliInput, sessionFactory: typeof createE2EWorkerSession): Promise<E2EActualCliRun> {
  if (process.version !== "v22.23.2" || !process.execPath.includes("node-v22.23.2-darwin-arm64")) throw new Error("actual E2E acceptance must use the pinned direct Node 22.23.2 runtime");
  const snapshot = validateE2ECompiledRuntimeAdmission(input.compiled, input.snapshot);
  const evidenceDirectory = resolve(input.evidenceDirectory);
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
  await symlink(join(resolve(input.sourceRoot), "node_modules"), join(project, "node_modules"), "dir");
  const capturePath = join(project, `run-start-${launchId}.jsonl`);
  const bridgePath = join(project, "worker-bridge.mjs");
  const assetPaths = { launchId, capturePath, workerBridgePath: bridgePath };
  const assets = createE2ERuntimeAssets(input.compiled, assetPaths);
  for (const [path, content] of input.compiled.files) {
    const output = join(project, path);
    await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
    await writeOwnedFile(output, content);
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
  const preExecution = { schemaVersion: "e2e-pre-execution-primary/v1", launchId, candidate: { candidateDigest: snapshot.candidate.digest, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, planDigest: input.compiled.bundle.planDigest, sourceSnapshot: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256, byteLength: item.bytes.byteLength, kind: item.kind })) }, compiler: { inventory: input.compiled.inventory, files: [...input.compiled.files].map(([path, content]) => ({ path, sha256: sha(Buffer.from(content)), byteLength: Buffer.byteLength(content) })) }, runtime: { launchConfigDigest: assets.launchConfigDigest, fixedAssetDigests: assets.assetDigests }, selection: input.selection, requests: [...input.compiled.hostRequestPayloads].map(([caseId, payload]) => ({ caseId, payload, payloadSha256: sha(Buffer.from(canonicalJson(payload))), logicalRequestId: input.hostRequestIds.get(caseId) ?? null })), assertions: input.compiled.expectedCases.map((expected) => ({ caseId: expected.caseId, assertionDigests: expected.assertionDigests })), adapterPrimaries: [...adapterPrimaryPaths].map(([caseId, path]) => ({ caseId, path })), declaredMockComponentIds, observedConsumedMockComponentIds: [], harnessSource: harnessPrimary ? { path: harnessPrimary, sha256: harnessDigest } : null };
  await writeOwnedFile(join(evidenceDirectory, `pre-execution-${launchId}.json`), `${JSON.stringify(preExecution, null, 2)}\n`);
  const cliPath = join(resolve(input.sourceRoot), "node_modules/e2e/dist/cli/bin.js");
  const pkg = JSON.parse(await readFile(join(resolve(input.sourceRoot), "node_modules/e2e/package.json"), "utf8")) as { version?: unknown };
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
    const execution = await runContainedCandidate(packet.packet, { requestId: hostRequestId, input: expected && scenario.steps[0]?.kind === "invoke-contract" ? scenario.steps[0].input : null }, { signal: input.signal });
    const observation = execution.observation;
    if (!observation || execution.receipt.cleanup !== "confirmed") throw new Error("contained candidate observation or owned cleanup confirmation is unavailable");
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
  const env: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmp, CI: "1", E2E_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", AGENTX_E2E_SOCKET: session.socketPath, AGENTX_E2E_WORKER_CAPABILITY: capability, NODE_OPTIONS: `--import=${bridgePath}` };
  const config = join(project, "runtime-config.mjs");
  const listArgs = [cliPath, "list", "--config", config, "--reporter", "json"];
  const runArgs = [cliPath, "run", "--config", config, "--reporter", "json", "--output", ".agentx-run-output", "--no-cache", "--workers", "1", "--retries", "0"];
  try {
    const list = await runProcess(process.execPath, listArgs, { cwd: project, env, timeoutMs: Math.max(1, Math.min(60_000, input.deadlineAt - Date.now())), signal: input.signal });
    if (list.status !== 0 || list.signal || list.timedOut || list.aborted) throw new Error("actual pinned CLI list did not complete cleanly");
    await writeOwnedFile(join(evidenceDirectory, `public-list-${launchId}.json`), list.stdout);
    await writeOwnedFile(join(evidenceDirectory, `public-list-stderr-${launchId}.bin`), list.stderr);
    const cliList: unknown = JSON.parse(list.stdout.toString("utf8")) as unknown;
    const publicList = await upstreamList({ cwd: project, config, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, CI: env.CI } });
    const selectedListRows = (publicList as { pairs?: readonly { disposition?: string }[] }).pairs?.filter((pair) => pair.disposition === "run" || pair.disposition === "skip") ?? [];
    if (!cliList || typeof cliList !== "object" || Array.isArray(cliList) || !Array.isArray((cliList as Record<string, unknown>).pairs) || canonicalJson((cliList as Record<string, unknown>).pairs) !== canonicalJson(selectedListRows)) throw new Error("public CLI list run/skip rows differ from the pinned runner list API");
    const publicListPath = join(evidenceDirectory, `full-public-list-${launchId}.json`);
    await writeOwnedFile(publicListPath, `${JSON.stringify(publicList, null, 2)}\n`);
    // Reparse the exact persisted API packet so collection receives ordinary JSON data, not runner-owned instances.
    const publicListSnapshot: unknown = JSON.parse(await readFile(publicListPath, "utf8"));
    const selected = compareE2EPublicList(input.selection, publicListSnapshot);
    const execution = await runProcess(process.execPath, runArgs, { cwd: project, env, timeoutMs: Math.max(1, Math.min(60_000, input.deadlineAt - Date.now())), signal: input.signal });
    await writeOwnedFile(join(evidenceDirectory, `raw-report-${launchId}.json`), execution.stdout);
    await writeOwnedFile(join(evidenceDirectory, `raw-run-stderr-${launchId}.bin`), execution.stderr);
    const captureBytes = await readFile(capturePath).catch(() => Buffer.alloc(0));
    const runStartCapture = parseE2EFirstPartyCapture(captureBytes, launchId);
    const cleanupConfirmed = await session.close();
    const cleanupReadback = session.readback();
    const receipt = { evidenceType: "actual-pinned-e2e-cli-runtime/v1", launchId, node: { execPath: process.execPath, version: process.version, argv: process.argv }, cli: { path: cliPath, version: pkg.version, listArgv: listArgs, runArgv: runArgs }, runtime: { launchConfigDigest: assets.launchConfigDigest, compilerConfigDigest: input.compiled.expectedConfigDigest, fixedAssetDigests: assets.assetDigests }, list: { status: list.status, signal: list.signal, stdoutSha256: sha(list.stdout), stderrSha256: sha(list.stderr), selected: selected.selected.length, filtered: selected.filtered.length }, publicList: publicListSnapshot, mockInventory: { groupManifestDigest: input.compiled.group.mockManifestDigest, declaredMockComponentIds, observedConsumedMockComponentIds: [] }, run: { status: execution.status, signal: execution.signal, timedOut: execution.timedOut, aborted: execution.aborted, startedAt: execution.startedAt, finishedAt: execution.finishedAt, stdoutSha256: sha(execution.stdout), stderrSha256: sha(execution.stderr), stdoutBytes: execution.stdout.byteLength, stderrBytes: execution.stderr.byteLength }, workerCleanup: { confirmed: cleanupConfirmed, serverListening: cleanupReadback.serverListening, socketPresent: cleanupReadback.socket, parentDevice: cleanupReadback.parentDevice, parentInode: cleanupReadback.parentInode, parentUid: cleanupReadback.parentUid }, runStartCapture: captureBytes.toString("utf8"), runStartCaptureStatus: runStartCapture.status, assertionReceipts: receiptRows, candidateCaptures: captures };
    await writeOwnedFile(join(evidenceDirectory, `actual-cli-receipt-${launchId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    if (execution.signal || execution.timedOut || execution.aborted) throw new Error("actual pinned CLI run was interrupted before clean process completion");
    return Object.freeze({ launchId, launchConfigDigest: assets.launchConfigDigest, fixedAssetDigests: assets.assetDigests, publicList: publicListSnapshot, selected: selected.selected.length, filtered: selected.filtered.length, rawReportBytes: new Uint8Array(execution.stdout), runStartCaptureBytes: new Uint8Array(captureBytes), runStartCapture, assertionReceipts: Object.freeze(receiptRows), declaredMockComponentIds: Object.freeze(declaredMockComponentIds), candidateCaptures: Object.freeze(captures), listProcess: Object.freeze({ status: list.status, signal: list.signal, startedAt: list.startedAt, finishedAt: list.finishedAt, stdoutSha256: sha(list.stdout), stderrSha256: sha(list.stderr) }), runProcess: Object.freeze({ status: execution.status, signal: execution.signal, timedOut: execution.timedOut, aborted: execution.aborted, startedAt: execution.startedAt, finishedAt: execution.finishedAt, stdoutSha256: sha(execution.stdout), stderrSha256: sha(execution.stderr), stdoutBytes: execution.stdout.byteLength, stderrBytes: execution.stderr.byteLength }), cleanupConfirmed, cleanupServerListening: cleanupReadback.serverListening, evidenceDirectory });
  } finally {
    const closed = await session.close();
    if (closed) await rmdir(sessionDirectory);
  }
}
