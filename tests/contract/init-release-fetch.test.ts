import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { fetchRelease, releaseAssetUrls, releaseCacheDir } from "../../packages/cli/src/init/release-fetch.js";
import { CLI_VERSION, RELEASE_VERSION, isPrereleaseVersion } from "../../packages/cli/src/version.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
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
