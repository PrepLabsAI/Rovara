// A stage's lessons at DELIVERY. The outbox row, the queue message, its dead-letter copy and a FAILED row carry only lesson ids and versions (`LearnedRefs`); the dispatcher calls this
// just before it posts the stage to the worker and gets the `learnedContext` built from the lesson store as it is at that moment. A lesson erased (even one whose purge has not finished: its authors are fenced
// first), retired, withdrawn, expired, edited since, no longer approved for use, or hidden from the task's reader since is left out; so is everything when the project's learning mode no longer loads. Any
// failure (the store, the access records, the reader's identity) delivers no lessons: the stage runs as without memory. The rules are the loader's own (`load.ts`), asked again.
import { LearnedContextSchema, type LearnedContext, type LearnedLesson, type LearnedRefs } from "@agentx/contracts";
import type { AccessCheckPort } from "./access-port.js";
import { hasStaleCitation, approvedForUse, stageAllows, toLearned, LOAD_MAX_BYTES } from "./load.js";
import { memberView, type MemberResolver } from "./members.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { Clock } from "./ports.js";
import { createLessonLiveReader } from "./live-visibility.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { IdentitySet, Lesson } from "./types.js";

export interface DeliveryDeps {
  store: LessonStore; settings: LearningSettingsReader; access: AccessCheckPort;
  /** Unused (the reader is the running task's audience, not one person); kept so the wiring needs no change. */
  identity(workspaceId: string, developerId: string): Promise<IdentitySet>;
  /** Counts approvers as members (a merged developer is the member they became). The dispatcher has no sign-in read, so it leaves this out and the loader's member-aware check (at queue time) stands; where given, a failed lookup delivers nothing. */
  resolveMember?: MemberResolver;
  now: Clock;
  log?: LessonLog;
}

/** People who wrote or rewrote a lesson's text: an erased one's lessons are never delivered (erasure fences them before it removes anything). */
const writersOf = (lesson: Lesson): string[] => [...lesson.provenance.authors, ...(lesson.provenance.editors ?? []), ...(lesson.provenance.readFrom ?? [])];

async function notErased(store: LessonStore, key: ScopeKey, lesson: Lesson): Promise<boolean> {
  for (const person of new Set(writersOf(lesson).map((p) => p.trim().toLowerCase()))) if (await store.isErased(key, person)) return false;
  return true;
}

export async function learnedContextFromRefs(deps: DeliveryDeps, refs: LearnedRefs): Promise<LearnedContext | undefined> {
  // A ref that names a repository file is delivered as that file, never as a prompt block.
  if (refs.file !== undefined) return undefined;
  try {
    const delivered = await deliveredLessons(deps, refs);
    if (delivered === undefined) return undefined;
    const { chosen, priorLoaded } = delivered;
    if (chosen.length === 0 && (priorLoaded ?? []).length === 0) return undefined;
    const context = { v: 1 as const, setVersion: refs.setVersion, stage: refs.stage, lessons: chosen.map((entry) => entry.learned), ...(priorLoaded === undefined || priorLoaded.length === 0 ? {} : { priorLoaded }) };
    const parsed = LearnedContextSchema.safeParse(context);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // The store, the access records or the reader's identity could not be read: no lessons, and the stage runs as without memory.
    return undefined;
  }
}

interface Delivered { chosen: Array<{ lesson: Lesson; learned: LearnedLesson }>; priorLoaded: LearnedContext["priorLoaded"] }

/** The lessons a stage is given now, after every delivery check; throws when the store cannot be read (the callers deliver nothing then). */
async function deliveredLessons(deps: DeliveryDeps, refs: LearnedRefs): Promise<Delivered | undefined> {
  const key: ScopeKey = { workspaceId: refs.orgId, project: refs.project };
  {
    const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
    // Replay snapshots are not part of this install: a ref that names one delivers nothing.
    if (refs.snapshotId !== undefined) return undefined;
    if (!modeAllows(resolved.mode, "load")) return undefined;
    const now = deps.now();
    // The reader is the running task's audience, asked again now (the people who can open its session now, not the audience the load saw, and not `task.shared`). A lesson is delivered only if everyone who
    // can see the task can see every source task of the lesson. A stage queued before the task id was carried, or a task whose audience can't be read, gets no lesson that names a task (there is no weaker rule to fall back to). Restricted places and
    // the lesson's own frozen audience are checked as for nobody in particular (`viewer` undefined): a lesson only some people may read never reaches an agent that several people can see.
    const viewer = undefined;
    const liveReader = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "deliver", running: { taskId: refs.taskId }, ...(deps.log === undefined ? {} : { log: deps.log }) });

    const fetched: Lesson[] = [];
    for (const ref of refs.lessons) {
      const lesson = await deps.store.get(key, ref.id);
      if (lesson === undefined || lesson.status !== "active" || lesson.version !== ref.version || lesson.expiresAt <= now) continue;
      fetched.push(lesson);
    }
    const member = await memberView(deps.resolveMember, key.workspaceId, fetched.flatMap((l) => l.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => a.by)));
    if (member === undefined) return undefined;
    const live: Lesson[] = [];
    for (const lesson of fetched) {
      // The approval rule, the mode, the access checks, erasure and the stage rules all apply again at delivery.
      if (!approvedForUse(lesson, resolved.approval, member, resolved.trialAllowed) || hasStaleCitation(lesson) || !stageAllows(lesson, refs.stage, member)) continue;
      if (!(await notErased(deps.store, key, lesson))) continue;
      live.push(lesson);
    }
    const readable = new Set((await readVisible({ access: deps.access, key, viewer, lessons: live, where: "deliver", live: liveReader, ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
    const chosen: Delivered["chosen"] = [];
    let bytes = 0;
    for (const lesson of live) {
      if (!readable.has(lesson.id)) continue;
      const learned = toLearned(lesson);
      const size = Buffer.byteLength(JSON.stringify(learned), "utf8");
      if (bytes + size > LOAD_MAX_BYTES) continue;
      chosen.push({ lesson, learned });
      bytes += size;
    }

    // The reviewer's list of what earlier stages were given: titles of lessons that still exist, are not withdrawn, whose writers are not erased, and that the reader may still see.
    let priorLoaded: LearnedContext["priorLoaded"];
    if (refs.priorLoaded !== undefined) {
      const seen: Lesson[] = [];
      for (const ref of refs.priorLoaded) {
        const lesson = await deps.store.get(key, ref.id);
        if (lesson === undefined || lesson.status === "withdrawn" || !(await notErased(deps.store, key, lesson))) continue;
        seen.push(lesson);
      }
      const shown = new Set((await readVisible({ access: deps.access, key, viewer, lessons: seen, where: "deliver", live: liveReader, ...(deps.log === undefined ? {} : { log: deps.log }) })).map((lesson) => lesson.id));
      priorLoaded = seen.filter((lesson) => shown.has(lesson.id)).map((lesson) => ({ id: lesson.id, type: lesson.type, title: lesson.title }));
    }

    return { chosen, priorLoaded };
  }
}
