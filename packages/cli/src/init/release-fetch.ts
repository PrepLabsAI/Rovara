// `npx @preplabsai/rovara-code init` needs the release matching the CLI: the GitHub release's
// release.json and tarball. The extracted release.json must equal the published one byte for byte;
// loadRelease then checks every file's sha256 against it. The tarball itself is untrusted until
// its entries are checked for containment (assertArchiveEntriesAreSafe, assertExtractedTreeIsContained).
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { agentXError, ReleaseManifestSchema, type ReleaseManifest } from "@agentx/contracts";
import type { CommandRunner } from "../deploy/cdk-engine.js";
import { sourceReleaseVersion } from "../deploy/cdk-source.js";
import type { LoadedRelease } from "../deploy/release.js";

export const RELEASE_REPOSITORY = "PrepLabsAI/Rovara";

export function releaseAssetUrls(version: string): { tarball: string; manifest: string } {
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  return { tarball: `${base}/agentx-${version}.tar.gz`, manifest: `${base}/release.json` };
}

export function releaseCacheDir(home: string, version: string): string {
  return join(home, ".agentx", "releases", version);
}

/** Spec 048 FR-009: reads a download, saying how much has arrived. With no usable content-length
 * there is no total, and the page shows megabytes received instead of a percentage. */
export async function readWithProgress(response: Response, onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void): Promise<Buffer> {
  if (onProgress === undefined || response.body === null) return Buffer.from(await response.arrayBuffer());
  const header = Number(response.headers.get("content-length") ?? "");
  const totalBytes = Number.isFinite(header) && header > 0 ? header : undefined;
  // Node's fetch stream is a byte stream here, but the mixed DOM/Node declarations used by the
  // CLI leave getReader() as `any` under the stricter lint project. Fix the boundary once so no
  // untyped child value reaches the progress calculation.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress({ receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
  }
  return Buffer.concat(chunks);
}

async function download(fetchImplementation: typeof fetch, url: string, version: string, onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void): Promise<Buffer> {
  const response = await fetchImplementation(url);
  if (response.status === 404) throw agentXError("CONFIG_INVALID", `release ${version} was not found at ${url}; check the version is published, or pass --release <dir>`);
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `downloading ${url} failed with HTTP ${response.status}`);
  return readWithProgress(response, onProgress);
}

function unsafeArchiveError(version: string): Error {
  return agentXError("CONFIG_INVALID", `the release archive for ${version} is unsafe and must not be used; try again later, or pass --release <dir>`);
}

/**
 * Refuses a tarball that could write outside the directory it is extracted into ("tar slip"):
 * an absolute path, a path with a ".." segment, a symlink or hard link (either can point its
 * target anywhere on disk, entirely outside the archive), or a device or FIFO node. Checked from
 * the archive's own listing, read once plain (for entry names) and once verbose (for entry
 * types), before anything is extracted — so a malicious release is refused without ever writing
 * one of its entries to disk, anywhere.
 */
async function assertArchiveEntriesAreSafe(input: { runner: CommandRunner; archive: string; cwd: string; archiveName: string; version: string }): Promise<void> {
  const { runner, archive, cwd, archiveName, version } = input;
  // quiet: the listings are for this check only, and a release lists thousands of files.
  // -P shows every entry's name as stored: GNU tar otherwise strips a leading "/" or "../" from the
  // listing (and from extraction), which would hide exactly the entries this check must refuse.
  const plain = await runner.run("tar", ["-tPzf", archive], { cwd, display: `tar -tPzf ${archiveName}`, quiet: true });
  const verbose = await runner.run("tar", ["-tPzvf", archive], { cwd, display: `tar -tPzvf ${archiveName}`, quiet: true });
  const names = plain.stdout.split("\n").filter((line) => line.length > 0);
  const details = verbose.stdout.split("\n").filter((line) => line.length > 0);
  // The plain and verbose listings come from the same tar reading the same archive back to back:
  // same entries, same order. A mismatched count means the two listings can't be paired up
  // entry-for-entry, so the archive can't be vouched for either way; refuse it.
  if (names.length !== details.length) throw unsafeArchiveError(version);
  names.forEach((name, index) => {
    if (name.startsWith("/") || name.split("/").includes("..")) throw unsafeArchiveError(version);
    const detail = details[index] ?? "";
    const type = detail.charAt(0);
    if (type === "l" || detail.includes(" -> ")) throw unsafeArchiveError(version); // symlink
    if (type === "h" || / link to /.test(detail)) throw unsafeArchiveError(version); // hard link
    if (type === "b" || type === "c" || type === "p" || type === "s") throw unsafeArchiveError(version); // device or FIFO
  });
}

/**
 * Defense in depth alongside `assertArchiveEntriesAreSafe`: walks the extracted tree and confirms
 * every entry's realpath still resolves inside `root`. The listing check above should already
 * have refused any symlink, but this catches one regardless of how it got there, before the
 * release is ever read from or moved into the cache.
 */
async function assertExtractedTreeIsContained(root: string, version: string): Promise<void> {
  const realRoot = await realpath(root);
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw unsafeArchiveError(version);
      const real = await realpath(path);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw unsafeArchiveError(version);
      if (entry.isDirectory()) await walk(path);
    }
  }
  try {
    await walk(root);
  } catch {
    // Refused either way: an entry outside root, or a tree that cannot be read back (EACCES on a
    // directory the archive made unreadable, say), which cannot be vouched for.
    throw unsafeArchiveError(version);
  }
}

/** chmod -R u+rwx, so an archive that extracted an unreadable or unwritable directory can still be
 * removed. Best effort: whatever it cannot change, the rm after it reports. */
async function makeRemovable(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined || stats.isSymbolicLink()) return;
  await chmod(path, (stats.mode & 0o7777) | 0o700).catch(() => undefined);
  if (!stats.isDirectory()) return;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) await makeRemovable(join(path, entry));
}

/**
 * Downloads the GitHub release's release.json and tarball, checks the tarball's own entries are
 * safe to extract, extracts it with tar, and checks the extracted release.json is byte for byte
 * the published one. A cached release whose release.json already matches is reused without
 * downloading the tarball again. A mismatch, an unsafe archive, or a missing release all refuse
 * and leave the cache untouched: the tarball is extracted into a scratch directory next to the
 * cache and only renamed into place once it checks out, so a failed or interrupted fetch never
 * leaves a half-written release directory. `loadRelease` then checks every file's checksum.
 */
export async function fetchRelease(input: { version: string | undefined; home: string; fetch: typeof fetch; runner: CommandRunner; write(line: string): void; onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void }): Promise<string> {
  const { version } = input;
  if (version === undefined) {
    // Issue 152: --engine cdk --source needs no release (sourceRelease), so init never gets here with it.
    throw agentXError("CONFIG_INVALID", "this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one), or --engine cdk --source <a checkout of a release tag>");
  }
  const urls = releaseAssetUrls(version);
  const published = await download(input.fetch, urls.manifest, version);
  const dir = releaseCacheDir(input.home, version);
  const cached = await readFile(join(dir, "release.json")).catch(() => undefined);
  if (cached !== undefined && cached.equals(published)) return dir;

  input.write(`Downloading AgentX release ${version} from GitHub`);
  const tarball = await download(input.fetch, urls.tarball, version, input.onProgress);
  await mkdir(dirname(dir), { recursive: true });
  const scratch = await mkdtemp(join(dirname(dir), `.${version}.`));
  try {
    const archiveName = `agentx-${version}.tar.gz`;
    const archive = join(scratch, archiveName);
    const extracted = join(scratch, "release");
    await writeFile(archive, tarball);
    await assertArchiveEntriesAreSafe({ runner: input.runner, archive, cwd: scratch, archiveName, version });
    await mkdir(extracted);
    // Never the archive's owners or permission bits: every file is ours, readable, and removable.
    await input.runner.run("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", extracted], { cwd: scratch, display: `tar -xzf ${archiveName}` });
    await assertExtractedTreeIsContained(extracted, version);
    const inside = await readFile(join(extracted, "release.json")).catch(() => undefined);
    if (inside === undefined || !inside.equals(published)) {
      throw agentXError("CONFIG_INVALID", `the downloaded release ${version} does not match its published release.json; try again later, or pass --release <dir>`);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(extracted, dir);
    return dir;
  } finally {
    // Reported, never thrown: a failed cleanup must not hide the fetch's own error or result.
    try {
      await makeRemovable(scratch);
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      input.write(`could not remove temporary files in ${scratch}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A release's manifest: the local release cache when it holds that version, else the published
 * release.json (read-only, 15-second limit). Undefined when neither can be read, or when what was
 * read names another version: doctor then says it could not compare, and fails nothing. */
export async function readReleaseManifest(input: { version: string; home: string; fetch: typeof fetch }): Promise<ReleaseManifest | undefined> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) return undefined;
  let text = await readFile(join(releaseCacheDir(input.home, input.version), "release.json"), "utf8").catch(() => undefined);
  if (text === undefined) {
    try {
      const response = await input.fetch(releaseAssetUrls(input.version).manifest, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return undefined;
      text = await response.text();
    } catch {
      return undefined;
    }
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return undefined; }
  const parsed = ReleaseManifestSchema.safeParse(json);
  return parsed.success && parsed.data.version === input.version ? parsed.data : undefined;
}


const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const IMAGE_FLAGS = "pass --worker-image and --slack-image, or --release <dir>";

/** The tag's published release.json, strictly: unlike readReleaseManifest (doctor's best-effort
 * comparison), every failure refuses, naming the address, so the images are never a guess. */
/** The refusal for a release whose images are unknown: no release.json, and an image flag missing. */
export function unknownImagesMessage(version: string): string {
  return `release ${version} has no published release.json at ${releaseAssetUrls(version).manifest}, so its images are unknown; ${IMAGE_FLAGS}`;
}

async function publishedManifest(input: { version: string; fetch: typeof fetch; missing: "refuse" | "allow" }): Promise<ReleaseManifest | undefined> {
  const url = releaseAssetUrls(input.version).manifest;
  let response: Response;
  try {
    response = await input.fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not download ${url} (${errorText(error)}); ${IMAGE_FLAGS}`);
  }
  if (response.status === 404) {
    if (input.missing === "allow") return undefined;
    throw agentXError("CONFIG_INVALID", unknownImagesMessage(input.version));
  }
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `downloading ${url} failed with HTTP ${response.status}; try again later, or ${IMAGE_FLAGS}`);
  let parsed: ReturnType<typeof ReleaseManifestSchema.safeParse>;
  try {
    parsed = ReleaseManifestSchema.safeParse(JSON.parse(await response.text()));
  } catch {
    throw agentXError("CONFIG_INVALID", `the published release.json at ${url} is not a valid release manifest; ${IMAGE_FLAGS}`);
  }
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `the published release.json at ${url} is not a valid release manifest; ${IMAGE_FLAGS}`);
  if (parsed.data.version !== input.version) throw agentXError("CONFIG_INVALID", `the published release.json at ${url} is for release ${parsed.data.version}, not ${input.version}`);
  return parsed.data;
}

/**
 * Issue 152: the release a source-built agentx deploys with `--engine cdk --source`, built from the
 * checkout instead of a release directory. The version is the one release tag at HEAD of the clean
 * checkout (sourceReleaseVersion). The images are the --worker-image and --slack-image overrides when
 * both are given (then nothing is fetched); otherwise the tag's published release.json supplies them
 * (only that file, never the tarball), and it must be the release built from this very commit.
 * The release has no templates and no packages: the cdk engine synthesizes its own and sends no
 * packages. `regions` is the published release's region list when release.json was read and names
 * one, for init's region question; undefined otherwise.
 */
export async function sourceRelease(input: {
  runner: CommandRunner; source: string; images?: { worker?: string | undefined; slack?: string | undefined } | undefined; fetch: typeof fetch;
  /** "allow": a tag with no published release.json, or one built from another commit, gives a
   * release with no images and `imagesProblem` saying why, for a caller that checks the images itself
   * once it knows them (init: a resume's saved answers may hold both). */
  missingReleaseJson?: "refuse" | "allow";
}): Promise<{ release: LoadedRelease; regions: string[] | undefined; imagesProblem?: string }> {
  const { source } = input;
  const { version, gitCommit } = await sourceReleaseVersion({ runner: input.runner, source });
  const bothImages = input.images?.worker !== undefined && input.images.slack !== undefined;
  const allow = input.missingReleaseJson === "allow";
  const fetched = bothImages ? undefined : await publishedManifest({ version, fetch: input.fetch, missing: allow ? "allow" : "refuse" });
  // With "allow", a missing or other-commit release.json gives no images, and the reason is handed
  // back for the caller to refuse with if it turns out to need them.
  let imagesProblem = !bothImages && fetched === undefined ? unknownImagesMessage(version) : undefined;
  let published = fetched;
  if (fetched !== undefined && fetched.gitCommit !== gitCommit) {
    const mismatch = `the published release ${version} was built from commit ${fetched.gitCommit}, but ${source} is at ${gitCommit}; check out tag v${version} cleanly, or pass --worker-image and --slack-image`;
    if (!allow) throw agentXError("CONFIG_INVALID", mismatch);
    imagesProblem = mismatch;
    published = undefined;
  }
  const manifest: ReleaseManifest = {
    schemaVersion: 1, version, gitCommit, environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: published?.images ?? {},
  };
  const from = `release ${version} was built from --source ${source}`;
  return {
    release: {
      manifest,
      dir: source,
      regions: () => [],
      template: () => { throw agentXError("CONFIG_INVALID", `${from}, which has no published templates; the cdk engine synthesizes its own`); },
      packagePath: () => { throw agentXError("CONFIG_INVALID", `${from}, which has no packages; the cdk engine sends none`); },
    },
    // A release.json that covers no region lists none to choose from, the same as none at all.
    regions: published === undefined || published.templates.length === 0 ? undefined : [...new Set(published.templates.map((entry) => entry.region))],
    ...(imagesProblem === undefined ? {} : { imagesProblem }),
  };
}
