// The task-end notice's reconcile on a hosted install. A task's end is sent to the model gateway the moment it happens (`taskEnded`, core-host/task-ended-http.ts); a notice that did not get through (the gateway down, an older
// gateway without the route, a process that stopped first) leaves its TASK_END marker without `notifiedAt`, and this sends it again. Its home is the always-wired `notify-deliver` job (every 5 minutes), run first in that
// job's pass with a time of its own, so it needs no schedule of its own (the clean-up is removing schedules, not adding them). A failure is logged and never stops the notices.
import type { OrgId } from "@agentx/contracts";
import type { CoreService, CoreServiceName } from "../core-host/core-runtime.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { reconcileTaskEnds } from "../core/task-flow/task-end.js";

/** The reconcile starts only with at least this much of the pass left (one send takes a few seconds at most, in parallel). */
export const TASK_END_RECONCILE_MIN_MS = 12_000;

export function withTaskEndReconcile(
  services: Partial<Record<CoreServiceName, CoreService>>,
  input: { flow: Pick<TaskFlow, "deps">; companyId: OrgId; now: () => number; log: (entry: Record<string, unknown>) => void },
): Partial<Record<CoreServiceName, CoreService>> {
  const notices = services["notify-deliver"];
  if (input.flow.deps.taskEnded === undefined) return services;
  return {
    ...services,
    "notify-deliver": {
      async pass(options) {
        const started = input.now();
        let report: { attempted: number; delivered: number } = { attempted: 0, delivered: 0 };
        if (options.budgetMs >= TASK_END_RECONCILE_MIN_MS) {
          report = await reconcileTaskEnds(input.flow.deps).catch((error: unknown) => {
            input.log({ component: "task_end", companyId: input.companyId, event: "reconcile_failed", error: error instanceof Error ? error.name : "unknown" });
            return report;
          });
        }
        const left = Math.max(0, options.budgetMs - (input.now() - started));
        return { ...(notices === undefined ? { skipped: "no_notification_transport" } : await notices.pass({ ...options, budgetMs: left })), taskEnds: report.attempted };
      },
    },
  };
}
