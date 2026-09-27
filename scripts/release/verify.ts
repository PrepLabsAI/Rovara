import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRelease } from "./build.js";
import { sha256Hex } from "./hash.js";
import { ReleaseManifestSchema, type ReleaseManifest } from "./manifest.js";

export interface VerifyReleaseInput {
  dir: string;
}

export type VerifyReleaseResult = { ok: true } | { ok: false; problems: string[] };

/** Reads each entry's file relative to `dir` and compares its checksum against `entry.sha256`,
 * pushing a problem naming the file instead of throwing when the file is missing or unreadable. */
async function checkFileChecksums(
  dir: string,
  entries: readonly { readonly file: string; readonly sha256: string }[],
  problems: string[],
): Promise<void> {
  for (const entry of entries) {
    let data: Buffer;
    try {
      data = await readFile(join(dir, entry.file));
    } catch (error) {
      problems.push(`${entry.file}: could not be read (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const actual = sha256Hex(data);
    if (actual !== entry.sha256) {
      problems.push(`${entry.file}: checksum mismatch (release.json says ${entry.sha256}, file on disk is ${actual})`);
    }
  }
}

/**
 * Verifies a release directory two ways:
 *  1. Every file release.json lists (each template, each package) is read back off disk and its
 *     checksum compared against the one recorded in release.json, catching a release directory
 *     that has been tampered with or partially copied.
 *  2. The same version and gitCommit are rebuilt from the current source (no images — they play no
 *     part in template/package synthesis) into a throwaway directory, and every template's and
 *     package's checksum is compared against that rebuild, catching a release that no longer
 *     matches what the current checkout would produce. Drift is reported in both directions: a
 *     release entry the rebuild no longer produces, and a rebuilt template or package the release
 *     doesn't have.
 */
export async function verifyRelease(input: VerifyReleaseInput): Promise<VerifyReleaseResult> {
  const dir = resolve(input.dir);
  const problems: string[] = [];

  let manifest: ReleaseManifest;
  try {
    manifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(dir, "release.json"), "utf8")));
  } catch (error) {
    return { ok: false, problems: [`release.json: ${error instanceof Error ? error.message : String(error)}`] };
  }

  await checkFileChecksums(dir, manifest.templates, problems);
  await checkFileChecksums(dir, manifest.packages, problems);

  const rebuildParent = await mkdtemp(join(tmpdir(), "agentx-verify-rebuild-"));
  try {
    const rebuilt = await buildRelease({
      version: manifest.version,
      out: join(rebuildParent, "r"),
      gitCommit: manifest.gitCommit,
    });

    const templateKey = (t: { region: string; part: string }): string => `${t.region}/${t.part}`;
    const rebuiltTemplatesByKey = new Map(rebuilt.templates.map((t) => [templateKey(t), t.sha256]));
    const releaseTemplateKeys = new Set(manifest.templates.map(templateKey));
    for (const template of manifest.templates) {
      const rebuiltSha = rebuiltTemplatesByKey.get(templateKey(template));
      if (rebuiltSha === undefined) {
        problems.push(`${template.file}: rebuilding from current source produced no ${template.part} template for region ${template.region}`);
      } else if (rebuiltSha !== template.sha256) {
        problems.push(
          `${template.file}: does not match a rebuild from current source (release has ${template.sha256}, rebuild has ${rebuiltSha})`,
        );
      }
    }
    for (const rebuiltTemplate of rebuilt.templates) {
      if (!releaseTemplateKeys.has(templateKey(rebuiltTemplate))) {
        problems.push(
          `${rebuiltTemplate.file}: rebuilding from current source produces a ${rebuiltTemplate.part} template for region ${rebuiltTemplate.region} not present in this release`,
        );
      }
    }

    const rebuiltPackagesById = new Map(rebuilt.packages.map((p) => [p.assetId, p]));
    const releasePackageIds = new Set(manifest.packages.map((p) => p.assetId));
    for (const pkg of manifest.packages) {
      const rebuiltPkg = rebuiltPackagesById.get(pkg.assetId);
      if (rebuiltPkg === undefined) {
        problems.push(`${pkg.file}: rebuilding from current source did not produce this package`);
      } else if (rebuiltPkg.sha256 !== pkg.sha256) {
        problems.push(
          `${pkg.file}: does not match a rebuild from current source (release has ${pkg.sha256}, rebuild has ${rebuiltPkg.sha256})`,
        );
      }
    }
    for (const rebuiltPkg of rebuilt.packages) {
      if (!releasePackageIds.has(rebuiltPkg.assetId)) {
        problems.push(`${rebuiltPkg.file}: rebuilding from current source produces a package not present in this release`);
      }
    }
  } finally {
    await rm(rebuildParent, { recursive: true, force: true });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true };
}

function usage(): string {
  return "Usage: tsx scripts/release/verify.ts <dir>\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help") || process.argv.length < 3) {
    process.stdout.write(usage());
    if (process.argv.length < 3) process.exitCode = 1;
  } else {
    const dir = resolve(process.argv[2]!);
    verifyRelease({ dir })
      .then((result) => {
        if (result.ok) {
          process.stdout.write(`release at ${dir} verified ok\n`);
        } else {
          for (const problem of result.problems) process.stderr.write(`${problem}\n`);
          process.exitCode = 1;
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`agentx release verify failed: ${message}\n`);
        process.exitCode = 1;
      });
  }
}
