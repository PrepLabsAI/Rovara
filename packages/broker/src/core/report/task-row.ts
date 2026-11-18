// The cost report's task row (lead 4, slice A2): ONE small row per task in the company's report partition, keyed by the time the task STARTED (`reportTaskKey`), so a range read of the partition is
// "the tasks that started in this range" and a task's whole cost belongs to the range it started in.
//
//   - It is written in the task's own start transaction (`reportStartItems`, joined to the core runtime's `startExtras`), so every ordinary task has a row from its first moment and a task that does not start
//     has none. A setup run (a task with a purpose) and a replay (`test_run`) are not feature work and get none.
//   - The row holds what does not change (project, title, where it started, when) and, once the task is over, what it ended as. Everything else is READ when the report is read: the cost from the cost
//     ledger (`taskCostFromTotal`), the state and the pull requests from the task record, the pull request and merge times from the task's milestone rows (`pr_ready`, `merged`). A task that is not
//     settled is folded again on every read (`foldTask`); a merged task settles at once, a closed one a day after it closed (it may be retried until then). A settled row is served from itself.
//   - Nothing here names a person.
import {
  REPORT_PR_LINKS_MAX, REPORT_TITLE_MAX, REPORT_INSTANT, REPORT_SK, ReportPathSchema, ReportOriginSchema, ReportStateSchema, reportTaskKey,
  type OrgId, type ReportOrigin, type ReportState, type StoredDocument, type TransactItem, type WorkOrigin,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";
import { timesOfStored, type TaskTimes } from "./times.js";

/** A closed task settles this long after it closed (a retry may open it again before then). */
export const CLOSED_SETTLE_MS = 24 * 3_600_000;
/** Origins that are not feature work: a replay of a test. (A setup run is excluded by its purpose.) */
const NOT_REPORTED: ReadonlySet<string> = new Set(["test_run"]);

/** Where a task started, as the report says it. */
export function reportOriginOf(origin: WorkOrigin | undefined): ReportOrigin {
  switch (origin) {
    case "app": return "web";
    case "cli": case "mcp": return "tool";
    case "slack": return "slack";
    case "linear": return "linear";
    case "jira": return "jira";
    default: return "other";
  }
}

/** A title as the report keeps it: no control or invisible characters, one line, cut to `REPORT_TITLE_MAX` characters. */
export function reportTitleOf(title: string): string {
  const plain = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...plain].slice(0, REPORT_TITLE_MAX).join("").trimEnd();
  return cut === "" ? "(no title)" : cut;
}

/** A pull request's address when it is a plain https address (no sign-in data), else nothing. */
export function plainHttpsLink(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface ReportStartInput {
  companyId: OrgId;
  taskId: string;
  project: string;
  title: string;
  origin: WorkOrigin | undefined;
  /** Set for a task that is not ordinary work (a setup run). */
  purpose?: string | undefined;
  /** The start's time, as `toISOString` writes it. */
  receivedAt: string;
}

/** Whether a start is feature work the report counts: not a setup run (a purpose), not a replay of a test, and a start time that is an instant. The work events of a start (slice A4) follow the same rule. */
export function startIsReported(input: Pick<ReportStartInput, "origin" | "purpose" | "receivedAt">): boolean {
  return input.purpose === undefined && !(input.origin !== undefined && NOT_REPORTED.has(input.origin)) && REPORT_INSTANT.test(input.receivedAt);
}

/** The step that adds a task's report row to its start transaction. Never throws (a start must not fail for the report): an input it cannot key, or a task that is not feature work, gives no step. */
export function reportStartItems(input: ReportStartInput): TransactItem[] {
  try {
    if (!startIsReported(input)) return [];
    const key = reportTaskKey(input.companyId, input.receivedAt, input.taskId);
    const row: StoredDocument = {
      ...key, entityType: "REPORT_TASK", companyId: input.companyId, taskId: input.taskId, project: input.project, title: reportTitleOf(input.title), origin: reportOriginOf(input.origin),
      startedAt: input.receivedAt, state: "open", prsOpened: 0, prsMerged: 0, prLinks: [], version: 1,
    };
    return [{ kind: "put", item: row, condition: { op: "notExists", path: ["pk"] } }];
  } catch {
    return [];
  }
}

/** A task row as stored, checked. */
export interface StoredReportRow {
  taskId: string;
  project: string;
  title: string;
  origin: ReportOrigin;
  startedAt: string;
  state: ReportState;
  path?: "quick" | "full" | undefined;
  firstPrAt?: string | undefined;
  endedAt?: string | undefined;
  prsOpened: number;
  prsMerged: number;
  prLinks: string[];
  settledAt?: string | undefined;
  /** Slice A4: the time split and send-backs, kept when the task settled and its events covered it. Absent: not known. */
  times?: TaskTimes | undefined;
  version: number;
  key: { pk: string; sk: string };
}

const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): value is string => typeof value === "string" && REPORT_INSTANT.test(value) && !Number.isNaN(Date.parse(value));

/** The stored row of this company, or undefined when it is not one (another company's, wrong shape, key that does not match its own fields). */
export function storedRowOf(row: StoredDocument, companyId: OrgId): StoredReportRow | undefined {
  if (row["entityType"] !== "REPORT_TASK" || !rowBelongsToCompany(row, companyId)) return undefined;
  const origin = ReportOriginSchema.safeParse(row["origin"]);
  const state = ReportStateSchema.safeParse(row["state"]);
  const path = row["path"] === undefined ? undefined : ReportPathSchema.safeParse(row["path"]);
  const links = row["prLinks"];
  if (!origin.success || !state.success || (path !== undefined && !path.success)) return undefined;
  if (typeof row["taskId"] !== "string" || typeof row["project"] !== "string" || typeof row["title"] !== "string" || !instant(row["startedAt"]) || !natural(row["version"])) return undefined;
  if (row.sk !== `${REPORT_SK.task}${row["startedAt"]}#${row["taskId"]}`) return undefined;
  if (!natural(row["prsOpened"]) || !natural(row["prsMerged"]) || !Array.isArray(links) || links.length > REPORT_PR_LINKS_MAX || !links.every((link) => typeof link === "string")) return undefined;
  if ((row["firstPrAt"] !== undefined && !instant(row["firstPrAt"])) || (row["endedAt"] !== undefined && !instant(row["endedAt"])) || (row["settledAt"] !== undefined && !instant(row["settledAt"]))) return undefined;
  // A `times` that is not six whole numbers is "not known" (the row stays readable), never a guess.
  const times = row["times"] === undefined ? undefined : timesOfStored(row["times"]);
  return {
    taskId: row["taskId"], project: row["project"], title: row["title"], origin: origin.data, startedAt: row["startedAt"], state: state.data, ...(path === undefined ? {} : { path: path.data }), ...(times === undefined ? {} : { times }),
    ...(row["firstPrAt"] === undefined ? {} : { firstPrAt: row["firstPrAt"] }), ...(row["endedAt"] === undefined ? {} : { endedAt: row["endedAt"] }),
    prsOpened: row["prsOpened"], prsMerged: row["prsMerged"], prLinks: links, ...(row["settledAt"] === undefined ? {} : { settledAt: row["settledAt"] }), version: row["version"], key: reportTaskKey(companyId, row["startedAt"], row["taskId"]),
  };
}

/** What the task's own record and milestone rows say about it now. */
export interface TaskFacts {
  state: ReportState;
  path?: "quick" | "full" | undefined;
  firstPrAt?: string | undefined;
  endedAt?: string | undefined;
  prsOpened: number;
  prsMerged: number;
  prLinks: string[];
  /** Slice A4: from the task's work events, when they cover it from its start. Absent: not known (never zero). */
  times?: TaskTimes | undefined;
}

interface MilestoneFact { kind: string; at: string }

/** The milestone rows of one task that this company wrote: kind and time only. Another company's row, or one with a time that is not an instant, is dropped. */
export function milestoneFactsOf(rows: readonly StoredDocument[], companyId: OrgId, taskId: string): MilestoneFact[] {
  const out: MilestoneFact[] = [];
  for (const row of rows) {
    if (row["entityType"] !== "CODE_MILESTONE" || row["orgId"] !== companyId || row["taskId"] !== taskId || typeof row["kind"] !== "string") continue;
    const at = typeof row["at"] === "string" ? new Date(Date.parse(row["at"])) : undefined;
    if (at === undefined || Number.isNaN(at.getTime())) continue;
    out.push({ kind: row["kind"], at: at.toISOString() });
  }
  return out;
}

const earliest = (times: readonly string[]): string | undefined => (times.length === 0 ? undefined : [...times].sort()[0]);

/** Folds a task's record and milestone facts into what the report says. `meta` is the task's `DEVTASK#<id>` / META row (already checked to be this company's). */
export function foldTask(meta: StoredDocument, milestones: readonly MilestoneFact[]): TaskFacts {
  const workflow = (typeof meta["workflow"] === "object" && meta["workflow"] !== null && !Array.isArray(meta["workflow"]) ? meta["workflow"] : undefined) as Record<string, unknown> | undefined;
  const pullRequests = Array.isArray(workflow?.["pullRequests"]) ? (workflow["pullRequests"] as unknown[]).filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null).slice(0, REPORT_PR_LINKS_MAX) : [];
  const prsOpened = pullRequests.length;
  const prsMerged = pullRequests.filter((entry) => entry["state"] === "MERGED").length;
  const prLinks = [...new Set(pullRequests.flatMap((entry) => plainHttpsLink(entry["url"]) ?? []))];
  const path = workflow?.["path"] === "QUICK" ? "quick" as const : workflow?.["path"] === "FULL" ? "full" as const : undefined;
  const mergedAt = earliest(milestones.filter((fact) => fact.kind === "merged").map((fact) => fact.at));
  const firstPrAt = earliest(milestones.filter((fact) => fact.kind === "pr_ready").map((fact) => fact.at));
  const workflowMerged = workflow?.["stage"] === "MERGED" && workflow["state"] === "COMPLETE" && workflow["outcome"] === "MERGED";
  const base = { ...(path === undefined ? {} : { path }), ...(firstPrAt === undefined ? {} : { firstPrAt }), prsOpened, prsMerged, prLinks };
  if (workflowMerged || mergedAt !== undefined) {
    const end = mergedAt ?? (instant(workflow?.["updatedAt"]) ? workflow["updatedAt"] : undefined) ?? (instant(meta["updatedAt"]) ? meta["updatedAt"] : undefined);
    return { state: "merged", ...base, ...(end === undefined ? {} : { endedAt: end }) };
  }
  const closedAt = instant(meta["closedAt"]) ? meta["closedAt"] : undefined;
  if (closedAt !== undefined) return { state: "closed", ...base, endedAt: closedAt };
  return { state: "open", ...base };
}

/** Whether a folded task is final: merged, or closed long enough ago that a retry is no longer expected. */
export function settles(facts: TaskFacts, now: number): boolean {
  if (facts.state === "merged") return true;
  return facts.state === "closed" && facts.endedAt !== undefined && Date.parse(facts.endedAt) + CLOSED_SETTLE_MS <= now;
}
