import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENVIRONMENT_PLACEHOLDER, STACK_PARTS, environmentStackName } from "@agentx/contracts";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SUPPORTED_REGIONS } from "../../infra/lib/production-foundation.js";
import { sha256Hex } from "./hash.js";
import { ImageDigest, ReleaseManifestSchema, type ReleaseManifest } from "./manifest.js";
import { zipDirectory } from "./zip.js";

export interface BuildReleaseInput {
  version: string;
  out: string;
  gitCommit: string;
  images?: { worker?: string; slack?: string };
}

// scripts/release/build.ts -> repo root is two levels up. NodejsFunction's esbuild bundles embed
// source-map `sources` as paths *relative to the bundle's own location*: when that bundle is built
// under an unrelated directory tree (os.tmpdir(), which varies by TMPDIR and by how deep the OS
// nests it), esbuild finds no common ancestor with the checkout and falls back to walking all the
// way up to "/" and back down through the checkout's *absolute* path — embedding that path as text
// and making the number of ".." segments depend on tmpdir's depth. Synthesizing at a fixed depth
// under the repo root instead keeps the relative path between the bundle and its sources constant
// (the same "../../../packages/..." however deep or wherever the checkout itself lives), so asset
// ids, zip checksums, the control-plane template and release.json stop depending on TMPDIR or the
// checkout's location. Verified by inspecting a real index.js.map: synthesizing under os.tmpdir()
// embedded "../../../../../../../../Users/<name>/.../packages/...", synthesizing under
// `<repoRoot>/.release-synth/...` produced clean "../../../node_modules/..." with no absolute path.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RELEASE_SYNTH_ROOT = join(REPO_ROOT, ".release-synth");

/** Validates images against ImageDigest before any other work, so a bad reference fails fast. */
function checkedImages(images: BuildReleaseInput["images"]): ReleaseManifest["images"] {
  const result: ReleaseManifest["images"] = {};
  if (images?.worker !== undefined) {
    const parsed = ImageDigest.safeParse(images.worker);
    if (!parsed.success) throw new Error(`worker image must be referenced by digest, not ${JSON.stringify(images.worker)}`);
    result.worker = parsed.data;
  }
  if (images?.slack !== undefined) {
    const parsed = ImageDigest.safeParse(images.slack);
    if (!parsed.success) throw new Error(`slack image must be referenced by digest, not ${JSON.stringify(images.slack)}`);
    result.slack = parsed.data;
  }
  return result;
}

/** Reuses the manifest schema's own field validators, so "valid" means the same thing everywhere. */
export function checkedVersion(version: string): string {
  const parsed = ReleaseManifestSchema.shape.version.safeParse(version);
  if (!parsed.success) throw new Error(`version must be a semantic version such as 1.2.3 or 1.2.3-beta.1, not ${JSON.stringify(version)}`);
  return parsed.data;
}

function checkedGitCommit(gitCommit: string): string {
  const parsed = ReleaseManifestSchema.shape.gitCommit.safeParse(gitCommit);
  if (!parsed.success) throw new Error(`gitCommit must be a 40-character hex git commit SHA, not ${JSON.stringify(gitCommit)}`);
  return parsed.data;
}

/**
 * CDK_CONTEXT_JSON and the context-overflow temp file are how the `cdk` CLI (or a leftover/ambient
 * environment) inject context; buildAgentXApp lets CDK_CONTEXT_JSON/the overflow file win over its
 * own context argument to match how App itself merges context (see infra/lib/app.ts). That is the
 * right behavior for `cdk synth`, but it means an ambient CDK_CONTEXT_JSON could silently override
 * this function's agentxEnv/agentxSynthesizer/outdir and produce a release that depends on whatever
 * happened to be in the calling shell's environment. Refuse instead.
 */
export function checkedNoAmbientCdkContext(): void {
  if (process.env[CONTEXT_ENV] !== undefined) {
    throw new Error(
      `refusing to build a release with ${CONTEXT_ENV} set in the environment; it could override this release's context and make the output depend on the ambient environment instead of these inputs alone. Unset it and retry`,
    );
  }
  if (process.env[CONTEXT_OVERFLOW_LOCATION_ENV] !== undefined) {
    throw new Error(
      `refusing to build a release with ${CONTEXT_OVERFLOW_LOCATION_ENV} set in the environment; it could override this release's context and make the output depend on the ambient environment instead of these inputs alone. Unset it and retry`,
    );
  }
}

/**
 * Runs `run` with the process's current working directory pinned to the repo root, restoring the
 * caller's original cwd afterward (even if `run` throws). infra/lib/control-plane.ts resolves each
 * Lambda's `entry` with `resolve(process.cwd(), entry)` against paths that are relative to the repo
 * root (e.g. "packages/broker/src/aws/broker.ts"), and NodejsFunction bundles each one synchronously
 * while the stacks are being constructed — before `.synth()` is ever called. So this release builder
 * has to produce the same output regardless of the caller's own working directory.
 *
 * process.chdir is process-global state, not scoped to this call: it affects every other piece of
 * code running in this process at the same time, so this only works because vitest runs this
 * suite's files under the forks pool (a separate OS process per test file) and no test in this file
 * calls buildRelease concurrently with another cwd-sensitive call.
 */
export function withRepoRootCwd<T>(run: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);
  try {
    return run();
  } finally {
    process.chdir(originalCwd);
  }
}

/** The out directory must not already hold a release; it is created if absent. */
async function claimOutDir(out: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(out, { recursive: true });
      return;
    }
    throw error;
  }
  if (existing.length > 0) {
    throw new Error(`release output directory is not empty: ${out}`);
  }
}

export interface PackageAccumulator {
  assetId: string;
  directory: string;
  parts: string[];
  bucketParameter: string;
  keyParameter: string;
  hashParameter: string;
}

/** The shape of a CDK FileAssetMetadataEntry/ContainerImageAssetMetadataEntry this function needs. */
export interface ReleaseAssetLike {
  packaging: string;
  id: string;
  s3BucketParameter: string;
  s3KeyParameter: string;
  artifactHashParameter: string;
}

/**
 * Folds one stack's asset into the running per-assetId accumulator (mutates `packagesById`). Only
 * zip-packaged Lambda code assets are supported; anything else (a Docker image asset, or a plain
 * "file"-packaged asset) is an error naming it, because images are published separately and this
 * release has no other asset kind today. The legacy synthesizer names a parameter from the asset id
 * alone, so the same asset id must produce the same parameter names in every stack that uses it;
 * that is checked here rather than assumed.
 */
export function accumulateAsset(packagesById: Map<string, PackageAccumulator>, asset: ReleaseAssetLike, part: string, directory: string): void {
  if (asset.packaging !== "zip") {
    throw new Error(
      `unsupported asset packaging ${JSON.stringify(asset.packaging)} for asset ${asset.id} in the ${part} template; only zip-packaged Lambda code assets are supported here, images are published separately`,
    );
  }
  const existing = packagesById.get(asset.id);
  if (existing === undefined) {
    packagesById.set(asset.id, {
      assetId: asset.id,
      directory,
      parts: [part],
      bucketParameter: asset.s3BucketParameter,
      keyParameter: asset.s3KeyParameter,
      hashParameter: asset.artifactHashParameter,
    });
  } else if (
    existing.bucketParameter !== asset.s3BucketParameter ||
    existing.keyParameter !== asset.s3KeyParameter ||
    existing.hashParameter !== asset.artifactHashParameter
  ) {
    throw new Error(`asset ${asset.id} has different parameter names across stacks, which the legacy synthesizer should never produce`);
  } else {
    existing.parts.push(part);
  }
}

/**
 * Code packages are shared across regions: an asset's id is a hash of its content, and Lambda code
 * doesn't depend on region, so every region's synth is expected to accumulate the very same set of
 * asset ids, each with the same parameter names. Returns true when `candidate` (a later region)
 * disagrees with `baseline` (the first region synthesized) in either respect.
 */
export function assetSignatureMismatch(
  baseline: ReadonlyMap<string, PackageAccumulator>,
  candidate: ReadonlyMap<string, PackageAccumulator>,
): boolean {
  if (baseline.size !== candidate.size) return true;
  for (const [assetId, expected] of baseline) {
    const actual = candidate.get(assetId);
    if (
      actual === undefined ||
      actual.bucketParameter !== expected.bucketParameter ||
      actual.keyParameter !== expected.keyParameter ||
      actual.hashParameter !== expected.hashParameter
    ) {
      return true;
    }
  }
  return false;
}

export async function buildRelease(input: BuildReleaseInput): Promise<ReleaseManifest> {
  // Fail fast, before touching the filesystem or running the expensive synth below, and in an
  // order that leaves the output directory untouched (absent, or unmodified if pre-existing) for
  // every one of these refusals, not just the non-empty-directory one.
  const images = checkedImages(input.images);
  const version = checkedVersion(input.version);
  const gitCommit = checkedGitCommit(input.gitCommit);
  checkedNoAmbientCdkContext();
  await claimOutDir(input.out);

  await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
  const synthDirs: string[] = [];
  try {
    // Write each region's parts, in SUPPORTED_REGIONS order, each region's parts in STACK_PARTS
    // (deploy) order, and group each stack's zip-packaged code assets by asset id. Code packages are
    // shared across regions (asset hashes don't depend on region), so only the first region's
    // (the baseline's) synth directories are kept around for zipping below; every later region is
    // checked against the baseline's asset ids and parameter names instead of contributing its own.
    const templates: ReleaseManifest["templates"] = [];
    const packagesById = new Map<string, PackageAccumulator>();
    await mkdir(join(input.out, "templates"), { recursive: true });

    for (const [index, region] of SUPPORTED_REGIONS.entries()) {
      // Synthesize the placeholder-environment app, bootstrap-free, at a fixed depth under the repo
      // root (see REPO_ROOT's comment for why), with the repo root as the working directory (see
      // withRepoRootCwd's comment for why).
      const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
      synthDirs.push(synthDir);
      const assembly = withRepoRootCwd(() =>
        buildAgentXApp({
          agentxEnv: ENVIRONMENT_PLACEHOLDER,
          agentxSynthesizer: "legacy",
          agentxRegion: region,
          outdir: synthDir,
        }).synth(),
      );

      const stackByName = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));
      await mkdir(join(input.out, "templates", region), { recursive: true });

      const regionPackagesById = new Map<string, PackageAccumulator>();
      for (const part of STACK_PARTS) {
        const stackName = environmentStackName(ENVIRONMENT_PLACEHOLDER, part);
        const stack = stackByName.get(stackName);
        if (!stack) throw new Error(`release synth produced no stack named ${stackName} (part ${part}, region ${region})`);
        const file = `templates/${region}/${part}.template.json`;
        const text = `${JSON.stringify(stack.template, null, 2)}\n`;
        await writeFile(join(input.out, file), text, "utf8");
        templates.push({ region, part, file, sha256: sha256Hex(Buffer.from(text, "utf8")) });

        for (const asset of stack.assets) {
          accumulateAsset(regionPackagesById, asset, part, join(assembly.directory, asset.path));
        }
      }

      if (index === 0) {
        for (const [assetId, accumulated] of regionPackagesById) packagesById.set(assetId, accumulated);
      } else if (assetSignatureMismatch(packagesById, regionPackagesById)) {
        throw new Error(`region ${region} produced different code packages`);
      }
    }

    // Zip and write each distinct asset once, sorted by asset id for a stable manifest order.
    await mkdir(join(input.out, "packages"), { recursive: true });
    const packages: ReleaseManifest["packages"] = [];
    for (const assetId of [...packagesById.keys()].sort()) {
      const accumulated = packagesById.get(assetId);
      if (accumulated === undefined) throw new Error(`missing accumulated package for asset ${assetId}`);
      const zipBuffer = await zipDirectory(accumulated.directory);
      const file = `packages/${assetId}.zip`;
      await writeFile(join(input.out, file), zipBuffer);
      packages.push({
        assetId,
        file,
        sha256: sha256Hex(zipBuffer),
        parts: accumulated.parts,
        bucketParameter: accumulated.bucketParameter,
        keyParameter: accumulated.keyParameter,
        hashParameter: accumulated.hashParameter,
        keyParameterValue: `packages/||${assetId}.zip`,
      });
    }

    // Include both current and previously granted license texts plus the grant history in the
    // release artifact, and checksum them in release.json like every other shipped file.
    const legalDir = join(input.out, "legal");
    await mkdir(legalDir, { recursive: true });
    const legalDocuments: NonNullable<ReleaseManifest["legalDocuments"]> = [];
    for (const name of ["LICENSE", "LICENSE-APACHE", "RELICENSED.md"] as const) {
      const file = `legal/${name}`;
      await copyFile(join(REPO_ROOT, name), join(input.out, file));
      const content = await readFile(join(input.out, file));
      legalDocuments.push({ file, sha256: sha256Hex(content) });
    }

    // Write release.json as validated, pretty JSON.
    const manifest = ReleaseManifestSchema.parse({
      schemaVersion: 1,
      version,
      gitCommit,
      environmentPlaceholder: ENVIRONMENT_PLACEHOLDER,
      templates,
      packages,
      legalDocuments,
      images,
    } satisfies ReleaseManifest);
    await writeFile(join(input.out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } finally {
    await Promise.all(synthDirs.map((synthDir) => rm(synthDir, { recursive: true, force: true })));
  }
}

function usage(): string {
  return (
    "Usage: tsx scripts/release/build.ts --version <version> --out <dir> " +
    "[--worker-image <uri@sha256:...>] [--slack-image <uri@sha256:...>]\n"
  );
}

interface CliArgs {
  version: string;
  out: string;
  images?: { worker?: string; slack?: string };
}

export function parseBuildArgs(argv: readonly string[]): CliArgs {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  const known = new Set(["--version", "--out", "--worker-image", "--slack-image", "--help"]);
  for (const argument of argv) {
    if (argument.startsWith("--") && !known.has(argument)) throw new Error(`unknown option ${argument}`);
  }
  const version = valueAfter("--version");
  const out = valueAfter("--out");
  if (version === undefined) throw new Error("--version is required");
  if (out === undefined) throw new Error("--out is required");
  const worker = valueAfter("--worker-image");
  const slack = valueAfter("--slack-image");
  return {
    version,
    out,
    ...(worker !== undefined || slack !== undefined
      ? { images: { ...(worker !== undefined ? { worker } : {}), ...(slack !== undefined ? { slack } : {}) } }
      : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage());
  } else {
    // Wraps the synchronous argument parsing and `git rev-parse` too, not just the buildRelease
    // promise below: a bad flag or a missing git checkout used to crash with a raw Node stack trace
    // instead of the same clean "agentx release build failed: ..." message + exit code every other
    // failure gets.
    try {
      const args = parseBuildArgs(process.argv.slice(2));
      const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      buildRelease({
        version: args.version,
        out: resolve(args.out),
        gitCommit,
        ...(args.images !== undefined ? { images: args.images } : {}),
      })
        .then((manifest) => {
          process.stdout.write(`wrote release ${manifest.version} (${manifest.gitCommit}) to ${resolve(args.out)}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`agentx release build failed: ${message}\n`);
          process.exitCode = 1;
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agentx release build failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
