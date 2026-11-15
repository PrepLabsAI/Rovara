// Engine host (lane LM1/LM2/LM3, DEC 225/226): lessons on the core engine of a deployed install, for ONE company. The laptop's counterpart is `local/app/lessons.ts`; both join the lessons library through
// `lessons/host-glue.ts`, so loading, the pull request's "Lessons used" section, capture and the daily upkeep behave the same. What differs here:
//
//   THE SWITCH  `ROVARA_CORE_LESSONS`: `off` (or absent, or empty: the DEFAULT), `on` (every company the core serves), or `on:<company id>[:<company id>...]`. Anything else is OFF and reported (a typo never
//               switches a company on). For a company the switch does not cover nothing is built: no step is given a lesson, nothing is queued, no model call is made and the task flow's lessons slots stay
//               empty (byte-identical to an install without lessons). The library's own install switch (`setLearnedLessonsGate`) is set from the same variable, so no learning model call is made anywhere
//               while it is off, whatever path asks (DEC 47).
//   PEOPLE      who approves, who reads and who a lesson may name come from the deployment's `HostedLessonPeople` port, for this company only (`lessons/hosted-people.ts`); never the laptop's one owner.
//   THE MODEL   learning calls (the reflector, the curator's judge, the outcome judge) go through the injected `learning` port: the model gateway on the company's own AI account with its learning cap
//               (DEC 226: $20 a month per company) on a deployed install, a fake in tests. Absent: every learning call refuses and nothing is spent; lessons still load and the pages still work.
//   THE QUEUE   the reflection queue is one per install; each message names its company and the pass hands it to THAT company's lessons (`hostFor`), so a company only learns from its own tasks.
//   COMPANY     every key the library writes is under the company's own partition (`companyScoped`, `teamRecordPk(company, project)`), and every task it reads is checked to be this company's.
//
// Wiring (the deployment, per company, in the runtime's `services`): `const lessons = createCoreLessons({ flow, ... }); lessons?.attach(); return { ..., ...(lessons === undefined ? {} : { lessons: lessons.service }) }`.
// The worker callbacks then hand a step's events to `lessons.host.onEvents`.
import { codeRepositoriesOf, companyScoped, orgProjectCatalogKey, queryAll, type AdapterRegistry, type AuditSink, type DocumentStore, type LearningAdapter, type LessonVectors, type OrgId, type RegistryView } from "@agentx/contracts";
import { createDocumentMilestones, type DocumentMilestones } from "../core/milestones/milestones.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { readTask } from "../core/task-flow/reads.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { createLessonsHost, pumpReflectQueue, type LessonsHost } from "../lessons/host-glue.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { setLearnedLessonsGate, type Edition } from "../lessons/policy.js";
import { gatedByLessonsSwitch } from "../lessons/model-gate.js";
import type { LearningSpend, PipelineModel } from "../lessons/ports.js";
import { createLessonsRuntime, type LessonsRuntime } from "../lessons/runtime.js";
import { lessonDeletionPort } from "../lessons/deletion.js";
import { DocumentLessonStore } from "../lessons/document-store.js";
import { documentLessonVectors } from "../lessons/document-vectors.js";
import { lessonAuditSink } from "../lessons/audit-sink.js";
import type { CodeFactsReader } from "../lessons/code-facts.js";
import type { TaskSubjectSource } from "../lessons/task-end.js";
import type { OutcomeRowReader } from "../lessons/task-outcome-rows.js";
import type { RepositoryVisibility } from "../lessons/used-in-pr.js";
import { createLessonRepositories } from "../local/app/lessons-repos.js";
import { createLocalLessonSources } from "../local/app/lessons-sources.js";
import type { CoreService } from "./core-runtime.js";
import { parseCoreSwitch, switchCovers, type CoreSwitch } from "./flags.js";

export const CORE_LESSONS_VARIABLE = "ROVARA_CORE_LESSONS";

/** The lessons switch from a function's environment. `drain` has no meaning for lessons and reads as off. Fail closed: anything that is not exactly a switch value is off, with a problem that never echoes it. */
export function readCoreLessonsSwitch(env: NodeJS.ProcessEnv = process.env): { value: CoreSwitch; problem?: string } {
  const parsed = parseCoreSwitch(env[CORE_LESSONS_VARIABLE]);
  if (parsed.drain === true) return { value: { mode: "off" }, problem: "not off, on or on:<company ids> (the engine's wind-down value has no meaning for lessons)" };
  return parsed.problem === undefined ? { value: parsed.value } : { value: parsed.value, problem: parsed.problem };
}

/** The install-wide gate the library asks before every learning model call: on only while the switch covers some company. */
export function setCoreLessonsGate(env: NodeJS.ProcessEnv = process.env): void {
  setLearnedLessonsGate(() => readCoreLessonsSwitch(env).value.mode !== "off");
}

/** The name lessons record for the system itself (never a person; never a name a lesson may carry). */
const SYSTEM_ACTOR = { id: "rovara-system", name: "Rovara" };
/** How many messages one pass takes off the shared reflection queue. */
const REFLECT_PER_PASS = 4;
/** The daily upkeep's marker, in the company's partition. */
const nightlyKey = (companyId: OrgId) => ({ pk: companyScoped(companyId, "LESSONS_NIGHTLY"), sk: "DAY" });

export interface CoreLessonsOptions {
  flow: TaskFlow;
  registry: AdapterRegistry | RegistryView;
  companyId: OrgId;
  /** The switch (`readCoreLessonsSwitch`). Lessons are built only where it covers `companyId`. */
  lessonsSwitch: CoreSwitch;
  people: HostedLessonPeople;
  /** The person a code host account is linked to, for the review comments a task's pull requests got. Absent: the account's own name. */
  personOfAccount?: (companyId: OrgId, provider: string, login: string) => Promise<string | undefined>;
  /** The model-access port for learning calls (the gateway on the company's own account, with its learning cap). Absent: learning calls refuse and nothing is spent. */
  learning?: { model: PipelineModel; spend: LearningSpend } | undefined;
  /** How lessons are compared (an embedder and where vectors live). Absent: keywords and cited paths, the vectors beside the lessons. */
  learningAdapter?: LearningAdapter | undefined;
  /** The lessons of another company, for a message of the shared reflection queue that names it. Undefined: lessons are off for that company (the message is removed). */
  hostFor: (companyId: string) => Promise<Pick<LessonsHost, "reflectOne"> | undefined>;
  edition?: Edition;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface CoreLessons {
  readonly companyId: OrgId;
  readonly runtime: LessonsRuntime;
  readonly host: LessonsHost;
  /** The milestones the task flow writes (merged, closed, ...) and that capture hears. */
  readonly milestones: DocumentMilestones;
  /** What a finished task of this company teaches (its record, its people's words, its outcome rows), with each person's standing read now. */
  readonly sources: { source: TaskSubjectSource; rows: OutcomeRowReader };
  /** The task, when it is this company's (company, project and person). */
  readTask(taskId: string): Promise<{ companyId: string; project: string; developerId: string } | undefined>;
  /** Fills the task flow's lessons slots (`learned`, `lessonsUsed`, `milestones`). Call once, before the first task of the company is started or dispatched. */
  attach(): void;
  /** The scheduled pass: milestones due, the shared reflection queue, and once a day the upkeep of the company's projects. */
  readonly service: CoreService;
}

/** Lessons for one company on the core, or undefined when the switch does not cover it (nothing is built). */
export function createCoreLessons(options: CoreLessonsOptions): CoreLessons | undefined {
  const { flow, registry, companyId, now } = options;
  if (!switchCovers(options.lessonsSwitch, companyId)) return undefined;
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "core-lessons", companyId, event, ...fields });
  const enabled = (): boolean => switchCovers(options.lessonsSwitch, companyId);
  const deps = flow.deps;
  const repositories = createLessonRepositories({ flow: deps, registry, companyId, now });

  const reader: CodeFactsReader = {
    async file(input) {
      if (input.workspaceId !== companyId) return undefined;
      const repo = (await repositories.ofProject(input.project)).find((candidate) => candidate.name === input.repo);
      return repo === undefined ? undefined : repo.codeHost.fileAtRevision(repo.repository, input.path, input.commit, repo.scope, { timeoutMs: input.timeoutMs });
    },
    async kind(input) {
      if (input.workspaceId !== companyId) return undefined;
      const repo = (await repositories.ofProject(input.project)).find((candidate) => candidate.name === input.repo);
      if (repo === undefined || repo.codeHost.pathKind === undefined) return undefined;
      const kind = await repo.codeHost.pathKind(repo.repository, input.path, input.commit, repo.scope, { timeoutMs: input.timeoutMs });
      return kind === "symlink" ? undefined : kind;
    },
  };
  const readOwnTask = async (taskId: string) => {
    const task = await readTask(deps, taskId);
    return task === undefined || task.companyId !== companyId ? undefined : { companyId: task.companyId, project: task.project, developerId: task.developerId };
  };
  // The model is gated on this company's switch as well as the install's: no learning call for a company the switch stopped covering.
  const model = options.learning === undefined ? undefined : gatedByLessonsSwitch(options.learning.model, enabled);

  const runtime = createLessonsRuntime({
    store: deps.store, companyId, now, log: (event, fields) => log(event, fields), audit: registry.require("audit-sink"), reader,
    repositoriesOf: async (workspaceId, project) => {
      if (workspaceId !== companyId) return [];
      const latest = await deps.projects.latest(project);
      return latest === undefined ? [] : codeRepositoriesOf(latest.definition).map((repository) => repository.name);
    },
    owner: SYSTEM_ACTOR, taskProject: async (workspaceId, taskId) => (workspaceId !== companyId ? undefined : (await readOwnTask(taskId))?.project),
    projectRepoScopes: repositories.scopes(), learning: options.learningAdapter, edition: options.edition ?? "public",
    ...(model === undefined || options.learning === undefined ? {} : { model, spend: options.learning.spend }),
    hosted: { people: options.people, readTask: readOwnTask },
  });

  const blobs = registry.require("object-storage");
  const readText = textReaderOf(blobs);
  const sources = createLocalLessonSources({
    flow: deps, companyId, ownerId: SYSTEM_ACTOR.id, repos: repositories, readObject: readText, now, log: (event, fields) => log(event, fields),
    hosted: { people: options.people, ...(options.personOfAccount === undefined ? {} : { personOfAccount: options.personOfAccount }) },
  });
  const host = createLessonsHost({
    flow: deps, runtime, companyId, blobs, queues: registry.require("queue"), enabled, sources: { source: sources.source, rows: sources.rows },
    visibility: async (project): Promise<RepositoryVisibility> => {
      const found = await repositories.ofProject(project);
      if (found.length === 0) return "unknown";
      if (found.some((repository) => repository.private === false)) return "public";
      return found.every((repository) => repository.private === true) ? "private" : "unknown";
    },
    now, log,
  });

  const milestones = createDocumentMilestones({ store: deps.store, now, log: (event, fields) => log(`milestones.${event}`, fields) });
  milestones.register(host.milestone);

  async function projectNames(): Promise<string[]> {
    const page = await deps.store.query({ pk: orgProjectCatalogKey(companyId, "x").pk, limit: 200 }).catch(() => ({ items: [] as Array<{ sk: string }> }));
    return page.items.map((item) => item.sk).filter((sk) => sk.startsWith("PROJECT#")).map((sk) => sk.slice("PROJECT#".length));
  }

  /** Whether today's upkeep is still to run: the first pass of a day claims it, so two passes never run it twice. */
  async function claimNightly(): Promise<boolean> {
    const day = Math.floor(now() / 86_400_000);
    const written = await deps.store.put({
      item: { ...nightlyKey(companyId), entityType: "LESSONS_NIGHTLY", day },
      condition: { op: "or", conditions: [{ op: "notExists", path: ["pk"] }, { op: "lt", path: ["day"], value: day }] },
    });
    return written.applied;
  }

  const service: CoreService = {
    async pass({ budgetMs }) {
      if (!enabled()) return { skipped: "lessons_off" };
      const started = now();
      const delivered = await milestones.deliverDue().catch((error: unknown) => { log("milestones_failed", { error: error instanceof Error ? error.name : "unknown" }); return { attempted: 0 }; });
      const reflected = await pumpReflectQueue({ queues: registry.require("queue"), hostFor: options.hostFor, perPass: REFLECT_PER_PASS, now, log }).catch((error: unknown) => {
        log("reflect_pass_failed", { error: error instanceof Error ? error.name : "unknown" });
        return { received: 0, reflected: 0, dropped: 0, retried: 0 };
      });
      let nightly = false;
      if (now() - started < budgetMs / 2 && await claimNightly().catch(() => false)) {
        nightly = true;
        await host.nightly(await projectNames()).catch((error: unknown) => log("nightly_failed", { error: error instanceof Error ? error.name : "unknown" }));
      }
      return { milestones: delivered.attempted, ...reflected, nightly };
    },
  };

  let attached = false;
  function attach(): void {
    if (attached) return;
    attached = true;
    deps.learned = (input) => host.learnedFor(input);
    deps.lessonsUsed = (task, repositoryId) => host.usedInPullRequest(task, repositoryId);
    deps.milestones = milestones;
  }

  return { companyId, runtime, host, milestones, sources: { source: sources.source, rows: sources.rows }, readTask: readOwnTask, attach, service };
}

/** The most projects one erase call walks; a company with more gets `complete: false` and the erase calls again. */
export const LESSONS_ERASE_PROJECTS_MAX = 200;

export interface ErasePersonLessonsReport {
  /** Every project of the company was walked and every step finished. False: call again (the steps are idempotent). */
  complete: boolean;
  projects: number;
  purged: number;
  scrubbed: number;
  /** Rows that named the person outside a lesson (a comment's retire request) and were removed. */
  rows: number;
}

/**
 * The lessons part of erasing one person of a company (row 13.1; the person erase of the core calls it). It runs WHATEVER the lessons switch says: lessons that exist must be erased even when the switch
 * is off. For each project of the company: every lesson the person wrote or that rests only on their words is hard-deleted (head, versions, vector, load references), the person is scrubbed from the
 * rest and from every audience snapshot, and the person's retire requests are removed. Only this company's partitions are touched. Throws on a failed step (the caller retries; nothing reports done early).
 */
export async function erasePersonLessons(input: { store: DocumentStore; audit: AuditSink; companyId: OrgId; personId: string; now: () => number; vectors?: LessonVectors; log?: (entry: Record<string, unknown>) => void }): Promise<ErasePersonLessonsReport> {
  const { store, companyId, personId, now } = input;
  const lessons = new DocumentLessonStore(store, now, (id) => id, () => undefined);
  const deletion = lessonDeletionPort({ store: lessons, vectors: input.vectors ?? documentLessonVectors(store), audit: lessonAuditSink(input.audit, now, companyId), now });
  const catalog = await store.query({ pk: orgProjectCatalogKey(companyId, "x").pk, limit: LESSONS_ERASE_PROJECTS_MAX + 1 });
  const projects = catalog.items.map((item) => item.sk).filter((sk) => sk.startsWith("PROJECT#")).map((sk) => sk.slice("PROJECT#".length));
  const walked = projects.slice(0, LESSONS_ERASE_PROJECTS_MAX);
  let purged = 0;
  let scrubbed = 0;
  let rows = 0;
  for (const project of walked) {
    await deletion.resumePending(companyId, project);
    const done = await deletion.erasePerson(companyId, project, { developerId: personId }, new Set());
    purged += done.purged.length;
    scrubbed += done.scrubbed.length;
    await deletion.scrubAudienceIds(companyId, project, [personId]);
    for (const row of await queryAll(store, { pk: companyScoped(companyId, `LESSON_RETIRE_ASK#${project}`) })) {
      if (row["personId"] !== personId) continue;
      await store.delete({ key: { pk: row.pk, sk: row.sk } });
      rows += 1;
    }
  }
  input.log?.({ component: "core-lessons", companyId, event: "person_erased", projects: walked.length, purged, scrubbed, rows });
  return { complete: projects.length <= LESSONS_ERASE_PROJECTS_MAX && catalog.cursor === undefined, projects: walked.length, purged, scrubbed, rows };
}
