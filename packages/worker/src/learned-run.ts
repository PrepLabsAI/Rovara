// Learning v2 (L4): the worker's one call for a stage's lessons. `prepareLearnedContext` turns the invocation's `learnedContext` into the prompt block and the load report, or into nothing:
//   - no `learnedContext`, a payload that does not parse, or one for another stage: no block, no report (the stage runs as it would without memory);
//   - each lesson's code citations are re-read at the task's BASE commit from the verified objects (never the working tree, never a file the agent wrote), and a lesson whose citation is stale,
//     or could not be checked, is left out (see learned-context.ts);
//   - the block is labelled, delimited advice (`renderLearnedBlock`); it grants no tool and no permission, and says so.
// A read that cannot be verified is "not checked", never "stale": a broken object store must not push a good lesson toward retirement.
import type { LessonStage, LoadReport } from "@agentx/contracts";
import { openBaseCommitSource, type KnowledgeFileSource } from "./knowledge/source.js";
import { learnedContextSection, type BaseFile, type BaseFileReader } from "./learned-context.js";

/** The workflow modes whose stage may carry lessons (the same five the broker sends for). */
const STAGES: Readonly<Record<string, LessonStage>> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", PLAN_CRITIQUE: "PLAN_CRITIQUE", REVIEW: "REVIEW" };
export const lessonStageOfMode = (mode: string | undefined): LessonStage | undefined => (mode === undefined || !Object.hasOwn(STAGES, mode) ? undefined : STAGES[mode]);

/** A file's size limit for a citation check; a larger file is "not checked". */
const FILE_LIMIT_BYTES = 1024 * 1024;
/** What a file that could not be read or verified looks like to the check: its anchor cannot be searched, so the citation is "not checked" and the lesson is left out. */
const UNCHECKED: BaseFile = { lineCount: Number.MAX_SAFE_INTEGER, lines: undefined };

export interface LearnedRepository { repositoryId: string; directory: string; baseCommitSha?: string | undefined }

/** Reads files of the task's repositories at their base commits. Opens a repository's verified objects on first use; `close` releases them. */
export function createBaseFileReader(repositories: readonly LearnedRepository[], open: typeof openBaseCommitSource = openBaseCommitSource): { read: BaseFileReader; close(): Promise<void> } {
  const sources = new Map<string, Promise<KnowledgeFileSource | undefined>>();
  const sourceOf = (repo: string): Promise<KnowledgeFileSource | undefined> => {
    let pending = sources.get(repo);
    if (pending === undefined) {
      const entry = repositories.find((candidate) => candidate.repositoryId === repo);
      pending = entry?.baseCommitSha === undefined ? Promise.resolve(undefined) : open(entry.directory, entry.baseCommitSha, "base").catch(() => undefined);
      sources.set(repo, pending);
    }
    return pending;
  };
  return {
    async read(repo, path) {
      const source = await sourceOf(repo);
      // No base commit, or objects that do not verify: not checked (never "the file is gone").
      if (source === undefined) return UNCHECKED;
      try {
        const file = await source.readFile(path, FILE_LIMIT_BYTES);
        if (file.kind === "missing") return undefined;
        if (file.kind !== "file") return UNCHECKED;
        const lines = file.content.split("\n").map((line) => line.replace(/\r$/u, ""));
        return { lineCount: lines.length, lines };
      } catch { return UNCHECKED; }
    },
    async close() {
      for (const pending of sources.values()) await (await pending)?.close().catch(() => undefined);
    },
  };
}

export interface PreparedLearning { section: string; report?: LoadReport }

export async function prepareLearnedContext(input: { raw: unknown; mode: string | undefined; repositories: readonly LearnedRepository[]; deadlineMs?: number; open?: typeof openBaseCommitSource }): Promise<PreparedLearning> {
  const stage = lessonStageOfMode(input.mode);
  if (input.raw === undefined || stage === undefined) return { section: "" };
  const reader = createBaseFileReader(input.repositories, input.open);
  try {
    return await learnedContextSection(input.raw, reader.read, stage, input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs });
  } catch {
    return { section: "" };
  } finally {
    await reader.close();
  }
}

/** The prompt with the lessons block in front of it ("after the How we work section, before the task"). Nothing to add leaves the prompt byte for byte as it was. */
export const withLearnedBlock = (prompt: string, section: string): string => (section === "" ? prompt : `${section}\n\n${prompt}`);
