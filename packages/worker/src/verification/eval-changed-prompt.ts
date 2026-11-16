// Worker-only, invocation-local classification. No source identity or changed-prompt claim comes from the sandbox.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  detectPromptChanges, matchChangedItems, modelPromptSegments, planRecording, readModelRequest, PROMPT_CHANGE_LIMITS,
  type ModelEgressFrame, type PromptChangedFile, type PromptChangeReport,
} from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";
import type { CandidateRepositoryInput, CandidateRepositoryIdentity } from "./candidate.js";

const classifiers = new AsyncLocalStorage<(frame: ModelEgressFrame) => boolean>();
const objectId = /^[a-f0-9]{40}$/u;
const zeroId = "0".repeat(40);

/** F8's fingerprints identify changed calls. A non-match is unknown, not proof of an unchanged source. */
export function changedPromptClassifier(report: PromptChangeReport | undefined): (frame: ModelEgressFrame) => boolean {
  const plan = planRecording(report);
  return (frame) => {
    try {
      if (plan.status !== "ready" || plan.itemsOmitted) return true;
      const read = readModelRequest(frame);
      if (!read.ok) return true;
      const segments = modelPromptSegments(read.view);
      if (segments.system.length + segments.prompt.length === 0) return true;
      if (matchChangedItems(plan, read.view).length > 0) return true;
      // Only a complete F4 report with NO changes can prove an otherwise readable prompt call unchanged.
      // Settings, removed prompts, dynamic text, and frames not mapped by F8 remain conservative positives.
      return report?.status !== "none_found" || report.items.length !== 0;
    } catch { return true; }
  };
}

/** The producer used by EvalHostSources.changedPrompt when the host has not supplied its own worker classifier. */
export function evalChangedPrompt(frame: ModelEgressFrame): boolean {
  try { return classifiers.getStore()?.(frame) ?? true; } catch { return true; }
}

/** A prompt can be loaded at run time from a file F4 cannot classify (assets/persona.txt) or sit in a plain string constant of a module with
 * no AI import. F4 reports nothing for those, which is "not found", never "unchanged". So a changed file that F4 gave no item for is
 * unknown (the whole classification becomes unknown) unless it is code whose quote-bearing text did not change. Best effort and deliberately
 * over-counting: a changed line that holds a quote or backtick (outside an import/require specifier), or that sits inside a multi-line
 * template literal or triple-quoted string, is a possible prompt change. Lines are compared as a multiset, so no tokenizer can be
 * desynchronised by a stray quote, and every step is one linear pass (no backtracking over the file). */
const codePath = /\.(?:[cm]?[jt]sx?|py|pyi)$/iu;
const moduleSpecifier = /(?:\bfrom|\bimport|\brequire\s*\()\s*(['"])[^'"\n]*\1/gu;
function quoteBearingLines(text: string | undefined): Map<string, number> {
  const found = new Map<string, number>();
  if (text === undefined) return found;
  let inside = false;
  for (const line of text.split("\n")) {
    let ticks = 0;
    for (let i = line.indexOf("`"); i !== -1; i = line.indexOf("`", i + 1)) if (line[i - 1] !== "\\") ticks++;
    const triples = line.split('"""').length + line.split("'''").length - 2;
    const quoted = /["'`]/u.test(line.replace(moduleSpecifier, ""));
    if (inside || quoted || ticks > 0 || triples > 0) found.set(line, (found.get(line) ?? 0) + 1);
    if ((ticks + triples) % 2 === 1) inside = !inside;
  }
  return found;
}
function everyChangeAccountedFor(files: readonly PromptChangedFile[], report: PromptChangeReport): boolean {
  const found = new Set<string>();
  for (const item of report.items) { found.add(item.path); if (item.oldPath !== undefined) found.add(item.oldPath); }
  for (const file of files) {
    if (found.has(file.path) || file.before === file.after) continue;
    if (!codePath.test(file.path)) return false;
    const before = quoteBearingLines(file.before); const after = quoteBearingLines(file.after);
    if (before.size !== after.size) return false;
    for (const [line, count] of before) if (after.get(line) !== count) return false;
  }
  return true;
}

/** Read complete changed-file sides from the exact check candidate, never mutable worktree paths or diff drivers.
 * The diff base is the plan's baseCommit, the commit the eval's old side runs: without one, or when a repository's own base
 * differs, the answer is unknown. Never an arbitrary local base.
 * No rename inference is needed: a rename is a removal plus addition, both scanned by F4. Any missing coverage
 * makes the WHOLE classification unknown. Bounds match F4 and apply before allocating source text.
 */
export async function candidatePromptChanges(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal,
  planBaseCommit: string | undefined,
): Promise<PromptChangeReport | undefined> {
  try {
    if (typeof planBaseCommit !== "string" || !objectId.test(planBaseCommit)) return undefined;
    if (repositories.length === 0 || repositories.length > 32 || repositories.length !== candidates.length
      || new Set(repositories.map(r => r.repositoryId)).size !== repositories.length
      || new Set(candidates.map(r => r.repositoryId)).size !== candidates.length) return undefined;
    const files: PromptChangedFile[] = [];
    let totalBytes = 0;
    for (const repository of repositories) {
      const candidate = candidates.find(c => c.repositoryId === repository.repositoryId);
      const base = repository.baseCommitSha;
      if (!candidate || !base || !objectId.test(base) || !objectId.test(candidate.treeSha)
        || candidate.baseCommitSha !== base || base !== planBaseCommit || signal.aborted) return undefined;
      await withIsolatedGit(repository.directory, "read", async (git) => {
        const options = { index: "none" as const, signal, timeout: 30_000 };
        const raw = await git.bytes(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
          "--ignore-submodules=none", planBaseCommit, candidate.treeSha, "--"], { ...options, maxBuffer: 4 * 1024 * 1024 });
        const fields = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
        if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("unreadable change");
        for (let i = 0; i < fields.length; i += 2) {
          if (files.length >= PROMPT_CHANGE_LIMITS.files || signal.aborted) throw new Error("incomplete change");
          const match = /^:(100644|100755|000000) (100644|100755|000000) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/u.exec(fields[i]!);
          const path = fields[i + 1]!;
          if (!match || path.length === 0 || Buffer.byteLength(path) > PROMPT_CHANGE_LIMITS.pathBytes) throw new Error("unreadable change");
          const [, oldMode, newMode, oldOid, newOid, status] = match;
          if ((status === "A" && (oldMode !== "000000" || oldOid !== zeroId))
            || (status === "D" && (newMode !== "000000" || newOid !== zeroId))) throw new Error("unreadable change");
          const side = async (mode: string, oid: string): Promise<string | undefined> => {
            if (mode === "000000") return undefined;
            const size = Number((await git.text(["cat-file", "-s", oid], options)).trim());
            if (!Number.isSafeInteger(size) || size < 0 || size > PROMPT_CHANGE_LIMITS.fileBytes) throw new Error("incomplete source");
            totalBytes += size;
            if (totalBytes > PROMPT_CHANGE_LIMITS.totalBytes) throw new Error("incomplete source");
            const bytes = await git.bytes(["cat-file", "blob", oid], { ...options, maxBuffer: PROMPT_CHANGE_LIMITS.fileBytes + 1 });
            if (bytes.length !== size || bytes.includes(0)) throw new Error("unreadable source");
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          };
          const before = await side(oldMode!, oldOid!); const after = await side(newMode!, newOid!);
          files.push({ path, status: status === "A" ? "added" : status === "D" ? "removed" : "modified", wholeFile: true,
            ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
        }
      });
    }
    // Duplicate repository-relative paths make F4 incomplete, which is conservative too.
    if (signal.aborted) return undefined;
    const { report } = detectPromptChanges({ files });
    return everyChangeAccountedFor(files, report) ? report : undefined;
  } catch { return undefined; }
}

/** Keeps concurrent checks/companies isolated. The check's existing deadline also bounds source reads. */
export async function withEvalChangedPromptClassifier<T>(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal,
  /** The eval's own plan. Absent, or unreadable: every call counts as changed. */
  plan: (() => Promise<{ readonly key: { readonly baseCommit: string } } | undefined>) | undefined, run: () => Promise<T>,
): Promise<T> {
  let planBase: string | undefined;
  try { planBase = plan === undefined ? undefined : (await plan())?.key.baseCommit; } catch { planBase = undefined; }
  const classifier = changedPromptClassifier(await candidatePromptChanges(repositories, candidates, signal, planBase));
  return classifiers.run(classifier, run);
}
