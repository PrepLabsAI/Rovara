// What nightly runs COST, attributed to the company and project that pay for it (lead 4 L4-SR1). Beside the machine-time rows (usage.ts) there is ONE spend row per finished AI system run:
//   partition `ORG#<company>#SYSTEM_RUN_SPEND#<month>`, sort key `<project>#<request hash>`; fields: company, project, kind (a closed list), month, the task, how the run ended, and `costMicros` ONLY when the cost is KNOWN.
// WHERE THE FIGURE COMES FROM. The run's cost is what the install's own cost ledger booked for its task (the worker's usage reports, priced by the install's metering; core-host/usage-booking.ts). It is read here
// from the task's own total row, nowhere else. (The gateway's `x-rovara-cost-usd` header is sent on the ANSWERS route only, never on the agent route the nightly refresh's calls use, so it cannot be the source.)
// A cost that is not known is NEVER zero: no total row, no priced entry, a call the price table does not cover (`unpricedEntries`), or a currency that is not dollars leaves `costMicros` out, and the run counts as unknown
// (`unknownRuns`), so a month's figure says it is a floor. The row is written ONCE per run (a repeat of the same request writes nothing more), before the run's money hold is settled.
// A row is read only as this company's, this project's, this month's and this kind's (checked on the row's own fields, not only its key), so one company's or project's figures never reach another's.
import { createHash } from "node:crypto";
import { AGENTX_NAME_PATTERN, OrgIdSchema, SystemRunKindSchema, UpkeepMonthSchema, companyScoped, queryAll, when, type DocumentKey, type DocumentStore, type OrgId, type SystemRunKind, type UpkeepSpend } from "@agentx/contracts";
import { costPartition } from "../cost/ledger.js";
import { upkeepExpiryOf } from "../upkeep/keys.js";

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function systemRunSpendPartition(orgId: OrgId, month: string): string {
  if (!OrgIdSchema.safeParse(orgId).success || !UpkeepMonthSchema.safeParse(month).success) throw new Error("not a spend partition");
  return companyScoped(orgId, `SYSTEM_RUN_SPEND#${month}`);
}
export function systemRunSpendKey(orgId: OrgId, month: string, project: string, requestId: string): DocumentKey {
  if (!AGENTX_NAME_PATTERN.test(project)) throw new Error("not a project name");
  return { pk: systemRunSpendPartition(orgId, month), sk: `${project}#${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}` };
}

/**
 * What the install's ledger says a task cost, in whole micro-dollars, or undefined when that is not KNOWN (never 0 for unknown): no total row, nothing recorded, any call without a price, another currency, a figure
 * that is not a whole number. A task whose recorded cost is really zero is known and is 0 only when at least one entry is recorded and every entry is priced.
 */
export async function knownTaskCostMicros(store: Pick<DocumentStore, "get">, companyId: OrgId, taskId: string): Promise<number | undefined> {
  try {
    const total = await store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" });
    if (total === undefined) return undefined;
    const currency = total["currency"];
    if (currency !== undefined && currency !== "USD") return undefined;
    if (!natural(total["micros"]) || !natural(total["entries"]) || total["entries"] === 0 || !natural(total["unpricedEntries"]) || total["unpricedEntries"] > 0) return undefined;
    return total["micros"];
  } catch {
    return undefined;
  }
}

type SpendDeps = { store: DocumentStore; companyId: OrgId; now: () => number };

/** Writes the run's spend row once. `costMicros` is left out when it is not known. Throws what the store throws: the caller (the sweep) then leaves the run open and tries again. */
export async function recordSystemRunSpend(deps: SpendDeps, input: { project: string; kind: SystemRunKind; requestId: string; taskId: string; startedAt: string | undefined; end: string; costMicros: number | undefined }): Promise<void> {
  const kind = SystemRunKindSchema.parse(input.kind);
  if (input.costMicros !== undefined && !natural(input.costMicros)) throw new Error("not a cost");
  const started = Date.parse(input.startedAt ?? "");
  const at = deps.now();
  // The month the run STARTED in (a night runs inside the window, far from a month's end), else when it settled.
  const month = monthOf(Number.isFinite(started) ? started : at);
  await deps.store.put({
    item: {
      ...systemRunSpendKey(deps.companyId, month, input.project, input.requestId), entityType: "SYSTEM_RUN_SPEND", orgId: deps.companyId, project: input.project, kind, month, requestId: input.requestId, taskId: input.taskId,
      end: input.end.slice(0, 40), settledAt: new Date(at).toISOString(), ...(input.costMicros === undefined ? {} : { costMicros: input.costMicros }), ...upkeepExpiryOf(at),
    },
    condition: when.absent(),
  });
}

/** One project's spend of one UTC month (this month unless asked), as the setup page's line reads it. Rows of another company, project, month or kind are never counted. */
export async function readSystemRunSpend(deps: Pick<SpendDeps, "store" | "companyId" | "now">, input: { project: string; month?: string }): Promise<UpkeepSpend> {
  const month = input.month ?? monthOf(deps.now());
  const rows = await queryAll(deps.store, { pk: systemRunSpendPartition(deps.companyId, month), sk: { op: "beginsWith" as const, prefix: `${input.project}#` } });
  let micros = 0;
  let runs = 0;
  let unknownRuns = 0;
  for (const row of rows) {
    if (row["entityType"] !== "SYSTEM_RUN_SPEND" || row["orgId"] !== deps.companyId || row["project"] !== input.project || row["month"] !== month || !SystemRunKindSchema.safeParse(row["kind"]).success) continue;
    runs += 1;
    if (natural(row["costMicros"])) micros += row["costMicros"]; else unknownRuns += 1;
  }
  return { month, spentUsd: micros / 1_000_000, runs, unknownRuns };
}
