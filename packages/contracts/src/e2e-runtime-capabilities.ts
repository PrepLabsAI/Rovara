import { z } from "zod";
import {
  E2EEvidenceScopeSchema,
  E2ERuntimeAvailabilitySchema,
  E2ETargetSchema,
  type E2EAssertion,
  type E2EEvidenceScope,
  type E2ERuntimeAvailability,
  type E2EStep,
  type E2ETarget,
} from "./e2e.js";

const id = (max = 120) => z.string().trim().min(1).max(max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T extends z.ZodType>(item: T) => z.array(item).refine((values) => new Set(values).size === values.length, "capabilities must be unique");

const stepKinds = ["navigate", "fill", "click", "agent", "request", "invoke-contract", "inspect-contract", "launch-app", "tap", "swipe", "deep-link", "restart-app", "set-permission", "choose-file"] as const satisfies readonly E2EStep["kind"][];
const assertionKinds = ["text", "visible", "csv", "http-status", "json", "state", "file"] as const satisfies readonly E2EAssertion["kind"][];
const common = {
  schemaVersion: z.literal("e2e-runtime-capabilities/v1"),
  profileId: id(120),
  host: z.object({ os: z.enum(["linux", "darwin", "win32"]), arch: z.enum(["arm64", "x64"]) }).strict(),
  engine: z.object({ name: id(120), version: id(120), spiVersion: z.literal(1) }).strict(),
  runtimeManifestDigest: digest,
  supportedSteps: unique(z.enum(stepKinds)),
  supportedAssertions: unique(z.enum(assertionKinds)),
  evidenceScopes: unique(E2EEvidenceScopeSchema),
  networkPolicyDigest: digest,
};
const webDetails = { browsers: unique(z.enum(["chromium", "firefox", "webkit"])) };
const apiDetails = { protocols: unique(z.literal("http")) };
const mobileDetails = {
  os: z.enum(["android", "ios"]),
  deviceKinds: unique(z.enum(["emulator", "simulator", "physical"])),
  deviceProfileIds: unique(id(120)),
};
const desktopDetails = {
  os: z.enum(["linux", "macos", "windows"]),
  driver: z.enum(["electron", "native"]),
  isolatedSession: z.literal(true),
};

export const E2ERuntimeCapabilityDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("default-sandbox") }).strict(),
  z.object({ ...common, kind: z.literal("web"), ...webDetails }).strict(),
  z.object({ ...common, kind: z.literal("api"), ...apiDetails }).strict(),
  z.object({ ...common, kind: z.literal("android"), ...mobileDetails, os: z.literal("android") }).strict(),
  z.object({ ...common, kind: z.literal("ios"), ...mobileDetails, os: z.literal("ios") }).strict(),
  z.object({ ...common, kind: z.literal("electron"), ...desktopDetails, driver: z.literal("electron") }).strict(),
  z.object({ ...common, kind: z.literal("native-desktop"), ...desktopDetails, driver: z.literal("native") }).strict(),
]).superRefine((descriptor, context) => {
  if (descriptor.kind === "ios" && descriptor.host.os !== "darwin") context.addIssue({ code: "custom", path: ["host", "os"], message: "iOS profiles require a Darwin host" });
  if (descriptor.kind === "android" && descriptor.host.os !== "linux" && descriptor.host.os !== "darwin") context.addIssue({ code: "custom", path: ["host", "os"], message: "Android profiles require a Linux or Darwin host" });
  if (descriptor.kind === "native-desktop" && hostOsForTarget(descriptor.os) !== descriptor.host.os) context.addIssue({ code: "custom", path: ["host", "os"], message: "native desktop OS must match its host" });
  if ((descriptor.kind === "electron" || descriptor.kind === "native-desktop") && descriptor.driver === "electron" && hostOsForTarget(descriptor.os) !== descriptor.host.os) context.addIssue({ code: "custom", path: ["host", "os"], message: "Electron target OS must match its host" });
});
export type E2ERuntimeCapabilityDescriptor = z.infer<typeof E2ERuntimeCapabilityDescriptorSchema>;

const DefaultSandboxTargetSchema = z.object({ targetId: id(80), runtimeProfileId: id(120), kind: z.literal("default-sandbox") }).strict();
const TargetInputSchema = z.union([E2ETargetSchema, DefaultSandboxTargetSchema]);
const readinessStatuses = ["READY", "MISSING", "EXPIRED", "UNQUALIFIED", "INCOMPATIBLE", "ACCESS_REQUIRED", "DISABLED"] as const;
const suggestedActions = ["install", "renew", "connect", "approve"] as const;
export const E2ERuntimeReadinessSchema = z.object({
  targetId: id(80),
  profileId: id(120),
  status: z.enum(readinessStatuses),
  reasonCode: id(80),
  requiredCapabilities: z.array(id(160)).max(64),
  supportedCapabilities: z.array(id(160)).max(128),
  suggestedAction: z.enum(suggestedActions).nullable(),
}).strict();
export type E2ERuntimeReadiness = z.infer<typeof E2ERuntimeReadinessSchema>;

export type E2ERuntimeReadinessInput = {
  target: E2ETarget | z.infer<typeof DefaultSandboxTargetSchema>;
  requiredSteps: E2EStep["kind"][];
  requiredAssertions: E2EAssertion["kind"][];
  minimumEvidence: E2EEvidenceScope;
  installationEnabled: boolean;
  activationEnabled: boolean;
  connection: "connected" | "unconnected";
  approval: "approved" | "pending" | "declined";
  qualification: "qualified" | "unqualified";
  state: "READY" | "PARKED" | "UNAVAILABLE";
  expiresAt: string | null;
  now: number;
  capabilities: E2ERuntimeCapabilityDescriptor | null;
};

const capabilityLabels = (steps: readonly string[], assertions: readonly string[], scopes: readonly string[]) => [
  ...steps.map((kind) => `step:${kind}`),
  ...assertions.map((kind) => `assertion:${kind}`),
  ...scopes.map((scope) => `evidence:${scope}`),
].sort();

function hostOsForTarget(os: "linux" | "macos" | "windows"): "linux" | "darwin" | "win32" {
  return os === "macos" ? "darwin" : os === "windows" ? "win32" : "linux";
}

function profileKindMatches(target: E2ERuntimeReadinessInput["target"], descriptor: E2ERuntimeCapabilityDescriptor): boolean {
  if (target.kind === "default-sandbox") return descriptor.kind === "default-sandbox";
  if (target.kind === "web") return descriptor.kind === "web";
  if (target.kind === "api") return descriptor.kind === "api";
  if (target.kind === "mobile") return (descriptor.kind === "android" || descriptor.kind === "ios") && descriptor.os === target.os;
  if (target.kind === "desktop") return (descriptor.kind === "electron" || descriptor.kind === "native-desktop")
    && descriptor.os === target.os && descriptor.driver === (target.driver === "electron" ? "electron" : "native");
  return false;
}

function targetCompatible(target: E2ERuntimeReadinessInput["target"], descriptor: E2ERuntimeCapabilityDescriptor): boolean {
  if (descriptor.profileId !== target.runtimeProfileId || !profileKindMatches(target, descriptor)) return false;
  if (target.kind === "web" && descriptor.kind === "web") return descriptor.browsers.includes(target.browser);
  if (target.kind === "api" && descriptor.kind === "api") return descriptor.protocols.includes(target.protocol);
  if (target.kind === "mobile" && (descriptor.kind === "android" || descriptor.kind === "ios")) {
    return descriptor.deviceProfileIds.includes(target.deviceProfileId);
  }
  if (target.kind === "desktop" && (descriptor.kind === "electron" || descriptor.kind === "native-desktop")) {
    return descriptor.os === target.os && descriptor.driver === (target.driver === "electron" ? "electron" : "native");
  }
  return target.kind === "default-sandbox" && descriptor.kind === "default-sandbox";
}

function readiness(input: E2ERuntimeReadinessInput, status: E2ERuntimeReadiness["status"], reasonCode: string, suggestedAction: E2ERuntimeReadiness["suggestedAction"] = null): E2ERuntimeReadiness {
  const descriptor = input.capabilities;
  return E2ERuntimeReadinessSchema.parse({
    targetId: input.target.targetId,
    profileId: input.target.runtimeProfileId,
    status,
    reasonCode,
    requiredCapabilities: capabilityLabels(input.requiredSteps, input.requiredAssertions, [input.minimumEvidence]),
    supportedCapabilities: descriptor === null ? [] : capabilityLabels(descriptor.supportedSteps, descriptor.supportedAssertions, descriptor.evidenceScopes),
    suggestedAction,
  });
}

/** Resolves trusted broker-projected runtime state. Descriptors alone do not qualify or register a runtime. */
export function resolveE2ERuntimeReadiness(input: E2ERuntimeReadinessInput): E2ERuntimeReadiness {
  const target = TargetInputSchema.safeParse(input.target);
  if (!target.success) throw new TypeError("runtime readiness target is invalid");
  if (!Number.isSafeInteger(input.now) || input.now < 0) return readiness(input, "EXPIRED", "INVALID_CLOCK");
  if (!input.activationEnabled) return readiness(input, "DISABLED", "ACTIVATION_DISABLED");
  if (input.capabilities === null) return readiness(input, "MISSING", "PROFILE_MISSING", input.installationEnabled ? "install" : null);
  const parsedDescriptor = E2ERuntimeCapabilityDescriptorSchema.safeParse(input.capabilities);
  if (!parsedDescriptor.success) return readiness({ ...input, capabilities: null }, "INCOMPATIBLE", "INVALID_DESCRIPTOR");
  if (input.connection !== "connected") return readiness(input, "ACCESS_REQUIRED", "CONNECTION_REQUIRED", "connect");
  if (input.approval !== "approved") return readiness(input, "ACCESS_REQUIRED", "APPROVAL_REQUIRED", "approve");
  if (input.qualification !== "qualified" || input.state !== "READY") return readiness(input, "UNQUALIFIED", input.qualification !== "qualified" ? "NOT_QUALIFIED" : "PROFILE_NOT_READY");
  if (input.expiresAt !== null) {
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.expiresAt)) return readiness(input, "EXPIRED", "INVALID_EXPIRY");
    if (input.now >= expiry) return readiness(input, "EXPIRED", "PROFILE_EXPIRED", "renew");
  }
  const descriptor = parsedDescriptor.data;
  if (!targetCompatible(target.data, descriptor)) return readiness(input, "INCOMPATIBLE", "TARGET_PROFILE_MISMATCH");
  const required = capabilityLabels(input.requiredSteps, input.requiredAssertions, []);
  const supported = new Set(capabilityLabels(descriptor.supportedSteps, descriptor.supportedAssertions, []));
  if (required.some((capability) => !supported.has(capability))) return readiness(input, "INCOMPATIBLE", "CAPABILITY_UNSUPPORTED");
  const evidenceOrder: E2EEvidenceScope[] = ["source", "mock-contract", "runtime", "external-live"];
  if (evidenceOrder.indexOf(input.minimumEvidence) > Math.max(...descriptor.evidenceScopes.map((scope) => evidenceOrder.indexOf(scope)), -1)) return readiness(input, "INCOMPATIBLE", "EVIDENCE_SCOPE_UNSUPPORTED");
  return readiness(input, "READY", "READY");
}

/** Converts descriptive readiness into the legacy projection without widening its trust semantics. */
export function toE2ERuntimeAvailability(readinessValue: E2ERuntimeReadiness, authorizationRevision: string): E2ERuntimeAvailability {
  const ready = E2ERuntimeReadinessSchema.parse(readinessValue).status === "READY";
  return E2ERuntimeAvailabilitySchema.parse({
    targetId: readinessValue.targetId,
    profileId: readinessValue.profileId,
    connection: ready ? "connected" : "unconnected",
    approval: ready ? "approved" : "pending",
    qualification: ready ? "qualified" : "unqualified",
    authorizationRevision,
  });
}

