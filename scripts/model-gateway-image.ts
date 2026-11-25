// Builds the Cloud model gateway's container image context, and the image from it, on this machine. It never pushes: pushing the image
// to the gateway-images stack's repository is a separate, approved step. Nothing here calls AWS or the network (a build pulls the
// base image by digest, and the build stage installs the compiler from environments/model-gateway/toolchain's lockfile).
//
//   npx tsx scripts/model-gateway-image.ts context --out <empty dir>   write the exact build context (no docker needed)
//   npx tsx scripts/model-gateway-image.ts build [--tag <name:tag>]    context in a temp dir, then docker buildx build --load (arm64)
//
// The context is an explicit file list, never the checkout: a stray .env, dist, node_modules or worktree cannot enter the image.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The process entry the image runs. infra/lib/model-gateway.ts sets no command, so this line of the Dockerfile is the contract. */
export const GATEWAY_IMAGE_ENTRY = "packages/model-gateway/dist/main.js";
export const GATEWAY_IMAGE_ENTRY_SOURCE = "packages/model-gateway/src/main.ts";
export const GATEWAY_IMAGE_DOCKERFILE = "environments/model-gateway/Dockerfile";
export const GATEWAY_IMAGE_PLATFORM = "linux/arm64";
export const GATEWAY_IMAGE_DEFAULT_TAG = "rovara-model-gateway:local";

/** One TOTAL limit for the whole context, whatever the tree holds. */
export const MAX_CONTEXT_FILES = 200;
export const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;

const FIXED_FILES = [
  "tsconfig.base.json",
  "packages/model-gateway/package.json",
  "packages/model-gateway/tsconfig.json",
  GATEWAY_IMAGE_DOCKERFILE,
  "environments/model-gateway/toolchain/package.json",
  "environments/model-gateway/toolchain/package-lock.json",
] as const;
const SOURCE_ROOT = "packages/model-gateway/src";

export interface ContextFile { path: string; bytes: number; sha256: string }
export interface ContextManifest { files: ContextFile[]; totalBytes: number; contextSha256: string }

export class ImageContextError extends Error {}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory)).sort()) {
      const path = `${directory}/${entry}`;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw new ImageContextError("a symbolic link is not allowed in the image context");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) found.push(path);
      else if (!stat.isFile()) throw new ImageContextError("an unsupported file kind is not allowed in the image context");
      else if (!path.endsWith(".ts") && !path.endsWith(".test.ts")) throw new ImageContextError("the gateway source holds a file that is not TypeScript");
      if (found.length > MAX_CONTEXT_FILES) throw new ImageContextError("the image context has too many files");
    }
  };
  if (!existsSync(join(root, SOURCE_ROOT))) throw new ImageContextError("the gateway package source is missing");
  // The walk checks every entry below src; check the parents of src itself too.
  for (const parent of ["packages", "packages/model-gateway", SOURCE_ROOT]) if (lstatSync(join(root, parent)).isSymbolicLink()) throw new ImageContextError("a symbolic link is not allowed in the image context");
  walk(SOURCE_ROOT);
  return found;
}

/** Every file of the build context, in a fixed order. Refuses a missing file, a link, or a context over the total limits. */
export function listContextFiles(root: string): string[] {
  const files = [...FIXED_FILES, ...sourceFiles(root)];
  if (files.length > MAX_CONTEXT_FILES) throw new ImageContextError("the image context has too many files");
  for (const file of files) {
    let stat;
    try { stat = lstatSync(join(root, file)); } catch { throw new ImageContextError(`an image context file is missing: ${file}`); }
    if (!stat.isFile()) throw new ImageContextError(`an image context path is not a regular file: ${file}`);
  }
  return files;
}

/** Whether the process entry's source exists. The image build fails without it; `context` still works so the rest can be checked. */
export function entryPresent(root: string): boolean {
  return existsSync(join(root, GATEWAY_IMAGE_ENTRY_SOURCE));
}

/** Writes the context into an empty (or new) directory and returns what it holds with checksums. */
export function assembleContext(root: string, outDir: string): ContextManifest {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new ImageContextError("the output directory is not empty");
  const files = listContextFiles(root);
  const entries: ContextFile[] = [];
  let totalBytes = 0;
  const contents = new Map<string, Buffer>();
  for (const file of files) {
    const data = readFileSync(join(root, file));
    totalBytes += data.byteLength;
    if (totalBytes > MAX_CONTEXT_BYTES) throw new ImageContextError("the image context is over its size limit");
    contents.set(file, data);
    entries.push({ path: file, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
  }
  for (const [file, data] of contents) {
    const target = join(outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    chmodSync(target, 0o644); // whatever the caller's umask: the image runs as another user and must be able to read every copied file
  }
  const contextSha256 = createHash("sha256").update(entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("")).digest("hex");
  return { files: entries, totalBytes, contextSha256 };
}

/** The docker command for a build. Local image only: refuses anything that could push or change where the image goes. */
export function dockerBuildArguments(contextDir: string, tag: string): string[] {
  if (!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]{1,128}$/u.test(tag)) throw new ImageContextError("the image tag must be name:tag with plain characters");
  if (/^[^/]*\.[^/]*\//u.test(tag)) throw new ImageContextError("the image tag must be a local name, not a registry address");
  return ["buildx", "build", "--platform", GATEWAY_IMAGE_PLATFORM, "--load", "--file", join(contextDir, GATEWAY_IMAGE_DOCKERFILE), "--tag", tag, contextDir];
}

function repositoryRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Command-line entry. Returns the process exit code. */
export function main(argv: string[], root = repositoryRoot(), run = spawnSync): number {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]!;
    const value = rest[index + 1];
    if ((name !== "--out" && name !== "--tag") || value === undefined || options.has(name)) { console.error("usage: model-gateway-image.ts context --out <dir> | build [--tag name:tag]"); return 2; }
    options.set(name, value);
  }
  try {
    if (command === "context") {
      const out = options.get("--out");
      if (out === undefined || options.has("--tag")) { console.error("usage: model-gateway-image.ts context --out <dir>"); return 2; }
      const manifest = assembleContext(root, out);
      console.log(JSON.stringify({ out, files: manifest.files.length, totalBytes: manifest.totalBytes, contextSha256: manifest.contextSha256, entryPresent: entryPresent(root) }));
      return 0;
    }
    if (command === "build") {
      if (options.has("--out")) { console.error("usage: model-gateway-image.ts build [--tag name:tag]"); return 2; }
      if (!entryPresent(root)) { console.error(`the gateway process entry ${GATEWAY_IMAGE_ENTRY_SOURCE} does not exist yet: nothing to run, so no image is built`); return 3; }
      const tag = options.get("--tag") ?? GATEWAY_IMAGE_DEFAULT_TAG;
      const directory = mkdtempSync(join(tmpdir(), "model-gateway-image-"));
      try {
        const context = join(directory, "context");
        const manifest = assembleContext(root, context);
        console.log(JSON.stringify({ contextSha256: manifest.contextSha256, files: manifest.files.length }));
        const result = run("docker", dockerBuildArguments(context, tag), { stdio: "inherit" });
        if (result.status === null || result.status === undefined) { console.error("docker did not run (is it installed and its daemon running?)"); return 1; }
        return result.status;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.error(error instanceof ImageContextError ? error.message : "the image build failed");
    return 1;
  }
  console.error("usage: model-gateway-image.ts context --out <dir> | build [--tag name:tag]");
  return 2;
}

if (process.argv[1] !== undefined && relative(fileURLToPath(import.meta.url), process.argv[1]) === "") process.exitCode = main(process.argv.slice(2));
