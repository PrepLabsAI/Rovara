import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { describe, expect, it } from "vitest";
import { accumulateAsset, buildRelease, type PackageAccumulator } from "../../scripts/release/build.js";
import { ReleaseManifestSchema } from "../../scripts/release/manifest.js";
import { readZipEntries } from "../support/zip-entries.js";

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

  it("validates images before checking whether the output directory is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    const out = join(dir, "r");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "stray.txt"), "not empty");
    await expect(
      buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), images: { worker: "public.ecr.aws/x/y:latest" } }),
    ).rejects.toThrow(/digest/);
  });

  it("refuses a bad version or gitCommit before touching anything, leaving the out dir absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    const out = join(dir, "r");
    await expect(buildRelease({ version: "not-a-version", out, gitCommit: "b".repeat(40) })).rejects.toThrow(/version/);
    await expect(readdir(out)).rejects.toThrow();
    await expect(buildRelease({ version: "1.2.3", out, gitCommit: "too-short" })).rejects.toThrow(/gitCommit/);
    await expect(readdir(out)).rejects.toThrow();
  }, 600_000);

  it(
    "is independent of TMPDIR and how deep it is nested, and leaves no absolute path in a package's source map",
    async () => {
      const baseOut = await mkdtemp(join(tmpdir(), "agentx-release-tmpdir-check-"));
      const originalTmpdir = process.env.TMPDIR;
      try {
        const outA = join(baseOut, "a");
        const manifestA = await buildRelease({ version: "1.2.3", out: outA, gitCommit: "b".repeat(40) });

        // Simulate a machine/CI whose ambient temp directory sits at a very different depth from
        // this one; the old (buggy) implementation synthesized under os.tmpdir(), which made the
        // number of ".." segments in the bundle's source map (and, because that changes the
        // bundle's own bytes, the asset id and every downstream checksum) depend on exactly this.
        const deepTmp = join(baseOut, "much", "deeper", "nested", "path", "for", "a", "different", "tmpdir");
        await mkdir(deepTmp, { recursive: true });
        process.env.TMPDIR = deepTmp;
        const outB = join(baseOut, "b");
        const manifestB = await buildRelease({ version: "1.2.3", out: outB, gitCommit: "b".repeat(40) });

        expect(manifestB.templates).toEqual(manifestA.templates);
        expect(manifestB.packages).toEqual(manifestA.packages);

        // The source map itself must carry no absolute path: not the machine's home directory
        // (however it is arranged), and not this checkout's own absolute path either.
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
        let checkedAny = false;
        for (const pkg of manifestA.packages) {
          const zipBuffer = await readFile(join(outA, pkg.file));
          for (const entry of readZipEntries(zipBuffer)) {
            if (!entry.name.endsWith(".js.map")) continue;
            checkedAny = true;
            const text = entry.data.toString("utf8");
            expect(text).not.toMatch(/\/Users\//);
            expect(text).not.toMatch(/\/home\//);
            expect(text.includes(repoRoot)).toBe(false);
          }
        }
        expect(checkedAny).toBe(true);
      } finally {
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
      }
    },
    600_000,
  );
});

describe("release builder refuses ambient CDK context", () => {
  it(`refuses to run with ${CONTEXT_ENV} set, naming the variable`, async () => {
    const original = process.env[CONTEXT_ENV];
    try {
      process.env[CONTEXT_ENV] = "{}";
      const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
      await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40) })).rejects.toThrow(new RegExp(CONTEXT_ENV));
    } finally {
      if (original === undefined) delete process.env[CONTEXT_ENV];
      else process.env[CONTEXT_ENV] = original;
    }
  });

  it(`refuses to run with ${CONTEXT_OVERFLOW_LOCATION_ENV} set, naming the variable`, async () => {
    const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    try {
      process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = "/nonexistent/agentx-context-overflow.json";
      const out = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
      await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40) })).rejects.toThrow(
        new RegExp(CONTEXT_OVERFLOW_LOCATION_ENV),
      );
    } finally {
      if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
      else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
    }
  });
});

describe("accumulateAsset", () => {
  const zipAsset = {
    packaging: "zip",
    id: "a".repeat(64),
    s3BucketParameter: "Bucket1",
    s3KeyParameter: "Key1",
    artifactHashParameter: "Hash1",
  };

  it('refuses a "file"-packaged asset, naming it and its packaging', () => {
    const packagesById = new Map<string, PackageAccumulator>();
    expect(() => accumulateAsset(packagesById, { ...zipAsset, packaging: "file" }, "control-plane", "/tmp/wherever")).toThrow(
      /unsupported asset packaging "file"/,
    );
  });

  it("refuses a container-image asset, naming it", () => {
    const packagesById = new Map<string, PackageAccumulator>();
    expect(() =>
      accumulateAsset(packagesById, { ...zipAsset, packaging: "container-image" }, "slack", "/tmp/wherever"),
    ).toThrow(/unsupported asset packaging "container-image"/);
  });

  it("accumulates the same asset id used by two different stacks under one package", () => {
    const packagesById = new Map<string, PackageAccumulator>();
    accumulateAsset(packagesById, zipAsset, "control-plane", "/tmp/dir");
    accumulateAsset(packagesById, zipAsset, "slack", "/tmp/dir");
    expect(packagesById.get(zipAsset.id)?.parts).toEqual(["control-plane", "slack"]);
  });

  it("refuses the same asset id with different parameter names across stacks", () => {
    const packagesById = new Map<string, PackageAccumulator>();
    accumulateAsset(packagesById, zipAsset, "control-plane", "/tmp/dir");
    expect(() => accumulateAsset(packagesById, { ...zipAsset, s3BucketParameter: "Bucket2" }, "slack", "/tmp/dir")).toThrow(
      /different parameter names/,
    );
  });
});
