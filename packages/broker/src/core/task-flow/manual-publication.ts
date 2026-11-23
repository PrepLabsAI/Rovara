// The retired manual open-PR route, on the existing core publication operation and request record.
import { DeveloperPullRequestRequestSchema, codeBuildGatesOf, agentXError, type RepositoryDefinition } from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { CLOSED_TASK, loadTaskAsOwner, parseBody, requireMayStartWork } from "./owner-round.js";
import { fromDocument, type OperationRecord } from "./records.js";
import { acceptStep, readWorkspace } from "./stage-machine.js";
import { newId } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

function selectedRepository(repositories: readonly RepositoryDefinition[], name: string | undefined): RepositoryDefinition {
  if (name === undefined && repositories.length !== 1) throw agentXError("CONFIG_INVALID", "name one of the repositories in this task's pinned project");
  const repository = repositories.find(entry => entry.name === (name ?? repositories[0]?.name));
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  return repository;
}

export async function startManualPublication(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown): Promise<OperationRecord> {
  const request = parseBody(DeveloperPullRequestRequestSchema, value);
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  if (task.workflow !== undefined) throw agentXError("CONFIG_INVALID", "This task opens its own pull request after its checks and reviews pass.");
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const project = await deps.projects.revision(workspace.projectName, workspace.projectRevision);
  const repository = selectedRepository(project?.definition.repositories ?? [], request.repository);
  const location = await workspaceKeys(deps, task.workspaceId);
  const prior = async (): Promise<OperationRecord | undefined> => {
    const record = await deps.store.get(location.operationRequestKey(task.ownerKey, request.requestId));
    if (record === undefined) return undefined;
    const operation = typeof record["operationId"] === "string" ? fromDocument<OperationRecord>(await deps.store.get(location.operationKey(record["operationId"]))) : undefined;
    const expected = operation?.publication;
    if (operation?.kind !== "publish" || expected === undefined || expected.candidateDigest !== undefined || expected.repository !== repository.name || expected.title !== request.title || expected.body !== (request.body ?? "") || expected.draft !== request.draft) throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    return operation;
  };
  const previous = await prior();
  if (previous !== undefined) return previous;
  if (task.closedAt !== undefined || workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  await requireMayStartWork(deps, task);
  const operationId = newId(deps);
  const headBranch = `agentx/${operationId}`;
  const accepted = await acceptStep(deps, {
    task, workspace, operationId, requestId: request.requestId, kind: "publish", prompt: "publish", extraActions: ["pull-request", "codebuild"],
    publication: { repository: repository.name, repositoryUrl: repository.url, headBranch, baseBranch: repository.defaultBranch, title: request.title, body: request.body ?? "", draft: request.draft, codeBuildGates: codeBuildGatesOf(repository) },
    payload: { mode: "create", repository: repository.name, headBranch, title: request.title, body: request.body ?? "", draft: request.draft },
    extra: [...(acting.items ?? []), ...stageAudit(deps, { eventId: `task.pull_request:${taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.pull_request", subject: { type: "task", id: taskId }, details: { repository: repository.name } })],
  });
  if (accepted.result === "STARTED" && accepted.operation !== undefined) return accepted.operation;
  if (accepted.result === "DUPLICATE") { const repeated = await prior(); if (repeated !== undefined) return repeated; }
  throw agentXError("WORKSPACE_BUSY", "the task changed or its workspace is busy; refresh and try again");
}
