import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WEB_API_PROBE_PROPOSAL_MAX_BYTES, WEB_API_REQUIRED_PROBES, WebApiRuntimeInstallProposalSchema, canonicalJson, webApiRuntimeInstallProposalSha256 } from "../../packages/contracts/src/index.js";
import { registerRuntimeInstallation } from "../../packages/broker/src/aws/runtime-installation.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { main as qualificationCli } from "../../packages/verifier/src/install-qualification-cli.js";
import { createLinuxProbeRunner, linuxProbeScratch, removeWebApiProbeScratch } from "../support/linux-web-api-probes.js";
import { EXECUTOR_IMAGE, removeProbeDirs } from "../support/linux-runtime.js";
import { createFakeRuntimeRegistry } from "../support/runtime-registry-fakes.js";
import { fakeLinuxEnvironment, shippedAssetManifest, webApiChallenge } from "../support/web-api-qualification.js";

// The whole qualification through the production CLI path, the production probe runner, the Docker host and the real collector, then the registrar.
// It runs only in the CI `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the DOCKER-USER metadata drop rule applied); elsewhere it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("web/API runtime qualification on a real Docker host", () => {
  afterAll(async () => { await removeProbeDirs(); await removeWebApiProbeScratch(); }, 120_000);
  const admin: AuthenticatedIdentity = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };

  it("qualifies linux-arm64-web-api-v1 through the CLI, registers both rows from the proposal file, and refuses it after one flipped byte", async () => {
    const now = Date.now();
    // Only the worker identity and the installed-manifest read are replaced: this CI host is not the EC2 worker and has no installed root.
    // The manifest still hashes the probe assets and the qualification app in this checkout, so a changed file fails against its pinned digest.
    const fake = fakeLinuxEnvironment(now);
    // Six container runs outlast the usual five-minute challenge window.
    const challenge = webApiChallenge(now, { expiresAt: new Date(now + 2 * 3_600_000).toISOString() });
    const { runRoot, evidenceRoot } = await linuxProbeScratch();
    const outputRoot = (await linuxProbeScratch()).evidenceRoot;
    const challengeFile = join(outputRoot, "challenge.json");
    const proposalFile = join(outputRoot, "proposal.json");
    await writeFile(challengeFile, canonicalJson(challenge));
    await qualificationCli(["--profile", "linux-arm64-web-api-v1", "--challenge-file", challengeFile, "--evidence-root", evidenceRoot, "--out", proposalFile], {
      environment: { EXECUTOR_IMAGE }, host: { platform: "linux", arch: "arm64" }, config: { runRoot },
      // The worker supervisor's Node is at the image's fixed path, which the registrar requires; the CI runner's own Node is elsewhere.
      qualificationEnvironment: { assertHostIdentity: fake.assertHostIdentity!, observeManifest: shippedAssetManifest, now: () => Date.now(), nodeExecPath: fake.nodeExecPath! },
      createProbeRunner: (input) => createLinuxProbeRunner(input) });

    const bytes = await readFile(proposalFile);
    // The measured size of a real proposal, to compare with the 5 MiB bound.
    process.stdout.write(`web/API qualification proposal: ${bytes.byteLength} bytes (bound ${WEB_API_PROBE_PROPOSAL_MAX_BYTES}); per probe ${JSON.stringify(
      (JSON.parse(bytes.toString("utf8")) as { probes: { probeId: string; evidence: unknown }[] }).probes.map((probe) => [probe.probeId, Buffer.byteLength(canonicalJson(probe.evidence))]))}\n`);
    expect(bytes.byteLength).toBeLessThan(WEB_API_PROBE_PROPOSAL_MAX_BYTES);
    const proposal = WebApiRuntimeInstallProposalSchema.parse(JSON.parse(bytes.toString("utf8")));
    expect(proposal.state).toBe("READY");
    expect(proposal.probes.map((probe) => [probe.probeId, probe.observedOutcome])).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => [probe.probeId, probe.expectedOutcome]));
    // Why each expected failure counts, read from the observations the registrar will re-derive.
    const byId = new Map(proposal.probes.map((probe) => [probe.probeId, probe.observation]));
    expect(byId.get("web-csv-negative-v1")).toMatchObject({ collectorStatus: "FAILED", failedAssertionKinds: ["csv"] });
    expect(byId.get("web-egress-denial-v1")!.blockedHosts).toContain("probe.example.com");
    expect(byId.get("api-egress-denial-v1")).toMatchObject({ collectorStatus: "FAILED", failedAssertionKinds: ["http-status"] });
    expect(byId.get("build-imds-denial-v1")).toMatchObject({ runUnavailableReason: "build-failed", buildExitCode: 7 });

    // The registrar re-derives every observation from the embedded bytes and registers both rows.
    const registry = createFakeRuntimeRegistry(Date.now());
    registry.seedChallenge(challenge);
    const result = await registerRuntimeInstallation(registry.deps, admin, { proposal, proposalSha256: webApiRuntimeInstallProposalSha256(proposal) });
    expect(result).toMatchObject({ profileId: "linux-arm64-web-api-v1", featureRevisions: { web: 1, api: 1 } });
    for (const kind of ["web", "api"] as const) {
      const key = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", kind);
      expect(registry.items.get(`${key.pk}|${key.sk}`)).toBeDefined();
    }

    // One flipped byte of one embedded report: the digests no longer agree, so nothing is registered.
    const flipped = JSON.parse(bytes.toString("utf8")) as { probes: { probeId: string; evidence: { collection: { shards: { rawReport: { bytesBase64: string } }[] } } }[] };
    const report = flipped.probes[1]!.evidence.collection.shards[0]!.rawReport;
    report.bytesBase64 = `${report.bytesBase64[0] === "A" ? "B" : "A"}${report.bytesBase64.slice(1)}`;
    const second = createFakeRuntimeRegistry(Date.now());
    second.seedChallenge(challenge);
    await expect(registerRuntimeInstallation(second.deps, admin, { proposal: flipped, proposalSha256: "a".repeat(64) })).rejects.toThrow(/probe-evidence-mismatch:web-csv-negative-v1/);
    expect(second.transactions).toHaveLength(0);
    expect(second.objects.size).toBe(0);
  }, 1_800_000);
});
