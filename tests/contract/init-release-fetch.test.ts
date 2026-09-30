import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { fetchRelease, readReleaseManifest, releaseAssetUrls, releaseCacheDir, sourceRelease } from "../../packages/cli/src/init/release-fetch.js";
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

/** A tarball with one entry recorded as "../outside.txt". Written by hand: GNU tar strips a leading
 * "../" when it creates an archive, so a tar-built fixture would not contain the entry on Linux. */
function tarballWithDotDotEntry(): Buffer {
  return ustarArchive([{ name: "../outside.txt", type: "0", mode: 0o644, body: "evil" }]);
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
    await expect(fetchRelease({ version: "1.2.3", home, fetch: github({ [urls.manifest]: MANIFEST, [urls.tarball]: tarballWithDotDotEntry() }), runner, write: () => undefined }))
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

  // Issue 152 replaces live check L7's refusal: --engine cdk --source now needs no release at all
  // (sourceRelease below), so the only thing left to say is how to give one or the other.
  it("asks a CLI built from source to pass --release, or --engine cdk with --source", async () => {
    await expect(fetchRelease({ version: undefined, home: await tmp("agentx-home-"), fetch: github({}), runner, write: () => undefined }))
      .rejects.toThrow("this agentx was built from source and has no published release to download; pass --release <dir> (npm run release:build builds one), or --engine cdk --source <a checkout of a release tag>");
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

describe("readReleaseManifest (doctor's release check)", () => {
  const manifest = { schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [], images: {} };

  it("reads the cached release.json without downloading", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-manifest-"));
    await mkdir(join(home, ".agentx", "releases", "1.2.3"), { recursive: true });
    await writeFile(join(home, ".agentx", "releases", "1.2.3", "release.json"), JSON.stringify(manifest));
    const fetched: string[] = [];
    const found = await readReleaseManifest({ version: "1.2.3", home, fetch: (async (url: string) => { fetched.push(url); return new Response("", { status: 500 }); }) as never });
    expect(found?.version).toBe("1.2.3");
    expect(fetched).toEqual([]);
  });

  it("downloads the published release.json, and answers undefined for anything unreadable", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-manifest-"));
    const ok = await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response(JSON.stringify(manifest), { status: 200 })) });
    expect(ok?.version).toBe("1.2.3");
    expect(await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response("", { status: 404 })) })).toBeUndefined();
    expect(await readReleaseManifest({ version: "1.2.3", home, fetch: (async () => new Response("not json", { status: 200 })) })).toBeUndefined();
    expect(await readReleaseManifest({ version: "1.2.4", home, fetch: (async () => new Response(JSON.stringify(manifest), { status: 200 })) })).toBeUndefined();
    expect(await readReleaseManifest({ version: "unversioned", home, fetch: (async () => { throw new Error("no call expected"); }) })).toBeUndefined();
  });
});

// Issue 152: a source-built agentx with --engine cdk --source builds its release from the checkout:
// the version from its tag, the images from the flags or the tag's published release.json.
describe("sourceRelease (issue 152)", () => {
  const HEAD = "e".repeat(40);
  const WORKER = `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`;
  const SLACK = `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}`;
  const OVERRIDE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"d".repeat(64)}`;
  const tagged: CommandRunner = {
    async run(_command, args) {
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "rev-parse") return { stdout: `${HEAD}\n` };
      return { stdout: "v1.4.0\n" };
    },
  };
  const published = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1, version: "1.4.0", gitCommit: HEAD, environmentPlaceholder: "qqenv-placeholderqq",
    templates: ["us-east-1", "us-west-2"].map((region) => ({ region, part: "access", file: `templates/${region}/access.template.json`, sha256: "0".repeat(64) })),
    packages: [], images: { worker: WORKER, slack: SLACK }, ...overrides,
  });
  const noFetch = (async () => { throw new Error("test setup: nothing may be fetched"); }) as unknown as typeof fetch;

  it("needs no release when both image flags are given: the version is the tag's, and nothing is fetched", async () => {
    const { release, regions } = await sourceRelease({ runner: tagged, source: "/src", images: { worker: OVERRIDE, slack: OVERRIDE }, fetch: noFetch });
    expect(release.manifest).toEqual({ schemaVersion: 1, version: "1.4.0", gitCommit: HEAD, environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [], images: {} });
    expect(release.regions()).toEqual([]);
    expect(regions).toBeUndefined();
  });

  it("without image flags, reads the tag's published release.json and never downloads the tarball", async () => {
    const urls = releaseAssetUrls("1.4.0");
    const fetched = github({ [urls.manifest]: published(), [urls.tarball]: "must not be downloaded" });
    const { release, regions } = await sourceRelease({ runner: tagged, source: "/src", fetch: fetched });
    expect(fetched.requested).toEqual([urls.manifest]);
    expect(release.manifest.images).toEqual({ worker: WORKER, slack: SLACK });
    expect(release.manifest.templates).toEqual([]);
    expect(release.manifest.packages).toEqual([]);
    expect(regions).toEqual(["us-east-1", "us-west-2"]);
  });

  it("reads release.json for the image a flag does not give", async () => {
    const urls = releaseAssetUrls("1.4.0");
    const fetched = github({ [urls.manifest]: published() });
    const { release } = await sourceRelease({ runner: tagged, source: "/src", images: { worker: OVERRIDE }, fetch: fetched });
    expect(fetched.requested).toEqual([urls.manifest]);
    expect(release.manifest.images.slack).toBe(SLACK);
  });

  it("refuses when the tag has no published release.json and an image flag is missing, naming both flags", async () => {
    const error = await sourceRelease({ runner: tagged, source: "/src", fetch: github({}) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentXError);
    expect((error as Error).message).toContain("release 1.4.0 has no published release.json at https://github.com/PrepLabsAI/AgentX/releases/download/v1.4.0/release.json, so its images are unknown; pass --worker-image and --slack-image, or --release <dir>");
  });

  it("refuses a published release.json built from another commit than the checkout", async () => {
    const urls = releaseAssetUrls("1.4.0");
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: github({ [urls.manifest]: published({ gitCommit: "f".repeat(40) }) }) }))
      .rejects.toThrow(`the published release 1.4.0 was built from commit ${"f".repeat(40)}, but /src is at ${HEAD}; check out tag v1.4.0 cleanly, or pass --worker-image and --slack-image`);
  });

  it("refuses a published release.json that is not a valid release manifest, or names another version", async () => {
    const urls = releaseAssetUrls("1.4.0");
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: github({ [urls.manifest]: "not json" }) }))
      .rejects.toThrow(`the published release.json at ${urls.manifest} is not a valid release manifest`);
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: github({ [urls.manifest]: published({ images: { worker: "latest" } }) }) }))
      .rejects.toThrow(`the published release.json at ${urls.manifest} is not a valid release manifest`);
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: github({ [urls.manifest]: published({ version: "1.4.1" }) }) }))
      .rejects.toThrow(`the published release.json at ${urls.manifest} is for release 1.4.1, not 1.4.0`);
  });

  it("names the address when release.json cannot be downloaded", async () => {
    const urls = releaseAssetUrls("1.4.0");
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: failing })).rejects.toThrow(`downloading ${urls.manifest} failed with HTTP 503`);
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND github.com"); }) as unknown as typeof fetch;
    await expect(sourceRelease({ runner: tagged, source: "/src", fetch: offline })).rejects.toThrow(`could not download ${urls.manifest} (getaddrinfo ENOTFOUND github.com); pass --worker-image and --slack-image, or --release <dir>`);
  });

  it("refuses a checkout that is not at one release tag, before fetching anything", async () => {
    const untagged: CommandRunner = { async run(_command, args) { return { stdout: args[0] === "tag" ? "" : "" }; } };
    await expect(sourceRelease({ runner: untagged, source: "/src", fetch: noFetch })).rejects.toThrow("/src is at no release tag");
  });

  it("never serves templates or packages: the cdk engine synthesizes its own", async () => {
    const { release } = await sourceRelease({ runner: tagged, source: "/src", images: { worker: OVERRIDE, slack: OVERRIDE }, fetch: noFetch });
    expect(() => release.template("access", "us-east-1", "staging")).toThrow("release 1.4.0 was built from --source /src, which has no published templates");
    expect(() => release.packagePath("x")).toThrow("release 1.4.0 was built from --source /src, which has no packages");
  });
});
