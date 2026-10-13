import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { CandidateManifestSchema, type CandidateManifest } from "./task-workflow.js";

export type E2ESourceSnapshot = {
  candidate: CandidateManifest;
  commitSha: string;
  treeSha: string;
  treeComplete: true;
  treePaths: readonly string[];
  sources: readonly { path: string; sha256: string; bytes: Uint8Array; kind: "blob" | "symlink" | "submodule" }[];
};

const blockedPathSegment = /^(?:\.git|\.github|\.aws|\.ssh|\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;
export function isSafeE2ESourcePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  try {
    let decoded = path;
    for (let depth = 0; depth < 4; depth += 1) decoded = decodeURIComponent(decoded);
    return !decoded.includes("\\") && !decoded.includes("\0") && !decoded.startsWith("/")
      && !decoded.split("/").some((part) => part === "" || part === "." || part === ".." || blockedPathSegment.test(part));
  } catch { return false; }
}

/** Structural candidate-bound verification. Native callers still load expectedCandidate from their authenticated record. */
export function verifyE2ESourceSnapshot(snapshotInput: E2ESourceSnapshot, expectedCandidateInput: CandidateManifest): Map<string, E2ESourceSnapshot["sources"][number]> {
  if (snapshotInput.treeComplete !== true || !Array.isArray(snapshotInput.treePaths) || snapshotInput.treePaths.length > 100_000 || snapshotInput.sources.length > 512) throw new Error("immutable source tree is incomplete or outside its bounds");
  const candidate = CandidateManifestSchema.parse(snapshotInput.candidate);
  const expectedCandidate = CandidateManifestSchema.parse(expectedCandidateInput);
  if (canonicalJson(candidate) !== canonicalJson(expectedCandidate)) throw new Error("source snapshot does not match the expected immutable candidate");
  if (candidate.repositories.length !== 1 || candidate.repositories[0]?.commitSha !== snapshotInput.commitSha || candidate.repositories[0]?.treeSha !== snapshotInput.treeSha) throw new Error("source snapshot commit and tree do not match its candidate manifest");
  // The complete tree inventory is membership evidence, so retain paths that are
  // intentionally excluded from runner sources (for example .env files). Only
  // paths promoted to source blobs are subject to the runner-safe path policy.
  if (snapshotInput.treePaths.some((path) => typeof path !== "string" || path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0"))) throw new Error("immutable tree path inventory contains an invalid path");
  const treePaths = new Set(snapshotInput.treePaths);
  if (treePaths.size !== snapshotInput.treePaths.length) throw new Error("immutable tree path inventory contains duplicate paths");
  const sourceMap = new Map<string, E2ESourceSnapshot["sources"][number]>();
  let totalBytes = 0;
  for (const source of snapshotInput.sources) {
    if (source.kind !== "blob" || !isSafeE2ESourcePath(source.path) || !treePaths.has(source.path) || sourceMap.has(source.path)) throw new Error("source path is unsafe, duplicated, symlinked, or outside the immutable candidate tree");
    if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength > 512 * 1024) throw new Error("source file exceeds the immutable snapshot size limit");
    totalBytes += source.bytes.byteLength;
    if (totalBytes > 4 * 1024 * 1024) throw new Error("source snapshot exceeds the aggregate byte limit");
    if (createHash("sha256").update(source.bytes).digest("hex") !== source.sha256) throw new Error("source bytes do not match their SHA-256 reference");
    sourceMap.set(source.path, source);
  }
  return sourceMap;
}
