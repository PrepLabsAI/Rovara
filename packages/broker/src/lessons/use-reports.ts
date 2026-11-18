// Lessons phase 2: the use reports of ONE task, for the clean-merge credit (`credit.ts`). The reports are the broker's own record of what each Build or Fix step's worker said about the knowledge it was given (L4-AK2:
// `KNOWLEDGE_USE#<company>` rows, one per operation, ids and booleans only, already checked against the delivery record when they were kept). Read here: this company's partition only, the rows of this task and the Build and Fix
// stage only, bounded by a total row limit and a deadline. Anything that cannot be read is "no reports": the credit then falls back to the changed files (never a failure of the task's end).
// Follow-up (named in the PR): the partition is keyed by operation, so finding a task's rows is a filtered read of the newest rows; an index on the task would make it exact.
import { KnowledgeUseReportSchema, companyScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { UseReport } from "./credit.js";

export const USE_REPORTS_ROWS_MAX = 2_000;
export const USE_REPORTS_MAX = 20;
const PAGE = 200;
const TASK = /^[A-Za-z0-9_-]{4,100}$/u;

export async function readTaskUseReports(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; taskId: string }): Promise<UseReport[]> {
  if (!TASK.test(input.taskId.replace(/-/gu, "_"))) return [];
  const pk = companyScoped(input.companyId, "KNOWLEDGE_USE");
  const out: UseReport[] = [];
  let read = 0;
  for (let cursor: string | undefined; read < USE_REPORTS_ROWS_MAX && out.length < USE_REPORTS_MAX;) {
    const page = await store.query({ pk, filter: when.eq("taskId", input.taskId), limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    read += Math.max(PAGE / 4, page.items.length);
    for (const row of page.items) {
      // Every row is checked again: this company's partition, this task and project, the Build and Fix stage, and the report's own shape.
      if (row["pk"] !== pk || row["entityType"] !== "KNOWLEDGE_USE" || row["taskId"] !== input.taskId || row["project"] !== input.project || row["stage"] !== "IMPLEMENT") continue;
      const parsed = KnowledgeUseReportSchema.safeParse({ v: 1, stage: row["stage"], units: row["units"], reported: row["reported"] });
      if (parsed.success) out.push({ reported: parsed.data.reported, units: parsed.data.units.map((unit) => ({ id: unit.id, kind: unit.kind, ...(unit.used === undefined ? {} : { used: unit.used }), areaTouched: unit.areaTouched })) });
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return out;
}
