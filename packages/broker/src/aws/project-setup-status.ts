// Guided onboarding PR 8 (DEC 254j/254k/254l; design "Project setup checklist"): ONE project setup-status read for the resumable checklist, plus the per-project record of skipped
// optional rows.
//
//   GET /v1/dev/client/projects/{project}/setup-status          any member of the project's company
//   PUT /v1/dev/client/projects/{project}/setup-status/skips    a company owner or admin, or the project's administrator
//   PUT /v1/dev/client/projects/{project}/setup-status/eval-none  the same people: confirm (or take back) "no evals" for the project's latest finished setup run (L2-5 c)
//
// "Progress is read from the real state, not a saved wizard position": every row is derived on each request, from records Code already keeps:
//   repos        the project's latest revision (the same row `GET /v1/dev/client/projects/{project}` reads)
//   setupRun     the setup run's pointer and task (`readState`, the laptop Setup screen's own reader), the run's journal for a failed run's command and last lines
//   evalConfirm  the latest run's eval report row (`readEvalDiscovery`): reported, or confirmed by a person (DEC 253n/253q); done by itself when the finished run left no report at all (L4-T5, owner D9)
//   aiAndSpend   the project's settings row (its own per-task model budget) and the company's model choice row; neither saved means the install's defaults apply (prefilled: done)
//   slackChannel the project's Slack channel bindings (the existing binding rows, injected by the route)
//   linear       the SEAM for PR #838's team pick (`SetupStatusReaders.linearTeam`); absent on code/next, so optional or skipped
//   invites      no Code state: optional or skipped
//   firstTask    whether the project has any task that is not a setup run (the byWorkspaceProject index, then each workspace's task)
// The only stored state is which optional rows were skipped (`SETUP_SKIPS#<project>` in the company's partition) and a person's "no evals" answer for one setup run
// (`SETUP_EVAL_NONE#<project>`, L2-5 c), each changed with an audit row in the same transaction.
//
// Rules held here:
//   - The company is the caller's, from live membership, and the project must be that company's (`recordInCompany` on its latest revision); every key below is built from it. Another company's
//     project, an unknown one and an unreadable name are one answer (the route's NOT_FOUND "project not found").
//   - A stored row that does not read back (wrong company or project, bad shape) is a fixed 503, never a guess and never a partial answer.
//   - Nothing from a run's output is returned except what its journal already shows on the Setup screen, redacted and bounded again here; failure words are the broker's fixed sentences.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, ProjectSetupEvalNoneBodySchema, ProjectSetupSkipBodySchema, SETUP_SKIPPABLE_ROWS, SETUP_STATUS_ROWS, SetupJournalEntrySchema, SetupProposalSchema, agentXError, companyScoped, redactAndCap, workspaceProjectIndexValue,
  type DocumentKey, type DocumentStore, type OrgId, type ProjectSetupChecklist, type SetupJournalEntry, type SetupProposal, type SetupRowState, type SetupSkippableRow, type SetupStatusRow, type StoredDocument,
  WORKSPACE_PROJECT_INDEX,
} from "@agentx/contracts";
import { readModelSelectionPolicy, PolicyUnreadable } from "../core/model-selection/policy-store.js";
import { SETUP_AGENT_FAILURES, readState } from "../core/setup-agent/agent.js";
import { evalDiscoveryKey, readEvalDiscovery } from "../core/setup-agent/eval-discovery.js";
import { journalKey, setupAgentKey, setupPartition } from "../core/setup-agent/keys.js";
import { taskKey, taskPointerKey } from "../core/task-flow/keys.js";
import { taskPointerKey as legacyTaskPointerKey } from "../developer/task-records.js";
import { recordInCompany } from "./company-check.js";
import { readRepositoryMoves, repositoryFullName } from "./github-credentials.js";
import { projectSettingsKey } from "./project-settings.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

export const SETUP_STATUS_UNREADABLE = "the project's setup status could not be read";
export const NOT_A_SETUP_ADMIN = "only the project's administrators or a company owner or admin can change the setup checklist";
export const SETUP_SKIPS_BODY = "send the row (slackChannel, linear or invites) and skipped (true or false), and nothing else";
export const SETUP_SKIPS_STALE = "the checklist changed while you were saving; try again";
export const NOT_AN_EVAL_ADMIN = "only the project's administrators or a company owner or admin can confirm how work is checked";
export const EVAL_NONE_BODY = "send noEvals (true or false), and nothing else";
export const EVAL_NONE_NEEDS_SETUP = "Finish the setup run first, then confirm how work is checked.";
export const EVAL_ALREADY_CONFIRMED = "The eval for this setup run is already confirmed.";

/** The most workspaces looked at, newest first, when asking whether the project has a task. */
const TASK_PROBE_WORKSPACES = 25;
/** The failing command's output: at most this many lines of at most this many characters, and this many characters in all. */
const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 300;
const TAIL_REDACT_CHARS = 8_192;
/** The setup run's journal: at most this many pages of this many rows are read (the schema holds a run to 400 entries). */
const JOURNAL_PAGE = 100;
const JOURNAL_PAGES = 8;

const unreadable = () => agentXError("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE);

// ---- keys

/** The project's skipped optional rows: one record per company and project, in the company's own partition. The company id is an org id (never a '#'). */
export const setupSkipsKey = (companyId: string, project: string): DocumentKey => ({ pk: companyScoped(OrgIdSchema.parse(companyId), `SETUP_SKIPS#${project}`), sk: "META" });

/** The person's "no evals" answer for one setup run: one record per company and project, in the company's own partition. */
export const setupEvalNoneKey = (companyId: string, project: string): DocumentKey => ({ pk: companyScoped(OrgIdSchema.parse(companyId), `SETUP_EVAL_NONE#${project}`), sk: "META" });

// ---- what the route supplies (the reads that need the route's own seams)

export interface SetupStatusReaders {
  /** The project's Slack channel links, as the existing binding rows say (ids; a name only when the route could look it up). Absent or throwing: the row cannot be read (a fixed 503). */
  channels(): Promise<Array<{ channelId: string; name?: string; isPrivate?: boolean }>>;
  /**
   * The seam for PR #838 (Linear OAuth): the project's picked Linear team, when code/next has one. Absent today, so the row is `optional` (or `skipped`).
   * #838 supplies `GET /v1/dev/company/linear/projects/{project}`'s record here; nothing else in this file changes.
   */
  linearTeam?: (() => Promise<{ id: string; name?: string } | undefined>) | undefined;
}

export interface SetupStatusInput {
  documentClient: Client;
  tableName: string;
  now: () => number;
  companyId: string;
  project: string;
  /** The project's latest revision row (already checked to be this company's). */
  definition: { revision: number; repositories?: unknown };
  viewer: { companyRole: "owner" | "admin" | "member" | null; projectAdmin: boolean };
  readers: SetupStatusReaders;
}

const asRecord = (value: unknown): Item | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Item : undefined);

/** A read-only document store over the state table: `get` is the only thing the shared readers below use. Anything else throws. */
function readOnlyStore(client: Client, tableName: string): DocumentStore {
  const refuse = () => { throw new Error("read only"); };
  return new Proxy({}, {
    get(_target, name) {
      if (name === "get") return async (key: DocumentKey): Promise<StoredDocument | undefined> => (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: StoredDocument }).Item;
      if (name === "indexes") return [];
      return refuse;
    },
  }) as DocumentStore;
}

// ---- skips

export interface SkipsRecord { skipped: SetupSkippableRow[]; revision: number }

/** The project's skipped rows. No record: none. A record that names another company or project, or does not parse, is unreadable (never applied). */
export async function readSkips(client: Client, tableName: string, companyId: string, project: string): Promise<SkipsRecord> {
  const item = asRecord((await client.send(new GetCommand({ TableName: tableName, Key: setupSkipsKey(companyId, project), ConsistentRead: true })) as { Item?: unknown }).Item);
  if (item === undefined) return { skipped: [], revision: 0 };
  const rows = item["skipped"];
  if (item["entityType"] !== "PROJECT_SETUP_SKIPS" || item["companyId"] !== companyId || item["project"] !== project || !Array.isArray(rows) || typeof item["revision"] !== "number" || !Number.isInteger(item["revision"])
    || !rows.every((row) => (SETUP_SKIPPABLE_ROWS as readonly unknown[]).includes(row)) || new Set(rows).size !== rows.length) throw unreadable();
  return { skipped: rows as SetupSkippableRow[], revision: item["revision"] };
}

/**
 * `PUT .../setup-status/skips`: set or clear one optional row's "Set up later" mark. `mayChange` is the caller's right (company owner or admin, or the project's administrator), decided by the
 * route from LIVE records before any body is read. A repeat of what is stored writes nothing and answers the same. The change and its audit row are one transaction, conditional on the revision read.
 */
export async function putSkip(input: {
  documentClient: Client; tableName: string; now: () => number; companyId: string; project: string; personId: string; mayChange: boolean; body: () => unknown;
}): Promise<{ project: string; row: SetupSkippableRow; skipped: boolean; skippedRows: SetupSkippableRow[] }> {
  if (!input.mayChange) throw agentXError("FORBIDDEN", NOT_A_SETUP_ADMIN);
  const body = ProjectSetupSkipBodySchema.safeParse(input.body());
  if (!body.success) throw agentXError("CONFIG_INVALID", SETUP_SKIPS_BODY);
  const { row, skipped } = body.data;
  const current = await readSkips(input.documentClient, input.tableName, input.companyId, input.project);
  const has = current.skipped.includes(row);
  if (has === skipped) return { project: input.project, row, skipped, skippedRows: orderedRows(current.skipped) };
  const next = orderedRows(skipped ? [...current.skipped, row] : current.skipped.filter((entry) => entry !== row));
  const at = new Date(input.now()).toISOString();
  const key = setupSkipsKey(input.companyId, input.project);
  try {
    await input.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: input.tableName, Item: { ...key, entityType: "PROJECT_SETUP_SKIPS", companyId: input.companyId, project: input.project, skipped: next, revision: current.revision + 1, updatedAt: at, updatedBy: input.personId },
        ConditionExpression: current.revision === 0 ? "attribute_not_exists(pk)" : "#revision = :revision",
        ...(current.revision === 0 ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": current.revision } }) } },
      { Put: { TableName: input.tableName, Item: { pk: companyScoped(OrgIdSchema.parse(input.companyId), "COMPANY_LOG"), sk: `${at}#${randomUUID()}`, entityType: "COMPANY_LOG",
        event: "project_setup_skip_changed", companyId: input.companyId, personId: input.personId, projectName: input.project, row, skipped }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | undefined)?.CancellationReasons;
    if (reasons?.some((reason) => reason?.Code === "ConditionalCheckFailed") === true || (error as { name?: unknown }).name === "ConditionalCheckFailedException") throw agentXError("CHANGE_STALE", SETUP_SKIPS_STALE);
    throw agentXError("RUNTIME_UNAVAILABLE", SETUP_STATUS_UNREADABLE);
  }
  return { project: input.project, row, skipped, skippedRows: next };
}

const orderedRows = (rows: readonly SetupSkippableRow[]): SetupSkippableRow[] => SETUP_SKIPPABLE_ROWS.filter((row) => rows.includes(row));

// ---- "no evals" (L2-5 c)

export interface EvalNoneRecord { taskId: string; revision: number; confirmedAt: string; confirmedBy: string }

/** The project's "no evals" answer. No record: none. A record that names another company or project, or does not parse, is unreadable (never applied). */
export async function readEvalNone(client: Client, tableName: string, companyId: string, project: string): Promise<EvalNoneRecord | undefined> {
  const item = asRecord((await client.send(new GetCommand({ TableName: tableName, Key: setupEvalNoneKey(companyId, project), ConsistentRead: true })) as { Item?: unknown }).Item);
  if (item === undefined) return undefined;
  const { taskId, revision, confirmedAt, confirmedBy } = item;
  if (item["entityType"] !== "PROJECT_SETUP_EVAL_NONE" || item["companyId"] !== companyId || item["project"] !== project || typeof taskId !== "string" || taskId === "" || taskId.length > 160
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || typeof confirmedAt !== "string" || confirmedAt.length > 40 || !Number.isFinite(Date.parse(confirmedAt))
    || typeof confirmedBy !== "string" || confirmedBy === "" || confirmedBy.length > 256) throw unreadable();
  return { taskId, revision, confirmedAt, confirmedBy };
}

/** The project's latest setup run, when it ended with a whole proposal (the checklist's "setup run" row is done); else undefined. */
async function finishedSetupRun(client: Client, tableName: string, companyId: OrgId, project: string, revision: number, now: () => number): Promise<string | undefined> {
  const store = readOnlyStore(client, tableName);
  const pointer = await store.get(setupAgentKey(companyId, project));
  const taskId = pointer?.["taskId"];
  if (typeof taskId !== "string" || taskId === "") return undefined;
  const view = (await readState({ store, companyId, now }, project, revision)).view;
  return view.status === "ready" && view.summary?.partial !== true && view.taskId === taskId ? taskId : undefined;
}

/**
 * `PUT .../setup-status/eval-none`: a person who may change the checklist confirms that the project runs NO evals (`noEvals: true`), or takes that back (`false`). The answer is bound to the
 * project's latest setup run that ended with a whole proposal: a later setup run needs a new answer. Refused: a person who may not change the checklist (403, before the body is read), no
 * finished setup run (409), a run whose eval is already confirmed (409: no edit after confirmation). A repeat of what is stored writes nothing. The change and its audit row are one
 * transaction, conditional on what was read.
 */
export async function putEvalNone(input: {
  documentClient: Client; tableName: string; now: () => number; companyId: string; project: string; revision: number; personId: string; mayChange: boolean; body: () => unknown;
}): Promise<{ project: string; noEvals: boolean; taskId: string | null }> {
  if (!input.mayChange) throw agentXError("FORBIDDEN", NOT_AN_EVAL_ADMIN);
  const body = ProjectSetupEvalNoneBodySchema.safeParse(input.body());
  if (!body.success) throw agentXError("CONFIG_INVALID", EVAL_NONE_BODY);
  const companyId = OrgIdSchema.parse(input.companyId);
  const client = input.documentClient;
  let current: EvalNoneRecord | undefined;
  let run: string | undefined;
  let confirmed: boolean;
  try {
    current = await readEvalNone(client, input.tableName, companyId, input.project);
    run = await finishedSetupRun(client, input.tableName, companyId, input.project, input.revision, input.now);
    const discovery = run === undefined ? undefined : await readEvalDiscovery({ store: readOnlyStore(client, input.tableName), companyId }, input.project);
    confirmed = discovery !== undefined && discovery.taskId === run && discovery.state === "confirmed";
  } catch (error) {
    if ((error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE") throw error;
    throw unreadable();
  }
  const key = setupEvalNoneKey(companyId, input.project);
  const at = new Date(input.now()).toISOString();
  const audit = (noEvals: boolean, taskId: string) => ({ Put: { TableName: input.tableName, Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${at}#${randomUUID()}`, entityType: "COMPANY_LOG",
    event: "project_setup_eval_none_changed", companyId, personId: input.personId, projectName: input.project, noEvals, taskId }, ConditionExpression: "attribute_not_exists(pk)" } });
  const held = current === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": current.revision } };
  let items: unknown[];
  let answer: { project: string; noEvals: boolean; taskId: string | null };
  if (body.data.noEvals) {
    if (run === undefined) throw agentXError("CHANGE_STALE", EVAL_NONE_NEEDS_SETUP);
    if (confirmed) throw agentXError("CHANGE_STALE", EVAL_ALREADY_CONFIRMED);
    answer = { project: input.project, noEvals: true, taskId: run };
    if (current?.taskId === run) return answer;
    items = [{ Put: { TableName: input.tableName, Item: { ...key, entityType: "PROJECT_SETUP_EVAL_NONE", companyId, project: input.project, taskId: run, revision: (current?.revision ?? 0) + 1, confirmedAt: at, confirmedBy: input.personId }, ...held } },
      // What the answer was decided on must still hold when it is written: the run is still the project's latest, and its eval was not confirmed meanwhile.
      { ConditionCheck: { TableName: input.tableName, Key: setupAgentKey(companyId, input.project), ConditionExpression: "#taskId = :run", ExpressionAttributeNames: { "#taskId": "taskId" }, ExpressionAttributeValues: { ":run": run } } },
      { ConditionCheck: { TableName: input.tableName, Key: evalDiscoveryKey(companyId, input.project, run), ConditionExpression: "attribute_not_exists(pk) OR #state <> :confirmed",
        ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":confirmed": "confirmed" } } },
      audit(true, run)];
  } else {
    answer = { project: input.project, noEvals: false, taskId: null };
    if (current === undefined) return answer;
    items = [{ Delete: { TableName: input.tableName, Key: key, ...held } }, audit(false, current.taskId)];
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: items as never }));
  } catch (error) {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | undefined)?.CancellationReasons;
    if (reasons?.some((reason) => reason?.Code === "ConditionalCheckFailed") === true || (error as { name?: unknown }).name === "ConditionalCheckFailedException") throw agentXError("CHANGE_STALE", SETUP_SKIPS_STALE);
    throw unreadable();
  }
  return answer;
}

// ---- the rows

/** The repos row. DEC 254zc(1): a repository this company's signed GitHub webhooks marked (moved to another owner, or off the App's list) carries `access`; the row's state and count are as before. */
async function reposRow(input: SetupStatusInput, client: Client, companyId: OrgId): Promise<ProjectSetupChecklist["repos"]> {
  const definition = input.definition;
  const items = (Array.isArray(definition.repositories) ? definition.repositories : []).flatMap((entry: unknown) => {
    const repository = asRecord(entry);
    if (typeof repository?.["name"] !== "string" || typeof repository["defaultBranch"] !== "string") return [];
    const full = typeof repository["url"] === "string" ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repository["url"])?.[1] : undefined;
    return [{ name: repository["name"], defaultBranch: repository["defaultBranch"], ...(full === undefined ? {} : { fullName: full }) }];
  }).slice(0, 32);
  // A mark that cannot be read, or does not read back as this company's own, refuses the whole read (the fixed unreadable answer), never a guess.
  const moves = await readRepositoryMoves(client, input.tableName, companyId, items.flatMap((item) => (item.fullName === undefined || !repositoryFullName.safeParse(item.fullName).success ? [] : [item.fullName]))).catch(() => { throw unreadable(); });
  const marked = items.map((item) => { const access = item.fullName === undefined ? undefined : moves.get(item.fullName.toLowerCase()); return access === undefined ? item : { ...item, access }; });
  return { state: marked.length > 0 ? "done" : "needs_you", count: marked.length, items: marked };
}

const commandCount = (items: SetupProposal["setup"] | undefined): number => (items ?? []).reduce((sum, item) => sum + item.value.commands.length, 0);

/** The last journal entry that failed (non-zero exit, a timeout), as stored. Entries that do not parse are skipped. */
async function journalOf(client: Client, tableName: string, companyId: OrgId, project: string, taskId: string): Promise<SetupJournalEntry[]> {
  const pk = setupPartition(companyId, project);
  const probe = journalKey({ orgId: companyId, project, taskId }, 1).sk.replace(/#\d+$/u, "#");
  const entries: SetupJournalEntry[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < JOURNAL_PAGES; page += 1) {
    const response = await client.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": probe }, ConsistentRead: true, Limit: JOURNAL_PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const raw of response.Items ?? []) {
      const row = asRecord(raw);
      if (row === undefined || row["orgId"] !== companyId || row["project"] !== project || row["taskId"] !== taskId) continue;
      const entry = SetupJournalEntrySchema.safeParse(row["entry"]);
      if (entry.success) entries.push(entry.data);
    }
    start = response.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return entries.sort((left, right) => left.n - right.n);
}

function failedCommandOf(entries: readonly SetupJournalEntry[]): NonNullable<ProjectSetupChecklist["setupRun"]["failedCommand"]> | undefined {
  const failed = [...entries].reverse().find((entry) => entry.timedOut || (entry.exitCode !== null && entry.exitCode !== 0));
  if (failed === undefined) return undefined;
  const tail = redactAndCap(failed.tail, TAIL_REDACT_CHARS).text.split("\n").filter((line) => line.trim() !== "").slice(-TAIL_LINES).map((line) => line.slice(0, TAIL_LINE_CHARS));
  return { n: failed.n, command: redactAndCap(failed.command, 2_000).text, exitCode: failed.exitCode, timedOut: failed.timedOut, lastLines: tail };
}

/** `passed` only when a proposed test command is an entry of the run's own journal and every such entry exited 0; `failed` when one such entry did not; else `unknown`. Never a guess. */
function testOutcomeOf(proposal: SetupProposal | undefined, entries: readonly SetupJournalEntry[]): "passed" | "failed" | "unknown" {
  const tests = new Set((proposal?.tests ?? []).flatMap((item) => item.value.commands));
  const ran = entries.filter((entry) => tests.has(entry.command));
  if (ran.length === 0) return "unknown";
  return ran.some((entry) => entry.timedOut || entry.exitCode !== 0) ? (ran.some((entry) => !entry.timedOut && entry.exitCode === 0) ? "unknown" : "failed") : "passed";
}

async function setupRunRow(input: SetupStatusInput, client: Client, companyId: OrgId): Promise<ProjectSetupChecklist["setupRun"]> {
  const store = readOnlyStore(client, input.tableName);
  const view = (await readState({ store, companyId, now: input.now }, input.project, input.definition.revision)).view;
  if (view.status === "none") return { state: "needs_you", status: "none" };
  const base = { status: view.status, ...(view.startedAt === undefined ? {} : { startedAt: view.startedAt }) };
  if (view.status === "running") return { state: "running", ...base };
  const summary = view.summary;
  // The stored proposal is read through its schema again; one that does not parse is counted as no proposal, never guessed at.
  const proposal = view.proposal === undefined ? undefined : SetupProposalSchema.safeParse(view.proposal).data;
  const facts = {
    ...(summary === undefined ? {} : { elapsedMs: summary.elapsedMs, costCents: summary.spendCents, commandsRun: summary.commandsRun, partial: summary.partial, stop: summary.stop }),
    ...(proposal === undefined ? {} : { commandsFound: { setup: commandCount(proposal.setup), tests: commandCount(proposal.tests) } }),
  };
  const entries = view.taskId === undefined ? [] : await journalOf(client, input.tableName, companyId, input.project, view.taskId);
  const testOutcome = testOutcomeOf(proposal, entries);
  // A run that ended with a proposal is done; one that stopped at a limit kept only a partial one: shown as failed, with the fixed sentence for the limit it hit.
  if (view.status === "ready" && summary?.partial !== true) return { state: "done", ...base, ...facts, testOutcome };
  const stop = view.stop;
  const failure = view.status === "failed" ? view.failure : stop === undefined ? undefined : (SETUP_AGENT_FAILURES as Record<string, string>)[stop];
  const failedCommand = failedCommandOf(entries);
  return { state: "failed", ...base, ...facts, testOutcome, ...(failure === undefined ? {} : { failure }), ...(failedCommand === undefined ? {} : { failedCommand }) };
}

/**
 * Whether the latest setup run left NO eval report at all. `readEvalDiscovery` answers "nothing" for a report that is absent AND for one that does not read back (or a store that did not answer), and only
 * the first is "found none": a report row that is there but unreadable keeps the row waiting for a person, and a read that fails fails the whole status read (the fixed unreadable error).
 */
async function noEvalRowOfLatestRun(input: SetupStatusInput, client: Client, companyId: OrgId): Promise<boolean> {
  const taskId = (await readOnlyStore(client, input.tableName).get(setupAgentKey(companyId, input.project)))?.["taskId"];
  if (typeof taskId !== "string" || taskId === "") return false;
  return (await client.send(new GetCommand({ TableName: input.tableName, Key: evalDiscoveryKey(companyId, input.project, taskId), ConsistentRead: true })) as { Item?: unknown }).Item === undefined;
}

async function evalConfirmRow(input: SetupStatusInput, client: Client, companyId: OrgId, setupDone: boolean): Promise<ProjectSetupChecklist["evalConfirm"]> {
  const discovery = await readEvalDiscovery({ store: readOnlyStore(client, input.tableName), companyId }, input.project);
  const blocked = setupDone ? {} : { blockedBy: "setupRun" as const };
  const suites = discovery === undefined ? undefined : discovery.report.suites.map((suite) => ({ selection: suite.selection, questions: suite.questions.length }));
  if (discovery?.state === "confirmed") return { state: "done", report: "confirmed", suites: suites!, ...(discovery.confirmedSelection === undefined ? {} : { confirmedSelection: discovery.confirmedSelection }) };
  // L2-5 c: a person's "no evals" counts only for the run it was given for, and only while that run is the project's latest finished one.
  const none = await readEvalNone(client, input.tableName, companyId, input.project);
  if (none !== undefined && setupDone) {
    const run = await finishedSetupRun(client, input.tableName, companyId, input.project, input.definition.revision, input.now);
    if (run !== undefined && run === none.taskId) return { state: "done", report: "no_evals", ...(suites === undefined ? {} : { suites }), noEvals: { confirmedAt: none.confirmedAt } };
  }
  // L4-T5 (owner D9): a finished setup run that found no evals leaves nothing for anyone to confirm, so the row is Done by itself. It is required only when evals were found.
  if (discovery === undefined) return setupDone && (await noEvalRowOfLatestRun(input, client, companyId)) ? { state: "done", report: "none" } : { state: "needs_you", report: "none", ...blocked };
  return { state: "needs_you", report: "reported", suites: suites!, ...blocked };
}

async function aiAndSpendRow(input: SetupStatusInput, client: Client, companyId: OrgId): Promise<ProjectSetupChecklist["aiAndSpend"]> {
  const row = asRecord((await client.send(new GetCommand({ TableName: input.tableName, Key: projectSettingsKey(companyId, input.project), ConsistentRead: true })) as { Item?: unknown }).Item);
  let budget: number | null = null;
  if (row !== undefined) {
    const overrides = asRecord(row["overrides"]);
    if (row["companyId"] !== companyId || row["projectName"] !== input.project || overrides === undefined) throw unreadable();
    const value = overrides["model_budget_usd"];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) budget = value;
  }
  let companyModelSaved: boolean;
  try { companyModelSaved = (await readModelSelectionPolicy(readOnlyStore(client, input.tableName), companyId)).revision > 0; }
  catch (error) { if (error instanceof PolicyUnreadable) throw unreadable(); throw error; }
  // The seam for PR #835's company engine model: its reader joins `companyModelSaved` here.
  return { state: "done", source: budget !== null ? "project" : companyModelSaved ? "company" : "default", companyModelSaved, modelBudgetUsd: budget };
}

/** Whether the project has a task that is not a setup run. Looks at the newest workspaces of this company's own index partition (and the install's legacy one, for the implicit company only). */
async function hasRealTask(input: SetupStatusInput, client: Client, companyId: OrgId): Promise<boolean> {
  const partitions = [{ value: workspaceProjectIndexValue(companyId, input.project), legacy: false }, ...(companyId === IMPLICIT_COMPANY_ID ? [{ value: input.project, legacy: true }] : [])];
  for (const partition of partitions) {
    const page = await client.send(new QueryCommand({
      TableName: input.tableName, IndexName: WORKSPACE_PROJECT_INDEX.name, KeyConditionExpression: "#project = :project", ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": partition.value }, ScanIndexForward: false, Limit: TASK_PROBE_WORKSPACES,
    })) as { Items?: unknown[] };
    for (const raw of page.Items ?? []) {
      const workspace = asRecord(raw);
      const id = workspace?.["id"];
      if (workspace === undefined || typeof id !== "string" || workspace["entityType"] === "WORKSPACE_COMPANY_POINTER" || !recordInCompany(workspace, companyId)) continue;
      if (typeof workspace["orgId"] === "string" && workspace["orgId"] !== companyId) continue;
      const pointer = asRecord((await client.send(new GetCommand({ TableName: input.tableName, Key: partition.legacy ? legacyTaskPointerKey(id) : taskPointerKey(companyId, id), ConsistentRead: true })) as { Item?: unknown }).Item);
      const taskId = pointer?.["taskId"];
      if (typeof taskId !== "string") continue;
      const task = asRecord((await client.send(new GetCommand({ TableName: input.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: unknown }).Item);
      if (task !== undefined && recordInCompany(task, companyId) && (typeof task["orgId"] !== "string" || task["orgId"] === companyId) && task["project"] === input.project && task["purpose"] !== "setup_agent" && task["purpose"] !== "wiki_build") return true;
    }
  }
  return false;
}

// ---- the whole status

const REQUIRED: readonly SetupStatusRow[] = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "firstTask"];

/** The optional row's state: set up wins, then a skip, else optional. */
const optionalState = (configured: boolean, skipped: boolean): SetupRowState => (configured ? "done" : skipped ? "skipped" : "optional");

/** One project's checklist, read now. Throws the fixed unreadable error when any stored row it needs does not read back. */
export async function readProjectSetupStatus(input: SetupStatusInput): Promise<ProjectSetupChecklist> {
  const companyId = OrgIdSchema.parse(input.companyId);
  const client = input.documentClient;
  try {
    const skips = await readSkips(client, input.tableName, companyId, input.project);
    const [channels, linearTeam, aiAndSpend, hasTask] = await Promise.all([
      input.readers.channels(), input.readers.linearTeam?.(), aiAndSpendRow(input, client, companyId), hasRealTask(input, client, companyId),
    ]);
    const repos = await reposRow(input, client, companyId);
    const setupRun = await setupRunRow(input, client, companyId);
    const evalConfirm = await evalConfirmRow(input, client, companyId, setupRun.state === "done");
    const skipped = (row: SetupSkippableRow) => skips.skipped.includes(row);
    const canStart = setupRun.state === "done" && evalConfirm.state === "done" && aiAndSpend.state === "done";
    const rows: Record<SetupStatusRow, { state: SetupRowState }> = {
      repos, setupRun, evalConfirm, aiAndSpend,
      slackChannel: { state: optionalState(channels.length > 0, skipped("slackChannel")) },
      linear: { state: optionalState(linearTeam !== undefined, skipped("linear")) },
      invites: { state: optionalState(false, skipped("invites")) },
      firstTask: { state: hasTask ? "done" : "needs_you" },
    };
    const total = SETUP_STATUS_ROWS.length;
    const done = SETUP_STATUS_ROWS.filter((row) => rows[row].state === "done" || rows[row].state === "skipped").length;
    const nextRequired = REQUIRED.find((row) => rows[row].state !== "done") ?? null;
    return {
      project: input.project,
      viewer: { companyRole: input.viewer.companyRole, projectAdmin: input.viewer.projectAdmin, canSkip: input.viewer.companyRole === "owner" || input.viewer.companyRole === "admin" || input.viewer.projectAdmin },
      progress: { done, total, percent: Math.round((100 * done) / total), nextRequired },
      repos, setupRun, evalConfirm, aiAndSpend,
      slackChannel: { state: rows.slackChannel.state, channels: channels.slice(0, 32) },
      linear: { state: rows.linear.state, team: linearTeam === undefined ? null : { id: linearTeam.id, ...(linearTeam.name === undefined ? {} : { name: linearTeam.name }) } },
      invites: { state: rows.invites.state },
      firstTask: { state: rows.firstTask.state, hasTask, canStart },
    };
  } catch (error) {
    // A fixed refusal stays as it is; a store fault or a record that does not read is one fixed unreadable answer (no cause echoed).
    if ((error as { code?: unknown }).code === "CONFIG_INVALID" || (error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE") throw error;
    throw unreadable();
  }
}
