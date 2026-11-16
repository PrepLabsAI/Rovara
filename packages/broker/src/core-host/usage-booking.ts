// Usage booking on a deployed install (switch-on lane L8): every model usage a core task's worker reports is booked into the task's cost ledger, as the laptop's model proxy books each call
// (`meter` in local/app/app.ts). A worker reports one `usage` event per model session (a run, a reviewer, a part of a plan) through the callback layer (services/callbacks.ts `bookUsage`),
// and the batch is acknowledged only once its usage is booked: a booking that fails fails the batch, the worker sends it again, and the ledger counts each usage once.
//
// Never $0 for unknown usage: a model no price table knows is charged the cautious price (hosted metering); a cost the provider reported that is higher than the table's is charged instead;
// a report with no tokens and no cost is charged a small fixed amount (`EMPTY_REPORT_CHARGE_MICROS`); and a usage report that cannot be read (no model, token counts that are not whole
// numbers, a cost that is not a number) is booked as a usage with NO dollar figure, so the task's and
// the company's day figures say they are a floor and the admission refuses new spending for the rest of the day (`spend_unknown`).
//
// `bookUsageReport` is the one entry for any reporter: the worker's events here, and the Cloud gateway's usage report when it lands (it names the task and its own entry id).
import { createHash } from "node:crypto";
import { type DocumentStore, type MeterEntry, type Metering, type ModelUsage } from "@agentx/contracts";
import { taskPointerKey } from "../core/task-flow/keys.js";
import { costPartition } from "../core/cost/ledger.js";
import { createHostedLedger } from "./hosted-modules.js";

/** The worker's event type that carries a model session's usage (`TaskUsageTelemetry`). */
export const USAGE_EVENT_TYPE = "usage";
/** The provider name an unreadable usage report is booked under: the booking meter gives it no price, so it is never $0. */
export const UNREADABLE_USAGE_PROVIDER = "rovara-unreadable-usage";
/** A booking that loses a race on the task's total is tried this many times before the batch fails (the worker then sends it again). */
const BOOKING_ATTEMPTS = 5;
/** What a usage report with no tokens and no cost is charged ($0.25). */
export const EMPTY_REPORT_CHARGE_MICROS = 250_000;
export const NO_TASK_FOR_USAGE = "the usage of this operation names no task";
/** The entry id kind of a usage checkpoint (`usage-checkpoint:<operation>:<digest>`); a session's end report and an estimate are `usage:<operation>:...`. */
export const CHECKPOINT_ENTRY_PREFIX = "usage-checkpoint";


const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** One usage as a reporter tells it. */
export interface UsageReport {
  companyId: string;
  taskId: string;
  /** Names this usage: telling it again books nothing more. */
  entryId: string;
  at: string;
  /** The reported payload (`TaskUsageTelemetry`): read here, never trusted for more than its numbers. */
  payload: unknown;
  /** The ledger holds a checkpoint of this report's run (a `final` zero then books $0; without one it is charged the floor). */
  checkpointsBooked?: boolean;
}

/** The usage a payload reports, or undefined when it does not read as one (see the file comment). */
export function readUsagePayload(payload: unknown, options: { checkpointsBooked?: boolean } = {}): { usage: ModelUsage; reportedMicros?: number } | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const tokens = record["tokens"] as Record<string, unknown> | null | undefined;
  if (!text(record["provider"], 128) || !text(record["modelId"], 256) || tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
  const { input, output, cacheRead, cacheWrite } = tokens;
  if (!natural(input) || !natural(output) || !natural(cacheRead) || !natural(cacheWrite)) return undefined;
  const cost = record["costUsd"];
  if (cost !== undefined && cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return undefined;
  const reportedMicros = typeof cost === "number" && cost > 0 ? Math.ceil(cost * 1_000_000) : undefined;
  // A report with no tokens and no cost (a session whose call failed before any token, or whose provider sent no usage) is charged a small fixed amount, never $0: the call may have been
  // billed. It is not taken as unreadable, which would stop the whole company for the day. The one exception is a session's `final` report when checkpoints of its run were BOOKED
  // (`checkpointsBooked`, read from the ledger, never the worker's word; per-run dollar stop): the run's spend is what they booked, never less. Without one, the floor stands:
  // the checkpoints told what it spent, and a zero end says only that nothing is left.
  if (input + output + cacheRead + cacheWrite === 0 && reportedMicros === undefined && !(record["final"] === true && options.checkpointsBooked === true)) {
    return { usage: { provider: record["provider"], modelId: record["modelId"], tokens: { input, output, cacheRead, cacheWrite } }, reportedMicros: EMPTY_REPORT_CHARGE_MICROS };
  }
  if (reportedMicros !== undefined && !Number.isSafeInteger(reportedMicros)) return undefined;
  return { usage: { provider: record["provider"], modelId: record["modelId"], tokens: { input, output, cacheRead, cacheWrite } }, ...(reportedMicros === undefined ? {} : { reportedMicros }) };
}

/** The meter bookings go through: the install's metering, except an unreadable report, which has no price. */
function bookingMeter(metering: Metering): Metering {
  return {
    price: (usage) => metering.price(usage),
    async record(entry) {
      if (entry.usage.provider === UNREADABLE_USAGE_PROVIDER) return { cost: null, source: "unknown" };
      return await metering.record(entry);
    },
  };
}

export interface UsageBooking {
  /** Books one report; true when it was counted now, false when it was counted before. */
  bookUsageReport(report: UsageReport): Promise<boolean>;
  /** Books the `usage` events of one worker batch of a core operation, in order. Throws (fixed words) when they cannot all be booked. */
  bookOperationEvents(operation: { id: string; workspaceId: string; companyId: string }, events: ReadonlyArray<{ type: string; timestamp: string; payload: unknown }>): Promise<{ booked: number; unreadable: number }>;
}

export function createUsageBooking(deps: { store: DocumentStore; metering: Metering; now?: () => Date }): UsageBooking {
  const ledger = createHostedLedger({ store: deps.store, metering: bookingMeter(deps.metering), ...(deps.now === undefined ? {} : { now: deps.now }) });

  async function bookUsageReport(report: UsageReport): Promise<boolean> {
    const read = readUsagePayload(report.payload, { checkpointsBooked: report.checkpointsBooked === true });
    const entry: MeterEntry = {
      companyId: report.companyId, entryId: report.entryId, at: report.at, taskId: report.taskId,
      usage: read?.usage ?? { provider: UNREADABLE_USAGE_PROVIDER, modelId: "unreadable", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ...(read?.reportedMicros === undefined ? {} : { reportedCost: { micros: read.reportedMicros, currency: "USD" } }),
    };
    let last: unknown;
    for (let attempt = 0; attempt < BOOKING_ATTEMPTS; attempt += 1) {
      try { return (await ledger.recordUsage(entry)).counted; } catch (error) { last = error; }
    }
    throw last instanceof Error ? last : new Error("the usage could not be booked");
  }

  return {
    bookUsageReport,
    async bookOperationEvents(operation, events) {
      const usages = events.filter((event) => event.type === USAGE_EVENT_TYPE);
      if (usages.length === 0) return { booked: 0, unreadable: 0 };
      const pointer = await deps.store.get(taskPointerKey(operation.workspaceId));
      const taskId = pointer?.["taskId"];
      if (typeof taskId !== "string" || taskId === "") throw new Error(NO_TASK_FOR_USAGE);
      let booked = 0;
      let unreadable = 0;
      for (const event of usages) {
        // The same event sent again (a retried batch) has the same time and payload, so the same entry id: it is counted once.
        const digest = createHash("sha256").update(`${event.timestamp}\n${JSON.stringify(event.payload) ?? "null"}`).digest("hex").slice(0, 40);
        const at = typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp)) ? new Date(Date.parse(event.timestamp)).toISOString() : (deps.now?.() ?? new Date()).toISOString();
        if (readUsagePayload(event.payload) === undefined) unreadable += 1;
        // A checkpoint (the spend so far of a session still going) has an entry id of its own kind, so a run is never taken as reported in full by its checkpoints alone (`runsOwed`).
        const checkpoint = (event.payload as { checkpoint?: unknown } | null)?.checkpoint === true;
        // A `final` report counts on the run's checkpoints only when the ledger holds one (booked before it, in this batch or an earlier one).
        const final = (event.payload as { final?: unknown } | null)?.final === true;
        const checkpointsBooked = final && (await deps.store.query({ pk: costPartition(operation.companyId, taskId), sk: { op: "beginsWith", prefix: `ENTRY#${CHECKPOINT_ENTRY_PREFIX}:${operation.id}:` }, limit: 1 })).items.length > 0;
        if (await bookUsageReport({ companyId: operation.companyId, taskId, entryId: `${checkpoint ? CHECKPOINT_ENTRY_PREFIX : "usage"}:${operation.id}:${digest}`, at, payload: event.payload, checkpointsBooked })) booked += 1;
      }
      return { booked, unreadable };
    },
  };
}
