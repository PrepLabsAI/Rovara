// What a reader of a task's session is shown of its log (B5): the entries as they were written, drawn once more through the same safety as a write (credentials redacted, one line, cut at the bound), because a row that
// was written by an older build, or by hand, must not carry more than a new one would. An entry that does not come out whole is left out (never shown partly); a pull request's address must be a plain https address.
// The rows are the company's own (`readTaskLog` reads this company's rows of this task only); who may read is decided by the caller (the session's level), never here.
import {
  TASK_LOG_CHOICES_MAX, TASK_LOG_PERSON_MAX, TASK_LOG_PLAN_LINES_MAX, TASK_LOG_PLAN_LINE_MAX, TASK_LOG_PLAN_NEEDED_MAX, TASK_LOG_PULL_REQUESTS_MAX, TASK_LOG_TEXT_MAX, TaskLogEntrySchema, TaskLogViewSchema,
  type DocumentStore, type OrgId, type TaskLogEntry, type TaskLogView,
} from "@agentx/contracts";
import { cleanLogText, plainHttpsLink } from "./entries.js";
import { readTaskLog } from "./store.js";

const some = (text: string | undefined, max: number): string => (text === undefined ? "" : cleanLogText(text, max));

/** One entry made safe again for a reader, or undefined when nothing safe is left of it. */
export function safeEntryOf(entry: TaskLogEntry): TaskLogEntry | undefined {
  let rebuilt: unknown;
  switch (entry.kind) {
    case "status":
      rebuilt = entry;
      break;
    case "plan_summary": {
      const estimate = some(entry.estimate, 80);
      rebuilt = {
        ...entry, needed: some(entry.needed, TASK_LOG_PLAN_NEEDED_MAX),
        lines: entry.lines.map((line) => some(line, TASK_LOG_PLAN_LINE_MAX)).filter((line) => line !== "").slice(0, TASK_LOG_PLAN_LINES_MAX),
        ...(estimate === "" ? { estimate: undefined } : { estimate }),
      };
      break;
    }
    case "question": {
      const choices = (entry.choices ?? []).map((choice) => some(choice, 80)).filter((choice) => choice !== "").slice(0, TASK_LOG_CHOICES_MAX);
      rebuilt = { ...entry, text: some(entry.text, TASK_LOG_TEXT_MAX), choices: choices.length === 0 ? undefined : choices };
      break;
    }
    case "answer":
      rebuilt = { ...entry, text: some(entry.text, TASK_LOG_TEXT_MAX), by: some(entry.by, TASK_LOG_PERSON_MAX) };
      break;
    case "approval":
      rebuilt = { ...entry, by: some(entry.by, TASK_LOG_PERSON_MAX) };
      break;
    case "pr":
      rebuilt = { ...entry, urls: entry.urls.flatMap((url) => plainHttpsLink(url) ?? []).slice(0, TASK_LOG_PULL_REQUESTS_MAX) };
      break;
  }
  const parsed = TaskLogEntrySchema.safeParse(JSON.parse(JSON.stringify(rebuilt)));
  return parsed.success ? parsed.data : undefined;
}

/** The task's log for a reader: this company's entries of this task, oldest first, each made safe once more. */
export async function taskLogViewFor(store: Pick<DocumentStore, "query">, orgId: OrgId, taskId: string): Promise<TaskLogView> {
  const entries = (await readTaskLog(store, orgId, taskId)).flatMap((entry) => safeEntryOf(entry) ?? []);
  return TaskLogViewSchema.parse({ entries });
}
