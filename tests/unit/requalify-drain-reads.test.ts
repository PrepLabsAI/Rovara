import { describe, expect, it } from "vitest";
import { REQUALIFY_DRAIN_ALLOWED_ATTRIBUTES, REQUALIFY_DRAIN_KEY_ATTRIBUTES, REQUALIFY_DRAIN_READS, REQUALIFY_DRAIN_READ_ATTRIBUTES, requalifyDrainProjection } from "../../packages/contracts/src/index.js";
import { requalifyDrainCount, requalifyDrainStatus } from "../../packages/broker/src/e2e/requalify-hold.js";
import { DRAIN_TABLE_AND_INDEX_KEYS, drainFixtureRows as rows, drainIamClient, type DrainRequest } from "../support/drain-iam-client.js";

import { DRAIN_FIXTURE_NOW as NOW } from "../support/drain-iam-client.js";
const TABLE = "state";

describe("the drain reads only what the narrowed DrainRead statement allows (DRAINREAD)", () => {
  it("counts the same rounds and setup runs when every read must name its attributes and sees only them", async () => {
    const { documentClient, requests } = drainIamClient(rows());
    const store = { documentClient, tableName: TABLE };
    expect(await requalifyDrainStatus(store, NOW)).toEqual({ drained: false, applicationRounds: 1, setupRuns: 2 });
    expect(await requalifyDrainCount(store, NOW)).toBe(3);
    // Positive control: the reads really ran, of all four kinds, each with a projection (a client that saw nothing would pass the count test for the wrong reason).
    expect(requests.filter((request) => request.command === "QueryCommand" && request.indexName === "bySessionState")).not.toHaveLength(0);
    expect(requests.filter((request) => request.command === "QueryCommand" && request.indexName === undefined).length).toBeGreaterThanOrEqual(3);
    expect(requests.filter((request) => request.command === "GetCommand")).not.toHaveLength(0);
    for (const request of requests) {
      expect(request.attributes, JSON.stringify(request)).toBeDefined();
      if (request.command === "QueryCommand") expect(request.select).toBe("SPECIFIC_ATTRIBUTES");
    }
  });

  it("asks for exactly the attributes of REQUALIFY_DRAIN_READS: the union of the projections it sends is the list the policy allows", async () => {
    const { documentClient, requests } = drainIamClient(rows());
    await requalifyDrainStatus({ documentClient, tableName: TABLE }, NOW);
    const sent = (match: (request: DrainRequest) => boolean) => [...new Set(requests.filter(match).flatMap((request) => request.attributes ?? []))].sort();
    expect(sent((request) => request.indexName === "bySessionState")).toEqual([...REQUALIFY_DRAIN_READS.sessions].sort());
    expect(sent((request) => request.command === "GetCommand")).toEqual([...REQUALIFY_DRAIN_READS.setupExecution].sort());
    expect(sent(() => true)).toEqual([...REQUALIFY_DRAIN_READ_ATTRIBUTES]);
    // The aliases hold the reserved words (`status`, `state`, `until`) so DynamoDB accepts the expression.
    const { ProjectionExpression, ExpressionAttributeNames } = requalifyDrainProjection("operations");
    expect(ProjectionExpression.split(", ").every((alias) => alias.startsWith("#drain"))).toBe(true);
    expect(Object.values(ExpressionAttributeNames)).toContain("status");
  });

  it.each([
    ["the sessions query", (request: DrainRequest) => request.indexName === "bySessionState"],
    ["a workspace's operations query", (request: DrainRequest) => request.command === "QueryCommand" && request.indexName === undefined && request.attributes?.includes("workflowMode") === true],
    ["the setup-marker query", (request: DrainRequest) => request.command === "QueryCommand" && request.indexName === undefined && request.attributes?.includes("setupExecutionId") === true],
    ["a setup execution read", (request: DrainRequest) => request.command === "GetCommand"],
  ])("throws, and never counts 0, when %s is refused", async (_name, deny) => {
    const store = { documentClient: drainIamClient(rows(), { deny }).documentClient, tableName: TABLE };
    await expect(requalifyDrainCount(store, NOW)).rejects.toThrow("refused");
    await expect(requalifyDrainStatus(store, NOW)).rejects.toThrow("refused");
  });

  it("throws when the policy would allow fewer attributes than the code reads (the drift this guards)", async () => {
    const narrower = REQUALIFY_DRAIN_ALLOWED_ATTRIBUTES.filter((attribute) => attribute !== "workflowMode");
    const store = { documentClient: drainIamClient(rows(), { allowed: narrower }).documentClient, tableName: TABLE };
    await expect(requalifyDrainCount(store, NOW)).rejects.toThrow(/workflowMode is not allowed/);
  });
  it("also needs the table's and the index's key attributes in dynamodb:Attributes: a list of only the projected names is refused (B1)", async () => {
    // The first list the policy had: projected names alone. DynamoDB cannot run the read without pk, sk and sessionState.
    const store = { documentClient: drainIamClient(rows(), { allowed: REQUALIFY_DRAIN_READ_ATTRIBUTES }).documentClient, tableName: TABLE };
    await expect(requalifyDrainCount(store, NOW)).rejects.toThrow(/key attributes pk, sk, sessionState/);
    // The key list in the contracts is the four keys (the contract test ties it to the synthesized schemas); with it the drain runs.
    expect([...REQUALIFY_DRAIN_KEY_ATTRIBUTES].sort()).toEqual([...DRAIN_TABLE_AND_INDEX_KEYS].sort());
    expect(await requalifyDrainCount({ documentClient: drainIamClient(rows()).documentClient, tableName: TABLE }, NOW)).toBe(3);
  });

  it("makes a read of an attribute the code did not project fail loudly, not skip the item (a fail-open the count tests might miss)", async () => {
    // The broker module reads the contracts package as built (dist), not the source file the rest of this test imports: mutate the object it really uses.
    const reads = (await import("@agentx/contracts")).REQUALIFY_DRAIN_READS as unknown as { operations: string[] };
    const original = reads.operations;
    reads.operations = original.filter((attribute) => attribute !== "workflowMode");
    try {
      await expect(requalifyDrainCount({ documentClient: drainIamClient(rows()).documentClient, tableName: TABLE }, NOW)).rejects.toThrow(/read "workflowMode"/);
    } finally { reads.operations = original; }
  });
});
