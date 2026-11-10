// The rows of the task page's "What the agent loaded" panel for lessons. The shell of the panel belongs to the task page;
// this supplies the lesson rows. A lesson from a restricted source is shown to a person who may not see that source as an opaque row: no title, no text.
import type { LessonStore, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "./access-port.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { IdentitySet, Lesson } from "./types.js";

export interface PanelRow {
  stage: string; round: number; lessonId: string; version: number; why: "scope" | "similar" | "path";
  citation: "unchecked" | "valid" | "moved" | "stale_dropped" | "unchecked_dropped" | "none";
  /** False when the viewer may not see the lesson's source: the row then carries no text. */
  visible: boolean;
  title?: string; type?: Lesson["type"]; helpful?: number; harmful?: number;
  /** "Helpful" and "Wrong here" are offered only on a lesson the viewer can see. */
  canMark: boolean;
  /** Live on trial or stable, with no approval: the viewer gets the one-tap thumbs-down. */
  trial?: "trial" | "stable";
}

export async function lessonPanelRows(store: LessonStore, key: ScopeKey, taskId: string, viewer: IdentitySet, access: AccessCheckPort, log?: LessonLog): Promise<PanelRow[]> {
  const entries: Array<{ base: Omit<PanelRow, "visible" | "canMark">; lesson: Lesson | undefined }> = [];
  for (const manifest of await store.manifests(key, taskId)) {
    for (const entry of manifest.lessons) {
      entries.push({ base: { stage: manifest.stage, round: manifest.round, lessonId: entry.id, version: entry.version, why: entry.why, citation: entry.citation }, lesson: await store.get(key, entry.id) });
    }
  }
  // One access check for the whole panel (the frozen snapshot AND the records now); an unreadable record fails the call.
  const shown = new Set((await readVisible({ access, key, viewer, lessons: entries.flatMap((e) => (e.lesson === undefined ? [] : [e.lesson])), where: "panel", log })).map((l) => l.id));
  const rows: PanelRow[] = entries.map(({ base, lesson }) => (lesson !== undefined && shown.has(lesson.id)
    ? { ...base, visible: true, title: lesson.title, type: lesson.type, helpful: lesson.counters.helpful, harmful: lesson.counters.harmful, canMark: true, ...(lesson.trial === undefined ? {} : { trial: lesson.trial.state }) }
    : { ...base, visible: false, canMark: false }));
  return rows;
}
