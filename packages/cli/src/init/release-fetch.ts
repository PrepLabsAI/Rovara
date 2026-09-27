// `npx @charterarc/agentx init` needs the release matching the CLI: the GitHub release's
// release.json and tarball. The extracted release.json must equal the published one byte for byte;
// loadRelease then checks every file's sha256 against it.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentXError } from "@agentx/contracts";
import type { CommandRunner } from "../deploy/cdk-engine.js";

export const RELEASE_REPOSITORY = "PrepLabsAI/AgentX";

export function releaseAssetUrls(version: string): { tarball: string; manifest: string } {
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  return { tarball: `${base}/agentx-${version}.tar.gz`, manifest: `${base}/release.json` };
}

export function releaseCacheDir(home: string, version: string): string {
  return join(home, ".agentx", "releases", version);
}

async function download(fetchImplementation: typeof fetch, url: string, version: string): Promise<Buffer> {
  const response = await fetchImplementation(url);
  if (response.status === 404) throw agentXError("CONFIG_INVALID", `release ${version} was not found at ${url}; check the version is published, or pass --release <dir>`);
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `downloading ${url} failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Downloads the GitHub release's release.json and tarball, extracts it with tar, and checks the
 * extracted release.json is byte for byte the published one. A cached release whose release.json
 * already matches is reused without downloading the tarball again. A mismatch (or a missing
 * release) refuses and leaves the cache untouched: the tarball is extracted into a scratch
 * directory next to the cache and only renamed into place once it checks out, so a failed or
 * interrupted fetch never leaves a half-written release directory. `loadRelease` then checks every
 * file's checksum.
 */
export async function fetchRelease(input: { version: string | undefined; home: string; fetch: typeof fetch; runner: CommandRunner; write(line: string): void }): Promise<string> {
  const { version } = input;
  if (version === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one)");
  }
  const urls = releaseAssetUrls(version);
  const published = await download(input.fetch, urls.manifest, version);
  const dir = releaseCacheDir(input.home, version);
  const cached = await readFile(join(dir, "release.json")).catch(() => undefined);
  if (cached !== undefined && cached.equals(published)) return dir;

  input.write(`Downloading AgentX release ${version} from GitHub`);
  const tarball = await download(input.fetch, urls.tarball, version);
  await mkdir(dirname(dir), { recursive: true });
  const scratch = await mkdtemp(join(dirname(dir), `.${version}.`));
  try {
    const archive = join(scratch, `agentx-${version}.tar.gz`);
    const extracted = join(scratch, "release");
    await writeFile(archive, tarball);
    await mkdir(extracted);
    await input.runner.run("tar", ["-xzf", archive, "-C", extracted], { cwd: scratch, display: `tar -xzf agentx-${version}.tar.gz` });
    const inside = await readFile(join(extracted, "release.json")).catch(() => undefined);
    if (inside === undefined || !inside.equals(published)) {
      throw agentXError("CONFIG_INVALID", `the downloaded release ${version} does not match its published release.json; try again later, or pass --release <dir>`);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(extracted, dir);
    return dir;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
