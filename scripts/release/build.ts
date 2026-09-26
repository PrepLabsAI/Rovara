import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENVIRONMENT_PLACEHOLDER, STACK_PARTS, environmentStackName } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ImageDigest, ReleaseManifestSchema, type ReleaseManifest } from "./manifest.js";
import { zipDirectory } from "./zip.js";

export interface BuildReleaseInput {
  version: string;
  out: string;
  gitCommit: string;
  images?: { worker?: string; slack?: string };
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

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

interface PackageAccumulator {
  assetId: string;
  directory: string;
  parts: string[];
  bucketParameter: string;
  keyParameter: string;
  hashParameter: string;
}

export async function buildRelease(input: BuildReleaseInput): Promise<ReleaseManifest> {
  // 1. Validate images before any other work (fail fast, before the expensive synth below).
  const images = checkedImages(input.images);
  // 2. Refuse a non-empty output directory.
  await claimOutDir(input.out);

  const synthDir = await mkdtemp(join(tmpdir(), "agentx-release-synth-"));
  try {
    // 3. Synthesize the placeholder-environment app, bootstrap-free, into a temporary directory.
    const assembly = buildAgentXApp({
      agentxEnv: ENVIRONMENT_PLACEHOLDER,
      agentxSynthesizer: "legacy",
      agentxRegion: "us-east-1",
      outdir: synthDir,
    }).synth();

    const stackByName = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));

    // 4. Write each part's template, in deploy order.
    const templates: ReleaseManifest["templates"] = [];
    const packagesById = new Map<string, PackageAccumulator>();
    await mkdir(join(input.out, "templates"), { recursive: true });
    for (const part of STACK_PARTS) {
      const stackName = environmentStackName(ENVIRONMENT_PLACEHOLDER, part);
      const stack = stackByName.get(stackName);
      if (!stack) throw new Error(`release synth produced no stack named ${stackName} (part ${part})`);
      const file = `templates/${part}.template.json`;
      const text = `${JSON.stringify(stack.template, null, 2)}\n`;
      await writeFile(join(input.out, file), text, "utf8");
      templates.push({ part, file, sha256: sha256Hex(Buffer.from(text, "utf8")) });

      // 5. Group this stack's zip-packaged code assets by asset id across stacks. The legacy
      // synthesizer names a parameter from the asset id alone, so the same id has the same
      // parameter names in every stack that references it.
      for (const asset of stack.assets) {
        if (asset.packaging !== "zip") {
          throw new Error(
            `unsupported asset packaging ${JSON.stringify(asset.packaging)} for asset ${asset.id} in the ${part} template; only zip-packaged Lambda code assets are supported here, images are published separately`,
          );
        }
        const existing = packagesById.get(asset.id);
        if (existing === undefined) {
          packagesById.set(asset.id, {
            assetId: asset.id,
            directory: join(assembly.directory, asset.path),
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

    // 6. Write release.json as validated, pretty JSON.
    const manifest = ReleaseManifestSchema.parse({
      schemaVersion: 1,
      version: input.version,
      gitCommit: input.gitCommit,
      environmentPlaceholder: ENVIRONMENT_PLACEHOLDER,
      templates,
      packages,
      images,
    } satisfies ReleaseManifest);
    await writeFile(join(input.out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } finally {
    await rm(synthDir, { recursive: true, force: true });
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
  }
}
