// TE-F1c (M2, release 0.5.19; te-f1 design 6, phase A, D6): the per-task record cache the bridge uses. It is TE-F8's cache and nothing else: F8's key (`modelRecordKey`), F8's engine (`createRecordReplay`) and F8's file store
// (`createTaskRecordingStore`). This file only places them: ONE store under the task's run directory (never inside the directory the helper mounts), swept when the task starts, two engines over it (one that may forward and
// record, one that only replays: the bridge picks per call from the round and the token), and one `end()` at the real end of the task that deletes everything. Build it ONCE PER TASK and keep it across rounds: a recording made in
// one round is what a later round replays, and F8's engine keeps the task's overrun and forward counts.
//
// The scope of the recordings and the scope the port reads are made here from ONE task scope: a call whose two scopes name different companies is refused by F8's engine.
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createRecordReplay, type ModelEgress, type ModelEgressFamily, type ModelEgressScope, type RecordReplay, type RecordingPlan, type RecordingScope, type RecordingStore, type RecordingSummary,
} from "@agentx/contracts";
import { createTaskRecordingStore } from "./model-record-store-task.js";
import type { ModelBridgeRecording } from "./model-bridge.js";

/** Where the recordings live below the task's run directory. A sibling of the helper's directory, never inside it. */
export const MODEL_RECORD_DIRECTORY_NAME = "model-record";

export interface TaskRecordCacheOptions {
  /** The task's run directory (on a worker: its tmpfs run directory). The recordings live in `<runDir>/model-record`. */
  readonly runDir: string;
  /** The directory the helper container mounts read-only (`.../models`). The recordings must not be inside it, and it must not be inside them. */
  readonly helperDir: string;
  readonly scope: RecordingScope;
  readonly egress: ModelEgress;
  /** The port's own scope for this task. Built by the caller from the SAME company and task as `scope`. */
  readonly egressScope: ModelEgressScope;
  /** The company the port's scope names (the adapter's own reading of it). F8's engine refuses a call when this and `scope.companyId` differ, so both come from the same task. */
  readonly egressCompanyOf: (scope: ModelEgressScope) => string | undefined;
  /** The task state of an earlier cache for this task (`state()`), when a cache is rebuilt between rounds: the stop after an overrun and the count of real calls are kept. Prefer one cache per task. */
  readonly taskState?: { readonly overrun?: boolean; readonly forwards?: number };
  /** F8's plan for the changed prompts (`planRecording(report)`). */
  readonly plan: RecordingPlan;
  readonly clock: () => number;
  readonly capMicros?: number;
  readonly maxRecordings?: number;
  readonly familyOf?: (row: string) => ModelEgressFamily | undefined;
}

export interface TaskRecordCache {
  /** The two engines for the bridge. */
  readonly recording: ModelBridgeRecording;
  readonly store: RecordingStore;
  readonly root: string;
  /** Counts and hashes only: no prompt, no answer. */
  summary(): Promise<RecordingSummary>;
  /** The task-level state to hand to a rebuilt cache for the same task. */
  state(): { readonly overrun: boolean; readonly forwards: number };
  /** The task's real end: deletes every recording of this task and the cache directory. Runs once; a second call does nothing and returns 0. */
  end(): Promise<number>;
}

const inside = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/** Opens the cache: checks where it lives, sweeps what a crash left behind (task start), and builds the engines. Throws one fixed sentence when the directories are not sound. */
export async function openTaskRecordCache(options: TaskRecordCacheOptions): Promise<TaskRecordCache> {
  const root = resolve(options.runDir, MODEL_RECORD_DIRECTORY_NAME);
  if (!isAbsolute(options.runDir) || !isAbsolute(options.helperDir)) throw new Error("the model record cache needs absolute directories");
  if (inside(options.helperDir, root) || inside(root, options.helperDir)) throw new Error("the model record cache must not share a directory with the helper");
  const store = createTaskRecordingStore({ root, now: options.clock });
  await store.sweep();
  const common = {
    egress: options.egress,
    egressScope: options.egressScope,
    egressCompanyOf: options.egressCompanyOf,
    store,
    scope: () => options.scope,
    plan: options.plan,
    clock: options.clock,
    ...(options.capMicros === undefined ? {} : { capMicros: options.capMicros }),
    ...(options.maxRecordings === undefined ? {} : { maxRecordings: options.maxRecordings }),
    ...(options.familyOf === undefined ? {} : { familyOf: options.familyOf }),
    ...(options.taskState === undefined ? {} : { taskState: options.taskState }),
  };
  const record: RecordReplay = createRecordReplay({ ...common, mode: "record" });
  const replay: RecordReplay = createRecordReplay({ ...common, mode: "replay_only" });
  let ended = false;
  return {
    recording: { record, replay },
    store,
    root,
    summary: () => record.summary(),
    state: () => record.taskState,
    async end() {
      if (ended) return 0;
      ended = true;
      try {
        const removed = await record.endTask();
        await replay.endTask().catch(() => 0);
        return removed;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
