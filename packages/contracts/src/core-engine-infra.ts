/**
 * Engine host (migration plan v3.2 lane E2): the deployment half of the core engine switch, as plain data for the CDK app (infra/lib/core-engine.ts), the CLI and the broker. The app cannot read the
 * broker's job table (packages/broker/src/core-host/jobs.ts), so the schedules are listed here and tests/contract/core-engine-infrastructure.test.ts holds the two equal.
 */

/** The broker's switch variable (core-host/flags.ts reads it). The stack parameter `CoreEngine` sets it. */
export const CORE_ENGINE_VARIABLE = "ROVARA_CORE_ENGINE";

/** The `source` of the event a core job schedule sends to the broker (CORE_SCHEDULE_SOURCE in core-host/jobs.ts). */
export const CORE_JOB_EVENT_SOURCE = "agentx.core-job";

export interface CoreJobSchedule {
  /** The job's name in the broker's CORE_JOBS table: the event is `{ source: "agentx.core-job", job: <name> }`. */
  readonly job: string;
  /** EventBridge Scheduler's rate expression. One minute is its shortest rate. */
  readonly rate: string;
}

/** Every CORE_JOBS row whose trigger is a schedule. The `outbox-relay` row is a stream trigger, not a schedule: only its backstop is here. */
export const CORE_JOB_SCHEDULES: readonly CoreJobSchedule[] = [
  { job: "outbox-relay-backstop", rate: "rate(1 minute)" },
  { job: "dispatch-sweep", rate: "rate(1 minute)" },
  { job: "run-watch", rate: "rate(1 minute)" },
  { job: "merge-tracking", rate: "rate(1 minute)" },
  { job: "session-sweep", rate: "rate(5 minutes)" },
  { job: "notify-deliver", rate: "rate(5 minutes)" },
  { job: "admission-hold-sweep", rate: "rate(15 minutes)" },
  { job: "automation-stop", rate: "rate(1 minute)" },
];

/**
 * What the `CoreEngine` parameter may be: `off`, `on` (every company), `on:<company id>[:<company id>]` or `drain` (no new task on the core, its running tasks served to the end), the shape the
 * broker's parseCoreSwitch reads (core-host/flags.ts). A company id is `org_` and twenty lowercase letters or digits; at most two here. The pattern admits no comma, equals sign, slash or space.
 */
export const CORE_ENGINE_PARAMETER_PATTERN = "^(off|on|drain|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$";
export const CORE_ENGINE_PARAMETER_MAX_LENGTH = 64;
export const CORE_ENGINE_DEFAULT = "off";
/**
 * Whether the broker runs the core engine yet. False until the broker wiring lands (lane E2 step 6, after the second mainline sync): until then the CLI refuses every value but `off`,
 * so switching on cannot enable schedules the broker does not answer. The stack parameter itself already takes every value, so turning this on needs no template change.
 */
export const CORE_ENGINE_BROKER_WIRED = false;

/** The core's most dispatch attempts for one message (DISPATCH_ATTEMPTS_MAX in core/task-flow/dispatch.ts). The queue's redrive limit must be above it, or SQS dead-letters a message the core still retries. */
export const CORE_DISPATCH_ATTEMPTS_MAX = 20;
/** The core dispatch queue's redrive limit: above the core's own retry budget. */
export const CORE_DISPATCH_MAX_RECEIVES = CORE_DISPATCH_ATTEMPTS_MAX + 1;

/** The core's dispatch queue and its dead letters, by fixed per-environment names (named environments only). */
export const coreDispatchQueueName = (env: string): string => `agentx-${env}-core-dispatch`;
export const coreDispatchDeadLetterName = (env: string): string => `agentx-${env}-core-dispatch-dead`;
