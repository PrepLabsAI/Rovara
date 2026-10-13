import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { types as utilTypes } from "node:util";
import { CONTAINED_IMAGE, CONTAINED_SOCKET, buildCreateArgs, isOwnedContainer } from "./container-envelope.js";
import { FIXED_CANDIDATE_BOOTSTRAP } from "./fixed-candidate-bootstrap.js";

export { CONTAINED_IMAGE, CONTAINED_SOCKET, buildCreateArgs, isOwnedContainer } from "./container-envelope.js";

export const CANDIDATE_RESPONSE_SCOPE = "contained-candidate-process-response/v1" as const;
export const CANDIDATE_ADAPTER_VERSION = 1 as const;
const MAX_INPUT_BYTES = 65_536;
const MAX_PROTOCOL_BYTES = 262_144;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_FILES = 128;
const MAX_DURATION_MS = 60_000;
const MAX_CLEANUP_MS = 60_000;
const STOP_GRACE_SECONDS = 10;
const DOCKER = "/opt/homebrew/bin/docker";
const CLIENT_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const STATE_ROOT = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1");

type ExportFile = Readonly<{ path: string; bytes: Uint8Array; sha256: string }>;
export type CandidateExportPacket = Readonly<{ schemaVersion: 1; entry: string; exportName: string; files: readonly ExportFile[]; sourceDigest: string }>;
export type CandidateRequest = Readonly<{ requestId: string; input: unknown }>;
export type CandidateObservation = Readonly<{
  scope: typeof CANDIDATE_RESPONSE_SCOPE;
  adapterVersion: typeof CANDIDATE_ADAPTER_VERSION;
  entry: string;
  exportName: string;
  requestId: string;
  output: unknown;
  stdoutBytes: number;
  stdoutSha256: string;
  stderrBytes: number;
  stderrSha256: string;
  correlation: "fresh-random-wire-id-matched";
}>;
export type ContainerReceipt = Readonly<{
  scope: typeof CANDIDATE_RESPONSE_SCOPE;
  adapterVersion: typeof CANDIDATE_ADAPTER_VERSION;
  plannedName: string;
  containerId: string | null;
  recordRef: string;
  entry?: string;
  exportName?: string;
  image: string;
  sourceDigest: string;
  sourceBytes: number;
  owner: Readonly<{ nonce: string; labels: Readonly<Record<string, string>> }>;
  endpoint: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  aggregateBytes: number;
  overflow: boolean;
  cleanup: "confirmed" | "pending" | "failed";
  diagnostic?: string;
}>;
export type ContainedExecution = Readonly<{ observation: CandidateObservation | null; receipt: ContainerReceipt; error?: string }>;
export type ReconciliationReceipt = Readonly<{ recordRef: string; plannedName: string; containerId: string | null; cleanup: "confirmed" | "pending" | "failed"; diagnostic?: string }>;

type ContainerState = { Status?: string; Running?: boolean; OOMKilled?: boolean; Dead?: boolean; ExitCode?: number };
type DockerInspect = { Id: string; Name?: string; State?: ContainerState; Config?: { Image?: string; User?: string; Env?: string[]; Labels?: Record<string, string>; OpenStdin?: boolean; Tty?: boolean; Entrypoint?: string[]; Cmd?: string[] }; HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; Privileged?: boolean; PidMode?: string; IpcMode?: string; UTSMode?: string; PortBindings?: Record<string, unknown> | null; Devices?: unknown[]; CapAdd?: string[]; CapDrop?: string[]; SecurityOpt?: string[]; PidsLimit?: number; NanoCpus?: number; Memory?: number; MemorySwap?: number; Tmpfs?: Record<string, string> }; Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> };
type ProcessResult = { stdout: Buffer; stderr: Buffer; code: number | null; aborted: boolean; timedOut: boolean; overflow: boolean; stdoutBytes: number; stderrBytes: number; aggregateBytes: number; inputWritten: boolean; error?: string };
type InspectResult = { kind: "present"; info: DockerInspect } | { kind: "absent" } | { kind: "unknown"; diagnostic: string };
type CleanupState = "confirmed" | "pending" | "failed";
type DurableRecord = { schemaVersion: 1; recordRef: string; plannedName: string; nonce: string; sourceDigest: string; endpoint: string; image: string; containerId: string | null; cidfile: string; workspace: string | null; requestId: string; sourceBytes: number; phase: string; cleanup: CleanupState; entry?: string; exportName?: string; diagnostic?: string };

function fail(message: string): never { throw new Error(message); }
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value); }
function safeDiagnostic(value: string): string { return [...value].map((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127 ? " " : character; }).join("").slice(0, 1000); }
function descriptorRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) fail(`${label} must be a plain data object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must not have a custom prototype`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) fail(`${label} shape is invalid`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(`${label} contains an accessor or non-enumerable field`);
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function denseArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain dense array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value as number | undefined;
  if (!Number.isSafeInteger(length) || (length as number) > maxItems) fail(`${label} count exceeds limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== (length as number) + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (length as number)))) fail(`${label} must not be sparse or contain custom properties`);
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(`${label} contains an accessor or hole`);
    result.push(descriptor.value as unknown);
  }
  return result;
}
function cloneJson(value: unknown, maxDepth: number, label: string, ancestors = new WeakSet<object>(), level = 0): unknown {
  if (level > maxDepth) fail(`${label} depth exceeds limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`); return value; }
  if (typeof value !== "object" || utilTypes.isProxy(value)) fail(`${label} contains a non-JSON value or proxy`);
  if (ancestors.has(value)) fail(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = denseArray(value, label, 65_536);
      return items.map((item) => cloneJson(item, maxDepth, label, ancestors, level + 1));
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} contains a custom prototype`);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) fail(`${label} contains symbol keys`);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(`${label} contains an accessor or non-enumerable field`);
      result[key] = cloneJson(descriptor.value as unknown, maxDepth, label, ancestors, level + 1);
    }
    return result;
  } finally { ancestors.delete(value); }
}
function jsonBytes(value: unknown, limit: number, label: string): { text: string; bytes: Uint8Array } {
  const text = JSON.stringify(value);
  if (typeof text !== "string") fail(`${label} is not JSON`);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limit) fail(`${label} size exceeds limit`);
  return { text, bytes };
}
function foldedSegment(value: string): string { return value.normalize("NFKC").normalize("NFD").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ").normalize("NFC"); }
function reservedSegment(value: string): boolean {
  const key = foldedSegment(value);
  return key.startsWith(".env") || key === ".git" || key === ".ssh" || key === ".aws" || key === ".docker"
    || key === ".npmrc" || key === ".pypirc" || key === ".netrc" || key === ".git-credentials"
    || key === "credentials" || key === "credentials.json" || key === "credential" || key === "config.json"
    || key === "node_modules" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/.test(key);
}
function validRelativePath(value: string): boolean {
  if (!value || [...value].length > 240 || value.startsWith("/") || value.includes("\\") || value.includes(":") || value !== value.normalize("NFC")
    || [...value].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127; })) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." && !reservedSegment(segment));
}
function foldedPath(value: string): string { return value.split("/").map(foldedSegment).join("/"); }
function assertNoFoldedPathCollisions(paths: readonly string[]): void {
  const seen: string[] = [];
  for (const path of paths) {
    const folded = foldedPath(path);
    if (seen.some((existing) => folded === existing || folded.startsWith(`${existing}/`) || existing.startsWith(`${folded}/`))) fail("candidate paths contain a folded file/directory collision");
    seen.push(folded);
  }
}
function copyBytes(value: unknown): Uint8Array {
  if (utilTypes.isProxy(value) || !(value instanceof Uint8Array)) fail("candidate bytes must be an unproxied Uint8Array");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) fail("candidate bytes must not have a custom prototype");
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) fail("shared candidate bytes are unsupported");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.byteLength)) fail("candidate bytes contain custom fields");
  return Uint8Array.from(value);
}
function digestExport(files: readonly ExportFile[]): string { return sha(new TextEncoder().encode(files.map((file) => `${file.path}\0${file.sha256}\n`).sort().join(""))); }
function ownerLabels(nonce: string, sourceDigest: string): Readonly<{ nonce: string; labels: Readonly<Record<string, string>> }> {
  return Object.freeze({ nonce, labels: Object.freeze({ "agentx.owner": "contained-candidate-v1", "agentx.nonce": nonce, "agentx.source": sourceDigest }) });
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)); }
function validRequestId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
function validExportName(value: unknown): value is string { return typeof value === "string" && /^(default|[A-Za-z_$][A-Za-z0-9_$]{0,63})$/.test(value); }

export function validateCandidatePacket(value: unknown): CandidateExportPacket {
  const rawKeys = value && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value) ? Reflect.ownKeys(value) : [];
  const allowed = ["schemaVersion", "entry", "exportName", "files"];
  if (rawKeys.some((key) => typeof key !== "string" || !allowed.includes(key)) || !rawKeys.includes("schemaVersion") || !rawKeys.includes("entry") || !rawKeys.includes("files")) fail("candidate packet shape or entry path is invalid");
  const packet = descriptorRecord(value, rawKeys as string[], "candidate packet");
  if (packet.schemaVersion !== 1 || typeof packet.entry !== "string" || !validRelativePath(packet.entry) || !packet.entry.endsWith(".mjs")
    || (Object.hasOwn(packet, "exportName") && !validExportName(packet.exportName))) fail("candidate packet schema or entry path is invalid");
  const exportName = Object.hasOwn(packet, "exportName") ? packet.exportName as string : "default";
  const entries = denseArray(packet.files, "candidate files", MAX_SOURCE_FILES);
  if (entries.length < 1) fail("candidate export has no files");
  const files: ExportFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const file = descriptorRecord(entry, ["path", "bytes", "sha256"], "candidate file");
    if (typeof file.path !== "string" || !validRelativePath(file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail("candidate file path or digest is invalid");
    const bytes = copyBytes(file.bytes);
    const actualDigest = sha(bytes);
    if (actualDigest !== file.sha256) fail("candidate file digest mismatch");
    total += bytes.byteLength;
    if (total > MAX_SOURCE_BYTES) fail("candidate source size exceeds limit");
    files.push(Object.freeze({ path: file.path, bytes, sha256: actualDigest }));
  }
  assertNoFoldedPathCollisions([...files.map((file) => file.path), ".agentx-bootstrap.mjs"]);
  if (!files.some((file) => file.path === packet.entry)) fail("candidate entry is absent from export packet");
  const sourceDigest = sha(new TextEncoder().encode(`${packet.entry}\0${exportName}\n${digestExport(files)}`));
  return Object.freeze({ schemaVersion: 1, entry: packet.entry, exportName, files: Object.freeze(files), sourceDigest });
}

export function validateRequest(value: unknown): CandidateRequest {
  const request = cloneJson(value, 64, "request envelope");
  if (!plain(request) || !exactKeys(request, ["requestId", "input"]) || !validRequestId(request.requestId)) fail("request envelope shape or logical request ID is invalid");
  const input = cloneJson(request.input, 32, "request input");
  const literal = jsonBytes(input, MAX_INPUT_BYTES, "request input");
  jsonBytes({ requestId: request.requestId, input: JSON.parse(literal.text) as unknown }, MAX_PROTOCOL_BYTES, "request envelope");
  return Object.freeze({ requestId: request.requestId, input });
}

function depthOf(value: unknown, maximum: number): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let max = 0;
  while (stack.length) {
    const current = stack.pop()!;
    max = Math.max(max, current.depth);
    if (max > maximum) return max;
    if (Array.isArray(current.value)) {
      for (const item of current.value as unknown[]) stack.push({ value: item, depth: current.depth + 1 });
    } else if (plain(current.value)) {
      for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return max;
}
function parseCandidateResponse(stdout: Uint8Array, expectedWireId: string): { output: unknown; stdoutSha256: string; stdoutBytes: number } {
  if (!stdout.byteLength || stdout.byteLength > MAX_PROTOCOL_BYTES) fail("candidate process response byte size is invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("candidate process must return exactly one JSON response line");
  const parsed: unknown = JSON.parse(text.slice(0, -1));
  if (!plain(parsed) || !exactKeys(parsed, ["wireId", "output"]) || parsed.wireId !== expectedWireId || !Object.hasOwn(parsed, "output")) fail("candidate process response correlation or envelope is invalid");
  const output = parsed.output;
  if (depthOf(parsed, 64) > 64) fail("candidate process response depth exceeds limit");
  // JSON.parse already produces data-only JSON; this clone makes the returned observation independent.
  const outputCopy = cloneJson(output, 64, "candidate output");
  return { output: outputCopy, stdoutSha256: sha(stdout), stdoutBytes: stdout.byteLength };
}

type RunOptions = { signal?: AbortSignal };
function snapshotOptions(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) fail("execution options must be a plain data object");
  const rawKeys = Reflect.ownKeys(value);
  if (rawKeys.some((key) => key !== "signal")) fail("execution options shape is invalid");
  const options = descriptorRecord(value, rawKeys as string[], "execution options");
  if (!Object.hasOwn(options, "signal")) return undefined;
  const signal = options.signal;
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== "object" || utilTypes.isProxy(signal)) fail("execution signal must be a native AbortSignal");
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.call(signal); } catch { fail("execution signal must be a native AbortSignal"); }
  return signal as AbortSignal;
}
function signalAborted(signal?: AbortSignal): boolean { return signal ? Boolean(Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.call(signal)) : false; }
function addAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (!signal) return;
  const add = Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener")?.value as ((this: object, ...args: unknown[]) => void) | undefined;
  if (!add) fail("native abort listener is unavailable");
  Reflect.apply(add, signal, ["abort", listener, { once: true }]);
}
function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (!signal) return;
  const remove = Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener")?.value as ((this: object, ...args: unknown[]) => void) | undefined;
  if (remove) Reflect.apply(remove, signal, ["abort", listener]);
}
function windowState(signal: AbortSignal | undefined, deadline: number): "aborted" | "deadline" | null {
  if (signalAborted(signal)) return "aborted";
  if (performance.now() >= deadline) return "deadline";
  return null;
}
function privateClientEnv(privateRoot: string): NodeJS.ProcessEnv {
  return { PATH: CLIENT_PATH, HOME: join(privateRoot, "home"), DOCKER_CONFIG: join(privateRoot, "docker-config"), DOCKER_HOST: CONTAINED_SOCKET, LANG: "C.UTF-8" };
}
function boundedResult(stdout: Buffer[], stderr: Buffer[], code: number | null, aborted: boolean, timedOut: boolean, overflow: boolean, stdoutBytes: number, stderrBytes: number, aggregateBytes: number, inputWritten: boolean, error?: string): ProcessResult {
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, aborted, timedOut, overflow, stdoutBytes, stderrBytes, aggregateBytes, inputWritten, ...(error ? { error: safeDiagnostic(error) } : {}) };
}
function runProcess(args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; input?: Uint8Array; deadline: number; signal?: AbortSignal; maxAggregateBytes?: number }): Promise<ProcessResult> {
  const before = windowState(options.signal, options.deadline);
  if (before) return Promise.resolve(boundedResult([], [], null, before === "aborted", before === "deadline", false, 0, 0, 0, false));
  return new Promise((resolvePromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child: ReturnType<typeof spawn> | null = null;
    let aggregateBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let storedBytes = 0;
    let aborted = false;
    let timedOut = false;
    let overflow = false;
    let inputWritten = false;
    let settled = false;
    let spawnError: string | undefined;
    const limit = options.maxAggregateBytes ?? MAX_PROTOCOL_BYTES;
    const remaining = options.deadline - performance.now();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, remaining));
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      removeAbortListener(options.signal, onAbort);
      resolvePromise(boundedResult(stdout, stderr, code, aborted, timedOut, overflow, stdoutBytes, stderrBytes, aggregateBytes, inputWritten, spawnError));
    };
    const terminate = () => {
      if (child) {
        child.kill("SIGTERM");
        if (!killTimer) { killTimer = setTimeout(() => child?.kill("SIGKILL"), 1000); killTimer.unref(); }
      }
    };
    const onAbort = () => { aborted = true; terminate(); };
    addAbortListener(options.signal, onAbort);
    if (signalAborted(options.signal)) { onAbort(); settle(null); return; }
    try { child = spawn(DOCKER, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { spawnError = error instanceof Error ? error.message : "Docker client spawn failed"; settle(null); return; }
    if (signalAborted(options.signal)) onAbort();
    child.stdout!.on("data", (chunk: Buffer) => {
      aggregateBytes += chunk.length; stdoutBytes += chunk.length;
      const room = Math.max(0, limit - storedBytes);
      if (room > 0) { const stored = Buffer.from(chunk.subarray(0, room)); stdout.push(stored); storedBytes += stored.length; }
      if (aggregateBytes > limit) { overflow = true; terminate(); }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      aggregateBytes += chunk.length; stderrBytes += chunk.length;
      const room = Math.max(0, limit - storedBytes);
      if (room > 0) { const stored = Buffer.from(chunk.subarray(0, room)); stderr.push(stored); storedBytes += stored.length; }
      if (aggregateBytes > limit) { overflow = true; terminate(); }
    });
    child.once("spawn", () => {
      const current = windowState(options.signal, options.deadline);
      if (current) { if (current === "aborted") aborted = true; else timedOut = true; terminate(); return; }
      inputWritten = true;
      child?.stdin?.end(options.input);
    });
    child.stdin!.on("error", () => { /* a child that closes stdin early cannot produce an admitted response */ });
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (code) => settle(code));
    if (signalAborted(options.signal)) onAbort();
  });
}

async function ensurePrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) fail("durable ownership directory is not private and owner-controlled");
}
async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  const directory = await open(join(path, ".."), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writeRecord(record: DurableRecord): Promise<void> { await atomicWrite(join(STATE_ROOT, `${record.recordRef}.record.json`), new TextEncoder().encode(JSON.stringify(record))); }
function recordExact(value: unknown): value is DurableRecord {
  if (!plain(value)) return false;
  const keys = ["schemaVersion", "recordRef", "plannedName", "nonce", "sourceDigest", "endpoint", "image", "containerId", "cidfile", "workspace", "requestId", "sourceBytes", "phase", "cleanup", "entry", "exportName"];
  if (Object.keys(value).some((key) => !keys.includes(key) && key !== "diagnostic")) return false;
  return value.schemaVersion === 1 && typeof value.recordRef === "string" && /^[a-f0-9]{32}$/.test(value.recordRef)
    && typeof value.plannedName === "string" && /^agentx-contained-[a-f0-9]{20}$/.test(value.plannedName)
    && typeof value.nonce === "string" && /^[a-f0-9]{48}$/.test(value.nonce)
    && typeof value.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(value.sourceDigest)
    && value.endpoint === CONTAINED_SOCKET && value.image === CONTAINED_IMAGE
    && (value.containerId === null || typeof value.containerId === "string" && /^[a-f0-9]{64}$/.test(value.containerId))
    && typeof value.cidfile === "string" && value.cidfile === join(STATE_ROOT, `${value.recordRef}.cid`)
    && (value.workspace === null || typeof value.workspace === "string" && dirname(resolve(value.workspace)) === resolve(process.cwd()) && /^\.contained-candidate-[A-Za-z0-9]+$/.test(basename(value.workspace)))
    && typeof value.requestId === "string" && validRequestId(value.requestId)
    && (value.entry === undefined || typeof value.entry === "string" && validRelativePath(value.entry) && value.entry.endsWith(".mjs"))
    && (value.exportName === undefined || validExportName(value.exportName))
    && Number.isSafeInteger(value.sourceBytes) && (value.sourceBytes as number) >= 0
    && typeof value.phase === "string" && ["planned", "creating", "created", "starting", "started", "cleanup-pending", "cleanup-failed", "cleanup-confirmed"].includes(value.phase)
    && ["pending", "failed", "confirmed"].includes(String(value.cleanup));
}
async function readRecord(path: string): Promise<DurableRecord | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 8192) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return recordExact(parsed) ? parsed : null;
  } catch { return null; }
}
async function readCidfile(record: DurableRecord): Promise<string | null> {
  try {
    const info = await lstat(record.cidfile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128) return null;
    const value = (await readFile(record.cidfile, "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch { return null; }
}
function clientEnv(privateRoot: string): NodeJS.ProcessEnv { return privateClientEnv(privateRoot); }
function inspectTargetMatchesError(stderr: string, target: string): boolean {
  const normalized = stderr.trim().replace(/\r/g, "");
  return normalized === `Error: No such object: ${target}` || normalized === `Error: No such object: /${target}`
    || normalized === `Error: No such container: ${target}` || normalized === `Error response from daemon: No such container: ${target}`;
}
async function inspectDocker(target: string, env: NodeJS.ProcessEnv, cwd: string, deadline: number, signal?: AbortSignal): Promise<InspectResult> {
  const result = await runProcess(["container", "inspect", target], { env, cwd, deadline, ...(signal ? { signal } : {}), maxAggregateBytes: 1_048_576 });
  if (result.code === 0) {
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
      if (Array.isArray(value) && value.length === 1 && plain(value[0]) && typeof value[0].Id === "string" && /^[a-f0-9]{64}$/.test(value[0].Id)) return { kind: "present", info: value[0] as DockerInspect };
      return { kind: "unknown", diagnostic: "Docker inspect returned a malformed response" };
    } catch { return { kind: "unknown", diagnostic: "Docker inspect returned invalid JSON" }; }
  }
  if (result.code === 1 && !result.timedOut && !result.aborted && !result.error && (result.stdout.length === 0 || result.stdout.toString("utf8").trim() === "[]") && inspectTargetMatchesError(new TextDecoder().decode(result.stderr), target)) return { kind: "absent" };
  return { kind: "unknown", diagnostic: result.error ?? (result.stderr.length ? safeDiagnostic(result.stderr.toString("utf8")) : "Docker inspect did not establish resource state") };
}
function verifyContainer(info: DockerInspect, source: string, bootstrap: string, entry: string, exportName: string): string[] {
  const cfg = info.Config ?? {};
  const hc = info.HostConfig ?? {};
  const mounts = info.Mounts ?? [];
  const env = cfg.Env ?? [];
  const expectedEnv = ["HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY=", "http_proxy=", "https_proxy=", "all_proxy=", "no_proxy=", "NODE_OPTIONS=", "NODE_PATH=", `AGENTX_ENTRY=/candidate/${entry}`, `AGENTX_EXPORT=${exportName}`];
  const allowedEnv = new Set(["PATH", "NODE_VERSION", "YARN_VERSION", ...expectedEnv.map((item) => item.slice(0, item.indexOf("=")))]);
  const failed: string[] = [];
  if (cfg.Image !== CONTAINED_IMAGE) failed.push("image");
  if (cfg.User !== "65532:65532") failed.push("user");
  if (cfg.OpenStdin !== true || cfg.Tty !== false) failed.push("stdio");
  if (JSON.stringify(cfg.Entrypoint) !== JSON.stringify(["node"]) || JSON.stringify(cfg.Cmd) !== JSON.stringify([`/candidate/${bootstrap}`])) failed.push("command");
  const envKeys = env.map((item) => item.slice(0, item.indexOf("=")));
  if (!expectedEnv.every((item) => env.includes(item)) || env.some((item) => !item.includes("=") || !allowedEnv.has(item.slice(0, item.indexOf("=")))) || new Set(envKeys).size !== envKeys.length) failed.push("env");
  if (hc.NetworkMode !== "none") failed.push("network");
  if (hc.Privileged !== false || (hc.PidMode ?? "") !== "" || hc.IpcMode !== "private" || (hc.UTSMode ?? "") !== "" || Object.keys(hc.PortBindings ?? {}).length !== 0 || (hc.Devices?.length ?? 0) !== 0 || (hc.CapAdd?.length ?? 0) !== 0) failed.push("host-isolation");
  if (hc.ReadonlyRootfs !== true) failed.push("rootfs");
  if (hc.PidsLimit !== 256 || hc.NanoCpus !== 2_000_000_000 || hc.Memory !== 4_294_967_296 || hc.MemorySwap !== 4_294_967_296) failed.push("resources");
  if (!hc.CapDrop?.includes("ALL")) failed.push("capabilities");
  if (!hc.SecurityOpt?.includes("no-new-privileges:true") || hc.SecurityOpt?.some((value) => value.startsWith("seccomp="))) failed.push("security-options");
  if (mounts.length !== 1 || !mounts.some((mount) => mount.Source === source && mount.Destination === "/candidate" && mount.RW === false)) failed.push("candidate-mount");
  if (hc.Tmpfs?.["/tmp"] !== "rw,nosuid,nodev,noexec,size=512m") failed.push("tmpfs");
  return failed;
}

async function persistReceipt(record: DurableRecord, receipt: ContainerReceipt): Promise<void> {
  await atomicWrite(join(STATE_ROOT, `${record.recordRef}.receipt.json`), new TextEncoder().encode(JSON.stringify(receipt)));
  await unlink(join(STATE_ROOT, `${record.recordRef}.record.json`)).catch(() => undefined);
  await unlink(record.cidfile).catch(() => undefined);
}
async function cleanupWorkspace(record: DurableRecord, persist = true): Promise<void> {
  if (!record.workspace) return;
  const workspaceInfo = await lstat(record.workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || await realpath(record.workspace) !== resolve(record.workspace)) fail("owned candidate workspace changed before cleanup");
  const sourceRoot = join(record.workspace, "candidate");
  const sourceInfo = await lstat(sourceRoot).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (sourceInfo && (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())) fail("owned candidate export root changed before cleanup");
  const relaxDirectories = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await relaxDirectories(join(directory, entry.name));
    await chmod(directory, 0o700);
  };
  await lstat(record.workspace);
  await relaxDirectories(sourceRoot).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
  await rm(record.workspace, { recursive: true, force: true });
  record.workspace = null;
  if (persist) await writeRecord(record);
}
async function cleanupOwned(record: DurableRecord, env: NodeJS.ProcessEnv, cwd: string): Promise<CleanupState> {
  const deadline = performance.now() + MAX_CLEANUP_MS;
  const target = record.containerId ?? record.plannedName;
  let inspect = await inspectDocker(target, env, cwd, deadline);
  if (inspect.kind === "absent") {
    if (target !== record.plannedName && !record.containerId) return "failed";
    return "confirmed";
  }
  if (inspect.kind === "unknown") return "pending";
  if (!isOwnedContainer(inspect.info.Config?.Labels, { nonce: record.nonce, sourceDigest: record.sourceDigest }) || (record.containerId && inspect.info.Id !== record.containerId)) return "failed";
  if (!record.containerId) {
    record.containerId = inspect.info.Id;
    await writeRecord(record);
  }
  if (inspect.info.State?.Running) {
    if (performance.now() >= deadline) return "pending";
    await runProcess(["container", "stop", "--time", String(STOP_GRACE_SECONDS), record.containerId], { env, cwd, deadline });
    inspect = await inspectDocker(record.containerId, env, cwd, deadline);
    if (inspect.kind === "unknown") return "pending";
    if (inspect.kind === "absent") return "confirmed";
    if (!isOwnedContainer(inspect.info.Config?.Labels, { nonce: record.nonce, sourceDigest: record.sourceDigest }) || inspect.info.Id !== record.containerId) return "failed";
    if (inspect.info.State?.Running) {
      if (performance.now() >= deadline) return "pending";
      await runProcess(["container", "kill", record.containerId], { env, cwd, deadline });
      inspect = await inspectDocker(record.containerId, env, cwd, deadline);
      if (inspect.kind === "unknown") return "pending";
      if (inspect.kind === "absent") return "confirmed";
      if (!isOwnedContainer(inspect.info.Config?.Labels, { nonce: record.nonce, sourceDigest: record.sourceDigest }) || inspect.info.Id !== record.containerId) return "failed";
      if (inspect.info.State?.Running) return "pending";
    }
  }
  if (performance.now() >= deadline) return "pending";
  await runProcess(["container", "rm", "--force", record.containerId], { env, cwd, deadline });
  inspect = await inspectDocker(record.containerId, env, cwd, deadline);
  if (inspect.kind === "absent") return "confirmed";
  if (inspect.kind === "unknown") return "pending";
  if (!isOwnedContainer(inspect.info.Config?.Labels, { nonce: record.nonce, sourceDigest: record.sourceDigest }) || inspect.info.Id !== record.containerId) return "failed";
  return "pending";
}
function receiptFor(record: DurableRecord, result: { exitCode: number | null; timedOut: boolean; aborted: boolean; stdoutBytes: number; stderrBytes: number; aggregateBytes: number; overflow: boolean; cleanup: CleanupState; diagnostic?: string }): ContainerReceipt {
  return Object.freeze({
    scope: CANDIDATE_RESPONSE_SCOPE, adapterVersion: CANDIDATE_ADAPTER_VERSION, plannedName: record.plannedName, containerId: record.containerId,
    recordRef: record.recordRef, image: record.image, sourceDigest: record.sourceDigest, sourceBytes: record.sourceBytes,
    ...(record.entry ? { entry: record.entry } : {}), ...(record.exportName ? { exportName: record.exportName } : {}),
    owner: ownerLabels(record.nonce, record.sourceDigest), endpoint: record.endpoint, exitCode: result.exitCode, timedOut: result.timedOut,
    aborted: result.aborted, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, aggregateBytes: result.aggregateBytes,
    overflow: result.overflow, cleanup: result.cleanup, ...(result.diagnostic ? { diagnostic: safeDiagnostic(result.diagnostic) } : {}),
  });
}
async function finishRecord(record: DurableRecord, result: Omit<Parameters<typeof receiptFor>[1], "cleanup">, cleanup: CleanupState): Promise<void> {
  record.cleanup = cleanup;
  record.phase = cleanup === "confirmed" ? "cleanup-confirmed" : cleanup === "failed" ? "cleanup-failed" : "cleanup-pending";
  if (cleanup === "confirmed") {
    await cleanupWorkspace(record);
    const receipt = receiptFor(record, { ...result, cleanup });
    await persistReceipt(record, receipt);
  } else await writeRecord(record);
}

export async function reconcileOwnedContainers(): Promise<readonly ReconciliationReceipt[]> {
  await ensurePrivateDirectory(STATE_ROOT, false).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
  let names: string[];
  try { names = await readdir(STATE_ROOT); } catch { return Object.freeze([]); }
  const results: ReconciliationReceipt[] = [];
  const env = clientEnv(STATE_ROOT);
  await ensurePrivateDirectory(env.HOME!, true);
  await ensurePrivateDirectory(env.DOCKER_CONFIG!, true);
  for (const name of names.filter((item) => /^[a-f0-9]{32}\.record\.json$/.test(item)).sort()) {
    const path = join(STATE_ROOT, name);
    const record = await readRecord(path);
    if (!record || path !== join(STATE_ROOT, `${record.recordRef}.record.json`)) continue;
    const cleanup = await cleanupOwned(record, env, STATE_ROOT).catch(() => "pending" as const);
    record.cleanup = cleanup;
    record.phase = cleanup === "confirmed" ? "cleanup-confirmed" : cleanup === "failed" ? "cleanup-failed" : "cleanup-pending";
    if (cleanup === "confirmed") delete record.diagnostic;
    else record.diagnostic = "owned resource state is not positively reconciled";
    if (cleanup === "confirmed") {
      await cleanupWorkspace(record);
      const receipt = receiptFor(record, { exitCode: null, timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0, aggregateBytes: 0, overflow: false, cleanup });
      await persistReceipt(record, receipt);
    } else await writeRecord(record);
    results.push(Object.freeze({ recordRef: record.recordRef, plannedName: record.plannedName, containerId: record.containerId, cleanup, ...(record.diagnostic ? { diagnostic: record.diagnostic } : {}) }));
  }
  return Object.freeze(results);
}

export async function runContainedCandidate(packetInput: unknown, requestInput: unknown, optionsInput?: RunOptions): Promise<ContainedExecution> {
  // All caller-controlled data is copied synchronously before the first await or filesystem effect.
  const packet = validateCandidatePacket(packetInput);
  const request = validateRequest(requestInput);
  const signal = snapshotOptions(optionsInput);
  const startedAt = performance.now();
  const deadline = startedAt + MAX_DURATION_MS;
  const wireId = randomBytes(24).toString("hex");
  const frame = jsonBytes({ wireId, input: request.input }, MAX_PROTOCOL_BYTES, "candidate process request");
  const nonce = randomBytes(24).toString("hex");
  const name = `agentx-contained-${randomBytes(10).toString("hex")}`;
  const recordRef = randomBytes(16).toString("hex");
  const cidfile = join(STATE_ROOT, `${recordRef}.cid`);
  const sourceBytes = packet.files.reduce((total, file) => total + file.bytes.byteLength, 0);
  let workspace: string | null = null;
  let env: NodeJS.ProcessEnv = clientEnv(STATE_ROOT);
  let workCwd = STATE_ROOT;
  const record: DurableRecord = { schemaVersion: 1, recordRef, plannedName: name, nonce, sourceDigest: packet.sourceDigest, endpoint: CONTAINED_SOCKET, image: CONTAINED_IMAGE, containerId: null, cidfile, workspace: null, requestId: request.requestId, sourceBytes, phase: "planned", cleanup: "confirmed", entry: packet.entry, exportName: packet.exportName };
  let exitCode: number | null = null;
  let timedOut = false;
  let aborted = false;
  let overflow = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let aggregateBytes = 0;
  let diagnostic: string | undefined;
  let provisional: CandidateObservation | null = null;
  let durablePlanned = false;
  let attemptedCreate = false;
  let cleanup: CleanupState = "confirmed";

  const noteWindow = () => {
    const state = windowState(signal, deadline);
    if (state === "aborted") aborted = true;
    if (state === "deadline") timedOut = true;
    return state;
  };
  try {
    await ensurePrivateDirectory(STATE_ROOT, true);
    const mkStatus = noteWindow();
    if (mkStatus) throw new Error(mkStatus === "aborted" ? "execution aborted before preparation" : "execution deadline elapsed before preparation");
    workspace = await mkdtemp(join(process.cwd(), ".contained-candidate-"));
    await chmod(workspace, 0o700);
    record.workspace = workspace;
    env = clientEnv(workspace);
    workCwd = join(workspace, "work");
    await Promise.all([mkdir(join(workspace, "home"), { mode: 0o700 }), mkdir(join(workspace, "docker-config"), { mode: 0o700 }), mkdir(join(workspace, "candidate"), { mode: 0o700 }), mkdir(workCwd, { mode: 0o700 })]);
    if (noteWindow()) throw new Error(aborted ? "execution aborted during preparation" : "execution deadline elapsed during preparation");
    for (const file of packet.files) {
      if (noteWindow()) throw new Error(aborted ? "execution aborted during export materialization" : "execution deadline elapsed during export materialization");
      const destination = resolve(workspace, "candidate", file.path);
      const sourceRoot = resolve(workspace, "candidate");
      if (!destination.startsWith(`${sourceRoot}${sep}`)) fail("candidate path escapes export root");
      const parent = resolve(destination, "..");
      await mkdir(parent, { recursive: true, mode: 0o755 });
      await writeFile(destination, file.bytes, { mode: 0o444, flag: "wx" });
      if (noteWindow()) throw new Error(aborted ? "execution aborted during export materialization" : "execution deadline elapsed during export materialization");
    }
    const dirs = new Set<string>([join(workspace, "candidate")]);
    for (const file of packet.files) {
      let parent = resolve(workspace, "candidate", file.path, "..");
      while (parent.startsWith(`${resolve(workspace, "candidate")}${sep}`)) { dirs.add(parent); parent = resolve(parent, ".."); }
    }
    const bootstrapPath = join(workspace, "candidate", ".agentx-bootstrap.mjs");
    await writeFile(bootstrapPath, FIXED_CANDIDATE_BOOTSTRAP, { mode: 0o444, flag: "wx" });
    for (const directory of [...dirs].sort((left, right) => right.length - left.length)) await chmod(directory, 0o555);
    const materialized = await recheckMaterializedExport(packet, join(workspace, "candidate"), bootstrapPath);
    if (!materialized) fail("materialized candidate export changed before allocation");
    if (noteWindow()) throw new Error(aborted ? "execution aborted before allocation" : "execution deadline elapsed before allocation");

    const image = await runProcess(["image", "inspect", CONTAINED_IMAGE, "--format", "{{json .}}"], { env, cwd: workCwd, deadline, ...(signal ? { signal } : {}), maxAggregateBytes: 1_048_576 });
    if (image.aborted || image.timedOut || noteWindow()) throw new Error(image.aborted || aborted ? "execution aborted while checking the pinned image" : "pinned image check exceeded execution deadline");
    let imageInfo: { RepoDigests?: string[]; Os?: string; Architecture?: string } | null = null;
    try { imageInfo = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(image.stdout)) as { RepoDigests?: string[]; Os?: string; Architecture?: string }; } catch { /* unavailable below */ }
    if (image.code !== 0 || !imageInfo?.RepoDigests?.includes(CONTAINED_IMAGE) || imageInfo.Os !== "linux" || imageInfo.Architecture !== "arm64") fail("pinned local Docker linux/arm64 image is unavailable");

    const planned = await inspectDocker(name, env, workCwd, deadline, signal);
    if (noteWindow()) throw new Error(aborted ? "execution aborted before allocation" : "execution deadline elapsed before allocation");
    if (planned.kind !== "absent") fail(planned.kind === "present" ? "random planned container name is already occupied" : planned.diagnostic);
    await writeRecord(record);
    durablePlanned = true;
    record.phase = "creating";
    record.cleanup = "pending";
    await writeRecord(record);
    if (noteWindow()) throw new Error(aborted ? "execution aborted before container creation" : "execution deadline elapsed before container creation");
    attemptedCreate = true;
    const create = await runProcess(buildCreateArgs({ name, cidfile, sourcePath: join(workspace, "candidate"), sourceDigest: packet.sourceDigest, nonce, entry: packet.entry, exportName: packet.exportName }), { env, cwd: workCwd, deadline, ...(signal ? { signal } : {}), maxAggregateBytes: 16_384 });
    stdoutBytes += create.stdoutBytes; stderrBytes += create.stderrBytes; aggregateBytes += create.aggregateBytes; overflow ||= create.overflow;
    aborted ||= create.aborted; timedOut ||= create.timedOut;
    if (create.error) diagnostic = create.error;
    const fromCid = await readCidfile(record);
    if (fromCid) { record.containerId = fromCid; record.phase = "created"; await writeRecord(record); }
    if (create.code !== 0 || create.aborted || create.timedOut || create.overflow) throw new Error(create.error ?? create.stderr.toString("utf8") ?? "Docker create did not complete cleanly");
    if (noteWindow()) throw new Error(aborted ? "execution aborted after container creation" : "execution deadline elapsed after container creation");
    if (!record.containerId) fail("Docker create returned without a durable exact container ID");
    const created = await inspectDocker(record.containerId, env, workCwd, deadline, signal);
    if (noteWindow()) throw new Error(aborted ? "execution aborted during container inspection" : "execution deadline elapsed during container inspection");
    if (created.kind !== "present") fail(created.kind === "unknown" ? created.diagnostic : "created container is positively absent");
    if (!isOwnedContainer(created.info.Config?.Labels, { nonce, sourceDigest: packet.sourceDigest }) || created.info.Id !== record.containerId) fail("created container ownership could not be confirmed");
    const policy = verifyContainer(created.info, join(workspace, "candidate"), ".agentx-bootstrap.mjs", packet.entry, packet.exportName);
    if (policy.length) fail(`actual container configuration did not match fixed containment policy: ${policy.join(",")}`);
    if (created.info.State?.Status !== "created") fail("newly created candidate container is not in the expected created state");
    record.phase = "created"; await writeRecord(record);
    if (noteWindow()) throw new Error(aborted ? "execution aborted before candidate process start" : "execution deadline elapsed before candidate process start");
    const materializedBeforeStart = await recheckMaterializedExport(packet, join(workspace, "candidate"), bootstrapPath);
    if (!materializedBeforeStart) fail("materialized candidate export changed before process start");
    if (noteWindow()) throw new Error(aborted ? "execution aborted after candidate materialization check" : "execution deadline elapsed after candidate materialization check");
    record.phase = "starting"; await writeRecord(record);
    if (noteWindow()) throw new Error(aborted ? "execution aborted before candidate process start" : "execution deadline elapsed before candidate process start");
    const started = await runProcess(["start", "--attach", "--interactive", record.containerId], { env, cwd: workCwd, input: frame.bytes, deadline, ...(signal ? { signal } : {}), maxAggregateBytes: MAX_PROTOCOL_BYTES });
    exitCode = started.code;
    aborted ||= started.aborted;
    timedOut ||= started.timedOut;
    overflow ||= started.overflow;
    stdoutBytes = started.stdoutBytes;
    stderrBytes = started.stderrBytes;
    aggregateBytes = started.aggregateBytes;
    if (started.error) diagnostic = started.error;
    if (started.stderr.length) diagnostic ??= safeDiagnostic(started.stderr.toString("utf8"));
    if (noteWindow() || aborted || timedOut || started.code !== 0 || overflow || !started.inputWritten) throw new Error(diagnostic ?? (overflow ? "candidate process exceeded aggregate stream limit" : "candidate process did not complete within the admitted window"));
    const afterStart = await inspectDocker(record.containerId, env, workCwd, deadline, signal);
    if (noteWindow()) throw new Error(aborted ? "execution aborted before response admission" : "execution deadline elapsed before response admission");
    if (afterStart.kind !== "present") fail(afterStart.kind === "unknown" ? afterStart.diagnostic : "candidate container disappeared before lifecycle readback");
    if (!isOwnedContainer(afterStart.info.Config?.Labels, { nonce, sourceDigest: packet.sourceDigest }) || afterStart.info.Id !== record.containerId) fail("candidate lifecycle ownership readback failed");
    if (afterStart.info.State?.Status !== "exited" || afterStart.info.State.ExitCode !== 0 || afterStart.info.State.OOMKilled || afterStart.info.State.Dead || afterStart.info.State.Running) fail("candidate process lifecycle did not report a clean successful exit");
    const parsed = parseCandidateResponse(started.stdout, wireId);
    provisional = Object.freeze({ scope: CANDIDATE_RESPONSE_SCOPE, adapterVersion: CANDIDATE_ADAPTER_VERSION, entry: packet.entry, exportName: packet.exportName, requestId: request.requestId, output: parsed.output, stdoutBytes: parsed.stdoutBytes, stdoutSha256: parsed.stdoutSha256, stderrBytes: started.stderrBytes, stderrSha256: sha(started.stderr), correlation: "fresh-random-wire-id-matched" });
    record.phase = "started"; await writeRecord(record);
  } catch (error) {
    diagnostic = error instanceof Error ? safeDiagnostic(error.message) : "contained candidate execution failed";
  } finally {
    if (durablePlanned || attemptedCreate) {
      record.phase = "cleanup-pending";
      record.cleanup = "pending";
      await writeRecord(record).catch((error: unknown) => { diagnostic ??= error instanceof Error ? safeDiagnostic(error.message) : "could not persist cleanup enrollment"; });
      cleanup = await cleanupOwned(record, env, workCwd).catch((error: unknown) => { diagnostic ??= error instanceof Error ? safeDiagnostic(error.message) : "owned cleanup could not be confirmed"; return "pending" as const; });
      await finishRecord(record, { exitCode, timedOut: timedOut || performance.now() >= deadline, aborted: aborted || signalAborted(signal), stdoutBytes, stderrBytes, aggregateBytes, overflow, ...(diagnostic ? { diagnostic } : {}) }, cleanup).catch((error: unknown) => { cleanup = "pending"; diagnostic ??= error instanceof Error ? safeDiagnostic(error.message) : "could not persist final cleanup receipt"; });
    } else if (workspace) {
      record.workspace = workspace;
      await cleanupWorkspace(record, false).catch((error: unknown) => {
        cleanup = "failed";
        diagnostic ??= error instanceof Error ? safeDiagnostic(error.message) : "prepared candidate workspace cleanup failed";
      });
    }
  }
  if (cleanup !== "confirmed") provisional = null;
  if (noteWindow() || aborted || timedOut || overflow) provisional = null;
  const receipt = receiptFor(record, { exitCode, timedOut: timedOut || performance.now() >= deadline, aborted: aborted || signalAborted(signal), stdoutBytes, stderrBytes, aggregateBytes, overflow, cleanup, ...(diagnostic ? { diagnostic } : {}) });
  if (cleanup === "confirmed" && durablePlanned && attemptedCreate) {
    // `finishRecord` persisted a candidate-process receipt before deleting its recovery enrollment.
  }
  return Object.freeze({ observation: provisional, receipt, ...(diagnostic ? { error: diagnostic } : {}) });
}

async function recheckMaterializedExport(packet: CandidateExportPacket, sourcePath: string, bootstrapPath: string): Promise<boolean> {
  try {
    const sourceRoot = await realpath(sourcePath);
    const actualFiles: string[] = [];
    const actualPaths: string[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = relative ? `${relative}/${item.name}` : item.name;
        if (!validRelativePath(path) || path !== path.normalize("NFC") || item.isSymbolicLink()) return fail("materialized candidate tree contains an unsafe path");
        actualPaths.push(path);
        if (item.isDirectory()) await walk(join(directory, item.name), path);
        else if (item.isFile()) actualFiles.push(path);
        else fail("materialized candidate tree contains a non-file entry");
      }
    };
    await walk(sourcePath, "");
    const foldedActual = new Map<string, string>();
    for (const path of actualPaths) {
      const folded = foldedPath(path);
      const existing = foldedActual.get(folded);
      if (existing && existing !== path) return false;
      foldedActual.set(folded, path);
    }
    const expectedFiles = [...packet.files.map((file) => file.path), ".agentx-bootstrap.mjs"].sort();
    if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(expectedFiles)) return false;
    const entries: string[] = [];
    const inodes = new Set<string>();
    for (const file of packet.files) {
      const parts = file.path.split("/");
      let parent = sourcePath;
      for (const segment of parts.slice(0, -1)) {
        parent = join(parent, segment);
        const parentInfo = await lstat(parent);
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o222) !== 0) return false;
      }
      const filePath = join(parent, parts.at(-1)!);
      const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        const bytes = await handle.readFile();
        const actualPath = await realpath(filePath);
        const inode = `${info.dev}:${info.ino}`;
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o222) !== 0 || !actualPath.startsWith(`${sourceRoot}${sep}`) || inodes.has(inode)
          || bytes.byteLength !== file.bytes.byteLength || sha(bytes) !== file.sha256 || !bytes.equals(Buffer.from(file.bytes))) return false;
        inodes.add(inode);
        entries.push(`${file.path}\0${sha(bytes)}\n`);
      } finally { await handle.close(); }
    }
    const filesDigest = sha(new TextEncoder().encode(entries.sort().join("")));
    const bootstrapHandle = await open(bootstrapPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await bootstrapHandle.stat();
      const bytes = await bootstrapHandle.readFile();
      const bootstrapPathActual = await realpath(bootstrapPath);
      const bootstrapInode = `${info.dev}:${info.ino}`;
      return sha(new TextEncoder().encode(`${packet.entry}\0${packet.exportName}\n${filesDigest}`)) === packet.sourceDigest
        && info.isFile() && info.nlink === 1 && (info.mode & 0o222) === 0 && bootstrapPathActual.startsWith(`${sourceRoot}${sep}`) && !inodes.has(bootstrapInode)
        && bytes.equals(Buffer.from(FIXED_CANDIDATE_BOOTSTRAP));
    } finally { await bootstrapHandle.close(); }
  } catch { return false; }
}
