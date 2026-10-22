import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_ROUTE, WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, WebApiProbeObservationSchema, canonicalJson, webApiProbeRunId } from "../../packages/contracts/src/index.js";
import { MAX_BLOCKED_REQUESTS_BYTES, createWebApiProbeRunner, readBlockedRequests, readChromiumSandboxAttestation, type WebApiProbeModelChannelRequest } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { webApiAgentProbeScript, webApiBuildProbeCommand } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { installedWebApiQualificationAppRoot } from "../../packages/verifier/src/host/web-api-qualification-app.js";
import { verifyWebApiProbeRecord } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { FakeDockerCli, writeExecutorOutput } from "../support/fake-docker-cli.js";
import { webApiChallenge } from "../support/web-api-qualification.js";

const dirs: string[] = [];
// Short on purpose: an agent probe's model socket sits under the run root, and a unix socket path holds 103 bytes.
async function temp() { const dir = realpathSync(await mkdtemp("/tmp/rvrn-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const challenge = webApiChallenge(Date.now());

async function setup(overrides: Partial<Parameters<typeof createWebApiProbeRunner>[0]> = {}, options: { withoutChannel?: boolean } = {}) {
  const fake = new FakeDockerCli();
  const runRoot = await temp(); const evidenceRoot = await temp();
  const channelRequests: WebApiProbeModelChannelRequest[] = [];
  // The model channel of an agent probe, as the qualifier supplies it: this stand-in only records what it was asked for (the worker's real one is exercised with a real executor in web-api-probe-runner-local.test.ts).
  const modelChannelFor = (request: WebApiProbeModelChannelRequest) => { channelRequests.push(request); return { open: async () => { throw new Error("not opened in this test"); } }; };
  const runner = createWebApiProbeRunner({ docker: fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, evidenceRoot, challenge, ...(options.withoutChannel === true ? {} : { modelChannelFor }), ...overrides });
  return { fake, runRoot, evidenceRoot, runner, channelRequests };
}

describe("the production web/API probe runner", () => {
  it("takes the build exit code from the host's structured result, not from anything the build printed", async () => {
    const { fake, runner } = await setup();
    // The build log claims exit code 3 and even a successful fetch; only the code docker returned counts.
    fake.failOn("build", 7); fake.buildOutput = "build command 1 (node) ended with exit code 3\nfetched 169.254.169.254: 200 OK\n";
    const run = await runner("build-imds-denial-v1");
    expect(run.observation).toMatchObject({ collectorStatus: null, runUnavailableReason: "build-failed", buildExitCode: 7, attempts: 1, skipped: 0, flaky: 0 });
    expect(run.evidence).toMatchObject({ kind: "unavailable", reason: "build-failed", runId: webApiProbeRunId(challenge, "build-imds-denial-v1"),
      build: { commandIndex: 1, exitCode: 7, command: webApiBuildProbeCommand("build-imds-denial-v1") } });
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
      // Both per-run networks were created and removed.
      expect(fake.calls.filter((args) => args[0] === "network" && args[1] === "create").map((args) => args.at(-1)).sort()).toEqual([`rovara-e2e-${runId}`, `rovara-e2e-build-${runId}`].sort());
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

  it("does not run an agent probe without a model channel: nothing is staged, nothing is started, and the attempt fails closed", async () => {
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      const { fake, runRoot, runner } = await setup({}, { withoutChannel: true });
      await expect(runner(probeId)).rejects.toThrow(`no model channel to run ${probeId}`);
      expect(fake.calls).toEqual([]);
      expect(await readdir(runRoot)).toEqual([]);
    }
  });

  it("asks for the scripted model channel of an agent probe only: the probe, its run, the asset's script and goal, the pinned route and the group's one AI-navigated step", async () => {
    const { fake, runner, channelRequests } = await setup();
    fake.failOn("build", 7);
    for (const probeId of WEB_API_AGENT_PROBE_IDS) await runner(probeId);
    expect(channelRequests.map((request) => request.probeId)).toEqual([...WEB_API_AGENT_PROBE_IDS]);
    for (const request of channelRequests) {
      expect(request).toMatchObject({ runId: webApiProbeRunId(challenge, request.probeId), goal: "Export the orders as a CSV file", modelRoute: WEB_API_AGENT_PROBE_ROUTE, allowedSteps: [{ stepIndex: 1 }] });
      expect(request.script).toEqual(webApiAgentProbeScript(request.probeId));
    }
    // A probe with no AI navigation never gets a channel (the host refuses one for a group that has no agent step).
    const other = await setup();
    other.fake.failOn("build", 7);
    for (const probe of WEB_API_REQUIRED_PROBES.slice(0, 11)) await other.runner(probe.probeId);
    expect(other.channelRequests).toEqual([]);
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

  it("clears what an earlier attempt of the same run left behind before it stages and allocates", async () => {
    const { fake, runRoot, runner } = await setup();
    fake.failOn("build", 7);
    const runId = webApiProbeRunId(challenge, "build-imds-denial-v1");
    // A candidate copy, a run workspace, a network and a container, all labeled for this run, as a killed qualification leaves them.
    await mkdir(join(runRoot, `candidate-${runId}`), { recursive: true });
    await writeFile(join(runRoot, `candidate-${runId}`, "stale.txt"), "stale");
    await mkdir(join(runRoot, runId, "out"), { recursive: true });
    await writeFile(join(runRoot, runId, "out", "stale.txt"), "stale");
    await fake.run(["network", "create", "--internal", "--label", `rovara.run=${runId}`, `rovara-e2e-${runId}`], { signal: new AbortController().signal, timeoutMs: 1_000 });
    await fake.run(["run", "-d", "--name", `rovara-app-${runId}`, "--label", `rovara.run=${runId}`], { signal: new AbortController().signal, timeoutMs: 1_000 }).catch(() => undefined);
    expect(fake.networks()).toEqual([`rovara-e2e-${runId}`]);
    const before = fake.calls.length;
    const run = await runner("build-imds-denial-v1");
    expect(run.observation).toMatchObject({ runUnavailableReason: "build-failed", buildExitCode: 7 });
    expect(fake.networks()).toEqual([]);
    expect(fake.liveResources(`rovara.run=${runId}`)).toEqual([]);
    expect(await readdir(runRoot)).toEqual([]);
    // The clearing came first: the leftover network was removed before the host created this attempt's.
    const calls = fake.calls.slice(before).map((args) => args.join(" "));
    expect(calls.indexOf(`network rm rovara-e2e-${runId}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`network rm rovara-e2e-${runId}`)).toBeLessThan(calls.findIndex((call) => call.startsWith("network create")));
  });

  it("refuses an installed probe asset that is not the pinned one, before it touches Docker", async () => {
    const root = join(await temp(), "assets");
    await cp(join(installedWebApiQualificationAppRoot(), "../application-runtime-v1/probes"), root, { recursive: true });
    await writeFile(join(root, "web-csv-positive-v1.json"), `${await readFile(join(root, "web-csv-positive-v1.json"), "utf8")} `);
    const { fake, runner } = await setup({ probeAssetsRoot: root });
    await expect(runner("web-csv-positive-v1")).rejects.toThrow("probe-asset-digest-mismatch:web-csv-positive-v1");
    expect(fake.calls).toEqual([]);
    expect(() => loadWebApiQualificationProbeAssets(root)).toThrow("probe-asset-digest-mismatch:web-csv-positive-v1");
  });
});

describe("the blocked-requests file the runner keeps", () => {
  it("is read whole when it fits the evidence schema's base64 bound and dropped when it does not", async () => {
    const dir = await temp();
    const write = (size: number) => writeFile(join(dir, "blocked-requests.json"), Buffer.alloc(size, 97));
    await write(MAX_BLOCKED_REQUESTS_BYTES);
    expect((await readBlockedRequests(dir))?.byteLength).toBe(MAX_BLOCKED_REQUESTS_BYTES);
    // The largest accepted file is the largest that stays within the schema's 262144 base64 characters.
    expect(Math.ceil(MAX_BLOCKED_REQUESTS_BYTES / 3) * 4).toBeLessThanOrEqual(262_144);
    await write(MAX_BLOCKED_REQUESTS_BYTES + 1);
    expect(await readBlockedRequests(dir)).toBeNull();
    expect(await readBlockedRequests(join(dir, "absent"))).toBeNull();
  });

  it("reads the executor's Chromium sandbox attestation only when it fits the evidence schema's base64 bound", async () => {
    const dir = await temp();
    const write = (size: number) => writeFile(join(dir, "chromium-sandbox.json"), Buffer.alloc(size, 97));
    await write(49_152);
    expect((await readChromiumSandboxAttestation(dir))?.byteLength).toBe(49_152);
    expect(Math.ceil(49_152 / 3) * 4).toBeLessThanOrEqual(65_536);
    await write(49_153);
    expect(await readChromiumSandboxAttestation(dir)).toBeNull();
    expect(await readChromiumSandboxAttestation(join(dir, "absent"))).toBeNull();
  });
});
