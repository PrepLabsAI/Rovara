import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requestRuntimeInstallChallenge } from "../../packages/cli/src/admin/runtime-installation.js";

const challenge = {
  schemaVersion: "runtime-install-challenge/v1",
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: `${"A".repeat(43)}=`,
  issuedAt: "2026-10-14T12:00:00.000Z",
  expiresAt: "2026-10-14T12:05:00.000Z",
  issuedByOwnerKey: "owner-key",
  issuedBySubject: "owner-subject",
  binding: {
    deploymentMode: "ec2-ebs",
    launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }],
    volumeSizeGiB: 64,
    volumeType: "gp3",
  },
  setupCatalogId: "setup-catalog-v1",
  featureCatalogId: "feature-catalog-v1",
  profileId: "linux-arm64-docker-v1",
  endpoint: "http://10.0.1.12:8080/",
  generation: 1,
  transportCorrelationId: "22222222-2222-4222-8222-222222222222",
  probeCorrelations: {
    sourceInterface: "33333333-3333-4333-8333-333333333333",
    featurePositive: "44444444-4444-4444-8444-444444444444",
    featureNegative: "55555555-5555-4555-8555-555555555555",
  },
} as const;

describe("runtime installation challenge CLI response", () => {
  it("accepts the broker requestId envelope and persists only the strict challenge", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-runtime-install-challenge-"));
    const bindingFile = join(root, "binding.json");
    const outputFile = join(root, "challenge.json");
    await writeFile(bindingFile, JSON.stringify(challenge.binding), { mode: 0o600 });
    try {
      const response = { requestId: "apigw:ZKx7mF3nY=", ...challenge };
      const sent: unknown[] = [];
      const fetcher: typeof fetch = async (_url, init) => { sent.push(init?.body); return new Response(JSON.stringify(response), { status: 201 }); };
      const result = await requestRuntimeInstallChallenge({
        controlPlaneUrl: "https://control.example", accessToken: "test-token", bindingFile,
        endpoint: challenge.endpoint, generation: challenge.generation,
        transportCorrelationId: challenge.transportCorrelationId, profileId: challenge.profileId, outputFile, instanceId: "i-0123456789abcdef0",
      }, fetcher);
      expect(JSON.parse(String(sent.at(-1)))).toMatchObject({ instanceId: "i-0123456789abcdef0", profileId: challenge.profileId });

      expect(result.challengeId).toBe(challenge.challengeId);
      expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual(challenge);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // WORKER-DELIVERY-IDENTITY (WDI-SETUP): the standard profile's challenge names its instance, and the tool refuses before anything is sent when it does not.
  it("refuses a standard-profile challenge without an EC2 instance id, and a malformed one, before any request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-runtime-install-challenge-"));
    const bindingFile = join(root, "binding.json");
    await writeFile(bindingFile, JSON.stringify(challenge.binding), { mode: 0o600 });
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 201 }));
      const base = { controlPlaneUrl: "https://control.example", accessToken: "t", bindingFile, endpoint: challenge.endpoint, generation: challenge.generation, transportCorrelationId: challenge.transportCorrelationId, profileId: "linux-arm64-docker-v1" as const, outputFile: join(root, "c.json") };
      await expect(requestRuntimeInstallChallenge(base, fetcher)).rejects.toThrow(/--instance-id/);
      await expect(requestRuntimeInstallChallenge({ ...base, instanceId: "ami-0123456789abcdef0" }, fetcher)).rejects.toThrow(/--instance-id/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
