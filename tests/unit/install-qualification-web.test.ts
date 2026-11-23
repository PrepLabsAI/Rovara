import { createHash } from "node:crypto";
import { stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2ERegisteredRuntimeSchema, SANDBOX_EGRESS_PROBE_IDS, WEB_API_AGENT_PROBE_IDS, WEB_API_REQUIRED_PROBES, WebApiRuntimeInstallProposalSchema, canonicalJson, e2eRuntimeCapabilityDigest, evaluateWebApiProbeObservation, webApiRuntimeRowProvesSandbox,
  webApiProbeAssetManifestPath, webApiProbeRunId, webApiProposalQualifiesAgent, type WebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { e2eWebApiRuntimeRecords, webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { WebApiQualificationRejected, assertRuntimeInstallationHostIdentity, qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { MODEL_SOCKET_PATH_MAX_BYTES, e2eModelSocketPath } from "../../packages/verifier/src/host/docker-application-host.js";
import { main as qualificationCli, webApiProbeRunnerConfig } from "../../packages/verifier/src/install-qualification-cli.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { fakeLinuxEnvironment, fakeProbeRunner, goodWebApiObservation, privateEvidenceRoot, webApiChallenge } from "../support/web-api-qualification.js";

const now = Date.parse("2026-10-19T12:00:00.000Z");
async function qualify(overrides: Parameters<typeof fakeProbeRunner>[0] = {}, extra: Partial<Parameters<typeof qualifyInstalledWebApiRuntime>[0]> = {}) {
  const runner = fakeProbeRunner(overrides);
  const evidenceRoot = await privateEvidenceRoot();
  const result = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(now), evidenceRoot, runProbe: runner.runProbe, environment: fakeLinuxEnvironment(now), ...extra });
  return { result, runner, evidenceRoot };
}
/** The agent facts the committed evidence of an agent probe shows; the cases below change one of them. */
function agentFacts(probeId: string) { return structuredClone(goodWebApiObservation(probeId).agent!); }
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("qualification unexpectedly succeeded"); }, (error: unknown) => error as Error);

describe("web/API runtime qualification", () => {

  it("binds every probe to its installed asset digest", async () => {
    const { result } = await qualify();
    const assets = new Map(loadWebApiQualificationProbeAssets().map((asset) => [asset.probeId, asset.assetDigest]));
    expect(result.probes.every((probe) => probe.assetDigest === assets.get(probe.probeId))).toBe(true);
    expect([...assets.keys()]).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId));
  });

  const negativeThatPassed: [string, Partial<WebApiProbeObservation>][] = [
    ["web-csv-negative-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [] }],
    ["web-egress-denial-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [], blockedHosts: [] }],
    ["api-egress-denial-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [] }],
    // An unmocked call must never be a pass: a run that PASSED did not show the unmocked-external-call outcome the probe pins.
    ["web-unmocked-call-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [], unmockedCalls: { sinkhole: 0, mocked: 0 } }],
    ["web-unmocked-call-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [], unmockedCalls: { sinkhole: 1, mocked: 0 } }],
    ["build-imds-denial-v1", { collectorStatus: "PASS" as const, runUnavailableReason: null, buildExitCode: null }],
    ["build-lateral-denial-v1", { collectorStatus: "PASS" as const, runUnavailableReason: null, buildExitCode: null }],
    // The wrong action must not be taken for the right one: a run that PASSED did not show agent-no-download, whatever else it shows.
    ["web-agent-wrong-action-v1", { collectorStatus: "PASS" as const }],
    ["web-agent-wrong-action-v1", { collectorStatus: "PASS" as const, agent: { ...agentFacts("web-agent-scripted-v1") } }],
  ];
  it.each(negativeThatPassed)("rejects a negative probe that passed: %s", async (probeId, observation) => {
    const error = await rejection(qualify({ [probeId]: observation }));
    expect(error).toBeInstanceOf(WebApiQualificationRejected);
    expect(error.message).toContain(`negative-probe-passed:${probeId}`);
  });
  // The qualifier reaches the oracle through the built contracts package; this goes to the oracle in src, so a stale build cannot hide a loosened oracle.
  it.each(negativeThatPassed)("the oracle in src rejects a negative probe that passed: %s", (probeId, observation) => {
    expect(evaluateWebApiProbeObservation(probeId, { ...goodWebApiObservation(probeId), ...observation })).toEqual({ ok: false, reason: `negative-probe-passed:${probeId}` });
  });

  const failedForAnotherCause: [string, Partial<WebApiProbeObservation>][] = [
    ["web-csv-negative-v1", { failedAssertionKinds: ["text"] }],
    ["web-csv-negative-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [] }],
    ["web-egress-denial-v1", { blockedHosts: ["fonts.example.com"] }],
    ["web-egress-denial-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [], blockedHosts: [] }],
    // The name must reach the sinkhole (UNKNOWN, one call) while the IP literal stays unreachable (the http-status assertion fails): a different mix is a different cause.
    ["api-egress-denial-v1", { failedAssertionKinds: ["json"] }],
    ["api-egress-denial-v1", { failedAssertionKinds: ["http-status", "json"] }],
    // The IP literal was reached: the assertion held, so the raw wall is missing even though the name was sinkholed.
    ["api-egress-denial-v1", { failedAssertionKinds: [] }],
    // The old outcome: the name never reached the sinkhole, so the app's resolver is not pointed at it.
    ["api-egress-denial-v1", { collectorStatus: "FAILED" as const, failedAssertionKinds: ["http-status"], unmockedCalls: { sinkhole: 0, mocked: 0 } }],
    ["api-egress-denial-v1", { unmockedCalls: { sinkhole: 0, mocked: 0 } }],
    ["api-egress-denial-v1", { unmockedCalls: { sinkhole: 2, mocked: 0 } }],
    ["api-egress-denial-v1", { unmockedCalls: { sinkhole: 1, mocked: 1 } }],
    ["api-egress-denial-v1", { mockConsumptions: { success: 1, refusal: 0, invalidData: 0 } }],
    ["api-egress-denial-v1", { runReason: "application-evidence-floor-unmet" }],
    ["api-egress-denial-v1", { runReason: undefined }],
    ["api-egress-denial-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [], unmockedCalls: { sinkhole: 1, mocked: 0 } }],
    // Any other cause rejects: a failed assertion, an unavailable run, no recorded call, a call to a mock rather than the sinkhole, or more than the one line.
    ["web-unmocked-call-v1", { collectorStatus: "FAILED" as const, failedAssertionKinds: ["text"] }],
    ["web-unmocked-call-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [], unmockedCalls: { sinkhole: 0, mocked: 0 } }],
    ["web-unmocked-call-v1", { unmockedCalls: { sinkhole: 0, mocked: 0 } }],
    ["web-unmocked-call-v1", { unmockedCalls: { sinkhole: 0, mocked: 1 } }],
    ["web-unmocked-call-v1", { unmockedCalls: { sinkhole: 2, mocked: 0 } }],
    ["web-unmocked-call-v1", { unmockedCalls: { sinkhole: 1, mocked: 1 } }],
    ["web-unmocked-call-v1", { mockConsumptions: { success: 1, refusal: 0, invalidData: 0 } }],
    // UNKNOWN for another cause that also made one sinkhole call is not the pinned outcome: a failed assertion, another reason, or no reason each reject.
    ["web-unmocked-call-v1", { failedAssertionKinds: ["text"] }],
    ["web-unmocked-call-v1", { runReason: "application-evidence-floor-unmet" }],
    ["web-unmocked-call-v1", { runReason: undefined }],
    // Task 4.5: the wrong-action probe is UNKNOWN for agent-no-download alone; any other cause, any extra receipt and any download rejects.
    ["web-agent-wrong-action-v1", { collectorStatus: "FAILED" as const, failedAssertionKinds: ["csv"], agent: { ...agentFacts("web-agent-wrong-action-v1"), caseReasons: [], downloads: 1 } }],
    ["web-agent-wrong-action-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [] }],
    ["web-agent-wrong-action-v1", { failedAssertionKinds: ["csv"] }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), caseReasons: ["ambiguous-download"] } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), caseReasons: ["model-unavailable"] } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), caseReasons: ["agent-no-download", "model-unavailable"] } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), caseReasons: [] } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), receipts: 2, okReceipts: 2 } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), receipts: 2 } }],
    ["web-agent-wrong-action-v1", { collectorStatus: "FAILED" as const }],
    ["web-agent-wrong-action-v1", { collectorStatus: null }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), downloads: 1 } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), routeId: null } }],
    ["web-agent-wrong-action-v1", { agent: { ...agentFacts("web-agent-wrong-action-v1"), unmockedCalls: { sinkhole: 1, mocked: 0 } } }],
    ["web-agent-wrong-action-v1", { agent: undefined }],
    ["build-imds-denial-v1", { buildExitCode: 1 }],
    ["build-imds-denial-v1", { runUnavailableReason: "app-exited" }],
    // A build that ends in 0 or 3 did not fail because the host was unreachable: only the probe's own exit 7 counts.
    ["build-lateral-denial-v1", { buildExitCode: 0 }],
    ["build-lateral-denial-v1", { buildExitCode: 3 }],
    ["build-lateral-denial-v1", { runUnavailableReason: "app-exited" }],
  ];
  it.each(failedForAnotherCause)("rejects an expected failure that failed for another cause: %s %j", async (probeId, observation) => {
    const error = await rejection(qualify({ [probeId]: observation }));
    expect(error.message).toContain(`probe-wrong-cause:${probeId}`);
  });
  it.each(failedForAnotherCause)("the oracle in src rejects an expected failure that failed for another cause: %s %j", (probeId, observation) => {
    expect(evaluateWebApiProbeObservation(probeId, { ...goodWebApiObservation(probeId), ...observation })).toEqual({ ok: false, reason: `probe-wrong-cause:${probeId}` });
  });

  it.each(["web-csv-positive-v1", "api-state-positive-v1", "app-host-denial-v1", "chromium-sandbox-v1", "web-mock-origin-v1", "web-agent-scripted-v1", "web-agent-app-isolation-v1"])("rejects a positive probe the collector did not pass: %s", async (probeId) => {
    for (const observation of [{ collectorStatus: "FAILED" as const, failedAssertionKinds: ["csv"] }, { collectorStatus: "UNKNOWN" as const },
      { collectorStatus: null, runUnavailableReason: "build-failed" }]) {
      expect((await rejection(qualify({ [probeId]: observation }))).message).toContain(`positive-probe-failed:${probeId}`);
    }
  });

  // The agent probes that must PASS pass only with the exact AI navigation the script leads to: the scripted route, two ok receipts that are the report's, one download, no case reason.
  const agentDeviations: [string, (facts: NonNullable<WebApiProbeObservation["agent"]>) => Partial<NonNullable<WebApiProbeObservation["agent"]>>][] = [
    ["another route", () => ({ routeId: "rovara-e2e-default" })], ["no route", () => ({ routeId: null })],
    ["an extra receipt", (f) => ({ receipts: f.receipts + 1, okReceipts: f.okReceipts + 1, verifiedReceipts: f.verifiedReceipts + 1 })],
    ["an extra receipt that is not ok", (f) => ({ receipts: f.receipts + 1 })],
    ["a receipt that is not ok", (f) => ({ okReceipts: f.okReceipts - 1 })], ["a receipt the report does not account for", (f) => ({ verifiedReceipts: f.verifiedReceipts - 1 })],
    ["no download", () => ({ downloads: 0 })], ["two downloads", () => ({ downloads: 2 })], ["a case reason", () => ({ caseReasons: ["agent-no-download"] })],
    ["a call to the sinkhole", () => ({ unmockedCalls: { sinkhole: 1, mocked: 0 } })],
  ];
  it.each(["web-agent-scripted-v1", "web-agent-app-isolation-v1"])("rejects %s when the AI navigation was not exactly the scripted one", async (probeId) => {
    for (const [label, change] of agentDeviations) {
      const good = agentFacts(probeId);
      expect((await rejection(qualify({ [probeId]: { agent: { ...good, ...change(good) } } }))).message, label).toContain(`positive-probe-failed:${probeId}`);
    }
    expect((await rejection(qualify({ [probeId]: { agent: undefined } }))).message).toContain(`positive-probe-failed:${probeId}`);
  });

  it.each(["web-agent-scripted-v1", "web-agent-wrong-action-v1", "web-agent-app-isolation-v1"])("fails closed when %s could not run (no model channel, no executor): no proposal, the other probes still judged", async (probeId) => {
    const error = await rejection(qualify({ [probeId]: new Error("no model channel to run the probe"), "web-csv-negative-v1": { collectorStatus: "PASS", failedAssertionKinds: [] } }));
    expect((error as WebApiQualificationRejected).reasons).toEqual(["negative-probe-passed:web-csv-negative-v1", `probe-run-failed:${probeId}`]);
  });

  it.each([
    ["no consumption at all", { mockConsumptions: { success: 0, refusal: 0, invalidData: 0 } }],
    ["two success consumptions", { mockConsumptions: { success: 2, refusal: 0, invalidData: 0 } }],
    ["a refusal beside the success", { mockConsumptions: { success: 1, refusal: 1, invalidData: 0 } }],
    ["an invalid-data variant instead of the success", { mockConsumptions: { success: 0, refusal: 0, invalidData: 1 } }],
    ["a call to the sinkhole", { unmockedCalls: { sinkhole: 1, mocked: 0 } }],
    ["a call no mock matched", { unmockedCalls: { sinkhole: 0, mocked: 1 } }],
    ["no consumption facts", { mockConsumptions: undefined }],
    ["no unmocked-call facts", { unmockedCalls: undefined }],
  ])("rejects the mock origin probe that passed with %s: exactly one success consumption and no unmocked call", async (_label, observation) => {
    expect((await rejection(qualify({ "web-mock-origin-v1": observation }))).message).toContain("positive-probe-failed:web-mock-origin-v1");
  });

  it.each([
    ["skipped", { skipped: 1 }, "probe-skipped"],
    ["flaky", { flaky: 1 }, "probe-flaky"],
    ["retried", { attempts: 2 }, "probe-retried"],
  ])("rejects any probe that is %s, even when it reached its expected outcome", async (_label, observation, reason) => {
    for (const required of WEB_API_REQUIRED_PROBES) {
      expect((await rejection(qualify({ [required.probeId]: observation }))).message).toContain(`${reason}:${required.probeId}`);
    }
  });

  it("refuses a challenge for another profile, another host, or another toolchain before running any probe", async () => {
    const runner = fakeProbeRunner();
    const evidenceRoot = await privateEvidenceRoot();
    const base = { evidenceRoot, runProbe: runner.runProbe };
    await expect(qualifyInstalledWebApiRuntime({ ...base, challenge: webApiChallenge(now, { profileId: "linux-arm64-docker-v1" }), environment: fakeLinuxEnvironment(now) })).rejects.toThrow(/not the web\/API runtime profile/);
    await expect(qualifyInstalledWebApiRuntime({ ...base, challenge: webApiChallenge(now), environment: fakeLinuxEnvironment(now, { platform: "darwin" }) })).rejects.toThrow(/does not match this actual host/);
    await expect(qualifyInstalledWebApiRuntime({ ...base, challenge: webApiChallenge(now), environment: fakeLinuxEnvironment(now, { arch: "x64" }) })).rejects.toThrow(/does not match this actual host/);
    await expect(qualifyInstalledWebApiRuntime({ ...base, challenge: webApiChallenge(now), environment: fakeLinuxEnvironment(now, { nodeVersion: "v22.23.1" }) })).rejects.toThrow(/Node v22.23.2/);
    await expect(qualifyInstalledWebApiRuntime({ ...base, challenge: webApiChallenge(now), environment: fakeLinuxEnvironment(now, { assertHostIdentity: () => { throw new Error("wrong worker identity"); } }) })).rejects.toThrow(/wrong worker identity/);
    expect(runner.calls).toEqual([]);
  });

  describe("the real host check, which the installed qualifier uses unless a test replaces it", () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    // A private address the challenge schema accepts and no test host has.
    const foreignEndpoint = webApiChallenge(now, { endpoint: "http://10.255.255.254:8080" });
    const bootEnvironment = (challenge: ReturnType<typeof webApiChallenge>) => ({ AGENTX_WORKSPACE_ID: challenge.transportCorrelationId, AGENTX_SESSION_GENERATION: String(challenge.generation) });
    const realHostCheck = () => { const { assertHostIdentity: _replaced, ...real } = fakeLinuxEnvironment(now); void _replaced; return real; };

    it("refuses a web/API challenge whose endpoint is not an address of this host, on the worker port, before any probe runs", async () => {
      expect(() => assertRuntimeInstallationHostIdentity(foreignEndpoint.profileId, foreignEndpoint, bootEnvironment(foreignEndpoint))).toThrow(/endpoint does not match a non-loopback address and listener port on this host/);
      for (const [name, value] of Object.entries(bootEnvironment(foreignEndpoint))) vi.stubEnv(name, value);
      const runner = fakeProbeRunner();
      await expect(qualifyInstalledWebApiRuntime({ challenge: foreignEndpoint, evidenceRoot: await privateEvidenceRoot(), runProbe: runner.runProbe, environment: realHostCheck() }))
        .rejects.toThrow(/endpoint does not match a non-loopback address and listener port on this host/);
      expect(runner.calls).toEqual([]);
    });

    it("refuses another worker's workspace identity before it looks at the endpoint", () => {
      expect(() => assertRuntimeInstallationHostIdentity(foreignEndpoint.profileId, foreignEndpoint, { AGENTX_WORKSPACE_ID: "other", AGENTX_SESSION_GENERATION: "3" })).toThrow(/boot-injected workspace identity/);
    });
  });

  it("requires a private evidence root", async () => {
    const open = await mkdtemp(join(tmpdir(), "web-api-open-"));
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(open, 0o755);
      await expect(qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(now), evidenceRoot: open, runProbe: fakeProbeRunner().runProbe, environment: fakeLinuxEnvironment(now) }))
        .rejects.toThrow(/private owned directory/);
    } finally { await rm(open, { recursive: true, force: true }); }
  });
});

describe("web/API qualification oracle and proposal", () => {
  it("is deterministic over the observation alone", () => {
    for (const required of WEB_API_REQUIRED_PROBES) expect(evaluateWebApiProbeObservation(required.probeId, goodWebApiObservation(required.probeId))).toEqual({ ok: true });
    expect(evaluateWebApiProbeObservation("web-auth-viewer-refusal-v1", goodWebApiObservation("web-csv-positive-v1"))).toEqual({ ok: false, reason: "unknown-probe:web-auth-viewer-refusal-v1" });
  });

  it("cannot be made READY by editing the label: the schema re-judges the recorded evidence", async () => {
    const { result } = await qualify();
    const forged = structuredClone(result);
    forged.probes[1]!.observation = { ...forged.probes[1]!.observation, collectorStatus: "PASS", failedAssertionKinds: [] };
    const parsed = WebApiRuntimeInstallProposalSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("negative-probe-passed:web-csv-negative-v1");
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, state: "PARKED" }).success).toBe(false);
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, probes: result.probes.slice(0, 5) }).success).toBe(false);
    // Neither is a record that holds some of the agent probes: it has the eleven base probes or all of them.
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, probes: result.probes.slice(0, 12) }).success).toBe(false);
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, probes: result.probes.slice(0, 13) }).success).toBe(false);
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, probes: [...result.probes].reverse() }).success).toBe(false);
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, runnerToolchain: { ...result.runnerToolchain, arch: "x64" } }).success).toBe(false);
  });
});

describe("the agent capability of the registered runtime (Task 4.5)", () => {
  const evidence = { key: "runtime-evidence/qualification.json", sha256: "e".repeat(64), byteLength: 100 };
  const rowsOf = (proposal: Awaited<ReturnType<typeof qualify>>["result"]) => e2eWebApiRuntimeRecords({ proposal, revisions: { web: 4, api: 5 }, qualifiedAt: new Date(now).toISOString(), evidence });
  /** A qualification as M1.3 and M1.4 up to Task 4.4 recorded it: the eleven base probes and nothing else. */
  const preAgent = (proposal: Awaited<ReturnType<typeof qualify>>["result"]) => ({ ...proposal, probes: proposal.probes.slice(0, 11) });

  it("lists agent and the model channel on the web row, and on no api row, for a qualification that holds all three agent probes", async () => {
    const { result } = await qualify();
    expect(webApiProposalQualifiesAgent(result)).toBe(true);
    const rows = rowsOf(result);
    expect(rows.web.capabilities).toMatchObject({ kind: "web", supportedSteps: ["navigate", "fill", "click", "choose-file", "agent"], modelChannel: "rovara-e2e-model-channel/v1" });
    expect(rows.api.capabilities.supportedSteps).toEqual(["request"]);
    expect(Object.keys(rows.api.capabilities)).not.toContain("modelChannel");
    expect(rows.web.capabilityDigest).toBe(e2eRuntimeCapabilityDigest(webApiRuntimeCapabilities("web", result.manifest.sha256, { agent: true })));
    // The web row's probe manifest names the three agent probes; the api row's does not.
    expect(rows.web.probeManifest.positiveProbeIds).toEqual(expect.arrayContaining(["web-agent-scripted-v1", "web-agent-app-isolation-v1"]));
    expect(rows.web.probeManifest.negativeProbeIds).toContain("web-agent-wrong-action-v1");
    expect([...rows.api.probeManifest.positiveProbeIds, ...rows.api.probeManifest.negativeProbeIds].filter((id) => id.startsWith("web-agent-"))).toEqual([]);
    expect(E2ERegisteredRuntimeSchema.safeParse(rows.web).success).toBe(true);
  });

  it("lists every egress probe on BOTH rows, so each row proves the sandbox on its own, and a qualification without the private-network probe proves it on neither", async () => {
    const { result } = await qualify();
    const rows = rowsOf(result);
    for (const kind of ["web", "api"] as const) {
      const listed = [...rows[kind].probeManifest.positiveProbeIds, ...rows[kind].probeManifest.negativeProbeIds];
      for (const probeId of SANDBOX_EGRESS_PROBE_IDS) expect(listed, `${kind} lists ${probeId}`).toContain(probeId);
      expect(webApiRuntimeRowProvesSandbox(rows[kind]), kind).toBe(true);
      expect(E2ERegisteredRuntimeSchema.safeParse(rows[kind]).success).toBe(true);
    }
    const before = rowsOf({ ...result, probes: result.probes.slice(0, 14) });
    for (const kind of ["web", "api"] as const) {
      expect([...before[kind].probeManifest.positiveProbeIds, ...before[kind].probeManifest.negativeProbeIds], kind).not.toContain("app-private-denial-v1");
      expect(webApiRuntimeRowProvesSandbox(before[kind]), kind).toBe(false);
    }
  });

  it("still parses a record from before the agent probes (eleven probes, no agent) and yields rows without agent, with the capability digests they always had", async () => {
    const { result } = await qualify();
    const legacy = preAgent(result);
    expect(legacy.probes.map((probe) => probe.probeId)).toEqual(WEB_API_REQUIRED_PROBES.slice(0, 11).map((probe) => probe.probeId));
    const parsed = WebApiRuntimeInstallProposalSchema.parse(JSON.parse(canonicalJson(legacy)));
    expect(webApiProposalQualifiesAgent(parsed)).toBe(false);
    const rows = rowsOf(parsed);
    for (const kind of ["web", "api"] as const) {
      expect(rows[kind].capabilities.supportedSteps).not.toContain("agent");
      expect(Object.keys(rows[kind].capabilities)).not.toContain("modelChannel");
      expect(rows[kind].capabilityDigest).toBe(e2eRuntimeCapabilityDigest(webApiRuntimeCapabilities(kind, result.manifest.sha256)));
      expect(E2ERegisteredRuntimeSchema.safeParse(rows[kind]).success).toBe(true);
    }
    expect(rows.web.probeManifest.fixtureRefs.map((ref) => ref.path).filter((path) => path.includes("web-agent-"))).toEqual([]);
  });

  it.each(["web-agent-scripted-v1", "web-agent-wrong-action-v1", "web-agent-app-isolation-v1"])("does not parse a record whose %s observation was edited to the wrong outcome, so agent cannot be listed on a forged claim", async (probeId) => {
    const { result } = await qualify();
    const forged = structuredClone(result);
    const probe = forged.probes[WEB_API_REQUIRED_PROBES.findIndex((item) => item.probeId === probeId)]!;
    probe.observation = probeId === "web-agent-wrong-action-v1" ? { ...probe.observation, collectorStatus: "PASS", agent: { ...probe.observation.agent!, caseReasons: [], verifiedReceipts: 1, downloads: 1 } }
      : { ...probe.observation, agent: { ...probe.observation.agent!, downloads: 0 } };
    const parsed = WebApiRuntimeInstallProposalSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(new RegExp(`(negative-probe-passed|positive-probe-failed):${probeId}`));
  });
});

describe("pinned web/API probe assets", () => {

  it("does not qualify when an installed probe asset is not the pinned one, and never runs that probe", async () => {
    const runner = fakeProbeRunner();
    const base = fakeLinuxEnvironment(now);
    const tampered = async () => {
      const manifest = await base.observeManifest!();
      const entries = manifest.entries.map((entry) => entry.path === webApiProbeAssetManifestPath("build-imds-denial-v1")
        ? { ...entry, sha256: createHash("sha256").update("process.exit(7)").digest("hex") } : entry);
      return { ...manifest, entries };
    };
    const error = await rejection(qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(now), evidenceRoot: await privateEvidenceRoot(),
      runProbe: runner.runProbe, environment: { ...base, observeManifest: tampered } }));
    expect((error as WebApiQualificationRejected).reasons).toEqual(["probe-asset-not-installed-as-pinned:build-imds-denial-v1"]);
    expect(runner.calls).not.toContain("build-imds-denial-v1");
  });

  it("does not parse a proposal whose probe digest or installed manifest names another asset, however it is re-sealed", async () => {
    const { result } = await qualify();
    const other = "e".repeat(64);
    const digestChanged = structuredClone(result);
    digestChanged.probes[WEB_API_REQUIRED_PROBES.findIndex((probe) => probe.probeId === "build-imds-denial-v1")]!.assetDigest = other;
    expect(JSON.stringify(WebApiRuntimeInstallProposalSchema.safeParse(digestChanged).error?.issues)).toContain("probe-asset-digest-mismatch:build-imds-denial-v1");
    const entries = result.manifest.entries.map((entry) => entry.path === webApiProbeAssetManifestPath("build-imds-denial-v1") ? { ...entry, sha256: other } : entry);
    const body = { schemaVersion: result.manifest.schemaVersion, entries };
    const resealed = { ...result, manifest: { ...body, sha256: createHash("sha256").update(canonicalJson(body)).digest("hex") } };
    expect(JSON.stringify(WebApiRuntimeInstallProposalSchema.safeParse(resealed).error?.issues)).toContain("probe-asset-not-installed-as-pinned:build-imds-denial-v1");
    const missing = result.manifest.entries.filter((entry) => entry.path !== webApiProbeAssetManifestPath("web-csv-positive-v1"));
    const dropped = { schemaVersion: result.manifest.schemaVersion, entries: missing };
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, manifest: { ...dropped, sha256: createHash("sha256").update(canonicalJson(dropped)).digest("hex") } }).success).toBe(false);
  });
});

describe("install qualification CLI", () => {
  async function challengeFile(profileId: string) {
    const dir = await mkdtemp(join(tmpdir(), "web-api-cli-"));
    const challenge = webApiChallenge(Date.now(), { profileId: profileId as never });
    await writeFile(join(dir, "challenge.json"), JSON.stringify(challenge));
    return { dir, args: ["--challenge-file", join(dir, "challenge.json"), "--evidence-root", dir, "--out", join(dir, "proposal.json")] };
  }

  it("fails closed with --profile linux-arm64-web-api-v1 when the worker has no executor image configured", async () => {
    const { dir, args } = await challengeFile("linux-arm64-web-api-v1");
    try {
      for (const environment of [{}, { EXECUTOR_IMAGE: "" }, { EXECUTOR_IMAGE: "  " }, { EXECUTOR_IMAGE: "--privileged" }, { EXECUTOR_IMAGE: "two words" }]) {
        await expect(qualificationCli([...args, "--profile", "linux-arm64-web-api-v1"], { environment })).rejects.toThrow(/EXECUTOR_IMAGE/);
      }
      await expect(stat(join(dir, "proposal.json"))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("takes the executor image from EXECUTOR_IMAGE, the build image from the pin, and the run root from the worker's runtime directory", () => {
    const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-e2e-executor@sha256:${"d".repeat(64)}`;
    expect(webApiProbeRunnerConfig({ EXECUTOR_IMAGE: image }, "linux", "arm64")).toEqual({ executorImage: image, buildImage: WEB_API_BUILD_IMAGE, runRoot: "/mnt/agentx-runtime/candidates/web-api-probes" });
    expect(WEB_API_BUILD_IMAGE).toBe("public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5");
    expect(() => webApiProbeRunnerConfig({ EXECUTOR_IMAGE: image }, "win32", "x64")).toThrow(/runtime directory/);
    // L4-NETG2: a gateway-mode worker's qualification builds (trusted fixtures) keep their bridge and take the host resolvers as --dns (read from the worker container's resolv.conf: tests/unit/e2e-model-check.test.ts); any other worker has none.
    const gateway = { EXECUTOR_IMAGE: image, AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" };
    const resolvers = () => "nameserver 127.0.0.53\nnameserver 10.42.0.2\n";
    expect(webApiProbeRunnerConfig(gateway, "linux", "arm64", resolvers).buildDns).toEqual(["10.42.0.2"]);
    expect(webApiProbeRunnerConfig({ ...gateway, AGENTX_SANDBOX_EGRESS: "" }, "linux", "arm64", resolvers)).not.toHaveProperty("buildDns");
  });

  it("leaves the agent probes' model socket under the worker's run root a path a unix socket can bind (103 bytes)", () => {
    const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-e2e-executor@sha256:${"d".repeat(64)}`;
    const { runRoot } = webApiProbeRunnerConfig({ EXECUTOR_IMAGE: image }, "linux", "arm64");
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      const socket = e2eModelSocketPath(runRoot, webApiProbeRunId(webApiChallenge(now), probeId));
      expect(Buffer.byteLength(socket), socket).toBeLessThanOrEqual(MODEL_SOCKET_PATH_MAX_BYTES);
    }
  });

  it("builds the production runner from the challenge and evidence root before qualifying, and writes no proposal when qualification stops", async () => {
    const { dir, args } = await challengeFile("linux-arm64-web-api-v1");
    try {
      const seen: unknown[] = [];
      await expect(qualificationCli([...args, "--profile", "linux-arm64-web-api-v1"], { environment: { EXECUTOR_IMAGE: "executor:test" }, host: { platform: "linux", arch: "arm64" },
        createProbeRunner: (config) => { seen.push(config); return async () => { throw new Error("stop here"); }; } })).rejects.toThrow(/actual host|exact installed Node|boot-injected workspace identity/);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ executorImage: "executor:test", buildImage: WEB_API_BUILD_IMAGE, evidenceRoot: dir });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a profile that is not the challenge's, and an unknown profile", async () => {
    const { dir, args } = await challengeFile("linux-arm64-docker-v1");
    try {
      await expect(qualificationCli([...args, "--profile", "linux-arm64-web-api-v1"])).rejects.toThrow(/challenge is for profile linux-arm64-docker-v1/);
      await expect(qualificationCli([...args, "--profile", "darwin-arm64-colima-v1"])).rejects.toThrow(/unsupported runtime qualification profile/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("without --profile still runs the standard P0 qualification, which refuses a web/API challenge", async () => {
    const { dir, args } = await challengeFile("linux-arm64-web-api-v1");
    try {
      await expect(qualificationCli(args)).rejects.toThrow(/challenge profile does not match this actual host/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
