// Live steer, the broker's send (the hosted product's `agent-sessions/live-steer.ts` and `live-steer-dispatch.ts`). A message the task took as a note is also handed, when its task's step is running
// right now on a worker, to that step's session within seconds. The note stays the durable record and the fallback: nothing here changes it, and a message that cannot go live (no running step, a step that takes no
// message, a worker that does not list `task.liveSteer.v1`, a machine that is not up) is simply a note, read by the next step as before.
//
// How it reaches the worker is the model every job uses: one `steer` invocation, delivered to the task's machine through the `worker-machines` port (the adapter signs it for this workspace, this operation id and this fence, for
// one minute), carrying a callback capability made the same way as a job's (HMAC, this workspace, this operation, this fence) but with NO action: the worker never calls the broker for a steer, and the capability opens
// nothing. The worker answers on the same request. Nothing here can carry a budget, a tool, a permission or an approval: the payload is strict, and the worker wraps the text so the model sees who sent it and what
// authority it has. Nothing here starts a machine (a message is not a reason to wake a stopped worker), touches an operation record or logs the text.
//
// Authority: the sender is the task's owner (`owner_instruction`: an instruction only inside the approved plan) or anyone else (`information`: context, never an instruction); the worker words it that way. On a
// Code install there is one owner, so a message is `owner_instruction`.
import { createHash } from "node:crypto";
import {
  AGENTX_PROTOCOL_VERSION, LIVE_STEER_FEATURE, LIVE_STEER_STEPS, LIVE_STEER_STEP_OF_MODE, LIVE_STEER_TEXT_MAX_CHARS, LiveSteerAnswerSchema, MachineError, WorkerInvocationSchema, liveSteerOperationId, redactText,
  type LiveSteerPayload, type LiveSteerStep, type WorkerInvocation,
} from "@agentx/contracts";
import { CallbackCapabilities } from "../../callbacks.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { operationKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { fromDocument, type OperationRecord } from "../task-flow/records.js";
import { readWorkspace } from "../task-flow/stage-machine.js";

/** The capability of a steer lives as long as one delivery attempt and a few asks, and lists no action. */
const CAPABILITY_SECONDS = 120;
/** How many times a step that has not opened its session yet is asked again, and how long between. */
export const LIVE_STEER_ATTEMPTS = 3;
export const LIVE_STEER_RETRY_MS = 1_000;
/** The whole send is given this long (a tell waits for it): a worker that is slow to answer leaves the message a note. */
export const LIVE_STEER_BUDGET_MS = 10_000;

export type LiveSteerResult =
  /** The worker's session took the message. */
  | "steered"
  /** There is no running step that takes a message, or its worker is not up: it is a note. */
  | "no_step"
  /** The worker does not list the feature (an older worker): it is a note. */
  | "old_worker"
  /** The step's session did not open in time, or the worker did not answer: it is a note. */
  | "not_ready"
  | "failed";

export interface LiveSteerDeps extends Pick<TaskFlowDeps, "store" | "machines" | "callbackSigningKey" | "now" | "log"> {
  sleep?: (ms: number) => Promise<void>;
  /** The longest the whole send may take. Default `LIVE_STEER_BUDGET_MS`. */
  budgetMs?: number;
  /** Off: nothing goes live and a message is a note (the kill switch). Default on. */
  enabled?: boolean;
}

export interface LiveSteerInput {
  taskId: string;
  messageId: string;
  text: string;
  /** Whether the sender is the task's owner. */
  owner: boolean;
  developerId: string;
}

/** A person as a prompt names them: a fixed word and a short id, the same for the same person, never the name they chose. The same label the task notes use. */
export const livePersonLabel = (developerId: string): string => `person p_${createHash("sha256").update(`person\0${developerId}`, "utf8").digest("hex").slice(0, 6)}`;

/** The running step a message could reach, or why not: only a running (handed to its machine, not ended) understanding, planning, coding or setup operation of this task, on the workspace that is busy with it. */
export async function runningSteerableStep(deps: Pick<TaskFlowDeps, "store">, taskId: string): Promise<{ workspaceId: string; fence: number; projectRevision: number; machineId: string; operationId: string; step: LiveSteerStep } | undefined> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.closedAt !== undefined) return undefined;
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status !== "BUSY" || workspace.activeOperationId === null || workspace.machine === undefined) return undefined;
  const operation = fromDocument<OperationRecord>(await deps.store.get(operationKey(workspace.id, workspace.activeOperationId)));
  const mode = operation?.workflowMode;
  const step = LIVE_STEER_STEPS.find((candidate) => candidate === (typeof mode === "string" ? LIVE_STEER_STEP_OF_MODE[mode] ?? mode : mode));
  // A local worker's operation stays DISPATCHING while it runs (its events do not move the status), a Cloud one is RUNNING: both are handed to the machine. The worker is the judge of whether its session is open
  // (it answers `not_ready` or `not_running`), so a step it has not taken yet is never given a message.
  if (operation === undefined || step === undefined || operation.kind !== "task" || (operation.status !== "RUNNING" && operation.status !== "DISPATCHING") || operation.machineId !== workspace.machine.machineId || operation.fence !== workspace.fence) return undefined;
  return { workspaceId: workspace.id, fence: workspace.fence, projectRevision: workspace.projectRevision, machineId: workspace.machine.machineId, operationId: operation.id, step };
}

/**
 * Hands a message the task just took as a note to its running step, when there is one. Never throws (the note is saved already, so a failure only means the message waits for the next step) and logs only names.
 */
export async function sendLiveSteer(deps: LiveSteerDeps, input: LiveSteerInput): Promise<LiveSteerResult> {
  const log = (event: string, extra: Record<string, unknown> = {}): void => deps.log?.({ component: "live-steer", event, ...extra });
  try {
    if (deps.enabled === false) return "no_step";
    const secret = Buffer.from(deps.callbackSigningKey);
    if (secret.byteLength < 32) return "no_step";
    const text = redactText(input.text).trim().slice(0, LIVE_STEER_TEXT_MAX_CHARS).trim();
    if (text === "") return "no_step";
    const running = await runningSteerableStep(deps, input.taskId);
    if (running === undefined) return "no_step";
    // Only a worker that is up and lists the feature: a stopped or starting machine is never woken for a message, and an older worker is never sent a kind it does not know.
    const health = await deps.machines.health(running.machineId);
    if (health.state !== "busy") return "no_step";
    if (!health.features.includes(LIVE_STEER_FEATURE)) return "old_worker";
    const operationId = liveSteerOperationId(input.messageId);
    const payload: LiveSteerPayload = {
      targetOperationId: running.operationId, messageId: input.messageId, step: running.step, authority: input.owner ? "owner_instruction" : "information", sender: livePersonLabel(input.developerId), text,
    };
    const invocation = WorkerInvocationSchema.safeParse({
      protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "steer", operationId, workspaceId: running.workspaceId, fence: running.fence, projectRevision: running.projectRevision,
      callbackCapability: new CallbackCapabilities(secret).issue({ workspaceId: running.workspaceId, operationId, fence: running.fence, actions: [], expiresInSeconds: CAPABILITY_SECONDS }), payload,
    });
    if (!invocation.success) return "failed";
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    const deadline = Date.now() + (deps.budgetMs ?? LIVE_STEER_BUDGET_MS);
    for (let attempt = 1; attempt <= LIVE_STEER_ATTEMPTS; attempt += 1) {
      const left = deadline - Date.now();
      if (left <= 0) return "not_ready";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([deliverOnce(deps, running.machineId, invocation.data), new Promise<"not_ready">((resolve) => { timer = setTimeout(() => resolve("not_ready"), left); })]);
      clearTimeout(timer);
      if (outcome === "steered") return "steered";
      if (outcome === "not_running") return "no_step";
      if (outcome === "failed") return "failed";
      // `not_ready`: the step has not opened its session yet. Asked again a few times, then it is a note.
      if (attempt < LIVE_STEER_ATTEMPTS) await sleep(LIVE_STEER_RETRY_MS);
    }
    return "not_ready";
  } catch (error) {
    // The words of an error are never repeated: a name only.
    log("live_steer_failed", { taskId: input.taskId, error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

async function deliverOnce(deps: Pick<LiveSteerDeps, "machines">, machineId: string, invocation: WorkerInvocation): Promise<"steered" | "not_running" | "not_ready" | "failed"> {
  try {
    const receipt = await deps.machines.deliver(machineId, invocation);
    const answer = LiveSteerAnswerSchema.safeParse(receipt.answer);
    return answer.success ? (answer.data.outcome === "steered" ? "steered" : answer.data.outcome) : "failed";
  } catch (error) {
    // A machine that is not ready (yet or any more) is asked again; one that is gone, or that refuses the message, is a note.
    return error instanceof MachineError && error.code === "not_ready" ? "not_ready" : "failed";
  }
}
