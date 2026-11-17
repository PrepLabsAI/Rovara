// DEC 254o (b), L2-2 PR 18d: Slack company mode in the DeveloperTaskNotifier. The notifier's company path (its `workspaces` dependency) changes every delivery (scoped tokens,
// no channel-adapter route), so with company mode on the notifier keeps TWO handlers: today's, and a company one. Each queued notice is routed by the record it is about,
// read once: the install's own work (the implicit company, the install's team or no team) goes to today's handler exactly as before; anything else, including anything the
// router cannot read, goes to the company handler (fail closed: the install's token is never used for another company). Stream records (which only queue notices) and the core
// outbox stay on today's handler: they post nothing.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";

type Reader = { send(command: GetCommand): Promise<unknown> };
type Batch = { batchItemFailures: Array<{ itemIdentifier: string }> };
type Handler = (event: { Records?: unknown[] }, context?: { getRemainingTimeInMillis(): number }) => Promise<Batch>;

const INSTALL_ONLY_KINDS = new Set(["admin_change_dm", "admin_change_outcome", "admin_change_expiry"]);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether the install's own work owns this record: the implicit company, and the install's team or none. Anything else (another company, another team, odd values) is not. */
function installOwns(row: Record<string, unknown>, legacyTeamId: string): boolean {
  const company = row.companyId ?? row.orgId ?? IMPLICIT_COMPANY_ID;
  if (company !== IMPLICIT_COMPANY_ID) return false;
  if (row.companyId !== undefined && row.orgId !== undefined && row.companyId !== row.orgId) return false;
  if (row.entityType === "WORKSPACE_COMPANY_POINTER") return false;
  const share = row.share;
  if (share === undefined) return true;
  if (share === null || typeof share !== "object") return false;
  const team = (share as { teamId?: unknown }).teamId;
  return team === undefined || team === legacyTeamId;
}

/**
 * True when the company handler serves this queued notice body. A failed read throws (the message is retried, nothing posted). Every record the delivery would post from is
 * checked: the workspace's META row, the task (named, or found through the workspace's task pointer as the notifier finds it), and a ChatGPT fallback's own thread. A named
 * task that is missing goes to the company handler, which refuses rather than posting with the install token.
 */
export async function noticeServedByCompany(deps: { documentClient: Reader; tableName: string; legacyTeamId: string }, body: unknown): Promise<boolean> {
  let notice: unknown;
  try { notice = typeof body === "string" ? JSON.parse(body) : undefined; } catch { return false; }
  // An unreadable notice is dropped by today's handler as before; it carries nothing to post.
  if (notice === null || typeof notice !== "object" || Array.isArray(notice)) return false;
  const { kind, taskId, workspaceId, operationId } = notice as { kind?: unknown; taskId?: unknown; workspaceId?: unknown; operationId?: unknown };
  // Admin change messages belong to the install's administrators (company mode refuses Slack admin presses).
  if (typeof kind === "string" && INSTALL_ONLY_KINDS.has(kind)) return false;
  const read = async (key: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (taskId !== undefined && (typeof taskId !== "string" || !ID.test(taskId))) return true;
  if (workspaceId !== undefined && (typeof workspaceId !== "string" || !ID.test(workspaceId))) return true;
  let task = typeof taskId === "string" ? taskId : undefined;
  if (typeof workspaceId === "string") {
    const workspace = await read({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
    if (workspace !== undefined && !installOwns(workspace, deps.legacyTeamId)) return true;
    if (task === undefined) {
      const pointer = (await read({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK" }))?.taskId;
      if (pointer !== undefined && (typeof pointer !== "string" || !ID.test(pointer))) return true;
      task = pointer;
    }
    if (kind === "chatgpt_fallback" && operationId !== undefined) {
      if (typeof operationId !== "string" || !ID.test(operationId)) return true;
      const thread = (await read({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` }))?.chatgptThread;
      if (thread !== undefined && (thread === null || typeof thread !== "object" || (thread as { teamId?: unknown }).teamId !== deps.legacyTeamId)) return true;
    }
  }
  if (task === undefined) return false;
  const row = await read({ pk: `DEVTASK#${task}`, sk: "META" });
  return row === undefined || !installOwns(row, deps.legacyTeamId);
}

/** The notifier's two handlers: off (no company handler) today's handler itself; on, queued notices split by their record, every other event to today's handler. */
export function splitNoticesBySlackCompany(legacy: Handler, company: Handler | undefined, serves: (body: unknown) => Promise<boolean>): Handler {
  if (company === undefined) return legacy;
  return async (event, context) => {
    const records = event.Records ?? [];
    const queued = records.filter((record) => (record as { eventSource?: unknown }).eventSource === "aws:sqs");
    if (queued.length === 0) return legacy(event, context);
    const own: unknown[] = [], others: unknown[] = [], failures: Batch["batchItemFailures"] = [];
    for (const record of queued) {
      const { body, messageId } = record as { body?: unknown; messageId?: unknown };
      try { (await serves(body) ? others : own).push(record); }
      catch { if (typeof messageId === "string") failures.push({ itemIdentifier: messageId }); }
    }
    if (own.length > 0) failures.push(...(await legacy({ Records: own }, context)).batchItemFailures);
    if (others.length > 0) failures.push(...(await company({ Records: others }, context)).batchItemFailures);
    return { batchItemFailures: failures };
  };
}

/**
 * The reconciler's sweeps (stuck cancels, unwaited tasks): with company mode on, a thread note for the install's own work (its team, a record of the implicit company) keeps
 * today's path (no scope, today's poster); everything else takes the company path. Without an install team configured, nothing is the install's.
 */
export function slackNoteIsInstalls(legacyTeamId: string | undefined, record: unknown, teamId: unknown): boolean {
  if (legacyTeamId === undefined || teamId !== legacyTeamId || record === null || typeof record !== "object" || Array.isArray(record)) return false;
  return installOwns(record as Record<string, unknown>, legacyTeamId);
}
