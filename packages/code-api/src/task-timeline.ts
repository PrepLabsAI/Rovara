// `GET /v1/dev/tasks/{taskId}/timeline` (RD-2c fills it; RD-2.0 writes the shape): the richer timeline for the new task page's frame: one entry per step run, decision and notable moment, each with links to what it touched, and how many of
// the task's automatic fix actions are used. It is a new read next to `events` (which stays as it is: at most 50 coarse lines).
// Every member is optional and unknown members pass through (see task-read-common.ts). Until the lane fills it, Code answers `ROUTE_NOT_SERVED`.
import { z } from "zod";
import { LinkWireSchema, loose } from "./task-read-common.js";

/** One entry. `kind`: step, decision, status, message, fix or error; `step` names the pipeline step it belongs to; `links` point at the step, files, commands or screenshots it touched. `text` is fixed words, never raw error text. */
export const TimelineEntryWireSchema = loose({
  at: z.string().nullish(),
  kind: z.string().nullish(),
  step: z.string().nullish(),
  text: z.string().nullish(),
  /** Who did it, in words ("Rovara", a person's name), when a person did. */
  by: z.string().nullish(),
  links: z.array(LinkWireSchema).nullish(),
});

export const TaskTimelineReadSchema = loose({
  timeline: loose({
    taskId: z.string().nullish(),
    /** Oldest first. */
    entries: z.array(TimelineEntryWireSchema).nullish(),
    /** How many automatic fix actions the task has used and may use (build send-backs plus CI fixes). */
    autoFix: loose({ used: z.number().nullish(), max: z.number().nullish() }).nullish(),
    /** Entries older than the ones listed exist. */
    more: z.boolean().nullish(),
  }).nullish(),
});
export type TaskTimelineRead = z.infer<typeof TaskTimelineReadSchema>;

export const TASK_TIMELINE_EXAMPLE = {
  timeline: {
    taskId: "11111111-1111-4111-8111-111111111111",
    entries: [
      { at: "2026-11-15T10:00:00.000Z", kind: "status", text: "Task started", by: "Maya" },
      { at: "2026-11-15T10:12:00.000Z", kind: "step", step: "coding", text: "Coding finished", by: "Rovara", links: [{ kind: "step", id: "coding" }] },
    ],
    autoFix: { used: 1, max: 6 },
    more: false,
  },
} as const;
