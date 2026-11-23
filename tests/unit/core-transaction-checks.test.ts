import { describe, expect, it } from "vitest";
import { change, when, type TransactItem } from "@agentx/contracts";
import { combinedChecks } from "../../packages/broker/src/core/task-flow/transaction-checks.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const key = { pk: "shared", sk: "META" };
const check = (field: string): TransactItem => ({ kind: "check", key, condition: when.eq(field, 1) });

for (const backend of ["memory", "dynamodb"] as const) describe(`transaction condition composition (${backend})`, () => {
  for (const kind of ["check", "update", "put", "delete"] as const) {
    for (const first of [true, false]) {
      for (const moved of [undefined, "original", "extra"] as const) it(`${kind}, check first=${first}, moved=${moved ?? "none"}`, async () => {
        const store = backend === "memory" ? new MemoryDocumentStore() : dynamoWorld().store;
        await store.put({ item: { ...key, original: 1, extra: 1 } });
        const action: TransactItem = kind === "put" ? { kind, item: { ...key, changed: true }, condition: when.eq("original", 1) }
          : kind === "update" ? { kind, key, ops: [change.set("changed", true)], condition: when.eq("original", 1) }
          : { kind, key, condition: when.eq("original", 1) };
        const extra = check("extra");
        const marker = { pk: "marker", sk: "META" };
        const items: TransactItem[] = [...(first ? [extra, action] : [action, extra]), { kind: "put", item: marker }];
        const before = structuredClone(items);
        if (moved !== undefined) await store.update({ key, ops: [change.set(moved, 2)] });
        const result = await store.transact(combinedChecks(items));
        expect(items).toEqual(before);
        expect(result.applied).toBe(moved === undefined);
        if (moved !== undefined) {
          expect(await store.get(marker)).toBeUndefined();
          expect(await store.get(key)).not.toHaveProperty("changed");
        } else {
          expect(await store.get(marker)).toBeDefined();
          if (kind === "delete") expect(await store.get(key)).toBeUndefined();
          if (kind === "put" || kind === "update") expect(await store.get(key)).toHaveProperty("changed", true);
        }
      });
    }
  }

  it("folds repeated checks into an unconditional write without losing any check", async () => {
    const store = backend === "memory" ? new MemoryDocumentStore() : dynamoWorld().store;
    await store.put({ item: { ...key, original: 1, extra: 2 } });
    const items: TransactItem[] = [check("original"), { kind: "update", key, ops: [change.set("changed", true)] }, check("extra")];
    expect((await store.transact(combinedChecks(items))).applied).toBe(false);
    expect(await store.get(key)).not.toHaveProperty("changed");
    await store.update({ key, ops: [change.set("extra", 1)] });
    expect((await store.transact(combinedChecks(items))).applied).toBe(true);
    expect(await store.get(key)).toHaveProperty("changed", true);
  });

  it("preserves separate partition and sort keys and refuses two writes to one item", async () => {
    const store = backend === "memory" ? new MemoryDocumentStore() : dynamoWorld().store;
    const rows = [{ ...key, original: 1 }, { pk: key.pk, sk: "other", original: 2 }, { pk: "other", sk: key.sk, original: 3 }];
    for (const item of rows) await store.put({ item });
    const items: TransactItem[] = rows.map((item, index) => ({ kind: "check", key: item, condition: when.eq("original", index + 1) }));
    expect((await store.transact(combinedChecks(items))).applied).toBe(true);
    const writes: TransactItem[] = [{ kind: "put", item: { ...key, replacement: true } },
      { kind: "update", key, ops: [change.set("replacement", true)] }, { kind: "delete", key }];
    for (const first of writes) for (const second of writes) {
      await expect(store.transact(combinedChecks([first, check("original"), second]))).rejects.toMatchObject({ code: "invalid_request" });
      expect(await store.get(key)).toEqual(rows[0]);
    }
  });
});
