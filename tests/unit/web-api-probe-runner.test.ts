import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_ROUTE, WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, WebApiProbeObservationSchema, webApiProbeRunId } from "../../packages/contracts/src/index.js";
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
/** The live private targets the private-network probe is handed: a VPC resolver and the host's own address, both private. */
const LIVE = { resolver: "10.42.0.2", host: "10.42.1.15" };

async function setup(overrides: Partial<Parameters<typeof createWebApiProbeRunner>[0]> = {}, options: { withoutChannel?: boolean } = {}) {
  const fake = new FakeDockerCli();
  const runRoot = await temp(); const evidenceRoot = await temp();
  const channelRequests: WebApiProbeModelChannelRequest[] = [];
  // The model channel of an agent probe, as the qualifier supplies it: this stand-in only records what it was asked for (the worker's real one is exercised with a real executor in web-api-probe-runner-local.test.ts).
  const modelChannelFor = (request: WebApiProbeModelChannelRequest) => { channelRequests.push(request); return { open: async () => { throw new Error("not opened in this test"); } }; };
  const runner = createWebApiProbeRunner({ docker: fake, executorImage: "rovara-executor:test", buildImage: "node:build-test", runRoot, evidenceRoot, challenge, liveTargets: LIVE, ...(options.withoutChannel === true ? {} : { modelChannelFor }), ...overrides });
  return { fake, runRoot, evidenceRoot, runner, channelRequests };
}

describe("the production web/API probe runner", () => {
  it("L4-NETG2: on a gateway-mode worker the probe's (trusted fixture) build commands keep their own build bridge and are given the host resolvers as --dns", async () => {
    const { fake, runner } = await setup({ buildDns: ["10.42.0.2", "169.254.169.253"] });
    fake.failOn("build", 7);
    const run = await runner("build-imds-denial-v1");
    expect(run.observation).toMatchObject({ runUnavailableReason: "build-failed", buildExitCode: 7 });
    const builds = fake.calls.filter((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("rovara-build-") && !args[args.indexOf("--name") + 1]!.endsWith("-0"));
    expect(builds.length).toBeGreaterThan(0);
    for (const args of builds) {
      expect(args[args.indexOf("--network") + 1]).toMatch(/^rovara-e2e-build-/u);
      expect(args.filter((value, at) => args[at - 1] === "--dns")).toEqual(["10.42.0.2", "169.254.169.253"]);
    }
  });

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

  it("the private-network probe is handed its two live targets, which the evidence records; the run networks are IPv4 only; and no other probe is handed them", async () => {
    const { fake, runner } = await setup();
    const runId = webApiProbeRunId(challenge, "app-private-denial-v1");
    fake.exitCodeOfExecutor(2);
    fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "app-unhealthy", runId, groupId: "unused" });
    await runner("app-private-denial-v1");
    const app = fake.calls.find((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-app-"))!;
    const env = app.filter((value, at) => app[at - 1] === "-e");
    expect(env).toContain("ROVARA_PROBE_LIVE_RESOLVER=10.42.0.2");
    expect(env).toContain("ROVARA_PROBE_LIVE_HOST=10.42.1.15");
    // IPv4 only: both run networks are created without IPv6, and the app and the executor have no IPv6 stack.
    for (const create of fake.calls.filter((args) => args[0] === "network" && args[1] === "create")) expect(create).toContain("--ipv6=false");
    const sysctl = (args: string[]) => args.filter((value, at) => args[at - 1] === "--sysctl");
    expect(sysctl(app)).toContain("net.ipv6.conf.all.disable_ipv6=1");
    const executor = fake.calls.find((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-executor-"));
    if (executor !== undefined) expect(sysctl(executor)).toContain("net.ipv6.conf.all.disable_ipv6=1");
    const other = await setup();
    other.fake.exitCodeOfExecutor(2);
    other.fake.onExecutor = (outDir) => writeExecutorOutput(outDir, { exitCode: 2, reason: "app-unhealthy", runId: webApiProbeRunId(challenge, "app-host-denial-v1"), groupId: "unused" });
    await other.runner("app-host-denial-v1");
    const hostApp = other.fake.calls.find((args) => args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1]!.startsWith("rovara-app-"))!;
    expect(hostApp.join(" ")).not.toContain("ROVARA_PROBE_LIVE");
  });

  it("does not run the private-network probe without valid live targets: nothing is staged, nothing is started, the attempt fails closed", async () => {
    for (const liveTargets of [undefined, { resolver: "1.1.1.1", host: "10.42.1.15" }, { resolver: "10.42.0.2", host: "169.254.169.254" }, { resolver: "10.42.0.2", host: "127.0.0.1" }, { resolver: "10.42.0.2" }, { resolver: "10.42.0.2", host: "10.42.1.15 " }]) {
      const { fake, runRoot, runner } = await setup({ liveTargets: liveTargets as never });
      await expect(runner("app-private-denial-v1")).rejects.toThrow("probe-live-targets-missing");
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
