// @rovara-code/lessons: the lessons engine (learning from finished tasks, the lesson store, approval, loading into a task). It depends only on @rovara-code/contracts, zod
// and Node. This entry names, one by one, what the laptop app (`@rovara-code/core/local`, later `@rovara-code/local`) uses. There is no `export *`: six names are
// exported by two modules each (`approversRequired`, `LEASE_MS`, `ReflectOutcome`, `ReflectResult`, `REVERT_WINDOW_MS`, `textHash`), so a star export would clash. Two
// more entries exist for Cloud: `./audit-sink` and `./types`. Add a name here when a package outside this one needs it.
export { approveLesson, retireByPerson } from "./approve.js";
export { type CodeFactsReader } from "./code-facts.js";
export { applyLoadReport, recordFeedback } from "./counters.js";
export { documentRepoFileStore } from "./document-repo-file.js";
export { isEvalRunMark } from "./eval-run.js";
export { sweepExpired } from "./expiry.js";
export { cleanForLearning } from "./guards.js";
export { isHumanSendBack } from "./human-send-backs.js";
export { currentLearningAttempt, learningCallMayStart, noteLearningFault } from "./learning-deadline.js";
export { learnedContextForDispatch } from "./load.js";
export { learningAdapterFromEnvironment } from "./local-embedder.js";
export { readLocalToolsState, setCompanyLocalTools, setProjectLocalTools, type LocalToolsSetResult } from "./local-tools-setting.js";
export { LocalLessonsUnavailable, lessonsForLocalTool, type LocalLessonsDeps, type LocalToolsCounter } from "./local-tools.js";
export { LearningRefusal } from "./pause.js";
export { planLoadFacts } from "./plan-facts.js";
export { modeAllows, requireAudit, resolveLearning, setLearnedLessonsGate } from "./policy.js";
export { type LearningSpend, type PipelineModel } from "./ports.js";
export { type ProjectRepoScopesPort } from "./project-repo-audience.js";
export { readVisible } from "./read-visible.js";
export { documentReflectClaims } from "./reflect-claims.js";
export { type EvidenceSpan } from "./reflect-input.js";
export { queueReflectQueue, queueReflectVisibility, reflectQueueOf } from "./reflect-queue.js";
export { retryDelayFor, runReflectMessage, type ReflectWorkerDeps } from "./reflect-worker.js";
export { lessonsRepoFilePublishJob, lessonsRepoFileSweepJob, type RepoFileRuntime } from "./repo-file-job.js";
export { type RepoFileTarget } from "./repo-file-pass.js";
export { repoFileAction, repoFileStatus } from "./repo-file-routes.js";
export { type RepoChangeRequest } from "./repo-reflect.js";
export { normalizeRemote } from "./repo-remote.js";
export { createLessonsRuntime, type LessonsRuntime } from "./runtime.js";
export { type ScopeKey } from "./store.js";
export { localLessonsEnabled } from "./switch.js";
export { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskEndOutcome, type TaskLearningDeps, type TaskSubjectBase, type TaskSubjectSource } from "./task-end.js";
export { type OutcomeRowReader, type RevertedTasksReader } from "./task-outcome-rows.js";
export { type SendBackFact } from "./task-subject.js";
export { promoteStableTrials } from "./trial.js";
export { narrowestAudience, peopleOf, type Audience, type Lesson, type TrustClass } from "./types.js";
export { lessonsUsedReaderOver, lessonsUsedSection, type LessonsUsedSummary, type RepositoryVisibility } from "./used-in-pr.js";
export { buildLessonHistory, buildLessonsView, buildLoadedLessons } from "./view.js";
