// BROWSER-SKIP-HONESTY: a project whose owner put a browser evidence recipe in the config asked for before and after pictures. On a machine that cannot take them (no executor image, or the image is not here, or the pinned profile does not verify) nothing is
// asked of the worker, and the pull request used to say nothing at all. It now says the pictures were not taken, in the words every surface uses.
import { BROWSER_RUNNER_WORDS, type BrowserEvidenceRecipe } from "@agentx/contracts";
import type { TaskRecord } from "../../core/task-flow/records.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import type { LocalBrowserEvidence } from "./browser-evidence-settings.js";

/**
 * The pull request's browser evidence lines: the pack's own lines when there are any; else, for a project with a recipe on a machine that cannot run browser evidence, the one sentence that says it did not run.
 * `canRun` is asked only when needed and a failure to answer reads as "cannot run".
 */
export async function browserEvidenceLinesWithSkip(input: { existing: readonly string[]; recipeConfigured: boolean; canRun: (() => Promise<boolean>) | undefined }): Promise<readonly string[]> {
  if (input.existing.length > 0 || !input.recipeConfigured) return input.existing;
  const can = input.canRun === undefined ? false : await input.canRun().catch(() => false);
  return can ? input.existing : [BROWSER_RUNNER_WORDS.evidenceNotRun];
}

/**
 * The flow's browser evidence seam on a laptop. With a way to run it: the recipe is asked for only when the worker can take it (a worker without the executor image would be refused the step), and the pull request's lines are
 * the pack's, or the one sentence that it did not run. With no way at all (no executor image) but a recipe in the owner's config: nothing is asked of a worker, and the lines say it did not run. Nothing configured: no seam.
 */
export function localBrowserEvidenceDeps(input: { page: Pick<LocalBrowserEvidence, "recipeFor"> | undefined; canRun: (() => Promise<boolean>) | undefined;
  fromConfig: ((project: string) => BrowserEvidenceRecipe | undefined) | undefined; linesOf: (task: TaskRecord, digest: string) => Promise<readonly string[]> }): TaskFlowDeps["browserEvidence"] | undefined {
  const { page, canRun, fromConfig } = input;
  const configured = async (project: string): Promise<boolean> => fromConfig?.(project) !== undefined || (page !== undefined && await page.recipeFor(project).then((recipe) => recipe !== undefined, () => false));
  if (page !== undefined && canRun !== undefined) {
    return {
      recipe: async (task: TaskRecord) => ((await canRun().catch(() => false)) ? page.recipeFor(task.project) : undefined),
      linesOf: async (task: TaskRecord, digest: string) => browserEvidenceLinesWithSkip({ existing: await input.linesOf(task, digest), recipeConfigured: await configured(task.project), canRun }),
    };
  }
  if (fromConfig === undefined) return undefined;
  return { recipe: async () => undefined, linesOf: async (task: TaskRecord) => browserEvidenceLinesWithSkip({ existing: [], recipeConfigured: await configured(task.project), canRun: undefined }) };
}
