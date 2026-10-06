// Runs `agentx init`'s steps in order under the environment lock, recording each outcome in SSM
// as soon as it is known. A done step is skipped on every later run (FR-019: re-running a
// completed step changes nothing); a failed step is not recorded, so the next run retries it; a
// waiting step (a person must act first, FR-035) is recorded and stops the run.
import { AgentXError, agentXError } from "@agentx/contracts";
import { cliErrorFor } from "../deploy/commands.js";
import { withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { emptyProgress, readInstallProgress, writeInstallProgress, type InitStepId, type InstallProgress } from "./install-state.js";
import { isOperatorStop, markOperatorStop } from "./stop.js";

export type StepOutcome = { status: "done"; note?: string } | { status: "waiting"; message: string };

export type ProgressPatch = Pick<Partial<InstallProgress>, "github" | "githubPending" | "slack" | "slackPending" | "admin" | "project" | "connectors" | "alerts">;

export interface ProgressHandle {
  current(): InstallProgress;
  /** Merges step facts and writes progress at once, so a crash right after keeps them. */
  update(patch: ProgressPatch): Promise<void>;
}

export interface InitStep<C> {
  id: InitStepId;
  title: string;
  run(context: C, progress: ProgressHandle): Promise<StepOutcome>;
}

export type InitEvent =
  | { kind: "step-skipped"; id: InitStepId; title: string }
  | { kind: "step-started"; id: InitStepId; title: string }
  | { kind: "step-done"; id: InitStepId; title: string }
  | { kind: "step-waiting"; id: InitStepId; title: string; message: string }
  /** Spec 048 FR-060: the step threw. The run may still retry it (onStepFailure). */
  | { kind: "step-failed"; id: InitStepId; title: string; message: string };

export type InitRunResult =
  | { status: "complete"; ran: InitStepId[]; skipped: InitStepId[] }
  | { status: "waiting"; step: InitStepId; message: string; ran: InitStepId[]; skipped: InitStepId[] };

export function initStepFailure(title: string, error: unknown, where: { env: string; region: string }): unknown {
  const mapped = cliErrorFor(error);
  const message = mapped instanceof Error ? mapped.message.replace(/^[A-Z_]+: /, "") : String(mapped);
  const text = `init stopped at "${title}": ${message}. Run agentx init --env ${where.env} --region ${where.region} again to continue from this step.`;
  // Fix round 1 (Plan ruling 8): a stop the step's own run already chose keeps that status
  // through this wrap, so a catch further up (runInit's) still reads it as a stop, not a new
  // failure, whatever onStepFailure answered.
  const keepStop = <T>(wrapped: T): T => (isOperatorStop(error) ? markOperatorStop(wrapped) : wrapped);
  if (mapped instanceof AgentXError) {
    const refresh = mapped.code === "AUTH_REQUIRED" ? " Refresh your AWS session first (for example aws sso login or aws login)." : "";
    return keepStop(Object.assign(agentXError(mapped.code, `${text}${refresh}`), { cause: error }));
  }
  return keepStop(new Error(text, { cause: error }));
}

export async function runInitSteps<C>(input: {
  /** env and region name the resume command in a failed step's message. */
  env: string; region: string; store: ParameterStore; holder: string;
  steps: ReadonlyArray<InitStep<C>>; context: C;
  onEvent?: (event: InitEvent) => void;
  confirmTakeover?: (held: LockRecord) => Promise<boolean>;
  now?: () => number;
  /** Runs under the lock before any step (init saves its answers here, so two first runs of the
   * same environment cannot overwrite each other's). Its error is thrown as it is. */
  beforeSteps?: () => Promise<void>;
  /** Spec 048 FR-060: asked after a step throws. "retry" runs the step again; "stop" (or no hook)
   * throws the step's error as before. */
  onStepFailure?: (failure: { id: InitStepId; title: string; error: unknown }) => Promise<"retry" | "stop">;
}): Promise<InitRunResult> {
  const now = input.now ?? Date.now;
  return withEnvironmentLock(
    {
      store: input.store, env: input.env, holder: input.holder, command: "init", now, takeOverOwn: true,
      ...(input.confirmTakeover === undefined ? {} : { confirmTakeover: input.confirmTakeover }),
    },
    async () => {
      await input.beforeSteps?.();
      let progress = (await readInstallProgress(input.store, input.env)) ?? emptyProgress(input.env, now());
      const save = async (next: InstallProgress) => {
        progress = { ...next, updatedAt: new Date(now()).toISOString() };
        await writeInstallProgress(input.store, progress);
      };
      const handle: ProgressHandle = {
        current: () => progress,
        update: (patch) => save({ ...progress, ...patch }),
      };
      const runStep = async (step: InitStep<C>): Promise<StepOutcome> => {
        for (;;) {
          input.onEvent?.({ kind: "step-started", id: step.id, title: step.title });
          try {
            return await step.run(input.context, handle);
          } catch (error) {
            input.onEvent?.({ kind: "step-failed", id: step.id, title: step.title, message: error instanceof Error ? error.message : String(error) });
            const next = (await input.onStepFailure?.({ id: step.id, title: step.title, error })) ?? "stop";
            if (next === "stop") throw initStepFailure(step.title, error, { env: input.env, region: input.region });
          }
        }
      };
      const ran: InitStepId[] = [];
      const skipped: InitStepId[] = [];
      for (const step of input.steps) {
        if (progress.steps[step.id]?.status === "done") {
          skipped.push(step.id);
          input.onEvent?.({ kind: "step-skipped", id: step.id, title: step.title });
          continue;
        }
        const outcome = await runStep(step);
        const at = new Date(now()).toISOString();
        if (outcome.status === "waiting") {
          await save({ ...progress, steps: { ...progress.steps, [step.id]: { status: "waiting", at, note: outcome.message.slice(0, 300) } } });
          input.onEvent?.({ kind: "step-waiting", id: step.id, title: step.title, message: outcome.message });
          return { status: "waiting", step: step.id, message: outcome.message, ran, skipped };
        }
        await save({ ...progress, steps: { ...progress.steps, [step.id]: { status: "done", at, ...(outcome.note === undefined ? {} : { note: outcome.note.slice(0, 300) }) } } });
        ran.push(step.id);
        input.onEvent?.({ kind: "step-done", id: step.id, title: step.title });
      }
      return { status: "complete", ran, skipped };
    },
  );
}
