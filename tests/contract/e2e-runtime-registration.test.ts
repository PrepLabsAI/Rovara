import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import {
  E2ERuntimeProbeManifestSchema,
  E2ERuntimeCapabilityDescriptorSchema,
  E2ERegisteredRuntimeSchema,
  assertE2ERuntimeProbeManifestIdentity,
  e2eRuntimeCapabilityDigest,
  type E2ERuntimeCapabilityDescriptor,
} from "../../packages/contracts/src/index.js";
import {
  admitE2ERegisteredRuntime,
  e2eRegisteredRuntimeKey,
} from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { E2EFeatureVerifierCatalogRecordSchema, E2EFeatureVerifierRecordSchema, WEB_API_WEB_ENGINE, webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "../../packages/verifier/src/rovara-http-engine-descriptor.js";
import { qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { runtimeInstallChallengeDigest, webApiRuntimeInstallProposalSha256, type RuntimeInstallChallenge } from "../../packages/contracts/src/index.js";
import { fakeLinuxEnvironment, fakeProbeRunner, privateEvidenceRoot, webApiChallenge } from "../support/web-api-qualification.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "x64" };
const capabilities: E2ERuntimeCapabilityDescriptor = E2ERuntimeCapabilityDescriptorSchema.parse({
  schemaVersion: "e2e-runtime-capabilities/v1", profileId: "web-profile", kind: "web",
  host: { os: "linux", arch: "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
  runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"],
  evidenceScopes: ["runtime"], networkPolicyDigest: "b".repeat(64), browsers: ["chromium"],
});
const probeBase = {
  schemaVersion: "e2e-runtime-probe-manifest/v1" as const,
  profileId: capabilities.profileId,
  capabilityDigest: e2eRuntimeCapabilityDigest(capabilities),
  runtimeManifestDigest: capabilities.runtimeManifestDigest,
  suiteDigest: "c".repeat(64),
  fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
  positiveProbeIds: ["browser-opens"],
  negativeProbeIds: ["browser-blocked-network"],
};
function probeManifest(overrides: Record<string, unknown> = {}) {
  const base = { ...probeBase, ...overrides };
  return { ...base, manifestDigest: digest(base) };
}
const probe = probeManifest();
const registration = {
  schemaVersion: 2 as const, entityType: "E2E_FEATURE_VERIFIER" as const,
  runtimeCatalogId: "runtime-catalog", catalogRevision: 3, profileId: capabilities.profileId,
  generation: 4, binding, bindingDigest: digest(binding), endpoint: "http://10.0.0.8:8080",
  transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
  runnerEnvironment, runnerEnvironmentDigest: digest(runnerEnvironment), runnerToolchain, runnerToolchainDigest: digest(runnerToolchain),
  capabilities, capabilityDigest: e2eRuntimeCapabilityDigest(capabilities), probeManifest: probe,
  qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
  state: "READY" as const, qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
};
const now = Date.parse("2026-10-13T12:30:00.000Z");
const expected = { runtimeCatalogId: registration.runtimeCatalogId, profileId: registration.profileId, binding,
  capabilityDigest: registration.capabilityDigest, now };

describe("authenticated E2E runtime catalog projection", () => {
  it("hashes the canonical parsed descriptor independent of property insertion order", () => {
    expect(e2eRuntimeCapabilityDigest(capabilities)).toBe(e2eRuntimeCapabilityDigest({
      browsers: ["chromium"], networkPolicyDigest: "b".repeat(64), evidenceScopes: ["runtime"],
      supportedAssertions: ["visible"], supportedSteps: ["navigate"], runtimeManifestDigest: "a".repeat(64),
      engine: { spiVersion: 1, version: "1.0.0", name: "playwright" }, host: { arch: "x64", os: "linux" },
      kind: "web", profileId: "web-profile", schemaVersion: "e2e-runtime-capabilities/v1",
    }));
  });

  it("requires a canonical fixed probe manifest with positive and negative probes", () => {
    expect(E2ERuntimeProbeManifestSchema.parse(probe)).toEqual(probe);
    expect(E2ERuntimeProbeManifestSchema.safeParse(probeManifest({ positiveProbeIds: ["browser-opens"], negativeProbeIds: [] })).success).toBe(false);
    expect(E2ERuntimeProbeManifestSchema.safeParse(probeManifest({ fixtureRefs: [{ path: "../escape.json", sha256: "d".repeat(64) }] })).success).toBe(false);
    expect(E2ERuntimeProbeManifestSchema.safeParse({ ...probe, unrecognized: true }).success).toBe(false);
    expect(() => assertE2ERuntimeProbeManifestIdentity(probe, probeManifest({ suiteDigest: "f".repeat(64) }))).toThrow();
    expect(() => assertE2ERuntimeProbeManifestIdentity({ ...probe, suiteDigest: "f".repeat(64) }, probe)).toThrow();
  });

  it("cross-checks registration identities and admits only a ready current catalog row", () => {
    const parsed = E2ERegisteredRuntimeSchema.parse(registration);
    expect(parsed.manifestDigest).toBe(parsed.capabilities.runtimeManifestDigest);
    expect(parsed.manifestDigest).toBe(parsed.probeManifest.runtimeManifestDigest);
    expect(parsed.manifestDigest).not.toBe(parsed.probeManifest.manifestDigest);
    const key = e2eRegisteredRuntimeKey(parsed.runtimeCatalogId, parsed.profileId);
    expect(key).toEqual({ pk: "E2E_FEATURE_VERIFIER#runtime-catalog", sk: "PROFILE#web-profile" });
    const row = { ...key, ...parsed };
    expect(admitE2ERegisteredRuntime(row, expected)).toEqual(parsed);
    expect(admitE2ERegisteredRuntime({ ...row, pk: "E2E_FEATURE_VERIFIER#other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, sk: "PROFILE#other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, unrecognized: true }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, profileId: "other" }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, binding: { ...binding, volumeSizeGiB: 64 } }, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...row, capabilityDigest: "f".repeat(64) }, expected)).toBeUndefined();
    expect(() => assertE2ERuntimeProbeManifestIdentity(probeManifest({ suiteDigest: "f".repeat(64) }), probe)).toThrow();
    const changedDriverManifest = probeManifest({ runtimeManifestDigest: "f".repeat(64) });
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, probeManifest: changedDriverManifest }).success).toBe(false);
    expect(admitE2ERegisteredRuntime({ ...row, qualifiedAt: "2026-10-13T12:31:00.000Z" }, expected)).toBeUndefined();
    expect(E2EFeatureVerifierCatalogRecordSchema.safeParse(parsed).success).toBe(true);
    expect(E2EFeatureVerifierCatalogRecordSchema.safeParse(E2EFeatureVerifierRecordSchema.parse({
      schemaVersion: 1, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "legacy", catalogRevision: 1,
      profileId: "default-sandbox", bindingDigest: digest(binding), binding, manifestDigest: "a".repeat(64),
      runnerEnvironment: { ci: true, trustNoticeShown: false, os: "linux", arch: "arm64", runtime: "node v22.23.2" },
      runnerEnvironmentDigest: digest({ ci: true, trustNoticeShown: false, os: "linux", arch: "arm64", runtime: "node v22.23.2" }),
      runnerToolchain: { execPath: "/opt/node/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" },
      runnerToolchainDigest: digest({ execPath: "/opt/node/bin/node", version: "v22.23.2", platform: "linux", arch: "arm64" }),
      endpoint: "http://10.0.0.9:8080", generation: 1, transportCorrelationId: "22222222-2222-4222-8222-222222222222",
      supportedFeatureScopes: ["portable-process-response/v1"], state: "READY",
      qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z",
    })).success).toBe(true);
  });

  it("does not allow a descriptor or caller-selected capability digest to qualify a runtime", () => {
    expect(admitE2ERegisteredRuntime(null, expected)).toBeUndefined();
    expect(admitE2ERegisteredRuntime({ ...registration, state: "PARKED" }, expected)).toBeUndefined();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilityDigest: "f".repeat(64) }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: { ...capabilities, profileId: "other" } }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerToolchain: { ...runnerToolchain, arch: "arm64" } }).success).toBe(false);
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "http://user:pass@10.0.0.8:8080" }).success).toBe(false);
  });

  it("returns validation failures instead of throwing for malformed nested schemas and URLs", () => {
    const malformedCapabilities = { ...capabilities, supportedSteps: ["navigate", "navigate"] };
    expect(() => E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: malformedCapabilities })).not.toThrow();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, capabilities: malformedCapabilities }).success).toBe(false);
    expect(() => E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "not-a-url" })).not.toThrow();
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, endpoint: "not-a-url" }).success).toBe(false);

    const row = { ...e2eRegisteredRuntimeKey(registration.runtimeCatalogId, registration.profileId), ...registration, capabilities: malformedCapabilities };
    expect(() => admitE2ERegisteredRuntime(row, expected)).not.toThrow();
    expect(admitE2ERegisteredRuntime(row, expected)).toBeUndefined();
  });

  it("binds runner OS, architecture and Node runtime to the registered toolchain", () => {
    const mismatchedOs = { ...runnerEnvironment, os: "win32 Windows Server 2022" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerEnvironment: mismatchedOs,
      runnerEnvironmentDigest: digest(mismatchedOs) }).success).toBe(false);
    const mismatchedRuntime = { ...runnerEnvironment, runtime: "node v1.0.0" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration, runnerEnvironment: mismatchedRuntime,
      runnerEnvironmentDigest: digest(mismatchedRuntime) }).success).toBe(false);
    const windowsCapabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ ...capabilities, host: { os: "win32", arch: "x64" } });
    const windowsProbe = probeManifest({ capabilityDigest: e2eRuntimeCapabilityDigest(windowsCapabilities) });
    const windowsEnvironment = { ...runnerEnvironment, os: "win32 Windows Server 2022" };
    const windowsToolchain = { ...runnerToolchain, platform: "win32" };
    expect(E2ERegisteredRuntimeSchema.safeParse({ ...registration,
      runnerEnvironment: windowsEnvironment, runnerEnvironmentDigest: digest(windowsEnvironment),
      runnerToolchain: windowsToolchain, runnerToolchainDigest: digest(windowsToolchain),
      capabilities: windowsCapabilities, capabilityDigest: e2eRuntimeCapabilityDigest(windowsCapabilities), probeManifest: windowsProbe,
    }).success).toBe(true);
  });
});

describe("web/API runtime registration (linux-arm64-web-api-v1)", () => {
  const admin: AuthenticatedIdentity = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };
  const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const at = Date.parse("2026-10-19T12:00:00.000Z");

  async function setup(options: { challenge?: Partial<RuntimeInstallChallenge>; toolchain?: Record<string, string>; runner?: Parameters<typeof fakeProbeRunner>[0] } = {}) {
    const items = new Map<string, Record<string, unknown>>();
    const objects = new Map<string, Buffer>();
    const transactions: Array<Array<Record<string, unknown>>> = [];
    const k = (key: Record<string, unknown>) => `${String(key.pk)}|${String(key.sk)}`;
    const documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const { input } = command;
      if (command.constructor.name === "GetCommand") return { Item: items.get(k(input.Key as Record<string, unknown>)) };
      if (command.constructor.name === "PutCommand") { items.set(k(input.Item as Record<string, unknown>), input.Item as Record<string, unknown>); return {}; }
      if (command.constructor.name === "TransactWriteCommand") {
        const writes = input.TransactItems as Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
        transactions.push(writes);
        for (const write of writes) {
          if (write.Put?.Item) items.set(k(write.Put.Item), write.Put.Item);
          if (write.Update?.Key) items.set(k(write.Update.Key), { ...items.get(k(write.Update.Key))!, state: "CONSUMED" });
        }
        return {};
      }
      throw new Error(`unexpected datastore command ${command.constructor.name}`);
    } };
    const s3 = { send: async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
      if (command.constructor.name === "PutObjectCommand") { objects.set(command.input.Key, Buffer.from(command.input.Body!)); return {}; }
      throw new Error("unexpected object-store command");
    } };
    const deps = { documentClient, s3, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => at } as unknown as RuntimeInstallationDependencies;
    const challenge = webApiChallenge(at, options.challenge);
    items.set(`RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}|CHALLENGE`, { pk: `RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}`, sk: "CHALLENGE",
      entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED", challengeDigest: runtimeInstallChallengeDigest(challenge),
      secretSha256: sha(Buffer.from(challenge.challengeSecret, "base64")), issuedByOwnerKey: challenge.issuedByOwnerKey, issuedBySubject: challenge.issuedBySubject,
      issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt });
    const proposal = await qualifyInstalledWebApiRuntime({ challenge, evidenceRoot: await privateEvidenceRoot(), runProbe: fakeProbeRunner(options.runner).runProbe,
      environment: fakeLinuxEnvironment(at, options.toolchain ? { nodeExecPath: options.toolchain.execPath! } : {}) });
    return { deps, items, objects, transactions, challenge, proposal, request: (value: unknown = proposal) => ({ proposal: value, proposalSha256: webApiRuntimeInstallProposalSha256(proposal) }) };
  }

  it("lets an administrator open a challenge for the new profile", async () => {
    const stored = new Map<string, unknown>();
    const deps = { documentClient: { send: async (command: { input: { Item: Record<string, unknown> } }) => { stored.set(String(command.input.Item.pk), command.input.Item); return {}; } },
      s3: {}, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => at } as unknown as RuntimeInstallationDependencies;
    const challenge = await issueRuntimeInstallChallenge(deps, admin, { binding: webApiChallenge(at).binding, endpoint: "http://10.0.2.15:8080", generation: 3,
      transportCorrelationId: webApiChallenge(at).transportCorrelationId, profileId: "linux-arm64-web-api-v1" });
    expect(challenge.profileId).toBe("linux-arm64-web-api-v1");
    expect(stored.size).toBe(1);
  });

  it("writes one v2 row per kind in a single transaction, and the broker admits each", async () => {
    const t = await setup();
    const result = await registerRuntimeInstallation(t.deps, admin, t.request());
    expect(result).toMatchObject({ profileId: "linux-arm64-web-api-v1", featureCatalogId: "configured-feature", featureRevisions: { web: 1, api: 1 } });
    expect(t.transactions).toHaveLength(1);
    expect(t.transactions[0]!.map((write) => Object.keys(write)[0])).toEqual(["Put", "Put", "Put", "Update"]);
    const webKey = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", "web");
    const apiKey = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", "api");
    expect([webKey.sk, apiKey.sk]).toEqual(["PROFILE#linux-arm64-web-api-v1#web", "PROFILE#linux-arm64-web-api-v1#api"]);
    for (const [kind, key] of [["web", webKey], ["api", apiKey]] as const) {
      const row = t.items.get(`${key.pk}|${key.sk}`)!;
      expect(E2ERegisteredRuntimeSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => name !== "pk" && name !== "sk"))).success).toBe(true);
      const expected = { runtimeCatalogId: "configured-feature", profileId: "linux-arm64-web-api-v1", binding: t.challenge.binding,
        capabilityDigest: String(row.capabilityDigest), now: at + 1000, kind };
      expect(admitE2ERegisteredRuntime(row, expected)).toMatchObject({ state: "READY", capabilities: { kind } });
      // The other kind, and the kindless key a single-kind profile uses, never admit this row.
      expect(admitE2ERegisteredRuntime(row, { ...expected, kind: kind === "web" ? "api" : "web" })).toBeUndefined();
      const { kind: _omitted, ...kindless } = expected;
      void _omitted;
      expect(admitE2ERegisteredRuntime(row, kindless)).toBeUndefined();
      expect(row.generation).toBe(t.challenge.generation);
      expect(row.endpoint).toBe(t.challenge.endpoint);
      expect(row.qualifiedAt).toBe(new Date(at).toISOString());
    }
    // The retained evidence is the exact approved proposal, content addressed, and the challenge is consumed.
    const evidenceKey = `runtime-installations/sha256/${result.proposalSha256}.json`;
    expect(sha(t.objects.get(evidenceKey)!)).toBe(result.proposalSha256);
    expect(t.items.get(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`)!.state).toBe("CONSUMED");
    expect(t.items.get(`${webKey.pk}|${webKey.sk}`)!.qualificationEvidenceRef).toEqual({ key: evidenceKey, sha256: result.proposalSha256, byteLength: t.objects.get(evidenceKey)!.byteLength });
  });

  it("describes what each runtime implements, matching the real engines, without over-claiming", () => {
    const web = webApiRuntimeCapabilities("web", "a".repeat(64));
    const api = webApiRuntimeCapabilities("api", "a".repeat(64));
    const webPackage = JSON.parse(readFileSync(new URL("../../packages/verifier/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(WEB_API_WEB_ENGINE.version).toBe(webPackage.dependencies["@e2e-dev/web"]);
    expect(web).toMatchObject({ kind: "web", profileId: "linux-arm64-web-api-v1", host: { os: "linux", arch: "arm64" }, engine: { name: "web", version: "0.14.0", spiVersion: 1 },
      supportedSteps: ["navigate", "fill", "click", "choose-file"], supportedAssertions: ["text", "visible", "csv"], evidenceScopes: ["runtime"], browsers: ["chromium"] });
    expect(api).toMatchObject({ kind: "api", engine: { name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: 1 },
      supportedSteps: ["request"], supportedAssertions: ["http-status", "json", "state"], evidenceScopes: ["runtime"], protocols: ["http"] });
    for (const descriptor of [web, api]) expect(descriptor.supportedSteps).not.toContain("agent");
  });

  it("registers nothing for a proposal whose recorded evidence is not the required outcome, even with a matching digest", async () => {
    const t = await setup();
    const forged = structuredClone(t.proposal);
    forged.probes[1]!.observation = { ...forged.probes[1]!.observation, collectorStatus: "PASS", failedAssertionKinds: [] };
    await expect(registerRuntimeInstallation(t.deps, admin, { proposal: forged, proposalSha256: "a".repeat(64) })).rejects.toThrow(/negative-probe-passed:web-csv-negative-v1/);
    expect(t.transactions).toHaveLength(0);
    expect(t.objects.size).toBe(0);
  });

  it("rejects a digest that is not the exact proposal, a non-issuer, a consumed challenge, wrong catalogs and a non-supervisor toolchain", async () => {
    const t = await setup();
    await expect(registerRuntimeInstallation(t.deps, admin, { proposal: t.proposal, proposalSha256: "b".repeat(64) })).rejects.toThrow(/approval digest/);
    await expect(registerRuntimeInstallation(t.deps, { ...admin, ownerKey: "other", subject: "other" }, t.request())).rejects.toThrow(/administrator who issued/);
    await expect(registerRuntimeInstallation(t.deps, { ...admin, isAdministrator: false }, t.request())).rejects.toThrow(/administrator/);
    await expect(registerRuntimeInstallation({ ...t.deps, featureCatalogId: "other-feature" }, admin, t.request())).rejects.toThrow(/catalogs do not match/);
    expect(t.transactions).toHaveLength(0);
    await registerRuntimeInstallation(t.deps, admin, t.request());
    await expect(registerRuntimeInstallation(t.deps, admin, t.request())).rejects.toThrow(/already consumed/);
    const wrongSupervisor = await setup({ toolchain: { execPath: "/opt/other/node" } });
    await expect(registerRuntimeInstallation(wrongSupervisor.deps, admin, wrongSupervisor.request())).rejects.toThrow(/fixed Linux ARM64 worker supervisor/);
    expect(wrongSupervisor.transactions).toHaveLength(0);
  });

  it("bumps each row's own catalog revision on re-registration", async () => {
    const t = await setup();
    const webKey = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", "web");
    t.items.set(`${webKey.pk}|${webKey.sk}`, { ...webKey, catalogRevision: 4 });
    const result = await registerRuntimeInstallation(t.deps, admin, t.request());
    expect(result).toMatchObject({ featureRevisions: { web: 5, api: 1 } });
    const condition = t.transactions[0]!.map((write) => (write.Put as { ConditionExpression?: string } | undefined)?.ConditionExpression);
    expect(condition[0]).toBe("catalogRevision = :expectedRevision");
    expect(condition[1]).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
  });

  it("keeps the standard P0 registrar closed to a web/API proposal and the web/API one closed to P0", async () => {
    const t = await setup();
    const asP0 = { ...t.proposal, schemaVersion: "runtime-installation-proposal/v1" };
    await expect(registerRuntimeInstallation(t.deps, admin, { proposal: asP0, proposalSha256: "c".repeat(64) })).rejects.toThrow();
    expect(t.transactions).toHaveLength(0);
  });
});
