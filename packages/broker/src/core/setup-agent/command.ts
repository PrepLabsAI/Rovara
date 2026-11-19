// "Run a command" in a setup run: the owner types ONE command; it runs in the run's setup sandbox, is journaled with `source: person`, and is shown to the agent as a RESULT, never as an instruction.
// There is no interactive terminal.
//
// What the broker decides here:
//   - WHO: the owner, on a local page's own session (a command runs code, so it is the person's own act at their keyboard: never a script token, an MCP client or the API token), for a run that is going now.
//   - WHAT: one line of at most 1,000 characters with no control or format characters, and no secret. A command that the redactor would change is REFUSED, not run in a changed form: a person is never
//     allowed to paste a credential into the setup sandbox, and what runs is exactly what they typed.
//   - HOW MANY: one at a time (the run's sandbox is single), at most `SETUP_PERSON_COMMANDS_MAX` per run, and a repeat of a request id is the same command (it returns the first answer and queues nothing).
//   - DELIVERY: the worker asks for it (`takeSetupCommand`, over the worker's setup callback). The company, project and task come from the authenticated operation, never from the worker's body. A command
//     taken and not finished within the longest a command may run is treated as finished, so a worker that died does not block the box for good.
// Nothing here executes anything. The command's text sits in the store for the length of the run's retention and nowhere else (no log line, no event).
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, change, redactText, when, type DocumentKey, type DocumentStore } from "@agentx/contracts";
import { expiryOf, setupPartition, type RunScope } from "./keys.js";

type Table = { store: Pick<DocumentStore, "get" | "put" | "update" | "transact">; now: () => number };

/** A command's longest text, and how many a person may run in one setup run. */
export const SETUP_COMMAND_TEXT_MAX = 1_000;
export const SETUP_PERSON_COMMANDS_MAX = 20;
/** The longest a taken command may be out before it is read as finished: the worker's own longest command (an hour) and a little over. */
export const SETUP_COMMAND_TAKEN_STALE_MS = 65 * 60_000;

export const SETUP_COMMAND_WORDS = {
  busy: "A command from a person is still running. Wait for it to finish.",
  limit: "This setup run has reached its limit of commands typed by a person.",
  notRunning: "The setup run is not going now, so a command cannot be run.",
  oneLine: "A command is one line of plain text, up to 1,000 characters.",
  secret: "That looks like it holds a secret. Rovara does not run commands with secrets in them.",
  pageOnly: "Run a command from Rovara's setup page in your browser: a command needs your own signed-in page, not a token.",
} as const;

/** The command a person may run: one plain line, not empty, not too long, and exactly what the redactor would leave. Returns the text, or the fixed sentence for why not. */
export function checkPersonCommand(raw: string): { ok: true; command: string } | { ok: false; reason: "oneLine" | "secret" } {
  const command = raw.trim();
  if (command === "" || command.length > SETUP_COMMAND_TEXT_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)) return { ok: false, reason: "oneLine" };
  if (redactText(command) !== command) return { ok: false, reason: "secret" };
  return { ok: true, command };
}

const counterKey = (scope: RunScope): DocumentKey => ({ pk: setupPartition(scope.orgId, scope.project), sk: `CMDCOUNT#${scope.taskId}` });
const commandKey = (scope: RunScope, seq: number): DocumentKey => ({ pk: setupPartition(scope.orgId, scope.project), sk: `CMD#${scope.taskId}#${String(seq).padStart(3, "0")}` });
const requestKey = (scope: RunScope, requestId: string): DocumentKey => ({ pk: setupPartition(scope.orgId, scope.project), sk: `CMDREQ#${scope.taskId}#${requestId}` });
const commandHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export type CommandState = "queued" | "taken" | "done";
export interface StoredCommand { seq: number; requestId: string; command: string; by: string; state: CommandState; createdAt: string; takenAt?: string; doneAt?: string; journalN?: number }

function commandOf(item: Record<string, unknown> | undefined, scope: RunScope): StoredCommand | undefined {
  if (item === undefined || item["entityType"] !== "SETUP_COMMAND" || item["taskId"] !== scope.taskId || item["orgId"] !== scope.orgId || item["project"] !== scope.project) return undefined;
  const state = item["state"];
  if ((state !== "queued" && state !== "taken" && state !== "done") || typeof item["seq"] !== "number" || typeof item["command"] !== "string" || typeof item["requestId"] !== "string" || typeof item["by"] !== "string" || typeof item["createdAt"] !== "string") return undefined;
  return {
    seq: item["seq"], requestId: item["requestId"], command: item["command"], by: item["by"], state, createdAt: item["createdAt"],
    ...(typeof item["takenAt"] === "string" ? { takenAt: item["takenAt"] } : {}), ...(typeof item["doneAt"] === "string" ? { doneAt: item["doneAt"] } : {}), ...(typeof item["journalN"] === "number" ? { journalN: item["journalN"] } : {}),
  };
}

/** Whether a command still holds the box: queued, or taken and not yet stale. */
function holdsBox(command: StoredCommand, nowMs: number): boolean {
  if (command.state === "done") return false;
  if (command.state === "queued") return true;
  return nowMs - Date.parse(command.takenAt ?? command.createdAt) < SETUP_COMMAND_TAKEN_STALE_MS;
}

export type QueueOutcome = { status: 202 | 200; seq: number; state: CommandState };

/**
 * Queues one command for the run `scope` names. The caller's authority and the run's state are checked by the route; this is the store. A repeat of `requestId` answers the first command and writes nothing;
 * a second command while one holds the box, or past the run's limit, is refused with a fixed sentence.
 */
export async function queueSetupCommand(table: Table, scope: RunScope, input: { requestId: string; command: string; by: string }): Promise<QueueOutcome> {
  const conflict = () => agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different command.");
  const repeat = await table.store.get(requestKey(scope, input.requestId));
  if (repeat !== undefined) {
    // The same request id means the same command from the same person: other text (or another person) is a conflict, never answered with the first command.
    if (repeat["by"] !== input.by || typeof repeat["seq"] !== "number" || repeat["commandHash"] !== commandHash(input.command)) throw conflict();
    const first = commandOf(await table.store.get(commandKey(scope, repeat["seq"])), scope);
    return { status: 200, seq: repeat["seq"], state: first?.state ?? "done" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const counter = await table.store.get(counterKey(scope));
    const count = typeof counter?.["count"] === "number" ? counter["count"] : 0;
    if (count >= SETUP_PERSON_COMMANDS_MAX) throw agentXError("TOO_MANY_REQUESTS", SETUP_COMMAND_WORDS.limit);
    if (count > 0) {
      const latest = commandOf(await table.store.get(commandKey(scope, count)), scope);
      if (latest === undefined || holdsBox(latest, table.now())) throw agentXError("WORKSPACE_BUSY", SETUP_COMMAND_WORDS.busy);
    }
    const seq = count + 1;
    const at = new Date(table.now()).toISOString();
    const result = await table.store.transact([
      { kind: "update", key: counterKey(scope), ops: [change.set("count", seq), change.set("entityType", "SETUP_COMMAND_COUNT"), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryOf(table.now())[INDEX_EXPIRY_ATTRIBUTE])], condition: count === 0 ? when.notExists("count") : when.eq("count", count) },
      { kind: "put", item: { ...commandKey(scope, seq), entityType: "SETUP_COMMAND", orgId: scope.orgId, project: scope.project, taskId: scope.taskId, seq, requestId: input.requestId, command: input.command, by: input.by, state: "queued", createdAt: at, ...expiryOf(table.now()) }, condition: when.absent() },
      { kind: "put", item: { ...requestKey(scope, input.requestId), entityType: "SETUP_COMMAND_REQUEST", seq, by: input.by, commandHash: commandHash(input.command), ...expiryOf(table.now()) }, condition: when.absent() },
    ]);
    if (result.applied) return { status: 202, seq, state: "queued" };
    // Another request took the place, or this very request committed first: read again.
    const again = await table.store.get(requestKey(scope, input.requestId));
    if (again !== undefined && again["by"] === input.by && typeof again["seq"] === "number" && again["commandHash"] === commandHash(input.command)) return { status: 200, seq: again["seq"], state: "queued" };
    if (again !== undefined) throw conflict();
  }
  throw agentXError("WORKSPACE_BUSY", SETUP_COMMAND_WORDS.busy);
}

/**
 * The worker asks for the next command of its run. Returns it once and marks it taken; a second ask while it is out returns nothing. The scope comes from the authenticated operation.
 * The text returned is the person's, exactly as accepted: the worker runs it and shows the result to the agent as data.
 */
export async function takeSetupCommand(
  table: Table, scope: RunScope,
  /** Whether the person who typed it may still run commands here (read live at hand-over). A command whose typist can no longer act is dropped, never run. Absent: nothing is handed over. */
  mayStillRun?: (by: string) => Promise<boolean>,
): Promise<{ seq: number; command: string; by: string } | undefined> {
  const counter = await table.store.get(counterKey(scope));
  const count = typeof counter?.["count"] === "number" ? counter["count"] : 0;
  if (count === 0) return undefined;
  const latest = commandOf(await table.store.get(commandKey(scope, count)), scope);
  if (latest === undefined || latest.state !== "queued") return undefined;
  const taken = await table.store.update({ key: commandKey(scope, count), ops: [change.set("state", "taken"), change.set("takenAt", new Date(table.now()).toISOString())], condition: when.eq("state", "queued") });
  if (!taken.applied) return undefined;
  if (mayStillRun === undefined || !(await mayStillRun(latest.by).catch(() => false))) {
    // The typist can no longer act: the command is finished without running (it must not hold the box).
    await finishSetupCommand(table, scope, { seq: latest.seq, skipped: true }).catch(() => false);
    return undefined;
  }
  return { seq: latest.seq, command: latest.command, by: latest.by };
}

/** One stored command of the run (its typist and state), or undefined. Reads only this run's rows. */
export async function readSetupCommand(table: Pick<Table, "store">, scope: RunScope, seq: number): Promise<StoredCommand | undefined> {
  if (!Number.isInteger(seq) || seq < 1 || seq > SETUP_PERSON_COMMANDS_MAX) return undefined;
  return commandOf(await table.store.get(commandKey(scope, seq)), scope);
}

/** The worker says the command finished and which journal position holds its result. Only a taken command can finish; a repeat changes nothing. */
export async function finishSetupCommand(table: Table, scope: RunScope, input: { seq: number; journalN?: number | undefined; skipped?: boolean }): Promise<boolean> {
  if (!Number.isInteger(input.seq) || input.seq < 1 || input.seq > SETUP_PERSON_COMMANDS_MAX) return false;
  const written = await table.store.update({
    key: commandKey(scope, input.seq),
    ops: [change.set("state", "done"), change.set("doneAt", new Date(table.now()).toISOString()), ...(input.journalN === undefined ? [] : [change.set("journalN", input.journalN)]), ...(input.skipped === true ? [change.set("skipped", true)] : [])],
    condition: when.and(when.eq("taskId", scope.taskId), input.skipped === true ? when.or(when.eq("state", "taken"), when.eq("state", "queued")) : when.eq("state", "taken")),
  });
  return written.applied;
}
