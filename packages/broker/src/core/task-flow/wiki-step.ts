// Lead 4 A1: the project wiki a task step is given, asked when the step's invocation is built (`TaskFlowDeps.wiki`). The task's own project and task come from the company's own records (the workspace
// record and the task pointer), never from the step's payload; the repositories are the project's revision this task runs on. Only a task step, only a worker that lists the feature, and a slow or failing
// answer is no wiki (the step runs as it would without it). Never throws.
import { WIKI_AGENT_FEATURE, codeRepositoriesOf, type WikiContext } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { workspaceKeys } from "./workspace-location.js";

/** The longest a step's dispatch waits for the wiki: a slow read sends nothing. */
export const WIKI_STEP_DEADLINE_MS = 3_000;

export async function wikiContextForStep(deps: TaskFlowDeps, workspace: WorkspaceRecord, operation: OperationRecord, features: readonly string[]): Promise<WikiContext | undefined> {
  const ask = deps.wiki;
  if (ask === undefined || operation.dispatch.kind !== "task" || !features.includes(WIKI_AGENT_FEATURE)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async (): Promise<WikiContext | undefined> => {
      const taskId = (await deps.store.get((await workspaceKeys({ store: deps.store, companyId: workspace.companyId }, workspace.id)).taskPointerKey()))?.["taskId"];
      if (typeof taskId !== "string" || taskId === "") return undefined;
      const revision = await deps.projects.revision(workspace.projectName, operation.dispatch.projectRevision);
      if (revision === undefined) return undefined;
      const answer = await ask({
        companyId: workspace.companyId, project: workspace.projectName, taskId, operationId: operation.id, workflowMode: operation.workflowMode,
        repositories: codeRepositoriesOf(revision.definition).map((repository) => repository.name),
      });
      return answer.wikiContext;
    };
    return await Promise.race([run(), new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, WIKI_STEP_DEADLINE_MS); timer.unref?.(); })]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
