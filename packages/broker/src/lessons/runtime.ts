// The lessons library's ports, assembled once from an install's own parts: its document store, its audit sink, what it can read of a repository at a commit, its model and spend path, its learning adapter and who the
// approver is. Nothing here names a provider; the broker (`local/app/lessons.ts` on a laptop) gives the parts and keeps the result.
//
// What is real: the document lesson store, the settings reader (the project's mode, the company lock, the tier-0 setting), the access check, the approver directory, the citation verifier and the code facts (the code
// host's file reads at a commit), the audit sink, the vectors and the pause store. The model and the spend path are given by the install; without them `judgeModel` and `spend` refuse (a curator judgement fails closed: a
// contradiction goes to a person) and the correction judge of the counters refuses too. Lesson similarity (keywords, cited paths and the optional embedder, fused; the vectors kept with the lessons) plugs in through the
// learning adapter.
import type { AuditSink, DocumentStore, LearningAdapter, LessonVectors, OrgId } from "@agentx/contracts";
import { lessonAuditSink } from "./audit-sink.js";
import type { ApproveDeps } from "./approve.js";
import { createLocalApproverDirectory, createLocalTier0Authority } from "./directory.js";
import { createLocalAccessCheck, type AccessCheckPort } from "./access-port.js";
import { createCitationVerifier } from "./citation-verifier.js";
import { createCodeFacts, type CodeFactsReader } from "./code-facts.js";
import type { CounterDeps } from "./counters.js";
import type { CurateDeps } from "./curate.js";
import { lessonDeletionPort, type LessonDeletionPort } from "./deletion.js";
import { DocumentLessonStore } from "./document-store.js";
import { documentLearningSettings, DocumentPresetStore, DocumentSoleOwnerSwitch, DocumentTier0Settings } from "./document-settings.js";
import { documentLessonVectors } from "./document-vectors.js";
import { modelCorrectionJudge } from "./judge-model.js";
import type { LoadDeps } from "./load.js";
import { gatedByLessonsSwitch } from "./model-gate.js";
import { documentPauseStore, type LessonsPauseStore } from "./pause.js";
import type { AttributionReader } from "./people.js";
import type { Edition, LearningSettingsReader } from "./policy.js";
import type { PresetDeps } from "./preset-setting.js";
import type { CorrectionJudge, LearningSpend, LessonAuditSink, PipelineModel } from "./ports.js";
import type { ProcessDeps } from "./process.js";
import { projectRepoScopesOf, withProjectRepoScopes, type ProjectRepoScopesPort } from "./project-repo-audience.js";
import type { RepoFileRuntime } from "./repo-file-job.js";
import type { LessonStore } from "./store.js";
import { localLessonAudiencePort, withLessonAudiences } from "./task-audience.js";
import type { TaskVisibilityPort } from "./access-port.js";
import type { LessonViewDeps } from "./view.js";

export interface LessonsRuntimeInput {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The `audit-sink` point. */
  audit: AuditSink;
  /** The code host's file reads at a commit, for citations and code facts. */
  reader: CodeFactsReader;
  repositoriesOf: (workspaceId: string, project: string) => Promise<readonly string[]>;
  /** The person who owns this install: the one approver, and the name the lessons page gives them. */
  owner: { id: string; name: string };
  /** The accounts the owner has on outside systems (a code host's account ids), for the checks on restricted places. */
  linkedAccounts?: (developerId: string) => Promise<readonly string[]>;
  /** The project a task belongs to (undefined: no such task), for the live audience of the tasks a lesson was learned from. */
  taskProject: (workspaceId: string, taskId: string) => Promise<string | undefined>;
  /** The project's repositories as places (`<host>:repo/<id>`), read live. Absent: no lesson restricted to repository readers is treated as project-wide. */
  projectRepoScopes?: ProjectRepoScopesPort;
  /** The model the curator's judge calls and the spend look. Absent: the refusing stand-ins, so nothing is judged or spent. */
  model?: PipelineModel;
  spend?: LearningSpend;
  edition?: Edition;
  /** The learning adapter: the optional embedder and where vectors live. Absent: keywords and cited paths, vectors beside the lessons. */
  learning?: LearningAdapter | undefined;
  /** Whether a recorded pause reason still holds (`LessonViewDeps.pauseStillApplies`). */
  pauseStillApplies?: LessonViewDeps["pauseStillApplies"];
}

/** The route-side lesson dependencies: everything the pages, commands and routes need to read and decide lessons. */
export type LessonRouteDeps = LessonViewDeps & ApproveDeps & ProcessDeps & CounterDeps & { presets: PresetDeps };

export interface LessonsRuntime {
  readonly store: LessonStore;
  readonly documents: DocumentStore;
  readonly settings: LearningSettingsReader;
  readonly access: AccessCheckPort;
  readonly directory: ApproveDeps["directory"];
  readonly audit: LessonAuditSink;
  readonly pause: LessonsPauseStore;
  readonly vectors: LessonVectors;
  readonly deletion: LessonDeletionPort;
  /** What the loader needs at a stage's dispatch. */
  readonly load: LoadDeps;
  /** What `applyLoadReport` and the task-end counting need. */
  readonly counters: CounterDeps;
  /** What the pages, the commands and the routes need. */
  readonly routes: LessonRouteDeps;
  /** The reflector's and the curator's own dependencies. */
  readonly process: ProcessDeps;
  readonly judgeModel: PipelineModel;
  readonly spend: LearningSpend;
  readonly edition: Edition;
  /** What the loader is told about a task besides its title: a summary of the approved plan and the files it names (`plan-facts.ts`). Absent: the title and request alone. */
  planFacts?: (task: { orgId?: string | undefined; taskId: string; workflow?: unknown }) => Promise<{ summary: string; files: readonly string[] } | undefined>;
  /** The weekly file pass and its routes. Set where the project's repositories and their code hosts can be reached. */
  repoFile?: RepoFileRuntime;
}

const noModel = (): never => { throw new Error("no learning model is set up in this install"); };
/** No pipeline model: every call fails, so nothing is judged, reflected or rated by a model. */
export const REFUSING_MODEL: PipelineModel = { complete: async () => noModel() };
/** Never usable: with no model nothing can be rated, so nothing is recorded and no helpful mark is queued (fails safe). */
export const REFUSING_JUDGE: CorrectionJudge = { rate: async () => noModel(), usable: async () => false };
/** No payer path: nothing is admitted and nothing is charged. */
export const DENYING_SPEND: LearningSpend = { admit: async () => false };

export function createLessonsRuntime(input: LessonsRuntimeInput): LessonsRuntime {
  const store = new DocumentLessonStore(input.store, input.now, (id) => id, (event, fields) => input.log?.(event, fields));
  const tier0 = new DocumentTier0Settings(input.store);
  const settings = documentLearningSettings(input.store, tier0);
  const owner = input.owner;
  const audiences = localLessonAudiencePort({ ownerId: owner.id, projectOf: (orgId, taskId) => input.taskProject(orgId, taskId) });
  const baseVisibility: TaskVisibilityPort = { async read(_orgId, taskIds) { return new Map(taskIds.map((id) => [id, { kind: "shared" as const }])); } };
  const withAudiences = withLessonAudiences(baseVisibility, audiences);
  const taskVisibility = input.projectRepoScopes === undefined ? withAudiences : withProjectRepoScopes(withAudiences, input.projectRepoScopes);
  const access = createLocalAccessCheck({ taskVisibility });
  const directory = createLocalApproverDirectory({ ownerId: owner.id, ...(input.linkedAccounts === undefined ? {} : { linkedAccounts: input.linkedAccounts }) });
  const audit = lessonAuditSink(input.audit, input.now, input.companyId);
  const base = { now: input.now, audit, ...(input.log === undefined ? {} : { log: input.log }) };
  const facts = createCodeFacts({ reader: input.reader, repositoriesOf: async (workspaceId, project) => input.repositoriesOf(workspaceId, project) });
  const verifier = createCitationVerifier({ reader: input.reader, repositoriesOf: input.repositoriesOf });
  const embedder = input.learning?.embedder?.(input.companyId);
  const vectors = input.learning?.vectors?.(input.companyId) ?? documentLessonVectors(input.store);
  const pause = documentPauseStore(input.store, input.now, (event, fields) => input.log?.(event, fields));
  const edition: Edition = input.edition ?? "enterprise";
  const model = input.model;
  const spend = input.spend ?? DENYING_SPEND;
  const judgeModel = model === undefined ? REFUSING_MODEL : gatedByLessonsSwitch(model);
  const load: LoadDeps = { ...base, store, embedder, vectors, settings, access };
  const outcomeJudge = model === undefined || input.spend === undefined ? REFUSING_JUDGE : modelCorrectionJudge({ model, spend, pause, edition });
  const counters: CounterDeps = { ...base, store, judge: outcomeJudge, settings, vectors };
  const process: ProcessDeps = {
    ...base, store, judgeModel, spend, pause, edition, embedder, vectors, access, verifier, facts, settings,
    // The project's own repositories, read live when a lesson is tiered or put on trial; no port or an unreadable definition is "not known", which leaves a repository-restricted lesson restricted.
    projectRepos: async (key) => {
      const port = projectRepoScopesOf(taskVisibility);
      if (port === undefined) return undefined;
      try { return await port.read(key.workspaceId, key.project); } catch { return undefined; }
    },
  } satisfies CurateDeps & Partial<ProcessDeps>;
  const names: AttributionReader = {
    async memberName(_orgId, developerId) { return developerId === owner.id ? owner.name : undefined; },
    async isErased() { return false; },
  };
  const presetStore = new DocumentPresetStore(input.store);
  const soleOwner = new DocumentSoleOwnerSwitch(input.store);
  const view = { store, directory, settings, access, names, now: input.now, ...(input.log === undefined ? {} : { log: input.log }), pause, ...(input.pauseStillApplies === undefined ? {} : { pauseStillApplies: input.pauseStillApplies }) } satisfies LessonViewDeps;
  const routes: LessonRouteDeps = {
    ...base, ...view, store, directory, settings, access, vectors, embedder, judgeModel, spend, edition, pause, verifier, facts, projectRepos: process.projectRepos,
    judge: outcomeJudge,
    presets: { settings: presetStore, changes: presetStore, audit, now: input.now, authority: createLocalTier0Authority(owner.id), soleOwnerLoosening: (workspaceId) => soleOwner.read(workspaceId) },
  } as LessonRouteDeps;
  const deletion = lessonDeletionPort({ store, vectors, audit, now: input.now });
  return { store, documents: input.store, settings, access, directory, audit, pause, vectors, deletion, load, counters, routes, process, judgeModel, spend, edition };
}
