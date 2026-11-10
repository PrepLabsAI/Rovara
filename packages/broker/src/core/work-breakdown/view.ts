// the parts of an ordered run as a person reads them, in Rovara's fixed words. The state of a part is what the broker acknowledged (`workflowDependenciesProgress`), never what the worker said.
import { taskGraphOrder, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";

export type PartState = "waiting" | "running" | "done" | "failed" | "stopped";

export interface PartView {
  id: string;
  title: string;
  /** The titles of the parts this one waits for. */
  waitsFor: string[];
  state: PartState;
}

export interface WorkBreakdownView {
  /** In the order they run (a part comes after every part it waits for). */
  parts: PartView[];
  /** Whether the owner approved this exact breakdown. */
  approved: boolean;
  /** How many parts may be built at once, when the plan could use more than one (Rovara Code v2); absent for one at a time. */
  atOnce?: number;
}

/** The words a page says for each state. */
export const PART_STATE_WORDS: Readonly<Record<PartState, string>> = Object.freeze({
  waiting: "waiting", running: "being built", done: "built", failed: "failed", stopped: "stopped, will be checked again",
});

/** The state of each part from the acknowledged checkpoints: the newest one of a part says where it stands. */
export function workBreakdownView(graph: TaskGraphV1, progress: readonly WorkItemProgressV1[], approved: boolean, atOnce?: number): WorkBreakdownView {
  const newest = new Map<string, WorkItemProgressV1>();
  for (const entry of [...progress].sort((left, right) => left.sequence - right.sequence)) newest.set(entry.itemId, entry);
  const byId = new Map(graph.items.map((item) => [item.id, item] as const));
  const stateOf = (id: string): PartState => {
    const entry = newest.get(id);
    return entry === undefined ? "waiting" : entry.state === "IMPLEMENTED" ? "done" : entry.state === "STARTED" ? "running" : entry.state === "FAILED" ? "failed" : "stopped";
  };
  return {
    parts: taskGraphOrder(graph).flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [{ id, title: item.title, waitsFor: item.dependsOn.map((dependency) => byId.get(dependency)?.title ?? dependency), state: stateOf(id) }];
    }),
    approved,
    ...(atOnce !== undefined && atOnce > 1 ? { atOnce } : {}),
  };
}
