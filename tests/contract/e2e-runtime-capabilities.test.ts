import { describe, expect, it } from "vitest";
import {
  E2ERuntimeCapabilityDescriptorSchema,
  E2ERuntimeReadinessSchema,
  resolveE2ERuntimeReadiness,
  toE2ERuntimeAvailability,
  type E2ERuntimeCapabilityDescriptor,
} from "../../packages/contracts/src/index.js";

const digest = "a".repeat(64);
const base = {
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
const { browsers: _baseBrowsers, ...baseWithoutBrowserDetails } = base;

const webTarget = {
  targetId: "web-app",
  applicationId: "app",
  runtimeProfileId: "web-profile",
  accountProfileId: "synthetic",
  kind: "web",
  browser: "chromium",
  viewport: { width: 1280, height: 720 },
} as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  } as Parameters<typeof resolveE2ERuntimeReadiness>[0];
}

describe("E2E runtime capability descriptor", () => {
  it("accepts each profile shape and rejects duplicate or unknown capabilities", () => {
    const descriptors: E2ERuntimeCapabilityDescriptor[] = [
      { ...baseWithoutBrowserDetails, kind: "default-sandbox", profileId: "default", supportedSteps: ["navigate"], supportedAssertions: ["text"], evidenceScopes: ["source"], host: { os: "linux", arch: "arm64" } },
      { ...base, kind: "web", browsers: ["chromium", "webkit"] },
      { ...baseWithoutBrowserDetails, kind: "api", profileId: "api", supportedSteps: ["request"], supportedAssertions: ["http-status"], evidenceScopes: ["runtime"], protocols: ["http"] },
      { ...baseWithoutBrowserDetails, kind: "android", profileId: "android", supportedSteps: ["launch-app"], supportedAssertions: ["visible"], evidenceScopes: ["runtime"], host: { os: "darwin", arch: "arm64" }, os: "android", deviceKinds: ["emulator", "physical"], deviceProfileIds: ["pixel"] },
      { ...baseWithoutBrowserDetails, kind: "ios", profileId: "ios", supportedSteps: ["launch-app"], supportedAssertions: ["visible"], evidenceScopes: ["runtime"], host: { os: "darwin", arch: "arm64" }, os: "ios", deviceKinds: ["simulator"], deviceProfileIds: ["iphone"] },
      { ...baseWithoutBrowserDetails, kind: "electron", profileId: "electron", supportedSteps: ["launch-app"], supportedAssertions: ["file"], evidenceScopes: ["runtime"], host: { os: "win32", arch: "x64" }, os: "windows", driver: "electron", isolatedSession: true },
      { ...baseWithoutBrowserDetails, kind: "native-desktop", profileId: "native", supportedSteps: ["launch-app"], supportedAssertions: ["file"], evidenceScopes: ["runtime"], host: { os: "darwin", arch: "arm64" }, os: "macos", driver: "native", isolatedSession: true },
    ];
    for (const descriptor of descriptors) expect(E2ERuntimeCapabilityDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...base, supportedSteps: ["navigate", "navigate"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...base, kind: "api", protocols: ["grpc"] }).success).toBe(false);
  });

  it("rejects platform-inconsistent profiles", () => {
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...base, kind: "ios", profileId: "ios", os: "ios", deviceKinds: ["simulator"], deviceProfileIds: ["iphone"] }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...base, kind: "native-desktop", profileId: "native", os: "windows", driver: "native", isolatedSession: true }).success).toBe(false);
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

  it("reports disabled and missing profiles without enabling installation implicitly", () => {
    expect(resolveE2ERuntimeReadiness(input({ activationEnabled: false })).status).toBe("DISABLED");
    const disabled = resolveE2ERuntimeReadiness(input({ capabilities: null, installationEnabled: false }));
    expect(disabled).toMatchObject({ status: "MISSING", suggestedAction: null });
    expect(resolveE2ERuntimeReadiness(input({ capabilities: null })).suggestedAction).toBe("install");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "2028-01-01T00:00:00.000Z" })).suggestedAction).toBe("renew");
  });

  it("reports access, qualification and external state separately", () => {
    expect(resolveE2ERuntimeReadiness(input({ connection: "unconnected" }))).toMatchObject({ status: "ACCESS_REQUIRED", suggestedAction: "connect" });
    expect(resolveE2ERuntimeReadiness(input({ approval: "pending" }))).toMatchObject({ status: "ACCESS_REQUIRED", suggestedAction: "approve" });
    expect(resolveE2ERuntimeReadiness(input({ approval: "declined" }))).toMatchObject({ status: "ACCESS_REQUIRED", suggestedAction: "approve" });
    expect(resolveE2ERuntimeReadiness(input({ qualification: "unqualified" })).status).toBe("UNQUALIFIED");
    expect(resolveE2ERuntimeReadiness(input({ state: "PARKED" })).status).toBe("UNQUALIFIED");
  });

  it("fails closed for invalid clocks and expired profiles", () => {
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "2028-01-01T00:00:00.000Z" })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ now: Number.NaN })).status).toBe("EXPIRED");
    expect(resolveE2ERuntimeReadiness(input({ expiresAt: "not-a-date" })).status).toBe("EXPIRED");
  });

  it("rejects target/profile and insufficient runtime capabilities", () => {
    expect(resolveE2ERuntimeReadiness(input({ target: { ...webTarget, runtimeProfileId: "other" } })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ capabilities: { ...base, browsers: ["firefox"] } })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ requiredSteps: ["launch-app"] })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ requiredAssertions: ["file"] })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ minimumEvidence: "external-live" })).status).toBe("INCOMPATIBLE");
    expect(resolveE2ERuntimeReadiness(input({ minimumEvidence: "source" })).status).toBe("READY");
  });

  it("matches API, Android, iOS, Electron and native desktop profiles to their target and host", () => {
    const api = { targetId: "api", applicationId: "app", runtimeProfileId: "api", accountProfileId: "synthetic", kind: "api", protocol: "http", originRef: "api-origin" } as const;
    expect(resolveE2ERuntimeReadiness(input({ target: api, capabilities: { ...baseWithoutBrowserDetails, profileId: "api", kind: "api", supportedSteps: ["request"], supportedAssertions: ["http-status"], protocols: ["http"] }, requiredSteps: ["request"], requiredAssertions: ["http-status"] })).status).toBe("READY");
    const mobile = (os: "android" | "ios", _host: "linux" | "darwin") => ({ targetId: os, applicationId: "app", runtimeProfileId: os, accountProfileId: "synthetic", kind: "mobile", os, appId: "app", deviceProfileId: "device-1" } as const);
    for (const [os, host] of [["android", "linux"], ["android", "darwin"], ["ios", "darwin"]] as const) {
      const descriptor = { ...baseWithoutBrowserDetails, profileId: os, kind: os, supportedSteps: ["launch-app"], supportedAssertions: ["visible"], host: { os: host, arch: "arm64" }, os, deviceKinds: [os === "android" ? "emulator" : "simulator"], deviceProfileIds: ["device-1"] } as const;
      expect(resolveE2ERuntimeReadiness(input({ target: mobile(os, host), capabilities: descriptor, requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("READY");
    }
    expect(resolveE2ERuntimeReadiness(input({ target: mobile("android", "linux"), capabilities: { ...baseWithoutBrowserDetails, profileId: "android", kind: "android", host: { os: "linux", arch: "arm64" }, os: "android", deviceKinds: ["emulator"], deviceProfileIds: ["another-device"] }, requiredSteps: ["launch-app"], requiredAssertions: ["visible"] })).status).toBe("INCOMPATIBLE");
    const desktop = (os: "linux" | "macos" | "windows", driver: "electron" | "native", profileId: string) => ({ targetId: "desktop", applicationId: "app", runtimeProfileId: profileId, accountProfileId: "synthetic", kind: "desktop", os, driver, appId: "app" } as const);
    const electron = { ...baseWithoutBrowserDetails, profileId: "electron", kind: "electron", supportedSteps: ["launch-app"], supportedAssertions: ["file"], host: { os: "linux", arch: "x64" }, os: "linux", driver: "electron", isolatedSession: true } as const;
    const electronReadiness = resolveE2ERuntimeReadiness(input({ target: desktop("linux", "electron", "electron"), capabilities: electron, requiredSteps: ["launch-app"], requiredAssertions: ["file"] }));
    expect(electronReadiness.status, electronReadiness.reasonCode).toBe("READY");
    const native = { ...baseWithoutBrowserDetails, profileId: "native", kind: "native-desktop", supportedSteps: ["launch-app"], supportedAssertions: ["file"], host: { os: "darwin", arch: "arm64" }, os: "macos", driver: "native", isolatedSession: true } as const;
    expect(resolveE2ERuntimeReadiness(input({ target: desktop("macos", "native", "native"), capabilities: native, requiredSteps: ["launch-app"], requiredAssertions: ["file"] })).status).toBe("READY");
  });

  it("keeps non-ready profiles unavailable and preserves existing profiles when installation is disabled", () => {
    const existing = resolveE2ERuntimeReadiness(input({ installationEnabled: false }));
    expect(existing.status).toBe("READY");
    expect(toE2ERuntimeAvailability(existing, "auth-7").qualification).toBe("qualified");
    for (const overrides of [{ activationEnabled: false }, { connection: "unconnected" }, { approval: "pending" }, { qualification: "unqualified" }, { state: "UNAVAILABLE" }, { capabilities: null }]) {
      const readiness = resolveE2ERuntimeReadiness(input(overrides));
      expect(readiness.status).not.toBe("READY");
      expect(toE2ERuntimeAvailability(readiness, "auth-7")).toMatchObject({ connection: "unconnected", approval: "pending", qualification: "unqualified" });
    }
  });
});
