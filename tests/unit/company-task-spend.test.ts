// L4-TSU: the flow's `taskSpendUsd` on a hosted root. It says what ONE task of ONE company has cost (the settled total in that company's cost ledger), fresh at each call, and anything it cannot say as
// a complete figure throws instead (automatic fixing then asks the owner; unknown is never "nothing spent"). Each guard has a test that fails without it (the mutants are listed in briefs/lead4/L4-TSU-MUTANTS-20261118.md).
import { describe, expect, it, vi } from "vitest";
import type { OrgId, StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { TASK_SPEND_UNKNOWN, createCompanyTaskSpend, type TaskSpendRefusal } from "../../packages/broker/src/core-host/company-task-spend.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId, B = COMPANY_B_ID as OrgId;
const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";

/** A TOTAL row as the ledger writes it (core/cost/ledger.ts), with whatever a test changes (an override of `undefined` removes the field). */
const total = (companyId: OrgId, taskId: string, over: Record<string, unknown> = {}): StoredDocument => {
  const row: Record<string, unknown> = {
    pk: costPartition(companyId, taskId), sk: "TOTAL", entityType: "COST_TOTAL", companyId, taskId, currency: "USD", micros: 4_250_000, entries: 3, unpricedEntries: 0,
    tokensInput: 10, tokensOutput: 10, tokensCacheRead: 0, tokensCacheWrite: 0, ...over,
  };
  for (const [name, value] of Object.entries(row)) if (value === undefined) delete row[name];
  return row as StoredDocument;
};

const WS = "ws-spend-1";
interface Run { id: string; workflowMode?: string; status: string; kind?: string; usageUnflushed?: true; booked?: "usage" | "checkpoint" | "none"; machineless?: true }
/** The task's runs as a healthy hosted task has them: a coding run and a review run that succeeded, each with its end report booked. */
const HEALTHY: Run[] = [{ id: "op-1", workflowMode: "IMPLEMENT", status: "SUCCEEDED" }, { id: "op-2", workflowMode: "REVIEW", status: "SUCCEEDED" }];

/**
 * A real in-memory store with the task, its workspace, its runs and their booked end reports of one company, and exactly the TOTAL rows given (a row a real store would refuse to write, such as a
 * non-finite number, is still a row a bad write could leave, so TOTAL reads are answered from a plain map).
 */
async function rowStore(rows: StoredDocument[], options: { runs?: Run[]; company?: OrgId; noTask?: boolean; taskCompany?: OrgId; workspaceFor?: OrgId[] } = {}) {
  const memory = new MemoryDocumentStore();
  const held = new Map(rows.map((row) => [`${row["pk"]}|${row["sk"]}`, row]));
  const company = options.company ?? A;
  if (options.noTask !== true) await memory.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: options.taskCompany ?? company, workspaceId: WS } });
  let at = 0;
  for (const owner of options.workspaceFor ?? [company]) {
    await memory.put({ item: { ...workspaceKey(owner, WS), entityType: "WORKSPACE", id: WS, companyId: owner, orgId: owner } });
    for (const run of options.runs ?? HEALTHY) {
      at += 1;
      await memory.put({ item: { ...operationKey(owner, WS, run.id), entityType: "OPERATION", id: run.id, companyId: owner, kind: run.kind ?? "task", ...(run.workflowMode === undefined ? {} : { workflowMode: run.workflowMode }), status: run.status, ...(run.machineless === true ? {} : { machineId: "machine-1" }), createdAt: `2026-11-18T07:00:${String(at).padStart(2, "0")}.000Z`, fence: at, ...(run.usageUnflushed === true ? { usageUnflushed: true } : {}) } });
      if (run.booked !== "none" && run.booked !== "checkpoint") await memory.put({ item: { pk: costPartition(owner, TASK), sk: `ENTRY#usage:${run.id}:abc`, entityType: "COST_ENTRY", companyId: owner, taskId: TASK } });
      if (run.booked === "checkpoint") await memory.put({ item: { pk: costPartition(owner, TASK), sk: `ENTRY#usage-checkpoint:${run.id}:abc`, entityType: "COST_ENTRY", companyId: owner, taskId: TASK } });
    }
  }
  const store = new Proxy(memory, {
    get(target, property) {
      if (property === "get") return async (key: { pk: string; sk: string }) => (key.sk === "TOTAL" ? held.get(`${key.pk}|${key.sk}`) : target.get(key));
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    store,
    put: (row: StoredDocument) => { held.set(`${row["pk"]}|${row["sk"]}`, row); },
    remove: (key: { pk: string; sk: string }) => { held.delete(`${key.pk}|${key.sk}`); },
  };
}

async function world(rows: StoredDocument[], refused?: (reason: TaskSpendRefusal) => void | Promise<void>, options: Parameters<typeof rowStore>[1] = {}) {
  const held = await rowStore(rows, options);
  return { store: held, spend: createCompanyTaskSpend({ store: held.store, companyId: A, ...(refused === undefined ? {} : { refused }) }) };
}

describe("the hosted task spend reader (L4-TSU)", () => {

  it("a row that names another company or another task is no figure for this one", async () => {
    for (const over of [{ companyId: B }, { taskId: OTHER_TASK }, { companyId: undefined }, { taskId: undefined }]) {
      const reasons: TaskSpendRefusal[] = [];
      const { spend } = await world([total(A, TASK, over)], (reason) => { reasons.push(reason); });
      await expect(spend(TASK), JSON.stringify(over)).rejects.toThrow(TASK_SPEND_UNKNOWN);
      expect(reasons).toEqual(["other_owner"]);
    }
  });

  it("unknown is never zero: no row, a floor, another currency, dollars with no currency, figures that are not whole numbers, a store fault and a bad task id all refuse in fixed words", async () => {
    const cases: Array<[string, StoredDocument[], TaskSpendRefusal]> = [
      ["no row", [], "not_recorded"],
      ["a call with no price", [total(A, TASK, { unpricedEntries: 1 })], "unpriced_usage"],
      ["another currency", [total(A, TASK, { currency: "EUR" })], "other_currency"],
      ["a currency that is not a string", [total(A, TASK, { currency: 5 })], "other_currency"],
      ["dollars with no currency", [total(A, TASK, { currency: undefined })], "unreadable_figures"],
      ["micros missing", [total(A, TASK, { micros: undefined })], "unreadable_figures"],
      ["micros negative", [total(A, TASK, { micros: -1 })], "unreadable_figures"],
      ["micros fractional", [total(A, TASK, { micros: 1.5 })], "unreadable_figures"],
      ["micros a string", [total(A, TASK, { micros: "4250000" })], "unreadable_figures"],
      ["micros not finite", [total(A, TASK, { micros: Number.POSITIVE_INFINITY })], "unreadable_figures"],
      ["unpriced count missing", [total(A, TASK, { unpricedEntries: undefined })], "unreadable_figures"],
      ["unpriced count unreadable", [total(A, TASK, { unpricedEntries: "0" })], "unreadable_figures"],
      ["entries missing", [total(A, TASK, { entries: undefined })], "unreadable_figures"],
    ];
    for (const [label, rows, reason] of cases) {
      const seen: TaskSpendRefusal[] = [];
      const { spend } = await world(rows, (r) => { seen.push(r); });
      await expect(spend(TASK), label).rejects.toThrow(TASK_SPEND_UNKNOWN);
      expect(seen, label).toEqual([reason]);
    }
    // a store that fails
    const seen: TaskSpendRefusal[] = [];
    const broken = createCompanyTaskSpend({ store: { get: async () => { throw new Error("DynamoDB said secret-detail-xyz"); } } as never, companyId: A, refused: (r) => { seen.push(r); } });
    const fault = await broken(TASK).then(() => new Error("no refusal"), (error: unknown) => error as Error);
    expect(fault.message).toBe(TASK_SPEND_UNKNOWN);
    expect(seen).toEqual(["storage_unavailable"]);
    expect(JSON.stringify([fault.message, seen])).not.toContain("secret-detail");
    // a store whose runs read fine but whose total read fails is the same refusal (not the raw error)
    const healthy = await rowStore([total(A, TASK)]);
    const totalSeen: TaskSpendRefusal[] = [];
    const failingTotal = new Proxy(healthy.store, { get(target, property) {
      if (property === "get") return async (key: { pk: string; sk: string }) => { if (key.sk === "TOTAL") throw new Error("DynamoDB said secret-detail-xyz"); return target.get(key); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const totalFault = await createCompanyTaskSpend({ store: failingTotal, companyId: A, refused: (r) => { totalSeen.push(r); } })(TASK).then(() => new Error("no refusal"), (error: unknown) => error as Error);
    expect(totalFault.message).toBe(TASK_SPEND_UNKNOWN);
    expect(totalSeen).toEqual(["storage_unavailable"]);
    // a task id that is not an id never reaches the store
    const get = vi.fn(async () => undefined);
    const guarded = createCompanyTaskSpend({ store: { get } as never, companyId: A });
    for (const bad of ["", "a#b", "a b", "../x", "x".repeat(201), undefined as unknown as string, 7 as unknown as string]) await expect(guarded(bad), String(bad)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    expect(get).not.toHaveBeenCalled();
  });

  it("a failing log never changes the answer (it throws, or answers a failing promise), and the log carries fixed words only", async () => {
    const { spend } = await world([], () => { throw new Error("log is down"); });
    await expect(spend(TASK)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    const later = await world([], (() => Promise.reject(new Error("log is down"))));
    await expect(later.spend(TASK)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    const seen: string[] = [];
    const quiet = await world([total(A, TASK, { unpricedEntries: 2 })], (reason) => { seen.push(reason); });
    await expect(quiet.spend(TASK)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    expect(JSON.stringify(seen)).not.toContain(TASK);
    expect(JSON.stringify(seen)).not.toContain(A);
  });

  describe("a run whose usage the total does not hold yet is no complete figure", () => {
    const refusedFor = async (runs: Run[], over: Parameters<typeof rowStore>[1] = {}) => {
      const seen: TaskSpendRefusal[] = [];
      const { spend } = await world([total(A, TASK)], (r) => { seen.push(r); }, { runs, ...over });
      const answer = await spend(TASK).then((value) => value, () => "refused" as const);
      return { answer, seen };
    };

    it("answers when every model run has its end report, and passes over the checks, runs of other kinds, and a run that never reached a machine", async () => {
      const runs: Run[] = [...HEALTHY, { id: "op-3", workflowMode: "CHECKS", status: "FAILED", booked: "none" }, { id: "op-4", workflowMode: "PLAN", status: "SUCCEEDED" },
        { id: "op-5", workflowMode: "IMPLEMENT", status: "FAILED", kind: "cancel", booked: "none" }, { id: "op-6", workflowMode: "REVIEW", status: "CANCELLED", booked: "none", machineless: true },
        // a run of another kind is not a model run whatever its status: even one that succeeded or is still going owes no usage report
        { id: "op-7", workflowMode: "IMPLEMENT", status: "SUCCEEDED", kind: "cancel", booked: "none" }, { id: "op-8", workflowMode: "IMPLEMENT", status: "RUNNING", kind: "cancel", booked: "none" }];
      expect(await refusedFor(runs)).toEqual({ answer: 4.25, seen: [] });
    });

    it("a run still going is not reported, even with a part of its usage already booked", async () => {
      for (const status of ["RUNNING", "QUEUED", "DISPATCHING", "CANCEL_REQUESTED"]) {
        expect(await refusedFor([...HEALTHY, { id: "op-3", workflowMode: "IMPLEMENT", status, booked: "usage" }]), status).toEqual({ answer: "refused", seen: ["run_unreported"] });
      }
    });

    it("a run kept as an estimate is reported once its estimate entry is booked (SPEND-UNREPORTED-RUN: the figure then adds what its hold kept, tested in spend-unreported-run-settle.test.ts); without the entry it is not", async () => {
      expect(await refusedFor([...HEALTHY, { id: "op-3", workflowMode: "IMPLEMENT", status: "INTERRUPTED", usageUnflushed: true, booked: "usage" }])).toEqual({ answer: 4.25, seen: [] });
      expect(await refusedFor([...HEALTHY, { id: "op-3", workflowMode: "IMPLEMENT", status: "INTERRUPTED", usageUnflushed: true, booked: "none" }])).toEqual({ answer: "refused", seen: ["run_unreported"] });
    });

    it("a task whose record cannot be found, or is another company's, and a task with more runs than are read, are not reported", async () => {
      expect(await refusedFor(HEALTHY, { noTask: true })).toEqual({ answer: "refused", seen: ["run_unreported"] });
      expect(await refusedFor(HEALTHY, { taskCompany: B })).toEqual({ answer: "refused", seen: ["run_unreported"] });
      const many: Run[] = Array.from({ length: 51 }, (_, index) => ({ id: `op-${String(index)}`, workflowMode: "PLAN", status: "SUCCEEDED" }));
      expect(await refusedFor(many)).toEqual({ answer: "refused", seen: ["run_unreported"] });
    });

    it("another company's workspace, runs and end reports never stand in for this company's: a task whose workspace is not this company's has unknown runs", async () => {
      expect(await refusedFor(HEALTHY, { workspaceFor: [B] })).toEqual({ answer: "refused", seen: ["run_unreported"] });
      expect(await refusedFor(HEALTHY, { workspaceFor: [] })).toEqual({ answer: "refused", seen: ["run_unreported"] });
    });
  });
});
