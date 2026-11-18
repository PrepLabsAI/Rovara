// DEC 253n(1): the setup run's eval discovery and the person's confirm of a selection from it. The broker then builds the EVAL_PLAN itself and proposes the eval spend item with it.
//
// REPORT (the worker's word, through the run's EXISTING setup callback, body kind `eval_discovery`; `callback.ts`). The callback already names the run: a running setup run of THIS company, its
// project and task from the authenticated operation, never from the body. The report is schema-checked (`SetupEvalDiscoveryReportSchema`: bounded, strict, the command fingerprint must be the
// broker's own of the command). It is kept as ONE row per run (`EVAL_DISCOVERY#<task>` in the project's company-scoped setup partition), written only if absent: the same report again is
// answered "same", any other report for that run is refused (a report is never edited). With it the broker keeps the commits IT recorded for the run (`preparedBase`), never the worker's.
//
// CONFIRM (`POST /v1/app/projects/{p}/setup-agent/eval-confirm`; `confirmEvalDiscovery`). Only a company owner or admin, or a maintainer of this project, read LIVE from the members seam (the
// hosted reader on a deployed install), in the caller's own company; the row is read at the caller's company's own key (T1), and its company, project, task and digest are recomputed. Refused:
// another company's row (it is never at this company's key, and a copied one names its company), a run that is not the project's latest setup run, a report the person did not see (digest),
// a suite or a file that is not in the report, a report already confirmed (no edit after confirmation), a file that is not at the recorded commit or is not plain text.
//
// PLAN (the broker's own): every selected question file is read by the BROKER from the code host at the recorded commit and hashed (`evalQuestionHash`); the eval-set hash
// (`evalSetHashOf` over those files), the command fingerprint (`evalCommandFingerprintOf`), the settings fingerprint (`evalSettingsFingerprintOf`) and the estimate (three runs x questions x the
// per-question caps) are computed here. No hash or digest the run sent is used. The plan goes to `proposeEvalSpendApproval`, which binds it to the new spend item; spend still needs that
// item's own approval and the install's reservation adapter.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS, EVAL_DISCOVERY_REPORT_MAX_BYTES, EVAL_OUTPUT_UNREADABLE_MESSAGE, EVAL_QUESTION_FILE_MAX_BYTES, EVAL_QUESTION_FILES_TOTAL_MAX_BYTES, EvalDiscoveryConfirmBodySchema, SetupEvalDiscoveryReportSchema,
  EVAL_WRAPPER_REPORT_PATH, agentXError, canonicalJson, change, evalCommandFingerprintOf, evalOutputNeedsWrapper, evalWrapperCommandOf, evalWrapperFor, evalJudgePinOf, evalPlanDigest, evalQuestionHash, evalSetHashOf, evalSettingsFingerprintOf, when,
  type DocumentStore, type EvalPlanBody, type OrgId, type Principal, type SetupEvalDiscoveryReport, type StoredDocument,
} from "@agentx/contracts";
import type { SetupEvalDiscoveryView } from "../local-pages/views.js";
import { listEvalWrapperFiles, needsOf, recordEvalWrapperTest, wrapperFileFor } from "./eval-wrapper.js";
import type { SessionMembers } from "../sessions/access.js";
import { developerIdOf } from "../sessions/create.js";
import { taskKey } from "../task-flow/keys.js";
import type { SetupDefinition } from "./agent.js";
import { evalDollarsOf } from "./eval-cost.js";
import { proposeEvalSpendApproval, readEvalSpendItem, roleFor } from "./eval-spend.js";
import { setupAgentKey, setupPartition, type RunScope } from "./keys.js";

export const EVAL_DISCOVERY_ENTITY = "EVAL_DISCOVERY";
/** The run's report row: one per run, in the project's company-scoped setup partition. */
export const evalDiscoveryKey = (company: string, project: string, taskId: string) => ({ pk: setupPartition(company, project), sk: `EVAL_DISCOVERY#${taskId}` });

/** How long the confirm's reads of the selected files may take together, and at most how many run at once. */
export const EVAL_CONFIRM_READS_DEADLINE_MS = 30_000;
const READS_AT_ONCE = 4;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

const CommitsSchema = z.array(z.object({ repository: z.string().min(1).max(200), commit: z.string().regex(SHA) }).strict()).min(1).max(50);
const RecordSchema = z.object({
  entityType: z.literal(EVAL_DISCOVERY_ENTITY), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), taskId: z.string().min(1).max(160),
  commits: CommitsSchema,
  reportDigest: hash,
  report: z.unknown(),
  state: z.enum(["reported", "confirmed"]),
  reportedAt: z.iso.datetime(),
  confirmed: z.object({ personId: z.string().min(1).max(256), provider: z.string().min(1).max(200), role: z.enum(["owner", "admin", "maintainer"]), at: z.iso.datetime(), selection: z.string().min(1).max(512), planDigest: hash }).strict().optional(),
}).strict();
type DiscoveryRecord = Omit<z.infer<typeof RecordSchema>, "report"> & { report: SetupEvalDiscoveryReport };

/** The report's digest: bound to its company, project, run and the commits the broker recorded. */
export function evalDiscoveryDigest(input: { company: string; project: string; taskId: string; commits: z.infer<typeof CommitsSchema>; report: SetupEvalDiscoveryReport }): string {
  return createHash("sha256").update(`rovara-eval-discovery/v1\n${canonicalJson({ company: input.company, project: input.project, taskId: input.taskId, commits: input.commits, report: input.report })}`, "utf8").digest("hex");
}

export type EvalDiscoveryLogEvent = "eval_discovery_recorded" | "eval_discovery_refused" | "eval_discovery_confirmed" | "eval_discovery_confirm_refused" | "eval_discovery_invalid";
type Log = ((entry: { event: EvalDiscoveryLogEvent; reason?: string }) => void) | undefined;

/** A fixed refusal: the error, and one fixed-word log line (never the input). */
function refuse(log: Log, event: "eval_discovery_refused" | "eval_discovery_confirm_refused", reason: string, code: Parameters<typeof agentXError>[0], message: string): never {
  log?.({ event, reason });
  throw agentXError(code, message);
}

/** The row, only when it is this company's, project's and run's, unedited (its digest recomputed) and its report still schema-valid. */
function parseRecord(company: string, project: string, taskId: string, raw: StoredDocument | undefined, log: Log): DiscoveryRecord | undefined {
  if (raw === undefined) return undefined;
  const { pk, sk, ...value } = raw;
  void pk; void sk;
  const parsed = RecordSchema.safeParse(value);
  const report = parsed.success ? SetupEvalDiscoveryReportSchema.safeParse(parsed.data.report) : undefined;
  if (parsed.success && report?.success === true) {
    const row = { ...parsed.data, report: report.data };
    if (row.company === company && row.project === project && row.taskId === taskId && row.reportDigest === evalDiscoveryDigest(row)) return row;
  }
  log?.({ event: "eval_discovery_invalid" });
  return undefined;
}

export interface EvalDiscoveryRecordDeps { store: DocumentStore; now: () => number; log?: Log }

/**
 * The callback's `eval_discovery`: keeps the run's report once. `run` is the callback's own (`setupRunOfOperation`: a running setup run of this company). Answers `new` or `same`; refuses an
 * unreadable report, a run with no recorded commit, a suite whose repository the run did not read, and a second, different report for the run.
 */
export async function recordEvalDiscovery(deps: EvalDiscoveryRecordDeps, run: RunScope, rawReport: unknown): Promise<{ recorded: "new" | "same" }> {
  const parsed = SetupEvalDiscoveryReportSchema.safeParse(rawReport);
  if (!parsed.success) refuse(deps.log, "eval_discovery_refused", "unreadable", "CONFIG_INVALID", "the eval discovery report is not readable");
  const report = parsed.data;
  if (Buffer.byteLength(canonicalJson(report), "utf8") > EVAL_DISCOVERY_REPORT_MAX_BYTES) refuse(deps.log, "eval_discovery_refused", "unreadable", "CONFIG_INVALID", "the eval discovery report is not readable");
  // The commits the BROKER recorded for this run, never the worker's.
  const task = await deps.store.get(taskKey(run.taskId));
  const base = Array.isArray(task?.["preparedBase"]) ? task["preparedBase"] as unknown[] : [];
  const commits = CommitsSchema.safeParse(base.map((entry) => ({ repository: (entry as { repositoryId?: unknown }).repositoryId, commit: (entry as { baseCommitSha?: unknown }).baseCommitSha })));
  if (task === undefined || task["companyId"] !== run.orgId || task["project"] !== run.project || !commits.success) refuse(deps.log, "eval_discovery_refused", "no_commit", "CONFIG_INVALID", "the setup run has no recorded commit");
  for (const suite of report.suites) {
    if (commitFor(commits.data, suite.repository) === undefined) refuse(deps.log, "eval_discovery_refused", "repository", "CONFIG_INVALID", "the eval is in a repository this setup run did not read");
  }
  const row = { entityType: EVAL_DISCOVERY_ENTITY, schemaVersion: 1 as const, company: run.orgId, project: run.project, taskId: run.taskId, commits: commits.data, report, state: "reported" as const,
    reportedAt: new Date(deps.now()).toISOString(), reportDigest: evalDiscoveryDigest({ company: run.orgId, project: run.project, taskId: run.taskId, commits: commits.data, report }) };
  const key = evalDiscoveryKey(run.orgId, run.project, run.taskId);
  const written = await deps.store.put({ item: { ...key, ...row } as unknown as StoredDocument, condition: when.absent() });
  if (written.applied) { deps.log?.({ event: "eval_discovery_recorded" }); return { recorded: "new" }; }
  const before = parseRecord(run.orgId, run.project, run.taskId, await deps.store.get(key), deps.log);
  if (before !== undefined && before.reportDigest === row.reportDigest) return { recorded: "same" };
  return refuse(deps.log, "eval_discovery_refused", "edited", "CHANGE_STALE", "this setup run already reported its eval discovery");
}

/** The recorded commit of a suite's repository: the named one, else the run's only one. */
function commitFor(commits: ReadonlyArray<{ repository: string; commit: string }>, repository: string | undefined): { repository: string; commit: string } | undefined {
  return repository === undefined ? (commits.length === 1 ? commits[0] : undefined) : commits.find((entry) => entry.repository === repository);
}

export interface EvalDiscoveryConfirmDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The install's members: the confirmer's role is read here, live. Absent: the local owner only. */
  members?: SessionMembers | undefined;
  /**
   * DEC 253q(c): the cap's source on a host that reads it: the bound `eval-reservation` adapter's `monthlyCapMicros` (Cloud's company budget, min of the company's and the project's monthly caps).
   * The ONLY source of the cap. Absent (a laptop), no answer or a fault: the confirm is refused with a fixed reason before anything is read or marked.
   */
  monthlyCap?: ((scope: { company: string; project: string }) => Promise<number | undefined>) | undefined;
  /** The project's latest revision's repositories (for the code host read). */
  latest(project: string): Promise<{ definition: SetupDefinition; revision?: number } | undefined>;
  /**
   * L4-EVC (DEC 254zzz20 D8): how the host approves the waiting spend item in the SAME act as the confirm (one approval). It is the host's own decision path (the approval gate with the person's fresh
   * proof), never a bypass: the broker calls it only for a body that names `approve`, after the person's live role was read and the dollars they were shown matched, and with exactly the item it just
   * proposed. It throws for a refusal. Absent: a body that asks to approve is refused before anything is read or marked.
   */
  approve?: ((offer: { requestId: string; revision: number; artifactDigest: string }, principal: Principal) => Promise<void>) | undefined;
  /** The code host's read of a whole file at a commit (undefined: not there; throws: the host cannot answer). */
  readFile?: ((repository: SetupDefinition["repositories"][number], path: string, commit: string, options: { timeoutMs: number; maxBytes: number }) => Promise<string | undefined>) | undefined;
  log?: Log;
}

/**
 * F3d's whole estimate for `count` questions of a suite: three runs of every question at its caps. The maximum is at least the default and never below the estimate. Shared by the confirm and by
 * the card shown before it, so the dollars a person reads are the dollars the broker proposes.
 */
export function evalEstimateOf(count: number, suite: Pick<SetupEvalDiscoveryReport["suites"][number], "maxCallsPerQuestion" | "maxCostMicrosPerQuestion">) {
  const estimate = { calls: 3 * count * suite.maxCallsPerQuestion, costMicros: 3 * count * suite.maxCostMicrosPerQuestion };
  const budget = { usual: estimate, maximum: { calls: Math.max(estimate.calls, EVAL_DEFAULT_CALL_BUDGET), costMicros: Math.max(estimate.costMicros, EVAL_DEFAULT_COST_BUDGET_MICROS) } };
  return { estimate, budget };
}
/** The dollars of a proposal for `count` questions of a suite under the host's monthly cap (undefined: not whole numbers). */
export function evalProposalDollars(count: number, suite: Pick<SetupEvalDiscoveryReport["suites"][number], "maxCallsPerQuestion" | "maxCostMicrosPerQuestion">, monthlyCapMicros: number) {
  return evalDollarsOf({ questions: count, costMicrosPerQuestion: suite.maxCostMicrosPerQuestion, maximumMicros: evalEstimateOf(count, suite).budget.maximum.costMicros, monthlyCapMicros });
}

/** The fixed refusal when the install has no eval budget to hold the spend item to. */
export const EVAL_NO_CAP_MESSAGE = "This install has no eval budget, so an eval can't be confirmed here. Evals run within a company's monthly spending cap, and this install has no eval spending cap source.";

/** The monthly cap: the host's source's answer for this company and project. A fault, a non-whole or negative number, or no source is undefined. */
async function capOf(deps: EvalDiscoveryConfirmDeps, company: string, project: string): Promise<number | undefined> {
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (deps.monthlyCap === undefined) return undefined;
  try { const cap = await deps.monthlyCap({ company, project }); return whole(cap) ? cap : undefined; } catch { return undefined; }
}

/** Reads every selected file at `commit`, a few at a time, inside one deadline and one byte total. Undefined for a file that is not there; throws a fixed refusal for anything else. */
async function readSelected(deps: EvalDiscoveryConfirmDeps, repository: SetupDefinition["repositories"][number], commit: string, paths: readonly string[]): Promise<Map<string, Uint8Array>> {
  const read = deps.readFile;
  if (read === undefined) refuse(deps.log, "eval_discovery_confirm_refused", "no_reader", "RUNTIME_UNAVAILABLE", "Rovara cannot read the repository to check the eval files. Try again.");
  const deadline = deps.now() + EVAL_CONFIRM_READS_DEADLINE_MS;
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let next = 0;
  let fault: "missing" | "binary" | "large" | "host" | undefined;
  const worker = async (): Promise<void> => {
    while (fault === undefined && next < paths.length) {
      const path = paths[next++]!;
      const left = deadline - deps.now();
      if (left <= 0) { fault = "host"; return; }
      let text: string | undefined;
      try { text = await read(repository, path, commit, { timeoutMs: left, maxBytes: EVAL_QUESTION_FILE_MAX_BYTES }); } catch { fault ??= "host"; return; }
      if (text === undefined) { fault ??= "missing"; return; }
      // The worker hashes the file's exact bytes. Text that did not decode cleanly cannot be hashed the same way here, so it is refused rather than guessed.
      if (typeof text !== "string" || text.includes("�")) { fault ??= "binary"; return; }
      const bytes = new TextEncoder().encode(text);
      total += bytes.byteLength;
      if (bytes.byteLength > EVAL_QUESTION_FILE_MAX_BYTES || total > EVAL_QUESTION_FILES_TOTAL_MAX_BYTES) { fault ??= "large"; return; }
      files.set(path, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, paths.length) }, worker));
  if (fault === "missing") refuse(deps.log, "eval_discovery_confirm_refused", "missing", "CONFIG_INVALID", "A selected eval file is not in the repository at the setup commit.");
  if (fault === "binary") refuse(deps.log, "eval_discovery_confirm_refused", "binary", "CONFIG_INVALID", "A selected eval file is not plain text.");
  if (fault === "large") refuse(deps.log, "eval_discovery_confirm_refused", "large", "CONFIG_INVALID", "The selected eval files are too large.");
  if (fault !== undefined || files.size !== paths.length) refuse(deps.log, "eval_discovery_confirm_refused", "host", "RUNTIME_UNAVAILABLE", "Rovara could not read the eval files. Try again.");
  return files;
}

/**
 * `POST /v1/app/projects/{project}/setup-agent/eval-confirm`: a maintainer or admin confirms a selection from the project's latest setup run's eval report. The broker builds the EVAL_PLAN from its
 * own reads and proposes the eval spend item with it. Answers the spend item as the setup page shows it (waiting for its own approval).
 */
export async function confirmEvalDiscovery(deps: EvalDiscoveryConfirmDeps, project: string, rawBody: unknown, principal: Principal): Promise<{ planDigest: string; evalSpend: Awaited<ReturnType<typeof readEvalSpendItem>> }> {
  const log = deps.log;
  const parsed = EvalDiscoveryConfirmBodySchema.safeParse(rawBody);
  if (!parsed.success) refuse(log, "eval_discovery_confirm_refused", "body", "CONFIG_INVALID", "That eval confirmation was not understood.");
  const body = parsed.data;
  const company = deps.companyId;
  // The caller's own company, and their LIVE role in it: a company owner or admin, or a maintainer of this project. A member, viewer, auditor or revoked person is refused.
  if (principal?.companyId !== company) refuse(log, "eval_discovery_confirm_refused", "company", "FORBIDDEN", "Only a company owner, admin or project maintainer confirms the eval.");
  const role = await roleFor(deps.members === undefined ? {} : { members: deps.members }, project, { companyId: company, developerId: developerIdOf(principal), principal });
  if (role === undefined) refuse(log, "eval_discovery_confirm_refused", "role", "FORBIDDEN", "Only a company owner, admin or project maintainer confirms the eval.");
  // DEC 253q(c): the monthly cap from the trusted host, read before anything else; none is a fixed refusal (a laptop has no eval budget).
  const monthlyCapMicros = await capOf(deps, company, project);
  if (monthlyCapMicros === undefined) refuse(log, "eval_discovery_confirm_refused", "no_cap", "CONFIG_INVALID", EVAL_NO_CAP_MESSAGE);
  // Only the project's latest setup run's report (T1: this company's own setup partition).
  const pointer = await deps.store.get(setupAgentKey(company, project));
  if (pointer?.["taskId"] !== body.taskId) refuse(log, "eval_discovery_confirm_refused", "not_latest", "CHANGE_STALE", "That is not the project's latest setup run.");
  const task = await deps.store.get(taskKey(body.taskId));
  if (task === undefined || task["purpose"] !== "setup_agent" || task["companyId"] !== company || task["project"] !== project) refuse(log, "eval_discovery_confirm_refused", "run", "NOT_FOUND", "There is no eval report for that setup run.");
  const key = evalDiscoveryKey(company, project, body.taskId);
  const row = parseRecord(company, project, body.taskId, await deps.store.get(key), log);
  if (row === undefined) refuse(log, "eval_discovery_confirm_refused", "no_report", "NOT_FOUND", "There is no eval report for that setup run.");
  if (row.reportDigest !== body.reportDigest) refuse(log, "eval_discovery_confirm_refused", "digest", "CHANGE_STALE", "The eval report changed. Read it again.");
  if (row.state !== "reported") refuse(log, "eval_discovery_confirm_refused", "confirmed", "CHANGE_STALE", "That eval report was already confirmed.");
  const suite = row.report.suites.find((entry) => entry.selection === body.selection);
  if (suite === undefined) refuse(log, "eval_discovery_confirm_refused", "selection", "CONFIG_INVALID", "That eval is not in the setup run's report.");
  // L4-EVW4 (DEC 254zzz43): an eval whose results Rovara cannot read as they are is not approved for spend until its wrapper file is on the project's DEFAULT branch (found by `detectEvalWrappers`, whoever put it there): it
  // would only ever read "Not run". From then on the eval runs THROUGH the file: the plan's command is the wrapper and its report is the wrapper's JUnit file, so the plan, its fingerprint and the dollars the person saw
  // are for exactly that run (the cost is the same eval spend approval, bound by `seen`).
  let wrapped: { language: "python" | "node" } | undefined;
  let run: Pick<typeof suite, "command" | "report"> = suite;
  if (evalOutputNeedsWrapper(suite.output)) {
    const wrapper = evalWrapperFor(suite);
    const firstOfFile = needsOf(row.report).find((entry) => entry.selection === suite.selection)?.firstOfFile === true;
    const file = wrapper === undefined ? undefined : wrapperFileFor(await listEvalWrapperFiles({ store: deps.store, companyId: company }, project), { ...(suite.repository === undefined ? {} : { repository: suite.repository }), selection: suite.selection, firstOfFile }, wrapper.language);
    if (wrapper === undefined || file === undefined) refuse(log, "eval_discovery_confirm_refused", "unreadable_output", "CONFIG_INVALID", EVAL_OUTPUT_UNREADABLE_MESSAGE);
    wrapped = { language: wrapper.language };
    run = { command: evalWrapperCommandOf(wrapper.language), report: { cwd: ".", argument: EVAL_WRAPPER_REPORT_PATH } };
  }
  const reported = new Set(suite.questions.map((question) => question.path));
  if (body.paths.some((path) => !reported.has(path))) refuse(log, "eval_discovery_confirm_refused", "path", "CONFIG_INVALID", "A selected file is not in the setup run's report.");
  const at = commitFor(row.commits, suite.repository);
  const latest = await deps.latest(project);
  const record = latest?.definition.repositories.find((entry) => entry.name === at?.repository);
  if (at === undefined || record === undefined) refuse(log, "eval_discovery_confirm_refused", "repository", "CONFIG_INVALID", "The eval's repository is not in the project.");

  // The broker's own reads and hashes: the selected question files and the judge's scoring file, at the recorded commit, in one bounded read.
  const read = await readSelected(deps, record, at.commit, [...body.paths, suite.judge.scoringPath]);
  const scoringBytes = read.get(suite.judge.scoringPath)!;
  const files = new Map([...read].filter(([path]) => path !== suite.judge.scoringPath));
  const hashes = new Map([...files].map(([path, bytes]) => [path, evalQuestionHash(bytes)]));
  // DEC 253q: the judge pin is the broker's own, over the scoring file it just read; the baseline is measured with the same judge.
  const judgeScoring = { path: suite.judge.scoringPath, hash: evalQuestionHash(scoringBytes) };
  const judgePin = evalJudgePinOf({ catalogRowId: suite.catalogRowId, judge: suite.judge, scoringHash: judgeScoring.hash });
  const selected = new Set(body.paths);
  const questions = suite.questions.filter((question) => selected.has(question.path)).map((question) => ({ id: question.id, category: question.category, path: question.path, hash: hashes.get(question.path)! }));
  const evalSetHash = evalSetHashOf([...files].map(([path, bytes]) => ({ path, bytes })));
  const commandFingerprint = evalCommandFingerprintOf(run.command, run.report);
  const settings = { imageDigest: suite.image, route: suite.route };
  const inputs = { evalSetHash, judgePin, modelVersion: suite.modelVersion, model: suite.model, catalogRowId: suite.catalogRowId, commandFingerprint, settingsFingerprint: evalSettingsFingerprintOf(settings, judgePin) };
  const plan: EvalPlanBody = {
    selection: suite.selection, ...(suite.repository === undefined ? {} : { repository: suite.repository }), inputs,
    key: { commandFingerprint, catalogRowId: suite.catalogRowId, model: suite.model, modelVersion: suite.modelVersion },
    // A model judge goes through the eval's one product row, so it is the product model's family: the existing notice says so (DEC 253q(b)).
    settings, evalSetHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, ...(suite.judge.kind === "model" ? { sameJudgeFamily: true } : {}),
    subsetSupported: suite.subsetSupported, questions, maxCallsPerQuestion: suite.maxCallsPerQuestion, maxCostMicrosPerQuestion: suite.maxCostMicrosPerQuestion,
    command: run.command, report: run.report, judgeScoring,
  };
  const planDigest = evalPlanDigest(company, project, plan);
  // F3d's whole estimate: three runs of every question at its caps. The maximum is at least the default and never below the estimate.
  const { estimate, budget } = evalEstimateOf(questions.length, suite);
  // L4-EVC: the dollars the card says, from these same numbers and the host's monthly cap (never the request's). A body that approves must have been shown exactly them.
  const dollars = evalProposalDollars(questions.length, suite, monthlyCapMicros);
  if (dollars === undefined) refuse(log, "eval_discovery_confirm_refused", "dollars", "CONFIG_INVALID", "The eval's cost could not be worked out, so it can't be approved here.");
  if (body.approve === true) {
    if (deps.approve === undefined) refuse(log, "eval_discovery_confirm_refused", "no_approve", "CONFIG_INVALID", "Approving the eval's spend isn't available here. Confirm it, then approve its spend.");
    if (body.seen?.perCheckHighMicros !== dollars.perCheckHighMicros || body.seen.monthlyCapMicros !== dollars.monthlyCapMicros) refuse(log, "eval_discovery_confirm_refused", "seen", "CHANGE_STALE", "The eval's cost changed since you looked. Read it again.");
  }

  // Confirmed first, once (the row's own state and digest guard it), so two confirms cannot both propose; a proposal that fails puts the row back.
  const confirmed = { personId: principal.personId, provider: principal.provider, role, at: new Date(deps.now()).toISOString(), selection: suite.selection, planDigest };
  const marked = await deps.store.transact([
    { kind: "update", key, ops: [change.set("state", "confirmed"), change.set("confirmed", confirmed)], condition: when.and(when.eq("state", "reported"), when.eq("reportDigest", row.reportDigest)) },
    // The run must still be the project's latest setup run when the mark is made (a run started meanwhile makes this report stale).
    { kind: "check", key: setupAgentKey(company, project), condition: when.eq("taskId", body.taskId) },
  ]);
  if (!marked.applied) refuse(log, "eval_discovery_confirm_refused", "stale", "CHANGE_STALE", "That eval report was already confirmed, or a newer setup run replaced it. Read it again.");
  const table = { store: deps.store, companyId: company, ...(deps.members === undefined ? {} : { members: deps.members }), monthlyCapMicros };
  let proposed: Awaited<ReturnType<typeof proposeEvalSpendApproval>>;
  try {
    proposed = await proposeEvalSpendApproval(table, project, { selection: suite.selection, inputs, estimate, budget, dollars }, plan, latest?.revision === undefined ? undefined : { setupRevision: latest.revision });
  } catch (error) {
    await deps.store.update({ key, ops: [change.set("state", "reported"), change.remove("confirmed")], condition: when.and(when.eq("state", "confirmed"), when.eq("reportDigest", row.reportDigest)) }).catch(() => undefined);
    log?.({ event: "eval_discovery_confirm_refused", reason: "proposal" });
    throw error;
  }
  log?.({ event: "eval_discovery_confirmed" });
  let item = await readEvalSpendItem(table, project);
  // One approval: the item this confirm just proposed, approved in the same act through the host's own decision path. A changed eval inside its approved limit is already approved (D6): nothing to ask.
  // The offer is the item THIS confirm proposed (its own revision and digest), never whatever is stored a moment later: a newer item of someone else's is never approved by this person's proof.
  if (body.approve === true && proposed.state === "waiting") {
    try { await deps.approve!({ requestId: `eval-${proposed.digest.slice(0, 40)}-${String(proposed.revision)}`, revision: proposed.revision, artifactDigest: proposed.digest }, principal); } catch (error) {
      // Nothing is approved or spent. The report goes back to `reported` (as a failed proposal does), so the person can confirm and approve again; the waiting item is the same one then.
      await deps.store.update({ key, ops: [change.set("state", "reported"), change.remove("confirmed")], condition: when.and(when.eq("state", "confirmed"), when.eq("reportDigest", row.reportDigest)) }).catch(() => undefined);
      log?.({ event: "eval_discovery_confirm_refused", reason: "approve" });
      throw error;
    }
    item = await readEvalSpendItem(table, project);
  }
  // The test run of a wrapped eval is approved with its cost: the spend approval the person just gave (or the carried one) is that approval. The file's record keeps it until the run's results are read.
  if (wrapped !== undefined && item?.state === "approved") await recordEvalWrapperTest({ store: deps.store, companyId: company, now: deps.now }, project, { ...(suite.repository === undefined ? {} : { repository: suite.repository }), selection: suite.selection, language: wrapped.language }, "approved").catch(() => false);
  return { planDigest, evalSpend: item };
}

/** What the setup page shows of the latest run's report: the suites as reported (no hashes: none are the run's), its digest to confirm against, and whether it was confirmed. */
export async function readEvalDiscovery(deps: { store: DocumentStore; companyId: OrgId; log?: Log }, project: string): Promise<{ taskId: string; reportDigest: string; state: "reported" | "confirmed"; report: SetupEvalDiscoveryReport; confirmedSelection?: string } | undefined> {
  try {
    const pointer = await deps.store.get(setupAgentKey(deps.companyId, project));
    const taskId = pointer?.["taskId"];
    if (typeof taskId !== "string") return undefined;
    const row = parseRecord(deps.companyId, project, taskId, await deps.store.get(evalDiscoveryKey(deps.companyId, project, taskId)), deps.log);
    if (row === undefined) return undefined;
    return { taskId, reportDigest: row.reportDigest, state: row.state, report: row.report, ...(row.confirmed === undefined ? {} : { confirmedSelection: row.confirmed.selection }) };
  } catch { return undefined; }
}

/** The question categories, in the order the setup page counts them. */
const CATEGORY_ORDER = ["ordinary", "safety", "refusal"] as const;

/**
 * DEC 253q: what the setup page shows of the latest run's eval definition (`readEvalDiscovery`) and its spend item (`readEvalSpendItem`'s state). Pure. The suites' texts came from the repository or
 * the model; the page renders them as such. Undefined: no eval was discovered.
 */
export function setupEvalDiscoveryView(
  discovery: Awaited<ReturnType<typeof readEvalDiscovery>>,
  spendState: "waiting" | "approved" | "rejected" | "approval needs renewing" | undefined,
  cannotConfirm: string | undefined,
): SetupEvalDiscoveryView | undefined {
  if (discovery === undefined) return undefined;
  const state = discovery.state === "reported" ? "waiting" as const : spendState === "waiting" || spendState === "approved" ? "confirmed" as const : "reapprove" as const;
  const suites = discovery.report.suites.map((suite) => {
    const counts = CATEGORY_ORDER.map((category) => [category, suite.questions.filter((q) => q.category === category).length] as const).filter(([, n]) => n > 0);
    return {
      selection: suite.selection, ...(suite.repository === undefined ? {} : { repository: suite.repository }),
      files: [...new Set(suite.questions.map((q) => q.path))], questions: suite.questions.length,
      categories: counts.map(([category, n]) => `${n} ${category}`).join(", "),
      // The WHOLE command, each argument on its own and quoted (JSON), never cut: what is confirmed is exactly what is shown (the schema bounds it at 16 KiB).
      command: JSON.stringify([suite.command.executable, ...suite.command.args]), commandCwd: suite.command.cwd,
      report: suite.report.cwd === "." ? suite.report.argument : `${suite.report.cwd}/${suite.report.argument}`,
      model: `${suite.model} (${suite.modelVersion}) through ${suite.catalogRowId}`,
      judge: suite.judge.kind === "rule" ? `a rule, scored by ${suite.judge.scoringPath}` : `${suite.judge.model} (${suite.judge.version}), scored by ${suite.judge.scoringPath}; the same model family as the product`,
      caps: `at most ${suite.maxCallsPerQuestion} calls and $${(suite.maxCostMicrosPerQuestion / 1_000_000).toFixed(2)} a question`,
    };
  });
  return {
    state, taskId: discovery.taskId, reportDigest: discovery.reportDigest, ...(discovery.confirmedSelection === undefined ? {} : { confirmedSelection: discovery.confirmedSelection }),
    ...(cannotConfirm === undefined ? {} : { cannotConfirm }), suites,
  };
}
