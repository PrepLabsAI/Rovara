// TE-F3-b: the holdout's limits: a per-task check limit (atomic, counted when a check starts), rotation of the questions, and pass/fail-only feedback.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { HOLDOUT_CHECKS_PER_TASK_CEILING, HOLDOUT_CHECKS_PER_TASK_DEFAULT, createDocumentHoldoutLedger, rotateHoldout } from "../../packages/contracts/src/eval-holdout.js";
import { evalGate, evalGateAgentFeedback } from "../../packages/contracts/src/eval-gate.js";
import { gateInput } from "../support/eval-gate-world.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
describe("the per-task holdout check limit", () => {
  it("allows the default number of checks for a task, numbers them, then says used up", async () => {
    const ledger = createDocumentHoldoutLedger(new MemoryDocumentStore(), { companyId: COMPANY });
    const got = [];
    for (let index = 0; index < 5; index += 1) got.push(await ledger.reserve({ project: "p1", task: "t1" }));
    expect(HOLDOUT_CHECKS_PER_TASK_DEFAULT).toBe(3);
    expect(got.map((entry) => entry.status)).toEqual(["allowed", "allowed", "allowed", "used_up", "used_up"]);
    expect(got.slice(0, 3)).toEqual([{ status: "allowed", checkIndex: 0, checksLeft: 2 }, { status: "allowed", checkIndex: 1, checksLeft: 1 }, { status: "allowed", checkIndex: 2, checksLeft: 0 }]);
  });
  it("counts each task, project and company separately", async () => {
    const store = new MemoryDocumentStore();
    const a = createDocumentHoldoutLedger(store, { companyId: COMPANY, limit: 1 });
    const b = createDocumentHoldoutLedger(store, { companyId: "org_bbbbbbbbbbbbbbbbbbbb", limit: 1 });
    expect((await a.reserve({ project: "p1", task: "t1" })).status).toBe("allowed");
    expect((await a.reserve({ project: "p1", task: "t1" })).status).toBe("used_up");
    expect((await a.reserve({ project: "p1", task: "t2" })).status).toBe("allowed");
    expect((await a.reserve({ project: "p2", task: "t1" })).status).toBe("allowed");
    expect((await b.reserve({ project: "p1", task: "t1" })).status).toBe("allowed");
  });
  it("holds under concurrency: ten checks at once, exactly the limit start", async () => {
    const ledger = createDocumentHoldoutLedger(new MemoryDocumentStore(), { companyId: COMPANY });
    const all = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve({ project: "p1", task: "t1" })));
    expect(all.filter((entry) => entry.status === "allowed")).toHaveLength(3);
  });
  it("never lets a project raise the limit above the ceiling, and a bad limit is the default", async () => {
    const big = createDocumentHoldoutLedger(new MemoryDocumentStore(), { companyId: COMPANY, limit: 99 });
    const states = [];
    for (let index = 0; index < 8; index += 1) states.push((await big.reserve({ project: "p", task: "t" })).status);
    expect(states.filter((state) => state === "allowed")).toHaveLength(HOLDOUT_CHECKS_PER_TASK_CEILING);
    const odd = createDocumentHoldoutLedger(new MemoryDocumentStore(), { companyId: COMPANY, limit: 0 });
    expect((await odd.reserve({ project: "p", task: "t" })).status).toBe("allowed");
    expect((await odd.reserve({ project: "p", task: "t" })).status).toBe("allowed");
    expect((await odd.reserve({ project: "p", task: "t" })).status).toBe("allowed");
    expect((await odd.reserve({ project: "p", task: "t" })).status).toBe("used_up");
  });
  it("fails closed: a store that throws, or an id that is not plain, is used up", async () => {
    const broken = createDocumentHoldoutLedger({ update: () => Promise.reject(new Error("down")) }, { companyId: COMPANY });
    expect((await broken.reserve({ project: "p", task: "t" })).status).toBe("used_up");
    const ledger = createDocumentHoldoutLedger(new MemoryDocumentStore(), { companyId: COMPANY });
    for (const bad of [{ project: "", task: "t" }, { project: "p", task: "a b" }, { project: "p#", task: "t" }, { project: "p", task: "x".repeat(201) }]) expect((await ledger.reserve(bad)).status).toBe("used_up");
    const odd = createDocumentHoldoutLedger({ update: () => Promise.resolve({ applied: true as const, item: { pk: "x", sk: "y", used: 99 } }) }, { companyId: COMPANY });
    expect((await odd.reserve({ project: "p", task: "t" })).status).toBe("used_up");
  });
  it("keeps its counters in the company's own partition", async () => {
    const store = new MemoryDocumentStore();
    await createDocumentHoldoutLedger(store, { companyId: COMPANY }).reserve({ project: "p", task: "t" });
    const found = await store.get({ pk: `ORG#${COMPANY}#EVALHOLDOUT`, sk: "T#p#t" });
    expect(found?.["used"]).toBe(1);
  });
});

describe("rotating the holdout questions", () => {
  const pool = Array.from({ length: 100 }, (_x, index) => `h-${String(index)}`);
  const secret = "a-rovara-side-secret-value";
  it("gives the same subset for the same inputs, of the size asked, from the pool", () => {
    const first = rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 0, secret });
    expect(first).toHaveLength(30);
    expect(first).toEqual(rotateHoldout({ poolIds: [...pool].reverse(), size: 30, taskId: "t1", checkIndex: 0, secret }));
    expect(first.every((id) => pool.includes(id))).toBe(true);
    expect(new Set(first).size).toBe(30);
  });
  it("gives a different subset for the next check of the same task and for another task", () => {
    const first = new Set(rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 0, secret }));
    const second = rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 1, secret });
    const third = rotateHoldout({ poolIds: pool, size: 30, taskId: "t2", checkIndex: 0, secret });
    expect(second.filter((id) => first.has(id)).length).toBeLessThan(25);
    expect(third.filter((id) => first.has(id)).length).toBeLessThan(25);
  });
  it("rotates over time: many checks cover most of the pool", () => {
    const seen = new Set<string>();
    for (let task = 0; task < 20; task += 1) for (const id of rotateHoldout({ poolIds: pool, size: 30, taskId: `t${String(task)}`, checkIndex: 0, secret })) seen.add(id);
    expect(seen.size).toBeGreaterThan(95);
  });
  it("depends on the secret, and gives nothing without a real one", () => {
    const a = rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 0, secret });
    const b = rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 0, secret: "another-secret-value!!" });
    expect(a).not.toEqual(b);
    expect(rotateHoldout({ poolIds: pool, size: 30, taskId: "t1", checkIndex: 0, secret: "short" })).toEqual([]);
    expect(rotateHoldout({ poolIds: pool, size: 0, taskId: "t1", checkIndex: 0, secret })).toEqual([]);
    expect(rotateHoldout({ poolIds: pool.slice(0, 5), size: 30, taskId: "t1", checkIndex: 0, secret })).toHaveLength(5);
  });
  it("is what the gate scores: only the selected holdout questions count", () => {
    const input = gateInput();
    const holdout = input.holdout!;
    const selected = rotateHoldout({ poolIds: [...new Set(holdout.base.map((row) => row.id))], size: 25, taskId: "t1", checkIndex: 0, secret });
    const result = evalGate({ ...input, holdout: { ...holdout, selectedQuestionIds: selected } });
    expect(result.qualified).toBe(true);
    expect(result.holdout?.questions).toBe(25);
    expect(result.holdout?.excluded.notSelected).toBe(15);
    expect(evalGateAgentFeedback(result)).toEqual({ result: "pass" });
  });
});
