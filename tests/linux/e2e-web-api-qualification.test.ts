import { afterAll, describe, expect, it } from "vitest";
import { WEB_API_REQUIRED_PROBES, WebApiRuntimeInstallProposalSchema } from "../../packages/contracts/src/index.js";
import { qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { observeWebApiProbe } from "../support/linux-web-api-probes.js";
import { removeProbeDirs } from "../support/linux-runtime.js";
import { fakeLinuxEnvironment, privateEvidenceRoot, shippedAssetManifest, webApiChallenge } from "../support/web-api-qualification.js";

// The whole qualification suite through the production Docker host and the real collector. It runs only in the CI `linux-runtime`
// job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the DOCKER-USER metadata drop rule applied); elsewhere it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("web/API runtime qualification on a real Docker host", () => {
  afterAll(removeProbeDirs, 120_000);

  it("qualifies linux-arm64-web-api-v1: every required probe has its expected outcome", async () => {
    const now = Date.now();
    const observed: string[] = [];
    // Only the worker identity and the installed-manifest read are replaced: this CI host is not the EC2 worker and has no installed root.
    // The manifest still hashes the probe asset files in this checkout, so a changed asset fails against its pinned digest.
    const fake = fakeLinuxEnvironment(now);
    // Six container runs outlast the usual five-minute challenge window.
    const challenge = webApiChallenge(now, { expiresAt: new Date(now + 2 * 3_600_000).toISOString() });
    const proposal = await qualifyInstalledWebApiRuntime({ challenge, evidenceRoot: await privateEvidenceRoot(),
      runProbe: async (probeId) => { observed.push(probeId); return observeWebApiProbe(probeId); },
      environment: { assertHostIdentity: fake.assertHostIdentity!, observeManifest: shippedAssetManifest, now: () => Date.now() } });
    expect(observed).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId));
    expect(proposal.state).toBe("READY");
    expect(proposal.probes.map((probe) => [probe.probeId, probe.observedOutcome])).toEqual(WEB_API_REQUIRED_PROBES.map((probe) => [probe.probeId, probe.expectedOutcome]));
    expect(WebApiRuntimeInstallProposalSchema.safeParse(proposal).success).toBe(true);
    // Why each expected failure counts, read from the retained evidence rather than assumed.
    const byId = new Map(proposal.probes.map((probe) => [probe.probeId, probe.observation]));
    expect(byId.get("web-csv-negative-v1")).toMatchObject({ collectorStatus: "FAILED", failedAssertionKinds: ["csv"] });
    expect(byId.get("web-egress-denial-v1")!.blockedHosts).toContain("probe.example.com");
    expect(byId.get("api-egress-denial-v1")).toMatchObject({ collectorStatus: "FAILED", failedAssertionKinds: ["http-status"] });
    expect(byId.get("build-imds-denial-v1")).toMatchObject({ runUnavailableReason: "build-failed", buildExitCode: 7 });
  }, 1_800_000);
});
