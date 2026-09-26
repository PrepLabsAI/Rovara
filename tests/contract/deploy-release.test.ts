import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { loadRelease } from "../../packages/cli/src/deploy/release.js";

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
});
