import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson } from "@agentx/contracts";

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
  z.object({ kind: z.literal("tenant-refusal"), path: z.string().startsWith("/"), expectedStatus: z.literal(403), expectedOwnerTenant: z.string().min(1),
    forbiddenTenant: z.string().min(1), expectedOutcome: z.literal("assertion-failed") }).strict(),
]);
const probeSchema = z.object({ schemaVersion: z.literal("e2e-application-runtime-probe/v1"), probeId: z.string().min(1).max(120),
  kind: z.enum(["web", "api"]), polarity: z.enum(["positive", "negative"]), templateId: z.string().min(1).max(120),
  requiredCapabilities: z.array(z.string().min(1).max(120)).min(1).max(16), oracle: probeOracle }).strict().superRefine((value, context) => {
    const webTypes = ["csv", "csv-defect"].includes(value.oracle.kind) || value.oracle.kind === "viewer-refusal" && value.oracle.viewerIdentity !== undefined;
    const expectedOracle = value.kind === "web" ? webTypes || value.oracle.kind === "protected-network-denial"
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
