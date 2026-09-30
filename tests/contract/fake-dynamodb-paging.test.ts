// The shared fake table's paging (spec 025 phase 25d): a loop that follows LastEvaluatedKey reads
// every item exactly once, on each key condition shape the broker pages through.
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

type Page = { Items: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };

/** Sends the query page by page, following LastEvaluatedKey, as the broker's loops do. */
async function readAll(db: FakeDynamoDb, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await db.send({ constructor: { name: "QueryCommand" }, input: { ...input, ...(start === undefined ? {} : { ExclusiveStartKey: start }) } }) as Page;
    items.push(...page.Items);
    start = page.LastEvaluatedKey;
    if (start === undefined) return items;
  }
  throw new Error("the query never finished paging");
}

describe("FakeDynamoDb paging", () => {
  it("pages a single-attribute index through every item once", async () => {
    const db = new FakeDynamoDb();
    for (const id of ["c", "a", "e", "b", "d"]) db.set({ pk: `WORKSPACE#${id}`, sk: "META", workspaceProject: "payments" });
    db.set({ pk: "WORKSPACE#z", sk: "META", workspaceProject: "other" });
    const items = await readAll(db, {
      IndexName: "byWorkspaceProject", KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": "workspaceProject" }, ExpressionAttributeValues: { ":project": "payments" }, Limit: 2,
    });
    expect(items.map((item) => item.pk).sort()).toEqual(["WORKSPACE#a", "WORKSPACE#b", "WORKSPACE#c", "WORKSPACE#d", "WORKSPACE#e"]);
  });

  it("pages an index sort key range without skipping items that share a sort value", async () => {
    const db = new FakeDynamoDb();
    for (const [id, at] of [["a", "2026-09-01"], ["b", "2026-09-02"], ["c", "2026-09-02"], ["d", "2026-09-02"], ["e", "2026-09-03"]] as const) {
      db.set({ pk: `TURN#${id}`, sk: "META", exportPk: "ALL", exportSk: at });
    }
    for (const forward of [true, false]) {
      const items = await readAll(db, {
        IndexName: "byTime", KeyConditionExpression: "exportPk = :partition AND exportSk >= :since",
        ExpressionAttributeValues: { ":partition": "ALL", ":since": "2026-09-01" }, ScanIndexForward: forward, Limit: 2,
      });
      expect(items.map((item) => item.pk).sort()).toEqual(["TURN#a", "TURN#b", "TURN#c", "TURN#d", "TURN#e"]);
      expect(items.map((item) => item.exportSk)).toEqual(forward
        ? ["2026-09-01", "2026-09-02", "2026-09-02", "2026-09-02", "2026-09-03"]
        : ["2026-09-03", "2026-09-02", "2026-09-02", "2026-09-02", "2026-09-01"]);
    }
  });

  it("pages the older-than range through every item once", async () => {
    const db = new FakeDynamoDb();
    for (const sk of ["2026-09-01#a", "2026-09-02#b", "2026-09-03#c", "2026-09-04#d", "2026-09-30#late"]) db.set({ pk: "SETUP_WATCH", sk });
    const items = await readAll(db, {
      KeyConditionExpression: "pk = :pk AND sk < :cutoff", ExpressionAttributeValues: { ":pk": "SETUP_WATCH", ":cutoff": "2026-09-10" }, Limit: 2,
    });
    expect(items.map((item) => item.sk)).toEqual(["2026-09-01#a", "2026-09-02#b", "2026-09-03#c", "2026-09-04#d"]);
  });
});
