import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { buildRelease } from "../../scripts/release/build.js";
import { verifyRelease } from "../../scripts/release/verify.js";

describe("release verification", () => {
  it("passes for a release built from the current source", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-verify-")), "r");
    await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    expect(await verifyRelease({ dir })).toEqual({ ok: true });
  }, 900_000);

  it("names a tampered package and a tampered template", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-verify-")), "r");
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
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-verify-")), "r");
    const manifest = await buildRelease({ version: "1.2.3", out: dir, gitCommit: "c".repeat(40) });
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, manifest.templates[0]!.file));
    const result = await verifyRelease({ dir });
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.some((p) => p.includes(manifest.templates[0]!.file))).toBe(true);
  }, 900_000);
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
