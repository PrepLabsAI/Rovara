// L10: a read-only learned input for ONE company's dispatcher runtime. L6 composes this
// with hostedDispatcherFlow. The workspace record, never the job payload, vouches for scope.
import { AgentXNameSchema, KNOWLEDGE_CONTEXT_FEATURE, KNOWLEDGE_PULL_MAX_UNITS, KNOWLEDGE_STAGE_PARTS, LEARNED_CONTEXT_FEATURE, OrgIdSchema, agentXError, codeRepositoriesOf, lessonSetKey, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { z } from "zod";
import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { taskKey } from "../../core/task-flow/keys.js";
import { workspaceKeys } from "../../core/task-flow/workspace-location.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { switchCovers, type CoreSwitch } from "../../core-host/flags.js";
import { DocumentLessonStore } from "../../lessons/document-store.js";
import { documentLearningSettings } from "../../lessons/document-settings.js";
import { documentLessonVectors } from "../../lessons/document-vectors.js";
import { createHostedLessonParts, type HostedLessonPeople } from "../../lessons/hosted-people.js";
import { LESSON_LOAD_DEADLINE_MS } from "../../lessons/host-glue.js";
import { hasStaleCitation, LOAD_MAX_BYTES, LOAD_MAX_LESSONS, selectLessons } from "../../lessons/load.js";
import { buildKnowledgeContext, deliveryRecordOf, pullable } from "../../lessons/knowledge-brief.js";
import { agreedDefaultBranch, flakyFactsPort } from "../../lessons/knowledge-facts.js";
import { writeKnowledgeDeliveryOnce } from "../../lessons/knowledge-use.js";
import { baseFlakyTests } from "../../core/test-env/base-flaky.js";
import { readVisible } from "../../lessons/read-visible.js";
import { modeAllows, resolveLearning, resolveLoadBudget, whyLearningOff } from "../../lessons/policy.js";
import { workspaceCompanyReader } from "./workspace-company.js";

export const DISPATCHER_LESSONS_UNAVAILABLE = "the dispatcher cannot read lessons for this workspace";
/** ONE budget for the workspace, task, project, settings, lesson heads and live audience reads. */
export const DISPATCHER_LESSONS_LIMITS = { reads: 128, items: 512, bytes: 1_048_576, lessons: 100 } as const;
/** The look-up's own share of the reads: it runs after the lessons, and a look-up that would pass this share is left out; it can never fail the lessons. */
export const DISPATCHER_PULL_READS = 40;
/** The look-up's own clock, and the time it always leaves of the dispatch deadline for the answer itself. */
export const DISPATCHER_PULL_MS = 900;
export const DISPATCHER_PULL_MARGIN_MS = 300;
/** The delivery record's own write: it gets at most this long, and always leaves the margin of the dispatch deadline. */
export const DISPATCHER_RECORD_MS = 400;
export const DISPATCHER_RECORD_MARGIN_MS = 100;
class PullBudgetSpent extends Error {}
type Learned = NonNullable<TaskFlowDeps["learned"]>;
function refuse(): never { throw agentXError("RUNTIME_UNAVAILABLE", DISPATCHER_LESSONS_UNAVAILABLE); }
const Request = z.object({ workspaceId: z.uuid(), operationId: z.uuid(), workflowMode: z.enum(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW", "CHECKS", "FEEDBACK_REVIEW", "SETUP_DRAFT", "SETUP_AGENT", "WIKI_BUILD", "SPEC_WRITE"]).optional(), features: z.array(z.string().max(100)).max(64) });
const Task = z.object({ taskId: z.uuid(), workspaceId: z.uuid(), companyId: OrgIdSchema, project: AgentXNameSchema, developerId: z.string().min(1).max(100), title: z.string().max(20_000), requestText: z.string().max(100_000).optional(), startingRevision: z.number().int().positive(), workflow: z.object({ revision: z.number().int().nonnegative() }) });
const SourceTask = Task.pick({ companyId: true, project: true, developerId: true });
const SetRecord = z.object({ setVersion: z.number().int().nonnegative(), members: z.record(z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), z.number().int().positive()) });

export interface DispatcherLessonsOptions {
  companyId: OrgId;
  lessonsSwitch: CoreSwitch;
  documentClient: Parameters<typeof workspaceCompanyReader>[0];
  tableName: string;
  store: DocumentStore;
  /** The existing hosted people port for this company, read live. */
  people: HostedLessonPeople;
  now?: () => number;
}

/** No host attachment, manifests, usage records, audits, learning calls or background jobs. */
export function createDispatcherLearned(options: DispatcherLessonsOptions): Learned {
  return async (input) => {
    if (!switchCovers(options.lessonsSwitch, options.companyId)) return {};
    let stopped = false;
    let failed = false;
    let reads = 0;
    let items = 0;
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + LESSON_LOAD_DEADLINE_MS;
    const check = (): void => { if (stopped || failed || Date.now() >= deadline) refuse(); };
    // The look-up (lead 4 L4-AK2) runs on a share of its own, and it can never fail the lessons: while it runs, a read past its share of reads, past its own short clock, past what is left of the shared caps, or a read that
    // fails, throws HERE (`PullBudgetSpent`) before anything is counted or `failed` is set, so the look-up ends and the lessons stand.
    let pulling = false;
    // Set when the look-up has ended (finished or given up on): work of it that is still in flight can no longer read, count or fail anything.
    let pullOver = false;
    let pullReads = 0;
    let pullDeadline = 0;
    const read = async <T>(work: () => Promise<T>, count = 1): Promise<T> => {
      if (pullOver) throw new PullBudgetSpent();
      check();
      if (pulling && (Date.now() >= pullDeadline || ++pullReads > DISPATCHER_PULL_READS || reads + 1 > DISPATCHER_LESSONS_LIMITS.reads || items + count > DISPATCHER_LESSONS_LIMITS.items || bytes >= DISPATCHER_LESSONS_LIMITS.bytes / 2)) throw new PullBudgetSpent();
      reads++; items += count;
      if (reads > DISPATCHER_LESSONS_LIMITS.reads || items > DISPATCHER_LESSONS_LIMITS.items) { failed = true; refuse(); }
      try {
        const answer = await work();
        check();
        bytes += Buffer.byteLength(JSON.stringify(answer) ?? "", "utf8");
        if (bytes > DISPATCHER_LESSONS_LIMITS.bytes) { if (pulling || pullOver) throw new PullBudgetSpent(); failed = true; refuse(); }
        return answer;
      } catch { if (pulling || pullOver) throw new PullBudgetSpent(); failed = true; return refuse(); }
    };
    // The shared lesson selector can catch dependency failures. A sticky failed budget ensures
    // those catches never turn a cap or failed read into a partial successful answer.
    const run = async (): ReturnType<Learned> => {
      if (!Array.isArray(input?.features) || input.features.length > 64) refuse();
      const request = Request.safeParse(input);
      if (!request.success || !OrgIdSchema.safeParse(options.companyId).success) refuse();
      if (request.data.workflowMode === undefined || !["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW"].includes(request.data.workflowMode) || !request.data.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
      // The plan check's lessons are part of the knowledge briefing: an older worker is sent exactly what it always was.
      if (request.data.workflowMode === "PLAN_CRITIQUE" && !request.data.features.includes(KNOWLEDGE_CONTEXT_FEATURE)) return {};
      const memo = new Map<string, Promise<StoredDocument | undefined>>();
      const client = { send: async (command: GetCommand) => {
        const answer = await read(() => options.documentClient.send(command));
        // The company reader already validated this workspace; reuse its read below.
        memo.set(JSON.stringify(command.input.Key), Promise.resolve(answer.Item as StoredDocument | undefined));
        return answer;
      } };
      const company = await workspaceCompanyReader(client, options.tableName)(request.data.workspaceId);
      if (company === undefined || company !== options.companyId) refuse();
      const store: DocumentStore = {
        indexes: options.store.indexes,
        async get(key) {
          check();
          const id = JSON.stringify(key);
          let found = memo.get(id);
          if (found === undefined) { found = read(() => options.store.get({ pk: key.pk, sk: key.sk })); memo.set(id, found); }
          return await found;
        },
        async getMany(keys) { return await Promise.all(keys.map((key) => store.get(key))); },
        query: () => refuse(), queryIndex: () => refuse(), put: () => refuse(), update: () => refuse(), delete: () => refuse(), transact: () => refuse(),
      };
      const pointer = await store.get((await workspaceKeys({ store, companyId: company }, request.data.workspaceId)).taskPointerKey());
      const taskId = z.uuid().safeParse(pointer?.["taskId"]);
      if (!taskId.success) refuse();
      const parsed = Task.safeParse(await store.get(taskKey(taskId.data)));
      if (!parsed.success) refuse();
      const task = parsed.data;
      if (task.companyId !== company || task.workspaceId !== request.data.workspaceId || task.taskId !== taskId.data) refuse();
      const now = options.now ?? Date.now;
      const ownTask = async (id: string) => {
        const parsed = SourceTask.safeParse(await store.get(taskKey(id)));
        if (!parsed.success || parsed.data.companyId !== company) return undefined;
        return parsed.data;
      };
      const people: HostedLessonPeople = {
        approvers: (c, p) => read(() => options.people.approvers(c, p)),
        onProjectRoster: (c, p, who) => read(async () => {
          const answer = await options.people.onProjectRoster(c, p, who);
          if (typeof answer !== "boolean") refuse();
          return answer;
        }),
        linkedAccounts: (c, who) => read(() => options.people.linkedAccounts(c, who)),
        displayName: (c, who) => read(() => options.people.displayName(c, who)),
        isErased: (c, who) => read(() => options.people.isErased(c, who)),
        ...(options.people.resolveMember === undefined ? {} : { resolveMember: (c: OrgId, who: string) => read(() => options.people.resolveMember!(c, who)) }),
      };
      const parts = createHostedLessonParts({ companyId: company, people, readTask: ownTask });
      const settings = documentLearningSettings(store);
      const resolved = await resolveLearning(settings, company, task.project);
      check();
      // This read-only input has already checked its own company switch. It does not
      // depend on the broker process having installed the learning-model global gate.
      if (!modeAllows(resolved.chosenMode, "load")) {
        if (resolved.chosenMode === "Off" && await whyLearningOff(settings, company, task.project) === "unreadable") refuse();
        return {};
      }
      const rawSet = await store.get(lessonSetKey(company, task.project));
      if (rawSet === undefined) return {};
      if (rawSet["members"] === null || typeof rawSet["members"] !== "object" || Object.keys(rawSet["members"]).length > DISPATCHER_LESSONS_LIMITS.lessons) refuse();
      const set = SetRecord.safeParse(rawSet);
      if (!set.success) refuse();
      const lessons = new DocumentLessonStore(store, now, (id) => id, () => undefined);
      const all = await lessons.list({ workspaceId: company, project: task.project });
      if (all.length !== Object.keys(set.data.members).length || all.some((lesson) => lesson.workspaceId !== company || lesson.project !== task.project || lesson.version !== set.data.members[lesson.id])) refuse();
      const visible = await readVisible({ access: parts.access, key: { workspaceId: company, project: task.project }, viewer: undefined, lessons: all, where: "load", running: { taskId: task.taskId } });
      const project = await createStoreProjectSource(store, company).revision(task.project, task.startingRevision);
      if (project === undefined) refuse();
      const stage = request.data.workflowMode as "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW";
      const selected = await selectLessons({ store: lessons, settings, vectors: documentLessonVectors(store), access: parts.access, ...(people.resolveMember === undefined ? {} : { resolveMember: (c: OrgId, who: string) => people.resolveMember!(c, who) }), now, audit: { emit: async () => refuse() } }, {
        key: { workspaceId: company, project: task.project }, stage, resolved,
        active: visible.filter((lesson) => lesson.status === "active" && lesson.expiresAt > now() && !hasStaleCitation(lesson)),
        intent: [task.title, task.requestText?.slice(0, 600) ?? ""].join("\n"),
        repos: codeRepositoriesOf(project.definition).map((repo) => repo.name), files: [], languages: [],
        reader: { running: { taskId: task.taskId } }, where: "load", budget: resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES }),
        // The ONE fit floor and the newcomer place (`scoring-settings.ts`): this is a live push.
        push: true,
      });
      check();
      if (!selected.ok || !selected.complete) refuse();
      // The knowledge briefing (lead 4 L4-AK2, L4-AK2b) for a worker that lists it: the look-up's lessons and the measured facts, each on the look-up's own read share and one short clock, and no skill names (this reader has no
      // source for them). Anything that goes wrong here is no part of the briefing, never a refused load. The one write this reader makes is the ids-only delivery record below, after the briefing is built.
      const stageParts = KNOWLEDGE_STAGE_PARTS[stage];
      let knowledgeContext: ReturnType<typeof buildKnowledgeContext>;
      pullDeadline = Math.min(deadline - DISPATCHER_PULL_MARGIN_MS, Date.now() + DISPATCHER_PULL_MS);
      if (request.data.features.includes(KNOWLEDGE_CONTEXT_FEATURE) && (stageParts.pull || stageParts.facts) && Date.now() < pullDeadline) {
        pulling = true;
        let pullTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // ONE clock for both: a read already in flight is raced against the look-up's own limit too, so the look-up ends at its limit whatever a slow read is doing, and the lessons are never waiting on it.
          const clock = new Promise<undefined>((resolve) => { pullTimer = setTimeout(() => { resolve(undefined); }, Math.max(1, pullDeadline - Date.now())); pullTimer.unref?.(); });
          const bounded = <T,>(work: Promise<T>): Promise<T | undefined> => Promise.race([work.catch(() => undefined), clock]);
          const widerRun = stageParts.pull ? selectLessons({ store: lessons, settings, vectors: documentLessonVectors(store), access: parts.access, ...(people.resolveMember === undefined ? {} : { resolveMember: (c: OrgId, who: string) => people.resolveMember!(c, who) }), now, audit: { emit: async () => refuse() } }, {
            key: { workspaceId: company, project: task.project }, stage, resolved,
            active: visible.filter((lesson) => lesson.status === "active" && lesson.expiresAt > now() && !hasStaleCitation(lesson)),
            intent: [task.title, task.requestText?.slice(0, 600) ?? ""].join("\n"),
            repos: codeRepositoriesOf(project.definition).map((repo) => repo.name), files: [], languages: [],
            reader: { running: { taskId: task.taskId } }, where: "load", budget: { lessons: Math.min(KNOWLEDGE_PULL_MAX_UNITS, DISPATCHER_LESSONS_LIMITS.lessons), bytes: 256 * 1024 }, prefilter: async (eligible) => eligible.filter(pullable),
          }) : Promise.resolve(undefined);
          // The base's known-flaky tests (counted by the nightly baseline, never written by a person or a model): one read of THIS company's and project's baseline row, through the same guarded reader. The base branch is the one this task's own revision names.
          const baseBranch = agreedDefaultBranch(project.definition);
          const factsRun = stageParts.facts && baseBranch !== undefined
            ? flakyFactsPort((flakyTask) => baseFlakyTests({ store, now }, flakyTask, { taskBranches: [baseBranch] }))({ companyId: company, project: task.project, stage, files: [], repos: [] })
            : Promise.resolve(undefined);
          const [wider, facts] = await Promise.all([bounded(widerRun), bounded(factsRun)]);
          knowledgeContext = buildKnowledgeContext({ stage, pushed: selected.picked, ...(wider !== undefined && wider.ok && wider.complete ? { pull: wider.picked, pullLeftOut: 0 } : {}), facts });
        } catch { knowledgeContext = undefined; } finally { pulling = false; pullOver = true; if (pullTimer !== undefined) clearTimeout(pullTimer); }
      }
      // The ids this delivery gives, kept once for the operation so the worker's use report can be checked against it (a hosted step's report was dropped for want of this). A store fault, a slow write or a repeated delivery is only "no
      // new record": the briefing still goes. Never STARTED once the call is over or with less than its margin left; a write already started may still land late (it is idempotent: the same ids).
      if (knowledgeContext !== undefined) {
        const room = Math.min(DISPATCHER_RECORD_MS, deadline - Date.now() - DISPATCHER_RECORD_MARGIN_MS);
        if (!stopped && !failed && room > 0) {
          let recordTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const record = deliveryRecordOf({ taskId: task.taskId, project: task.project, learnedLessonIds: selected.chosen.map((lesson) => lesson.id), knowledge: knowledgeContext });
            await Promise.race([writeKnowledgeDeliveryOnce(options.store, { companyId: company, operationId: request.data.operationId, record, now }), new Promise<void>((resolve) => { recordTimer = setTimeout(resolve, room); recordTimer.unref?.(); })]);
          } catch { /* no record: the report of this step is dropped, as it was before */ } finally { if (recordTimer !== undefined) clearTimeout(recordTimer); }
        }
      }
      return selected.chosen.length === 0 && knowledgeContext === undefined ? {} : {
        ...(selected.chosen.length === 0 ? {} : { learnedContext: { v: 1, setVersion: set.data.setVersion, stage, lessons: selected.chosen } }),
        ...(knowledgeContext === undefined ? {} : { knowledgeContext }),
      };
    };
    try {
      return await Promise.race([run(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { stopped = true; reject(agentXError("RUNTIME_UNAVAILABLE", DISPATCHER_LESSONS_UNAVAILABLE)); }, LESSON_LOAD_DEADLINE_MS);
        timer.unref?.();
      })]);
    } catch { return refuse(); }
    finally { stopped = true; if (timer !== undefined) clearTimeout(timer); }
  };
}
