// Lessons phase 2: the use reports of ONE task, for the clean-merge credit (`credit.ts`). The reports are the broker's own record of what each Build or Fix step's worker said about the knowledge it was given (L4-AK2:
// `KNOWLEDGE_USE_TASK#<project>#<task>` rows under the company's own partition, one per operation, ids and booleans only, already checked against the delivery record when they were kept). Read here by the task's own exact
// partition, this company and this project only, the Build and Fix stage only, bounded by a row limit and a deadline. A read that fails or runs out of time THROWS (the caller counts the task later: unknown is not "no report");
// a task with no report row (a worker that does not report, or a task from before the rows existed) answers an empty list.
import { KnowledgeUseReportSchema, companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { UseReport } from "./credit.js";

export const USE_REPORTS_ROWS_MAX = 200;
export const USE_REPORTS_DEADLINE_MS = 3_000;
const PAGE = 100;
const TASK = /^[A-Za-z0-9_-]{4,100}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export async function readTaskUseReports(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; taskId: string; deadlineMs?: number }): Promise<UseReport[]> {
  if (!TASK.test(input.taskId.replace(/-/gu, "_")) || !PROJECT.test(input.project)) return [];
  const pk = companyScoped(input.companyId, `KNOWLEDGE_USE_TASK#${input.project}#${input.taskId}`);
  const out: UseReport[] = [];
  const deadlineAt = Date.now() + (input.deadlineMs ?? USE_REPORTS_DEADLINE_MS);
  let read = 0;
  for (let cursor: string | undefined; ;) {
    const left = deadlineAt - Date.now();
    if (left <= 0 || read >= USE_REPORTS_ROWS_MAX) throw new Error("use reports: not read whole");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let page: Awaited<ReturnType<typeof store.query>>;
    try {
      page = await Promise.race([store.query({ pk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("use reports: out of time")), left); timer.unref?.(); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    read += Math.max(1, page.items.length);
    for (const row of page.items) {
      // Every row is checked again: this task's partition, this task and project, the Build and Fix stage, and the report's own shape.
      if (row["pk"] !== pk || row["entityType"] !== "KNOWLEDGE_USE" || row["taskId"] !== input.taskId || row["project"] !== input.project || row["stage"] !== "IMPLEMENT") continue;
      const parsed = KnowledgeUseReportSchema.safeParse({ v: 1, stage: row["stage"], units: row["units"], reported: row["reported"] });
      if (parsed.success) out.push({ reported: parsed.data.reported, units: parsed.data.units.map((unit) => ({ id: unit.id, kind: unit.kind, ...(unit.used === undefined ? {} : { used: unit.used }), areaTouched: unit.areaTouched })) });
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return out;
}
