import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ReleaseBuild from "../../scripts/release/build.js";
import type { BuildReleaseInput } from "../../scripts/release/build.js";
import type { ReleaseManifest } from "../../scripts/release/manifest.js";
import { verifyRelease } from "../../scripts/release/verify.js";

// A release build is a CDK synth of every region plus the packages (about a minute on CI), and verifyRelease rebuilds one to compare against. The file builds
// one release, once. The first test verifies a copy of it with a real rebuild, so two independent builds still have to match; the tampering tests verify
// copies too, and their rebuild is a copy of that same build (`reuseBuild`), since what they check is that verify names the changed file.
const VERSION = "1.2.3";
const GIT_COMMIT = "c".repeat(40);
const built: { dir?: string; manifest?: ReleaseManifest; parent?: string } = {};
let reuseBuild = false;

vi.mock("../../scripts/release/build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ReleaseBuild>();
  return {
    ...actual,
    buildRelease: async (input: BuildReleaseInput): Promise<ReleaseManifest> => {
      if (!reuseBuild || built.dir === undefined || built.manifest === undefined) return actual.buildRelease(input);
      expect({ version: input.version, gitCommit: input.gitCommit }).toEqual({ version: VERSION, gitCommit: GIT_COMMIT });
      await cp(built.dir, input.out, { recursive: true });
      return structuredClone(built.manifest);
    },
  };
});

const temporaryDirectories: string[] = [];

beforeAll(async () => {
  const { buildRelease } = await import("../../scripts/release/build.js");
  built.parent = await mkdtemp(join(tmpdir(), "agentx-verify-built-"));
  built.dir = join(built.parent, "r");
  built.manifest = await buildRelease({ version: VERSION, out: built.dir, gitCommit: GIT_COMMIT });
}, 900_000);

afterEach(async () => {
  reuseBuild = false;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(async () => {
  if (built.parent !== undefined) await rm(built.parent, { recursive: true, force: true });
});

/** A fresh copy of the one release this file builds, and its manifest. */
async function copyOfRelease(): Promise<{ dir: string; manifest: ReleaseManifest }> {
  const base = await mkdtemp(join(tmpdir(), "agentx-verify-"));
  temporaryDirectories.push(base);
  const dir = join(base, "r");
  await cp(built.dir!, dir, { recursive: true });
  return { dir, manifest: structuredClone(built.manifest!) };
}

describe("release verification", () => {
  it("passes for a release built from the current source", async () => {
    const { dir } = await copyOfRelease();
    expect(await verifyRelease({ dir })).toEqual({ ok: true });
  }, 300_000);

  it("names a tampered package and a tampered template", async () => {
    const { dir, manifest } = await copyOfRelease();
    reuseBuild = true;
    await writeFile(join(dir, manifest.packages[0]!.file), "tampered");
    await writeFile(join(dir, manifest.templates[0]!.file), "{}\n");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.packages[0]!.file))).toBe(true);
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 300_000);

  it("names a missing file instead of throwing", async () => {
    const { dir, manifest } = await copyOfRelease();
    reuseBuild = true;
    await rm(join(dir, manifest.templates[0]!.file));
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 300_000);

  it("names a template that a rebuild from current source produces but the release doesn't have, not just the reverse", async () => {
    const { dir, manifest } = await copyOfRelease();
    reuseBuild = true;
    const dropped = manifest.templates[0]!;
    const edited = {
      ...manifest,
      templates: manifest.templates.filter((t) => !(t.region === dropped.region && t.part === dropped.part)),
    };
    await writeFile(join(dir, "release.json"), `${JSON.stringify(edited, null, 2)}\n`, "utf8");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(dropped.file) && p.includes("not present in this release"))).toBe(true);
  }, 300_000);
});

describe("verifyRelease: release.json problems", () => {
  it("reports a missing release.json as a problem naming release.json, instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-verify-missing-"));
    temporaryDirectories.push(dir);
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("release.json");
  });

  it("reports an unparseable release.json (invalid JSON) as a problem naming release.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-verify-badjson-"));
    temporaryDirectories.push(dir);
    await writeFile(join(dir, "release.json"), "{ this is not json", "utf8");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("release.json");
  });

  it("reports a schema-invalid release.json as a problem naming release.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-verify-badschema-"));
    temporaryDirectories.push(dir);
    await writeFile(join(dir, "release.json"), `${JSON.stringify({ schemaVersion: 2, version: "not-a-version" })}\n`, "utf8");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("release.json");
  });
});

describe("CI workflow reproducibility check", () => {
  it("runs a release build+verify reproducibility step in the quick job's release part, after infra:synth", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const text = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const workflow = YAML.parse(text) as {
      jobs: { quick: { steps: Array<{ name?: string; run?: string; uses?: string }> } };
    };
    const steps = workflow.jobs.quick.steps;
    const synthIndex = steps.findIndex((step) => typeof step.run === "string" && step.run.includes("infra:synth"));
    const reproIndex = steps.findIndex(
      (step) =>
        typeof step.run === "string" && step.run.includes("release:build") && step.run.includes("release:verify"),
    );
    expect(synthIndex).toBeGreaterThanOrEqual(0);
    expect(reproIndex).toBeGreaterThan(synthIndex);

    const reproStep = steps[reproIndex]!;
    expect(reproStep.run).toContain("$RUNNER_TEMP/release-a");
    expect(reproStep.run).toContain("$RUNNER_TEMP/release-b");
    expect(reproStep.run).toMatch(/diff\s+"?\$RUNNER_TEMP\/release-a\/release\.json"?\s+"?\$RUNNER_TEMP\/release-b\/release\.json"?/);
  });
});
