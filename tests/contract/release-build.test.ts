import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { CORE_AGENT_MODEL_PATTERN, CORE_AGENT_MODEL_MAX_LENGTH } from "@agentx/contracts";
import type { ContainerImageAssetMetadataEntry } from "@aws-cdk/cloud-assembly-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { accumulateAsset, assetSignatureMismatch, buildRelease, parseBuildArgs, type PackageAccumulator } from "../../scripts/release/build.js";
import { ReleaseManifestSchema, type ReleaseManifest } from "../../scripts/release/manifest.js";
import { readZipEntries } from "../support/zip-entries.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const worker = `public.ecr.aws/agentx/agentx-worker@sha256:${"a".repeat(64)}`;
const executor = `public.ecr.aws/agentx/agentx-executor@sha256:${"c".repeat(64)}`;
const gateway = `public.ecr.aws/agentx/agentx-gateway@sha256:${"d".repeat(64)}`;

describe("release builder", () => {
  // A release build is a CDK synth of every region plus the packages (about a minute on CI), so the file runs two and every test reads them:
  // A, an ordinary build, and B, built with a much deeper TMPDIR and from a working directory outside the repository. B must come out byte for byte like A.
  // (Images go into the manifest only, never into a template or a package.)
  let a: { out: string; manifest: ReleaseManifest };
  let b: { manifest: ReleaseManifest; cwdAfter: string; elsewhere: string };

  beforeAll(async () => {
    const outA = join(await mkdtemp(join(tmpdir(), "agentx-release-")), "r");
    a = { out: outA, manifest: await buildRelease({ version: "1.2.3", out: outA, gitCommit: "b".repeat(40), images: { worker, executor, gateway } }) };

    // The old (buggy) implementation synthesized under os.tmpdir(), which made the number of ".." segments in the bundle's source map (and, because that
    // changes the bundle's own bytes, the asset id and every downstream checksum) depend on how deep the temp directory sits. And infra/lib/control-plane.ts
    // resolves each Lambda's `entry` (e.g. "packages/broker/src/aws/broker.ts") with resolve(process.cwd(), entry), so a build from outside the repository
    // root once failed to find those files at all.
    const baseOut = await mkdtemp(join(tmpdir(), "agentx-release-tmpdir-check-"));
    const deepTmp = join(baseOut, "much", "deeper", "nested", "path", "for", "a", "different", "tmpdir");
    await mkdir(deepTmp, { recursive: true });
    const elsewhere = await mkdtemp(join(tmpdir(), "agentx-release-elsewhere-"));
    const originalTmpdir = process.env.TMPDIR;
    const originalCwd = process.cwd();
    process.env.TMPDIR = deepTmp;
    process.chdir(elsewhere);
    try {
      const manifest = await buildRelease({ version: "1.2.3", out: join(baseOut, "b"), gitCommit: "b".repeat(40) });
      b = { manifest, cwdAfter: process.cwd(), elsewhere };
    } finally {
      process.chdir(originalCwd);
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  }, 900_000);

  it("writes templates, packages and a manifest whose checksums match the files", async () => {
    expect(ReleaseManifestSchema.parse(JSON.parse(await readFile(join(a.out, "release.json"), "utf8")))).toEqual(a.manifest);
    expect(a.manifest.legalDocuments?.map((document) => document.file)).toEqual([
      "legal/LICENSE",
      "legal/LICENSE-APACHE",
      "legal/RELICENSED.md",
    ]);
    // Every supported region's seven parts, region by region (SUPPORTED_REGIONS order).
    const parts = ["access", "foundation", "identity", "runtime", "control-plane", "gateway", "slack"];
    expect(a.manifest.templates.map((t) => [t.region, t.part])).toEqual(["us-east-1", "us-west-2"].flatMap((region) => parts.map((part) => [region, part])));
    for (const t of a.manifest.templates) {
      expect(t.file).toBe(`templates/${t.region}/${t.part}.template.json`);
      expect(sha(await readFile(join(a.out, t.file)))).toBe(t.sha256);
      if (t.part === "control-plane") {
        const template = JSON.parse(await readFile(join(a.out, t.file), "utf8")) as { Outputs: Record<string, unknown>; Parameters: Record<string, unknown> };
        expect(template.Outputs.ModelRunPriceVersion).toMatchObject({ Value: "1" });
        expect(template.Parameters.CoreAgentModel).toMatchObject({ AllowedPattern: CORE_AGENT_MODEL_PATTERN, MaxLength: CORE_AGENT_MODEL_MAX_LENGTH });
      }
    }
    for (const p of a.manifest.packages) {
      expect(sha(await readFile(join(a.out, p.file)))).toBe(p.sha256);
      expect(p.file).toBe(`packages/${p.assetId}.zip`);
      expect(p.keyParameterValue).toBe(`packages/||${p.assetId}.zip`);
    }
    for (const document of a.manifest.legalDocuments ?? []) {
      expect(sha(await readFile(join(a.out, document.file)))).toBe(document.sha256);
    }
    // The release carries all digests: worker, browser executor, and self-hosted Model Gateway.
    expect(a.manifest.images).toEqual({ worker, executor, gateway });
  });

  it("covers every asset parameter in every template with exactly one package, and ships no unused package", async () => {
    const declared = new Set(a.manifest.packages.flatMap((p) => [p.bucketParameter, p.keyParameter, p.hashParameter]));
    const used = new Set<string>();
    for (const t of a.manifest.templates) {
      const template = JSON.parse(await readFile(join(a.out, t.file), "utf8")) as { Parameters?: Record<string, unknown> };
      for (const name of Object.keys(template.Parameters ?? {}).filter((n) => n.startsWith("AssetParameters"))) {
        expect(declared.has(name), `${t.region}/${t.part}: ${name}`).toBe(true);
        used.add(name);
      }
    }
    expect([...declared].filter((n) => !used.has(n))).toEqual([]);
    expect((await readdir(join(a.out, "packages"))).sort()).toEqual(a.manifest.packages.map((p) => `${p.assetId}.zip`).sort());
  });

  it("refuses a non-empty output directory (an existing release) and a malformed image reference", async () => {
    await expect(buildRelease({ version: "1.2.3", out: a.out, gitCommit: "b".repeat(40) })).rejects.toThrow(/not empty/);
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    await expect(buildRelease({ version: "1.2.3", out: join(dir, "s"), gitCommit: "b".repeat(40), images: { worker: "public.ecr.aws/x/y:latest" } })).rejects.toThrow(/digest/);
  });

  it("takes the executor image from --executor-image and refuses one that is not pinned by digest", async () => {
    expect(parseBuildArgs(["--version", "1.2.3", "--out", "o", "--worker-image", worker, "--executor-image", executor, "--gateway-image", gateway]).images).toEqual({ worker, executor, gateway });
    expect(parseBuildArgs(["--version", "1.2.3", "--out", "o", "--executor-image", executor]).images).toEqual({ executor });
    expect(() => parseBuildArgs(["--version", "1.2.3", "--out", "o", "--executor-image"])).toThrow("--executor-image requires a value");
    expect(() => parseBuildArgs(["--version", "1.2.3", "--out", "o", "--gateway-image"])).toThrow("--gateway-image requires a value");
    const dir = await mkdtemp(join(tmpdir(), "agentx-release-"));
    const out = join(dir, "r");
    await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), images: { executor: "public.ecr.aws/x/executor:latest" } })).rejects.toThrow(/executor image must be referenced by digest/);
    await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), images: { gateway: "public.ecr.aws/x/gateway:latest" } })).rejects.toThrow(/gateway image must be referenced by digest/);
    await expect(readdir(out)).rejects.toThrow();
  });

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

  it("is independent of TMPDIR and how deep it is nested, and leaves no absolute path in a package's source map", async () => {
    expect(b.manifest.templates).toEqual(a.manifest.templates);
    expect(b.manifest.packages).toEqual(a.manifest.packages);

    // The source map itself must carry no absolute path: not the machine's home directory
    // (however it is arranged), and not this checkout's own absolute path either.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    let checkedAny = false;
    for (const pkg of a.manifest.packages) {
      const zipBuffer = await readFile(join(a.out, pkg.file));
      for (const entry of readZipEntries(zipBuffer)) {
        if (!entry.name.endsWith(".js.map")) continue;
        checkedAny = true;
        // Check only `sources` (the paths esbuild recorded for each original file), not
        // `sourcesContent` (the original file text, embedded verbatim): that text is free-form
        // source code and could legitimately contain a string that looks like an absolute path,
        // e.g. in a comment or a string literal, without that being the bug this test guards.
        const sourceMap = JSON.parse(entry.data.toString("utf8")) as { sources?: unknown };
        const sources = Array.isArray(sourceMap.sources) ? (sourceMap.sources as unknown[]).join("\n") : "";
        expect(sources).not.toMatch(/\/Users\//);
        expect(sources).not.toMatch(/\/home\//);
        expect(sources.includes(repoRoot)).toBe(false);
      }
    }
    expect(checkedAny).toBe(true);
  });

  it("succeeds when the caller's current working directory is somewhere other than the repo root, and restores it afterward", async () => {
    expect(b.manifest.templates.length).toBeGreaterThan(0);
    expect(b.manifest.packages.length).toBeGreaterThan(0);
    // Compare realpaths: process.cwd() resolves the macOS /tmp -> /private/tmp symlink, but `elsewhere` (built from os.tmpdir()) does not, even though they
    // name the same directory.
    expect(await realpath(b.cwdAfter)).toBe(await realpath(b.elsewhere));
  });
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

  it("rejects an actual no-S3 container asset before adding a package", () => {
    const packagesById = new Map<string, PackageAccumulator>();
    const containerAsset: ContainerImageAssetMetadataEntry = {
      packaging: "container-image",
      id: "container-asset",
      sourceHash: "a".repeat(64),
      path: "docker",
    };
    expect(() => accumulateAsset(packagesById, containerAsset, "slack", "/tmp/wherever")).toThrow(
      'unsupported asset packaging "container-image" for asset container-asset in the slack template; only zip-packaged Lambda code assets are supported here, images are published separately',
    );
    expect(packagesById.size).toBe(0);
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

describe("assetSignatureMismatch", () => {
  const accumulator = (overrides: Partial<PackageAccumulator> = {}): PackageAccumulator => ({
    assetId: "a".repeat(64),
    directory: "/tmp/dir",
    parts: ["control-plane"],
    bucketParameter: "Bucket1",
    keyParameter: "Key1",
    hashParameter: "Hash1",
    ...overrides,
  });

  it("reports no mismatch when baseline and candidate have identical asset ids and parameter names", () => {
    const baseline = new Map([["a".repeat(64), accumulator()]]);
    const candidate = new Map([["a".repeat(64), accumulator({ directory: "/tmp/other-region-dir" })]]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(false);
  });

  it("reports a mismatch when the candidate is missing an asset id present in the baseline", () => {
    const baseline = new Map([
      ["a".repeat(64), accumulator({ assetId: "a".repeat(64) })],
      ["b".repeat(64), accumulator({ assetId: "b".repeat(64) })],
    ]);
    const candidate = new Map([["a".repeat(64), accumulator({ assetId: "a".repeat(64) })]]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(true);
  });

  it("reports a mismatch when the candidate has an extra asset id not present in the baseline", () => {
    const baseline = new Map([["a".repeat(64), accumulator({ assetId: "a".repeat(64) })]]);
    const candidate = new Map([
      ["a".repeat(64), accumulator({ assetId: "a".repeat(64) })],
      ["b".repeat(64), accumulator({ assetId: "b".repeat(64) })],
    ]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(true);
  });

  it("reports a mismatch when the same asset id has a different bucketParameter", () => {
    const baseline = new Map([["a".repeat(64), accumulator({ bucketParameter: "Bucket1" })]]);
    const candidate = new Map([["a".repeat(64), accumulator({ bucketParameter: "Bucket2" })]]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(true);
  });

  it("reports a mismatch when the same asset id has a different keyParameter", () => {
    const baseline = new Map([["a".repeat(64), accumulator({ keyParameter: "Key1" })]]);
    const candidate = new Map([["a".repeat(64), accumulator({ keyParameter: "Key2" })]]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(true);
  });

  it("reports a mismatch when the same asset id has a different hashParameter", () => {
    const baseline = new Map([["a".repeat(64), accumulator({ hashParameter: "Hash1" })]]);
    const candidate = new Map([["a".repeat(64), accumulator({ hashParameter: "Hash2" })]]);
    expect(assetSignatureMismatch(baseline, candidate)).toBe(true);
  });
});

describe("ReleaseManifestSchema: (region, part) uniqueness", () => {
  const template = (region: string, part: string) => ({
    region,
    part,
    file: `templates/${region}/${part}.template.json`,
    sha256: "a".repeat(64),
  });

  const baseManifest = {
    schemaVersion: 1 as const,
    version: "1.2.3",
    gitCommit: "b".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq" as const,
    packages: [],
    images: {},
  };

  it("refuses a manifest with a duplicate (region, part) template pair", () => {
    const manifest = {
      ...baseManifest,
      templates: [template("us-east-1", "access"), template("us-east-1", "access")],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow(/each \(region, part\) pair must appear exactly once/);
  });

  it("accepts the same part used in two different regions", () => {
    const manifest = {
      ...baseManifest,
      templates: [template("us-east-1", "access"), template("us-west-2", "access")],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).not.toThrow();
  });
});

// Whoever can edit release.json also controls its recorded sha256, so a checksum match alone
// proves nothing about where a `file` path points: the schema itself must refuse any `file` value
// that could escape the release directory, by construction (not merely by convention).
describe("ReleaseManifestSchema: file path containment", () => {
  const baseManifest = {
    schemaVersion: 1 as const,
    version: "1.2.3",
    gitCommit: "b".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq" as const,
    images: {},
  };
  const assetId = "a".repeat(64);
  const validPackage = {
    assetId,
    file: `packages/${assetId}.zip`,
    sha256: "a".repeat(64),
    parts: ["runtime"],
    bucketParameter: "Bucket1",
    keyParameter: "Key1",
    hashParameter: "Hash1",
    keyParameterValue: `packages/||${assetId}.zip`,
  };

  it("refuses a template file that escapes the release directory via .. segments", () => {
    const manifest = {
      ...baseManifest,
      templates: [{ region: "us-east-1", part: "access", file: "templates/../../../etc/passwd", sha256: "a".repeat(64) }],
      packages: [],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow();
  });

  it("refuses a template file that is an absolute path", () => {
    const manifest = {
      ...baseManifest,
      templates: [{ region: "us-east-1", part: "access", file: "/etc/passwd", sha256: "a".repeat(64) }],
      packages: [],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow();
  });

  it("refuses a package file that escapes the release directory via .. segments", () => {
    const manifest = {
      ...baseManifest,
      templates: [],
      packages: [{ ...validPackage, file: `packages/../../../etc/passwd` }],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow();
  });

  it("refuses a package file that is an absolute path", () => {
    const manifest = {
      ...baseManifest,
      templates: [],
      packages: [{ ...validPackage, file: "/etc/passwd" }],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow();
  });

  it("refuses a package whose file does not equal packages/<assetId>.zip", () => {
    const manifest = {
      ...baseManifest,
      templates: [],
      packages: [{ ...validPackage, file: `packages/${"b".repeat(64)}.zip` }],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow(/file must equal packages\/<assetId>\.zip/);
  });

  it("refuses a template whose file does not equal templates/<region>/<part>.template.json for its own region and part", () => {
    const manifest = {
      ...baseManifest,
      templates: [{ region: "us-east-1", part: "access", file: "templates/us-west-2/access.template.json", sha256: "a".repeat(64) }],
      packages: [],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).toThrow(/file must equal templates\/<region>\/<part>\.template\.json/);
  });

  it("accepts the well-formed template and package file shapes the release builder produces", () => {
    const manifest = {
      ...baseManifest,
      templates: [{ region: "us-east-1", part: "access", file: "templates/us-east-1/access.template.json", sha256: "a".repeat(64) }],
      packages: [validPackage],
    };
    expect(() => ReleaseManifestSchema.parse(manifest)).not.toThrow();
  });
});
