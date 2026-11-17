// Worker-only, invocation-local classification. No source identity or changed-prompt claim comes from the sandbox.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  detectPromptChanges, matchChangedItems, modelPromptSegments, planRecording, promptFilePath, readModelRequest, PROMPT_CHANGE_LIMITS,
  type ModelEgressFrame, type PromptChangedFile, type PromptChangeReport,
} from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";
import { AI_WALK_LIMITS, CODE_PATH, aiRelatedSet, hasAiMarker, hasDynamicLoad, resolutionFile, walkReads, type AiRelatedSet, type AiWalkLimits } from "./eval-ai-related.js";
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

/** EVAL-TRIGGER-NARROW (owner 2026-11-16, replaces #807's "any changed file holding a quote is unknown"): a changed file counts as a possible
 * prompt change only when it is AI-related (eval-ai-related.ts: SDK/model-call code, its callers and wrappers, prompt files, what they import,
 * the assets they name), when either side of it names an AI SDK or loads code from a computed name, or when it decides how imports resolve
 * (package.json, lockfiles, tsconfig, pyproject, .env). Any such file makes the WHOLE classification unknown, so every call counts as changed.
 * Other changed code and config files still go through F4, whose findings (a named prompt constant, a model name in config) count as well.
 * Anything unresolvable is unknown: an unreadable side or tree file, a non-regular mode, a limit, an import the walk cannot follow. */
const configPath = /\.(?:json|ya?ml|toml|ini)$/iu;
const envPath = /(?:^|\/)(?:\.env[^/]*|env(?:\.[^/]*)?|[^/]*\.env)$/iu;
/** Changed files outside the set that can hold no program text: media, fonts, archives, documentation, styles, repository metadata.
 * Any other file the walk cannot parse (Go, Java, Ruby, .vue, .svelte, .astro, .ipynb, HTML, shell, Dockerfile...) is unknown. */
const INERT = /(?:\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic|svg|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|webm|mov|avi|pdf|zip|gz|tgz|bz2|xz|7z|md|mdx|rst|adoc|txt|csv|tsv|css|scss|sass|less)|(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|CHANGELOG|CODEOWNERS)(?:\.[^/]*)?|(?:^|\/)\.(?:gitignore|gitattributes|gitkeep|editorconfig|dockerignore|prettierignore|npmignore|eslintignore))$/iu;
const textNeeded = (path: string): boolean => CODE_PATH.test(path) || configPath.test(path) || envPath.test(path) || resolutionFile(path);
interface ChangedEntry { path: string; status: "A" | "M" | "D"; oldOid: string | undefined; newOid: string | undefined }
const CAT_FILE_HEADER = /^([a-f0-9]{40}) blob (\d+)$/u;

/** Read complete changed-file sides and the candidate tree from the exact check candidate, never mutable worktree paths or diff drivers.
 * The diff base is the plan's baseCommit, the commit the eval's old side runs: without one, or when a repository's own base
 * differs, the answer is unknown. Never an arbitrary local base. Bounds apply before allocating source text.
 */
export async function candidatePromptChanges(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal,
  planBaseCommit: string | undefined, limits: AiWalkLimits = AI_WALK_LIMITS,
): Promise<PromptChangeReport | undefined> {
  try {
    if (typeof planBaseCommit !== "string" || !objectId.test(planBaseCommit)) return undefined;
    if (repositories.length === 0 || repositories.length > 32 || repositories.length !== candidates.length
      || new Set(repositories.map(r => r.repositoryId)).size !== repositories.length
      || new Set(candidates.map(r => r.repositoryId)).size !== candidates.length) return undefined;
    const files: PromptChangedFile[] = [];
    let changedCount = 0;
    for (const repository of repositories) {
      const candidate = candidates.find(c => c.repositoryId === repository.repositoryId);
      const base = repository.baseCommitSha;
      if (!candidate || !base || !objectId.test(base) || !objectId.test(candidate.treeSha)
        || candidate.baseCommitSha !== base || base !== planBaseCommit || signal.aborted) return undefined;
      const related = await withIsolatedGit(repository.directory, "read", async (git) => {
        const options = { index: "none" as const, signal, timeout: 30_000 };
        const raw = await git.bytes(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
          "--ignore-submodules=none", planBaseCommit, candidate.treeSha, "--"], { ...options, maxBuffer: 4 * 1024 * 1024 });
        const fields = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
        if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("unreadable change");
        const changed: ChangedEntry[] = [];
        for (let i = 0; i < fields.length; i += 2) {
          if (++changedCount > PROMPT_CHANGE_LIMITS.files || signal.aborted) throw new Error("incomplete change");
          const match = /^:(100644|100755|000000) (100644|100755|000000) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/u.exec(fields[i]!);
          const path = fields[i + 1]!;
          if (!match || path.length === 0 || Buffer.byteLength(path) > PROMPT_CHANGE_LIMITS.pathBytes) throw new Error("unreadable change");
          const [, oldMode, newMode, oldOid, newOid, status] = match;
          if ((status === "A" && (oldMode !== "000000" || oldOid !== zeroId))
            || (status === "D" && (newMode !== "000000" || newOid !== zeroId))
            || (status === "M" && (oldMode === "000000" || newMode === "000000"))) throw new Error("unreadable change");
          changed.push({ path, status: status as ChangedEntry["status"], oldOid: oldMode === "000000" ? undefined : oldOid, newOid: newMode === "000000" ? undefined : newOid });
        }
        if (changed.length === 0) return { changed, texts: new Map<string, string>(), set: { known: true, has: () => false } as AiRelatedSet };

        // The whole candidate tree: every path, and the text of every file the walk reads (code, package.json, tsconfig/jsconfig).
        const listing = await git.bytes(["ls-tree", "-r", "-z", "-l", "--full-tree", candidate.treeSha], { ...options, maxBuffer: 64 * 1024 * 1024 });
        const entries = new TextDecoder("utf-8", { fatal: true }).decode(listing).split("\0");
        if (entries.pop() !== "" || entries.length > limits.treeEntries) throw new Error("incomplete tree");
        const paths: string[] = []; const links: string[] = []; const treeOid = new Map<string, string>(); const wanted = new Map<string, number>();
        let wantedBytes = 0;
        for (const entry of entries) {
          const m = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}) +(\d+|-)\t(.+)$/su.exec(entry);
          if (!m) throw new Error("unreadable tree");
          const [, mode, , oid, size, path] = m;
          if (mode === "160000") continue; // a submodule holds no file of this tree
          if (mode === "120000") { links.push(path!); continue; }
          if (mode !== "100644" && mode !== "100755") throw new Error("unreadable tree");
          paths.push(path!); treeOid.set(path!, oid!);
          if (!walkReads(path!)) continue;
          const bytes = Number(size);
          if (!Number.isSafeInteger(bytes) || bytes > limits.fileBytes) throw new Error("incomplete source");
          if (!wanted.has(oid!)) { wanted.set(oid!, bytes); wantedBytes += bytes; }
        }
        for (const entry of changed) if (textNeeded(entry.path)) for (const oid of [entry.oldOid, entry.newOid]) if (oid !== undefined && !wanted.has(oid)) wanted.set(oid, -1);
        if (wanted.size > limits.files + 2 * PROMPT_CHANGE_LIMITS.files || wantedBytes > limits.totalBytes) throw new Error("incomplete source");

        // One batch read. Every object must be a blob of the stated size, valid UTF-8 and free of NUL.
        const texts = new Map<string, string>();
        if (wanted.size > 0) {
          const out = await git.bytes(["cat-file", "--batch"], { ...options, input: [...wanted.keys()].join("\n") + "\n",
            maxBuffer: limits.totalBytes + (2 * PROMPT_CHANGE_LIMITS.files + 1) * PROMPT_CHANGE_LIMITS.fileBytes + wanted.size * 64 });
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let at = 0; let changedBytes = 0;
          for (const [oid, expected] of wanted) {
            const newline = out.indexOf(10, at);
            const header = CAT_FILE_HEADER.exec(newline < 0 ? "" : out.subarray(at, newline).toString("latin1"));
            if (!header || header[1] !== oid) throw new Error("unreadable source");
            const size = Number(header[2]);
            if (!Number.isSafeInteger(size) || size > PROMPT_CHANGE_LIMITS.fileBytes || (expected >= 0 && size !== expected)) throw new Error("incomplete source");
            if (expected < 0 && (changedBytes += size) > PROMPT_CHANGE_LIMITS.totalBytes) throw new Error("incomplete source");
            const body = out.subarray(newline + 1, newline + 1 + size);
            if (body.length !== size || out[newline + 1 + size] !== 10 || body.includes(0)) throw new Error("unreadable source");
            texts.set(oid, decoder.decode(body));
            at = newline + 2 + size;
          }
          if (at !== out.length) throw new Error("unreadable source");
        }
        const text = new Map<string, string>();
        for (const [path, oid] of treeOid) if (walkReads(path)) text.set(path, texts.get(oid)!);
        const removed = changed.filter(c => c.status === "D").map(c => c.path);
        return { changed, texts, set: aiRelatedSet({ paths, removed, text, links }, limits) };
      });
      if (!related.set.known || signal.aborted) return undefined;
      for (const entry of related.changed) {
        const before = entry.oldOid === undefined ? undefined : related.texts.get(entry.oldOid);
        const after = entry.newOid === undefined ? undefined : related.texts.get(entry.newOid);
        if (related.set.has(entry.path) || resolutionFile(entry.path) || promptFilePath(entry.path)) return undefined;
        if (!textNeeded(entry.path)) {
          if (INERT.test(entry.path)) continue; // documentation, images, styles: read by no AI-related file
          return undefined; // source the walk cannot parse
        }
        for (const side of [before, after]) if (side !== undefined && (hasAiMarker(side) || hasDynamicLoad(entry.path, side))) return undefined;
        files.push({ path: entry.path, status: entry.status === "A" ? "added" : entry.status === "D" ? "removed" : "modified", wholeFile: true,
          ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
      }
    }
    // Duplicate repository-relative paths make F4 incomplete, which is conservative too.
    if (signal.aborted) return undefined;
    return detectPromptChanges({ files }).report;
  } catch { return undefined; }
}

/** Keeps concurrent checks/companies isolated. The check's existing deadline also bounds source reads. */
export async function withEvalChangedPromptClassifier<T>(
  repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal,
  /** The eval's own plan. Absent, or unreadable: every call counts as changed. */
  plan: (() => Promise<{ readonly key: { readonly baseCommit: string } } | { readonly notRun: string } | undefined>) | undefined, run: () => Promise<T>,
): Promise<T> {
  let planBase: string | undefined;
  // A plan the broker answered "not run" (questions changed since approval) has no base: no plan, so every call counts as changed.
  try { const answered = plan === undefined ? undefined : await plan(); planBase = answered !== undefined && "key" in answered ? answered.key.baseCommit : undefined; } catch { planBase = undefined; }
  const classifier = changedPromptClassifier(await candidatePromptChanges(repositories, candidates, signal, planBase));
  return classifiers.run(classifier, run);
}
