// Loading a downloaded/verified release directory for install or upgrade: parses release.json,
// checks every template's and package's sha256 against what's on disk (catching a stale or
// tampered local copy before any stack is touched), and hands back the rendered templates and
// package paths the deploy engine needs.
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { agentXError, ReleaseManifestSchema, renderTemplate, type ReleaseManifest } from "@agentx/contracts";
import { sha256Hex } from "./hash.js";
import type { DeployPart } from "./parameters.js";

export interface LoadedRelease {
  manifest: ReleaseManifest;
  dir: string;
  /** The template for part in region, rendered for env. Throws when the release does not cover the region. */
  template(part: DeployPart, region: string, env: string): string;
  /** Absolute path of a package zip. */
  packagePath(assetId: string): string;
  regions(): string[];
}

/** What `assertReleaseCoversRegion` reads from a release; a `LoadedRelease` is one. */
export interface ReleaseCoverage {
  manifest: { version: string };
  regions(): readonly string[];
}

/** The templates engine can only deploy the templates a release was built for: refuses any other
 * region, listing the ones it covers. The one place this check and its wording live, shared by
 * `agentx deploy`, `agentx init`, the export bundle and the templates engine itself. */
export function assertReleaseCoversRegion(release: ReleaseCoverage, region: string): void {
  const problem = releaseRegionProblem(release, region);
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", problem);
}

/** `assertReleaseCoversRegion`'s message when the release does not cover `region`, otherwise
 * undefined: for callers that collect problems instead of stopping at the first. */
export function releaseRegionProblem(release: ReleaseCoverage, region: string): string | undefined {
  const regions = release.regions();
  if (regions.includes(region)) return undefined;
  return `release ${release.manifest.version} does not cover region ${region}; it covers: ${regions.join(", ") || "no region"}`;
}

/**
 * Resolves `file` (as recorded in release.json) against `dir` and refuses to hand back a path
 * outside it, whether `file` is absolute or escapes via `..` segments. release.json's schema
 * already constrains every `file` value to a safe pattern, but whoever can edit release.json also
 * controls its recorded sha256, so a checksum match alone proves nothing about where the path
 * actually points; this check is the loader's own, independent guard and runs on every read here,
 * regardless of what the schema did or didn't catch.
 *
 * A lexical check alone would miss a `file` that resolves lexically inside `dir` but is itself a
 * symlink (or sits under a symlinked directory) pointing outside it, so — mirroring
 * packages/cli/src/config.ts and deployment.ts — this also resolves both `dir` and the candidate
 * path with realpath and re-checks containment on the resolved paths. A `file` that does not exist
 * throws a clear "is missing" error instead of a raw ENOENT.
 */
export function containedPath(dir: string, file: string): string {
  const base = resolve(dir);
  const resolved = resolve(base, file);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`release file ${file} is outside the release directory`);
  }
  let realBase: string;
  let realTarget: string;
  try {
    realBase = realpathSync(base);
    realTarget = realpathSync(resolved);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    // ENOTDIR: a path component that should be a directory (to hold the rest of `file`) is
    // actually a regular file — indistinguishable from a plain missing file to whoever asked for
    // this path, so it gets the same "is missing" message.
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`release file ${file} is missing`, { cause: error });
    }
    // ELOOP: too many symlinks were followed resolving `file` (most commonly a symlink whose
    // target — directly or transitively — is itself), so unlike ENOENT this is never simply
    // "absent"; say so distinctly rather than call a symlink loop "missing".
    if (code === "ELOOP") {
      throw new Error(`release file ${file} is not a regular file (too many symbolic links)`, { cause: error });
    }
    throw error;
  }
  if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
    throw new Error(`release file ${file} is outside the release directory`);
  }
  return resolved;
}

/** Reads each entry's file relative to `dir` (via `containedPath`) and compares its checksum
 * against `entry.sha256`; a missing file or a mismatch throws naming the file, exactly as
 * release.json records it. */
async function checkFileChecksums(dir: string, entries: readonly { readonly file: string; readonly sha256: string }[]): Promise<void> {
  for (const entry of entries) {
    const path = containedPath(dir, entry.file);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new Error(`release file ${entry.file} does not match release.json`);
    }
    if (sha256Hex(data) !== entry.sha256) {
      throw new Error(`release file ${entry.file} does not match release.json`);
    }
  }
}

/** Validates release.json and every file's sha256 before returning. */
export async function loadRelease(dir: string): Promise<LoadedRelease> {
  const manifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(dir, "release.json"), "utf8")));
  await checkFileChecksums(dir, manifest.templates);
  await checkFileChecksums(dir, manifest.packages);
  await checkFileChecksums(dir, manifest.legalDocuments ?? []);

  return {
    manifest,
    dir,
    regions(): string[] {
      return [...new Set(manifest.templates.map((entry) => entry.region))];
    },
    template(part: DeployPart, region: string, env: string): string {
      const entry = manifest.templates.find((candidate) => candidate.region === region && candidate.part === part);
      if (entry === undefined) {
        throw new Error(`release ${manifest.version} does not cover region ${region}`);
      }
      const text = readFileSync(containedPath(dir, entry.file), "utf8");
      return renderTemplate(text, env);
    },
    packagePath(assetId: string): string {
      const entry = manifest.packages.find((candidate) => candidate.assetId === assetId);
      if (entry === undefined) {
        throw new Error(`release ${manifest.version} has no package ${assetId}`);
      }
      return containedPath(dir, entry.file);
    },
  };
}
