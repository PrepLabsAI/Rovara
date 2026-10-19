import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, WebApiRuntimeInstallProposalSchema, canonicalJson, evaluateWebApiProbeObservation, webApiProbeAssetManifestPath } from "../../packages/contracts/src/index.js";
import { WebApiQualificationRejected, qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { main as qualificationCli } from "../../packages/verifier/src/install-qualification-cli.js";
import { loadWebApiQualificationProbeAssets } from "../../packages/verifier/src/application-runtime-probes.js";
import { fakeLinuxEnvironment, fakeProbeRunner, goodWebApiObservations, privateEvidenceRoot, webApiChallenge } from "../support/web-api-qualification.js";

const now = Date.parse("2026-10-19T12:00:00.000Z");
async function qualify(overrides: Parameters<typeof fakeProbeRunner>[0] = {}, extra: Partial<Parameters<typeof qualifyInstalledWebApiRuntime>[0]> = {}) {
  const runner = fakeProbeRunner(overrides);
  const evidenceRoot = await privateEvidenceRoot();
  const result = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(now), evidenceRoot, runProbe: runner.runProbe, environment: fakeLinuxEnvironment(now), ...extra });
  return { result, runner, evidenceRoot };
}
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("qualification unexpectedly succeeded"); }, (error: unknown) => error as Error);

describe("web/API runtime qualification", () => {
  it("runs the six required probes in order and qualifies a runtime whose outcomes are all as expected", async () => {
    const { result, runner } = await qualify();
    expect(runner.calls).toEqual(["web-csv-positive-v1", "web-csv-negative-v1", "web-egress-denial-v1", "api-state-positive-v1", "api-egress-denial-v1", "build-imds-denial-v1"]);
    expect(result.state).toBe("READY");
    expect(result.profileId).toBe("linux-arm64-web-api-v1");
    expect(result.scope).toBe("application-web-api/v1");
    expect(result.probes.map((probe) => [probe.probeId, probe.observedOutcome])).toEqual([
      ["web-csv-positive-v1", "PASS"], ["web-csv-negative-v1", "EXPECTED_FAILURE"], ["web-egress-denial-v1", "EXPECTED_FAILURE"],
      ["api-state-positive-v1", "PASS"], ["api-egress-denial-v1", "EXPECTED_FAILURE"], ["build-imds-denial-v1", "EXPECTED_FAILURE"]]);
    expect(WebApiRuntimeInstallProposalSchema.parse(JSON.parse(canonicalJson(result)))).toEqual(result);
  });

  it("retains each probe's observation as private evidence", async () => {
    const { evidenceRoot } = await qualify();
    const [directory] = await readdir(evidenceRoot);
    const files = await readdir(join(evidenceRoot, directory!));
    expect(files.sort()).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => `${probe.probeId}.json`).sort());
    expect((await stat(join(evidenceRoot, directory!, files[0]!))).mode & 0o777).toBe(0o600);
    expect((JSON.parse(await readFile(join(evidenceRoot, directory!, "web-csv-negative-v1.json"), "utf8")) as { failedAssertionKinds: string[] }).failedAssertionKinds).toEqual(["csv"]);
  });

  it("binds every probe to its installed asset digest", async () => {
    const { result } = await qualify();
    const assets = new Map(loadWebApiQualificationProbeAssets().map((asset) => [asset.probeId, asset.assetDigest]));
    expect(result.probes.every((probe) => probe.assetDigest === assets.get(probe.probeId))).toBe(true);
    expect([...assets.keys()]).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId));
  });

  it.each([
    ["web-csv-negative-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [] }],
    ["web-egress-denial-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [], blockedHosts: [] }],
    ["api-egress-denial-v1", { collectorStatus: "PASS" as const, failedAssertionKinds: [] }],
    ["build-imds-denial-v1", { collectorStatus: "PASS" as const, runUnavailableReason: null, buildExitCode: null }],
  ])("rejects a negative probe that passed: %s", async (probeId, observation) => {
    const error = await rejection(qualify({ [probeId]: observation }));
    expect(error).toBeInstanceOf(WebApiQualificationRejected);
    expect(error.message).toContain(`negative-probe-passed:${probeId}`);
  });

  it.each([
    ["web-csv-negative-v1", { failedAssertionKinds: ["text"] }],
    ["web-csv-negative-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [] }],
    ["web-egress-denial-v1", { blockedHosts: ["fonts.example.com"] }],
    ["web-egress-denial-v1", { collectorStatus: null, runUnavailableReason: "app-exited", failedAssertionKinds: [], blockedHosts: [] }],
    ["api-egress-denial-v1", { failedAssertionKinds: ["json"] }],
    ["api-egress-denial-v1", { collectorStatus: "UNKNOWN" as const, failedAssertionKinds: [] }],
    ["build-imds-denial-v1", { buildExitCode: 1 }],
    ["build-imds-denial-v1", { runUnavailableReason: "app-exited" }],
  ])("rejects an expected failure that failed for another cause: %s %j", async (probeId, observation) => {
    const error = await rejection(qualify({ [probeId]: observation }));
    expect(error.message).toContain(`probe-wrong-cause:${probeId}`);
  });

  it.each(["web-csv-positive-v1", "api-state-positive-v1"])("rejects a positive probe the collector did not pass: %s", async (probeId) => {
    for (const observation of [{ collectorStatus: "FAILED" as const, failedAssertionKinds: ["csv"] }, { collectorStatus: "UNKNOWN" as const },
      { collectorStatus: null, runUnavailableReason: "build-failed" }]) {
      expect((await rejection(qualify({ [probeId]: observation }))).message).toContain(`positive-probe-failed:${probeId}`);
    }
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

  it("rejects a probe whose run threw, and still judges every other probe", async () => {
    const error = await rejection(qualify({ "web-csv-positive-v1": new Error("docker unavailable"), "web-csv-negative-v1": { collectorStatus: "PASS", failedAssertionKinds: [] } }));
    expect((error as WebApiQualificationRejected).reasons).toEqual(["probe-run-failed:web-csv-positive-v1", "negative-probe-passed:web-csv-negative-v1"]);
  });

  it("rejects a malformed observation instead of trusting it", async () => {
    expect((await rejection(qualify({ "web-csv-positive-v1": { collectorStatus: "PASSED" as never } }))).message).toContain("probe-run-failed:web-csv-positive-v1");
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
    for (const required of WEB_API_REQUIRED_PROBES) expect(evaluateWebApiProbeObservation(required.probeId, goodWebApiObservations[required.probeId])).toEqual({ ok: true });
    expect(evaluateWebApiProbeObservation("web-auth-viewer-refusal-v1", goodWebApiObservations["web-csv-positive-v1"])).toEqual({ ok: false, reason: "unknown-probe:web-auth-viewer-refusal-v1" });
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
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, probes: [...result.probes].reverse() }).success).toBe(false);
    expect(WebApiRuntimeInstallProposalSchema.safeParse({ ...result, runnerToolchain: { ...result.runnerToolchain, arch: "x64" } }).success).toBe(false);
  });
});

describe("pinned web/API probe assets", () => {
  it("keeps the pinned digests equal to the shipped asset bytes", () => {
    expect(loadWebApiQualificationProbeAssets().map((asset) => [asset.probeId, asset.assetDigest]))
      .toEqual(WEB_API_REQUIRED_PROBES.map((probe) => [probe.probeId, probe.assetDigest]));
  });

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
    digestChanged.probes[5]!.assetDigest = other;
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

describe("web/API probe assets", () => {
  it("defines the IMDS denial probe as the pinned fetch with a short timeout and expects exit 7", () => {
    const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === "build-imds-denial-v1")!;
    expect(asset.probe.oracle).toEqual({ kind: "build-command-failure", expectedExitCode: 7, expectedUnavailableReason: "build-failed",
      build: { program: "node", args: ["-e", "fetch('http://169.254.169.254/latest/meta-data/').then(()=>process.exit(0),()=>process.exit(7))"], cwd: ".", timeoutMs: 30000, env: {} } });
    expect(asset.polarity).toBe("negative");
  });

  it("loads only the six M1.1 probes, not the later auth and tenant probes", () => {
    expect(loadWebApiQualificationProbeAssets().map((asset) => asset.probeId)).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId));
  });
});

describe("install qualification CLI", () => {
  async function challengeFile(profileId: string) {
    const dir = await mkdtemp(join(tmpdir(), "web-api-cli-"));
    const challenge = webApiChallenge(Date.now(), { profileId: profileId as never });
    await writeFile(join(dir, "challenge.json"), JSON.stringify(challenge));
    return { dir, args: ["--challenge-file", join(dir, "challenge.json"), "--evidence-root", dir, "--out", join(dir, "proposal.json")] };
  }

  it("fails closed with --profile linux-arm64-web-api-v1 when no probe runner is installed", async () => {
    const { dir, args } = await challengeFile("linux-arm64-web-api-v1");
    try {
      await expect(qualificationCli([...args, "--profile", "linux-arm64-web-api-v1"])).rejects.toThrow(/probe runner is not installed/);
      await expect(stat(join(dir, "proposal.json"))).rejects.toThrow();
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
