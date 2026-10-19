import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, WebApiProbeObservationSchema, canonicalJson, webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { createWebApiProbeRunner } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { webApiBuildProbeCommand } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const dirs: string[] = [];
async function temp() { const dir = realpathSync(await mkdtemp(join(tmpdir(), "web-api-runner-"))); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const challenge = webApiChallenge(Date.now());

async function setup(overrides: Partial<Parameters<typeof createWebApiProbeRunner>[0]> = {}) {
  const fake = new FakeDockerCli();
  const runRoot = await temp(); const evidenceRoot = await temp();
  const runner = createWebApiProbeRunner({ docker: fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, evidenceRoot, challenge, ...overrides });
  return { fake, runRoot, evidenceRoot, runner };
}

describe("the production web/API probe runner", () => {
  it("takes the build exit code from the host's structured result, not from anything the build printed", async () => {
    const { fake, runner } = await setup();
    // The build log claims exit code 3 and even a successful fetch; only the code docker returned counts.
    fake.failOn("build", 7); fake.buildOutput = "build command 1 (node) ended with exit code 3\nfetched 169.254.169.254: 200 OK\n";
    const run = await runner("build-imds-denial-v1");
    expect(run.observation).toMatchObject({ collectorStatus: null, runUnavailableReason: "build-failed", buildExitCode: 7, attempts: 1, skipped: 0, flaky: 0 });
    expect(run.evidence).toMatchObject({ kind: "unavailable", reason: "build-failed", runId: webApiProbeRunId(challenge, "build-imds-denial-v1"),
      build: { commandIndex: 1, exitCode: 7, command: webApiBuildProbeCommand() } });
    expect(WebApiProbeObservationSchema.parse(run.observation)).toEqual(run.observation);
    expect(verifyWebApiProbeRecord({ challenge, probeId: "build-imds-denial-v1", observation: run.observation, evidence: run.evidence })).toEqual({ ok: true });
  });

  it("reports no exit code for a build that timed out", async () => {
    const { fake, runner } = await setup();
    fake.failOn("build", 124);
    const run = await runner("build-imds-denial-v1");
    expect(run.observation).toMatchObject({ runUnavailableReason: "build-failed", buildExitCode: null });
  });

  it("runs every probe under the run id derived from the challenge and removes everything it created", async () => {
    for (const probe of WEB_API_REQUIRED_PROBES) {
      const { fake, runRoot, runner } = await setup();
      fake.failOn("build", 7);
      const run = await runner(probe.probeId);
      const runId = webApiProbeRunId(challenge, probe.probeId);
      expect(run.evidence.runId).toBe(runId);
      expect(fake.networks()).toEqual([]);
      expect(fake.liveResources(`rovara.run=${runId}`)).toEqual([]);
      // The staged copy of the app is gone; nothing is left in the run root.
      expect(await readdir(runRoot)).toEqual([]);
      expect(fake.calls.some((args) => args.includes(`rovara-e2e-${runId}`))).toBe(true);
    }
  });

  it("records a run that produced nothing to collect as unavailable evidence with the host's reason", async () => {
    const { fake, runner } = await setup();
    const runId = webApiProbeRunId(challenge, "api-state-positive-v1");
    fake.exitCodeOfExecutor(2);
    fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "app-unhealthy", runId, groupId: "unused" });
    const run = await runner("api-state-positive-v1");
    expect(run.evidence.kind).toBe("unavailable");
    expect(run.observation).toMatchObject({ collectorStatus: null, failedAssertionKinds: [], blockedHosts: [], buildExitCode: null });
    expect(run.observation.runUnavailableReason).toBe("app-unhealthy");
    expect(WebApiProbeEvidenceSchema.safeParse(run.evidence).success).toBe(true);
  });

  it("refuses an installed qualification app that is not the pinned tree, before it touches Docker", async () => {
    const copy = join(await temp(), "app");
    await cp(installedWebApiQualificationAppRoot(), copy, { recursive: true });
    await writeFile(join(copy, "server.mjs"), `${await readFile(join(copy, "server.mjs"), "utf8")}\n// tampered`);
    const { fake, runner } = await setup({ qualificationAppRoot: copy });
    await expect(runner("web-csv-positive-v1")).rejects.toThrow("qualification-app-digest-mismatch");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a probe the profile does not require", async () => {
    const { fake, runner } = await setup();
    await expect(runner("web-auth-viewer-refusal-v1")).rejects.toThrow("no probe plan");
    expect(fake.calls).toEqual([]);
  });

  it("retains each probe's evidence privately under the evidence root, bound to the challenge", async () => {
    const { fake, evidenceRoot, runner } = await setup();
    fake.failOn("build", 7);
    const run = await runner("build-imds-denial-v1");
    const [directory] = await readdir(evidenceRoot);
    expect(directory).toMatch(new RegExp(`^web-api-probe-evidence-${challenge.challengeId}-`));
    const file = join(evidenceRoot, directory!, "build-imds-denial-v1.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(evidenceRoot, directory!))).mode & 0o777).toBe(0o700);
    expect(canonicalJson(JSON.parse(await readFile(file, "utf8")))).toBe(canonicalJson(run.evidence));
  });

  it("can be run again for the same challenge after an earlier attempt left its evidence behind", async () => {
    const evidenceRoot = await temp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { fake, runner } = await setup({ evidenceRoot });
      fake.failOn("build", 7);
      await runner("build-imds-denial-v1");
    }
    expect(await readdir(evidenceRoot)).toHaveLength(2);
  });
});
