import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { verifyRelease } from "../../scripts/release/verify.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("release verification", () => {
  it("passes for a release built from the current source", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentx-verify-"));
    temporaryDirectories.push(base);
    const dir = join(base, "r");
    await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    expect(await verifyRelease({ dir })).toEqual({ ok: true });
  }, 900_000);

  it("names a tampered package and a tampered template", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentx-verify-"));
    temporaryDirectories.push(base);
    const dir = join(base, "r");
    const manifest = await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    await writeFile(join(dir, manifest.packages[0]!.file), "tampered");
    await writeFile(join(dir, manifest.templates[0]!.file), "{}\n");
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.packages[0]!.file))).toBe(true);
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 900_000);

  it("names a missing file instead of throwing", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentx-verify-"));
    temporaryDirectories.push(base);
    const dir = join(base, "r");
    const manifest = await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    await rm(join(dir, manifest.templates[0]!.file));
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 900_000);

  it("names a template that a rebuild from current source produces but the release doesn't have, not just the reverse", async () => {
    const base = await mkdtemp(join(tmpdir(), "agentx-verify-"));
    temporaryDirectories.push(base);
    const dir = join(base, "r");
    const manifest = await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
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
  }, 900_000);
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
  it("runs a release build+verify reproducibility step in the local job, after infra:synth", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const text = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const workflow = YAML.parse(text) as {
      jobs: { local: { steps: Array<{ name?: string; run?: string; uses?: string }> } };
    };
    const steps = workflow.jobs.local.steps;
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
