// One scheduler, several features. The scheduler port keeps ONE handler (a second `subscribe` replaces the first), but the nightly test run and schedule triggers both listen to the same scheduler. So the install
// subscribes ONCE, through this router, and each feature adds its own handler to it. Every handler hears every fire and ignores the ones that are not its own (by `target.kind`); a handler that throws makes the whole
// delivery fail after the others have run, so the scheduler delivers the fire again (every handler is safe to run twice on one fire).
import type { DueSchedule, ScheduleSubscription, Scheduler } from "@agentx/contracts";

export type ScheduleHandler = (due: DueSchedule) => Promise<void>;

export interface ScheduleRouter {
  /** What a feature subscribes through: the same `subscribe` the scheduler has, except that it adds a handler instead of replacing the scheduler's. */
  readonly view: Pick<Scheduler, "capabilities" | "put" | "remove" | "get" | "subscribe">;
  /** Subscribes once to the real scheduler. Call it after every feature has added its handler (a handler added later is heard too). */
  start(): ScheduleSubscription;
}

export function createScheduleRouter(scheduler: Scheduler): ScheduleRouter {
  const handlers = new Set<ScheduleHandler>();
  const view: ScheduleRouter["view"] = {
    capabilities: scheduler.capabilities,
    put: (entry) => scheduler.put(entry),
    remove: (company, id) => scheduler.remove(company, id),
    get: (company, id) => scheduler.get(company, id),
    subscribe(handler) {
      handlers.add(handler);
      return { stop: async () => { handlers.delete(handler); } };
    },
  };
  return {
    view,
    start() {
      return scheduler.subscribe(async (due) => {
        let failure: { error: unknown } | undefined;
        for (const handler of [...handlers]) {
          try {
            await handler(due);
          } catch (error) {
            failure ??= { error };
          }
        }
        if (failure !== undefined) throw failure.error;
      });
    },
  };
}
