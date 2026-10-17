import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { E2ERuntimeCapabilityDescriptorSchema, type E2ERuntimeCapabilityDescriptor } from "./e2e-runtime-capabilities.js";
import { Ec2RuntimeBindingSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema } from "./session.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = (max = 120) => z.string().trim().min(1).max(max);
const uniqueIds = (max = 64) => z.array(identifier()).min(1).max(max).refine((items) => new Set(items).size === items.length, "probe identifiers must be unique");

function parseStrictUtcIsoTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const millis = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millis) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp === date.getTime() ? timestamp : null;
}

function strictTimestamp() {
  return z.string().superRefine((value, context) => {
    if (parseStrictUtcIsoTimestamp(value) === null) context.addIssue({ code: "custom", message: "timestamp must be a real UTC ISO date and time" });
  });
}

const fixturePath = z.string().min(1).max(1024).superRefine((path, context) => {
  if (path !== path.trim() || path.startsWith("/") || path.includes("\\") || path.includes("\u0000")
    || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
    || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    context.addIssue({ code: "custom", message: "fixture path must be normalized relative POSIX syntax" });
  }
});

const probeManifestFields = {
  schemaVersion: z.literal("e2e-runtime-probe-manifest/v1"),
  profileId: identifier(120),
  capabilityDigest: digest,
  runtimeManifestDigest: digest,
  suiteDigest: digest,
  fixtureRefs: z.array(z.object({ path: fixturePath, sha256: digest }).strict()).max(128)
    .refine((items) => new Set(items.map((item) => item.path)).size === items.length, "fixture paths must be unique"),
  positiveProbeIds: uniqueIds(128),
  negativeProbeIds: uniqueIds(128),
};
const E2ERuntimeProbeManifestContentSchema = z.object(probeManifestFields).strict()
  .refine((manifest) => manifest.positiveProbeIds.every((id) => !manifest.negativeProbeIds.includes(id)), "positive and negative probes must be distinct");
export const E2ERuntimeProbeManifestSchema = z.object({ ...probeManifestFields, manifestDigest: digest }).strict().superRefine((manifest, context) => {
  if (manifest.positiveProbeIds.some((id) => manifest.negativeProbeIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["negativeProbeIds"], message: "positive and negative probes must be distinct" });
  }
  const { manifestDigest, ...content } = manifest;
  void manifestDigest;
  const parsed = E2ERuntimeProbeManifestContentSchema.safeParse(content);
  if (!parsed.success) return;
  const expected = createHash("sha256").update(canonicalJson(parsed.data)).digest("hex");
  if (manifest.manifestDigest !== expected) context.addIssue({ code: "custom", path: ["manifestDigest"], message: "probe manifest digest must identify its canonical content" });
});
export type E2ERuntimeProbeManifest = z.infer<typeof E2ERuntimeProbeManifestSchema>;

export function e2eRuntimeCapabilityDigest(descriptor: E2ERuntimeCapabilityDescriptor): string {
  const parsed = E2ERuntimeCapabilityDescriptorSchema.parse(descriptor);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

/** Confirms identity with a server-owned installed oracle manifest; the descriptor records intent, not probe execution. */
export function assertE2ERuntimeProbeManifestIdentity(actual: unknown, installedExpected: unknown): void {
  const actualParsed = E2ERuntimeProbeManifestSchema.parse(actual);
  const expectedParsed = E2ERuntimeProbeManifestSchema.parse(installedExpected);
  if (canonicalJson(actualParsed) !== canonicalJson(expectedParsed)) throw new TypeError("runtime probe manifest does not match the installed fixed oracle");
}

export const E2EQualificationEvidenceRefSchema = z.object({
  key: z.string().trim().min(1).max(1024), sha256: digest, byteLength: z.number().int().positive().max(67_108_864),
}).strict();
export type E2EQualificationEvidenceRef = z.infer<typeof E2EQualificationEvidenceRefSchema>;

const runtimeRecordFields = {
  schemaVersion: z.literal(2),
  entityType: z.literal("E2E_FEATURE_VERIFIER"),
  runtimeCatalogId: identifier(160),
  profileId: identifier(120),
  catalogRevision: z.number().int().positive(),
  generation: z.number().int().positive(),
  binding: Ec2RuntimeBindingSchema,
  bindingDigest: digest,
  endpoint: z.string().url().max(512).refine((value) => {
    const parsed = new URL(value);
    return parsed.username === "" && parsed.password === "";
  }, "runtime endpoint must not include credentials"),
  transportCorrelationId: z.string().uuid(),
  manifestDigest: digest,
  runnerEnvironment: ProjectSetupRunnerEnvironmentSchema,
  runnerEnvironmentDigest: digest,
  runnerToolchain: ProjectSetupRunnerToolchainSchema,
  runnerToolchainDigest: digest,
  state: z.enum(["READY", "PARKED", "UNAVAILABLE"]),
  qualifiedAt: strictTimestamp(),
  expiresAt: strictTimestamp(),
  capabilities: E2ERuntimeCapabilityDescriptorSchema,
  capabilityDigest: digest,
  probeManifest: E2ERuntimeProbeManifestSchema,
  qualificationEvidenceRef: E2EQualificationEvidenceRefSchema,
};
export const E2ERegisteredRuntimeSchema = z.object(runtimeRecordFields).strict().superRefine((record, context) => {
  const checkDigest = (path: string, value: unknown, expected: string) => {
    if (createHash("sha256").update(canonicalJson(value)).digest("hex") !== expected) {
      context.addIssue({ code: "custom", path: [path], message: `${path} must identify its exact canonical value` });
    }
  };
  checkDigest("bindingDigest", record.binding, record.bindingDigest);
  checkDigest("runnerEnvironmentDigest", record.runnerEnvironment, record.runnerEnvironmentDigest);
  checkDigest("runnerToolchainDigest", record.runnerToolchain, record.runnerToolchainDigest);
  if (e2eRuntimeCapabilityDigest(record.capabilities) !== record.capabilityDigest) {
    context.addIssue({ code: "custom", path: ["capabilityDigest"], message: "capability digest must identify the exact descriptor" });
  }
  if (record.capabilities.profileId !== record.profileId || record.probeManifest.profileId !== record.profileId) {
    context.addIssue({ code: "custom", path: ["profileId"], message: "runtime, capability, and probe profile identities must match" });
  }
  if (record.probeManifest.capabilityDigest !== record.capabilityDigest) {
    context.addIssue({ code: "custom", path: ["probeManifest", "capabilityDigest"], message: "probe manifest must identify the registered capabilities" });
  }
  if (record.probeManifest.runtimeManifestDigest !== record.capabilities.runtimeManifestDigest) {
    context.addIssue({ code: "custom", path: ["probeManifest", "runtimeManifestDigest"], message: "probe and capability runtime manifests must match" });
  }
  if (record.manifestDigest !== record.probeManifest.manifestDigest) {
    context.addIssue({ code: "custom", path: ["manifestDigest"], message: "record and probe manifest digests must match" });
  }
  if (record.capabilities.host.os !== record.runnerToolchain.platform || record.capabilities.host.arch !== record.runnerToolchain.arch
    || record.runnerEnvironment.arch !== record.runnerToolchain.arch) {
    context.addIssue({ code: "custom", path: ["runnerToolchain"], message: "capability host and runner toolchain identities must match" });
  }
  const qualifiedAt = parseStrictUtcIsoTimestamp(record.qualifiedAt);
  const expiresAt = parseStrictUtcIsoTimestamp(record.expiresAt);
  if (qualifiedAt !== null && expiresAt !== null && qualifiedAt >= expiresAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "runtime expiry must follow qualification" });
  }
});
export type E2ERegisteredRuntime = z.infer<typeof E2ERegisteredRuntimeSchema>;
