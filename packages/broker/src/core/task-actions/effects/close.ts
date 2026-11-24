// S1: closing a task, as a registry effect. Irreversible, so it always carries a confirm (danger style) that says what closes, the unpublished work the close preview found in each repository, that the open pull request stays on
// GitHub and that the evidence is kept; the preview's own digest is bound into the confirm digest, so a close made on a preview that changed (more work was written meanwhile) is refused `stale` before anything is written.
// Discarding unpublished work is a choice, off unless the person makes it. The move is the engine's own (`closeTask`), guarded by the preview digest where the host can inspect a workspace.
import type { ActionBinding, ActionValues, ConfirmLines, TaskActionRisk } from "@agentx/contracts";
import { closeTask } from "../../task-flow/close.js";
import { previewTaskClose } from "../../task-flow/close-inspection.js";
import type { TaskRecord } from "../../task-flow/records.js";
import type { ActionEnv, ActionCaller, Description, PressContext, Performed } from "../types.js";
import { inert, textOf } from "./values.js";
import { taskIsOpen } from "./moves.js";

export const closeWhen = (task: TaskRecord): ActionBinding | undefined => (taskIsOpen(task) ? { revision: task.workflow?.revision ?? 0 } : undefined);
export const closeRisk = (): TaskActionRisk => "irreversible";

const REASON_WORDS: Record<string, string> = { worktree_changes: "changes not committed", untracked_files: "new files not committed", unpushed_head: "commits not pushed", unpushed_branch: "a branch not pushed" };

async function previewOf(env: ActionEnv, caller: ActionCaller, task: TaskRecord, discard: boolean) {
  const answer = await previewTaskClose(env.deps, caller, task.taskId, discard ? "discard" : "close").catch(() => undefined);
  return answer?.preview ?? undefined;
}

export async function describeClose(env: ActionEnv, caller: ActionCaller, task: TaskRecord, _binding: ActionBinding, values: ActionValues): Promise<Description> {
  const discard = textOf(values, "discard") === "discard";
  // The plain preview says whether there is unpublished work at all; the discard choice is shown only then.
  const plain = await previewOf(env, caller, task, false);
  const shown = discard ? (await previewOf(env, caller, task, true)) ?? plain : plain;
  const unpublished = plain?.unpublished ?? [];
  const spec = { fields: unpublished.length === 0 ? [] : [{
    kind: "choice" as const, id: "discard", label: "Unpublished work in this task's workspace", required: true,
    options: [{ value: "discard", label: "Discard it and close" }],
  }] };
  const lines = [
    "Closing stops this task and releases its workspace. This cannot be undone.",
    ...unpublished.map((repository) => `Not published in ${inert(repository.repository, 80)}: ${repository.reasons.map((reason) => REASON_WORDS[reason] ?? reason).join(", ")}.`),
    ...(unpublished.length > 0 ? [discard ? "The unpublished work will be discarded." : "Choose to discard the unpublished work to close."] : []),
    "The open pull request stays on GitHub.",
    "The evidence of this task is kept.",
  ];
  const confirm: ConfirmLines = { title: "Close this task", lines, button: "Close task", danger: true };
  return { spec, confirm, bound: { preview: shown?.digest ?? null, discard } };
}

export async function performClose(ctx: PressContext): Promise<Performed> {
  const discard = textOf(ctx.values, "discard") === "discard";
  const preview = await previewOf(ctx.env, ctx.caller, ctx.task, discard);
  const guarded = preview === undefined ? {} : { expectedPreviewDigest: preview.digest, ...(discard ? { discard_unpublished: true } : {}) };
  const view = await closeTask(ctx.deps, ctx.caller, ctx.task.taskId, { requestId: ctx.requestId, ...guarded });
  return { status: view.closing || view.closedAt === undefined ? "started" : "done" };
}
