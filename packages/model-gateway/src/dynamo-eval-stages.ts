// The shared eval stage table (B8, PRODUCT-EVAL-STAGE-STORE): every gateway task reads and changes the same stage, so a hold, its
// calls and its release may each land on a different task behind the load balancer (product-eval.ts EvalStageStore).
//
//   pk  CO#[iss,cid]          the company (the IAM LeadingKeys rule: CO# keys only)
//   sk  STAGE#<id>            one stage: `stage` (its plain state), `v` (version), `expiresAt` (TTL), and while its parent hold is
//                             not settled `dueAll`/`dueAt` (the sparse due-stages index the sweep reads)
//       SLOTS                 the company's open-stage slots: `open` (stage id -> until, epoch ms), `v`
//
// Every write is conditional on `v`, so two tasks never lose each other's change. A stage row expires (DynamoDB TTL) after its
// deadline plus the call ceiling and a margin (EVAL_DEAD_CALL_MS): by then every call admitted under it has ended, and a parent
// hold left unsettled is closed by the meter's open-hold sweep at its whole estimate. Nothing here deletes a row.
import { GATEWAY_COMPANY_KEY_PREFIX, GATEWAY_EVAL_STAGE_INDEXES, GATEWAY_EVAL_STAGE_PARTITION } from "./deploy.js";
import type { Dynamo, Item, Plain } from "./dynamo.js";
import { companyPartition } from "./dynamo-meter.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import { EVAL_DEAD_CALL_MS, evalStageSweepAt, type EvalStage, type EvalStageStore, type StageRef } from "./product-eval.js";

const STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const pad = (n: number): string => String(n).padStart(16, "0");
const valid = (ref: StageRef): boolean => typeof ref.iss === "string" && ref.iss.length > 0 && ref.iss.length <= 2048 && typeof ref.cid === "string" && COMPANY.test(ref.cid) && typeof ref.id === "string" && STAGE_ID.test(ref.id);

/** A bounded shape check of a stored stage: anything unexpected is unreadable (the caller answers busy/unavailable, never guesses). */
function readStage(value: unknown, ref: StageRef): EvalStage {
  const s = record(value);
  if (s === undefined || s.id !== ref.id || s.iss !== ref.iss || s.cid !== ref.cid || typeof s.pid !== "string" || typeof s.tid !== "string" || !whole(s.heldCalls) || !whole(s.heldCost) || !whole(s.deadline)
    || record(s.reservation) === undefined || typeof (s.reservation as Record<string, unknown>).id !== "string" || (s.status !== "open" && s.status !== "stopped") || typeof s.callerReleased !== "boolean"
    || !["held", "settling", "settled"].includes(s.parent as string) || !whole(s.settledMicros) || typeof s.keepWhole !== "boolean" || !whole(s.reportedFloor) || !Array.isArray(s.heldMarkers)
    || !whole(s.dispatched) || !whole(s.spent) || !whole(s.inFlight) || !whole(s.inFlightCost) || typeof s.exclusive !== "boolean" || typeof s.estimatedAny !== "boolean" || !whole(s.claiming)
    || record(s.waiting) === undefined || record(s.subs) === undefined) throw new Error("unreadable eval stage");
  return structuredClone(s) as unknown as EvalStage;
}

export class DynamoEvalStageStore implements EvalStageStore {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async get(ref: StageRef): Promise<{ version: number; stage: EvalStage } | undefined> {
    if (!valid(ref)) return undefined;
    const item = await this.db.get(this.table, { pk: companyPartition(ref.iss, ref.cid), sk: `STAGE#${ref.id}` }, { consistent: true });
    if (item === undefined) return undefined;
    if (!whole(item.v) || item.v < 1) throw new Error("unreadable eval stage");
    return { version: item.v, stage: readStage(item.stage, ref) };
  }

  async put(stage: EvalStage, expected: number): Promise<boolean> {
    if (!valid(stage) || !whole(expected)) throw new Error("invalid eval stage");
    const pk = companyPartition(stage.iss, stage.cid);
    const sk = `STAGE#${stage.id}`;
    const due = stage.parent === "settled" ? {} : { dueAll: GATEWAY_EVAL_STAGE_PARTITION, dueAt: `${pad(evalStageSweepAt(stage))}|${pk}|${stage.id}` };
    const item: Item = { pk, sk, v: expected + 1, stage: structuredClone(stage) as unknown as Plain, expiresAt: Math.ceil((stage.deadline + EVAL_DEAD_CALL_MS) / 1000), ...due };
    return this.db.put(this.table, item, (e) => expected === 0 ? `attribute_not_exists(${e.name("pk")})` : `${e.name("v")} = ${e.value(expected)}`);
  }

  async slots(iss: string, cid: string): Promise<{ version: number; open: Record<string, number> }> {
    if (typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("invalid company");
    const item = await this.db.get(this.table, { pk: companyPartition(iss, cid), sk: "SLOTS" }, { consistent: true });
    if (item === undefined) return { version: 0, open: {} };
    const open = record(item.open);
    if (!whole(item.v) || open === undefined || !Object.entries(open).every(([id, until]) => STAGE_ID.test(id) && whole(until))) throw new Error("unreadable eval slots");
    return { version: item.v, open: { ...(open as Record<string, number>) } };
  }

  async putSlots(iss: string, cid: string, open: Record<string, number>, expected: number): Promise<boolean> {
    if (typeof cid !== "string" || !COMPANY.test(cid) || !whole(expected)) throw new Error("invalid company");
    return this.db.put(this.table, { pk: companyPartition(iss, cid), sk: "SLOTS", v: expected + 1, open: { ...open } }, (e) => expected === 0 ? `attribute_not_exists(${e.name("pk")})` : `${e.name("v")} = ${e.value(expected)}`);
  }

  async due(before: number, limit: number): Promise<StageRef[]> {
    if (!whole(before) || !whole(limit) || limit < 1 || limit > 1000) throw new Error("invalid sweep");
    const index = GATEWAY_EVAL_STAGE_INDEXES.dueStages;
    const found = await this.db.query(this.table, { index: index.name, limit, key: (e) => `${e.name(index.partitionKey)} = ${e.value(GATEWAY_EVAL_STAGE_PARTITION)} AND ${e.name(index.sortKey)} < ${e.value(pad(before + 1))}` });
    const refs: StageRef[] = [];
    for (const item of found) {
      // The index is eventually consistent and only points: the sweep re-reads the stage from the table before deciding.
      if (typeof item.pk !== "string" || !item.pk.startsWith(GATEWAY_COMPANY_KEY_PREFIX) || typeof item.sk !== "string" || !item.sk.startsWith("STAGE#")) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(item.pk.slice(GATEWAY_COMPANY_KEY_PREFIX.length)); } catch { continue; }
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") continue;
      const ref = { iss: parsed[0], cid: parsed[1], id: item.sk.slice("STAGE#".length) };
      if (valid(ref)) refs.push(ref);
    }
    return refs;
  }
}
