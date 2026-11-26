// D1 (old workflow engine removed): three one-minute schedules drove it (GitHub webhook recovery, workflow merge recovery, workflow dispatch recovery). They are gone from the stack.
// CloudFormation updates the broker BEFORE it deletes the schedules in its clean-up phase, so for a minute or more the new broker still receives their events. For release N each of
// them is answered 200 and nothing is read or written (otherwise the broker would error, the scheduler would retry and the alarm would fire). Removed in release N+1 (DEFERRED-CHECKS).
export const RETIRED_SCHEDULE_SOURCES = ["agentx.github-webhook-recovery", "agentx.workflow-merge-recovery", "agentx.workflow-dispatch-recovery"] as const;
export type RetiredScheduleSource = (typeof RETIRED_SCHEDULE_SOURCES)[number];
export type RetiredScheduleEvent = { source: RetiredScheduleSource; continuation?: number };

export function isRetiredScheduleEvent(event: unknown): event is RetiredScheduleEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const value = event as { source?: unknown; requestContext?: unknown };
  // API Gateway always sets requestContext, so an HTTP request can never take this path (IAM protects the direct invoke).
  return value.requestContext === undefined && (RETIRED_SCHEDULE_SOURCES as readonly unknown[]).includes(value.source);
}

/** The answer body of a retired schedule's event: it did nothing. */
export const RETIRED_SCHEDULE_ANSWER = Object.freeze({ retired: true, attempted: 0 });
