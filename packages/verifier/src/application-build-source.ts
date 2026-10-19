import { createHash } from "node:crypto";
import { types } from "node:util";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson, CandidateManifestSchema, E2EApplicationBuildBindingSchema,
  E2EApplicationBuildSourceManifestSchema, E2EApplicationBuildSourceRefSchema,
  copyBoundedE2ESourceBytes, verifyE2ESourceSnapshot, type CandidateManifest, type E2EApplicationBuildBinding,
  type E2EApplicationBuildSourceManifest, type E2EApplicationBuildSourceRef, type E2ESourceSnapshot } from "@agentx/contracts";

const chunkSize = 64 * 1024;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const blobId = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), Buffer.from(bytes)])).digest("hex");

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("build source import input must be an ordinary record");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["manifest", "reference", "expectedCandidate", "inspectionSnapshot", "binding", "readChunk", "destination", "signal"]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new TypeError("build source import input has unknown fields");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("build source import input must contain own data fields");
    result[key] = descriptor.value as unknown;
  }
  return result;
}

export type E2EApplicationBuildArchiveFile = Readonly<{ path: string; mode: "100644" | "100755"; bytes: Uint8Array }>;
export type E2EApplicationBuildSourceArchive = Readonly<{ bytes: Uint8Array; sha256: string; byteLength: number; fileCount: number }>;

function canonicalArchive(filesInput: readonly E2EApplicationBuildArchiveFile[]): { text: string; files: E2EApplicationBuildArchiveFile[] } {
  if (!Array.isArray(filesInput) || Object.getPrototypeOf(filesInput) !== Array.prototype || filesInput.length > 10_000) throw new Error("build source files exceed their count bound");
  const list = Object.getOwnPropertyDescriptors(filesInput);
  if (Reflect.ownKeys(list).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= filesInput.length))) throw new TypeError("build source file list has extra properties");
  const files = Array.from({ length: filesInput.length }, (_, index) => {
    const descriptor = list[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("build source file list must contain own data entries");
    const raw = descriptor.value as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError("build source file must be an ordinary data record");
    const fields = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(fields).some((key) => typeof key !== "string" || !["path", "mode", "bytes"].includes(key))
      || !fields.path || !("value" in fields.path) || !fields.mode || !("value" in fields.mode) || !fields.bytes || !("value" in fields.bytes)
      || !fields.path.enumerable || !fields.mode.enumerable || !fields.bytes.enumerable) throw new TypeError("build source file must contain only own path, mode, and bytes data fields");
    const file = { path: fields.path.value as unknown, mode: fields.mode.value as unknown,
      bytes: copyBoundedE2ESourceBytes(fields.bytes.value as unknown, 8 * 1024 * 1024) };
    if (typeof file.path !== "string" || !/^(?:100644|100755)$/.test(String(file.mode))) throw new TypeError("build source file identity or bytes are invalid");
    if (!file.path || file.path.normalize("NFC") !== file.path || Buffer.byteLength(file.path, "utf8") > 1024 || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some((part: string) => !part || part === "." || part === "..") || !isSafePath(file.path)) throw new Error("build source path is unsafe or outside the approved path policy");
    const bytes = Buffer.from(file.bytes);
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error(`permitted source file is too large: ${file.path}`);
    return { path: file.path, mode: file.mode as "100644" | "100755", bytes };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("build source archive contains duplicate paths");
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > 64 * 1024 * 1024) throw new Error("build source archive exceeds the decoded byte limit");
  const text = canonicalJson({ schemaVersion: "e2e-application-build-source-archive/v1", files: files.map(({ path, mode, bytes }) => ({ path, mode, bytesBase64: bytes.toString("base64") })) });
  if (Buffer.byteLength(text, "utf8") > 112 * 1024 * 1024) throw new Error("encoded build source archive exceeds the transfer ceiling");
  return { text, files };
}
function isSafePath(path: string): boolean {
  try { return (requireSafePath(path)); } catch { return false; }
}
function requireSafePath(path: string): boolean {
  // The contract implementation remains the single source of truth for blocked names.
  return safeSourcePath(path);
}
import { isSafeE2ESourcePath as safeSourcePath } from "@agentx/contracts";

export function encodeE2EApplicationBuildSourceArchive(files: readonly E2EApplicationBuildArchiveFile[]): E2EApplicationBuildSourceArchive {
  const { text, files: normalized } = canonicalArchive(files);
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ bytes, sha256: digest(bytes), byteLength: bytes.byteLength, fileCount: normalized.length });
}

function assertCandidateIdentity(manifest: E2EApplicationBuildSourceManifest, expectedCandidateInput: CandidateManifest,
  snapshot: E2ESourceSnapshot): void {
  const expectedCandidate = CandidateManifestSchema.parse(expectedCandidateInput);
  const candidateRepository = expectedCandidate.repositories.find((repository) => repository.repositoryId === manifest.repository.repositoryId);
  if (expectedCandidate.repositories.length !== 1 || !candidateRepository || expectedCandidate.digest !== manifest.candidateDigest
    || candidateRepository.commitSha !== manifest.repository.commitSha || candidateRepository.treeSha !== manifest.repository.treeSha
    || candidateRepository.baseCommitSha !== manifest.repository.baseCommitSha) throw new Error("build source manifest does not bind the exact single-repository candidate commit, tree, and base identity");
  verifyE2ESourceSnapshot(snapshot, expectedCandidate);
  if (snapshot.commitSha !== manifest.repository.commitSha || snapshot.treeSha !== manifest.repository.treeSha) throw new Error("build source manifest identity differs from the protected inspection candidate");
}

export function validateE2EApplicationBuildSourceManifest(input: {
  manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef;
  expectedCandidate: CandidateManifest; inspectionSnapshot: E2ESourceSnapshot;
}): E2EApplicationBuildSourceManifest {
  const manifest = E2EApplicationBuildSourceManifestSchema.parse(input.manifest);
  const reference = E2EApplicationBuildSourceRefSchema.parse(input.reference);
  assertCandidateIdentity(manifest, input.expectedCandidate, input.inspectionSnapshot);
  const repository = CandidateManifestSchema.parse(input.expectedCandidate).repositories[0]!;
  if (manifest.repository.repositoryId !== repository.repositoryId || manifest.repository.commitSha !== repository.commitSha
    || manifest.repository.treeSha !== repository.treeSha || manifest.repository.baseCommitSha !== repository.baseCommitSha) throw new Error("build source repository identity differs from the selected candidate");
  if (reference.manifestDigest !== manifest.manifestDigest || reference.sha256 !== manifest.archive.sha256 || reference.byteLength !== manifest.archive.byteLength) throw new Error("build source reference does not match its exact manifest and archive identity");
  const snapshotPaths = [...input.inspectionSnapshot.treePaths].sort();
  const manifestPaths = manifest.treeEntries.map((entry) => entry.path).sort();
  if (canonicalJson(snapshotPaths) !== canonicalJson(manifestPaths)) throw new Error("build source tree inventory differs from the complete inspected candidate path set");
  const sourceByPath = new Map(input.inspectionSnapshot.sources.map((source) => [source.path, source]));
  for (const file of manifest.files) {
    const inspectionSource = sourceByPath.get(file.path);
    if (inspectionSource && (inspectionSource.kind !== "blob" || inspectionSource.sha256 !== file.sha256 || inspectionSource.bytes.byteLength !== file.byteLength)) throw new Error("build source file differs from its overlapping inspection blob");
  }
  return manifest;
}

type BuildSourceChunk = { offset: number; totalBytes: number; sha256: string; bytes: Uint8Array };
export async function materializeE2EApplicationBuildSource(input: {
  manifest: E2EApplicationBuildSourceManifest; reference: E2EApplicationBuildSourceRef; expectedCandidate: CandidateManifest;
  inspectionSnapshot: E2ESourceSnapshot; binding: E2EApplicationBuildBinding;
  readChunk(offset: number, signal: AbortSignal): Promise<BuildSourceChunk>; destination: string; signal: AbortSignal;
}): Promise<{ sourceDirectory: string; manifestDigest: string; archiveSha256: string; fileCount: number }> {
  const envelope = inputRecord(input);
  const signal = envelope.signal as AbortSignal;
  const destination = envelope.destination as string;
  const readChunk = envelope.readChunk as (offset: number, signal: AbortSignal) => Promise<BuildSourceChunk>;
  if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof readChunk !== "function" || typeof destination !== "string") throw new TypeError("build source import requires a fixed destination, reader, and AbortSignal");
  const manifest = validateE2EApplicationBuildSourceManifest({ manifest: envelope.manifest as E2EApplicationBuildSourceManifest,
    reference: envelope.reference as E2EApplicationBuildSourceRef, expectedCandidate: envelope.expectedCandidate as CandidateManifest,
    inspectionSnapshot: envelope.inspectionSnapshot as E2ESourceSnapshot });
  const reference = E2EApplicationBuildSourceRefSchema.parse(envelope.reference);
  if (manifest.files.reduce((sum, file) => sum + file.byteLength, 0) > 64 * 1024 * 1024) throw new Error("build source archive exceeds the decoded byte limit");
  const binding = E2EApplicationBuildBindingSchema.parse(envelope.binding);
  if (binding.candidateDigest !== manifest.candidateDigest || binding.buildSourceManifestDigest !== manifest.manifestDigest || binding.buildSourceSha256 !== reference.sha256) throw new Error("build ticket does not bind this exact source archive");
  const deadline = Date.parse(binding.deadlineAt);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("build source preparation deadline has expired");
  const assertActive = () => {
    if (signal.aborted || Date.now() >= deadline) throw new Error("build source import was cancelled or exceeded its preparation deadline");
  };
  assertActive();
  const rootPath = resolve(destination);
  let rootStat;
  try { rootStat = await lstat(rootPath); } catch { throw new Error("build source destination must be a fresh owned directory"); }
  assertActive();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (uid !== undefined && rootStat.uid !== uid) || (rootStat.mode & 0o077) !== 0) throw new Error("build source destination must be an empty, owner-controlled private directory");
  assertActive();
  const rootEntries = await readdir(rootPath);
  assertActive();
  if (rootEntries.length !== 0) throw new Error("build source destination must be an empty, owner-controlled private directory");
  assertActive();
  const rootReal = await realpath(rootPath);
  assertActive();
  if (rootReal !== rootPath) throw new Error("build source destination must use its canonical no-follow path");
  for (let ancestor = dirname(rootPath); ; ancestor = dirname(ancestor)) {
    assertActive();
    const stat = await lstat(ancestor);
    assertActive();
    const trustedOwner = uid === undefined || stat.uid === uid || stat.uid === 0;
    const writableByOthers = Boolean(stat.mode & 0o022);
    const protectedSharedTemp = stat.uid === 0 && Boolean(stat.mode & 0o1000);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner || (writableByOthers && !protectedSharedTemp)) throw new Error("build source destination has an untrusted, writable, symlinked, or non-canonical ancestor");
    assertActive();
    const ancestorReal = await realpath(ancestor);
    assertActive();
    if (ancestorReal !== ancestor) throw new Error("build source destination has an untrusted, writable, symlinked, or non-canonical ancestor");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < reference.byteLength) {
    if (signal.aborted || Date.now() >= deadline) throw new Error("build source import was cancelled or exceeded its preparation deadline");
    const chunk = await raceUntilDeadline(readChunk, offset, signal, deadline, "build source chunk read exceeded its preparation deadline");
    if (signal.aborted || Date.now() >= deadline) throw new Error("build source import was cancelled or exceeded its preparation deadline");
    if (chunk.offset !== offset || chunk.totalBytes !== reference.byteLength || chunk.sha256 !== reference.sha256
      || !(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > chunkSize
      || offset % chunkSize !== 0 || (offset + chunk.bytes.byteLength < reference.byteLength && chunk.bytes.byteLength !== chunkSize)
      || offset + chunk.bytes.byteLength > reference.byteLength) throw new Error("build source chunks are out of order or do not match their immutable transfer ticket");
    chunks.push(Buffer.from(chunk.bytes));
    offset += chunk.bytes.byteLength;
  }
  const archiveBytes = Buffer.concat(chunks);
  if (archiveBytes.byteLength !== reference.byteLength || digest(archiveBytes) !== reference.sha256) throw new Error("build source archive bytes do not match their content reference");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(archiveBytes); } catch { throw new Error("build source archive is not valid UTF-8"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error("build source archive is not valid JSON"); }
  if (canonicalJson(parsed) !== text) throw new Error("build source archive is not canonical JSON");
  const archiveSchema = zArchiveSchema.safeParse(parsed);
  if (!archiveSchema.success || archiveSchema.data.files.length !== manifest.files.length || archiveBytes.byteLength !== manifest.archive.byteLength
    || digest(archiveBytes) !== manifest.archive.sha256) throw new Error("build source archive does not match its manifest count, digest, or size");
  const actualByPath = new Map(archiveSchema.data.files.map((file) => [file.path, file]));
  if (actualByPath.size !== manifest.files.length) throw new Error("build source archive contains duplicate files");
  let decodedBytes = 0;
  for (const file of manifest.files) {
    assertActive();
    const actual = actualByPath.get(file.path);
    if (!actual || actual.mode !== file.mode) throw new Error("build source archive file set or executable mode differs from its manifest");
    const bytes = Buffer.from(actual.bytesBase64, "base64");
    decodedBytes += bytes.byteLength;
    if (decodedBytes > 64 * 1024 * 1024) throw new Error("decoded build source archive exceeds the 64 MiB aggregate limit");
    if (bytes.toString("base64") !== actual.bytesBase64 || bytes.byteLength !== file.byteLength || digest(bytes) !== file.sha256 || blobId(bytes) !== file.gitBlobId) throw new Error(`build source file bytes do not match their Git blob and content identities: ${file.path}`);
  }
  for (const file of archiveSchema.data.files) if (!manifest.files.some((item) => item.path === file.path)) throw new Error("build source archive contains an unmanifested file");
  for (const file of manifest.files) {
    assertActive();
    const output = resolve(rootReal, file.path);
    const rel = relative(rootReal, output);
    if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(rootReal, rel) !== output) throw new Error("build source output path escapes its private directory");
    assertActive();
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    assertActive();
    for (let current = dirname(output); current !== rootReal && current.startsWith(rootReal + sep); current = dirname(current)) {
      assertActive();
      const stat = await lstat(current);
      assertActive();
      if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw new Error("build source path contains a symlink, non-private, or non-directory ancestor");
    }
    assertActive();
    const entry = archiveSchema.data.files.find((item) => item.path === file.path)!;
    const bytes = Buffer.from(entry.bytesBase64, "base64");
    assertActive();
    const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), file.mode === "100755" ? 0o700 : 0o600);
    assertActive();
    try {
      assertActive();
      await handle.writeFile(bytes);
      assertActive();
      await handle.sync();
      assertActive();
    } finally { await handle.close(); }
    assertActive();
    assertActive();
    const readback = await open(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    assertActive();
    try {
      assertActive();
      const stat = await readback.stat();
      assertActive();
      const bytes = await readback.readFile();
      assertActive();
      const expectedMode = file.mode === "100755" ? 0o700 : 0o600;
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || stat.nlink !== 1 || (stat.mode & 0o777) !== expectedMode
        || bytes.byteLength !== file.byteLength || digest(bytes) !== file.sha256) throw new Error("materialized source file failed no-follow readback validation");
    } finally { await readback.close(); }
  }
  assertActive();
  return { sourceDirectory: rootReal, manifestDigest: manifest.manifestDigest, archiveSha256: reference.sha256, fileCount: manifest.files.length };
}

async function raceUntilDeadline<T>(operation: (offset: number, signal: AbortSignal) => Promise<T>, offset: number,
  signal: AbortSignal, deadline: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const forwardAbort = () => controller.abort(signal.reason);
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(new Error(message)); reject(new Error(message)); };
    if (signal.aborted || Date.now() >= deadline) { onAbort(); return; }
    signal.addEventListener("abort", forwardAbort, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(1, Math.min(deadline - Date.now(), 2_147_483_647)));
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error(message);
    return operation(offset, controller.signal);
  }), interrupted]); }
  finally { if (timer) clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); signal.removeEventListener("abort", forwardAbort); }
}

import { z } from "zod";
const zArchiveSchema = z.object({ schemaVersion: z.literal("e2e-application-build-source-archive/v1"), files: z.array(z.object({
  path: z.string().min(1).max(1024), mode: z.enum(["100644", "100755"]), bytesBase64: z.string().max(12 * 1024 * 1024),
}).strict()).max(10_000) }).strict();
