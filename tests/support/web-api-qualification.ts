import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type RuntimeInstallChallenge, type WebApiProbeObservation } from "../../packages/contracts/src/index.js";
import type { WebApiQualificationEnvironment } from "../../packages/verifier/src/install-qualification.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** A strict, valid challenge for the web/API profile; times are relative to `now`. */
export function webApiChallenge(now: number, overrides: Partial<RuntimeInstallChallenge> = {}): RuntimeInstallChallenge {
  return { schemaVersion: "runtime-install-challenge/v1", challengeId: randomUUID(), challengeSecret: `${"B".repeat(43)}=`,
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 240_000).toISOString(), issuedByOwnerKey: "admin", issuedBySubject: "admin",
    binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" },
    setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "linux-arm64-web-api-v1", endpoint: "http://10.0.2.15:8080",
    generation: 3, transportCorrelationId: randomUUID(),
    probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() }, ...overrides };
}

const evidenceDigest = (probeId: string) => sha(`evidence:${probeId}`);
const clean = { attempts: 1, skipped: 0, flaky: 0 } as const;

/** The observations a healthy, contained runtime produces for each required probe. */
export const goodWebApiObservations: Record<string, WebApiProbeObservation> = {
  "web-csv-positive-v1": { collectorStatus: "PASS", runUnavailableReason: null, failedAssertionKinds: [], blockedHosts: [], buildExitCode: null, ...clean, evidenceDigest: evidenceDigest("web-csv-positive-v1") },
  "web-csv-negative-v1": { collectorStatus: "FAILED", runUnavailableReason: null, failedAssertionKinds: ["csv"], blockedHosts: [], buildExitCode: null, ...clean, evidenceDigest: evidenceDigest("web-csv-negative-v1") },
  "web-egress-denial-v1": { collectorStatus: "FAILED", runUnavailableReason: null, failedAssertionKinds: ["text"], blockedHosts: ["probe.example.com"], buildExitCode: null, ...clean, evidenceDigest: evidenceDigest("web-egress-denial-v1") },
  "api-state-positive-v1": { collectorStatus: "PASS", runUnavailableReason: null, failedAssertionKinds: [], blockedHosts: [], buildExitCode: null, ...clean, evidenceDigest: evidenceDigest("api-state-positive-v1") },
  "api-egress-denial-v1": { collectorStatus: "FAILED", runUnavailableReason: null, failedAssertionKinds: ["http-status"], blockedHosts: [], buildExitCode: null, ...clean, evidenceDigest: evidenceDigest("api-egress-denial-v1") },
  "build-imds-denial-v1": { collectorStatus: null, runUnavailableReason: "build-failed", failedAssertionKinds: [], blockedHosts: [], buildExitCode: 7, ...clean, evidenceDigest: evidenceDigest("build-imds-denial-v1") },
};

/** A fake probe runner returning the good observations, with per-probe overrides. */
export function fakeProbeRunner(overrides: Record<string, Partial<WebApiProbeObservation> | Error> = {}) {
  const calls: string[] = [];
  const runProbe = async (probeId: string): Promise<WebApiProbeObservation> => {
    calls.push(probeId);
    const override = overrides[probeId];
    if (override instanceof Error) throw override;
    return { ...goodWebApiObservations[probeId]!, ...override };
  };
  return { runProbe, calls };
}

/** A Linux ARM64 host description with an installed-manifest fixture; nothing here reads the real machine. */
export function fakeLinuxEnvironment(now: number, overrides: Partial<WebApiQualificationEnvironment> = {}): Partial<WebApiQualificationEnvironment> {
  const entries = [{ path: "packages/verifier/assets/application-runtime-v1/probes/web-csv-positive-v1.json", sha256: sha("probe") },
    { path: "packages/verifier/dist/install-qualification.js", sha256: sha("code") }];
  const body = { schemaVersion: "installed-runtime-manifest/v1" as const, entries };
  return { platform: "linux", arch: "arm64", nodeVersion: "v22.23.2", nodeExecPath: "/usr/local/bin/node", osRelease: "6.8.0-aws", now: () => now,
    assertHostIdentity: () => undefined, observeManifest: async () => ({ ...body, sha256: sha(canonicalJson(body)) }), ...overrides };
}

/** A pre-created private evidence root, as the qualifier requires. */
export async function privateEvidenceRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "web-api-qualification-")));
  await chmod(root, 0o700);
  return root;
}
