// Saved project images: what makes the registry look at a project, and what starts the job it queues. Every trigger calls the registry's `checkRebuild`, which decides; a job it queues is started by
// `onQueued` here, the same way for all of them:
//   - a push to a project's default branch (`savedEnvPushQueue`);
//   - the project's nightly fire, before the night is started (`savedEnvBeforeNightly`), which also runs the deleted-project sweep (`sweepDeleted`) once per fire (a pass with nothing due is one read);
//   - the periodic poll (`runSavedEnvPoll`), from the install's timer;
//   - the task-start check the registry already makes when a preparation is built (`savedEnvForPrepare`).
// Everything is inert while the saved-environments switch is off, and nothing here throws into its caller: a trigger that fails is logged by name and the next one tries again.
import { NightlyFireSchema } from "@agentx/contracts";
import { abandonQueuedJob, checkRebuild, runPoll, sweepDeleted, type SavedEnvDeps } from "./saved-env.js";
import { startSavedEnvRebuild, type RebuildStartDeps, type SavedEnvBuildInputs } from "./saved-env-rebuild.js";
import { savedEnvEnabled } from "./saved-env-switch.js";

/** The projects one periodic pass looks at. */
export const SAVED_ENV_POLL_LIMIT = 10;
/** The ideal gap between periodic passes (the install's timer calls `runSavedEnvPoll` this often). */
export const SAVED_ENV_POLL_INTERVAL_MS = 5 * 60_000;
/** Why a start was refused for a reason that will not mend itself: the queued job is ended, so the project does not wait out its lease. */
const PERMANENT: ReadonlySet<string> = new Set(["no_owner", "no_build_inputs", "approved_moved", "commits_mismatch", "no_project"]);

export interface SavedEnvTriggerDeps extends Omit<RebuildStartDeps, "saved"> {
  /** The registry's dependencies, read each time (the registry is made while these are being made). */
  saved: () => SavedEnvDeps;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

const defaultLog = (event: string, extra: Record<string, unknown> = {}): void => { console.log(JSON.stringify({ component: "broker", event, ...extra })); };

export type BuildInputsProvider = (orgId: string, project: string) => Promise<SavedEnvBuildInputs | undefined>;

/** The registry's `onQueued`: starts the job as a pinned preparation. A refusal that will not mend ends the job with its word. Never throws. */
export function savedEnvOnQueued(deps: SavedEnvTriggerDeps): NonNullable<SavedEnvDeps["onQueued"]> {
  const log = deps.log ?? defaultLog;
  return async (ids, job) => {
    try {
      const saved = deps.saved();
      const started = await startSavedEnvRebuild({ ...deps, saved }, ids);
      if (!started.started && PERMANENT.has(started.why)) await abandonQueuedJob(saved, ids, job.jobId, started.why);
      if (!started.started) log("saved_env.start_refused", { why: started.why });
    } catch (error) {
      log("saved_env.start_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };
}

/** The periodic poll, over the registry's due projects. Off or not installed: nothing is read. */
export async function runSavedEnvPoll(deps: SavedEnvDeps | undefined, env: NodeJS.ProcessEnv = process.env, log: (event: string, extra?: Record<string, unknown>) => void = defaultLog): Promise<unknown> {
  if (deps === undefined || !savedEnvEnabled(env)) return "off";
  try { return await runPoll(deps, SAVED_ENV_POLL_LIMIT); } catch (error) {
    log("saved_env.poll_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

/** Before a project's nightly is started: its images are checked (the nightly trigger), and the deleted projects' registries are swept. The night is never held up or failed by this. */
export async function savedEnvBeforeNightly(deps: SavedEnvDeps | undefined, event: unknown, env: NodeJS.ProcessEnv = process.env, log: (event: string, extra?: Record<string, unknown>) => void = defaultLog): Promise<void> {
  if (deps === undefined || !savedEnvEnabled(env)) return;
  const fire = NightlyFireSchema.safeParse(event);
  try {
    if (fire.success) await checkRebuild(deps, { orgId: fire.data.orgId, projectId: fire.data.project }, "nightly");
    await sweepDeleted(deps);
  } catch (error) {
    log("saved_env.nightly_failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

/** A push to the default branch of a project's repository: the registry is told (activity) and a rebuild is queued if one is due. Undefined while the switch is off. */
export function savedEnvPushQueue(deps: SavedEnvDeps | undefined, env: NodeJS.ProcessEnv = process.env): ((push: { orgId: string; project: string }) => Promise<unknown>) | undefined {
  if (deps === undefined || !savedEnvEnabled(env)) return undefined;
  return (push) => checkRebuild(deps, { orgId: push.orgId, projectId: push.project }, "push");
}
