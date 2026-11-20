import { describe, expect, it } from "vitest";
import * as contracts from "@agentx/contracts";
import * as ports from "../../packages/broker/src/ports/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { SqliteDocumentStore } from "../../packages/local-adapters/src/sqlite-document-store.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
const change = (pk: string, after: Record<string, unknown> = {}, before?: Record<string, unknown>): contracts.DocumentChange => ({ sequence: "1", kind: before === undefined ? "insert" : "modify", cause: "write", key: { pk, sk: "x" }, after: { pk, sk: "x", ...after }, ...(before === undefined ? {} : { before: { pk, sk: "x", ...before } }) });

describe("companyOfChange", () => {
  it.each([
    [change(contracts.companyScoped(A, "row")), A], [change("old", { companyId: A }), A], [change("old", { orgId: B }), B], [change("old"), contracts.IMPLICIT_COMPANY_ID],
    [change(contracts.companyScoped(A, "row"), { companyId: B }), undefined], [change("old", { companyId: "bad-canary" }), undefined],
    [change("old", { companyId: A, orgId: B }), undefined], [change("old", { companyId: A }, { companyId: B }), undefined],
    [change("ORG#bad#row"), undefined], [change("ORG##row"), undefined], [change("old", { companyId: null }), undefined],
    [{ ...change("old"), kind: "remove", after: undefined, before: { pk: "old", sk: "x", companyId: B } }, B],
  ])("classifies ownership without guessing %#", (input, expected) => { expect(contracts.companyOfChange(input as contracts.DocumentChange)).toBe(expected); });
});

for (const backend of ["memory", "sqlite", "dynamo"] as const) describe(`company view on ${backend}`, () => {
  it("delivers only the owner in order, reports ambiguity, and keeps legacy implicit rows", async () => {
    const sqlite = backend === "sqlite" ? SqliteDocumentStore.open({ path: ":memory:" }) : undefined;
    const dynamo = backend === "dynamo" ? dynamoWorld() : undefined;
    const memory = new MemoryDocumentStore();
    const store = sqlite ?? dynamo?.store ?? memory;
    const heard = new Map<string, contracts.DocumentChange[]>();
    const errors: unknown[] = [];
    const subs: contracts.ChangeSubscription[] = [];
    try {
      for (const companyId of [A, B, contracts.IMPLICIT_COMPANY_ID]) {
        heard.set(companyId, []);
        subs.push(await ports.companyChangeFeed(store.changes!, companyId, (event) => errors.push(event)).subscribe(companyId, async (batch) => {
          expect(batch.length).toBeGreaterThan(0); heard.get(companyId)!.push(...batch);
        }));
      }
      for (const item of [change(contracts.companyScoped(A, "one"), { marker: "A1" }), change(contracts.companyScoped(B, "one"), { marker: "B1" }), change(contracts.companyScoped(A, "two"), { marker: "A2" }), change("legacy"), change(contracts.companyScoped(A, "bad"), { companyId: B, marker: "secret" })]) await store.put({ item: item.after! });
      if (dynamo !== undefined) await dynamo.settled();
      else if (sqlite !== undefined) await sqlite.settled();
      else await memory.settled();
      expect(heard.get(A)?.map((c) => c.after?.marker)).toEqual(["A1", "A2"]);
      expect(heard.get(B)?.map((c) => c.after?.marker)).toEqual(["B1"]);
      expect(heard.get(contracts.IMPLICIT_COMPANY_ID)?.map((c) => c.key.pk)).toEqual(["legacy"]);
      expect(errors).toEqual(["company_change.ambiguous", "company_change.ambiguous", "company_change.ambiguous"]);
      expect(JSON.stringify(errors)).not.toContain(B);
    } finally { for (const sub of subs) await sub.stop(); await sqlite?.close(); }
  });
});
it("poison callbacks see only their company's batch and fixed error text", async () => {
  const store = new MemoryDocumentStore();
  const poisoned: unknown[] = [];
  const sub = await ports.companyChangeFeed(store.changes!, A).subscribe("a", async () => { throw new Error(`secret-${B}`); }, { onPoison: (batch, error) => poisoned.push({ batch, error: String(error) }) });
  await store.transact([change(contracts.companyScoped(A, "x")), change(contracts.companyScoped(B, "x"))].map((c) => ({ kind: "put", item: c.after! })));
  await store.settled(); await sub.stop();
  expect(poisoned).toHaveLength(1); expect(JSON.stringify(poisoned)).not.toContain(B); expect(JSON.stringify(poisoned)).not.toContain("secret");
});
it("never reclassifies a present undefined image company as implicit", () => {
  expect(contracts.companyOfChange(change("legacy", { companyId: undefined }))).toBeUndefined();
});
it("no valid company is a strict prefix of another; present longer prefix is refused", () => {
  expect(contracts.companyOfChange(change("legacy", { companyId: `${A}x` }))).toBeUndefined();
});
it("fails closed: malformed change envelopes are ambiguous", () => {
  for (const input of [null, {}, { ...change("legacy"), kind: "unknown" }, { ...change("legacy"), after: [] }, { ...change("legacy"), key: { pk: "legacy" } }]) expect(contracts.companyOfChange(input as contracts.DocumentChange)).toBeUndefined();
});
