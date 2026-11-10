// The planner's answer with the checks the task's repositories' CI requires added to its proposed checks (Rovara Code version 2 plan quality; Cloud's `answerWithCiChecks`). A host gives a read-only view
// of a repository's CI definition (`CiDefinitionReader`: a directory's entries and a file's text); the CodeHost port carries file reads but no directory listing, so an install whose host gives no such
// view leaves the plan's checks as the planner proposed them. Never holds a plan up: a repository that cannot be read in time, or a workflow that cannot be understood, adds nothing.
import { withCiChecks } from "@agentx/contracts";
import { readCiChecks, type CiDefinitionReader } from "../../rovara-code/ci-checks.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";

/** The most repositories whose CI is read for one plan, and how long the reading may take: a plan is never held up for it. */
export const CI_READ_REPOSITORIES_MAX = 3;
export const CI_READ_TIMEOUT_MS = 10_000;

export async function answerWithCiChecks(
  deps: Pick<TaskFlowDeps, "ciDefinitionReader">, repositories: ReadonlyArray<{ name: string; path: string; url: string }>, content: string,
): Promise<string> {
  if (deps.ciDefinitionReader === undefined) return content;
  const reader = deps.ciDefinitionReader;
  try {
    const reading = Promise.all(repositories.slice(0, CI_READ_REPOSITORIES_MAX).map(async (repository) => {
      try {
        const view: CiDefinitionReader | undefined = await reader(repository);
        return view === undefined ? [] : await readCiChecks(view, repository.path);
      } catch {
        return [];
      }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = await Promise.race([reading, new Promise<never[][]>((resolve) => { timer = setTimeout(() => resolve([]), CI_READ_TIMEOUT_MS); })]);
    if (timer !== undefined) clearTimeout(timer);
    return withCiChecks(content, found.flat());
  } catch {
    return content;
  }
}
