// L4-EVW4 (DEC 254zzz43, replacing DEC 254zzz20 D2's automatic proposal): when the customer's eval writes something Rovara cannot read as it is, the setup card says so, shows the small wrapper file (path and text), and
// lets a PERSON choose: add it themselves, have Rovara open a pull request for it, or "Not now". Rovara never writes to the repository on its own: outside a task, the only write is ONE new file, on a new branch, as a pull
// request, after a person with the right role clicked, and the audit names that person.
//
// THIS WRITES TO A CUSTOMER'S REPOSITORY, so every rule below is a test:
//   - Only a person's POST opens a pull request. There is no automatic path: nothing at the eval report, the setup run or a poll calls `openEvalWrapperPullRequest`.
//   - Only the TEMPLATE (`rows`) wrapper may be opened directly. An AI-written (`custom`) wrapper is copy-only. A wrapper the setup run's dry-run did not pass is not offered at all.
//   - Only a Rovara branch (`rovara/eval-wrapper-<12 hex>`, a name nobody has), created at the default branch's head the file was checked against, never the default branch and never a branch that exists. The adapter
//     holds the same line, in its own narrow module (`plugins/code-host/github/eval-wrapper-pr.ts`, the port's `evalWrapperPullRequest`): one new branch, one new file at one of the two wrapper paths, one pull request; no update, no
//     other path, no default-branch write. There is no generic commit call anywhere.
//   - Never over a file that exists: a path that holds anything (a file, a folder, a link) at the base is a refusal, not a replacement. The file that is there is left alone and CHECKED (detected on the default branch).
//   - Never merged by Rovara. There is no merge call here. A closed pull request is a "no" and is never opened again unless the wrapper itself changed.
//   - Once per file: one record per repository and wrapper language (the fixed path is one file), keyed by a digest of the shape, the command and the report. A monorepo gets a pull request for its first eval and copy for the rest.
//   - Audited BEFORE the write, and a failed audit means no write. Every host call goes through a guarded target (the repository that answers at the address must be the one the project pins).
//   - Fixed words everywhere a person reads; the repository's own text (a field name, a command) appears only as data in the wrapper file and the pull request body, which the person reviews.
//   - The file is found on the DEFAULT branch whoever put it there (a pull request, a person's own commit): `detectEvalWrappers`. From there a test run is approved with its cost (the eval spend approval) and then checked.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  EVAL_WRAPPER_BRANCH_PATTERN, EVAL_WRAPPER_BRANCH_PREFIX, EVAL_WRAPPER_CONFLICT_MESSAGE, EVAL_WRAPPER_PATH_TAKEN_MESSAGE, EVAL_WRAPPER_REPORT_PATH, EVAL_WRAPPER_TEMPLATE_VERSION, change, evalOutputNeedsWrapper, evalWrapperDigestOf, evalWrapperFor,
  evalWrapperTemplateVersionOf, queryAll, when,
  type DocumentStore, type EvalWrapperLanguage, type OrgId, type SetupEvalDiscoveryReport, type StoredDocument,
} from "@agentx/contracts";
import { assertGuarded, guardTarget, headOf, readOwnPr, verifyRepository, type EvalWrapperTarget } from "./eval-wrapper-host.js";
import { setupPartition } from "./keys.js";

const hex32 = z.string().regex(/^[a-f0-9]{32}$/u);
export const EVAL_WRAPPER_SK_PREFIX = "EVAL_WRAPPER#";
export const EVAL_WRAPPER_FILE_SK_PREFIX = "EVAL_WRAPPER_FILE#";
export const EVAL_WRAPPER_DISMISSED_SK = "EVAL_WRAPPER_DISMISSED";
const keyOf = (company: string, project: string, id: string) => ({ pk: setupPartition(company, project), sk: `${EVAL_WRAPPER_SK_PREFIX}${id}` });
const fileKeyOf = (company: string, project: string, id: string) => ({ pk: setupPartition(company, project), sk: `${EVAL_WRAPPER_FILE_SK_PREFIX}${id}` });
const dismissedKeyOf = (company: string, project: string) => ({ pk: setupPartition(company, project), sk: EVAL_WRAPPER_DISMISSED_SK });

/** Why a proposal was not opened, in fixed words. */
export const EVAL_WRAPPER_FAILURES = ["no_repository", "host_cannot", "unreachable", "file_exists", "conflict", "refused", "audit", "interrupted", "another_shape", "not_needed", "copy_only", "not_offered", "another_eval", "closed"] as const;
export type EvalWrapperFailure = (typeof EVAL_WRAPPER_FAILURES)[number];
export const EVAL_WRAPPER_FAILURE_WORDS: Readonly<Record<EvalWrapperFailure, string>> = Object.freeze({
  no_repository: "Rovara could not find the repository this eval is in.",
  host_cannot: "This repository's code host cannot take a proposed file from Rovara. Copy the file instead.",
  unreachable: "Rovara could not reach the repository just now.",
  file_exists: "The repository already has something at the place Rovara would put the file, so Rovara left it alone and is checking it.",
  conflict: "The repository changed while Rovara was opening the pull request. Try again.",
  refused: "The code host did not let Rovara open the pull request (the branch may be protected, or Rovara may not have write access). Copy the file instead.",
  audit: "The record of this change could not be written, so nothing was opened. Try again.",
  interrupted: "The pull request was interrupted before it opened. Try again.",
  another_shape: "Another eval in this repository already has a pull request for the same file, so this one waits for it. Copy the file instead.",
  not_needed: "This eval's results are already readable, so no file is needed.",
  copy_only: "A file Rovara's setup agent wrote itself is copy-only: copy it into your repository.",
  not_offered: "Rovara could not check a file for this eval, so it is not offering one.",
  another_eval: "Rovara opens one pull request for the first eval in a repository. Copy the file for this one.",
  closed: "The pull request was closed. Rovara will not open it again unless your eval changes. Copy the file instead.",
});

const RecordSchema = z.object({
  entityType: z.literal("EVAL_WRAPPER"), schemaVersion: z.literal(1),
  company: z.string().min(1).max(100), project: z.string().min(1).max(128), id: hex32,
  language: z.enum(["python", "node"]), repository: z.string().min(1).max(200), place: z.string().min(1).max(300), selection: z.string().min(1).max(512),
  /** The suite's own `repository` member ("" for a single-repository project), so a suite finds its record without a host read. */
  suiteRepository: z.string().max(200).optional(),
  /** Of the shape, command and report (`evalWrapperDigestOf`): the same proposal is made once. */
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["opening", "open", "merged", "closed", "failed"]),
  branch: z.string().regex(EVAL_WRAPPER_BRANCH_PATTERN).optional(), baseBranch: z.string().max(200).optional(),
  number: z.string().max(40).optional(), url: z.string().max(500).optional(), headRevision: z.string().max(80).optional(),
  failure: z.enum(EVAL_WRAPPER_FAILURES).optional(),
  taskId: z.string().max(160), by: z.string().max(256),
  openedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type EvalWrapperRecord = z.infer<typeof RecordSchema>;

/** What was found at the wrapper's path on the default branch (whoever put it there). Rewritten by every check; the test run's state is kept across checks. */
const FileRecordSchema = z.object({
  entityType: z.literal("EVAL_WRAPPER_FILE"), schemaVersion: z.literal(1),
  company: z.string().min(1).max(100), project: z.string().min(1).max(128), id: hex32,
  language: z.enum(["python", "node"]), repository: z.string().min(1).max(200), place: z.string().min(1).max(300), suiteRepository: z.string().max(200), path: z.string().min(1).max(200),
  /** The eval this check is for: one row per eval, so an eval never reads another eval's file as its own (a monorepo's second eval shares the path, not the row). */
  selection: z.string().min(1).max(512),
  /** `present`: a file is there; `absent`: nothing is; `other`: something that is not a file (a folder or a link). */
  status: z.enum(["present", "absent", "other"]),
  /** For a present file: the same text Rovara would offer, a file edited since, or one made by an older template. An edited file is judged by whether a test run can read its results. */
  match: z.enum(["same", "edited", "outdated", "other"]).optional(),
  defaultBranch: z.string().max(200).optional(),
  /** Of the file's text, so a test result follows exactly the text that was tested (an edited file that changes again starts over). */
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** The test run (approved with its cost through the eval spend approval, then checked for readable results). */
  test: z.enum(["none", "approved", "readable", "unreadable"]),
  testAt: z.iso.datetime().optional(),
  checkedAt: z.iso.datetime(),
}).strict();
export type EvalWrapperFileRecord = z.infer<typeof FileRecordSchema>;

const DismissedSchema = z.object({
  entityType: z.literal("EVAL_WRAPPER_DISMISSED"), schemaVersion: z.literal(1),
  company: z.string().min(1).max(100), project: z.string().min(1).max(128),
  /** The setup run's eval report this was set aside for: a newer report asks again. */
  reportDigest: z.string().regex(/^[a-f0-9]{16,128}$/u),
  by: z.string().max(256), at: z.iso.datetime(),
}).strict();
export type EvalWrapperDismissed = z.infer<typeof DismissedSchema>;

export interface EvalWrapperDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The project's repositories as targets (the code host that serves each, its scope and the place it pins). Absent or empty: nothing is read from or written to a host. */
  targets(project: string): Promise<EvalWrapperTarget[]>;
  /** The audit record, written BEFORE the host write, naming the person who asked. Throws when it cannot be written: nothing is then done. */
  audit(event: { action: "eval_wrapper.pull_request_requested" | "eval_wrapper.dismissed" | "eval_wrapper.reopened"; project: string; details: Record<string, string> }): Promise<void>;
  /** 12 hex digits for a branch name (tests). */
  randomHex?: () => string;
  log?: (event: string, fields: Record<string, string>) => void;
}

export interface EvalWrapperOutcome { selection: string; state: EvalWrapperRecord["state"] | "skipped"; failure?: EvalWrapperFailure; number?: string; url?: string; replayed?: boolean }

/** How long a claim may stay "opening" before the next call recovers it (looks the pull request up by its branch, or marks the proposal interrupted). */
export const OPENING_STALE_MS = 10 * 60_000;
/** How old a check of the default branch may be before a plain read of the card looks again ("Check now" always looks). */
export const DETECT_FRESH_MS = 60_000;

function parse(company: string, project: string, raw: unknown): EvalWrapperRecord | undefined {
  if (raw === undefined || raw === null) return undefined;
  const { pk, sk, ...value } = raw as Record<string, unknown>;
  void pk; void sk;
  const parsed = RecordSchema.safeParse(value);
  return parsed.success && parsed.data.company === company && parsed.data.project === project ? parsed.data : undefined;
}
function parseFile(company: string, project: string, raw: unknown): EvalWrapperFileRecord | undefined {
  if (raw === undefined || raw === null) return undefined;
  const { pk, sk, ...value } = raw as Record<string, unknown>;
  void pk; void sk;
  const parsed = FileRecordSchema.safeParse(value);
  return parsed.success && parsed.data.company === company && parsed.data.project === project ? parsed.data : undefined;
}

const fileIdOf = (project: string, place: string, language: EvalWrapperLanguage, selection: string): string => createHash("sha256").update(`rovara-eval-wrapper-file-id/v1\n${project}\n${place}\n${language}\n${selection}`, "utf8").digest("hex").slice(0, 32);
const idOf = (project: string, place: string, language: EvalWrapperLanguage): string => createHash("sha256").update(`rovara-eval-wrapper-id/v1\n${project}\n${place}\n${language}`, "utf8").digest("hex").slice(0, 32);

async function readRecord(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string, id: string): Promise<EvalWrapperRecord | undefined> {
  return parse(deps.companyId, project, await deps.store.get(keyOf(deps.companyId, project, id)));
}

/** This project's wrapper pull requests, newest first (this company's rows only). */
export async function listEvalWrappers(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<EvalWrapperRecord[]> {
  try {
    const rows = await queryAll(deps.store, { pk: setupPartition(deps.companyId, project), sk: { op: "beginsWith", prefix: EVAL_WRAPPER_SK_PREFIX } });
    return rows.map((row) => parse(deps.companyId, project, row)).filter((row): row is EvalWrapperRecord => row !== undefined).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 8);
  } catch { return []; }
}

/** What the last check found at each wrapper path on the default branch (this company's rows only). */
export async function listEvalWrapperFiles(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<EvalWrapperFileRecord[]> {
  try {
    const rows = await queryAll(deps.store, { pk: setupPartition(deps.companyId, project), sk: { op: "beginsWith", prefix: EVAL_WRAPPER_FILE_SK_PREFIX } });
    return rows.map((row) => parseFile(deps.companyId, project, row)).filter((row): row is EvalWrapperFileRecord => row !== undefined).slice(0, 64);
  } catch { return []; }
}

/** The project's "Not now" for the eval wrapper card, or undefined. Read from this company's own key; a row of another company or project is ignored. */
export async function readEvalWrapperDismissed(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<EvalWrapperDismissed | undefined> {
  try {
    const raw = await deps.store.get(dismissedKeyOf(deps.companyId, project));
    if (raw === undefined || raw === null) return undefined;
    const { pk, sk, ...value } = raw as Record<string, unknown>;
    void pk; void sk;
    const parsed = DismissedSchema.safeParse(value);
    return parsed.success && parsed.data.company === deps.companyId && parsed.data.project === project ? parsed.data : undefined;
  } catch { return undefined; }
}

const prTitle = (language: EvalWrapperLanguage): string => `Add ${language === "python" ? "rovara/eval-wrapper.py" : "rovara/eval-wrapper.mjs"} so Rovara can read your eval results`;

/** The pull request's text: fixed words, and the data the wrapper was made from. The wrapper file is the thing to review. */
function prBody(input: { language: EvalWrapperLanguage; selection: string; command: string; results: string; path: string }): string {
  return [
    "A person on your team asked Rovara to open this pull request. Nothing happens unless you merge it, and Rovara never merges it.",
    "",
    `Rovara runs the eval "${input.selection.replace(/[^A-Za-z0-9 ._/:+-]+/gu, " ").slice(0, 120)}" before and after an AI change, and needs one result per question. Your eval writes its results in a form Rovara does not read as it is, so this adds one small file:`,
    "",
    `- \`${input.path}\` was made from a template for a file of rows. It runs your eval command unchanged (first removing any old \`${input.results}\` and \`${EVAL_WRAPPER_REPORT_PATH}\`), reads \`${input.results}\`, and writes a JUnit report (one test case per question) to \`${EVAL_WRAPPER_REPORT_PATH}\`.`,
    "- It reads `ROVARA_EVAL_IDS` (the questions to report), calls no network and reads no secret.",
    `- Your command, as it will run: \`${input.command.replace(/`/gu, "'").slice(0, 300)}\``,
    "",
    "Please read the file before you merge it. Once it is on your default branch, Rovara notices it and asks you to approve a test run (with its cost) to check it can read your results. If you close this pull request, Rovara will not open it again unless your eval changes.",
  ].join("\n");
}

const commandText = (command: { executable: string; args: readonly string[] }): string => [command.executable, ...command.args].join(" ");

async function freshBranch(deps: EvalWrapperDeps, target: EvalWrapperTarget): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const branch = `${EVAL_WRAPPER_BRANCH_PREFIX}${deps.randomHex?.() ?? randomBytes(6).toString("hex")}`;
    if (await headOf(target, branch) === undefined) return branch;
  }
  return undefined;
}

const isoOf = (deps: Pick<EvalWrapperDeps, "now">): string => new Date(deps.now()).toISOString();

/** Marks the claim failed with a fixed reason (best effort: the next call sees the claim go stale and recovers it). */
async function fail(deps: EvalWrapperDeps, record: EvalWrapperRecord, failure: EvalWrapperFailure): Promise<EvalWrapperOutcome> {
  try {
    await deps.store.update({ key: keyOf(record.company, record.project, record.id), ops: [change.set("state", "failed"), change.set("failure", failure), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", record.state) });
  } catch { deps.log?.("eval_wrapper.fail_write", { failure }); }
  return { selection: record.selection, state: "failed", failure };
}

/** A claim left "opening" (the process ended mid-way): the pull request is found by its branch, or the proposal is marked interrupted. */
async function recover(deps: EvalWrapperDeps, target: EvalWrapperTarget, record: EvalWrapperRecord): Promise<EvalWrapperRecord> {
  if (record.branch === undefined) return record;
  let found: { id: string; url: string } | undefined;
  try { found = await target.host.evalWrapperPullRequest?.forBranch(target.repository, record.branch, target.scope).then((ref) => (ref === undefined ? undefined : { id: ref.id, url: ref.url })); } catch { return record; }
  if (found !== undefined) {
    const next: EvalWrapperRecord = { ...record, state: "open", number: found.id, url: found.url, updatedAt: isoOf(deps) };
    const done = await deps.store.update({ key: keyOf(record.company, record.project, record.id), ops: [change.set("state", "open"), change.set("number", found.id), change.set("url", found.url), change.set("updatedAt", next.updatedAt)], condition: when.eq("state", "opening") });
    return done.applied ? next : record;
  }
  // The head Rovara left is not known here, so the branch stays (a person may delete it); the proposal is simply marked interrupted.
  const failed: EvalWrapperRecord = { ...record, state: "failed", failure: "interrupted", updatedAt: isoOf(deps) };
  const done = await deps.store.update({ key: keyOf(record.company, record.project, record.id), ops: [change.set("state", "failed"), change.set("failure", "interrupted"), change.set("updatedAt", failed.updatedAt)], condition: when.eq("state", "opening") });
  return done.applied ? failed : record;
}

/** One eval of a report whose results Rovara cannot read as they are, and the file it would take. */
export interface Need {
  selection: string; language: EvalWrapperLanguage; suite: SetupEvalDiscoveryReport["suites"][number]; file: NonNullable<ReturnType<typeof evalWrapperFor>>; digest: string;
  kind: "template" | "custom";
  /** The setup run's dry-run passed: only then is the file offered (shown, copied or opened as a pull request). */
  offered: boolean;
  /** The first eval (by name) of its repository and language: the only one a pull request may be opened for (the file is one path); the rest are copy-only. */
  firstOfFile: boolean;
}

/** Every eval of the report that needs a wrapper, in the order of their names. Pure. */
export function needsOf(report: SetupEvalDiscoveryReport): Need[] {
  const out: Need[] = [];
  const seen = new Set<string>();
  for (const suite of [...report.suites].sort((a, b) => (a.selection < b.selection ? -1 : a.selection > b.selection ? 1 : 0))) {
    if (!evalOutputNeedsWrapper(suite.output)) continue;
    const file = evalWrapperFor(suite);
    if (file === undefined) continue;
    const group = `${suite.repository ?? ""}\u0000${file.language}`;
    out.push({
      selection: suite.selection, language: file.language, suite, file, digest: evalWrapperDigestOf({ output: suite.output, command: suite.command, report: suite.report }),
      kind: suite.output.kind === "custom" ? "custom" : "template", offered: suite.wrapperDryRun === "passed", firstOfFile: !seen.has(group),
    });
    seen.add(group);
  }
  return out;
}

function targetFor(targets: readonly EvalWrapperTarget[], repository: string | undefined): EvalWrapperTarget | undefined {
  return repository === undefined ? (targets.length === 1 ? targets[0] : undefined) : targets.find((entry) => entry.name === repository);
}

/**
 * A PERSON asked Rovara to open the pull request for the eval named `selection` (`by` is that person's id; the route checked their live role and wrote the audit's person). Never throws. Refuses, with a fixed reason and no
 * write: an eval that needs no file, a `custom` wrapper (copy-only), a file the dry-run did not pass, a second eval for a file that one pull request already covers, a closed pull request for this very wrapper, a file that
 * is already there (left alone and checked) and a repository Rovara cannot write to. A failed proposal may be asked for again; one that is open or merged is replayed, never repeated.
 */
export async function openEvalWrapperPullRequest(deps: EvalWrapperDeps, project: string, input: { report: SetupEvalDiscoveryReport; selection: string; taskId: string; by: string }): Promise<EvalWrapperOutcome> {
  const needs = needsOf(input.report);
  const need = needs.find((entry) => entry.selection === input.selection);
  if (need === undefined) return { selection: input.selection, state: "failed", failure: "not_needed" };
  try { return await openOne(deps, project, input, need, needs); } catch { return { selection: need.selection, state: "failed", failure: "refused" }; }
}

async function openOne(deps: EvalWrapperDeps, project: string, input: { taskId: string; by: string }, need: Need, siblings: readonly Need[]): Promise<EvalWrapperOutcome> {
  // The AI-written file and a file nothing checked are never opened for a person; a second eval for one file is copy-only.
  if (need.kind === "custom") return { selection: need.selection, state: "failed", failure: "copy_only" };
  if (!need.offered) return { selection: need.selection, state: "failed", failure: "not_offered" };
  if (!need.firstOfFile) return { selection: need.selection, state: "failed", failure: "another_eval" };
  let targets: EvalWrapperTarget[];
  try { targets = await deps.targets(project); } catch { targets = []; }
  const raw = targetFor(targets, need.suite.repository);
  if (raw === undefined) return { selection: need.selection, state: "failed", failure: "no_repository" };
  const id = idOf(project, raw.place, need.language);
  const host = raw.host;
  if (host.evalWrapperPullRequest === undefined || host.pathKind === undefined) return { selection: need.selection, state: "failed", failure: "host_cannot" };
  const target = guardTarget(raw);
  let existing = await readRecord(deps, project, id);
  if (existing?.state === "opening" && deps.now() - Date.parse(existing.updatedAt) >= OPENING_STALE_MS) existing = await recover(deps, target, existing);
  if (existing !== undefined) {
    if (existing.state === "opening") return { selection: need.selection, state: "opening", replayed: true };
    if (existing.state === "open" || existing.state === "merged") {
      // The same proposal is made once. A different shape for the same file waits for the open one.
      return existing.digest === need.digest ? { selection: need.selection, state: existing.state, ...(existing.number === undefined ? {} : { number: existing.number }), ...(existing.url === undefined ? {} : { url: existing.url }), replayed: true } : { selection: need.selection, state: "skipped", failure: "another_shape" };
    }
    // A closed pull request is a "no" to THIS wrapper and is never opened again; a different wrapper (the eval changed) may be opened.
    if (existing.state === "closed" && existing.digest === need.digest) return { selection: need.selection, state: "closed", failure: "closed", replayed: true, ...(existing.number === undefined ? {} : { number: existing.number }) };
  }

  const verified = await verifyRepository(target);
  if (!verified.ok) return { selection: need.selection, state: "failed", failure: "unreachable" };
  const baseBranch = verified.identity.defaultBranch;
  const baseHead = await headOf(target, baseBranch);
  if (baseHead === undefined) return { selection: need.selection, state: "failed", failure: "unreachable" };
  // Never over a file: anything at the wrapper's path (a file, a folder, a link) is left exactly as it is, and CHECKED (the card then moves on from the file that is there).
  let kind: Awaited<ReturnType<NonNullable<typeof host.pathKind>>>;
  try { kind = await target.host.pathKind!(target.repository, need.file.path, baseHead, target.scope); } catch { return { selection: need.selection, state: "failed", failure: "unreachable" }; }
  if (kind !== "none") {
    await detectOne(deps, project, need, raw, siblings).catch(() => undefined);
    return { selection: need.selection, state: "failed", failure: "file_exists" };
  }
  const branch = await freshBranch(deps, target);
  if (branch === undefined) return { selection: need.selection, state: "failed", failure: "conflict" };

  // Audited BEFORE any write, naming the person; a failed audit is no write at all.
  try { await deps.audit({ action: "eval_wrapper.pull_request_requested", project, details: { repository: raw.name.slice(0, 200), language: need.language, digest: need.digest.slice(0, 16), taskId: input.taskId.slice(0, 160), by: input.by.slice(0, 256) } }); } catch { return { selection: need.selection, state: "failed", failure: "audit" }; }

  const at = isoOf(deps);
  const claim: EvalWrapperRecord = {
    entityType: "EVAL_WRAPPER", schemaVersion: 1, company: deps.companyId, project, id, language: need.language, repository: raw.name, place: raw.place, selection: need.selection, suiteRepository: need.suite.repository ?? "", digest: need.digest,
    state: "opening", branch, baseBranch, taskId: input.taskId, by: input.by, openedAt: at, updatedAt: at,
  };
  const key = keyOf(deps.companyId, project, id);
  // The claim: new, or in place of the record this call read (failed or a different closed proposal). Two calls cannot both hold it.
  const claimed = existing === undefined
    ? await deps.store.put({ item: { ...key, ...claim } as unknown as StoredDocument, condition: when.absent() })
    : await deps.store.put({ item: { ...key, ...claim } as unknown as StoredDocument, condition: when.and(when.eq("state", existing.state), when.eq("updatedAt", existing.updatedAt)) });
  if (!claimed.applied) return { selection: need.selection, state: "opening", replayed: true };

  // ONE call: the new branch with the one new file, and the one pull request (the adapter removes the branch it made when the pull request cannot be opened).
  let written: Awaited<ReturnType<NonNullable<typeof host.evalWrapperPullRequest>["open"]>>;
  try {
    written = await target.host.evalWrapperPullRequest!.open({
      repository: target.repository, baseBranch, baseRevision: baseHead, branch, path: need.file.path, content: need.file.content, title: prTitle(need.language),
      body: prBody({ language: need.language, selection: need.selection, command: commandText(need.suite.command), results: need.suite.report.cwd === "." ? need.suite.report.argument : `${need.suite.report.cwd}/${need.suite.report.argument}`, path: need.file.path }),
    }, target.scope);
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    return fail(deps, claim, text.includes(EVAL_WRAPPER_PATH_TAKEN_MESSAGE) ? "file_exists" : text.includes(EVAL_WRAPPER_CONFLICT_MESSAGE) ? "conflict" : "refused");
  }
  const opened = await deps.store.update({
    key, ops: [change.set("state", "open"), change.set("number", written.ref.id), change.set("url", written.ref.url), change.set("headRevision", written.revision), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "opening"),
  });
  if (!opened.applied) deps.log?.("eval_wrapper.open_write", { project });
  return { selection: need.selection, state: "open", number: written.ref.id, url: written.ref.url };
}

/** Reads the file at one need's path on the default branch and keeps what it found. A host that cannot answer changes nothing. Never touches the repository except by reading. */
async function detectOne(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "now">, project: string, need: Need, raw: EvalWrapperTarget, siblings: readonly Need[] = []): Promise<void> {
  const host = raw.host;
  if (host.pathKind === undefined) return;
  const target = guardTarget(raw);
  const verified = await verifyRepository(target);
  if (!verified.ok) return;
  const defaultBranch = verified.identity.defaultBranch;
  const head = await headOf(target, defaultBranch);
  if (head === undefined) return;
  const kind = await target.host.pathKind!(target.repository, need.file.path, head, target.scope);
  let status: EvalWrapperFileRecord["status"] = kind === "none" ? "absent" : kind === "file" ? "present" : "other";
  let match: EvalWrapperFileRecord["match"];
  let contentDigest: string | undefined;
  if (status === "present") {
    const text = await target.host.fileAtRevision(target.repository, need.file.path, head, target.scope, { timeoutMs: 15_000, maxBytes: 100_000 });
    if (text === undefined) status = "absent";
    else {
      contentDigest = createHash("sha256").update(text, "utf8").digest("hex");
      const version = evalWrapperTemplateVersionOf(text);
      // The same text Rovara would offer; else a file an older Rovara template made; else one a person made or changed (judged by whether a test run can read its results, never by its text).
      // Another eval's own offered file at the same path (a monorepo's copy-only file put there): it would run THAT eval's command, so it is never this eval's file.
      const another = siblings.some((entry) => entry.selection !== need.selection && entry.file.path === need.file.path && entry.file.content === text && entry.file.content !== need.file.content);
      match = another ? "other" : text === need.file.content ? "same" : version !== undefined && version < EVAL_WRAPPER_TEMPLATE_VERSION ? "outdated" : "edited";
    }
  }
  const id = fileIdOf(project, raw.place, need.language, need.selection);
  const key = fileKeyOf(deps.companyId, project, id);
  const at = new Date(deps.now()).toISOString();
  const before = parseFile(deps.companyId, project, await deps.store.get(key));
  // A test result belongs to the file that was tested: a file that is gone or has changed text since its test starts over.
  const keep = before !== undefined && before.status === status && before.match === match && before.contentDigest === contentDigest;
  const next: EvalWrapperFileRecord = {
    entityType: "EVAL_WRAPPER_FILE", schemaVersion: 1, company: deps.companyId, project, id, language: need.language, repository: raw.name, place: raw.place, suiteRepository: need.suite.repository ?? "", path: need.file.path, selection: need.selection, status,
    ...(match === undefined ? {} : { match }), ...(contentDigest === undefined ? {} : { contentDigest }), defaultBranch, test: keep ? before.test : "none", ...(keep && before.testAt !== undefined ? { testAt: before.testAt } : {}), checkedAt: at,
  };
  await deps.store.put({ item: { ...key, ...next } as unknown as StoredDocument });
}

/**
 * Looks for each eval's wrapper file on the DEFAULT branch (whoever put it there: a pull request, a person's own commit), reading only. `force` looks now (the "Check now" button); otherwise a check younger than
 * `DETECT_FRESH_MS` is left as it is. Bounded (at most 4 evals); a read that fails changes nothing. Never throws.
 */
export async function detectEvalWrappers(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "now" | "targets">, project: string, report: SetupEvalDiscoveryReport, options: { force?: boolean; floorMs?: number } = {}): Promise<void> {
  try {
    const all = needsOf(report);
    const needs = all.slice(0, 4);
    if (needs.length === 0) return;
    const files = await listEvalWrapperFiles(deps, project);
    const targets = await deps.targets(project);
    for (const need of needs) {
      try {
        const raw = targetFor(targets, need.suite.repository);
        if (raw === undefined) continue;
        const known = files.find((row) => row.id === fileIdOf(project, raw.place, need.language, need.selection));
        const age = known === undefined ? Infinity : deps.now() - Date.parse(known.checkedAt);
        // A plain read leaves a young check alone; "Check now" looks again, but not more than once in `floorMs` (a person cannot drain the code host's quota).
        if (age < (options.force === true ? (options.floorMs ?? 0) : DETECT_FRESH_MS)) continue;
        await detectOne(deps, project, need, raw, all);
      } catch { /* tried again at the next read */ }
    }
  } catch { /* the card reads the rows as they are */ }
}

/** "Not now": the card is set aside for this setup run's report. A newer report (another setup run) asks again. Audited, naming the person; a failed audit sets nothing aside. */
export async function dismissEvalWrapper(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "now" | "audit">, project: string, input: { reportDigest: string; by: string }): Promise<void> {
  await deps.audit({ action: "eval_wrapper.dismissed", project, details: { by: input.by.slice(0, 256), reportDigest: input.reportDigest.slice(0, 16) } });
  const row: EvalWrapperDismissed = { entityType: "EVAL_WRAPPER_DISMISSED", schemaVersion: 1, company: deps.companyId, project, reportDigest: input.reportDigest, by: input.by, at: new Date(deps.now()).toISOString() };
  await deps.store.put({ item: { ...dismissedKeyOf(deps.companyId, project), ...row } });
}

/** Undoes "Not now" (the Evals page row's "Set up now"). Audited, naming the person. */
export async function reopenEvalWrapper(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "audit">, project: string, input: { by: string }): Promise<void> {
  await deps.audit({ action: "eval_wrapper.reopened", project, details: { by: input.by.slice(0, 256) } });
  await deps.store.delete({ key: dismissedKeyOf(deps.companyId, project) });
}

/**
 * The test run of a found file (DEC 254zzz43): `approved` once the person approved the eval's spend (the same approval, in dollars, as every eval), then `readable` or `unreadable` from what the run read. Kept on the file's
 * record, so it follows the text that was tested: a changed file starts over. Returns false when no found file matches (nothing is recorded).
 */
export async function recordEvalWrapperTest(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "now">, project: string, suite: { repository?: string | undefined; selection: string; language: EvalWrapperLanguage }, result: "approved" | "readable" | "unreadable"): Promise<boolean> {
  const row = (await listEvalWrapperFiles(deps, project)).find((entry) => entry.selection === suite.selection && entry.suiteRepository === (suite.repository ?? "") && entry.language === suite.language && entry.status === "present" && entry.match !== "outdated");
  if (row === undefined) return false;
  const done = await deps.store.update({ key: fileKeyOf(deps.companyId, project, row.id), ops: [change.set("test", result), change.set("testAt", new Date(deps.now()).toISOString())], condition: when.eq("checkedAt", row.checkedAt) });
  return done.applied;
}

/**
 * The found file THIS eval is read through, if one is there and usable: its own row, present, same or edited (an out-of-date one asks for the new file first). An eval that is not the first of its file (a monorepo's second
 * eval shares the path) is read through the file only when the text is exactly its own: it is never approved through another eval's file, whose command it would run.
 */
export function wrapperFileFor(files: readonly EvalWrapperFileRecord[], suite: { repository?: string | undefined; selection: string; firstOfFile: boolean }, language: EvalWrapperLanguage): EvalWrapperFileRecord | undefined {
  return files.find((row) => row.selection === suite.selection && row.suiteRepository === (suite.repository ?? "") && row.language === language && row.status === "present"
    && (row.match === "same" || (row.match === "edited" && suite.firstOfFile)));
}

/**
 * Reads where each OPEN pull request stands at the host (merged, closed, still open) and keeps it. Bounded (at most 4 reads). A read that fails or a pull request that is not Rovara's own changes nothing. Never throws.
 */
export async function refreshEvalWrappers(deps: Pick<EvalWrapperDeps, "store" | "companyId" | "now" | "targets">, project: string): Promise<void> {
  try {
    const open = (await listEvalWrappers(deps, project)).filter((row) => row.state === "open" && row.number !== undefined && row.branch !== undefined).slice(0, 4);
    if (open.length === 0) return;
    const targets = await deps.targets(project);
    for (const record of open) {
      try {
        const raw = targets.find((entry) => entry.place === record.place);
        if (raw === undefined) continue;
        const target = guardTarget(raw);
        assertGuarded(target);
        const read = await readOwnPr(target, record.number!, record.branch!, record.baseBranch);
        const key = keyOf(deps.companyId, project, record.id);
        if (read.kind === "gone") { await deps.store.update({ key, ops: [change.set("state", "closed"), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "open") }); continue; }
        if (read.ours !== true) continue;
        const state = read.details.state === "merged" ? "merged" : read.details.state === "closed" ? "closed" : undefined;
        if (state !== undefined) await deps.store.update({ key, ops: [change.set("state", state), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "open") });
      } catch { /* tried again at the next read */ }
    }
  } catch { /* the card reads the rows as they are */ }
}
