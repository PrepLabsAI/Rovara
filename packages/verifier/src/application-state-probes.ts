import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** The installed read-only state probes: the shape of `GET /api/orders/state` every sample must match before its value is compared. */
const STATE_PROBE_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze({
  "api-state-positive/v1": { type: "object", required: ["orders", "version"], additionalProperties: false,
    properties: { orders: { type: "string" }, version: { type: "integer" } } },
});

/** The manifest digest the executor gives an approved probe asset, from the probe id and the asset's own digest. */
export const e2eApplicationStateProbeManifestDigest = (probeId: string, assetSha256: string): string => sha(canonicalJson({ probeId, assetSha256 }));

/**
 * The approved state-probe document the executor reads for `probeId`, as the bytes it records and the digests that identify it, or undefined for a probe
 * that is not in the installed fixed inventory. Executor and broker both take it from here, so the broker can require the exact bytes and manifest digest.
 */
export function installedE2EApplicationStateProbeAsset(probeId: string): { bytes: Buffer; sha256: string; byteLength: number; manifestDigest: string } | undefined {
  const schema = Object.hasOwn(STATE_PROBE_SCHEMAS, probeId) ? STATE_PROBE_SCHEMAS[probeId] : undefined;
  if (schema === undefined) return undefined;
  const bytes = Buffer.from(canonicalJson(schema), "utf8");
  const sha256 = sha(bytes);
  return { bytes, sha256, byteLength: bytes.byteLength, manifestDigest: e2eApplicationStateProbeManifestDigest(probeId, sha256) };
}
