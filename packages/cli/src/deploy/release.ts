// Loading a downloaded/verified release directory for install or upgrade: parses release.json,
// checks every template's and package's sha256 against what's on disk (catching a stale or
// tampered local copy before any stack is touched), and hands back the rendered templates and
// package paths the deploy engine needs.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReleaseManifestSchema, renderTemplate, type ReleaseManifest } from "@agentx/contracts";
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

/** Reads each entry's file relative to `dir` and compares its checksum against `entry.sha256`; a
 * missing file or a mismatch throws naming the file, exactly as release.json records it. */
async function checkFileChecksums(dir: string, entries: readonly { readonly file: string; readonly sha256: string }[]): Promise<void> {
  for (const entry of entries) {
    let data: Buffer;
    try {
      data = await readFile(join(dir, entry.file));
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
      const text = readFileSync(join(dir, entry.file), "utf8");
      return renderTemplate(text, env);
    },
    packagePath(assetId: string): string {
      const entry = manifest.packages.find((candidate) => candidate.assetId === assetId);
      if (entry === undefined) {
        throw new Error(`release ${manifest.version} has no package ${assetId}`);
      }
      return resolve(dir, entry.file);
    },
  };
}
