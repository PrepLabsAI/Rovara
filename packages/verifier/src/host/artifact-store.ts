import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, E2EAppArtifactRefSchema, E2ERunBindingSchema, E2EApplicationHostPreparationBindingSchema,
  E2ELinuxApplicationProfileSchema, type E2EAppArtifactRef, type E2EApplicationArtifactStore, type E2EApplicationArtifactStoreBinding,
  type E2ELinuxApplicationProfile } from "@agentx/contracts";

const chunkSize = 64 * 1024;
const maxArtifactBytes = 112 * 1024 * 1024;

type CatalogEntry = Readonly<{
  path: string;
  formatId: string;
  artifact: E2EAppArtifactRef;
  candidateDigest: string;
}>;
type Catalog = Readonly<{
  resolve(input: { artifactId: string; binding: E2EApplicationArtifactStoreBinding }, signal: AbortSignal): Promise<CatalogEntry>;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bindingCandidateDigest(binding: E2EApplicationArtifactStoreBinding): string {
  if ("preparationId" in binding) return E2EApplicationHostPreparationBindingSchema.parse(binding).candidateDigest;
  return E2ERunBindingSchema.parse(binding).candidateDigest;
}

async function readStableRegularFile(path: string, root: string, signal: AbortSignal): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root) || resolve(root) !== root) throw new Error("artifact catalog returned a non-canonical path");
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("artifact path escapes the installed private artifact root");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("installed private artifact root is not canonical");
  const rootStat = await lstat(root);
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : rootStat.uid;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== ownerUid || (rootStat.mode & 0o077) !== 0) {
    throw new Error("installed private artifact root must be owner-controlled and inaccessible to group or other users");
  }
  let parent = root;
  const pieces = relativePath.split(sep);
  for (const piece of pieces.slice(0, -1)) {
    if (piece.length === 0 || piece === "." || piece === "..") throw new Error("artifact path contains an invalid component");
    parent = `${parent}${sep}${piece}`;
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== ownerUid || (parentStat.mode & 0o077) !== 0
      || await realpath(parent) !== parent) throw new Error("artifact parent is not a private regular directory");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o077) !== 0
    || before.size > maxArtifactBytes || await realpath(path) !== path) throw new Error("artifact must be a bounded private canonical regular file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error("artifact file identity changed while opening");
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (signal.aborted) throw signal.reason ?? new Error("artifact read was aborted");
      const { bytesRead } = await handle.read(bytes, offset, Math.min(chunkSize, bytes.byteLength - offset), offset);
      if (bytesRead <= 0) throw new Error("artifact read ended before the catalogued byte length");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      bytes.fill(0);
      throw new Error("artifact identity changed during readback");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Fixed-root reader for catalog-issued artifact identities. The catalog never receives a caller path. */
function createStore(input: {
  privateRoot: string;
  catalog: Catalog;
  maxBytes?: number;
}): E2EApplicationArtifactStore {
  const root = resolve(input.privateRoot);
  const cap = input.maxBytes ?? maxArtifactBytes;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > maxArtifactBytes) throw new Error("artifact store limit is invalid");
  return Object.freeze({
    async open(openInput, signal) {
      if (signal.aborted) throw signal.reason ?? new Error("artifact open was aborted");
      const artifact = E2EAppArtifactRefSchema.parse(openInput.artifact);
      const binding = "preparationId" in openInput.binding
        ? E2EApplicationHostPreparationBindingSchema.parse(openInput.binding)
        : E2ERunBindingSchema.parse(openInput.binding);
      const entry = await input.catalog.resolve({ artifactId: artifact.artifactId, binding }, signal);
      const catalogArtifact = E2EAppArtifactRefSchema.parse(entry.artifact);
      if (canonicalJson(catalogArtifact) !== canonicalJson(artifact)) throw new Error("artifact reference differs from its protected catalog entry");
      if (entry.candidateDigest !== bindingCandidateDigest(binding)) throw new Error("artifact catalog candidate does not match the exact preparation or run binding");
      if (entry.formatId !== "e2e-app-archive/v1") throw new Error("artifact format does not match the installed web/API archive codec");
      const bytes = await readStableRegularFile(entry.path, root, signal);
      if (bytes.byteLength > cap || sha256(bytes) !== artifact.sha256) {
        bytes.fill(0);
        throw new Error("actual serialized artifact bytes do not match the approved artifact reference");
      }
      let closed = false;
      let nextOffset = 0;
      return Object.freeze({
        byteLength: bytes.byteLength,
        sha256: artifact.sha256,
        formatId: entry.formatId,
        async readChunk(offset: number, chunkSignal: AbortSignal) {
          if (closed) throw new Error("artifact reader is closed");
          if (chunkSignal.aborted) throw chunkSignal.reason ?? new Error("artifact chunk read was aborted");
          if (!Number.isSafeInteger(offset) || offset !== nextOffset || offset >= bytes.byteLength) throw new Error("artifact chunks must be read once in exact ordered offsets");
          const chunk = Uint8Array.from(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
          nextOffset += chunk.byteLength;
          return Object.freeze({ offset, totalBytes: bytes.byteLength, sha256: sha256(chunk), bytes: chunk });
        },
        async close() {
          if (!closed) {
            closed = true;
            bytes.fill(0);
          }
        },
      });
    },
  });
}

export function createE2EApplicationArtifactStore(input: { profile: E2ELinuxApplicationProfile; catalog: Catalog }): E2EApplicationArtifactStore {
  const profile = E2ELinuxApplicationProfileSchema.parse(input.profile);
  return createStore({ privateRoot: profile.privateRoots.artifacts, catalog: input.catalog });
}

/** @internal Test seam for ordinary temporary directories; never used by the installed host composition. */
export function createE2EApplicationArtifactStoreForConformance(input: { privateRoot: string; catalog: Catalog }): E2EApplicationArtifactStore {
  return createStore(input);
}
