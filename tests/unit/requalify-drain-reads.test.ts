import { describe, expect, it } from "vitest";
import { REQUALIFY_DRAIN_KEY_ATTRIBUTES, REQUALIFY_DRAIN_READS, REQUALIFY_DRAIN_READ_ATTRIBUTES, requalifyDrainProjection } from "../../packages/contracts/src/index.js";
import { requalifyDrainCount, requalifyDrainStatus } from "../../packages/broker/src/e2e/requalify-hold.js";
import { DRAIN_TABLE_AND_INDEX_KEYS, drainFixtureRows as rows, drainIamClient, type DrainRequest } from "../support/drain-iam-client.js";

import { DRAIN_FIXTURE_NOW as NOW } from "../support/drain-iam-client.js";
const TABLE = "state";

describe("the drain reads only what the narrowed DrainRead statement allows (DRAINREAD)", () => {

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


  it("also needs the table's and the index's key attributes in dynamodb:Attributes: a list of only the projected names is refused (B1)", async () => {
    // The first list the policy had: projected names alone. DynamoDB cannot run the read without pk, sk and sessionState.
    const store = { documentClient: drainIamClient(rows(), { allowed: REQUALIFY_DRAIN_READ_ATTRIBUTES }).documentClient, tableName: TABLE };
    await expect(requalifyDrainCount(store, NOW)).rejects.toThrow(/key attributes pk, sk, sessionState/);
    // The key list in the contracts is the four keys (the contract test ties it to the synthesized schemas); with it the drain runs.
    expect([...REQUALIFY_DRAIN_KEY_ATTRIBUTES].sort()).toEqual([...DRAIN_TABLE_AND_INDEX_KEYS].sort());
    expect(await requalifyDrainCount({ documentClient: drainIamClient(rows()).documentClient, tableName: TABLE }, NOW)).toBe(3);
  });

});
