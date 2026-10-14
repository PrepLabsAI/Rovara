import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { qualifyInstalledP0Runtime } from "@agentx/verifier";

const admin: AuthenticatedIdentity = { issuer: "native-p0", subject: "explicit-test-admin", ownerKey: "native-p0-admin", isAdministrator: true, claims: {} };
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

describe("installed P0 runtime qualification on the current native supervisor", () => {
  it("runs the actual installed positive and negative probes before the Linux registrar rejects this Darwin host", async () => {
    const evidenceRoot = process.env.P0_RUNTIME_INSTALL_EVIDENCE_DIR;
    expect(evidenceRoot, "P0_RUNTIME_INSTALL_EVIDENCE_DIR must be a fresh private external evidence root").toBeDefined();
    const root = resolve(evidenceRoot!);
    const info = await lstat(root);
    expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o077).toBe(0);
    expect(await realpath(root)).toBe(root);
    expect(basename(dirname(root))).toBe("AgentX-e2e-p0-20261012-evidence");
    const tmpRoot = await realpath(resolve(process.env.TMPDIR ?? "/tmp"));
    expect(root.startsWith(`${tmpRoot}/`)).toBe(false);

    const rows = new Map<string, Record<string, unknown>>();
    const documentClient = { send: async (command: unknown) => {
      const input = (command as { input?: Record<string, unknown> }).input ?? {};
      if (input.Item && typeof input.Item === "object") {
        const item = input.Item as Record<string, unknown>;
        rows.set(`${String(item.pk)}|${String(item.sk)}`, item);
        return {};
      }
      if (input.Key && typeof input.Key === "object") {
        const key = input.Key as Record<string, unknown>;
        return { Item: rows.get(`${String(key.pk)}|${String(key.sk)}`) };
      }
      throw new Error("native Darwin rejection test must not read or update runtime catalogs");
    } };
    const deps = { documentClient, s3: { send: async () => { throw new Error("wrong-host proof must be rejected before artifact storage"); } }, tableName: "runtime-test-state", artifactBucketName: "runtime-test-artifacts", setupCatalogId: "native-setup", featureCatalogId: "native-feature", now: () => Date.now() } as unknown as RuntimeInstallationDependencies;
    const challenge = await issueRuntimeInstallChallenge(deps, admin, {
      binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" },
      endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), profileId: "darwin-arm64-colima-v1",
    });
    expect(rows.size).toBe(1);

    const proposal = await qualifyInstalledP0Runtime({ challenge, evidenceRoot: root });
    expect(proposal.challenge.challengeId).toBe(challenge.challengeId);
    expect(proposal.probes.map((probe) => [probe.probeId, probe.observedOutcome])).toEqual([
      ["source-interface-positive/v1", "PASS"], ["process-response-positive/v1", "PASS"], ["process-response-negative/v1", "EXPECTED_FAILURE"],
    ]);
    expect(proposal.probes.every((probe) => probe.captures.every((capture) => sha(Buffer.from(capture.bytesBase64, "base64")) === capture.sha256))).toBe(true);
    expect(proposal.manifest.entries.some((entry) => entry.path === "packages/verifier/assets/runtime-installation/probe-oracle.json")).toBe(true);
    expect(proposal.runnerToolchain).toMatchObject({ version: "v22.23.2", platform: "darwin", arch: "arm64" });
    expect(challenge.profileId).toBe("darwin-arm64-colima-v1");

    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: createHash("sha256").update(canonicalJson(proposal)).digest("hex") })).rejects.toThrow(/Linux ARM64 worker supervisor/);
    expect([...rows.values()].filter((row) => row.entityType === "RUNTIME_INSTALL_CHALLENGE" && row.state === "ISSUED")).toHaveLength(1);
    expect([...rows.values()].some((row) => row.entityType === "PROJECT_SETUP_RUNTIME" || row.entityType === "E2E_FEATURE_VERIFIER")).toBe(false);
  }, 120_000);
});
