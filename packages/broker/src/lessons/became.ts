// "Became": the link a lesson keeps after a person made it permanent (lessons phase 4). A graduated lesson is RETIRED, so no step is handed it as a lesson again (every reader takes `active` lessons only), and it carries
// `became` (a rule, a draft check task or a skill) beside its whole history, so people can still see what it turned into. ONE conditional commit per try; a lesson that already became something keeps its first link.
import { dropVector } from "./similarity.js";
import type { LessonVectors } from "./ports.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export type Became = NonNullable<Lesson["became"]>;
const MAX_TRIES = 3;

export interface BecameDeps { store: LessonStore; now: () => number; vectors?: LessonVectors | undefined }
export type BecameResult = { ok: true; already: boolean; became: Became } | { ok: false; code: "not_found" | "conflict" };

/**
 * Retires a lesson (when it is still live) and records what it became. `promotedRuleId` is kept in step for a rule (the older field). A lesson that already has a link is returned as it is (`already`): the first link stands.
 * A lesson in any status can be linked (a skill goes live later than the lesson's retirement in some orders), but only an `active` or `stale` lesson is retired by it; an already retired lesson stays as it was.
 */
export async function recordBecame(deps: BecameDeps, key: ScopeKey, lessonId: string, to: { kind: Became["kind"]; ref: string }): Promise<BecameResult> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, lessonId) ?? await deps.store.getHead(key, lessonId);
    if (fresh === undefined) return { ok: false, code: "not_found" };
    if (fresh.became !== undefined) return { ok: true, already: true, became: fresh.became };
    const became: Became = { kind: to.kind, ref: to.ref.slice(0, 100), at: deps.now() };
    const setVersion = await deps.store.setVersion(key);
    const retire = fresh.status === "active" || fresh.status === "stale" || fresh.status === "pending";
    const write: Lesson = { ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), became, ...(to.kind === "rule" ? { promotedRuleId: became.ref } : {}), ...(retire ? { status: "retired" as const } : {}), updatedAt: deps.now() };
    const result = await deps.store.commit(key, setVersion, [write], deps.now());
    if (result.ok) {
      await dropVector(deps.vectors, key, lessonId);
      return { ok: true, already: false, became };
    }
  }
  return { ok: false, code: "conflict" };
}
