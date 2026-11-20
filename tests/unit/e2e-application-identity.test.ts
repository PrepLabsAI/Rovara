import { describe, expect, it } from "vitest";
import { APPLICATION_E2E_TEST_PATH } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { compareE2EApplicationPublicList, createE2EApplicationSelectionPacket, E2EApplicationSelectionPacketSchema } from "../../packages/verifier/src/application-identity.js";

const tuple = {
  caseId: "case-1", executionDescriptorDigest: "a".repeat(64),
  upstreamTestId: `${APPLICATION_E2E_TEST_PATH}::case-abc`, upstreamResultId: "b".repeat(64),
  title: "case-abc", targetId: "web-1", targetName: "web-1", platform: "web", agent: "default" as const,
  disposition: "run" as const, source: { file: APPLICATION_E2E_TEST_PATH, line: 1, column: 1 }, tags: [],
};

describe("application public-list identity", () => {

  it("refuses a public-list result that substitutes another same-platform target", () => {
  const packet = E2EApplicationSelectionPacketSchema.parse({ schemaVersion: 1, algorithm: "e2e-application-public-list-selection/v1",
      executionPlanDigest: "c".repeat(64), groupId: "group-1", shardId: "shard-1", targetId: "web-1", tuples: [tuple] });
    expect(() => compareE2EApplicationPublicList(packet, { pairs: [{ id: tuple.upstreamResultId,
      file: APPLICATION_E2E_TEST_PATH, title: tuple.title, titlePath: [tuple.title], kind: "test", session: undefined,
      sessions: [], serialId: undefined, target: "web-2", agent: "default", disposition: "run", tags: [],
      source: { file: APPLICATION_E2E_TEST_PATH, line: 1, column: 1 } }], unmatched: [] })).toThrow();
  });

  it("rejects missing one-target expected identities instead of filtering by platform", () => {
    expect(() => createE2EApplicationSelectionPacket({ plan: {} as never, groupId: "group-1", shardId: "shard-1",
      targetId: "web-1", targetPlatform: "web", titleByCaseId: new Map(), sourceByCaseId: new Map() })).toThrow();
  });

});
