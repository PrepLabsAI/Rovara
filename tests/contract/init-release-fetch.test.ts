import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { fetchRelease, releaseAssetUrls, releaseCacheDir } from "../../packages/cli/src/init/release-fetch.js";
import { CLI_VERSION, RELEASE_VERSION, isPrereleaseVersion } from "../../packages/cli/src/version.js";

const dirs: string[] = [];
/** A test that leaves a mode-000 directory behind must not stop the cleanup of the others. */
const removeAll = async (dir: string) => {
  execFileSync("chmod", ["-R", "u+rwx", dir], { stdio: "ignore" });
  await rm(dir, { recursive: true, force: true });
};
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => removeAll(dir).catch(() => undefined))); });
const tmp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const runner = realCommandRunner({ write: () => undefined });
const MANIFEST = JSON.stringify({ schemaVersion: 1, version: "1.2.3" });

async function publishedRelease(manifest = MANIFEST): Promise<Buffer> {
  const source = await tmp("agentx-rel-src-");
  await mkdir(join(source, "templates", "us-east-1"), { recursive: true });
  await writeFile(join(source, "release.json"), manifest);
  await writeFile(join(source, "templates", "us-east-1", "access.template.json"), "{}");
  const out = join(await tmp("agentx-rel-tar-"), "agentx-1.2.3.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", source, "."]);
  return readFile(out);
}

/** A tarball with one entry recorded as "../outside.txt" (built by archiving that relative path
 * from one directory in, so tar records the literal ".." segment rather than resolving it away). */
async function tarballWithDotDotEntry(): Promise<Buffer> {
  const source = await tmp("agentx-rel-evil-dotdot-");
  await mkdir(join(source, "inner"), { recursive: true });
  await writeFile(join(source, "outside.txt"), "evil");
  const out = join(await tmp("agentx-rel-evil-dotdot-tar-"), "agentx-1.2.3.tar.gz");
  execFileSync("tar", ["-czf", out, "../outside.txt"], { cwd: join(source, "inner") });
  return readFile(out);
}

/** A tarball with one entry recorded as an absolute path (tar's own default strips a leading "/"
 * unless told to preserve it with -P). */
async function tarballWithAbsoluteEntry(): Promise<Buffer> {
  const source = await tmp("agentx-rel-evil-abs-");
  const file = join(source, "evil.txt");
  await writeFile(file, "evil");
  const out = join(await tmp("agentx-rel-evil-abs-tar-"), "agentx-1.2.3.tar.gz");
  execFileSync("tar", ["-czPf", out, file]);
  return readFile(out);
}

/** A tarball with one entry that is a symlink to a path outside the archive entirely. */
async function tarballWithSymlinkEntry(): Promise<Buffer> {
  const source = await tmp("agentx-rel-evil-sym-");
  execFileSync("ln", ["-s", "/etc/passwd", join(source, "evil-link")]);
  const out = join(await tmp("agentx-rel-evil-sym-tar-"), "agentx-1.2.3.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", source, "."]);
  return readFile(out);
}

/** One ustar entry, written by hand so the archive is the same on every platform's tar (and a
 * FIFO or a hard link needs no mkfifo or ln). Type "0" is a file, "1" a hard link, "5" a directory,
 * "6" a FIFO. */
function ustarEntry(input: { name: string; type: "0" | "1" | "5" | "6"; mode: number; body?: string; linkName?: string }): Buffer {
  const body = Buffer.from(input.body ?? "");
  const header = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) => { header.write(text.slice(0, length), offset, "ascii"); };
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
  put(input.name, 0, 100);
  put(octal(input.mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12);
  put(octal(1_790_000_000, 12), 136, 12);
  put("        ", 148, 8);
  put(input.type, 156, 1);
  put(input.linkName ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function ustarArchive(entries: Array<Parameters<typeof ustarEntry>[0]>): Buffer {
  return gzipSync(Buffer.concat([...entries.map(ustarEntry), Buffer.alloc(1024)]));
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function github(files: Record<string, Buffer | string>): typeof fetch & { requested: string[] } {
  const requested: string[] = [];
  const handler = async (url: Parameters<typeof fetch>[0]) => {
    const target = requestUrl(url);
    requested.push(target);
    const body = files[target];
    return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body, { status: 200 });
  };
  return Object.assign(handler, { requested });
}

describe("fetching the release for this CLI", () => {
  it("names the GitHub release assets", () => {
    expect(releaseAssetUrls("1.2.3")).toEqual({
      tarball: "https://github.com/PrepLabsAI/AgentX/releases/download/v1.2.3/agentx-1.2.3.tar.gz",
      manifest: "https://github.com/PrepLabsAI/AgentX/releases/download/v1.2.3/release.json",
    });
  });

  it("downloads and extracts the release into the per-version cache", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const dir = await fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() }), runner, write: () => undefined });
    expect(dir).toBe(releaseCacheDir(home, "1.2.3"));
    expect(await readFile(join(dir, "release.json"), "utf8")).toBe(MANIFEST);
    expect(await readdir(join(dir, "templates", "us-east-1"))).toEqual(["access.template.json"]);
  });

  it("reuses a cached release whose release.json matches, without downloading the tarball again", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const files = { [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() };
    await fetchRelease({ version: "1.2.3", home, fetch: github(files), runner, write: () => undefined });
    const second = github(files);
    await fetchRelease({ version: "1.2.3", home, fetch: second, runner, write: () => undefined });
    expect(second.requested).toEqual([urls.manifest]);
  });

  it("refuses a tarball whose release.json is not the published one, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease("{\"tampered\":true}") }), runner, write: () => undefined }))
      .rejects.toThrow("the downloaded release 1.2.3 does not match its published release.json; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("refuses an archive entry with a `..` segment, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await tarballWithDotDotEntry() }), runner, write: () => undefined }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("refuses an archive entry with an absolute path, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await tarballWithAbsoluteEntry() }), runner, write: () => undefined }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("refuses an archive entry that is a symlink pointing outside the archive, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await tarballWithSymlinkEntry() }), runner, write: () => undefined }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("refuses an archive entry that is a hard link, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const tarball = ustarArchive([
      { name: "release.json", type: "0", mode: 0o644, body: MANIFEST },
      { name: "evil-link", type: "1", mode: 0o644, linkName: "release.json" },
    ]);
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: tarball }), runner, write: () => undefined }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("refuses an archive entry that is a FIFO, leaving nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const tarball = ustarArchive([
      { name: "release.json", type: "0", mode: 0o644, body: MANIFEST },
      { name: "evil-fifo", type: "6", mode: 0o644 },
    ]);
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: tarball }), runner, write: () => undefined }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
  });

  it("extracts without the archive's owners or permission bits", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const calls: string[][] = [];
    const recording: CommandRunner = { run: (command, args, options) => { calls.push([command, ...args]); return runner.run(command, args, options); } };
    await fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() }), runner: recording, write: () => undefined });
    const extract = calls.find((call) => call.some((arg) => arg.startsWith("-x")));
    expect(extract).toEqual(expect.arrayContaining(["--no-same-owner", "--no-same-permissions"]));
  });

  it("keeps the archive listings out of the terminal", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const printed: string[] = [];
    const echoing = realCommandRunner({ write: (text) => printed.push(text) });
    await fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: await publishedRelease() }), runner: echoing, write: () => undefined });
    expect(printed.join("")).not.toContain("access.template.json");
  });

  // Root reads a mode-000 directory anyway, so there is nothing to refuse.
  it.skipIf(process.getuid?.() === 0)("refuses an archive whose tree cannot be read back, and still leaves nothing behind", async () => {
    const home = await tmp("agentx-home-");
    const urls = releaseAssetUrls("1.2.3");
    const tarball = ustarArchive([
      { name: "release.json", type: "0", mode: 0o644, body: MANIFEST },
      { name: "locked/", type: "5", mode: 0o000 },
      { name: "locked/inside.txt", type: "0", mode: 0o644, body: "x" },
    ]);
    const lines: string[] = [];
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: tarball }), runner, write: (line) => lines.push(line) }))
      .rejects.toThrow("the release archive for 1.2.3 is unsafe and must not be used; try again later, or pass --release <dir>");
    await expect(readdir(join(home, ".agentx", "releases"))).resolves.toEqual([]);
    expect(lines.join("\n")).not.toContain("could not remove");
  });

  it("names the address when the release is not published", async () => {
    await expect(fetchRelease({ version: "9.9.9", home: await tmp("agentx-home-"), fetch: github({}), runner, write: () => undefined }))
      .rejects.toThrow("release 9.9.9 was not found at https://github.com/PrepLabsAI/AgentX/releases/download/v9.9.9/release.json; check the version is published, or pass --release <dir>");
  });

  it("asks a CLI built from source to pass --release", async () => {
    await expect(fetchRelease({ version: undefined, home: await tmp("agentx-home-"), fetch: github({}), runner, write: () => undefined }))
      .rejects.toThrow("this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one)");
  });
});

describe("the CLI's own version", () => {
  it("falls back to 0.1.0 when built from source (no esbuild define, as under vitest)", () => {
    expect(RELEASE_VERSION).toBeUndefined();
    expect(CLI_VERSION).toBe("0.1.0");
  });

  it("recognizes a semver prerelease suffix", () => {
    expect(isPrereleaseVersion("1.2.3")).toBe(false);
    expect(isPrereleaseVersion("1.2.3-beta.1")).toBe(true);
    expect(isPrereleaseVersion("1.2.3-rc.1")).toBe(true);
  });
});
