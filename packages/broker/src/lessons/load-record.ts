// The two rows a lesson load leaves besides its manifest, written the same way by every process that loads lessons for a step: the broker's host (`host-glue.ts`, laptop and deployed broker) and the hosted dispatcher
// (`aws/worker-machines/dispatcher-lessons.ts`), so a load on either road is read by the same readers.
//   LESSON_LOAD_REF  `<company>#LESSON_LOAD` / <operation id>: which task, project, stage and round an operation's lessons were loaded for. The worker's load report names only the operation; the broker finds the
//                    manifest (and so the lessons it may touch) through this row (`host-glue.ts` `onEvents`).
//   LESSON_USE       `<company>#LESSON_USE#<project>#<lesson id>` / <task id>: one row per lesson and task ("used in N tasks", `use-count.ts`, which reads it).
// Both are idempotent for a retried dispatch: the same operation or the same task and lesson is the same key, so a second write replaces the first with equal facts and nothing is counted twice.
import { companyScoped, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { DocumentLessonStore } from "./document-store.js";
import type { LoadManifest, LoadManifestEntry } from "./store.js";
import { LESSON_USE_KEEP_SECONDS } from "./use-count.js";

/** How long an operation's load reference is kept. */
export const LOAD_RECORD_KEEP_SECONDS = 30 * 86_400;

const expires = (ttlAttribute: string | undefined, now: number, seconds: number): Record<string, number> => (ttlAttribute === undefined ? {} : { [ttlAttribute]: Math.floor(now / 1000) + seconds });

export function lessonLoadRefItem(input: { companyId: OrgId; operationId: string; taskId: string; project: string; stage: string; round: number; now: number; ttlAttribute?: string | undefined }): StoredDocument {
  return { pk: companyScoped(input.companyId, "LESSON_LOAD"), sk: input.operationId, entityType: "LESSON_LOAD_REF", taskId: input.taskId, project: input.project, stage: input.stage, round: input.round, ...expires(input.ttlAttribute, input.now, LOAD_RECORD_KEEP_SECONDS) };
}

export function lessonUseItem(input: { companyId: OrgId; project: string; lessonId: string; taskId: string; title: string; now: number; ttlAttribute?: string | undefined }): StoredDocument {
  return { pk: companyScoped(input.companyId, `LESSON_USE#${input.project}#${input.lessonId}`), sk: input.taskId, entityType: "LESSON_USE", taskId: input.taskId, title: input.title.slice(0, 200), at: input.now, ...expires(input.ttlAttribute, input.now, LESSON_USE_KEEP_SECONDS) };
}

/**
 * The load record of a load made OUTSIDE the broker's host (the hosted dispatcher): the manifest, the operation's reference and a use row per lesson, as `host-glue.ts` writes them. `chosen` are the lessons really sent, and
 * `entries` the manifest's entries for them; with none chosen nothing is written. `check` throws when the call is over (no write starts after it); `over` says the same without throwing, for the best-effort use rows.
 * Idempotent: the manifest is written only when absent, and the reference and the use rows are the same keys for a retried dispatch. THROWS when the manifest or the reference cannot be written (the caller refuses the load); a use
 * row that cannot be written is only a missing count.
 */
export async function recordLessonLoad(store: DocumentStore, input: {
  companyId: OrgId; operationId: string; task: { taskId: string; project: string; title: string; round: number }; stage: LoadManifest["stage"];
  setVersion: number; chosen: ReadonlyArray<{ id: string }>; entries: LoadManifestEntry[]; bytes: number; now: number; check: () => void; over: () => boolean;
}): Promise<void> {
  if (input.chosen.length === 0) return;
  const { companyId, task } = input;
  input.check();
  await new DocumentLessonStore(store, () => input.now).putManifest({ taskId: task.taskId, workspaceId: companyId, project: task.project, stage: input.stage, round: task.round, setVersion: input.setVersion, memory: "live", at: input.now, lessons: input.entries, bytes: input.bytes });
  input.check();
  await store.put({ item: lessonLoadRefItem({ companyId, operationId: input.operationId, taskId: task.taskId, project: task.project, stage: input.stage, round: task.round, now: input.now, ttlAttribute: store.ttlAttribute }) });
  input.check();
  await Promise.all(input.chosen.map((lesson) => (input.over() ? Promise.resolve() : store.put({ item: lessonUseItem({ companyId, project: task.project, lessonId: lesson.id, taskId: task.taskId, title: task.title, now: input.now, ttlAttribute: store.ttlAttribute }) }).then(() => undefined, () => undefined))));
  input.check();
}
