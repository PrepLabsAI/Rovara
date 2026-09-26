import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { containedPath, loadRelease } from "../../packages/cli/src/deploy/release.js";

let dir: string;
beforeAll(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "agentx-load-")), "r");
  await buildRelease({ version: "1.2.3", out: dir, gitCommit: "a".repeat(40) });
}, 900_000);

describe("loading a release for install", () => {
  it("renders a part's template for an environment in a covered region", async () => {
    const release = await loadRelease(dir);
    expect(release.regions()).toEqual(["us-east-1"]);
    const text = release.template("access", "us-east-1", "staging");
    expect(text).toContain("agentx-staging");
    expect(text).not.toContain("qqenv");
  });

  it("refuses a region the release does not cover, naming it", async () => {
    const release = await loadRelease(dir);
    expect(() => release.template("access", "eu-west-1", "staging")).toThrow(/release 1\.2\.3 does not cover region eu-west-1/);
  });

  it("refuses a release whose files do not match release.json", async () => {
    const tampered = join(await mkdtemp(join(tmpdir(), "agentx-tamper-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out: tampered, gitCommit: "a".repeat(40) });
    await writeFile(join(tampered, manifest.packages[0]!.file), "tampered");
    await expect(loadRelease(tampered)).rejects.toThrow(manifest.packages[0]!.file);
  }, 900_000);

  it("packagePath throws for an unknown asset id", async () => {
    const release = await loadRelease(dir);
    expect(() => release.packagePath("f".repeat(64))).toThrow(/release 1\.2\.3 has no package/);
  });
});

// The schema (packages/contracts/src/release.ts) already refuses a release.json whose `file`
// values could escape the release directory, but the loader must not rely on that alone: whoever
// can edit release.json also controls its recorded sha256, so a checksum match alone proves
// nothing about where the path points. containedPath is the loader's own, independent guard;
// these tests call it directly, bypassing the schema entirely, so its containment check is proven
// on its own rather than merely inferred from the schema tests passing.
describe("containedPath: the loader's own path-containment guard, independent of the schema", () => {
  it("refuses a file that escapes the release directory via .. segments, naming it", () => {
    expect(() => containedPath(dir, "../../../etc/passwd")).toThrow("release file ../../../etc/passwd is outside the release directory");
  });

  it("refuses an absolute file path, naming it", () => {
    expect(() => containedPath(dir, "/etc/passwd")).toThrow("release file /etc/passwd is outside the release directory");
  });

  it("accepts a legitimate path inside the release directory", () => {
    expect(containedPath(dir, "templates/us-east-1/access.template.json")).toBe(resolve(dir, "templates/us-east-1/access.template.json"));
  });

  it("refuses a file that is missing, with a clear error naming it", () => {
    expect(() => containedPath(dir, "packages/does-not-exist.zip")).toThrow("release file packages/does-not-exist.zip is missing");
  });

  it("refuses a symlink inside the release directory that points outside it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentx-outside-"));
    await writeFile(join(outside, "secret.txt"), "not part of the release");
    await symlink(join(outside, "secret.txt"), join(dir, "escape-link"));
    expect(() => containedPath(dir, "escape-link")).toThrow("release file escape-link is outside the release directory");
  });
});
