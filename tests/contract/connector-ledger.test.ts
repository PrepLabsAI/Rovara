import { describe, expect, it } from "vitest";
import { DynamoConnectorLedger, GITHUB_LEDGER, connectorLedgerKeys } from "../../packages/broker/src/aws/connector-ledger.js";
import type { Invocation } from "../../packages/gateway/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const invocation = (status: Invocation["result"]["status"]): Invocation => ({
  requestId: "0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11", workspaceId: "w1", ownerKey: "owner", repository: "payments", tool: "create_issue",
  fingerprint: "f".repeat(64), createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
  result: { requestId: "0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11", status, text: "", truncated: false, replayed: false },
});

describe("connector ledger", () => {
  it("writes new connectors under CONNECTOR#<name># and claims each request once", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", connectorLedgerKeys("linear"), "linear");
    expect(await ledger.claim(invocation("IN_PROGRESS"))).toBe(true);
    expect(await ledger.claim(invocation("IN_PROGRESS"))).toBe(false);
    await ledger.finish(invocation("SUCCEEDED"));
    expect(db.get("WORKSPACE#w1", "CONNECTOR#linear#0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11"))
      .toMatchObject({ entityType: "CONNECTOR_INVOCATION", connector: "linear", result: { status: "SUCCEEDED" } });
    expect((await ledger.get(invocation("IN_PROGRESS").requestId))?.result.status).toBe("SUCCEEDED");
  });

  it("keeps the feature 007 key for the github connector", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", GITHUB_LEDGER, "github");
    await ledger.claim(invocation("IN_PROGRESS"));
    expect(db.get("WORKSPACE#w1", "GITHUB_MCP#0f0e8a52-5a4c-4c1e-9d55-3d1f4f0f6a11"))
      .toMatchObject({ entityType: "GITHUB_MCP_INVOCATION", connector: "github" });
  });

  it("refuses to finish a record that is no longer in progress", async () => {
    const db = new FakeDynamoDb();
    const ledger = new DynamoConnectorLedger(db as never, "state", "w1", connectorLedgerKeys("jira"), "jira");
    await ledger.claim(invocation("IN_PROGRESS"));
    await ledger.finish(invocation("FAILED"));
    await expect(ledger.finish(invocation("SUCCEEDED"))).rejects.toThrow();
  });
});
