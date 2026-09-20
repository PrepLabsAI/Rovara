import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CandidateResultSchema, CANDIDATE_CHUNK_BYTES, MAX_CANDIDATE_BYTES, WorkerInvocationSchema, agentXError, candidateArtifactId, type CandidateResult, type WorkerInvocation } from "@agentx/contracts";
import type { ArtifactSink } from "./artifacts.js";
import { WorkerOperationCancelledError } from "./cancel.js";

const exec = promisify(execFile);
type Task = Extract<WorkerInvocation, { kind: "task" }>;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const forbidden = /(^|\/)(\.env(?:\..*)?|\.agentx|\.git|\.ssh|\.aws|\.npmrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519|.*\.(?:pem|key))($|\/)/i;
const debris = /(^|\/)(node_modules|dist|build|coverage|\.next|\.venv|venv|__pycache__|\.pytest_cache|\.DS_Store)($|\/)/;
const suspicious = /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/;

// Local demo boundary: broker invocation and this directory are trusted runtime state.
// The coding process must be quiescent; this detects ordinary races, not a hostile process
// able to alter the worker runtime itself. Such isolation is a separate managed gate.
export function candidateDirectory(root: string, operationId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(operationId)) throw agentXError("CONFIG_INVALID", "invalid candidate operation");
  return resolve(root, ".agentx/candidates", operationId);
}

function binding(invocation: Task): string {
  return hash(JSON.stringify({ workspaceId: invocation.workspaceId, operationId: invocation.operationId, fence: invocation.fence,
    projectRevision: invocation.projectRevision, candidate: invocation.payload.candidate, project: invocation.payload.project }));
}

async function repository(root: string, invocation: Task) {
  const candidate = invocation.payload.candidate;
  const project = invocation.payload.project;
  if (!candidate || !project || project.revision !== invocation.projectRevision) throw agentXError("CONFIG_INVALID", "candidate requires trusted project binding");
  const selected = project.repositories.find((entry) => entry.name === candidate.repository);
  if (!selected) throw agentXError("CONFIG_INVALID", "candidate repository not registered");
  const canonicalRoot = await realpath(root);
  const path = await realpath(resolve(root, selected.path));
  const from = relative(canonicalRoot, path);
  if (!from || from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) throw agentXError("CONFIG_INVALID", "repository escapes workspace");
  if ((await git(path, ["remote", "get-url", "origin"])).trim() !== selected.url) throw agentXError("CONFIG_INVALID", "candidate repository remote mismatch");
  const url = new URL(selected.url);
  if (url.username || url.password) throw agentXError("CONFIG_INVALID", "credential-bearing repository remote");
  if ((await git(path, ["rev-parse", "--show-toplevel"])).trim() !== path) throw agentXError("CONFIG_INVALID", "repository root mismatch");
  return { path, selected, candidate };
}

export async function assertTaskCandidateBase(rootPath: string, invocation: Task): Promise<string> {
  WorkerInvocationSchema.parse(invocation);
  const { path, candidate } = await repository(rootPath, invocation);
  if ((await git(path, ["rev-parse", "HEAD"])).trim() !== candidate.baseCommit) throw agentXError("CONFIG_INVALID", "candidate base commit does not match job start");
  if ((await git(path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw agentXError("CONFIG_INVALID", "candidate task requires a clean starting workspace");
  const directory = candidateDirectory(rootPath, invocation.operationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "start.json"), JSON.stringify({ binding: binding(invocation) }), { flag: "wx", mode: 0o600 });
  return path;
}

export async function freezeTaskCandidate(input: {
  rootPath: string; invocation: Task; artifactSink: ArtifactSink; isCancelled?: () => boolean;
}): Promise<CandidateResult> {
  WorkerInvocationSchema.parse(input.invocation);
  const { invocation } = input;
  const checkCancellation = () => { if (input.isCancelled?.()) throw new WorkerOperationCancelledError(invocation.operationId); };
  checkCancellation();
  const directory = candidateDirectory(input.rootPath, invocation.operationId);
  const start = JSON.parse(await readFile(resolve(directory, "start.json"), "utf8")) as { binding: string };
  if (start.binding !== binding(invocation)) throw agentXError("IDEMPOTENCY_CONFLICT", "candidate binding conflict");
  const recordPath = resolve(directory, "candidate.json");
  let result: CandidateResult;
  const persisted = await readFile(recordPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (persisted) {
    result = CandidateResultSchema.parse(JSON.parse(persisted));
  } else {
    const { path, selected, candidate } = await repository(input.rootPath, invocation);
    const before = await captureSource(path);
    const objectStore = resolve(directory, `objects-${randomUUID()}`);
    await mkdir(objectStore, { mode: 0o700 });
    await git(objectStore, ["init", "--bare", "--initial-branch=candidate"]);
    const baseBundle = resolve(objectStore, "base.bundle");
    const baseRef = `refs/agentx-capture/${randomUUID()}`;
    await git(path, ["update-ref", baseRef, candidate.baseCommit, "0".repeat(40)]);
    try { await git(path, ["bundle", "create", baseBundle, baseRef]); }
    finally { await git(path, ["update-ref", "-d", baseRef, candidate.baseCommit]); }
    await git(objectStore, ["fetch", "--no-tags", baseBundle, baseRef]);
    await rm(baseBundle);
    await git(objectStore, ["read-tree", "--empty"]);
    for (const file of before.files) {
      const blobFile = resolve(directory, `blob-${randomUUID()}`);
      await writeFile(blobFile, file.bytes, { mode: 0o600, flag: "wx" });
      try {
        const blob = (await git(objectStore, ["hash-object", "-w", "--no-filters", blobFile])).trim();
        await git(objectStore, ["update-index", "--add", "--cacheinfo", `${file.mode},${blob},${file.path}`]);
      } finally { await rm(blobFile); }
    }
    const tree = (await git(objectStore, ["write-tree"])).trim();
    const after = await captureSource(path);
    if (before.fingerprint !== after.fingerprint) throw agentXError("STALE_FENCE", "workspace mutated during candidate capture");
    checkCancellation();
    const commit = (await git(objectStore, ["-c", "user.name=AgentX", "-c", "user.email=agentx@noreply.local", "commit-tree", tree, "-p", candidate.baseCommit, "-m", `AgentX candidate ${invocation.operationId}`])).trim();
    await git(objectStore, ["update-ref", "refs/heads/candidate", commit]);
    const temporaryBundle = resolve(directory, `candidate-${randomUUID()}.bundle`);
    await git(objectStore, ["bundle", "create", temporaryBundle, "refs/heads/candidate", "HEAD"]);
    const bytes = await readFile(temporaryBundle);
    if (bytes.length > MAX_CANDIDATE_BYTES) throw agentXError("CONFIG_INVALID", "candidate bundle exceeds 64 MiB limit");
    const createdAt = new Date().toISOString();
    const chunks: CandidateResult["retrieval"]["chunks"] = [];
    for (let offset = 0; offset < bytes.length; offset += CANDIDATE_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + CANDIDATE_CHUNK_BYTES);
      const name = `candidate-${invocation.operationId}-${String(chunks.length).padStart(4, "0")}.bundle.base64`;
      chunks.push({ artifactId: candidateArtifactId(invocation.operationId, name), name, sha256: hash(part), sizeBytes: part.length });
    }
    result = CandidateResultSchema.parse({ schemaVersion: 1, candidateId: invocation.operationId, ...candidate,
      operationId: invocation.operationId, workspaceId: invocation.workspaceId, projectRevision: invocation.projectRevision,
      repositoryUrl: selected.url, commit, tree, createdAt, expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
      producer: "agentx-worker", qualification: "claimed", retrieval: { kind: "agentx-artifacts", format: "git-bundle", sha256: hash(bytes), sizeBytes: bytes.length, chunks } });
    await rename(temporaryBundle, resolve(directory, "candidate.bundle"));
    await writeFile(recordPath, JSON.stringify(result), { flag: "wx", mode: 0o600 });
  }
  if (Date.parse(result.expiresAt) <= Date.now()) throw agentXError("CONFIG_INVALID", "candidate retention expired");
  const bytes = await readFile(resolve(directory, "candidate.bundle"));
  if (hash(bytes) !== result.retrieval.sha256 || bytes.length !== result.retrieval.sizeBytes) throw agentXError("CONFIG_INVALID", "retained candidate bundle changed");
  let offset = 0;
  for (const chunk of result.retrieval.chunks) {
    checkCancellation();
    const content = bytes.subarray(offset, offset + chunk.sizeBytes).toString("base64"); offset += chunk.sizeBytes;
    const receipt = await input.artifactSink({ id: chunk.artifactId, name: chunk.name, mediaType: "application/vnd.agentx.git-bundle-chunk.base64", content });
    if (!receipt || receipt.artifactId !== chunk.artifactId || receipt.sha256 !== hash(content) || receipt.sizeBytes !== Buffer.byteLength(content)) throw agentXError("RUNTIME_UNAVAILABLE", "candidate upload receipt mismatch");
  }
  checkCancellation();
  return result;
}

async function captureSource(path: string) {
  if ((await git(path, ["ls-files", "--unmerged"])).trim()) throw agentXError("CONFIG_INVALID", "unmerged candidate source");
  const tracked = new Set((await git(path, ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean));
  const names = [...new Set([...tracked, ...(await git(path, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean)])].sort();
  const files: Array<{ path: string; mode: string; bytes: Buffer }> = [];
  let total = 0;
  for (const name of names) {
    if (isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..") ||
        [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw agentXError("CONFIG_INVALID", "unsafe candidate path");
    }
    if (forbidden.test(name) || debris.test(name)) {
      if (tracked.has(name)) throw agentXError("CONFIG_INVALID", "tracked credential or generated path requires cleanup before capture");
      continue;
    }
    const full = resolve(path, name);
    const metadata = await lstat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!metadata) continue;
    const parent = await realpath(dirname(full));
    if (parent !== path && !parent.startsWith(`${path}${sep}`)) throw agentXError("CONFIG_INVALID", "candidate path traverses symlink");
    // First demo rejects all symlinks; no automatic dereference or external-object fetch.
    if (metadata.isSymbolicLink()) { await readlink(full); throw agentXError("CONFIG_INVALID", "candidate symlink is unsupported"); }
    if (!metadata.isFile()) throw agentXError("CONFIG_INVALID", "submodule or special candidate file is unsupported");
    total += metadata.size;
    if (total > MAX_CANDIDATE_BYTES) throw agentXError("CONFIG_INVALID", "candidate source exceeds 64 MiB limit");
    const bytes = await readFile(full);
    if (suspicious.test(bytes.toString("utf8"))) throw agentXError("CONFIG_INVALID", "candidate source contains credential material");
    if (bytes.subarray(0, 200).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) throw agentXError("CONFIG_INVALID", "Git LFS candidate object is unsupported");
    files.push({ path: name, mode: metadata.mode & 0o111 ? "100755" : "100644", bytes });
  }
  const head = (await git(path, ["rev-parse", "HEAD"])).trim();
  return { files, fingerprint: hash(JSON.stringify({ head, files: files.map((file) => [file.path, file.mode, hash(file.bytes)]) })) };
}

export async function candidateGit(directory: string, args: readonly string[]): Promise<string> { return git(directory, args); }

async function git(directory: string, args: readonly string[]): Promise<string> {
  // Managed workspace mounts can use a different UID. Match preparation's
  // exact-directory trust without inheriting ambient Git config or trusting '*'.
  const canonicalDirectory = await realpath(directory);
  const result = await exec("git", ["--no-replace-objects", "-c", `safe.directory=${canonicalDirectory}`, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always", "-C", canonicalDirectory, ...args], {
    env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    timeout: 120_000, maxBuffer: MAX_CANDIDATE_BYTES, encoding: "utf8",
  });
  return result.stdout;
}
