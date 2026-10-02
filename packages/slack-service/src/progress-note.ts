// packages/slack-service/src/progress-note.ts
// Issue 219: after "Got it", a long task used to post nothing until its result. When the worker
// accepts the task, one short note says so; while it runs, that same message is edited at a steady
// interval with how long it has run, so the thread shows progress without a stream of messages.
// Nothing here throws: a failed post or edit is logged (event and error name only) and the turn goes on.
import type { ServiceLog } from "./processor.js";
import { escapeText } from "./slack-format.js";

/** How often the note is edited while the task runs. */
export const PROGRESS_INTERVAL_MS = 3 * 60_000;
/** The longest task name the note shows. */
const SUBJECT_MAX = 120;

/**
 * What the note calls the task: what the member approved when this turn ran on their "yes",
 * otherwise their own words, without mentions or backticks, on one Slack-safe line and shortened.
 */
export function progressSubject(memberText: string, approved?: string): string {
  const own = memberText.replace(/<[@#!][^>]*>/gu, " ").replace(/[`\s]+/gu, " ").trim();
  const flat = own.length > 0 ? escapeText(own) : (approved ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > SUBJECT_MAX ? `${flat.slice(0, SUBJECT_MAX - 1).replace(/&[a-z]{0,3}$/u, "")}…` : flat;
}

function minutesText(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes < 1 ? "less than a minute" : minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export interface ProgressNoteOptions {
  /** The task, already Slack-safe (see progressSubject). */
  what: string;
  eventId: string;
  /** Posts the note in the thread and answers its timestamp, so it can be edited. */
  post(text: string): Promise<string | undefined>;
  update(ts: string, text: string): Promise<void>;
  now(): number;
  log: ServiceLog;
  intervalMs?: number;
}

export interface ProgressNote {
  /** Posts the note once, when the worker accepts the task, and starts the edits. */
  start(): Promise<void>;
  /** Stops the edits and edits the note a last time to say the task finished or stopped. */
  finish(outcome: "finished" | "stopped"): Promise<void>;
  /** Stops the edits with no last edit: the turn was handed off, or ended some other way. */
  dispose(): void;
}

export function createProgressNote(options: ProgressNoteOptions): ProgressNote {
  const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
  let started = false;
  let startedAt = 0;
  let ts: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let editing: Promise<void> = Promise.resolve();
  let done = false;

  const edit = (text: string): Promise<void> => {
    const target = ts;
    if (target === undefined) return editing;
    // One edit at a time, in order, so a slow edit is never overwritten by an older text.
    editing = editing.then(async () => {
      try {
        await options.update(target, text);
      } catch (error) {
        options.log("progress.update_failed", { eventId: options.eventId, errorName: errorName(error) });
      }
    });
    return editing;
  };
  const dispose = () => {
    done = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    async start() {
      if (started || done) return;
      started = true;
      startedAt = options.now();
      try {
        ts = await options.post(`Started on the worker: ${options.what}. I'll update this message while it runs.`);
      } catch (error) {
        options.log("progress.post_failed", { eventId: options.eventId, errorName: errorName(error) });
        return;
      }
      if (ts === undefined || done) return;
      timer = setInterval(() => {
        if (done) return;
        void edit(`Still working: ${options.what}, ${minutesText(options.now() - startedAt)} so far.`);
      }, options.intervalMs ?? PROGRESS_INTERVAL_MS);
      // The interval must never keep the service alive on its own.
      timer.unref?.();
    },
    async finish(outcome) {
      if (done) return;
      dispose();
      if (ts === undefined) return;
      const elapsed = minutesText(options.now() - startedAt);
      await edit(outcome === "finished" ? `Finished: ${options.what}, after ${elapsed}.` : `Stopped: ${options.what}, after ${elapsed}.`);
    },
    dispose,
  };
}
