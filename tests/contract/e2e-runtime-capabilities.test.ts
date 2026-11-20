import { describe, expect, it } from "vitest";
import {
  E2ERuntimeCapabilityDescriptorSchema,
  E2ERuntimeReadinessSchema,
  E2ETargetSchema,
  resolveE2ERuntimeReadiness,
  toE2ERuntimeAvailability,
  type E2ERuntimeCapabilityDescriptor,
  type E2ERuntimeReadinessInput,
} from "../../packages/contracts/src/index.js";

const digest = "a".repeat(64);
type WebDescriptor = Extract<E2ERuntimeCapabilityDescriptor, { kind: "web" }>;
const base: WebDescriptor = {
  schemaVersion: "e2e-runtime-capabilities/v1",
  profileId: "web-profile",
  kind: "web",
  host: { os: "linux", arch: "x64" },
  engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
  runtimeManifestDigest: digest,
  supportedSteps: ["navigate", "click"],
  supportedAssertions: ["text", "visible"],
  evidenceScopes: ["source", "mock-contract", "runtime"],
  networkPolicyDigest: digest,
  browsers: ["chromium"],
};
const baseWithoutBrowserDetails: Omit<WebDescriptor, "browsers"> = {
  schemaVersion: base.schemaVersion,
  profileId: base.profileId,
  kind: base.kind,
  host: base.host,
  engine: base.engine,
  runtimeManifestDigest: base.runtimeManifestDigest,
  supportedSteps: base.supportedSteps,
  supportedAssertions: base.supportedAssertions,
  evidenceScopes: base.evidenceScopes,
  networkPolicyDigest: base.networkPolicyDigest,
};

const webTarget = E2ETargetSchema.parse({
  targetId: "web-app", applicationId: "app", runtimeProfileId: "web-profile", accountProfileId: "synthetic",
  kind: "web", browser: "chromium", viewport: { width: 1280, height: 720 },
});

const defaultInput: E2ERuntimeReadinessInput = {
  target: webTarget,
  requiredSteps: ["navigate"],
  requiredAssertions: ["text"],
  minimumEvidence: "runtime",
  installationEnabled: true,
  activationEnabled: true,
  connection: "connected",
  approval: "approved",
  qualification: "qualified",
  state: "READY",
  expiresAt: "2030-01-01T00:00:00.000Z",
  now: Date.parse("2029-01-01T00:00:00.000Z"),
  capabilities: base,
};

function input(overrides: Partial<E2ERuntimeReadinessInput> = {}): E2ERuntimeReadinessInput {
  return { ...defaultInput, ...overrides };
}

function webCapabilities(overrides: Partial<Omit<WebDescriptor, "kind">> = {}): WebDescriptor {
  return { ...base, ...overrides, kind: "web" };
}

function mobileTarget(os: "android" | "ios", profileId = os): E2ERuntimeReadinessInput["target"] {
  return E2ETargetSchema.parse({ targetId: os, applicationId: "app", runtimeProfileId: profileId, accountProfileId: "synthetic", kind: "mobile", os, appId: "app", deviceProfileId: "device-1" });
}

function mobileDescriptor(os: "android" | "ios", host: "linux" | "darwin", deviceKinds: ("emulator" | "simulator" | "physical")[], deviceProfileIds = ["device-1"]): E2ERuntimeCapabilityDescriptor {
  return E2ERuntimeCapabilityDescriptorSchema.parse({
    ...baseWithoutBrowserDetails,
    profileId: os,
    kind: os,
    supportedSteps: ["launch-app"],
    supportedAssertions: ["visible"],
    evidenceScopes: ["runtime"],
    host: { os: host, arch: "arm64" },
    os,
    deviceKinds,
    deviceProfileIds,
  });
}

function desktopTarget(os: "linux" | "macos" | "windows", driver: "electron" | "native", profileId: string): E2ERuntimeReadinessInput["target"] {
  return E2ETargetSchema.parse({ targetId: "desktop", applicationId: "app", runtimeProfileId: profileId, accountProfileId: "synthetic", kind: "desktop", os, driver, appId: "app" });
}

describe("E2E runtime capability descriptor", () => {

  it("rejects platform-inconsistent host and device profiles", () => {
    const noBrowserDetails = baseWithoutBrowserDetails;
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "ios", profileId: "ios", os: "ios", deviceKinds: ["simulator"], deviceProfileIds: ["iphone"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "native-desktop", profileId: "native", os: "windows", driver: "native", isolatedSession: true }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "android", profileId: "android", host: { os: "win32", arch: "x64" }, os: "android", deviceKinds: ["emulator"], deviceProfileIds: ["pixel"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "ios", profileId: "ios", host: { os: "linux", arch: "x64" }, os: "ios", deviceKinds: ["simulator"], deviceProfileIds: ["iphone"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "android", profileId: "android", host: { os: "linux", arch: "x64" }, os: "android", deviceKinds: ["simulator"], deviceProfileIds: ["pixel"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...noBrowserDetails, kind: "ios", profileId: "ios", host: { os: "darwin", arch: "arm64" }, os: "ios", deviceKinds: ["emulator"], deviceProfileIds: ["iphone"] }).success).toBe(false);
  });

});

describe("E2E runtime readiness", () => {
  it("returns READY only when profile, target, host, capabilities, access and qualification match", () => {
    const result = resolveE2ERuntimeReadiness(input());
    expect(E2ERuntimeReadinessSchema.parse(result)).toEqual(expect.objectContaining({
      targetId: "web-app", profileId: "web-profile", status: "READY", suggestedAction: null,
      requiredCapabilities: ["assertion:text", "evidence:runtime", "step:navigate"],
    }));
    expect(toE2ERuntimeAvailability(result, "auth-7")).toEqual({ targetId: "web-app", profileId: "web-profile", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth-7" });
  });

  it("returns READY for the valid default sandbox target", () => {
    const target: Extract<E2ERuntimeReadinessInput["target"], { kind: "default-sandbox" }> = { targetId: "default-sandbox", runtimeProfileId: "default-sandbox", kind: "default-sandbox" };
    const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({
      ...baseWithoutBrowserDetails, kind: "default-sandbox", profileId: "default-sandbox", supportedSteps: ["navigate"], supportedAssertions: ["text"], evidenceScopes: ["source", "mock-contract"], host: { os: "linux", arch: "arm64" },
    });
    const result = resolveE2ERuntimeReadiness(input({ target, capabilities, minimumEvidence: "mock-contract" }));
    expect(result.status).toBe("READY");
    expect(toE2ERuntimeAvailability(result, "auth-7").qualification).toBe("qualified");
  });

  it("reports disabled and missing profiles without enabling installation implicitly", () => {
    expect(resolveE2ERuntimeReadiness(input({ activationEnabled: false })).status).toBe("DISABLED");
    const disabled = resolveE2ERuntimeReadiness(input({ capabilities: null, installationEnabled: false }));
    expect(disabled).toMatchObject({ status: "MISSING", suggestedAction: null });
    expect(resolveE2ERuntimeReadiness(input({ capabilities: null })).suggestedAction).toBe("install");
  });

  it("fails closed for missing, invalid, expired and just-expired timestamps", () => {
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: null })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "2028-01-01T00:00:00.000Z" })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "2029-02-29T00:00:00Z" })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "not-a-date" })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "2029-01-01T00:00:00.000Z", now: Date.parse("2029-01-01T00:00:00.000Z") })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ now: Number.NaN })).status).toBe("EXPIRED");
  });

  it("rejects target/profile and insufficient runtime capabilities", () => {
    const wrongProfile = E2ETargetSchema.parse({ ...webTarget, runtimeProfileId: "other" });
    expect(resolveE2ERuntimeReadiness(input({ target: wrongProfile })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ capabilities: webCapabilities({ browsers: ["firefox"] }) })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ requiredSteps: ["launch-app"] })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ requiredAssertions: ["file"] })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ minimumEvidence: "external-live" })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ minimumEvidence: "source" })).status).toBe("READY");
  });

  it("matches API, Android, iOS, Electron and native desktop profiles to their target and host", () => {
    const apiTarget = E2ETargetSchema.parse({ targetId: "api", applicationId: "app", runtimeProfileId: "api", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "api-origin" });
    const apiDescriptor = E2ERuntimeCapabilityDescriptorSchema.parse({ ...baseWithoutBrowserDetails, profileId: "api", kind: "api", supportedSteps: ["request"], supportedAssertions: ["http-status"], protocols: ["http"] });
    expect(resolveE2ERuntimeReadiness(input({ target: apiTarget, capabilities: apiDescriptor, requiredSteps: ["request"], requiredAssertions: ["http-status"] })).status).toBe("READY");
    expect(resolveE2ERuntimeReadiness(input({ target: mobileTarget("android"), capabilities: mobileDescriptor("android", "linux", ["emulator"]), requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("READY");
    expect(resolveE2ERuntimeReadiness(input({ target: mobileTarget("android"), capabilities: mobileDescriptor("android", "darwin", ["emulator"]), requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("READY");
    expect(resolveE2ERuntimeReadiness(input({ target: mobileTarget("ios"), capabilities: mobileDescriptor("ios", "darwin", ["simulator"]), requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("READY");
    const androidTarget = mobileTarget("android");
    expect(resolveE2ERuntimeReadiness(input({ target: androidTarget, capabilities: mobileDescriptor("android", "linux", ["emulator"], ["another-device"]), requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("INCOMPATIBLE");
    const electronTarget = desktopTarget("linux", "electron", "electron");
    const electron = E2ERuntimeCapabilityDescriptorSchema.parse({ ...baseWithoutBrowserDetails, profileId: "electron", kind: "electron", supportedSteps: ["launch-app"], supportedAssertions: ["file"], host: { os: "linux", arch: "x64" }, os: "linux", driver: "electron", isolatedSession: true });
    expect(resolveE2ERuntimeReadiness(input({ target: electronTarget, capabilities: electron, requiredSteps: ["launch-app"], requiredAssertions: ["file"] })).status).toBe("READY");
    const nativeTarget = desktopTarget("macos", "native", "native");
    const native = E2ERuntimeCapabilityDescriptorSchema.parse({ ...baseWithoutBrowserDetails, profileId: "native", kind: "native-desktop", supportedSteps: ["launch-app"], supportedAssertions: ["file"], host: { os: "darwin", arch: "arm64" }, os: "macos", driver: "native", isolatedSession: true });
    expect(resolveE2ERuntimeReadiness(input({ target: nativeTarget, capabilities: native, requiredSteps: ["launch-app"], requiredAssertions: ["file"] })).status).toBe("READY");
  });

  it("keeps non-ready profiles unavailable and preserves existing profiles when installation is disabled", () => {
    const existing = resolveE2ERuntimeReadiness(input({ installationEnabled: false }));
    expect(existing.status).toBe("READY");
    expect(toE2ERuntimeAvailability(existing, "auth-7").qualification).toBe("qualified");
    const nonReady: E2ERuntimeReadinessInput[] = [
      input({ activationEnabled: false }), input({ connection: "unconnected" }), input({ approval: "pending" }),
      input({ qualification: "unqualified" }), input({ state: "UNAVAILABLE" }), input({ capabilities: null }),
    ];
    for (const readinessInput of nonReady) {
      const readiness = resolveE2ERuntimeReadiness(readinessInput);
      expect(readiness.status).not.toBe("READY");
      expect(toE2ERuntimeAvailability(readiness, "auth-7")).toMatchObject({ connection: "unconnected", approval: "pending", qualification: "unqualified" });
    }
  });
});
