// Arch rule 9 (REGISTRY-TOLERANT-READ): a project whose CURRENT revision cannot be read is refused wherever that one project is read (task start, setup status, ...). A reader that builds a LIST or a company-wide answer must not
// let one such project take the whole answer down, so it leaves that project out, never reads an older revision in its place, and says so in the log with this ONE fixed event (ids only: no text of the record).
import { PROJECT_REVISION_UNREADABLE_RULE, ProjectRevisionUnreadableError } from "@agentx/contracts";

export const PROJECT_LEFT_OUT_EVENT = "project.left_out_unreadable_revision";

/** Whether an error is the refusal of an unreadable current revision. By class, never by text. */
export const isProjectUnreadable = (error: unknown): boolean => error instanceof ProjectRevisionUnreadableError;

/** The log line for a project left out of a list. `log` is the caller's own sink; the default is one JSON line on the console, as the broker's other structured logs. */
export function logProjectLeftOut(companyId: string | undefined, project: string, log?: (entry: Record<string, unknown>) => void): void {
  const entry = { event: PROJECT_LEFT_OUT_EVENT, rule: PROJECT_REVISION_UNREADABLE_RULE, companyId: companyId ?? "implicit", project };
  if (log !== undefined) log(entry);
  else console.log(JSON.stringify({ component: "broker", level: "warn", ...entry }));
}
