import { WORKSPACE_PROJECT_INDEX, codeRepositoriesOf, workspaceProjectIndexValue, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { taskKey, workspaceKey } from "../core/task-flow/keys.js";
import { fromDocument, type TaskRecord } from "../core/task-flow/records.js";
import type { LessonsRuntime } from "./runtime.js";
import { LOAD_MAX_BYTES, LOAD_MAX_LESSONS, selectLessons } from "./load.js";
import { resolveLoadBudget, resolveLearning } from "./policy.js";
import { hasStaleCitation } from "./trial.js";
import { compareLessonReplay, type ReplayLoadInput } from "./replay.js";
import { readVisible } from "./read-visible.js";
import { INTENT_REQUEST_CHARS } from "./host-glue.js";

/** Replay recent finished tasks through the current selector. Every task and lesson read is company and project scoped. */
export async function replayProjectLessons(input: {
  companyId: OrgId;
  project: string;
  limit: number;
  store: DocumentStore;
  projects: Pick<TaskFlowDeps["projects"], "revision">;
  runtime: LessonsRuntime;
  now: () => number;
  /** The live load's plan reading (`taskPlanLoadFacts`): the latest stored plan's summary and named files. Absent: the replay ranks by title and request alone. */
  planFacts?: ((task: TaskRecord) => Promise<{ summary: string; files: readonly string[] } | undefined>) | undefined;
}): Promise<ReturnType<typeof compareLessonReplay>> {
  const { companyId, project, limit, store, projects, runtime } = input;
  const key = { workspaceId: companyId, project };
  const at = input.now();
  // Replay uses stored vectors but never invokes an embedding model or a lesson write/measurement sink.
  const replayDeps = { ...runtime.load, now: () => at, embedder: undefined, measure: undefined };
  const candidates: TaskRecord[] = [];
  let cursor: string | undefined;
  // The sparse project index is company-prefixed and contains only workspace META rows. Bound the scan so a large index cannot return a partial replay.
  for (let pageNo = 0; pageNo < 20 && candidates.length < limit; pageNo++) {
    const page = await store.queryIndex({ index: WORKSPACE_PROJECT_INDEX.name, partition: workspaceProjectIndexValue(companyId, project), descending: true, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) {
      if (row.entityType !== "WORKSPACE" || row.companyId !== companyId || row.orgId !== companyId || row.projectName !== project || typeof row.id !== "string") continue;
      const pointer = await store.get({ ...workspaceKey(companyId, row.id), sk: "DEVELOPER_TASK" });
      const taskId = pointer?.["taskId"];
      if (typeof taskId !== "string") continue;
      const task = fromDocument<TaskRecord>(await store.get(taskKey(taskId)));
      if (task === undefined || task.companyId !== companyId || task.project !== project || task.closedAt === undefined) continue;
      candidates.push(task);
      if (candidates.length >= limit) break;
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  if (candidates.length < limit && cursor !== undefined) throw new Error("lesson replay history exceeded its read bound");

  const resolved = await resolveLearning(replayDeps.settings, companyId, project);
  const active = (await replayDeps.store.list(key, { statuses: ["active"] })).filter((lesson) => lesson.expiresAt > at && !hasStaleCitation(lesson));
  const reposByRevision = new Map<number, string[]>();
  const loads: ReplayLoadInput[] = [];
  for (const task of candidates) {
    const manifests = (await runtime.store.manifests(key, task.taskId)).filter((manifest) => manifest.workspaceId === companyId && manifest.project === project && manifest.memory === "live");
    if (manifests.length === 0) continue;
    // Historical ids can outlive their lessons' visibility or active status. Check the heads, including retired ones,
    // for the same task audience the selector uses; missing heads and unreadable sources disclose no ids or diff counts.
    const historical = await Promise.all([...new Set(manifests.flatMap((manifest) => manifest.lessons.map((entry) => entry.id)))].map((id) => runtime.store.get(key, id)));
    const visible = new Set((await readVisible({
      access: replayDeps.access, key, viewer: undefined, running: { taskId: task.taskId },
      lessons: historical.flatMap((lesson) => lesson === undefined ? [] : [lesson]), where: "replay", log: replayDeps.log,
    })).map((lesson) => lesson.id));
    let repos = reposByRevision.get(task.startingRevision);
    if (repos === undefined) {
      const revision = await projects.revision(project, task.startingRevision);
      repos = revision === undefined ? [] : codeRepositoriesOf(revision.definition).map((repo) => repo.name);
      reposByRevision.set(task.startingRevision, repos);
    }
    // The same task facts the live load ranked by (`host-glue.ts` learnedFor): the plan reading, the request cut to the same length, the plan's files capped the same. A fix round's correction text is not stored, so it is not replayed.
    const plan = input.planFacts === undefined ? undefined : await input.planFacts(task).catch(() => undefined);
    const intent = [task.title, (task.requestText ?? "").slice(0, INTENT_REQUEST_CHARS)].filter((part) => part.trim() !== "").join("\n");
    const files = [...new Set(plan?.files ?? [])].slice(0, 50);
    for (const manifest of manifests) {
      const selection = await selectLessons(replayDeps, {
        key, stage: manifest.stage, resolved, active, intent, ...(plan?.summary === undefined || plan.summary === "" ? {} : { planSummary: plan.summary }),
        repos, files, languages: [], reader: { running: { taskId: task.taskId } }, where: "replay",
        budget: resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES }), push: true,
      });
      loads.push({ taskId: task.taskId, stage: manifest.stage, round: manifest.round, actual: manifest.lessons.filter((entry) => visible.has(entry.id)).map((entry) => entry.id), replayed: selection.ok ? selection.picked.map((lesson) => lesson.id) : [] });
    }
  }
  return compareLessonReplay(loads);
}
