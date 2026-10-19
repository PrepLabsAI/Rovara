import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";

/**
 * The one engine an API application target may name: Rovara's own first-party HTTP engine. It drives nothing (every request goes
 * through the owned API client); it exists so the runner can record each approved assertion as an upstream `assertion` step, through
 * the fixture it contributes. The descriptor is pinned: the compiler, the oracle and the collector accept an API engine only when
 * it matches this digest exactly. The version is the verifier package's own (a test keeps the two equal).
 */
export const ROVARA_HTTP_ENGINE_ASSERTION_FIXTURE = "agentxAssertions" as const;
export const ROVARA_HTTP_ENGINE_DESCRIPTOR = Object.freeze({ name: "rovara-http", version: "0.1.0", spiVersion: 1 as const, platform: "api",
  capabilities: Object.freeze([ROVARA_HTTP_ENGINE_ASSERTION_FIXTURE]) });
export const ROVARA_HTTP_ENGINE_DIGEST = createHash("sha256").update(canonicalJson(ROVARA_HTTP_ENGINE_DESCRIPTOR)).digest("hex");

type EngineDescriptor = Readonly<{ name: string; version: string; spiVersion: number; platform: string; workers?: number | undefined; capabilities: readonly string[] }>;

/** True only for an engine descriptor whose canonical digest is the pinned one; a different field, capability, order of keys aside, is not it. */
export function isPinnedRovaraHttpEngine(engine: EngineDescriptor | null | undefined): boolean {
  if (!engine) return false;
  const { name, version, spiVersion, platform, workers, capabilities } = engine;
  if (workers !== undefined) return false;
  return createHash("sha256").update(canonicalJson({ name, version, spiVersion, platform, capabilities: [...capabilities].sort() })).digest("hex") === ROVARA_HTTP_ENGINE_DIGEST;
}
