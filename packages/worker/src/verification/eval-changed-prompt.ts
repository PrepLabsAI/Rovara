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

/** Read complete changed-file sides from the exact check candidate, never mutable worktree paths or diff drivers.
 * No rename inference is needed: a rename is a removal plus addition, both scanned by F4. Any missing coverage
 * makes the WHOLE classification unknown. Bounds match F4 and apply before allocating source text.
 */
export async function candidatePromptChanges(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal,
): Promise<PromptChangeReport | undefined> {
  try {
    if (repositories.length === 0 || repositories.length > 32 || repositories.length !== candidates.length
      || new Set(repositories.map(r => r.repositoryId)).size !== repositories.length
      || new Set(candidates.map(r => r.repositoryId)).size !== candidates.length) return undefined;
    const files: PromptChangedFile[] = [];
    let totalBytes = 0;
    for (const repository of repositories) {
      const candidate = candidates.find(c => c.repositoryId === repository.repositoryId);
      const base = repository.baseCommitSha;
      if (!candidate || !base || !objectId.test(base) || !objectId.test(candidate.treeSha)
        || candidate.baseCommitSha !== base || signal.aborted) return undefined;
      await withIsolatedGit(repository.directory, "read", async (git) => {
        const options = { index: "none" as const, signal, timeout: 30_000 };
        const raw = await git.bytes(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
          "--ignore-submodules=none", base, candidate.treeSha, "--"], { ...options, maxBuffer: 4 * 1024 * 1024 });
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
    return signal.aborted ? undefined : detectPromptChanges({ files }).report;
  } catch { return undefined; }
}

/** Keeps concurrent checks/companies isolated. The check's existing deadline also bounds source reads. */
export async function withEvalChangedPromptClassifier<T>(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal, run: () => Promise<T>,
): Promise<T> {
  const classifier = changedPromptClassifier(await candidatePromptChanges(repositories, candidates, signal));
  return classifiers.run(classifier, run);
}
