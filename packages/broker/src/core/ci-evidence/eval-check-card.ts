// L4-EVCI2: the setup card's "Eval check from your CI", the same on the hosted core and on a laptop (the two route files only decide who the caller is and which audit sink records the act).
//
//   READ    the confirmed check (if any) for everyone with a role on the project; for the people who MANAGE the setup also the proposals, read now from the repositories' workflow files (`proposeEvalChecks`: data, never run,
//           no model).
//   CONFIRM a strict body `{ requestId, check }`: `check` is one of the proposals just read (matched by name AND reporting app), or `null` for none. A check Rovara did not just propose is refused, and so is a confirm
//           when the workflow files cannot be read right now (a name is never taken on the person's word or the browser's). `null` always works: a person can always turn it off.
//   Who      the setup rule, decided by the route (a company owner or admin, or the project's administrator); this file never sees a role it was not handed as `canManage`.
//   Audit    the record naming the person and why they were allowed is written BEFORE the row: nothing changes when it cannot be written. The same request id with the same choice is one act.
//   Words    fixed; nothing a caller wrote is echoed. Of a repository only a proposed check's name, its workflow file's path and the repository's name are returned (to a manager, as the list to pick from), each bounded; Cloud refuses a control character in any of them.
import { EvalCheckSchema, agentXError, type CodeHost, type EvalCheck, type HostScope, type PluginKind } from "@agentx/contracts";
import { z } from "zod";
import type { CiDefinitionReader } from "../../rovara-code/ci-checks.js";
import { CI_READ_REPOSITORIES_MAX, CI_READ_TIMEOUT_MS } from "../plan/ci.js";
import { EVAL_PROPOSALS_MAX, proposeEvalChecks } from "./eval-check-proposal.js";
import { readEvalCheckSetting, writeEvalCheckSetting, type EvalCheckStoreDeps } from "./eval-check-setting.js";

export const EVAL_CHECK_WORDS = {
  notAllowed: "Only company owners and admins, or this project's admins, can choose the eval check.",
  projectNotFound: "project not found",
  unreadable: "The eval check could not be read just now. Try again.",
  auditUnavailable: "The record of this change could not be written, so nothing was done. Try again.",
  notProposed: "That is not a check Rovara found in your workflow files. Open the setup again to see the list.",
  cannotRead: "Rovara could not read your workflow files just now, so it cannot confirm a check. Try again.",
  invalid: "the request is not valid",
  /** The card's one line, shown beside the row. */
  explanation: "Rovara shows this check's result on its pull requests.",
} as const;

/** The strict body of a confirm: the request id (one act per id and choice) and the check, or `null` for none. */
export const EvalCheckSetBodySchema = z.object({ requestId: z.string().uuid(), check: EvalCheckSchema.nullable() }).strict();
export type EvalCheckSetBody = z.infer<typeof EvalCheckSetBodySchema>;

export interface EvalCheckCardProposal { name: string; source?: string; workflow: string; repository: string; basis: "name" | "commands" }
export interface EvalCheckProposalsView { verdict: "proposals" | "none_found" | "unknown"; items: EvalCheckCardProposal[]; cut: boolean }
export interface EvalCheckView {
  project: string;
  canManage: boolean;
  /** The confirmed check, with when it was confirmed. Null: none chosen. */
  confirmed: { name: string; source?: string; changedAt: string } | null;
  /** What setup read from the workflow files (managers only; null for a reader). */
  proposals: EvalCheckProposalsView | null;
  explanation: typeof EVAL_CHECK_WORDS.explanation;
}

export interface EvalCheckRepository { name: string; url: string; defaultBranch: string; host?: { kind: PluginKind } | undefined }
export interface EvalCheckCardDeps extends EvalCheckStoreDeps {
  now: () => number;
  /** A read-only view of a repository's workflow files on its default branch, or undefined when this install's code host cannot give one. */
  readerFor(repository: EvalCheckRepository): Promise<CiDefinitionReader | undefined>;
}

/** A repository's workflow-file reader from a code host: the head of its default branch, listed and read at that one commit. Throws when the host cannot answer (the card then says it could not read). */
export async function ciDefinitionReaderOf(host: Pick<CodeHost, "baseBranchHead" | "fileAtRevision"> & Partial<Pick<CodeHost, "directoryEntries">>, repository: { url: string; defaultBranch: string }, scope: HostScope): Promise<CiDefinitionReader | undefined> {
  if (host.directoryEntries === undefined) return undefined;
  const list = host.directoryEntries.bind(host);
  const ref = { url: repository.url };
  const commit = await host.baseBranchHead(ref, repository.defaultBranch, scope);
  return {
    async list(path) {
      const read = await list(ref, path, commit, scope);
      return { entries: read.entries.map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, type: entry.kind })), truncated: !read.complete };
    },
    async read(path, maxBytes) {
      const text = await host.fileAtRevision(ref, path, commit, scope, { maxBytes, timeoutMs: CI_READ_TIMEOUT_MS });
      return text === undefined ? undefined : { text };
    },
  };
}

const sameCheck = (left: { name: string; source?: string | undefined }, right: { name: string; source?: string | undefined }): boolean => left.name === right.name && (left.source ?? "") === (right.source ?? "");

/**
 * The proposals of a project's repositories (at most the first few, inside one deadline). A name proposed in two repositories is offered once. What was proposed is offered even when another repository could not be read (the person
 * picks from what Rovara saw); with nothing proposed the answer is "none_found" only when EVERY repository was read: a repository that could not be read is never taken as "no eval".
 */
export async function gatherEvalProposals(deps: Pick<EvalCheckCardDeps, "readerFor">, repositories: readonly EvalCheckRepository[]): Promise<EvalCheckProposalsView> {
  const targets = repositories.slice(0, CI_READ_REPOSITORIES_MAX);
  if (targets.length === 0) return { verdict: "unknown", items: [], cut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unknown = { verdict: "unknown" as const, items: [], cut: false };
  try {
    const reading = Promise.all(targets.map(async (repository) => {
      try {
        const reader = await deps.readerFor(repository);
        return { repository, answer: reader === undefined ? ({ verdict: "unknown" } as const) : await proposeEvalChecks(reader) };
      } catch {
        return { repository, answer: { verdict: "unknown" } as const };
      }
    }));
    const read = await Promise.race([reading, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), CI_READ_TIMEOUT_MS); })]);
    if (read === undefined) return unknown;
    const items: EvalCheckCardProposal[] = [];
    let cut = false;
    for (const { repository, answer } of read) {
      if (answer.verdict !== "proposals") continue;
      cut ||= answer.cut;
      for (const proposal of answer.proposals) {
        if (items.some((item) => sameCheck(item, proposal.check))) continue;
        items.push({ name: proposal.check.name, ...(proposal.check.source === undefined ? {} : { source: proposal.check.source }), workflow: proposal.workflow, repository: repository.name, basis: proposal.basis });
      }
    }
    if (items.length > 0) return { verdict: "proposals", items: items.slice(0, EVAL_PROPOSALS_MAX), cut: cut || items.length > EVAL_PROPOSALS_MAX };
    return read.every(({ answer }) => answer.verdict === "none_found") ? { verdict: "none_found", items: [], cut: false } : unknown;
  } catch {
    return unknown;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The card as the caller may see it. `canManage` is the route's live reading of the setup rule. */
export async function evalCheckView(deps: EvalCheckCardDeps, input: { project: string; canManage: boolean; repositories: readonly EvalCheckRepository[] }): Promise<EvalCheckView> {
  let setting: Awaited<ReturnType<typeof readEvalCheckSetting>>;
  try { setting = await readEvalCheckSetting(deps, input.project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", EVAL_CHECK_WORDS.unreadable); }
  return {
    project: input.project, canManage: input.canManage,
    confirmed: setting?.check === undefined ? null : { name: setting.check.name, ...(setting.check.source === undefined ? {} : { source: setting.check.source }), changedAt: setting.changedAt },
    proposals: input.canManage ? await gatherEvalProposals(deps, input.repositories) : null,
    explanation: EVAL_CHECK_WORDS.explanation,
  };
}

export interface EvalCheckAct {
  project: string;
  /** The route's live decision that this person may confirm (a company owner or admin, or the project's administrator). A person who may not never reaches the row. */
  canManage: boolean;
  repositories: readonly EvalCheckRepository[];
  /** The audit record of the act, written before the row. Throws when it cannot be written. */
  record(details: { requestId: string; check: EvalCheck | undefined; previous: EvalCheck | undefined }): Promise<void>;
}

/** Confirms one proposed check, or none. Answers the view. */
export async function setEvalCheck(deps: EvalCheckCardDeps, act: EvalCheckAct, rawBody: unknown): Promise<EvalCheckView> {
  const body = EvalCheckSetBodySchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", EVAL_CHECK_WORDS.invalid);
  if (!act.canManage) throw agentXError("FORBIDDEN", EVAL_CHECK_WORDS.notAllowed);
  const { requestId, check } = body.data;
  let before: Awaited<ReturnType<typeof readEvalCheckSetting>>;
  try { before = await readEvalCheckSetting(deps, act.project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", EVAL_CHECK_WORDS.unreadable); }
  if (check !== null) {
    // Only a check Rovara just found in the project's own workflow files: read again now, never taken from the browser's list.
    const proposals = await gatherEvalProposals(deps, act.repositories);
    if (proposals.verdict === "unknown") throw agentXError("RUNTIME_UNAVAILABLE", EVAL_CHECK_WORDS.cannotRead);
    if (!proposals.items.some((item) => sameCheck(item, check))) throw agentXError("CONFIG_INVALID", EVAL_CHECK_WORDS.notProposed);
  }
  const chosen: EvalCheck | undefined = check === null ? undefined : { name: check.name, ...(check.source === undefined ? {} : { source: check.source }) };
  // A repeat of this request (the same id AND the same choice) is one act: nothing more is recorded or written.
  if (before !== undefined && before.requestId === requestId && sameChoice(before.check, chosen)) return evalCheckView(deps, { project: act.project, canManage: true, repositories: act.repositories });
  try { await act.record({ requestId, check: chosen, previous: before?.check }); } catch { throw agentXError("AUDIT_UNAVAILABLE", EVAL_CHECK_WORDS.auditUnavailable); }
  try { await writeEvalCheckSetting(deps, { project: act.project, check: chosen, requestId, now: deps.now() }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", EVAL_CHECK_WORDS.unreadable); }
  return evalCheckView(deps, { project: act.project, canManage: true, repositories: act.repositories });
}

function sameChoice(left: EvalCheck | undefined, right: EvalCheck | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameCheck(left, right);
}

