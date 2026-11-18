// Read-only comparison of the lessons a task actually received with the current selector's answer.
// Store reads and selection are supplied by the caller; this function itself is deterministic and has no effects.
export interface ReplayLoadInput {
  taskId: string;
  stage: string;
  round: number;
  actual: readonly string[];
  replayed: readonly string[];
}

export interface ReplayLoadResult extends ReplayLoadInput {
  gained: string[];
  lost: string[];
  changed: boolean;
}

export interface ReplayResult {
  tasks: ReplayLoadResult[];
  totals: { changedTasks: number; lessonsGained: number; lessonsLost: number };
}

/** Compare manifests by task/stage/round. Input order is retained; each lesson list is made unique. */
export function compareLessonReplay(loads: readonly ReplayLoadInput[]): ReplayResult {
  const tasks = [...loads].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.stage.localeCompare(b.stage) || a.round - b.round).map((load) => {
    const actual = new Set(load.actual);
    const replayed = new Set(load.replayed);
    const gained = [...replayed].filter((id) => !actual.has(id)).sort();
    const lost = [...actual].filter((id) => !replayed.has(id)).sort();
    return { ...load, actual: [...actual], replayed: [...replayed], gained, lost, changed: gained.length > 0 || lost.length > 0 };
  });
  return {
    tasks,
    totals: {
      changedTasks: new Set(tasks.filter((task) => task.changed).map((task) => task.taskId)).size,
      lessonsGained: tasks.reduce((sum, task) => sum + task.gained.length, 0),
      lessonsLost: tasks.reduce((sum, task) => sum + task.lost.length, 0),
    },
  };
}
