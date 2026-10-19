import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WEB_API_REQUIRED_PROBES, canonicalJson } from "@agentx/contracts";

const probeOracle = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("csv"), downloadName: z.literal("orders.csv"), columns: z.array(z.string().min(1).max(64)).length(4),
    rows: z.array(z.array(z.string().max(128)).length(4)).length(2), forbiddenRows: z.array(z.array(z.string().max(128)).length(4)).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("csv-defect"), downloadName: z.literal("orders.csv"), forbiddenRow: z.array(z.string().max(128)).length(4), expectedOutcome: z.literal("assertion-failed") }).strict(),
  z.object({ kind: z.literal("viewer-refusal"), viewerIdentity: z.string().min(1).max(128).optional(), path: z.string().startsWith("/").optional(),
    expectedStatus: z.literal(403), visibleTestId: z.string().min(1).max(120).optional(), visibleText: z.string().min(1).max(256).optional(),
    identityPath: z.string().startsWith("/").optional(), identityRole: z.literal("viewer").optional() }).strict(),
  z.object({ kind: z.literal("protected-network-denial"), requiresKernelDenialCounter: z.literal(true), requiresAbsenceOfEffect: z.literal(true),
    candidateUiIsNotEvidence: z.literal(true).optional(), candidateResponseIsNotEvidence: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal("json-state"), path: z.string().startsWith("/"), expected: z.object({ version: z.number().int().positive(), tenantId: z.string().min(1), orderIds: z.array(z.string().min(1)).min(1).max(10) }).strict() }).strict(),
  z.object({ kind: z.literal("build-command-failure"), build: z.object({ program: z.literal("node"), args: z.array(z.string().min(1).max(512)).min(1).max(8),
    cwd: z.literal("."), timeoutMs: z.number().int().min(1_000).max(120_000), env: z.object({}).strict() }).strict(),
    expectedExitCode: z.literal(7), expectedUnavailableReason: z.literal("build-failed") }).strict(),
  z.object({ kind: z.literal("tenant-refusal"), path: z.string().startsWith("/"), expectedStatus: z.literal(403), expectedOwnerTenant: z.string().min(1),
    forbiddenTenant: z.string().min(1), expectedOutcome: z.literal("assertion-failed") }).strict(),
]);
const probeSchema = z.object({ schemaVersion: z.literal("e2e-application-runtime-probe/v1"), probeId: z.string().min(1).max(120),
  kind: z.enum(["web", "api", "build"]), polarity: z.enum(["positive", "negative"]), templateId: z.string().min(1).max(120),
  requiredCapabilities: z.array(z.string().min(1).max(120)).min(1).max(16), oracle: probeOracle }).strict().superRefine((value, context) => {
    const webTypes = ["csv", "csv-defect"].includes(value.oracle.kind) || value.oracle.kind === "viewer-refusal" && value.oracle.viewerIdentity !== undefined;
    const expectedOracle = value.kind === "build" ? value.oracle.kind === "build-command-failure" && value.polarity === "negative"
      : value.oracle.kind === "build-command-failure" ? false : value.kind === "web" ? webTypes || value.oracle.kind === "protected-network-denial"
      : ["json-state", "tenant-refusal"].includes(value.oracle.kind) || value.oracle.kind === "viewer-refusal" && value.oracle.path !== undefined
        || value.oracle.kind === "protected-network-denial";
    if (!expectedOracle) context.addIssue({ code: "custom", path: ["oracle"], message: "runtime probe oracle kind is incompatible with its platform profile" });
  });
const expected: Record<"web" | "api", { positive: readonly string[]; negative: readonly string[] }> = {
  web: { positive: ["web-csv-positive/v1", "web-auth-viewer-refusal/v1"], negative: ["web-csv-negative/v1", "web-egress-denial/v1"] },
  api: { positive: ["api-state-positive/v1", "api-auth-viewer-refusal/v1"], negative: ["api-tenant-negative/v1", "api-egress-denial/v1"] },
};
const filename = (probeId: string) => probeId.replaceAll("/", "-") + ".json";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export type E2EApplicationRuntimeProbe = Readonly<z.infer<typeof probeSchema> & { assetDigest: string }>;
export type E2EApplicationRuntimeProbeManifest = Readonly<{ schemaVersion: "e2e-application-runtime-probe-manifest/v1"; kind: "web" | "api";
  installedManifestDigest: string; positiveProbes: readonly E2EApplicationRuntimeProbe[]; negativeProbes: readonly E2EApplicationRuntimeProbe[]; manifestDigest: string }>;

export function createE2EApplicationRuntimeProbeManifest(input: { kind: "web" | "api"; capabilities: readonly string[]; installedManifestDigest: string }): E2EApplicationRuntimeProbeManifest {
  if (!/^[a-f0-9]{64}$/.test(input.installedManifestDigest) || input.capabilities.length > 64 || new Set(input.capabilities).size !== input.capabilities.length) throw new Error("application probe manifest identity or capability set is invalid");
  const capabilities = new Set(input.capabilities);
  const ids = [...expected[input.kind].positive, ...expected[input.kind].negative];
  const probes = ids.map((probeId) => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "../assets/application-runtime-v1/probes", filename(probeId));
    const bytes = readFileSync(path);
    if (bytes.byteLength > 16_384) throw new Error("installed runtime probe asset exceeds its bound");
    const parsed = probeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (parsed.probeId !== probeId || parsed.kind !== input.kind || parsed.templateId !== probeId
      || !parsed.requiredCapabilities.every((capability) => capabilities.has(capability))) throw new Error("installed probe asset does not match the requested platform capabilities or fixed identity");
    return { ...parsed, assetDigest: sha(bytes) };
  });
  const positiveProbes = probes.filter((probe) => probe.polarity === "positive").sort((a, b) => a.probeId.localeCompare(b.probeId));
  const negativeProbes = probes.filter((probe) => probe.polarity === "negative").sort((a, b) => a.probeId.localeCompare(b.probeId));
  const body = { schemaVersion: "e2e-application-runtime-probe-manifest/v1" as const, kind: input.kind, installedManifestDigest: input.installedManifestDigest, positiveProbes, negativeProbes };
  return { ...body, manifestDigest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}

/** One installed probe asset of the web/API profile, with the digest of its exact bytes. */
export type E2EWebApiQualificationProbeAsset = Readonly<{ probeId: string; kind: "web" | "api" | "build"; polarity: "positive" | "negative"; assetDigest: string;
  probe: z.infer<typeof probeSchema> }>;

/**
 * Loads exactly the probe assets `linux-arm64-web-api-v1` requires (the auth and tenant probes belong to a later milestone), each bound
 * to its fixed identity and to the digest pinned in contracts. The qualification ids are the asset file names, `web-csv-positive-v1` for `web-csv-positive/v1`.
 */
export function loadWebApiQualificationProbeAssets(root = join(dirname(fileURLToPath(import.meta.url)), "../assets/application-runtime-v1/probes")): readonly E2EWebApiQualificationProbeAsset[] {
  return WEB_API_REQUIRED_PROBES.map((required) => {
    const bytes = readFileSync(join(root, `${required.probeId}.json`));
    if (bytes.byteLength > 16_384) throw new Error("installed runtime probe asset exceeds its bound");
    // The asset is the one pinned in contracts or nothing is built from it.
    if (sha(bytes) !== required.assetDigest) throw new Error(`probe-asset-digest-mismatch:${required.probeId}`);
    const probe = probeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const assetId = required.probeId.replace(/-v1$/, "/v1");
    if (probe.probeId !== assetId || probe.templateId !== assetId || probe.kind !== required.kind
      || probe.polarity !== (required.expectedOutcome === "PASS" ? "positive" : "negative")) throw new Error("installed probe asset does not match its fixed qualification identity");
    return { probeId: required.probeId, kind: probe.kind, polarity: probe.polarity, assetDigest: sha(bytes), probe };
  });
}
