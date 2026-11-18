import { workspaceKeys } from "../task-flow/workspace-location.js";
// The setup run's callback: ONE worker-to-broker action, `POST /v1/internal/workspaces/{w}/operations/{o}/setup-agent`, for everything a running setup run reports or asks. It is granted (capability `setup-agent`) only to a
// SETUP_AGENT operation, and the route accepts it only for that operation while it RUNS.
//
// The run is never named by the body. The company, the project and the task come from the authenticated operation (its workspace's task pointer and the task's own record: a setup-run task of this company), and a person is
// never named at all: a host ask is credited to the starter the broker recorded on the task (`requestHostAsk` reads it itself). The body is a strict union:
//   journal       the commands the run ran, in order (at most 20 a call; the broker reads each again and keeps the first for a position);
//   host          a website the run could not reach: the name only (and where it came from): the broker decides whether it is refused, already allowed, joined or a new ask. Nothing is granted;
//   alive         the worker is still here while the run ends (nothing is handed over or answered);
//   poll          "anything for me?": the next command the owner typed (handed over once), and where each host this run asked for stands (open, approved, refused);
//   command_done  a person's command finished, with the journal position of its result;
//   eval_discovery  DEC 253n(1): the eval questions the run found (suites, their question files and categories, the command, judge pins, model catalog row and image), kept once per run and
//                 never trusted for a hash (`eval-discovery.ts`): a maintainer or admin confirms a selection from it, and the broker builds the eval plan from its own reads.
// Nothing in a reply is repository or command text except the person's own command (which only the owner could type and the broker already checked).
import { z } from "zod";
import { agentXError, change, when, type DocumentStore, type OrgId, type TestEnvProdDeny } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { SETUP_AGENT_WORKFLOW_MODE } from "./agent.js";
import { finishSetupCommand, readSetupCommand, takeSetupCommand } from "./command.js";
import { listHostAsks, approvedHostsOf, requestHostAsk } from "./host-ask.js";
import { SETUP_JOURNAL_BATCH_MAX, appendSetupJournal } from "./journal.js";
import { recordEvalDiscovery, type EvalDiscoveryLogEvent } from "./eval-discovery.js";

export interface SetupAgentCallbackDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The websites this install's machines reach by their own list (the install's own allowed websites), so an ask for one of them is "already allowed". */
  installDomains?: (() => readonly string[]) | undefined;
  /** The production deny list that refuses a website without a card. A list that cannot be read does not stop the ask. */
  prodDeny?: ((project: string) => Promise<TestEnvProdDeny | undefined>) | undefined;
  /** FIX-0518: the names this project's test sandbox is denied (the laptop's model hosts; empty when the owner allowed them for the project). A website ask for one is refused as a model host. */
  sandboxDenied?: ((project: string) => readonly string[]) | undefined;
  /** Whether the person who typed a command may still have it run (the owner, read live at hand-over). Absent: nothing is handed over. */
  mayStillRun?: ((by: string) => Promise<boolean>) | undefined;
  /** Fixed-word log lines (the eval discovery's); never the body. */
  log?: ((entry: { event: EvalDiscoveryLogEvent; reason?: string }) => void) | undefined;
}

/** The authenticated operation, as the callback route read it. */
export interface SetupAgentOperation { kind: string; workflowMode?: string | undefined; status: string; workspaceId: string; companyId?: string | undefined }

const HostSchema = z.object({
  kind: z.literal("host"),
  host: z.string().min(1).max(300),
  /** The place of the person's command that was running when the website was blocked (its number in "Run a command"). The broker looks up who typed it; the worker never names a person. */
  viaCommandSeq: z.number().int().min(1).max(20).optional(),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
}).strict();
export const SetupAgentCallbackBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("journal"), entries: z.array(z.unknown()).min(1).max(SETUP_JOURNAL_BATCH_MAX) }).strict(),
  HostSchema,
  z.object({ kind: z.literal("poll") }).strict(),
  // L4-T5: "I am still here", said while the run finishes (the poll has stopped, a person's command may still run). Takes nothing and answers nothing: it only notes the time.
  z.object({ kind: z.literal("alive") }).strict(),
  z.object({ kind: z.literal("command_done"), seq: z.number().int().min(1).max(20), journalN: z.number().int().min(1).max(400).optional() }).strict(),
  // The report itself is checked by `recordEvalDiscovery` (`SetupEvalDiscoveryReportSchema`), so a bad report gets its own fixed refusal.
  z.object({ kind: z.literal("eval_discovery"), report: z.unknown() }).strict(),
]);
export type SetupAgentCallbackBody = z.infer<typeof SetupAgentCallbackBodySchema>;

/** The statuses of an operation whose worker has it: handed over (this install's dispatch does not wait for a worker's own "running" report), or running. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["DISPATCHING", "RUNNING"]);

/** The run an operation belongs to: its task, which must be a setup-run task of this company. Undefined for anything else. */
export async function setupRunOfOperation(deps: Pick<SetupAgentCallbackDeps, "store" | "companyId">, operation: SetupAgentOperation): Promise<{ orgId: OrgId; project: string; taskId: string; seenAt?: string } | undefined> {
  if (operation.kind !== "task" || operation.workflowMode !== SETUP_AGENT_WORKFLOW_MODE || !RUNNING_STATUSES.has(operation.status)) return undefined;
  const pointer = await deps.store.get((await workspaceKeys(deps, operation.workspaceId)).taskPointerKey());
  if (typeof pointer?.["taskId"] !== "string") return undefined;
  const task = await deps.store.get(taskKey(pointer["taskId"]));
  if (task === undefined || task["purpose"] !== "setup_agent" || task["companyId"] !== deps.companyId || task["workspaceId"] !== operation.workspaceId || task["closedAt"] !== undefined || typeof task["project"] !== "string") return undefined;
  if (operation.companyId !== undefined && operation.companyId !== task["companyId"]) return undefined;
  return { orgId: deps.companyId, project: task["project"], taskId: pointer["taskId"], ...(typeof task["setupAgentSeenAt"] === "string" ? { seenAt: task["setupAgentSeenAt"] } : {}) };
}

/** L4-T5: how often the run's task is stamped with the worker's last word (the worker polls every 3 seconds; one write a minute is all a 10-minute silence rule needs). */
export const SETUP_RUN_SEEN_EVERY_MS = 60_000;

/** Notes that the worker just talked, on the run's own task and only while the task is still there. Best effort: a write that fails changes nothing (the next poll tries again). */
async function noteSetupRunSeen(deps: Pick<SetupAgentCallbackDeps, "store" | "now">, run: { taskId: string; seenAt?: string }): Promise<void> {
  const last = run.seenAt === undefined ? Number.NaN : Date.parse(run.seenAt);
  if (Number.isFinite(last) && deps.now() - last < SETUP_RUN_SEEN_EVERY_MS) return;
  await deps.store.update({ key: taskKey(run.taskId), ops: [change.set("setupAgentSeenAt", new Date(deps.now()).toISOString())], condition: when.present() }).catch(() => undefined);
}

/** Handles one setup callback. Throws CALLBACK_FORBIDDEN for an operation that is not a running setup run, CONFIG_INVALID for a body that is not one of its shapes. */
export async function handleSetupAgentCallback(deps: SetupAgentCallbackDeps, operation: SetupAgentOperation, rawBody: unknown): Promise<object> {
  const run = await setupRunOfOperation(deps, operation);
  if (run === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the setup callback is limited to a running setup run");
  const parsed = SetupAgentCallbackBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the setup callback body is not one of its shapes");
  const body = parsed.data;
  const table = { store: deps.store, now: deps.now };
  // L4-T5: any word from a live worker is noted, so a run that is journaling, answering or finishing never reads as stopped.
  await noteSetupRunSeen(deps, run);
  switch (body.kind) {
    case "alive":
      return {};
    case "journal":
      return appendSetupJournal(table, run, body.entries);
    case "host": {
      const projectDomains = [...(deps.installDomains?.() ?? []), ...(await approvedHostsOf(table, run.orgId, run.project))];
      const prodDeny = await deps.prodDeny?.(run.project).catch(() => undefined);
      // Who typed the command that hit the website, from the broker's own stored command of THIS run (a place that is not this run's, or a command not yet handed over, names nobody).
      const via = body.viaCommandSeq === undefined ? undefined : await readSetupCommand(table, run, body.viaCommandSeq);
      const typedBy = via !== undefined && via.state !== "queued" ? via.by : undefined;
      const outcome = await requestHostAsk(table, { ...run, host: body.host, projectDomains, ...(prodDeny === undefined ? {} : { prodDeny }), ...(deps.sandboxDenied === undefined ? {} : { sandboxDenied: deps.sandboxDenied(run.project) }), ...(typedBy === undefined ? {} : { typedBy }), ...(body.journalN === undefined ? {} : { journalN: body.journalN }), ...(body.from === undefined ? {} : { from: body.from }) });
      // A fixed word and nothing else: the worker learns whether it may wait for an answer, never why in words of its own.
      return { outcome: outcome.outcome, ...(outcome.outcome === "refused" ? { reason: outcome.reason } : {}) };
    }
    case "poll": {
      const command = await takeSetupCommand(table, run, deps.mayStillRun);
      const asks = (await listHostAsks(table, run.orgId, run.project, ["open", "approved", "refused"])).filter((ask) => ask.taskId === run.taskId).slice(0, 20);
      return { ...(command === undefined ? {} : { command: { seq: command.seq, command: command.command } }), hosts: asks.map((ask) => ({ host: ask.host, state: ask.state })) };
    }
    case "command_done":
      return { finished: await finishSetupCommand(table, run, { seq: body.seq, journalN: body.journalN }) };
    // DEC 254zzz43: recording the report is ALL it does. A wrapper file is never proposed or written from here: only a person's click (the card's POST) may open a pull request.
    case "eval_discovery":
      return await recordEvalDiscovery({ ...table, store: deps.store, ...(deps.log === undefined ? {} : { log: deps.log }) }, run, body.report);
  }
}
