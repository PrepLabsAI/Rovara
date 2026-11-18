// Lead 4 L4-AK2: what the broker keeps of a worker's knowledge use report (contracts `knowledge-context.ts`). The report carries ids only. It is checked against the delivery record written when this operation's step was delivered
// (the ids it was given, pushed and pulled): an id the step was not given is removed, a report for another stage is dropped, a report with no delivery record is dropped (fail closed: it cannot be checked). The latest report
// of an operation replaces the one before. It moves no counter: the 1/k credit (`knowledgeCreditShares`, contracts) is its own lane, and the agent's claim only ever decides how one credit is shared, never adds one.
import { KnowledgeDeliveryRecordSchema, KnowledgeUseReportSchema, companyScoped, validateKnowledgeUseReport, type DocumentStore, type KnowledgeUseReport, type OrgId } from "@agentx/contracts";

type UseStore = Pick<DocumentStore, "get" | "put">;

/** The row of what this operation's delivery gave (written at delivery; ids only). Undefined when there is none or it is not valid. */
export async function readKnowledgeDelivery(store: UseStore, companyId: OrgId, operationId: string) {
  const row = await store.get({ pk: companyScoped(companyId, "KNOWLEDGE_GIVEN"), sk: operationId });
  if (row === undefined) return undefined;
  const parsed = KnowledgeDeliveryRecordSchema.safeParse({ v: row["v"], stage: row["stage"], taskId: row["taskId"], project: row["project"], pushed: row["pushed"], pulled: row["pulled"] });
  return parsed.success ? parsed.data : undefined;
}

/** The report as kept, or undefined when nothing was kept. Never throws a read error to the caller's events loop that it could not catch itself. */
export async function recordKnowledgeUseReport(input: {
  store: UseStore; companyId: OrgId; operationId: string; report: KnowledgeUseReport; now: () => number;
  ttlSeconds: number; ttl: (seconds: number) => Record<string, number>;
}): Promise<KnowledgeUseReport | undefined> {
  const delivery = await readKnowledgeDelivery(input.store, input.companyId, input.operationId);
  if (delivery === undefined) return undefined;
  const checked = validateKnowledgeUseReport(input.report, delivery);
  if (checked === undefined) return undefined;
  await input.store.put({
    item: {
      pk: companyScoped(input.companyId, "KNOWLEDGE_USE"), sk: input.operationId, entityType: "KNOWLEDGE_USE", taskId: delivery.taskId, project: delivery.project, stage: checked.stage,
      reported: checked.reported,
      units: checked.units.map((unit) => ({ id: unit.id, kind: unit.kind, given: unit.given, areaTouched: unit.areaTouched, ...(unit.version === undefined ? {} : { version: unit.version }), ...(unit.used === undefined ? {} : { used: unit.used }), ...(unit.wrong === undefined ? {} : { wrong: true }) })),
      at: input.now(), ...input.ttl(input.ttlSeconds),
    },
  });
  return checked;
}

/** The kept report of an operation for its task (for the task page and the credit seam), or undefined. */
export async function readKnowledgeUseReport(store: UseStore, companyId: OrgId, operationId: string): Promise<(KnowledgeUseReport & { taskId: string; project: string }) | undefined> {
  const row = await store.get({ pk: companyScoped(companyId, "KNOWLEDGE_USE"), sk: operationId });
  if (row === undefined || typeof row["taskId"] !== "string" || typeof row["project"] !== "string") return undefined;
  const parsed = KnowledgeUseReportSchema.safeParse({ v: 1, stage: row["stage"], units: row["units"], reported: row["reported"] });
  return parsed.success ? { ...parsed.data, taskId: row["taskId"], project: row["project"] } : undefined;
}
