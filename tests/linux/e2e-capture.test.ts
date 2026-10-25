import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "../../packages/verifier/src/executor/capture.js";
import { removeProbeDirs, runProbe, type ProbeRun } from "../support/linux-runtime.js";

const why = (r: ProbeRun) => {
  const logs = r.host.readDiagnostics(r.fixture.plan.runId);
  return `the run was ${r.run.unavailableReason === null ? "available" : `unavailable (${r.run.unavailableReason})`}; executor exit code ${String(r.exitCode)}\n`
    + `app log: ${logs.appLogTail || "(empty)"}\nexecutor log: ${logs.executorLogTail || "(empty)"}`;
};
const outOf = (r: ProbeRun) => { if (r.outDir === null) throw new Error(`the run was unavailable: ${why(r)}`); return r.outDir; };
const artifactsOf = async (outDir: string) => (JSON.parse(await readFile(join(outDir, "artifacts.json"), "utf8")) as { artifacts: Array<{ caseId: string; kind: string; sha256: string; bytes: number; omitted?: string }> }).artifacts;

// Task 3.6 on real Docker, the real executor image and a real Chromium (the CI `linux-runtime` job: ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE). Everywhere else it skips.
// Screenshots only (Ruling CJ): there is no trace capture. The web qualification probes declare screenshots (their engine descriptor needs the artifacts capability), so a
// FAILED probe case takes one; nothing in the probe runner reads it, and no probe digest depends on it.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("screenshots of failed cases, in a real executor", () => {
  afterAll(removeProbeDirs, 120_000);

  it("a FAILED web case keeps one JPEG screenshot within its cap, no trace, and no credential in any stored byte", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: "extra-order.json" });
    expect(r.exitCode, why(r)).toBe(1);
    const out = outOf(r);
    const artifacts = await artifactsOf(out);
    expect(artifacts.map((item) => item.kind), JSON.stringify(artifacts)).toEqual(["screenshot"]);
    expect(artifacts.every((item) => item.omitted === undefined), JSON.stringify(artifacts)).toBe(true);
    const screenshot = await readFile(join(out, "captures", "case-0-screenshot.jpg"));
    expect(screenshot.byteLength).toBeLessThanOrEqual(CAPTURE_SCREENSHOT_MAX_BYTES);
    expect([...screenshot.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect((await readdir(join(out, "captures"))).filter((name) => /trace|\.zip$/.test(name))).toEqual([]);
    expect(r.credentialsLeaked).toBe(false);
    // The worker's view of the same run: the listing and the file travel in the actual run, for the operator's evidence.
    const captures = (r.run.actualRun as { executorEvidence?: { captures: { files: Array<{ name: string }> } | null } } | null)?.executorEvidence?.captures;
    expect(captures?.files.map((file) => file.name)).toEqual(["case-0-screenshot.jpg"]);
  }, 300_000);

  it("a PASS case keeps no capture, and the listing is empty", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null });
    expect(r.exitCode, why(r)).toBe(0);
    const out = outOf(r);
    expect(await artifactsOf(out)).toEqual([]);
    expect(await readdir(join(out, "captures")).catch(() => [])).toEqual([]);
  }, 300_000);

  it("an API run, whose admission approves no capture, writes no capture file and no listing", async () => {
    const r = await runProbe("api-state-positive-v1", { defect: null });
    expect(r.exitCode, why(r)).toBe(0);
    const out = outOf(r);
    expect(await readdir(out)).not.toContain("captures");
    expect(await readdir(out)).not.toContain("artifacts.json");
  }, 300_000);
});
