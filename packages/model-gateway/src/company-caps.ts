import type { Caps, CapsScope, CapsSource } from "./caps.js";
import { GATEWAY_COMPANY_BUDGET_FIELDS, GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_LEARNING_BUDGET_FIELD, GATEWAY_COMPANY_LESSONS_GATE, GATEWAY_COMPANY_SETTINGS, GATEWAY_COMPANY_SPEND_LIMITS } from "./deploy.js";
import type { Dynamo, Item } from "./dynamo.js";
import type { LessonsSwitch } from "./learning-route.js";
import { COMPANY, PERSON, PROJECT, record, whole } from "./model-gateway-token.js";
import type { AnswersLimits } from "./answers-route.js";
import type { UpkeepLimits } from "./upkeep-cap.js";

/**
 * The caps a call is held to, read from the Cloud company backend's budgets (deploy.ts GATEWAY_COMPANY_SETTINGS): the company's
 * monthly cap, each member's monthly cap, each project's monthly cap and each task's cap, in micro-dollars, null for "no cap of
 * this kind". The backend's admin API (PUT /org/settings) writes them; the gateway only reads, on every call, so a lowered cap
 * applies to the next call.
 *
 * A company with no settings row, or with no company monthly cap (null), has set no ceiling: its calls are refused (503 "model
 * access unavailable") rather than run uncapped on Rovara's provider key. The backend's default settings hold every budget null,
 * so saving any other setting must not open unlimited spend; the other three nulls keep the backend's meaning ("no cap of this
 * kind"), always under the company's monthly cap. The learning cap (`learningMonthlyUsdMicros`, DEC 226) rides along in `learningMonth` for the
 * learning route only; absent in an older row, it is left out. A row that is not this company's, or a budget that is not null or a whole number of micro-dollars up to
 * the backend's own ceiling, refuses the same way. A failed read throws (the call stops before anything is reserved or sent).
 *
 * Overrides (lead 3 B1, DEC 254t b): the project the call runs in and the person it runs for may each have a monthly limit of their own
 * (deploy.ts GATEWAY_COMPANY_SPEND_LIMIT), read by key on every call, strongly consistent (a lowered limit applies to the very next call).
 * No item: the company default above. An item that is not exactly this company's, this kind's and this id's, or whose amount or version
 * is not whole numbers (amount up to the backend's ceiling), refuses the call; so does a project or person id that is not in the token's
 * format. A failed read throws. The company's monthly cap stays the outer bound (it is returned beside the override either way).
 */
export const NO_CAP = Number.MAX_SAFE_INTEGER;
/** What `validCaps` refuses: the server answers 503 and sends nothing. */
const UNAVAILABLE = Object.freeze({}) as unknown as Caps;

type SpendLimitDef = { kind: string; scope: "project" | "person" | "company"; sortPrefix: string; caps: "projectMonth" | "personMonth" | null };
const SPEND_LIMIT_DEFS: readonly SpendLimitDef[] = GATEWAY_COMPANY_SPEND_LIMITS.kinds;
/** The id of a call that a scope's limits are about, and the format it must have; undefined when the call names none (a person limit of a call with no person). */
const SCOPE_ID: Record<SpendLimitDef["scope"], { of(scope: CapsScope): string | undefined; format: RegExp }> = {
  project: { of: (scope) => scope.pid, format: PROJECT },
  person: { of: (scope) => scope.per, format: PERSON },
  // A company-wide limit is about the company itself: its id is the company's own.
  company: { of: (scope) => scope.cid, format: COMPANY },
};

/** The override's amount: undefined for "no override item", null when an item is there but does not read, else micro-dollars. */
function overrideAmount(item: Item | undefined, cid: string, kind: string, id: string): number | null | undefined {
  if (item === undefined) return undefined;
  if (item.companyId !== cid || item.kind !== kind || item.id !== id) return null;
  const amount = item.monthlyUsdMicros;
  // The same fields Cloud's store requires of a readable item (company-store.ts validSpendLimit), so the two never disagree about whether an override reads.
  if (!whole(amount) || amount > GATEWAY_COMPANY_BUDGET_MAX || !whole(item.version) || item.version < 1 || typeof item.updatedAt !== "string" || typeof item.updatedBy !== "string") return null;
  return amount;
}

/**
 * One kind's override for a company and an id, strongly consistent: undefined when there is none (the default applies), null when the item does not
 * read as exactly this company's, this kind's and this id's (the caller refuses), else micro-dollars. A failed read throws. Whatever enforces a kind
 * that is not a meter cap (`caps` null in the table) reads it through this, and refuses on null and on a throw.
 */
export async function readSpendLimit(db: Dynamo, table: string, kind: string, cid: string, id: string, signal?: AbortSignal): Promise<number | null | undefined> {
  const def = SPEND_LIMIT_DEFS.find((d) => d.kind === kind);
  if (def === undefined || !COMPANY.test(cid) || !SCOPE_ID[def.scope].format.test(id)) return null;
  const item = await db.get(table, { pk: `${GATEWAY_COMPANY_SPEND_LIMITS.partitionPrefix}${cid}`, sk: `${def.sortPrefix}${id}` }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
  return overrideAmount(item, cid, kind, id);
}

/**
 * The limits of the kinds whose own caller enforces them (the table's `caps: null`): a project's nightly upkeep cap (upkeep-cap.ts) and the company's
 * answers limit (answers-route.ts). Each is the strongly consistent, fail-closed `readSpendLimit`: undefined (no item: the caller's default), null (the item
 * does not read: the caller refuses), a throw (the read failed: the call stops).
 */
export class CompanyUpkeepLimits implements UpkeepLimits {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  limitFor(cid: string, pid: string, signal?: AbortSignal): Promise<number | null | undefined> { return readSpendLimit(this.db, this.table, "upkeep_month", cid, pid, signal); }
}
export class CompanyAnswersLimits implements AnswersLimits {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  limitFor(cid: string, signal?: AbortSignal): Promise<number | null | undefined> { return readSpendLimit(this.db, this.table, "answers_month", cid, cid, signal); }
}

export class CompanyBudgetCaps implements CapsSource {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> {
    if (record(scope) === undefined || typeof scope.cid !== "string" || !COMPANY.test(scope.cid)) return UNAVAILABLE;
    // The overrides' keys come only from ids in the token's own format; anything else is refused before a read.
    const wired = SPEND_LIMIT_DEFS.filter((def) => def.caps !== null);
    const ids = wired.map((def) => ({ def, id: SCOPE_ID[def.scope].of(scope) }));
    if (typeof scope.pid !== "string" || !PROJECT.test(scope.pid) || ids.some(({ def, id }) => id !== undefined && (typeof id !== "string" || !SCOPE_ID[def.scope].format.test(id)))) return UNAVAILABLE;
    const [item, ...found] = await Promise.all([
      this.db.get(this.table, { pk: `${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${scope.cid}`, sk: GATEWAY_COMPANY_SETTINGS.sortKey }, { consistent: false, ...(signal === undefined ? {} : { signal }) }),
      ...ids.map(({ def, id }) => (id === undefined ? Promise.resolve(undefined) : readSpendLimit(this.db, this.table, def.kind, scope.cid, id, signal))),
    ]);
    // An item that does not read (null) refuses; the amounts replace the default of the meter cap their kind names.
    if (found.some((amount) => amount === null)) return UNAVAILABLE;
    if (item === undefined || item.companyId !== scope.cid) return UNAVAILABLE;
    const budgets = record(record(item.settings)?.budgets);
    if (budgets === undefined) return UNAVAILABLE;
    const value = (name: typeof GATEWAY_COMPANY_BUDGET_FIELDS[number]): number | null | undefined => {
      const v = budgets[name];
      return v === null ? null : whole(v) && v <= GATEWAY_COMPANY_BUDGET_MAX ? v : undefined;
    };
    const [company, member, project, task] = GATEWAY_COMPANY_BUDGET_FIELDS.map(value);
    if ([company, member, project, task].some((v) => v === undefined) || company === null || company === undefined) return UNAVAILABLE;
    // The learning cap (DEC 226): whole micro-dollars, or absent in an older row (the learning default applies). Anything else refuses.
    const learning = budgets[GATEWAY_COMPANY_LEARNING_BUDGET_FIELD];
    if (learning !== undefined && !(whole(learning) && learning <= GATEWAY_COMPANY_BUDGET_MAX)) return UNAVAILABLE;
    const caps: Caps = {
      task: task ?? NO_CAP,
      projectMonth: project ?? NO_CAP,
      ...(member === null || member === undefined ? {} : { personMonth: member }),
      companyMonth: company,
      ...(learning === undefined ? {} : { learningMonth: learning }),
    };
    ids.forEach(({ def }, index) => { const amount = found[index]; if (typeof amount === "number" && def.caps !== null) caps[def.caps] = amount; });
    return caps;
  }
}

/**
 * The company's lessons switch (DEC 226), from the same company backend settings item the budgets come from (#52): on only when
 * `settings.featureGates.lessons` is exactly true on this company's own row. Fail closed: no row, another company's row, no gate,
 * or any other value is off. The read is strongly consistent, so an admin's "off" applies to the very next learning call. A failed
 * read throws (the learning route answers 503 and sends nothing). Turning a gate on is a loosening change in the backend, so it
 * goes through the company's decision rules there.
 */
export class CompanyLessonsSwitch implements LessonsSwitch {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async isOn(cid: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof cid !== "string" || !COMPANY.test(cid)) return false;
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${cid}`, sk: GATEWAY_COMPANY_SETTINGS.sortKey }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined || item.companyId !== cid) return false;
    const gates = record(record(item.settings)?.featureGates);
    return gates !== undefined && Object.hasOwn(gates, GATEWAY_COMPANY_LESSONS_GATE) && gates[GATEWAY_COMPANY_LESSONS_GATE] === true;
  }
}
