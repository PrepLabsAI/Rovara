// Lead 4 L4-AK2: what the broker keeps of a worker's knowledge use report (contracts `knowledge-context.ts`). The report carries ids only. It is checked against the delivery record written when this operation's step was delivered
// (the ids it was given, pushed and pulled): an id the step was not given is removed, a report for another stage is dropped, a report with no delivery record is dropped (fail closed: it cannot be checked). The latest report
// of an operation replaces the one before. It moves no counter: the 1/k credit (`knowledgeCreditShares`, contracts) is its own lane, and the agent's claim only ever decides how one credit is shared, never adds one.
import { KnowledgeDeliveryRecordSchema, KnowledgeUseReportSchema, companyScoped, validateKnowledgeUseReport, when, type DocumentStore, type KnowledgeDeliveryRecord, type KnowledgeUseReport, type OrgId, type StoredDocument } from "@agentx/contracts";

type UseStore = Pick<DocumentStore, "get" | "put">;

/** How long a delivery record is kept, for the store's sweep and for the reader's own check (a swept row may be read until the sweep runs). */
export const KNOWLEDGE_GIVEN_KEEP_SECONDS = 30 * 86_400;

/** The delivery record's row (lead 4 L4-AK2b): ids only, in the company's own partition, one per operation. `at` is the app-side expiry's clock; the store's own sweep attribute is added when the store names one. Never names a TTL attribute itself. */
export function knowledgeGivenItem(input: { companyId: OrgId; operationId: string; record: KnowledgeDeliveryRecord; now: () => number; ttlAttribute?: string | undefined }): StoredDocument {
  return {
    pk: companyScoped(input.companyId, "KNOWLEDGE_GIVEN"), sk: input.operationId, entityType: "KNOWLEDGE_GIVEN", ...input.record, at: input.now(),
    ...(input.ttlAttribute === undefined ? {} : { [input.ttlAttribute]: Math.floor(input.now() / 1000) + KNOWLEDGE_GIVEN_KEEP_SECONDS }),
  };
}

/** Writes a delivery record once for an operation (the first write wins: a repeated delivery keeps the record the first one made). True when this call wrote it. Throws on a store fault; the caller decides it is only "no record". */
export async function writeKnowledgeDeliveryOnce(store: UseStore & Pick<DocumentStore, "ttlAttribute">, input: { companyId: OrgId; operationId: string; record: KnowledgeDeliveryRecord; now: () => number }): Promise<boolean> {
  const written = await store.put({ item: knowledgeGivenItem({ ...input, ttlAttribute: store.ttlAttribute }), condition: when.absent() });
  return written.applied;
}

/** The row of what this operation's delivery gave (written at delivery; ids only). Undefined when there is none, it is past its keep time, or it is not valid. `now` is given by the writer's own caller; a row without `at` (written before it existed) is kept as it was. */
export async function readKnowledgeDelivery(store: UseStore, companyId: OrgId, operationId: string, now?: () => number) {
  const row = await store.get({ pk: companyScoped(companyId, "KNOWLEDGE_GIVEN"), sk: operationId });
  if (row === undefined) return undefined;
  if (now !== undefined && typeof row["at"] === "number" && row["at"] + KNOWLEDGE_GIVEN_KEEP_SECONDS * 1000 <= now()) return undefined;
  const parsed = KnowledgeDeliveryRecordSchema.safeParse({ v: row["v"], stage: row["stage"], taskId: row["taskId"], project: row["project"], pushed: row["pushed"], pulled: row["pulled"] });
  return parsed.success ? parsed.data : undefined;
}

/** The report as kept, or undefined when nothing was kept. Never throws a read error to the caller's events loop that it could not catch itself. */
export async function recordKnowledgeUseReport(input: {
  store: UseStore; companyId: OrgId; operationId: string; report: KnowledgeUseReport; now: () => number;
  ttlSeconds: number; ttl: (seconds: number) => Record<string, number>;
}): Promise<KnowledgeUseReport | undefined> {
  const delivery = await readKnowledgeDelivery(input.store, input.companyId, input.operationId, input.now);
  if (delivery === undefined) return undefined;
  const checked = validateKnowledgeUseReport(input.report, delivery);
  if (checked === undefined) return undefined;
  const row = {
    taskId: delivery.taskId, project: delivery.project, stage: checked.stage,
    reported: checked.reported,
    units: checked.units.map((unit) => ({ id: unit.id, kind: unit.kind, given: unit.given, areaTouched: unit.areaTouched, ...(unit.version === undefined ? {} : { version: unit.version }), ...(unit.used === undefined ? {} : { used: unit.used }), ...(unit.wrong === undefined ? {} : { wrong: true }) })),
    at: input.now(), ...input.ttl(input.ttlSeconds),
  };
  await input.store.put({ item: { pk: companyScoped(input.companyId, "KNOWLEDGE_USE"), sk: input.operationId, entityType: "KNOWLEDGE_USE", ...row } });
  // The same row under the TASK's own partition (lessons phase 2: the clean-merge credit reads a task's reports exactly, not by scanning the company's operations). Best effort: when it fails the task has no copy, and a read of the task's reports then finds none (the credit takes the weaker road, shared among the Build step's lessons, never doubled).
  try { await input.store.put({ item: { pk: companyScoped(input.companyId, `KNOWLEDGE_USE_TASK#${delivery.project}#${delivery.taskId}`), sk: input.operationId, entityType: "KNOWLEDGE_USE", ...row } }); } catch { /* the operation's own row is kept */ }
  return checked;
}

/** The kept report of an operation for its task (for the task page and the credit seam), or undefined. */
export async function readKnowledgeUseReport(store: UseStore, companyId: OrgId, operationId: string): Promise<(KnowledgeUseReport & { taskId: string; project: string }) | undefined> {
  const row = await store.get({ pk: companyScoped(companyId, "KNOWLEDGE_USE"), sk: operationId });
  if (row === undefined || typeof row["taskId"] !== "string" || typeof row["project"] !== "string") return undefined;
  const parsed = KnowledgeUseReportSchema.safeParse({ v: 1, stage: row["stage"], units: row["units"], reported: row["reported"] });
  return parsed.success ? { ...parsed.data, taskId: row["taskId"], project: row["project"] } : undefined;
}
