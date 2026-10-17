import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export type E2ECaseIdentityInput = Readonly<{
  scenarioId: string; targetId: string; requestedTargetId: string; accountProfileId: string; accountContextId: string; accountContextDigest: string;
  executionDescriptorDigest: string; minimumEvidence: string; requiredRealComponentIds: readonly string[]; agentId: string; repeat: number; assertionDigests: readonly string[];
}>;
export function e2eCaseIdentityDigest(input: E2ECaseIdentityInput): string {
  return createHash("sha256").update(canonicalJson([input.scenarioId, input.targetId, input.requestedTargetId, input.accountProfileId,
    input.accountContextId, input.accountContextDigest, input.executionDescriptorDigest, input.minimumEvidence,
    input.requiredRealComponentIds, input.agentId, input.repeat, input.assertionDigests])).digest("hex");
}
export function e2eCaseIdFromIdentity(input: E2ECaseIdentityInput): string { return `case-${e2eCaseIdentityDigest(input)}`; }
export function e2eUpstreamTestIdFromIdentity(input: E2ECaseIdentityInput): string { return `.agentx/e2e/generated-contract.test.ts::case-${e2eCaseIdentityDigest(input)}`; }
