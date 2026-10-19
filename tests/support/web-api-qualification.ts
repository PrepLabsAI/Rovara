import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { WEB_API_CHALLENGE_LIFETIME_MS, WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX, WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, canonicalJson, webApiProbeAssetManifestPath,
  type RuntimeInstallChallenge, type WebApiProbeEvidence, type WebApiProbeObservation, type WebApiProbeRun } from "../../packages/contracts/src/index.js";
import { deriveWebApiProbeObservation } from "../../packages/verifier/src/web-api-probe-evidence.js";
import type { WebApiQualificationEnvironment } from "../../packages/verifier/src/install-qualification.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** The moment the committed probe evidence was recorded against; challenges made for this moment bind to it. */
export const WEB_API_FIXTURE_NOW = Date.parse("2026-10-19T12:00:00.000Z");

/**
 * A strict, valid challenge for the web/API profile; times are relative to `now`. Every other field is fixed, so a challenge made for
 * `WEB_API_FIXTURE_NOW` is always the same challenge: the committed probe evidence is bound to it by the run id derived from its digest.
 */
export function webApiChallenge(now: number, overrides: Partial<RuntimeInstallChallenge> = {}): RuntimeInstallChallenge {
  return { schemaVersion: "runtime-install-challenge/v1", challengeId: "5d1f0f4e-3c2a-4b8e-9f64-7a1c2b3d4e5f", challengeSecret: `${"B".repeat(43)}=`,
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 60_000 + WEB_API_CHALLENGE_LIFETIME_MS).toISOString(), issuedByOwnerKey: "admin", issuedBySubject: "admin",
    binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" },
    setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "linux-arm64-web-api-v1", endpoint: "http://10.0.2.15:8080",
    generation: 3, transportCorrelationId: "7b0e9c52-6d41-4f1e-8a3b-2c5d6e7f8091",
    probeCorrelations: { sourceInterface: "a1b2c3d4-0001-4aaa-8bbb-000000000001", featurePositive: "a1b2c3d4-0002-4aaa-8bbb-000000000002", featureNegative: "a1b2c3d4-0003-4aaa-8bbb-000000000003" }, ...overrides };
}

const fixtureDirectory = join(import.meta.dirname, "../fixtures/web-api-probe-evidence");
/** The evidence the production runner retained for each probe, recorded against the challenge `webApiChallenge(WEB_API_FIXTURE_NOW)`. */
export function fixtureEvidence(probeId: string): WebApiProbeEvidence {
  return WebApiProbeEvidenceSchema.parse(JSON.parse(readFileSync(join(fixtureDirectory, `${probeId}.json`), "utf8")));
}

/** Each probe's run exactly as the production runner reports it: the evidence, and the observation derived from nothing but that evidence. */
export function fixtureProbeRuns(challenge: RuntimeInstallChallenge = webApiChallenge(WEB_API_FIXTURE_NOW)): Record<string, WebApiProbeRun> {
  return Object.fromEntries(WEB_API_REQUIRED_PROBES.map((probe) => {
    const evidence = fixtureEvidence(probe.probeId);
    const derived = deriveWebApiProbeObservation({ challenge, probeId: probe.probeId, evidence });
    if (!derived.ok) throw new Error(`committed probe evidence no longer binds: ${derived.reason}`);
    return [probe.probeId, { observation: derived.observation, evidence }];
  }));
}

/** The observation a healthy, contained runtime produces for a required probe. Read from the committed evidence when asked, so stale evidence can be regenerated. */
export function goodWebApiObservation(probeId: string): WebApiProbeObservation { return fixtureProbeRuns()[probeId]!.observation; }

/**
 * A fake probe runner replaying the committed evidence, with per-probe overrides of the recorded observation. An override changes only the claimed
 * observation, never the evidence, which is exactly what a forged claim looks like to the registrar.
 */
export function fakeProbeRunner(overrides: Record<string, Partial<WebApiProbeObservation> | Error> = {}) {
  const calls: string[] = [];
  const runs = fixtureProbeRuns();
  const runProbe = async (probeId: string): Promise<WebApiProbeRun> => {
    calls.push(probeId);
    const override = overrides[probeId];
    if (override instanceof Error) throw override;
    const run = runs[probeId]!;
    return { observation: { ...run.observation, ...override }, evidence: run.evidence };
  };
  return { runProbe, calls };
}

/** The installed manifest's entries for the qualification app, hashed from the files actually shipped in the repo. */
function qualificationAppEntries(): { path: string; sha256: string }[] {
  const root = join(import.meta.dirname, "../../packages/verifier/assets/qualification-app");
  return readdirSync(root, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .map((entry) => { const path = join(entry.parentPath, entry.name); return { path: `${WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX}${relative(root, path).split(sep).join("/")}`, sha256: sha(readFileSync(path)) }; });
}

/** A Linux ARM64 host description with an installed-manifest fixture; nothing here reads the real machine. */
export function fakeLinuxEnvironment(now: number, overrides: Partial<WebApiQualificationEnvironment> = {}): Partial<WebApiQualificationEnvironment> {
  const entries = [...WEB_API_REQUIRED_PROBES.map((probe) => ({ path: webApiProbeAssetManifestPath(probe.probeId), sha256: probe.assetDigest })), ...qualificationAppEntries(),
    { path: "packages/verifier/dist/install-qualification.js", sha256: sha("code") }].sort((left, right) => left.path.localeCompare(right.path));
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

/** A manifest that hashes the probe asset files actually shipped in the repo, so a changed asset fails qualification as it would on a host. */
export async function shippedAssetManifest() {
  const root = join(import.meta.dirname, "../..");
  const entries = [...WEB_API_REQUIRED_PROBES.map((probe) => ({ path: webApiProbeAssetManifestPath(probe.probeId), sha256: sha(readFileSync(join(root, webApiProbeAssetManifestPath(probe.probeId)))) })), ...qualificationAppEntries(),
    { path: "packages/verifier/dist/install-qualification.js", sha256: sha("code") }].sort((left, right) => left.path.localeCompare(right.path));
  const body = { schemaVersion: "installed-runtime-manifest/v1" as const, entries };
  return { ...body, sha256: sha(canonicalJson(body)) };
}
