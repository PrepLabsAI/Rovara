// A read-only look at a running task's working tree (the hosted product's `agent-sessions/peek-client.ts` and `ask-diff.ts`). It is what an Ask is given of the code while the task's worker is up. The broker sends the
// worker one `peek` invocation through the `worker-machines` port (the adapter signs it for this workspace, one minute) and reads the answer on the same request. The worker reads the repository through its isolated Git (no write,
// no hook, no config of the candidate), redacts what it read and cuts it to fixed sizes. The invocation holds no capability (a fixed filler no route accepts) and no command, path or budget, so a peek gives the worker no power.
// Every failure (no workspace, a machine that is not up, an older worker, a refusal, an answer that does not parse) is `undefined`, and the Ask is built without a diff: a peek is never required, never retried, and never wakes a stopped machine.
import { randomUUID } from "node:crypto";
import { AGENTX_PROTOCOL_VERSION, PEEK_FEATURE, PEEK_NO_CALLBACK_CAPABILITY, PEEK_PATCH_MAX_BYTES, PeekAnswerSchema, WorkerInvocationSchema, type PeekAnswer } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { taskPointerKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { readWorkspace } from "../task-flow/stage-machine.js";
import type { AskContextData } from "./ask-context.js";
import type { AskContextReaders } from "./ask-context-load.js";

export type PeekClient = (taskId: string) => Promise<PeekAnswer | undefined>;

/** A peek that has not answered in this long is given up. */
export const PEEK_TIMEOUT_MS = 12_000;

export function createPeekClient(deps: Pick<TaskFlowDeps, "store" | "machines"> & { newOperationId?: () => string; timeoutMs?: number }): PeekClient {
  return async (taskId) => {
    try {
      const task = await readTask(deps, taskId);
      if (task === undefined) return undefined;
      const workspace = await readWorkspace(deps, task.workspaceId);
      if (workspace === undefined || workspace.machine === undefined || (workspace.status !== "BUSY" && workspace.status !== "READY")) return undefined;
      // Only the workspace that is working for THIS task now: a workspace another task holds is someone else's run, and nothing of it reaches this Ask.
      if ((await deps.store.get(taskPointerKey(workspace.id)))?.["taskId"] !== task.taskId) return undefined;
      // Only a worker that is up and lists the feature: a stopped or starting machine is never woken for an Ask.
      const health = await deps.machines.health(workspace.machine.machineId);
      if ((health.state !== "busy" && health.state !== "ready") || !health.features.includes(PEEK_FEATURE)) return undefined;
      const invocation = WorkerInvocationSchema.safeParse({
        protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "peek", operationId: (deps.newOperationId ?? randomUUID)(), workspaceId: workspace.id, fence: workspace.fence, projectRevision: workspace.projectRevision,
        callbackCapability: PEEK_NO_CALLBACK_CAPABILITY, payload: { maxPatchBytes: PEEK_PATCH_MAX_BYTES },
      });
      if (!invocation.success) return undefined;
      const receipt = await Promise.race([
        deps.machines.deliver(workspace.machine.machineId, invocation.data),
        new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error("timeout")), deps.timeoutMs ?? PEEK_TIMEOUT_MS).unref(); }),
      ]);
      const answer = PeekAnswerSchema.safeParse(receipt.answer);
      return answer.success && answer.data.outcome === "peeked" ? answer.data : undefined;
    } catch {
      return undefined;
    }
  };
}

type Diff = NonNullable<AskContextData["diff"]>;

/** Splits one unified diff into the patch of each file, by its `diff --git a/<path> b/<path>` header. Text before the first header (a repository banner) belongs to no file and is dropped. */
export function splitPatchByFile(patch: string): Array<{ path: string; patch: string }> {
  const out: Array<{ path: string; patch: string }> = [];
  let repository = "";
  let current: { path: string; lines: string[] } | undefined;
  const flush = (): void => { if (current !== undefined) out.push({ path: current.path, patch: current.lines.join("\n") }); current = undefined; };
  for (const line of patch.split("\n")) {
    const banner = /^## repository (.+)$/u.exec(line);
    if (banner !== null) { flush(); repository = banner[1]!; continue; }
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header !== null) { flush(); current = { path: repository === "" ? header[2]! : `${repository}/${header[2]!}`, lines: [line] }; continue; }
    current?.lines.push(line);
  }
  flush();
  return out;
}

/** A peek as the Ask's diff. A path is shown with its repository name only when the workspace has more than one repository. */
export function diffFromPeek(answer: PeekAnswer): Diff {
  const several = new Set([...answer.files, ...answer.untracked].map((file) => file.repository)).size > 1;
  const name = (repository: string, path: string): string => (several ? `${repository}/${path}` : path);
  const files = [
    ...answer.files.map((file) => ({ path: name(file.repository, file.path), additions: file.additions, deletions: file.deletions })),
    ...answer.untracked.map((file) => ({ path: `${name(file.repository, file.path)} (new, not yet tracked)`, additions: 0, deletions: 0 })),
  ];
  // The patch's file headers carry the repository banner only for several repositories; strip the banner when there is one repository so the paths match the file list.
  const patches = splitPatchByFile(several ? answer.patch : answer.patch.replace(/^## repository .+$/gmu, ""));
  return { source: "working_tree", files, ...(patches.length === 0 ? {} : { patches }) };
}

/**
 * The `diff` reader of an Ask: a peek at the working tree, else nothing. (The pull request's own diff as a second source needs a code host that lists a pull request's files with their patches; no code-host port reads those yet,
 * so a task with no worker up gives an Ask no diff.) Which of it an audience may see, and its redaction and size, are decided again in `buildAskContext`.
 */
export function createAskDiffReader(sources: { peek?: PeekClient | undefined }): NonNullable<AskContextReaders["diff"]> {
  return async (task) => {
    const answer = sources.peek === undefined ? undefined : await sources.peek(task.taskId).catch(() => undefined);
    return answer === undefined ? undefined : diffFromPeek(answer);
  };
}
