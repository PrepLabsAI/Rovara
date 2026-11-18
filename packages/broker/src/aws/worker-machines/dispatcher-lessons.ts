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
import { hasStaleCitation, LOAD_MAX_BYTES, LOAD_MAX_LESSONS, PUSH_FIT_FLOOR, selectLessons } from "../../lessons/load.js";
import { buildKnowledgeContext, pullable } from "../../lessons/knowledge-brief.js";
import { readVisible } from "../../lessons/read-visible.js";
import { modeAllows, resolveLearning, resolveLoadBudget, whyLearningOff } from "../../lessons/policy.js";
import { workspaceCompanyReader } from "./workspace-company.js";

export const DISPATCHER_LESSONS_UNAVAILABLE = "the dispatcher cannot read lessons for this workspace";
/** ONE budget for the workspace, task, project, settings, lesson heads and live audience reads. */
export const DISPATCHER_LESSONS_LIMITS = { reads: 128, items: 512, bytes: 1_048_576, lessons: 100 } as const;
/** The look-up's own share of the reads: it runs after the lessons, and a look-up that would pass this share is left out; it can never fail the lessons. */
export const DISPATCHER_PULL_READS = 40;
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
    // The look-up (lead 4 L4-AK2) runs on a share of its own: past it a read throws HERE, before it is counted, so the look-up ends without failing the lessons' budget.
    let pulling = false;
    let pullReads = 0;
    const read = async <T>(work: () => Promise<T>, count = 1): Promise<T> => {
      check();
      if (pulling && ++pullReads > DISPATCHER_PULL_READS) throw new PullBudgetSpent();
      reads++; items += count;
      if (reads > DISPATCHER_LESSONS_LIMITS.reads || items > DISPATCHER_LESSONS_LIMITS.items) { failed = true; refuse(); }
      try {
        const answer = await work();
        check();
        bytes += Buffer.byteLength(JSON.stringify(answer) ?? "", "utf8");
        if (bytes > DISPATCHER_LESSONS_LIMITS.bytes) { failed = true; refuse(); }
        return answer;
      } catch { failed = true; return refuse(); }
    };
    // The shared lesson selector can catch dependency failures. A sticky failed budget ensures
    // those catches never turn a cap or failed read into a partial successful answer.
    const run = async (): ReturnType<Learned> => {
      if (!Array.isArray(input?.features) || input.features.length > 64) refuse();
      const request = Request.safeParse(input);
      if (!request.success || !OrgIdSchema.safeParse(options.companyId).success) refuse();
      if (request.data.workflowMode === undefined || !["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW"].includes(request.data.workflowMode) || !request.data.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
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
        ...(request.data.features.includes(KNOWLEDGE_CONTEXT_FEATURE) ? { fitFloor: PUSH_FIT_FLOOR } : {}),
      });
      check();
      if (!selected.ok || !selected.complete) refuse();
      // The knowledge briefing (lead 4 L4-AK2) for a worker that lists it: the look-up's lessons on their own read share, and no facts or skill names (this reader has no source for them). Anything that goes wrong here is no
      // briefing, never a refused load. This reader writes nothing, so it leaves no delivery record: a use report for such a step cannot be checked and is not kept.
      let knowledgeContext: ReturnType<typeof buildKnowledgeContext>;
      if (request.data.features.includes(KNOWLEDGE_CONTEXT_FEATURE) && KNOWLEDGE_STAGE_PARTS[stage].pull) {
        pulling = true;
        try {
          const wider = await selectLessons({ store: lessons, settings, vectors: documentLessonVectors(store), access: parts.access, ...(people.resolveMember === undefined ? {} : { resolveMember: (c: OrgId, who: string) => people.resolveMember!(c, who) }), now, audit: { emit: async () => refuse() } }, {
            key: { workspaceId: company, project: task.project }, stage, resolved,
            active: visible.filter((lesson) => lesson.status === "active" && lesson.expiresAt > now() && !hasStaleCitation(lesson)),
            intent: [task.title, task.requestText?.slice(0, 600) ?? ""].join("\n"),
            repos: codeRepositoriesOf(project.definition).map((repo) => repo.name), files: [], languages: [],
            reader: { running: { taskId: task.taskId } }, where: "load", budget: { lessons: Math.min(KNOWLEDGE_PULL_MAX_UNITS, DISPATCHER_LESSONS_LIMITS.lessons), bytes: 256 * 1024 }, prefilter: async (eligible) => eligible.filter(pullable),
          });
          if (wider.ok && !failed) knowledgeContext = buildKnowledgeContext({ stage, pushed: selected.picked, pull: wider.picked, pullLeftOut: 0 });
        } catch { knowledgeContext = undefined; } finally { pulling = false; }
        if (failed) refuse();
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
