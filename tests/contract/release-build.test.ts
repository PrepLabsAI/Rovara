import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { ReleaseManifestSchema } from "../../scripts/release/manifest.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const worker = `public.ecr.aws/agentx/agentx-worker@sha256:${"a".repeat(64)}`;

describe("release builder", () => {
  it("writes templates, packages and a manifest whose checksums match the files", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), images: { worker } });
    expect(ReleaseManifestSchema.parse(JSON.parse(await readFile(join(out, "release.json"), "utf8")))).toEqual(manifest);
    expect(manifest.templates.map((t) => t.part)).toEqual(["foundation", "identity", "runtime", "control-plane", "slack"]);
    for (const t of manifest.templates) expect(sha(await readFile(join(out, t.file)))).toBe(t.sha256);
    for (const p of manifest.packages) {
      expect(sha(await readFile(join(out, p.file)))).toBe(p.sha256);
      expect(p.file).toBe(`packages/${p.assetId}.zip`);
      expect(p.keyParameterValue).toBe(`packages/||${p.assetId}.zip`);
    }
    expect(manifest.images).toEqual({ worker });
  }, 600_000);

  it("covers every asset parameter in every template with exactly one package, and ships no unused package", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40) });
    const declared = new Set(manifest.packages.flatMap((p) => [p.bucketParameter, p.keyParameter, p.hashParameter]));
    const used = new Set<string>();
    for (const t of manifest.templates) {
      const template = JSON.parse(await readFile(join(out, t.file), "utf8")) as { Parameters?: Record<string, unknown> };
      for (const name of Object.keys(template.Parameters ?? {}).filter((n) => n.startsWith("AssetParameters"))) {
        expect(declared.has(name), `${t.part}: ${name}`).toBe(true);
        used.add(name);
      }
    }
    expect([...declared].filter((n) => !used.has(n))).toEqual([]);
    expect((await readdir(join(out, "packages"))).sort()).toEqual(manifest.packages.map((p) => `${p.assetId}.zip`).sort());
  }, 600_000);

  it("refuses a non-empty output directory and a malformed image reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    await buildRelease({ version: "1.2.3", out: join(dir, "r"), gitCommit: "b".repeat(40) });
    await expect(buildRelease({ version: "1.2.3", out: join(dir, "r"), gitCommit: "b".repeat(40) })).rejects.toThrow(/not empty/);
    await expect(buildRelease({ version: "1.2.3", out: join(dir, "s"), gitCommit: "b".repeat(40), images: { worker: "public.ecr.aws/x/y:latest" } })).rejects.toThrow(/digest/);
  }, 600_000);
});
