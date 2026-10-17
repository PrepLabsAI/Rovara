import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, symlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { E2ERoundSchema, E2ERunBindingSchema, E2EApplicationCliHostDescriptorSchema, E2EApplicationEvidenceRefSchema,
  ProjectSetupRunnerToolchainSchema, canonicalJson, copyBoundedE2EJsonData,
  type E2ERound, type E2ERunBinding, type ProjectSetupRunnerToolchain } from "@agentx/contracts";
import { compareE2EApplicationPublicList, type E2EApplicationSelectionPacket } from "./application-identity.js";
import { validateE2ECompiledApplicationAdmission, type E2ECompiledApplicationSuite } from "./application-scenarios.js";
import { createE2EApplicationRuntimeAssets } from "./application-runtime-assets.js";
import type { E2EActualApplicationRun, E2EActualApplicationShard } from "./application-collection.js";
import { E2EApplicationSupervisorReadbackSchema, e2eApplicationPrivateTransferMaxBytes,
  validateE2EApplicationSupervisorReadbackStructure } from "./application-result-adapter.js";
import type { E2EApplicationSupervisorReadback } from "./application-result-adapter.js";
import { z } from "zod";

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_ASSIGNMENT = 32_768;
const SPOOL_CHUNK = 65_536;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function installedRuntimeRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "../../.."); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
async function canonicalInstalledFile(path: string, root: string): Promise<Buffer> {
  const absolute = resolve(path);
  if (!inside(root, absolute)) throw spoolUnavailable("installed registry escapes the fixed package root");
  for (let current = absolute; inside(root, current); current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw spoolUnavailable("installed registry ancestry contains a symlink");
    if (current === root) break;
  }
  const before = await lstat(absolute);
  if (!before.isFile() || before.size > 1_048_576 || await realpath(absolute) !== absolute) throw spoolUnavailable("installed registry is not a bounded canonical file");
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(); const after = await lstat(absolute);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || after.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino || opened.size > 1_048_576) throw spoolUnavailable("installed registry changed during safe open");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size || bytes.byteLength > 1_048_576) throw spoolUnavailable("installed registry changed while being read");
    return bytes;
  } finally { await handle.close(); }
}

export type E2EApplicationSupervisorReadbackExpected = Readonly<{ transportId: string; transportCorrelationId: string;
  bindingDigest: string; compiledInventoryDigest: string; preparedEnvironmentDigest: string;
  launches: readonly Readonly<{ shardId: string; launchId: string; upstreamRunId: string }>[]; maxWireBytes: number }>;
export type E2EApplicationSupervisorReadbackClient = Readonly<{ read(expected: E2EApplicationSupervisorReadbackExpected,
  signal: AbortSignal): Promise<E2EApplicationSupervisorReadback> }>;
type CliDescriptor = { entryPointId: string; entryPointManifestDigest: string };
const descriptorSchema = E2EApplicationCliHostDescriptorSchema;
const assignmentLaunchSchema = z.object({ shardId: z.string().min(1).max(120), launchId: z.string().uuid(), upstreamRunId: z.string().uuid() }).strict();
const expectedReadbackSchema = z.object({ transportId: z.string().min(1).max(256), transportCorrelationId: z.string().uuid(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), compiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  preparedEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/), launches: z.array(assignmentLaunchSchema).min(1).max(3),
  maxWireBytes: z.number().int().positive().max(26_214_400) }).strict().superRefine((value, context) => {
    if (new Set(value.launches.map((row) => row.shardId)).size !== value.launches.length
      || canonicalJson(value.launches) !== canonicalJson([...value.launches].sort((a, b) => a.shardId.localeCompare(b.shardId)))) {
      context.addIssue({ code: "custom", path: ["launches"], message: "expected launches must be sorted and unique" });
    }
  });
const spoolRegistrySchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-spools/v1"), entries: z.array(z.object({
  profileId: z.string().min(1).max(120), descriptor: descriptorSchema, transportId: z.string().min(1).max(256),
  assignmentRoot: z.string().min(1).max(4096), ownerUid: z.number().int().nonnegative().max(0x7fffffff),
}).strict()).max(12) }).strict().superRefine((registry, context) => {
  const keys = registry.entries.map((row) => `${row.profileId}\0${canonicalJson(row.descriptor)}\0${row.transportId}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["entries"], message: "spool mapping contains duplicate identities" });
  for (const entry of registry.entries) if (!isAbsolute(entry.assignmentRoot) || resolve(entry.assignmentRoot) !== entry.assignmentRoot) {
    context.addIssue({ code: "custom", path: ["entries"], message: "assignment root must be canonical absolute" });
  }
});
const assignmentSchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-readback-assignment/v1"),
  profileId: z.string().min(1).max(120), descriptor: descriptorSchema, transportId: z.string().min(1).max(256), transportCorrelationId: z.string().uuid(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), compiledInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  preparedEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/), launches: z.array(assignmentLaunchSchema).min(1).max(3),
  maxWireBytes: z.number().int().positive().max(26_214_400), closedAt: z.string().datetime({ offset: true }),
  harvestDeadlineAt: z.string().datetime({ offset: true }) }).strict().superRefine((value, context) => {
    if (new Set(value.launches.map((row) => row.shardId)).size !== value.launches.length
      || canonicalJson(value.launches) !== canonicalJson([...value.launches].sort((a, b) => a.shardId.localeCompare(b.shardId)))) {
      context.addIssue({ code: "custom", path: ["launches"], message: "assignment launches must be sorted and unique" });
    }
  });
const spoolProofSchema = z.object({ ref: z.unknown(), bytesBase64: z.string().max(35_000_000) }).strict();
const spoolWireSchema = z.object({ schemaVersion: z.literal("e2e-application-supervisor-readback/v1"), receipt: spoolProofSchema,
  evidence: z.array(spoolProofSchema).max(250_000) }).strict();

function spoolUnavailable(message: string): Error { return new Error(`application supervisor spool unavailable: ${message}`); }
function parseSpoolJson(bytes: Uint8Array): unknown {
  return copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { maxBytes: MAX_ASSIGNMENT, maxDepth: 24 });
}
function protectedOwner(stat: Stats, ownerUid: number): boolean {
  return (stat.uid === 0 || stat.uid === ownerUid) && (stat.mode & 0o022) === 0;
}
async function checkProtectedDirectory(path: string, ownerUid: number): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw spoolUnavailable("directory is not canonical absolute");
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !protectedOwner(stat, ownerUid)) throw spoolUnavailable("directory ancestry is writable or has an untrusted owner");
    if (dirname(current) === current) break;
  }
}
async function readProtectedFile(path: string, root: string, ownerUid: number, maxBytes: number, signal?: AbortSignal,
  onStream?: () => void): Promise<Buffer> {
  if (signal?.aborted) throw spoolUnavailable("read cancelled before open");
  if (!inside(root, path)) throw spoolUnavailable("fixed file escapes its protected root");
  for (let current = dirname(path); inside(root, current); current = dirname(current)) {
    const dir = await lstat(current);
    if (dir.isSymbolicLink() || !dir.isDirectory() || !protectedOwner(dir, ownerUid)) throw spoolUnavailable("file ancestry is writable or has an untrusted owner");
    if (current === root) break;
  }
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.uid !== ownerUid
    || (before.mode & 0o022) !== 0 || before.size > maxBytes || await realpath(path) !== path) throw spoolUnavailable("file is not a protected owned single-link regular file");
  let handle: FileHandle | undefined; let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.nlink !== 1 || opened.uid !== ownerUid || (opened.mode & 0o022) !== 0) throw spoolUnavailable("file changed during safe open");
    if (signal?.aborted) throw spoolUnavailable("read cancelled after open");
    onAbort = () => stream?.destroy(spoolUnavailable("read cancelled during stream"));
    signal?.addEventListener("abort", onAbort, { once: true });
    stream = handle.createReadStream({ autoClose: false, highWaterMark: SPOOL_CHUNK, signal });
    onStream?.();
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of stream) {
      if (signal?.aborted) throw spoolUnavailable("read cancelled during stream");
      const part = Buffer.from(chunk as Buffer); total += part.byteLength;
      if (total > maxBytes) { stream.destroy(); throw spoolUnavailable("bytes exceed active transfer ceiling"); }
      chunks.push(part);
    }
    const after = await handle.stat(); const pathAfter = await lstat(path);
    if (signal?.aborted || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || total !== opened.size
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== opened.size
      || pathAfter.nlink !== 1 || pathAfter.uid !== ownerUid) throw spoolUnavailable("file changed or read was cancelled");
    return Buffer.concat(chunks, total);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    stream?.destroy();
    await handle?.close();
  }
}
async function createSpoolClient(packageRoot: string, input: { profileId: string; descriptor: CliDescriptor }, conformance?: { onSpoolStream?: () => void }): Promise<E2EApplicationSupervisorReadbackClient> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw spoolUnavailable("platform custody is not qualified");
  const root = resolve(packageRoot); const registryPath = join(root, "assets/application-runtime-v1/supervisor-spools.json");
  const registryBytes = await canonicalInstalledFile(registryPath, root);
  const registry = spoolRegistrySchema.parse(copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(registryBytes)), { maxBytes: 1_048_576, maxDepth: 24 }));
  const mappings = registry.entries.filter((row) => row.profileId === input.profileId && canonicalJson(row.descriptor) === canonicalJson(input.descriptor));
  if (mappings.length < 1) throw spoolUnavailable("selected profile has no fixed installed mapping");
  return Object.freeze({ async read(expectedInput, signal) {
    const expected = expectedReadbackSchema.parse(expectedInput);
    const selectedMappings = mappings.filter((row) => row.transportId === expected.transportId);
    if (selectedMappings.length !== 1) throw spoolUnavailable("expected transport does not resolve to one fixed installed mapping");
    const mapping = selectedMappings[0]!;
    await checkProtectedDirectory(mapping.assignmentRoot, mapping.ownerUid);
    if (signal.aborted) throw spoolUnavailable("read cancelled before assignment lookup");
    const correlationRoot = join(mapping.assignmentRoot, expected.transportCorrelationId);
    const assignmentPath = join(correlationRoot, "assignment.json");
    const assignmentBytes = await readProtectedFile(assignmentPath, mapping.assignmentRoot, mapping.ownerUid, MAX_ASSIGNMENT, signal);
    const assignmentText = new TextDecoder("utf-8", { fatal: true }).decode(assignmentBytes);
    const assignment = assignmentSchema.parse(parseSpoolJson(assignmentBytes));
    const closedAt = Date.parse(assignment.closedAt); const harvestDeadlineAt = Date.parse(assignment.harvestDeadlineAt);
    if (canonicalJson(assignment) !== assignmentText || assignment.profileId !== input.profileId
      || canonicalJson(assignment.descriptor) !== canonicalJson(input.descriptor) || assignment.transportId !== mapping.transportId
      || assignment.transportId !== expected.transportId || assignment.transportCorrelationId !== expected.transportCorrelationId
      || assignment.bindingDigest !== expected.bindingDigest || assignment.compiledInventoryDigest !== expected.compiledInventoryDigest
      || assignment.preparedEnvironmentDigest !== expected.preparedEnvironmentDigest || canonicalJson(assignment.launches) !== canonicalJson(expected.launches)
      || assignment.maxWireBytes > e2eApplicationPrivateTransferMaxBytes(64, 3) || expected.maxWireBytes > e2eApplicationPrivateTransferMaxBytes(64, 3)
      || !Number.isFinite(closedAt) || !Number.isFinite(harvestDeadlineAt) || closedAt > Date.now() || Date.now() >= harvestDeadlineAt
      || harvestDeadlineAt <= closedAt || harvestDeadlineAt > closedAt + 30_000) throw spoolUnavailable("assignment identity, ceiling, or original harvest deadline is invalid");
    const maxWireBytes = Math.min(assignment.maxWireBytes, expected.maxWireBytes);
    const spoolDir = join(correlationRoot, ".agentx", "e2e"); await checkProtectedDirectory(spoolDir, mapping.ownerUid);
    const spoolPath = join(spoolDir, "supervisor-readback.json");
    const bounded = new AbortController();
    const abortParent = () => bounded.abort(signal.reason);
    if (signal.aborted) abortParent(); else signal.addEventListener("abort", abortParent, { once: true });
    const harvestTimer = setTimeout(() => bounded.abort(new Error("original supervisor harvest deadline elapsed")), Math.max(1, harvestDeadlineAt - Date.now()));
    try {
      const wireBytes = await readProtectedFile(spoolPath, correlationRoot, mapping.ownerUid, maxWireBytes, bounded.signal, conformance?.onSpoolStream);
      if (signal.aborted || bounded.signal.aborted || Date.now() >= harvestDeadlineAt) throw spoolUnavailable("readback completed after cancellation or harvest deadline");
      const wireText = new TextDecoder("utf-8", { fatal: true }).decode(wireBytes);
      const raw = copyBoundedE2EJsonData(JSON.parse(wireText), { maxBytes: maxWireBytes, maxDepth: 48, maxNodes: 300_000 });
      if (canonicalJson(raw) !== wireText) throw spoolUnavailable("wire bytes are not canonical UTF-8 JSON");
      const wire = spoolWireSchema.parse(raw);
      const decode = (proof: z.infer<typeof spoolProofSchema>) => {
        const ref = E2EApplicationEvidenceRefSchema.parse(proof.ref); const bytes = Buffer.from(proof.bytesBase64, "base64");
        if (bytes.toString("base64") !== proof.bytesBase64 || bytes.byteLength !== ref.byteLength || sha(bytes) !== ref.sha256) throw spoolUnavailable("proof bytes differ from immutable ref metadata");
        return { ref, bytes: new Uint8Array(bytes) };
      };
      const result = E2EApplicationSupervisorReadbackSchema.parse({ schemaVersion: wire.schemaVersion, receipt: decode(wire.receipt), evidence: wire.evidence.map(decode) });
      const proofBytes = result.receipt.bytes.byteLength + result.evidence.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      if (Buffer.byteLength(wireText) > maxWireBytes || proofBytes > maxWireBytes || signal.aborted || bounded.signal.aborted
        || Date.now() >= harvestDeadlineAt) throw spoolUnavailable("readback exceeds active bounds or original deadline");
      validateE2EApplicationSupervisorReadbackStructure(result);
      const receiptFrame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.receipt.bytes)) as {
        context: { bindingDigest: string; compiledInventoryDigest: string; preparedEnvironmentDigest: string; producer: { transportCorrelationId: string } };
        launches: readonly { shardId: string; launchId: string; upstreamRunId: string }[];
      };
      if (receiptFrame.context.bindingDigest !== expected.bindingDigest || receiptFrame.context.compiledInventoryDigest !== expected.compiledInventoryDigest
        || receiptFrame.context.preparedEnvironmentDigest !== expected.preparedEnvironmentDigest
        || receiptFrame.context.producer.transportCorrelationId !== expected.transportCorrelationId
        || canonicalJson(receiptFrame.launches) !== canonicalJson(expected.launches)) throw spoolUnavailable("raw receipt identity differs from the protected assignment tuple");
      if (signal.aborted || bounded.signal.aborted || Date.now() >= harvestDeadlineAt) throw spoolUnavailable("readback structural validation completed outside the original deadline");
      return Object.freeze({ schemaVersion: result.schemaVersion,
        receipt: Object.freeze({ ref: Object.freeze({ ...result.receipt.ref }), bytes: Uint8Array.from(result.receipt.bytes) }),
        evidence: Object.freeze(result.evidence.map((item) => Object.freeze({ ref: Object.freeze({ ...item.ref }), bytes: Uint8Array.from(item.bytes) }))) });
    } finally {
      clearTimeout(harvestTimer); signal.removeEventListener("abort", abortParent);
    }
  } });
}

/** Fixed package-relative installed reader; the caller cannot choose paths, URLs, modules, or read callbacks. */
export function createInstalledE2EApplicationSupervisorReadbackClient(input: Readonly<{ profileId: string; descriptor: CliDescriptor }>): Promise<E2EApplicationSupervisorReadbackClient> {
  return createSpoolClient(resolve(dirname(fileURLToPath(import.meta.url)), ".."), input);
}

/** @internal Controlled installed-layout fixture seam, not accepted by production bootstrap inputs. */
export function createE2EApplicationSupervisorReadbackClientForConformance(input: Readonly<{ packageRoot: string; profileId: string; descriptor: CliDescriptor }>): Promise<E2EApplicationSupervisorReadbackClient> {
  return createSpoolClient(input.packageRoot, input);
}

/** @internal Test-only stream lifecycle hook; production constructor has no callback input. */
export function createE2EApplicationSupervisorReadbackClientForConformanceWithHooks(input: Readonly<{ packageRoot: string; profileId: string;
  descriptor: CliDescriptor; onSpoolStream?: () => void }>): Promise<E2EApplicationSupervisorReadbackClient> {
  return input.onSpoolStream
    ? createSpoolClient(input.packageRoot, input, { onSpoolStream: input.onSpoolStream })
    : createSpoolClient(input.packageRoot, input);
}

async function writeExclusive(path: string, bytes: Uint8Array | string): Promise<void> {
  const fd = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await fd.writeFile(bytes); } finally { await fd.close(); }
}
async function readOwnedCapture(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || await realpath(path) !== path) throw new Error("application private capture is not a bounded owned regular file");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size || bytes.byteLength > maxBytes) throw new Error("application private capture changed while being read");
    return bytes;
  } finally { await handle.close(); }
}
async function linkInstalledDependencies(project: string): Promise<void> {
  const dependencyRoot = join(installedRuntimeRoot(), "node_modules");
  const stat = await import("node:fs/promises").then(({ lstat }) => lstat(dependencyRoot));
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dependencyRoot) !== dependencyRoot) throw new Error("installed e2e dependencies are unavailable from the fixed runtime root");
  await symlink(dependencyRoot, join(project, "node_modules"), "dir");
}

type ProcessResult = { status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer; startedAt: string; finishedAt: string;
  timedOut: boolean; aborted: boolean; outputExceeded: boolean };
function runProcess(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; deadlineAt: number; signal: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    if (Date.now() >= options.deadlineAt) { rejectProcess(new Error("application CLI original round deadline elapsed")); return; }
    const startedAt = new Date().toISOString();
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const out: Buffer[] = []; const err: Buffer[] = []; let outBytes = 0; let errBytes = 0; let timedOut = false; let aborted = false; let outputExceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (child.kill("SIGTERM")) killTimer ??= setTimeout(() => { child.kill("SIGKILL"); }, 2_000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.deadlineAt - Date.now()));
    const onAbort = () => { aborted = true; stop(); };
    if (options.signal.aborted) onAbort(); else options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.byteLength; if (outBytes <= MAX_OUTPUT) out.push(Buffer.from(chunk)); else { outputExceeded = true; stop(); } });
    child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.byteLength; if (errBytes <= MAX_OUTPUT) err.push(Buffer.from(chunk)); else { outputExceeded = true; stop(); } });
    child.once("error", (error) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener("abort", onAbort); rejectProcess(error); });
    child.once("close", (status, signal) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal.removeEventListener("abort", onAbort);
      resolveProcess({ status, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), startedAt, finishedAt: new Date().toISOString(), timedOut, aborted, outputExceeded }); });
  });
}

function processRecord(result: ProcessResult) {
  return { status: result.status, signal: result.signal, startedAt: result.startedAt, finishedAt: result.finishedAt, timedOut: result.timedOut, aborted: result.aborted,
    stdoutSha256: sha(result.stdout), stderrSha256: sha(result.stderr), stdoutBytes: result.stdout.byteLength, stderrBytes: result.stderr.byteLength };
}
function parseJson(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }

export type E2EActualApplicationCliInput = Readonly<{ compiled: E2ECompiledApplicationSuite; snapshot: unknown; binding: E2ERunBinding; round: E2ERound;
  runnerToolchain: ProjectSetupRunnerToolchain; evidenceDirectory: string; signal: AbortSignal }>;

/** Runs the pinned public CLI list and run commands for each exact one-target compiled shard. */
export async function runE2EApplicationActualCli(input: E2EActualApplicationCliInput): Promise<E2EActualApplicationRun> {
  const toolchain = ProjectSetupRunnerToolchainSchema.parse(input.runnerToolchain);
  if (toolchain.version !== process.version || toolchain.execPath !== process.execPath || toolchain.platform !== process.platform || toolchain.arch !== process.arch
    || process.version !== "v22.23.2" || !isAbsolute(toolchain.execPath)) throw new Error("application runner does not match the exact ready-registry Node 22 toolchain");
  const snapshot = validateE2ECompiledApplicationAdmission(input.compiled, input.snapshot);
  const binding = E2ERunBindingSchema.parse(input.binding); const round = E2ERoundSchema.parse(input.round);
  if (binding.groupId !== input.compiled.group.groupId || binding.runId !== round.groupBindings.find((item) => item.groupId === binding.groupId)?.runId
    || binding.roundId !== round.roundId || binding.deadlineAt !== round.deadlineAt || binding.candidateDigest !== snapshot.candidate.digest
    || canonicalJson(binding.expectedCases) !== canonicalJson(input.compiled.expectedCases)) throw new Error("application CLI binding differs from the exact compiled group or original round");
  const evidenceDirectory = resolve(input.evidenceDirectory);
  if (!isAbsolute(input.evidenceDirectory) || evidenceDirectory !== input.evidenceDirectory || await realpath(evidenceDirectory) !== evidenceDirectory) throw new Error("application evidence directory must be an existing canonical absolute path");
  const info = await import("node:fs/promises").then(({ lstat }) => lstat(evidenceDirectory));
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("application evidence directory must be private and owned");
  const deadlineAt = Date.parse(round.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || input.signal.aborted) throw new Error("application CLI round deadline or cancellation prevents launch");
  const root = installedRuntimeRoot(); const e2eRoot = join(root, "node_modules", "e2e"); const cliPath = join(e2eRoot, "dist", "cli", "bin.js");
  const packageBytes = await readFile(join(e2eRoot, "package.json")); const pkg = JSON.parse(packageBytes.toString("utf8")) as { version?: unknown };
  if (pkg.version !== "0.20.0") throw new Error("installed application runner is not pinned e2e 0.20.0");
  const shards: E2EActualApplicationShard[] = []; let selected = 0; let filtered = 0;
  for (const compiledShard of input.compiled.shards) {
    if (Date.now() >= deadlineAt || input.signal.aborted) throw new Error("application shard launch refused after the original group deadline");
    const shardRoot = join(evidenceDirectory, `application-${sha(Buffer.from(compiledShard.shardId)).slice(0, 16)}`);
    const assets = await createE2EApplicationRuntimeAssets({ compiled: input.compiled, shardId: compiledShard.shardId, ownedDirectory: shardRoot });
    const project = shardRoot;
    const privateRoot = join(project, ".agentx", "e2e");
    const launch = { schemaVersion: "e2e-application-cli-launch/v1", launchId: assets.launchId, shardId: compiledShard.shardId,
      compiledInventoryDigest: compiledShard.inventory.digest, bindingDigest: createHash("sha256").update(canonicalJson(binding)).digest("hex"),
      roundId: round.roundId, runId: binding.runId, cliHost: input.compiled.cliHost, transportId: randomUUID(),
      transportCorrelationId: randomUUID(), deadlineAt: round.deadlineAt };
    const inventory = { schemaVersion: "e2e-application-cli-inventory/v1", compiledInventoryDigest: compiledShard.inventory.digest,
      shardId: compiledShard.shardId, inventory: compiledShard.inventory, selection: compiledShard.selection,
      expectedCases: compiledShard.expectedCases };
    await writeExclusive(join(privateRoot, "application-cli-launch.json"), `${JSON.stringify(launch)}\n`);
    await writeExclusive(join(privateRoot, "application-cli-inventory.json"), `${JSON.stringify(inventory)}\n`);
    const projectStat = await import("node:fs/promises").then(({ lstat }) => lstat(project));
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink() || await realpath(project) !== project) throw new Error("application shard project directory is not canonical and owned");
    await linkInstalledDependencies(project);
    const home = join(project, ".home"); const tmp = join(project, ".tmp"); await mkdir(home, { mode: 0o700 }); await mkdir(tmp, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: "1", E2E_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
    const configPath = join(project, "e2e.config.mjs");
    const list = await runProcess(toolchain.execPath, [cliPath, "list", "--config", configPath, "--reporter", "json"], { cwd: project, env, deadlineAt, signal: input.signal });
    if (list.status !== 0 || list.signal || list.timedOut || list.aborted || list.outputExceeded) throw new Error("pinned application CLI list did not complete cleanly within its output bounds");
    const publicList = copyBoundedE2EJsonData(parseJson(list.stdout), { maxBytes: MAX_OUTPUT, maxDepth: 32, maxNodes: 65_536 });
    const selection: E2EApplicationSelectionPacket = compiledShard.selection;
    const listed = compareE2EApplicationPublicList(selection, publicList);
    selected += listed.selected.length; filtered += listed.filtered.length;
    const run = await runProcess(toolchain.execPath, [cliPath, "run", "--config", configPath, "--reporter", "json", "--output", ".agentx-run-output",
      "--no-cache", "--workers", "1", "--retries", "0"], { cwd: project, env, deadlineAt, signal: input.signal });
    const reportBytes = run.stdout;
    const runStderr = new Uint8Array(run.stderr);
    const startPath = join(privateRoot, `run-start-${assets.launchId}.jsonl`);
    const startBytes = await readOwnedCapture(startPath, 16_384);
    let runStart: unknown;
    try { runStart = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(startBytes).trim()); } catch { runStart = null; }
    shards.push({ shardId: compiledShard.shardId, launchId: assets.launchId, launchConfigDigest: compiledShard.expectedConfigDigest,
      fixedAssetDigests: assets.assetDigests, publicList, listStdoutBytes: new Uint8Array(list.stdout), listStderrBytes: new Uint8Array(list.stderr),
      rawReportBytes: new Uint8Array(reportBytes), runStderrBytes: runStderr, runStartCaptureBytes: new Uint8Array(startBytes), runStartCapture: runStart,
      listProcess: processRecord(list), runProcess: processRecord(run) });
    if (run.signal || run.timedOut || run.aborted || run.outputExceeded) throw new Error("pinned application CLI was interrupted or exceeded its output bounds; partial reports remain unavailable");
    // The CLI bridge and runner are cleaned by the runner itself; host-owned application resources are closed by the shared lifecycle.
  }
  // Return only original CLI observations here. Whole-group cleanup and private proof bytes are
  // deliberately null until the owning lifecycle closes and its installed supervisor reads back.
  return Object.freeze({ protocol: "e2e-actual-application-run/v1", runnerToolchain: toolchain, shards: Object.freeze(shards),
    applicationCaptures: Object.freeze([]), supervisorReceiptRefs: Object.freeze([]), declaredMockComponentIds: Object.freeze(
    [...new Set(input.compiled.group.mocks.map((mock) => mock.componentId))].sort()),
    selected, filtered, supervisorReadback: null, cleanupConfirmed: null, cleanupServerListening: null, evidenceDirectory });
}
