// Reading Rovara local AWS's request ledger (test services, slice 2, TS22; design test-services.md 8.1 and 12). The fork keeps a ledger of every API request it answered (service and operation from the request, never from an
// object's body; the control paths are not in it) and serves its counters at `GET /_rovara/ledger/summary` behind the control token: `{ "<service>": { calls, unsupported, errors, operations: { "<operation>": { calls,
// unsupported, errors } } } }`. This module reads that one answer for the usage record (service-usage-record.ts has the ONE port that takes it and reduces it).
//
// WHY THE ANSWER IS NOT TRUSTED AS TEXT: the operation names are the sandbox program's own words. A request the emulator cannot name is recorded as `METHOD /path` (cut at 80 characters), and an `Action=` value is whatever the
// program sent. So this module only checks the SHAPE and the sizes and hands the names on as data; it never shows, logs or forwards one. The reduction (service-usage-record.ts `reduceAwsUsage`) decides which names may be shown,
// and the usage record (like the sealed round's output) must never be fed back to the agent or a model: nothing the agent, a model call or the setup agent reads may import this module (tests guard it).
//
// FAIL CLOSED: a ledger that cannot be read (the control call fails, the answer is not the summary, a number is not a count, the answer is past its limits) is an `EmulatorControlError`/`EmulatorLedgerError`, never "no calls".
// The caller records "unreadable", which the broker treats as a failed usage check.
import { emulatorControlCall, type EmulatorControlTarget } from "./emulator-control.js";

/** `invalid`: not the summary shape. `too_many`: more distinct services or operations than any honest run makes (the code flooded the ledger): a failure with its own word, never a quiet one. */
export class EmulatorLedgerError extends Error {
  constructor(readonly reason: "invalid" | "too_many" = "invalid") {
    super(reason === "too_many" ? "The test services' AWS request ledger holds more different calls than the worker reads" : "The test services' AWS request ledger could not be read");
    this.name = "EmulatorLedgerError";
  }
}

/** Counters of one operation or one service, as the emulator keeps them. */
export interface LedgerCounts { calls: number; unsupported: number; errors: number }
export interface LedgerService extends LedgerCounts {
  /** The emulator's name for the service as the ledger wrote it (a key of the table, an older spelling, a signing name, or `unknown`): `reduceAwsUsage` turns it into a key. */
  service: string;
  /** Calls the emulator counted as outside the run's planned services (`ROVARA_AWS_PLANNED_SERVICES`). Absent when the emulator does not say (the older image): the plan itself is then compared. */
  outOfPlan?: number;
  /** The program's own operation words, UNCHECKED: only `reduceAwsUsage` may decide what of them is shown. */
  operations: Array<LedgerCounts & { operation: string }>;
}
/** What the emulator's ledger said, shape-checked and bounded. Names inside are unchecked data. */
export interface EmulatorLedger { services: LedgerService[] }

/** The ledger's own limits: more than this is not read (an answer that big is refused whole). */
/** No AWS service has anywhere near this many operations: more distinct ones in a run is the code flooding the ledger (the emulator's own counters are not capped: fork follow-up). */
export const LEDGER_LIMITS = { services: 64, operationsPerService: 200, operationChars: 200, count: 1_000_000_000_000 } as const;
const SERVICE_KEY = /^[a-z][a-z0-9-]{0,39}$/u;

function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > LEDGER_LIMITS.count) throw new EmulatorLedgerError();
  return value;
}
function countsOf(value: unknown): LedgerCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmulatorLedgerError();
  const { calls, unsupported, errors } = value as Record<string, unknown>;
  return { calls: countOf(calls), unsupported: countOf(unsupported), errors: countOf(errors) };
}

/** Parses the summary's text. Throws `EmulatorLedgerError` for anything that is not exactly the summary shape within the limits. Pure. */
export function parseLedgerSummary(text: string): EmulatorLedger {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new EmulatorLedgerError(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new EmulatorLedgerError();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > LEDGER_LIMITS.services) throw new EmulatorLedgerError("too_many");
  const services: LedgerService[] = [];
  for (const [service, value] of entries) {
    if (!SERVICE_KEY.test(service) || typeof value !== "object" || value === null || Array.isArray(value)) throw new EmulatorLedgerError();
    const counts = countsOf(value);
    const operations = (value as Record<string, unknown>)["operations"];
    if (typeof operations !== "object" || operations === null || Array.isArray(operations)) throw new EmulatorLedgerError();
    const rows = Object.entries(operations as Record<string, unknown>);
    if (rows.length > LEDGER_LIMITS.operationsPerService) throw new EmulatorLedgerError("too_many");
    const outOfPlan = (value as Record<string, unknown>)["outOfPlan"];
    services.push({
      service, ...counts, ...(outOfPlan === undefined ? {} : { outOfPlan: countOf(outOfPlan) }),
      operations: rows.map(([operation, row]) => {
        if (operation.length < 1 || operation.length > LEDGER_LIMITS.operationChars) throw new EmulatorLedgerError();
        return { operation, ...countsOf(row) };
      }),
    });
  }
  return { services };
}

/** The port the usage record takes: reads the emulator's ledger NOW (while it still runs) or throws. */
export type EmulatorLedgerPort = (signal?: AbortSignal) => Promise<EmulatorLedger>;

/** Binds the port to one running emulator. Call it for the round's own emulator while its helpers still run (before the round is torn down). */
export function emulatorLedgerPort(target: EmulatorControlTarget): EmulatorLedgerPort {
  return async (signal) => {
    const answer = await emulatorControlCall(signal === undefined ? target : { ...target, signal }, { path: "ledgerSummary", method: "GET", print: true });
    return parseLedgerSummary(answer);
  };
}
