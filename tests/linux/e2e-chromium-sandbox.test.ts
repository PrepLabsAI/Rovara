import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChromiumSandboxAttestationSchema, evaluateChromiumSandbox } from "../../packages/contracts/src/index.js";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { docker } from "../support/linux-network-walls.js";
import { EXECUTOR_IMAGE, removeProbeDirs, runProbe } from "../support/linux-runtime.js";

/**
 * Chromium's own sandbox inside the executor container, on a real kernel: the same flags the production host gives the executor (every capability dropped,
 * no-new-privileges, read-only root, no network) with the pinned seccomp profile and no `--no-sandbox`. It runs only in the CI `linux-runtime` job
 * (ubuntu-24.04-arm, ROVARA_DOCKER=1, the sysctl step that lets the runner create unprivileged user namespaces); everywhere else it skips.
 */

/** Runs inside the executor image: launch the production Chromium (optionally behind a wrapper that adds --no-sandbox), look at its renderers, report. */
const INSIDE_THE_CONTAINER = `
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { evaluateChromiumSandbox } from "@agentx/contracts";
import { launchLocalChromium } from "/opt/agentx/packages/verifier/dist/executor/local-browser.js";
import { inspectChromiumSandbox } from "/opt/agentx/packages/verifier/dist/executor/chromium-sandbox.js";
const controller = new AbortController();
let executablePath;
if (process.env.SANDBOX_MODE === "no-sandbox") {
  // The only difference from production: the browser is started with --no-sandbox, as it was before this task.
  executablePath = "/tmp/chrome-no-sandbox";
  writeFileSync(executablePath, "#!/bin/sh\\nexec '" + chromium.executablePath() + "' --no-sandbox \\"$@\\"\\n");
  chmodSync(executablePath, 0o755);
}
let result;
try {
  const browser = await launchLocalChromium({ downloadDir: "/tmp/downloads", signal: controller.signal, ...(executablePath ? { executablePath } : {}) });
  const attestation = await inspectChromiumSandbox({ cdpEndpoint: browser.cdpEndpoint, browserPid: browser.pid, runId: "7f1d1c6e-4f43-4d5c-9b8f-2a6f3c0a9d11", groupId: "linux-ci", signal: controller.signal });
  const status = readFileSync("/proc/self/status", "utf8");
  result = { launched: true, attestation, verdict: evaluateChromiumSandbox(attestation), capEff: /CapEff:\\s*(\\w+)/.exec(status)?.[1], noNewPrivs: /NoNewPrivs:\\s*(\\d)/.exec(status)?.[1] };
  await browser.close();
} catch (error) {
  result = { launched: false, error: String(error instanceof Error ? error.message : error).slice(-800) };
}
process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
`;

type Outcome = { launched: true; attestation: unknown; verdict: { sandboxed: boolean; reason?: string }; capEff: string; noNewPrivs: string } | { launched: false; error: string };

/** The production executor container's own hardening, with a seccomp option of the test's choosing. */
async function inContainer(mode: "sandbox" | "no-sandbox", seccomp: "pinned" | "docker-default"): Promise<{ outcome: Outcome; raw: string }> {
  const args = ["run", "--rm", "--init", "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
    ...(seccomp === "pinned" ? ["--security-opt", `seccomp=${installedExecutorSeccompProfilePath()}`] : []),
    "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m", "--shm-size", "1g", "--pids-limit", "1024", "--memory", "2g", "-e", `SANDBOX_MODE=${mode}`,
    EXECUTOR_IMAGE, "node", "--input-type=module", "-e", INSIDE_THE_CONTAINER];
  const result = await docker(...args);
  const raw = `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
  const line = result.stdout.split("\n").find((item) => item.startsWith("RESULT "));
  if (!line) throw new Error(`the container printed no result\n${raw}`);
  return { outcome: JSON.parse(line.slice("RESULT ".length)) as Outcome, raw };
}

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("Chromium's own sandbox inside the executor container", () => {
  afterAll(removeProbeDirs, 120_000);

  it("is on under the pinned seccomp profile with every capability dropped: renderers have their own seccomp filter, PID namespace and user namespace", async () => {
    const { outcome, raw } = await inContainer("sandbox", "pinned");
    if (!outcome.launched) throw new Error(`Chromium did not start with its sandbox on: ${outcome.error}\n${raw}`);
    expect(outcome.verdict, raw).toEqual({ sandboxed: true });
    const attestation = ChromiumSandboxAttestationSchema.parse(outcome.attestation);
    expect(attestation.renderers.length, raw).toBeGreaterThan(0);
    for (const renderer of attestation.renderers) {
      expect(renderer.seccompFilters, raw).toBeGreaterThan(attestation.browser.seccompFilters);
      expect(renderer.nsPidDepth, raw).toBeGreaterThan(attestation.browser.nsPidDepth);
      expect(renderer.uidMap, raw).not.toBe(attestation.browser.uidMap);
    }
    // No capability was added to make that work, and no new privilege can be gained.
    expect(outcome.capEff, raw).toBe("0000000000000000");
    expect(outcome.noNewPrivs, raw).toBe("1");
  }, 180_000);

  it("negative control: a --no-sandbox browser in the very same container is detected as unsandboxed", async () => {
    const { outcome, raw } = await inContainer("no-sandbox", "pinned");
    if (!outcome.launched) throw new Error(`the --no-sandbox control did not start: ${outcome.error}\n${raw}`);
    expect(outcome.verdict.sandboxed, raw).toBe(false);
    const attestation = ChromiumSandboxAttestationSchema.parse(outcome.attestation);
    expect(attestation.renderers.length, raw).toBeGreaterThan(0);
    // An unsandboxed renderer is an ordinary child of the browser: same filters, same PID namespace, same user namespace.
    for (const renderer of attestation.renderers) {
      expect([renderer.seccompFilters, renderer.nsPidDepth, renderer.uidMap], raw).toEqual([attestation.browser.seccompFilters, attestation.browser.nsPidDepth, attestation.browser.uidMap]);
    }
  }, 180_000);

  it("fails closed under Docker's default seccomp profile: Chromium cannot start its sandbox, so it does not start, and nothing falls back to --no-sandbox", async () => {
    const { outcome, raw } = await inContainer("sandbox", "docker-default");
    expect(outcome.launched, `Chromium started although Docker's default profile forbids creating user namespaces without CAP_SYS_ADMIN\n${raw}`).toBe(false);
    if (!outcome.launched) expect(outcome.error).toContain("chromium exited before it opened a debugging port");
  }, 180_000);

  it("is verified for every real run: the host runs the executor under the pinned profile and the executor keeps the facts it saw", async () => {
    const r = await runProbe("web-csv-positive-v1", { defect: null });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    expect(r.exitCode, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBe(0);
    const outDir = r.outDir!;
    const attestation = ChromiumSandboxAttestationSchema.parse(JSON.parse(await readFile(join(outDir, "chromium-sandbox.json"), "utf8")));
    expect(attestation).toMatchObject({ runId: r.fixture.plan.runId, groupId: r.fixture.plan.groupId });
    expect(evaluateChromiumSandbox(attestation)).toEqual({ sandboxed: true });
    expect(await readFile(join(outDir, "executor.log"), "utf8")).toContain("chromium sandbox verified");
  }, 300_000);
});
