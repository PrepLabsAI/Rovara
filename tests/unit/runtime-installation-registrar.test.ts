import { createHash, randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { RuntimeInstallationProposalSchema, runtimeInstallChallengeDigest, runtimeInstallationProposalSha256, type RuntimeInstallChallenge } from "../../packages/contracts/src/runtime-installation.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { proposalFor } from "../support/p0-runtime-proposal.js";
import { assertRuntimeInstallationEndpointIdentity, assertRuntimeInstallationHostIdentity } from "../../packages/verifier/src/install-qualification.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const admin: AuthenticatedIdentity = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };
const ordinary: AuthenticatedIdentity = { ...admin, subject: "operator", ownerKey: "operator", isAdministrator: false };


function challengeStore() {
  const items = new Map<string, Record<string, unknown>>();
  const documentClient = { send: async (command: unknown) => {
    const record = command as { input?: Record<string, unknown> };
    const input = record.input ?? {};
    if (input.Item && typeof input.Item === "object") {
      const item = input.Item as Record<string, unknown>;
      items.set(`${String(item.pk)}|${String(item.sk)}`, item);
      return {};
    }
    if (input.Key && typeof input.Key === "object") {
      const key = input.Key as Record<string, unknown>;
      return { Item: items.get(`${String(key.pk)}|${String(key.sk)}`) };
    }
    throw new Error("unexpected registrar datastore access in wrong-host test");
  } };
  return { items, documentClient };
}

function seedIssuedChallenge(items: Map<string, Record<string, unknown>>, challenge: RuntimeInstallChallenge) {
  items.set(`RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}|CHALLENGE`, {
    pk: `RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}`, sk: "CHALLENGE", entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED",
    challengeDigest: runtimeInstallChallengeDigest(challenge), secretSha256: sha(Buffer.from(challenge.challengeSecret, "base64")),
    issuedByOwnerKey: challenge.issuedByOwnerKey, issuedBySubject: challenge.issuedBySubject, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
  });
}

describe("runtime installation broker registration", () => {
  it("fails closed when a Linux challenge does not match actual boot workspace and generation", () => {
    const localIpv4 = Object.values(networkInterfaces()).flatMap((items) => (items ?? []).filter((item) => !item.internal && item.family === "IPv4").map((item) => item.address))[0] ?? "192.168.1.2";
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "linux-arm64-docker-v1" as const, endpoint: `http://${localIpv4}:8080`, generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, {})).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: randomUUID(), AGENTX_SESSION_GENERATION: "3" })).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: challenge.transportCorrelationId, AGENTX_SESSION_GENERATION: "2" })).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: challenge.transportCorrelationId, AGENTX_SESSION_GENERATION: "3" })).not.toThrow();
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.3:8080", 8080, ["10.1.2.3"])).not.toThrow();
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.4:8080", 8080, ["10.1.2.3"])).toThrow(/does not match/);
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.3:3000", 8080, ["10.1.2.3"])).toThrow(/does not match/);
  });

  it("requires administrator authority before issuing a challenge and derives catalog IDs server-side", async () => {
    const { items, documentClient } = challengeStore();
    const deps = { documentClient, s3: { send: async () => { throw new Error("unused"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature" } as unknown as RuntimeInstallationDependencies;
    const request = { binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" }, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), profileId: "darwin-arm64-colima-v1" };
    await expect(issueRuntimeInstallChallenge(deps, ordinary, request)).rejects.toThrow(/administrator/);
    expect(items.size).toBe(0);
    const challenge = await issueRuntimeInstallChallenge(deps, admin, request);
    expect(challenge.setupCatalogId).toBe("configured-setup");
    expect(challenge.featureCatalogId).toBe("configured-feature");
    expect(new Set(Object.values(challenge.probeCorrelations)).size).toBe(3);
    expect(items.size).toBe(1);
  });

  it("does not publish local Darwin evidence into the standard Linux catalog", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:04:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    const parsedProposal = RuntimeInstallationProposalSchema.safeParse(proposal);
    if (!parsedProposal.success) throw new Error(JSON.stringify(parsedProposal.error.issues));
    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/Linux ARM64 worker supervisor/);
    expect(items.size).toBe(1);
  });

  it("binds redemption and immutable evidence approval to the challenge issuer", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:04:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      issuedByOwnerKey: admin.ownerKey, issuedBySubject: admin.subject, binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    const otherAdmin: AuthenticatedIdentity = { ...admin, ownerKey: "other-admin", subject: "other-admin" };
    await expect(registerRuntimeInstallation(deps, otherAdmin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/administrator who issued its challenge/);
    expect(items.size).toBe(1);
  });

  it("rejects wrong catalog identities and fresh-challenge replay before registrar writes", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "attacker-catalog", featureCatalogId: "attacker-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/catalogs do not match/);
    const replay = structuredClone(proposal);
    replay.challenge.challengeId = randomUUID();
    await expect(registerRuntimeInstallation(deps, admin, { proposal: replay, proposalSha256: "a".repeat(64) })).rejects.toThrow();
    expect(items.size).toBe(1);
  });
});
