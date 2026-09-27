// Runs `agentx init`'s steps in order under the environment lock, recording each outcome in SSM
// as soon as it is known. A done step is skipped on every later run (FR-019: re-running a
// completed step changes nothing); a failed step is not recorded, so the next run retries it; a
// waiting step (a person must act first, FR-035) is recorded and stops the run.
import { AgentXError, agentXError } from "@agentx/contracts";
import { cliErrorFor } from "../deploy/commands.js";
import { withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { emptyProgress, readInstallProgress, writeInstallProgress, type InitStepId, type InstallProgress } from "./install-state.js";

export type StepOutcome = { status: "done"; note?: string } | { status: "waiting"; message: string };

export interface ProgressHandle {
  current(): InstallProgress;
  /** Merges github or slack facts and writes progress at once, so a crash right after keeps them. */
  update(patch: Pick<Partial<InstallProgress>, "github" | "slack">): Promise<void>;
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
  | { kind: "step-waiting"; id: InitStepId; title: string; message: string };

export type InitRunResult =
  | { status: "complete"; ran: InitStepId[]; skipped: InitStepId[] }
  | { status: "waiting"; step: InitStepId; message: string; ran: InitStepId[]; skipped: InitStepId[] };

const RESUME = "Run agentx init again to continue from this step.";

export function initStepFailure(title: string, error: unknown): unknown {
  const mapped = cliErrorFor(error);
  const message = mapped instanceof Error ? mapped.message.replace(/^[A-Z_]+: /, "") : String(mapped);
  const text = `init stopped at "${title}": ${message}. ${RESUME}`;
  if (mapped instanceof AgentXError) {
    const refresh = mapped.code === "AUTH_REQUIRED" ? " Refresh your AWS session first (for example aws sso login or aws login)." : "";
    return Object.assign(agentXError(mapped.code, `${text}${refresh}`), { cause: error });
  }
  return new Error(text, { cause: error });
}

export async function runInitSteps<C>(input: {
  env: string; store: ParameterStore; holder: string;
  steps: ReadonlyArray<InitStep<C>>; context: C;
  onEvent?: (event: InitEvent) => void;
  confirmTakeover?: (held: LockRecord) => Promise<boolean>;
  now?: () => number;
}): Promise<InitRunResult> {
  const now = input.now ?? Date.now;
  return withEnvironmentLock(
    {
      store: input.store, env: input.env, holder: input.holder, command: "init", now, takeOverOwn: true,
      ...(input.confirmTakeover === undefined ? {} : { confirmTakeover: input.confirmTakeover }),
    },
    async () => {
      let progress = (await readInstallProgress(input.store, input.env)) ?? emptyProgress(input.env, now());
      const save = async (next: InstallProgress) => {
        progress = { ...next, updatedAt: new Date(now()).toISOString() };
        await writeInstallProgress(input.store, progress);
      };
      const handle: ProgressHandle = {
        current: () => progress,
        update: (patch) => save({ ...progress, ...patch }),
      };
      const ran: InitStepId[] = [];
      const skipped: InitStepId[] = [];
      for (const step of input.steps) {
        if (progress.steps[step.id]?.status === "done") {
          skipped.push(step.id);
          input.onEvent?.({ kind: "step-skipped", id: step.id, title: step.title });
          continue;
        }
        input.onEvent?.({ kind: "step-started", id: step.id, title: step.title });
        let outcome: StepOutcome;
        try {
          outcome = await step.run(input.context, handle);
        } catch (error) {
          throw initStepFailure(step.title, error);
        }
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
