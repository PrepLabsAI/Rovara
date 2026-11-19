// The keys a project's lessons are stored under, and the fixed numbers of the lessons' reflection queue. A project's lessons live in one partition per company and project
// (`teamRecordPk`), in sort-key families that a project erase wipes (`LESSON#...`, `LESSONSET...`, `LOAD#...`). The layout is the one a hosted install keeps its lessons
// under, so the same rows can be read by either: change a key here and a stored lesson is lost to the other.
import { createHash } from "node:crypto";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";

export interface LessonKey { pk: string; sk: string }

/** The project segment of a partition for a row that belongs to no project. A project name starts with a letter, so this never collides. */
export const TEAM_RECORD_NO_PROJECT = "_workspace";

/** A key segment: never empty and never holds the `#` that separates segments, so one segment can't be read as two. */
function keyPart(value: string, what: string): string {
  if (value.length === 0 || value.includes("#") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${what} can't be empty or hold a "#" or a control character`);
  return value;
}

const COUNTER_WIDTH = 12;
const counter = (value: number, what: string): string => {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** COUNTER_WIDTH) throw new Error(`${what} is a whole number below 10^${String(COUNTER_WIDTH)}`);
  return String(value).padStart(COUNTER_WIDTH, "0");
};
const ROUND_WIDTH = 6;
const roundPart = (value: number): string => {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** ROUND_WIDTH) throw new Error(`a round is a whole number from 0 to ${String(10 ** ROUND_WIDTH - 1)}`);
  return String(value).padStart(ROUND_WIDTH, "0");
};

/** The partition holding one project's lessons, load manifests and learning settings in one company. */
export function teamRecordPk(orgId: OrgId, project?: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#P#${project === undefined ? TEAM_RECORD_NO_PROJECT : keyPart(project, "a project name")}`;
}

export function lessonKey(orgId: OrgId, project: string, lessonId: string): LessonKey {
  return { pk: teamRecordPk(orgId, project), sk: `LESSON#${keyPart(lessonId, "a lesson id")}` };
}
export const LESSON_SK_PREFIX = "LESSON#";
export function lessonVersionKey(orgId: OrgId, project: string, lessonId: string, version: number): LessonKey {
  return { pk: teamRecordPk(orgId, project), sk: `LESSON#${keyPart(lessonId, "a lesson id")}#V#${counter(version, "a lesson version")}` };
}
/** The project's lesson-set version counter (monotonic; a load manifest records it so a task's context can be reproduced). */
export function lessonSetKey(orgId: OrgId, project: string): LessonKey {
  return { pk: teamRecordPk(orgId, project), sk: "LESSONSET" };
}
/** What the agent loaded for one stage dispatch. An eval run writes `EVALLOAD#` instead, so the live counters never see it. */
export function loadManifestKey(orgId: OrgId, project: string, taskId: string, stage: string, round: number, evalRun = false): LessonKey {
  return { pk: teamRecordPk(orgId, project), sk: `${evalRun ? "EVALLOAD" : "LOAD"}#${keyPart(taskId, "a task id")}#${keyPart(stage, "a stage")}#${roundPart(round)}` };
}
/** The project's learning mode (Off, Collect, Suggest, On), where the settings writer stores it. */
export function learningModeKey(orgId: OrgId, project: string): LessonKey {
  return { pk: teamRecordPk(orgId, project), sk: "MODE" };
}
/** The company lock on the learning mode, in the company's own (project-less) partition. */
export function learningModeLockKey(orgId: OrgId): LessonKey {
  return { pk: teamRecordPk(orgId), sk: "MODE_LOCK" };
}
/** A hash of a text for a key segment (so a `#` in it can't move a key boundary). */
export const lessonKeyHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A lesson waiting for people is dropped after this many days; a change that nobody approved does not wait for ever. */
export const LESSON_APPROVAL_TTL_DAYS = 7;

// ---- the reflection queue (a finished task's reflection waits in it: ids only, never a person's words)

/** The queue a finished task's reflection waits in, and its dead-letter queue. */
export const LESSONS_REFLECT_QUEUE = "lessons-reflect";
export const LESSONS_REFLECT_DEAD_LETTER_QUEUE = "lessons-reflect-dead";
/** A reflection that is received five times lands in the dead-letter queue. */
export const LESSONS_REFLECT_MAX_RECEIVES = 5;
/** A reflection that failed before anything was spent is tried again at most this many times, each after the backoff below. */
export const LESSONS_REFLECT_MAX_ATTEMPTS = 3;
/** The wait before a failed message becomes visible again, by how many times it has been received (the last figure holds for every later receive). */
export const LESSONS_REFLECT_RETRY_BACKOFF_SECONDS = [60, 300, 900] as const;
/** A reflection's lease lasts the worker's timeout and this much more; a lease past it belongs to a worker that died. */
export const LESSONS_REFLECT_LEASE_GRACE_SECONDS = 60;
/** How long the model step may take, and the work around it: the work stops starting model calls at the deadline. */
export const LESSONS_BROKER_MODEL_WAIT_SECONDS = 130;
export const LESSONS_WORKER_TIMEOUT_SECONDS = 300;
export const LESSONS_WORKER_DEADLINE_SECONDS = 240;
export const LESSONS_REFLECT_VISIBILITY_SECONDS = 6 * LESSONS_WORKER_TIMEOUT_SECONDS;
