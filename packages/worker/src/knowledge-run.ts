// Lead 4 L4-AK2: the worker's call for a step's knowledge briefing. `createKnowledgeStep` turns the invocation's `knowledgeContext` into the step's record and tools; `step.arm(lessons)` gives
//   - the prompt block (`<<team-knowledge>>`: lessons, facts, skill names, the "more" line), or "" when there is nothing beyond the plain lessons block (that block is then left exactly as it was), and
//   - the step's own record and tools (`KnowledgeStep`): `knowledge_for` and `knowledge_report` in the stages that may look up, and the use report the run sends to the broker.
// Absent or invalid `knowledgeContext`, or one for another stage: no block, no tools, no report (the step runs with the lessons block alone, as before this lane).
import { isAbsolute, relative, resolve, sep } from "node:path";
import { KNOWLEDGE_USE_REPORT_FIELD, type KnowledgeUseReport, type LessonStage } from "@agentx/contracts";
import { validateKnowledgeContext, type LocatedPath } from "./knowledge-context.js";
import { KnowledgeStep } from "./knowledge-tools.js";
import { lessonStageOfMode, type LearnedRepository } from "./learned-run.js";

export { KNOWLEDGE_USE_REPORT_FIELD };

/** Maps a path from a tool call or a query (workspace-relative, absolute under the workspace, or already repository-relative) to its repository and repository-relative path. A trailing `/` (a folder) is kept. */
export function locatorOf(rootPath: string, repositories: readonly LearnedRepository[]): (raw: string) => LocatedPath | undefined {
  const root = resolve(rootPath);
  return (raw) => {
    const folder = raw.endsWith("/");
    let path = raw.replace(/^\.\//u, "");
    if (isAbsolute(path)) {
      const inner = relative(root, resolve(path));
      if (inner === "" || inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return undefined;
      path = inner.split(sep).join("/");
    }
    if (path === "" || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part === ".." )) return undefined;
    let best: { repo: LearnedRepository; rel: string } | undefined;
    for (const repo of repositories) {
      const prefix = relative(root, repo.directory).split(sep).join("/");
      const rel = prefix === "" ? path : path === prefix ? "" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
      if (rel !== undefined && (best === undefined || prefix.length > relative(root, best.repo.directory).length)) best = { repo, rel };
    }
    const shown = (text: string): string => (folder && text !== "" && !text.endsWith("/") ? `${text}/` : text);
    if (best !== undefined) return { repo: best.repo.repositoryId, path: best.rel === "" ? "" : shown(best.rel) };
    // Not under a known repository: taken as repository-relative to whichever repository the unit names (a single-repository project writes plain paths).
    return { path: shown(path) };
  };
}

/**
 * The step's knowledge record and tools, or undefined (no `knowledgeContext`, a stage that carries none, or a payload that is not valid for this stage). Built BEFORE the model session opens, because the session's
 * tool list is fixed when it opens; the lessons that survive the base-commit check are given to `step.arm` afterwards, which returns the prompt block ("" when the plain lessons block stands).
 */
export function createKnowledgeStep(input: {
  raw: unknown;
  mode: string | undefined;
  rootPath: string;
  repositories: readonly LearnedRepository[];
  onReport?: ((report: KnowledgeUseReport) => void) | undefined;
}): KnowledgeStep | undefined {
  const stage: LessonStage | undefined = lessonStageOfMode(input.mode);
  if (input.raw === undefined || stage === undefined) return undefined;
  try {
    const context = validateKnowledgeContext(input.raw, stage);
    if (context === undefined) return undefined;
    return new KnowledgeStep({ stage, context, locate: locatorOf(input.rootPath, input.repositories), ...(input.onReport === undefined ? {} : { onReport: input.onReport }) });
  } catch {
    return undefined;
  }
}
