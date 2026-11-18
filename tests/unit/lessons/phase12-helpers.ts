// Shared world of the lessons phase 1 and 2 tests (fit floor, Beta strength, newcomer place, weekly order, credit, fade, area checks): a company's lesson store, its document store, the loader's deps with the real
// signals reader and evidence sink, and fixtures that FIT a task (they share its words) or do not.
import type { OrgId } from "@agentx/contracts";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import type { CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { documentEvidenceSink } from "../../../packages/broker/src/lessons/evidence.js";
import { cachedSignalsReader } from "../../../packages/broker/src/lessons/signals.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Audit, Clock, Judge, MemoryVectors, PROJECT, WS, allowAllAccess, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

export const DAY = 86_400_000;
export const A = WS as OrgId;
export const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const INTENT = "Retry failed HTTP calls in the api service with withRetry";

export const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: INTENT, repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "shared" }, ...over,
});

/** A lesson that shares the task's words (it fits). */
export const fitting = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({
  id, type: "convention", tier: 1, title: "Retry failed HTTP calls", description: "", body: "Retry failed HTTP calls in the api service with withRetry", scope: { repos: ["api"] }, ...over,
});
/** A lesson about other things: it shares none of the task's words. */
export const unrelated = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({
  id, type: "convention", tier: 1, title: `Quartz ${id}`, description: "Zebra giraffe", body: `Marmot ${id} kangaroo ledger rounding`, scope: { repos: ["api"] }, ...over,
});

export async function world(options: { embedder?: boolean; documents?: MemoryDocumentStore; clock?: Clock; ttlMs?: number } = {}) {
  const clock = options.clock ?? new Clock();
  const documents = options.documents ?? new MemoryDocumentStore({ ttlAttribute: "ttlSeconds", nowSeconds: () => Math.floor(clock.now() / 1000) });
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const evidence = documentEvidenceSink(documents, A);
  const signals = cachedSignalsReader(documents, A, clock.now, { ttlMs: options.ttlMs ?? 0, waitMs: 2_000 });
  const deps: LoadDeps = { access: allowAllAccess, store, embedder: options.embedder === true ? embedder : undefined, vectors, settings: settings(), audit: new Audit(), now: clock.now, signals };
  const counters: CounterDeps = { store, judge: new Judge(), settings: settings(), audit: new Audit(), now: clock.now, evidence };
  const add = async (...input: Lesson[]) => {
    const lessons = input.map((l) => (l.approvals.some((a) => a.mode !== "auto") ? l : { ...l, approvals: [...l.approvals, { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  const load = async (over: Partial<LoadRequest> = {}, depsOver: Partial<LoadDeps> = {}) => loadLessonsForStage({ ...deps, ...depsOver }, request(over));
  return { clock, documents, store, vectors, evidence, signals, deps, counters, add, load };
}
export const ids = (r: Awaited<ReturnType<typeof loadLessonsForStage>>): string[] => r.context?.lessons.map((l) => l.id) ?? [];

export const manifest = (taskId: string, lessonIds: string[], over: Partial<LoadManifest> = {}): LoadManifest => ({
  taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
  lessons: lessonIds.map((id) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const })), bytes: 100, ...over,
});
