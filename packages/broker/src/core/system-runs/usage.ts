// Machine time of system runs, attributed to the company and project that pay for it (lead 4 L4-P1; owner DEC 254zzl 4: the COMPANY pays machine time for system runs, nothing is free).
//
// What exists today: a machine is ADMITTED when it starts (`machine.start`, keyed by workspace, with the project as the thing charged, core/task-flow/dispatch.ts), and `Admission.settle` takes tokens and cost, not machine
// time (core/task-flow/close.ts says so: the machine time actually used is a port gap). There is NO machine-minute meter and NO machine-minute limit anywhere. So this file does what can be done honestly:
//   - ONE ROW per system run, written when the run starts, naming the company, the project, the kind and the run's own workspace: partition `ORG#<company>#SYSTEM_RUN_USAGE#<month>`, sort key `<project>#<request hash>`.
//     A company's month is one partition read; a project's is one range of it. No row is shared by two companies, and a project's name is part of every key.
//   - MINUTES ARE MEASURED, never stated by a caller: `readSystemRunUsage` reads each row's workspace and counts from its creation to its close (or to now, for one still open, and never past `AUTOMATIC_RUN_MAX_MS`).
// What limit enforcement still needs (not built here): a machine-minute cap kind in the company's and project's spend limits (Cloud) and in `Admission`, checked before `machine.start` against `readSystemRunUsage`, and a
// unit price if the minutes are to be shown as dollars. Until then these minutes are COUNTED and ATTRIBUTED, and what bounds them is the project's monthly count of automatic runs (default 100) and one-at-a-time.
import { createHash } from "node:crypto";
import {
  AUTOMATIC_RUN_MAX_MS, AGENTX_NAME_PATTERN, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SystemRunKindSchema, companyScoped, queryAll, when, type DocumentKey, type OrgId, type SystemRunKind,
} from "@agentx/contracts";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";

const KEEP_SECONDS = 400 * 86_400;
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export function systemRunUsagePartition(orgId: OrgId, month: string): string {
  if (!OrgIdSchema.safeParse(orgId).success || !MONTH.test(month)) throw new Error("not a usage partition");
  return companyScoped(orgId, `SYSTEM_RUN_USAGE#${month}`);
}
export function systemRunUsageKey(orgId: OrgId, month: string, project: string, requestId: string): DocumentKey {
  if (!AGENTX_NAME_PATTERN.test(project)) throw new Error("not a project name");
  return { pk: systemRunUsagePartition(orgId, month), sk: `${project}#${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}` };
}

type UsageDeps = Pick<TaskFlowDeps, "store" | "companyId" | "now">;
const nowMs = (deps: Pick<UsageDeps, "now">): number => (deps.now?.() ?? new Date()).getTime();

/** Writes the run's usage row once (a repeat of the same request writes nothing more). Throws what the store throws: the caller decides whether that stops anything. */
export async function recordSystemRunUsage(deps: UsageDeps, input: { project: string; kind: SystemRunKind; workspaceId: string; requestId: string }): Promise<void> {
  const kind = SystemRunKindSchema.parse(input.kind);
  const at = nowMs(deps);
  const month = monthOf(at);
  // A row that is already there is the same run's (a retried start): the condition refuses and nothing more is written.
  await deps.store.put({
    item: {
      ...systemRunUsageKey(deps.companyId, month, input.project, input.requestId), entityType: "SYSTEM_RUN_USAGE", orgId: deps.companyId, project: input.project, kind, workspaceId: input.workspaceId,
      requestId: input.requestId, month, startedAt: new Date(at).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + KEEP_SECONDS,
    },
    condition: when.absent(),
  });
}

export interface SystemRunUsageReport {
  month: string;
  runs: number;
  minutes: number;
  byProject: Readonly<Record<string, { runs: number; minutes: number }>>;
  byKind: Readonly<Partial<Record<SystemRunKind, { runs: number; minutes: number }>>>;
}

/**
 * The company's system runs of one UTC month with their measured machine minutes, for the whole company or for one project. A row of another company or another project is never counted (checked on the row's own
 * fields, not only its key). A run whose workspace cannot be read counts as a run with no minutes (never a guess).
 */
export async function readSystemRunUsage(deps: UsageDeps, input: { month?: string; project?: string }): Promise<SystemRunUsageReport> {
  const month = input.month ?? monthOf(nowMs(deps));
  const rows = await queryAll(deps.store, { pk: systemRunUsagePartition(deps.companyId, month), ...(input.project === undefined ? {} : { sk: { op: "beginsWith" as const, prefix: `${input.project}#` } }) });
  const report: { month: string; runs: number; minutes: number; byProject: Record<string, { runs: number; minutes: number }>; byKind: Partial<Record<SystemRunKind, { runs: number; minutes: number }>> } = { month, runs: 0, minutes: 0, byProject: {}, byKind: {} };
  for (const row of rows) {
    if (row["entityType"] !== "SYSTEM_RUN_USAGE" || row["orgId"] !== deps.companyId || row["month"] !== month || typeof row["project"] !== "string" || !AGENTX_NAME_PATTERN.test(row["project"])) continue;
    if (input.project !== undefined && row["project"] !== input.project) continue;
    const kind = SystemRunKindSchema.safeParse(row["kind"]);
    if (!kind.success || typeof row["workspaceId"] !== "string") continue;
    const minutes = await minutesOf(deps, row["workspaceId"], typeof row["startedAt"] === "string" ? row["startedAt"] : undefined);
    report.runs += 1;
    report.minutes += minutes;
    const project = (report.byProject[row["project"]] ??= { runs: 0, minutes: 0 });
    project.runs += 1; project.minutes += minutes;
    const byKind = (report.byKind[kind.data] ??= { runs: 0, minutes: 0 });
    byKind.runs += 1; byKind.minutes += minutes;
  }
  return report;
}

/** Whole minutes (rounded up: a started minute is a minute) from the workspace's creation to its close, or to now while it is open; never more than the run's own age limit. */
async function minutesOf(deps: UsageDeps, workspaceId: string, startedAt: string | undefined): Promise<number> {
  try {
    const found = await deps.store.get((await workspaceKeys({ store: deps.store, companyId: deps.companyId }, workspaceId)).workspaceKey);
    if (found === undefined || found["companyId"] !== deps.companyId) return 0;
    const start = Date.parse(typeof found["createdAt"] === "string" ? found["createdAt"] : (startedAt ?? ""));
    if (!Number.isFinite(start)) return 0;
    const closed = typeof found["closedAt"] === "string" ? Date.parse(found["closedAt"]) : NaN;
    const end = Number.isFinite(closed) ? closed : nowMs(deps);
    return Math.ceil(Math.max(0, Math.min(end - start, AUTOMATIC_RUN_MAX_MS)) / 60_000);
  } catch {
    return 0;
  }
}
