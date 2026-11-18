// L4-EVW2 (DEC 254zzz20 D2): when the setup run found an eval whose OUTPUT Rovara cannot read as it is, Rovara proposes a small wrapper file as a PULL REQUEST on the customer's repository. The customer never writes an
// adapter. A person reviews the pull request and merges it (or does not); setup then reads the eval again.
//
// THIS WRITES TO A CUSTOMER'S REPOSITORY, so every rule below is a test:
//   - Only a Rovara branch (`rovara/eval-wrapper-<12 hex>`, a name nobody has), created at the default branch's head the file was checked against, never the default branch and never a branch that exists. The adapter
//     holds the same line: wrapper branch names carry only the two wrapper paths, only as new files, only on a new branch (`commit-files.ts`).
//   - Never over a file that exists: a path that holds anything (a file, a folder, a link) at the base is a refusal, not a replacement.
//   - Never merged by Rovara. There is no merge call here; the pull request is a proposal and says so. A closed pull request is a "no" and is not opened again unless the wrapper itself changed.
//   - Once per unmappable format: one record per repository and wrapper language (the fixed path is one file), keyed by a digest of the shape, the command and the report. The same proposal is made once, a repeat finds the
//     record, and a suite that would need the same file for another shape is not opened beside it.
//   - Audited BEFORE the write, and a failed audit means no write. Every host call goes through a guarded target (the repository that answers at the address must be the one the project pins).
//   - A `rows` wrapper is made by code from a template (`eval-wrapper-templates.ts`); only a `custom` one is the setup agent's text, bounded, from the setup run (under the setup run's own spend).
//   - Fixed words everywhere a person reads; the repository's own text (a field name, a command) appears only as data in the wrapper file and the pull request body, which the person reviews.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE, EVAL_WRAPPER_BRANCH_PREFIX, EVAL_WRAPPER_REPORT_PATH, change, evalOutputNeedsWrapper, evalWrapperDigestOf, queryAll, when,
  type DocumentStore, type EvalWrapperLanguage, type OrgId, type SetupEvalDiscoveryReport, type StoredDocument,
} from "@agentx/contracts";
import { assertGuarded, guardTarget, headOf, readOwnPr, verifyRepository, type RepoFileTarget } from "../../lessons/repo-file-host.js";
import { evalWrapperFor } from "./eval-wrapper-templates.js";
import { setupPartition } from "./keys.js";

const hex32 = z.string().regex(/^[a-f0-9]{32}$/u);
export const EVAL_WRAPPER_SK_PREFIX = "EVAL_WRAPPER#";
const keyOf = (company: string, project: string, id: string) => ({ pk: setupPartition(company, project), sk: `${EVAL_WRAPPER_SK_PREFIX}${id}` });

/** Why a proposal was not opened, in fixed words. */
export const EVAL_WRAPPER_FAILURES = ["no_repository", "host_cannot", "unreachable", "file_exists", "conflict", "refused", "audit", "interrupted", "another_shape"] as const;
export type EvalWrapperFailure = (typeof EVAL_WRAPPER_FAILURES)[number];
export const EVAL_WRAPPER_FAILURE_WORDS: Readonly<Record<EvalWrapperFailure, string>> = Object.freeze({
  no_repository: "Rovara could not find the repository this eval is in.",
  host_cannot: "This repository's code host cannot take a proposed file from Rovara.",
  unreachable: "Rovara could not reach the repository just now.",
  file_exists: "The repository already has a file at the place Rovara would put its proposal, so Rovara left it alone.",
  conflict: "The repository changed while Rovara was proposing the file. Try again.",
  refused: "The code host refused the proposed file.",
  audit: "The record of this change could not be written, so nothing was proposed. Try again.",
  interrupted: "The proposal was interrupted before the pull request opened. Try again.",
  another_shape: "Another eval in this repository already has a proposal for the same file, so this one waits for it.",
});

const RecordSchema = z.object({
  entityType: z.literal("EVAL_WRAPPER"), schemaVersion: z.literal(1),
  company: z.string().min(1).max(100), project: z.string().min(1).max(128), id: hex32,
  language: z.enum(["python", "node"]), repository: z.string().min(1).max(200), place: z.string().min(1).max(300), selection: z.string().min(1).max(512),
  /** Of the shape, command and report (`evalWrapperDigestOf`): the same proposal is made once. */
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["opening", "open", "merged", "closed", "failed"]),
  branch: z.string().max(100).optional(), baseBranch: z.string().max(200).optional(),
  number: z.string().max(40).optional(), url: z.string().max(500).optional(), headRevision: z.string().max(80).optional(),
  failure: z.enum(EVAL_WRAPPER_FAILURES).optional(),
  taskId: z.string().max(160), by: z.string().max(256),
  openedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type EvalWrapperRecord = z.infer<typeof RecordSchema>;

export interface EvalWrapperDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The project's repositories as targets (the code host that serves each, its scope and the place it pins): the same shape the lessons pass reads. Absent or empty: no proposal is made. */
  targets(project: string): Promise<RepoFileTarget[]>;
  /** The audit record, written BEFORE the host write. Throws when it cannot be written: nothing is then proposed. */
  audit(event: { action: "eval_wrapper.proposed" | "eval_wrapper.retry"; project: string; details: Record<string, string> }): Promise<void>;
  /** 12 hex digits for a branch name (tests). */
  randomHex?: () => string;
  log?: (event: string, fields: Record<string, string>) => void;
}

export interface EvalWrapperOutcome { selection: string; state: EvalWrapperRecord["state"] | "skipped"; failure?: EvalWrapperFailure; number?: string; url?: string; replayed?: boolean }

/** How long a claim may stay "opening" before the next call recovers it (looks the pull request up by its branch, or marks the proposal interrupted). */
export const OPENING_STALE_MS = 10 * 60_000;

function parse(company: string, project: string, raw: unknown): EvalWrapperRecord | undefined {
  if (raw === undefined || raw === null) return undefined;
  const { pk, sk, ...value } = raw as Record<string, unknown>;
  void pk; void sk;
  const parsed = RecordSchema.safeParse(value);
  return parsed.success && parsed.data.company === company && parsed.data.project === project ? parsed.data : undefined;
}

const idOf = (project: string, place: string, language: EvalWrapperLanguage): string => createHash("sha256").update(`rovara-eval-wrapper-id/v1\n${project}\n${place}\n${language}`, "utf8").digest("hex").slice(0, 32);

async function readRecord(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string, id: string): Promise<EvalWrapperRecord | undefined> {
  return parse(deps.companyId, project, await deps.store.get(keyOf(deps.companyId, project, id)));
}

/** This project's wrapper proposals, newest first (this company's rows only). */
export async function listEvalWrappers(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<EvalWrapperRecord[]> {
  try {
    const rows = await queryAll(deps.store, { pk: setupPartition(deps.companyId, project), sk: { op: "beginsWith", prefix: EVAL_WRAPPER_SK_PREFIX } });
    return rows.map((row) => parse(deps.companyId, project, row)).filter((row): row is EvalWrapperRecord => row !== undefined).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 8);
  } catch { return []; }
}

const prTitle = (language: EvalWrapperLanguage): string => `Add ${language === "python" ? "rovara/eval-wrapper.py" : "rovara/eval-wrapper.mjs"} so Rovara can read your eval results (proposal)`;

/** The pull request's text: fixed words, and the data the wrapper was made from. The wrapper file is the thing to review. */
function prBody(input: { language: EvalWrapperLanguage; selection: string; custom: boolean; command: string; results: string; path: string }): string {
  return [
    "This is a proposal from Rovara. Nothing happens unless you merge it, and Rovara never merges it.",
    "",
    `Rovara runs the eval "${input.selection.replace(/[\r\n`]+/gu, " ").slice(0, 120)}" before and after an AI change, and needs one result per question. Your eval writes its results in a form Rovara does not read as it is, so this adds one small file:`,
    "",
    `- \`${input.path}\` ${input.custom ? "was written by Rovara's setup agent for this repository." : "was made from a template for a file of rows."} It runs your eval command unchanged, reads \`${input.results}\`, and writes a JUnit report (one test case per question) to \`${EVAL_WRAPPER_REPORT_PATH}\`.`,
    "- It reads `ROVARA_EVAL_IDS` (the questions to report), calls no network and reads no secret.",
    `- Your command, as it will run: \`${input.command.replace(/`/gu, "'").slice(0, 300)}\``,
    "",
    "Please read the file before you merge it. After it is merged, run setup again so Rovara reads your eval through it. If you close this pull request, Rovara will not open it again unless your eval changes.",
  ].join("\n");
}

const commandText = (command: { executable: string; args: readonly string[] }): string => [command.executable, ...command.args].join(" ");

async function freshBranch(deps: EvalWrapperDeps, target: RepoFileTarget): Promise<string | undefined> {
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

/** Deletes a branch Rovara made for a proposal that did not open (best effort; only ever a wrapper-family name, which the adapter checks again). */
async function dropBranch(target: RepoFileTarget, branch: string | undefined): Promise<void> {
  if (branch === undefined || target.host.deleteBranch === undefined) return;
  try { await target.host.deleteBranch(target.repository, branch, target.scope); } catch { /* the next sweep or retry meets it again */ }
}

/** A claim left "opening" (the process ended mid-way): the pull request is found by its branch, or the proposal is marked interrupted and its branch is dropped. */
async function recover(deps: EvalWrapperDeps, target: RepoFileTarget, record: EvalWrapperRecord): Promise<EvalWrapperRecord> {
  if (record.branch === undefined) return record;
  let found: { id: string; url: string } | undefined;
  try { found = await target.host.changeRequestForBranch?.(target.repository, record.branch, target.scope).then((ref) => (ref === undefined ? undefined : { id: ref.id, url: ref.url })); } catch { return record; }
  if (found !== undefined) {
    const next: EvalWrapperRecord = { ...record, state: "open", number: found.id, url: found.url, updatedAt: isoOf(deps) };
    const done = await deps.store.update({ key: keyOf(record.company, record.project, record.id), ops: [change.set("state", "open"), change.set("number", found.id), change.set("url", found.url), change.set("updatedAt", next.updatedAt)], condition: when.eq("state", "opening") });
    return done.applied ? next : record;
  }
  await dropBranch(target, record.branch);
  const failed: EvalWrapperRecord = { ...record, state: "failed", failure: "interrupted", updatedAt: isoOf(deps) };
  const done = await deps.store.update({ key: keyOf(record.company, record.project, record.id), ops: [change.set("state", "failed"), change.set("failure", "interrupted"), change.set("updatedAt", failed.updatedAt)], condition: when.eq("state", "opening") });
  return done.applied ? failed : record;
}

interface Need { selection: string; language: EvalWrapperLanguage; suite: SetupEvalDiscoveryReport["suites"][number]; file: NonNullable<ReturnType<typeof evalWrapperFor>>; digest: string }

function needsOf(report: SetupEvalDiscoveryReport): Need[] {
  const out: Need[] = [];
  for (const suite of [...report.suites].sort((a, b) => (a.selection < b.selection ? -1 : a.selection > b.selection ? 1 : 0))) {
    if (!evalOutputNeedsWrapper(suite.output)) continue;
    const file = evalWrapperFor(suite);
    if (file === undefined) continue;
    out.push({ selection: suite.selection, language: file.language, suite, file, digest: evalWrapperDigestOf({ output: suite.output, command: suite.command, report: suite.report }) });
  }
  return out;
}

function targetFor(targets: readonly RepoFileTarget[], repository: string | undefined): RepoFileTarget | undefined {
  return repository === undefined ? (targets.length === 1 ? targets[0] : undefined) : targets.find((entry) => entry.name === repository);
}

/**
 * Proposes the wrapper of every suite in `report` that needs one: once per repository and language, never over a file, never on the default branch, never merged. Never throws (a fault is that suite's outcome). `by` is who or what
 * asked (the setup run's id, or the person who pressed "Try again"); `retry` lets a proposal that FAILED be made again (a closed pull request stays a "no").
 */
export async function proposeEvalWrappers(deps: EvalWrapperDeps, project: string, input: { report: SetupEvalDiscoveryReport; taskId: string; by: string; retry?: boolean }): Promise<EvalWrapperOutcome[]> {
  const outcomes: EvalWrapperOutcome[] = [];
  const needs = needsOf(input.report);
  if (needs.length === 0) return outcomes;
  let targets: RepoFileTarget[];
  try { targets = await deps.targets(project); } catch { targets = []; }
  const handled = new Set<string>();
  for (const need of needs) {
    try { outcomes.push(await proposeOne(deps, project, input, need, targets, handled)); } catch { outcomes.push({ selection: need.selection, state: "failed", failure: "refused" }); }
  }
  return outcomes;
}

async function proposeOne(deps: EvalWrapperDeps, project: string, input: { taskId: string; by: string; retry?: boolean }, need: Need, targets: readonly RepoFileTarget[], handled: Set<string>): Promise<EvalWrapperOutcome> {
  const raw = targetFor(targets, need.suite.repository);
  if (raw === undefined) return { selection: need.selection, state: "failed", failure: "no_repository" };
  const id = idOf(project, raw.place, need.language);
  // One file, one proposal: a second suite that needs the same file (another shape) waits for the first.
  if (handled.has(id)) return { selection: need.selection, state: "skipped", failure: "another_shape" };
  handled.add(id);
  const host = raw.host;
  if (host.commitFiles === undefined || host.changeRequestForBranch === undefined || host.deleteBranch === undefined) return { selection: need.selection, state: "failed", failure: "host_cannot" };
  const target = guardTarget(raw);
  let existing = await readRecord(deps, project, id);
  if (existing?.state === "opening" && deps.now() - Date.parse(existing.updatedAt) >= OPENING_STALE_MS) existing = await recover(deps, target, existing);
  if (existing !== undefined) {
    if (existing.state === "opening") return { selection: need.selection, state: "opening", replayed: true };
    if (existing.state === "open" || existing.state === "merged") {
      // The same proposal is made once. A different shape for the same file waits for the open one (a merged file is read again by setup).
      return existing.digest === need.digest ? { selection: need.selection, state: existing.state, ...(existing.number === undefined ? {} : { number: existing.number }), ...(existing.url === undefined ? {} : { url: existing.url }), replayed: true } : { selection: need.selection, state: "skipped", failure: "another_shape" };
    }
    // A closed pull request is a "no" to THIS wrapper; a different wrapper (the eval changed) may be proposed.
    if (existing.state === "closed" && existing.digest === need.digest) return { selection: need.selection, state: "closed", replayed: true, ...(existing.number === undefined ? {} : { number: existing.number }) };
    if (existing.state === "failed" && existing.digest === need.digest && input.retry !== true) return { selection: need.selection, state: "failed", ...(existing.failure === undefined ? {} : { failure: existing.failure }), replayed: true };
  }

  const verified = await verifyRepository(target);
  if (!verified.ok) return { selection: need.selection, state: "failed", failure: "unreachable" };
  const baseBranch = verified.identity.defaultBranch;
  const baseHead = await headOf(target, baseBranch);
  if (baseHead === undefined) return { selection: need.selection, state: "failed", failure: "unreachable" };
  // Never over a file: anything at the wrapper's path (a file, a folder, a link) is left exactly as it is.
  if (host.pathKind === undefined) return { selection: need.selection, state: "failed", failure: "host_cannot" };
  let kind: Awaited<ReturnType<NonNullable<typeof host.pathKind>>>;
  try { kind = await target.host.pathKind!(target.repository, need.file.path, baseHead, target.scope); } catch { return { selection: need.selection, state: "failed", failure: "unreachable" }; }
  if (kind !== "none") return { selection: need.selection, state: "failed", failure: "file_exists" };
  const branch = await freshBranch(deps, target);
  if (branch === undefined) return { selection: need.selection, state: "failed", failure: "conflict" };

  // Audited BEFORE any write; a failed audit is no write at all.
  try { await deps.audit({ action: input.retry === true ? "eval_wrapper.retry" : "eval_wrapper.proposed", project, details: { repository: raw.name.slice(0, 200), language: need.language, digest: need.digest.slice(0, 16), taskId: input.taskId.slice(0, 160) } }); } catch { return { selection: need.selection, state: "failed", failure: "audit" }; }

  const at = isoOf(deps);
  const claim: EvalWrapperRecord = {
    entityType: "EVAL_WRAPPER", schemaVersion: 1, company: deps.companyId, project, id, language: need.language, repository: raw.name, place: raw.place, selection: need.selection, digest: need.digest,
    state: "opening", branch, baseBranch, taskId: input.taskId, by: input.by, openedAt: at, updatedAt: at,
  };
  const key = keyOf(deps.companyId, project, id);
  // The claim: new, or in place of the record this call read (failed or a different closed proposal). Two calls cannot both hold it.
  const claimed = existing === undefined
    ? await deps.store.put({ item: { ...key, ...claim } as unknown as StoredDocument, condition: when.absent() })
    : await deps.store.put({ item: { ...key, ...claim } as unknown as StoredDocument, condition: when.and(when.eq("state", existing.state), when.eq("updatedAt", existing.updatedAt)) });
  if (!claimed.applied) return { selection: need.selection, state: "opening", replayed: true };

  let written: { revision: string };
  try {
    written = await target.host.commitFiles!({ repository: target.repository, branch, baseBranch, message: `Add Rovara's eval wrapper (${need.file.path})`, files: [{ path: need.file.path, content: need.file.content }], fromBase: true, baseRevision: baseHead, previous: [{ path: need.file.path, content: null }] }, target.scope);
  } catch (error) {
    await dropBranch(target, branch);
    const text = error instanceof Error ? error.message : "";
    return fail(deps, claim, text.includes(COMMIT_SYMLINK_MESSAGE) ? "file_exists" : text.includes(COMMIT_CONFLICT_MESSAGE) ? "conflict" : "refused");
  }
  let reconciled: Awaited<ReturnType<typeof host.reconcileChangeRequest>>;
  try {
    reconciled = await target.host.reconcileChangeRequest({
      repository: target.repository, sourceBranch: branch, targetBranch: baseBranch, title: prTitle(need.language),
      body: prBody({ language: need.language, selection: need.selection, custom: need.suite.output?.kind === "custom", command: commandText(need.suite.command), results: need.suite.report.cwd === "." ? need.suite.report.argument : `${need.suite.report.cwd}/${need.suite.report.argument}`, path: need.file.path }),
    }, target.scope);
  } catch {
    await dropBranch(target, branch);
    return fail(deps, claim, "refused");
  }
  const opened = await deps.store.update({
    key, ops: [change.set("state", "open"), change.set("number", reconciled.ref.id), change.set("url", reconciled.ref.url), change.set("headRevision", written.revision), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "opening"),
  });
  if (!opened.applied) deps.log?.("eval_wrapper.open_write", { project });
  return { selection: need.selection, state: "open", number: reconciled.ref.id, url: reconciled.ref.url };
}

/**
 * Reads where each OPEN proposal stands at the host (merged, closed, still open) and keeps it. Bounded (at most 4 reads). A read that fails or a pull request that is not Rovara's own changes nothing. Never throws.
 * A merged proposal tells setup to read the eval again; a closed one is a "no".
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
        const read = await readOwnPr(target, record.number!, record.branch!, record.headRevision);
        const key = keyOf(deps.companyId, project, record.id);
        if (read.kind === "gone") { await deps.store.update({ key, ops: [change.set("state", "closed"), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "open") }); continue; }
        if (read.ours !== true) continue;
        const state = read.details.state === "merged" ? "merged" : read.details.state === "closed" ? "closed" : undefined;
        if (state !== undefined) await deps.store.update({ key, ops: [change.set("state", state), change.set("updatedAt", isoOf(deps))], condition: when.eq("state", "open") });
      } catch { /* tried again at the next read */ }
    }
  } catch { /* the card reads the rows as they are */ }
}

/** What the setup card says of one proposal. Fixed words; the pull request number and address are the host's. */
export interface EvalWrapperView {
  repository: string;
  language: EvalWrapperLanguage;
  state: EvalWrapperRecord["state"];
  /** The one line the card shows: "Rovara proposed a small file so it can read your eval results: review PR #12". */
  line: string;
  number?: string;
  url?: string;
  /** The pull request is merged: setup should read the eval again. */
  rediscover?: boolean;
}

export function evalWrapperLine(row: Pick<EvalWrapperRecord, "state" | "number" | "failure">): string {
  const pr = row.number === undefined ? "the pull request" : `PR #${row.number}`;
  switch (row.state) {
    case "open": return `Rovara proposed a small file so it can read your eval results: review ${pr}`;
    case "merged": return `${pr} is merged. Set up again so Rovara reads your eval through it.`;
    case "closed": return `${pr} was closed without merging. Rovara will not propose it again unless your eval changes.`;
    case "opening": return "Rovara is proposing a small file so it can read your eval results.";
    case "failed": return row.failure === undefined ? "Rovara could not propose the file it needs to read your eval results." : EVAL_WRAPPER_FAILURE_WORDS[row.failure];
  }
}

/** The proposals of a project as the card shows them. */
export async function readEvalWrapperViews(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<EvalWrapperView[]> {
  return (await listEvalWrappers(deps, project)).map((row) => ({
    repository: row.repository, language: row.language, state: row.state, line: evalWrapperLine(row),
    ...(row.number === undefined ? {} : { number: row.number }), ...(row.url === undefined || !row.url.startsWith("https://") ? {} : { url: row.url }),
    ...(row.state === "merged" ? { rediscover: true } : {}),
  }));
}
