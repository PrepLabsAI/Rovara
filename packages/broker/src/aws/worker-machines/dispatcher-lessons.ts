// L10: a read-only learned input for ONE company's dispatcher runtime. L6 composes this
// with hostedDispatcherFlow. The workspace record, never the job payload, vouches for scope.
import { AgentXNameSchema, LEARNED_CONTEXT_FEATURE, OrgIdSchema, agentXError, codeRepositoriesOf, lessonSetKey, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { z } from "zod";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { taskKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { switchCovers, type CoreSwitch } from "../../core-host/flags.js";
import { DocumentLessonStore } from "../../lessons/document-store.js";
import { documentLearningSettings } from "../../lessons/document-settings.js";
import { documentLessonVectors } from "../../lessons/document-vectors.js";
import { createHostedLessonParts, type HostedLessonPeople } from "../../lessons/hosted-people.js";
import { LESSON_LOAD_DEADLINE_MS } from "../../lessons/host-glue.js";
import { hasStaleCitation, LOAD_MAX_BYTES, LOAD_MAX_LESSONS, selectLessons } from "../../lessons/load.js";
import { modeAllows, resolveLearning, resolveLoadBudget, whyLearningOff } from "../../lessons/policy.js";
import { workspaceCompanyReader } from "./workspace-company.js";

export const DISPATCHER_LESSONS_UNAVAILABLE = "the dispatcher cannot read lessons for this workspace";
/** ONE budget for the workspace, task, project, settings, lesson heads and live audience reads. */
export const DISPATCHER_LESSONS_LIMITS = { reads: 128, items: 512, bytes: 1_048_576, lessons: 100 } as const;
type Learned = NonNullable<TaskFlowDeps["learned"]>;
function refuse(): never { throw agentXError("RUNTIME_UNAVAILABLE", DISPATCHER_LESSONS_UNAVAILABLE); }
const Request = z.object({ workspaceId: z.uuid(), operationId: z.uuid(), workflowMode: z.enum(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW", "CHECKS", "FEEDBACK_REVIEW", "SETUP_DRAFT", "SETUP_AGENT", "SPEC_WRITE"]).optional(), features: z.array(z.string().max(100)).max(64) });
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
    const read = async <T>(work: () => Promise<T>, count = 1): Promise<T> => {
      check();
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
      if (request.data.workflowMode === undefined || !["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"].includes(request.data.workflowMode) || !request.data.features.includes(LEARNED_CONTEXT_FEATURE)) return {};
      const client = { send: (command: never) => read(() => options.documentClient.send(command)) };
      const company = await workspaceCompanyReader(client, options.tableName)(request.data.workspaceId);
      if (company === undefined || company !== options.companyId) refuse();
      const memo = new Map<string, Promise<StoredDocument | undefined>>();
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
      const pointer = await store.get(taskPointerKey(request.data.workspaceId));
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
      const project = await createStoreProjectSource(store, company).revision(task.project, task.startingRevision);
      if (project === undefined) refuse();
      const stage = request.data.workflowMode as "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "REVIEW";
      const selected = await selectLessons({ store: lessons, settings, vectors: documentLessonVectors(store), access: parts.access, ...(people.resolveMember === undefined ? {} : { resolveMember: (c: OrgId, who: string) => people.resolveMember!(c, who) }), now, audit: { emit: async () => refuse() } }, {
        key: { workspaceId: company, project: task.project }, stage, resolved,
        active: all.filter((lesson) => lesson.status === "active" && lesson.expiresAt > now() && !hasStaleCitation(lesson)),
        intent: [task.title, task.requestText?.slice(0, 600) ?? ""].join("\n"),
        repos: codeRepositoriesOf(project.definition).map((repo) => repo.name), files: [], languages: [],
        reader: { running: { taskId: task.taskId } }, where: "load", budget: resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES }),
      });
      check();
      if (!selected.ok || !selected.complete) refuse();
      return selected.chosen.length === 0 ? {} : { learnedContext: { v: 1, setVersion: set.data.setVersion, stage, lessons: selected.chosen } };
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
