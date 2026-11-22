import { constants, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readlink, realpath, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AgentXNameSchema, agentXError } from "@agentx/contracts";
import { z } from "zod";
import { runIsolatedGit } from "./isolated-repository.js";
import type { PreparationManifest } from "./prepare.js";

const MAX_BYTES = 1_048_576;
const MAX_FILES = 4096;
const ManifestIdentity = z.object({
  schemaVersion: z.literal(2), complete: z.literal(true),
  projectName: AgentXNameSchema, projectRevision: z.number().int().positive(),
  repositories: z.array(z.object({
    name: AgentXNameSchema, path: z.string().min(1), defaultBranch: z.string().min(1),
    resolvedCommit: z.string().regex(/^[a-f0-9]{40}$/), resolvedAt: z.string().min(1), completedAt: z.string().min(1),
  })).min(1).max(32),
});

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw agentXError("WORKSPACE_NOT_READY", "close inspection needs a regular file");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) return bytes.subarray(0, size);
      size += read.bytesRead;
    }
    throw agentXError("WORKSPACE_NOT_READY", "close inspection file limit exceeded");
  } finally { await file.close(); }
}

export async function readCloseManifest(root: string): Promise<PreparationManifest> {
  const manifest = JSON.parse((await boundedFile(resolve(root, ".agentx/preparation-manifest.json"), 65_536)).toString("utf8")) as PreparationManifest;
  if (!ManifestIdentity.safeParse(manifest).success) throw agentXError("WORKSPACE_NOT_READY", "close inspection needs a complete bounded repository manifest");
  if (new Set(manifest.repositories.map((r) => r.name)).size !== manifest.repositories.length || new Set(manifest.repositories.map((r) => r.path)).size !== manifest.repositories.length) throw agentXError("WORKSPACE_NOT_READY", "close inspection repository identities must be unique");
  return manifest;
}

/** A bounded content identity, never file bytes in a result/log. Retention is a separate requirement; this hash is not a lock. */
export async function closeContentDigest(root: string, manifest: PreparationManifest): Promise<string> {
  const hash = createHash("sha256");
  let remaining = 8 * MAX_BYTES;
  const add = (value: unknown) => {
    const text = JSON.stringify(canonicalValue(value));
    if (text.includes("\ufffd")) throw agentXError("WORKSPACE_NOT_READY", "close inspection cannot certify undecodable paths");
    remaining -= Buffer.byteLength(text);
    if (remaining < 0) throw agentXError("WORKSPACE_NOT_READY", "close inspection byte limit exceeded");
    hash.update(text).update("\n");
  };
  add({ ...manifest, repositories: [...manifest.repositories].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
  for (const repo of [...manifest.repositories].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const directory = await realpath(resolve(root, repo.path));
    await assertCloseTree(directory);
    const git = (args: readonly string[]) => runIsolatedGit(directory, args, { maxBuffer: MAX_BYTES, timeout: 120_000 });
    add({ name: repo.name, path: repo.path, resolvedCommit: repo.resolvedCommit });
    add(await git(["rev-parse", "HEAD"]));
    add(await git(["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)"]));
    // Index object ids/modes include staged bytes, removals and renames; reject unmerged entries below.
    const index = await git(["ls-files", "--stage", "-z"]);
    if (index.split("\0").some((entry) => entry && !/^\d+ [a-f0-9]+ 0\t/u.test(entry))) throw agentXError("WORKSPACE_NOT_READY", "close inspection cannot certify an unmerged index");
    if (index.includes("160000 ")) throw agentXError("WORKSPACE_NOT_READY", "close inspection cannot certify submodules");
    add(index);
    add(await git(["ls-files", "-v", "-z"]));
    const paths = [...new Set((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))].sort();
    if (paths.length > MAX_FILES) throw agentXError("WORKSPACE_NOT_READY", "close inspection file limit exceeded");
    for (const path of paths) {
      const entry = await contentEntry(directory, path);
      remaining -= entry.bytes;
      add(entry.value);
    }
  }
  return hash.digest("hex");
}

async function contentEntry(directory: string, path: string): Promise<{ bytes: number; value: unknown }> {
  const candidate = resolve(directory, path);
  if (isAbsolute(path)) throw agentXError("WORKSPACE_NOT_READY", "close inspection path must be relative");
  assertContentContained(directory, candidate);
  const metadata = await lstat(candidate).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return { bytes: 0, value: { path, type: "deleted" } };
  assertContentContained(directory, await realpath(dirname(candidate)));

  if (metadata.isSymbolicLink()) {
    const target = await readlink(candidate);
    return { bytes: Buffer.byteLength(target), value: { path, type: "symlink", target } };
  }
  if (!metadata.isFile()) throw agentXError("WORKSPACE_NOT_READY", "close inspection encountered an unsupported file type");
  const bytes = await boundedFile(candidate, MAX_BYTES);
  return { bytes: bytes.length, value: { path, type: "file", mode: metadata.mode & 0o777, digest: createHash("sha256").update(bytes).digest("hex") } };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalValue(entry)]));
}

/** Git omits special files entirely; their presence must not turn an incomplete inventory into a clean result. */
async function assertCloseTree(root: string): Promise<void> {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for await (const entry of await opendir(directory)) {
      if (directory === root && entry.name === ".git") continue;
      if (++entries > MAX_FILES) throw agentXError("WORKSPACE_NOT_READY", "close inspection file limit exceeded");
      const child = closeTreeChild(directory, entry);
      if (child !== undefined) pending.push(child);
    }
  }
}

function closeTreeChild(directory: string, entry: Dirent): string | undefined {
  if (entry.isDirectory()) return resolve(directory, entry.name);
  if (!entry.isFile() && !entry.isSymbolicLink()) throw agentXError("WORKSPACE_NOT_READY", "close inspection encountered an unsupported file type");
  return undefined;
}

function assertContentContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw agentXError("WORKSPACE_NOT_READY", "close inspection path escapes repository");
}
