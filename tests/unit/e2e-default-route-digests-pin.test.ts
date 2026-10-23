import { describe, expect, it } from "vitest";
import { e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { SECRET_ARN } from "../support/e2e-model-fixtures.js";

// M1.4 Task 4.10B must hold: the failure-class work (a receipt field, six verifier codes, sentences) changes no route definition, so the digest of each provider's default route is the
// value it had at 38b55645. The values below were computed at that head (the keyed ones for the installation's secret ARN of tests/support/e2e-model-fixtures.ts) and are pinned.
const PINNED = {
  "amazon-bedrock": { installation: { provider: "amazon-bedrock", region: "us-east-1" }, digest: "01552c0c27e0b584697a1eeb8e5eb9570d46adfda8d7d5a58798ea9ebf59e71d", revision: "r1-1ca517bbc9f9" },
  anthropic: { installation: { provider: "anthropic", secretArn: SECRET_ARN }, digest: "60a2697c57d2924c8ece074d1ec9dbf86028cbf942dfe72817f08454e0ad6beb", revision: "r1-e5fe6d5062e9" },
  openai: { installation: { provider: "openai", secretArn: SECRET_ARN }, digest: "8da98f523e532db7b7b3e4914e5c6b22e3dae32a5d45a64b6ad514703950ef57", revision: "r1-caddd5789781" },
  openrouter: { installation: { provider: "openrouter", secretArn: SECRET_ARN }, digest: "5a50ca00b38246d2b82578520e93b1ece7ae1843ecf574922612970a37caafd0", revision: "r1-11b43bcbc1e5" },
} as const;

describe("default route digests do not move", () => {
  for (const [provider, pinned] of Object.entries(PINNED)) {
    it(`${provider}: the default route's definition digest and revision are the ones 38b55645 computed`, () => {
      const derived = deriveE2EAgentRoute(pinned.installation);
      if (derived.status !== "available") throw new Error("the fixture installation has no route");
      expect(e2eAgentRouteDefinitionDigest(derived.definition)).toBe(pinned.digest);
      expect(e2eModelRouteRevision(derived.definition)).toBe(pinned.revision);
    });
  }
});
