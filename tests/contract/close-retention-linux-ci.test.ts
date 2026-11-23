import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; if?: string; uses?: string; run?: string; with?: Record<string, string> };
const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { permissions?: unknown; steps: Step[] }> };
const job = workflow.jobs["linux-runtime"]!;
const step = (name: string) => job.steps.find((item) => item.name === name)!;

it("prepares a local worker digest and runs the complete mutation grid only on the existing manual Linux path", () => {
  expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  const prepare = step("Prepare close retention worker digest (manual only)");
  const grid = step("Close retention Linux mutation grid (manual only)");
  for (const item of [prepare, grid]) {
    expect(item.if).toBe("(success() || failure()) && steps.runtime_setup.outcome == 'success'");
    expect(item.run).toContain('if [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then');
    expect(item.run).toContain("CODE_CI_LINUX=1 python3 scripts/linux-mutation-grid.py");
    const run = spawnSync("bash", ["-euc", item.run!], { env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("");
  }
  expect(prepare.run).toContain("--prepare-image");
  expect(job.steps.indexOf(prepare)).toBeLessThan(job.steps.indexOf(grid));
  expect(job.steps.indexOf(grid)).toBeLessThan(job.steps.indexOf(step("Sandbox egress gateway (boot stage on real Docker)")));
  const archive = step("Upload close retention Linux mutations");
  expect(archive.if).toBe("always() && github.event_name == 'workflow_dispatch'");
  expect(archive.uses).toBe("actions/upload-artifact@v4");
  expect(archive.with).toEqual({ name: "close-retention-linux-mutants", path: "linux-mutants.json", "if-no-files-found": "error" });
});

it("activates both named Linux proofs without silently skipping a missing image", () => {
  const directory = mkdtempSync(join(tmpdir(), "close-retention-linux-inputs-"));
  try {
    const config = join(directory, "vitest.config.mjs");
    writeFileSync(config, "export default {test:{include:[" + JSON.stringify(resolve("tests/linux/worker-close-retention.test.ts")) + "],maxWorkers:1}};\n");
    for (const input of [{ enabled: "1", image: undefined }, { enabled: "1", image: "localhost:5000/close-retention:latest" }, { enabled: "0", image: undefined }, { enabled: "2", image: undefined }, { enabled: undefined, image: undefined }]) {
      const env: NodeJS.ProcessEnv = { ...process.env, CODE_CI_LINUX: input.enabled };
      delete env.CLOSE_RETENTION_TEST_IMAGE;
      if (input.image !== undefined) env.CLOSE_RETENTION_TEST_IMAGE = input.image;
      const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", config, "--reporter=json", "--outputFile=" + join(directory, "report.json")], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 });
      expect(result.status, result.stderr).toBe(input.enabled === "1" ? 1 : 0);
      const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8")) as { numTotalTests: number; numFailedTests: number; numPendingTests: number; testResults: Array<{ assertionResults: Array<{ failureMessages: string[] }> }> };
      expect(report.numTotalTests).toBe(2);
      expect(report.numFailedTests).toBe(input.enabled === "1" ? 2 : 0);
      expect(report.numPendingTests).toBe(input.enabled === "1" ? 0 : 2);
      if (input.enabled === "1") {
        const failures = report.testResults.flatMap((item) => item.assertionResults);
        expect(failures[0]!.failureMessages.join("\n")).toContain("manual proof needs an already-installed digest-pinned Linux worker image");
        expect(failures[1]!.failureMessages.join("\n")).toContain("preload the final worker image by digest");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
