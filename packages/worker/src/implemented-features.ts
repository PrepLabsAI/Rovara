import { DESIGN_REVIEW_WORKER_FEATURE, EVAL_FILES_FEATURE, NIGHTLY_RUN_FEATURE, SECOND_REVIEWER_FEATURE, SETUP_AGENT_FEATURE, SETUP_RECIPES_FEATURE, STANDING_INSTRUCTIONS_FEATURE, type WorkerInvocationFeature } from "@agentx/contracts";

/**
 * The optional invocation fields this worker implements, listed by hand and advertised on /ping. WORKER_INVOCATION_FEATURES
 * is the list of fields the shared schema knows; a worker that parses a field but does not act on it must not advertise
 * it, or the delivery guard would send it to a worker that silently ignores it. A task that adds a feature to the
 * contracts adds it here when the worker implements it ("task.agentRun" was added by Task 23).
 */
export const WORKER_IMPLEMENTED_FEATURES = [
  "task.modelPolicy",
  "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview",
  "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode",
  "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate",
  "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "task.workflowReviewers", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission",
  // M1.2 to M1.4: the application plan, application and baseline rounds, AI navigation steps, replay, and the model-free time limits and model choice (mainline's worker implements each).
  "task.workflowE2EApplicationPlan", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks", "task.workflowE2EBaselineSource",
  "task.workflowE2EAgentSteps.v1", "task.workflowE2ECaptureExtras.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EModelFreeLimits.v1", "task.workflowE2EAgentModelChoice.v1",
  "model.route", "task.agentStep", "task.agentRun", "task.agentGrounding.v1",
  // Rovara Code version 2 (Plan 6): Understand runs read-only and answers with a `rovara-intent` block.
  "task.workflowUnderstand",
  // Plan 6 Task 8: the plan check of Rovara Code version 2 (a read-only model run that answers with a rovara-plan-critique block).
  "task.workflowPlanCritique",
  // Rovara Code (Plan 6 Task 10): a read-only run that drafts a project's dev setup.
  "task.setupDraft",
  "task.setupProposal.v2",
  // Plan 6 Task 13: the code review of a Rovara Code version 2 task states a risk level.
  "task.workflowReviewRisk",
  // Plan 6 Task 15: a coding run that fixes a pull request that is already open (CI, a conflict or comments).
  "task.workflowFix",
  // Plan 6 Task 16: a coding run whose PR feedback approval is Rovara's own (it carries the autonomy it was decided under).
  "task.workflowFeedbackAutonomy",
  // Rovara Code v2: independent parts of an approved plan build side by side (parallel-parts.ts).
  "task.workflowParallelParts",
  // Plan 6 Task 17: a merge of the base branch into a workflow task's pull request branch, and a conflict round's fix pushed as a merge commit.
  "maintain.workflowSync",
  // Mainline #408: the plan dry run (a coding plan's proposed checks tried on the unchanged code; the executor monitor withholds it on a host without the executor image) and the grounding round (T7a/T7b).
  "task.workflowPlanDryRun.v1", "task.workflowE2EGroundingChecks.v1",
  // Mainline #413 (MIDSTEPCOOKIE): the executor syncs the browser's session values before every model call; the application-runtime monitor withholds it on a host whose executor image lacks the session-sync label.
  "task.workflowE2EMidStepSync.v1",
  // Live steer: a person's message reaches the running Understand, Plan or Implement step's session (steer-invocation.ts).
  "task.liveSteer.v1",
  // SH14: the setup run that runs commands (setup-agent-run.ts), on the run's own network with the DNS-watch helper. Listed only by a worker image that carries the helper script and the setup sandbox guard.
  SETUP_AGENT_FEATURE,
  // SH30: company recipes offered to the detectors (test-env-detect.ts `recipes`).
  SETUP_RECIPES_FEATURE,
  // Meta repo lane A3: the prepare invocation's `meta` request (the project's meta repository, read-only and sparse; meta-checkout.ts).
  "prepare.metaRepo",
  // Lane E (MCP context sources): an Understand, Plan, Plan-check or Review stage asks the broker for the project's source tools (worker/src/context-sources).
  "task.contextSources.v1",
  // Meta repo lane D: the spec write run (spec-write.ts) .
  "task.specWrite.v1",
  "task.workflowReviewSpec.v1",
  // Live interaction, Stop & redirect: the owner's instruction that stopped a coding step is taken from the owner and framed in the restarted step's prompt (steer-invocation.ts).
  "task.ownerRedirect.v1",
  // Live interaction A2: a read-only look at the working tree for an Ask (peek-invocation.ts).
  "task.peek.v1",
  // Plug-in foundations I3: the commit a publication makes carries a random attribution reference, and the description names who asked and who approved (publish.ts).
  "publish.attribution",
  // Live interaction F3: a deep diagnosis, the read-only look answered with the diagnosis JSON (diagnosis.ts).
  "task.diagnosis.v1",
  // Proof and evidence (wire-proof): a CHECKS run writes evidence-raw.json when the invocation carries `evidenceCapture` (verification/evidence-raw.ts).
  "task.evidenceCapture.v1",
  // Learning v2 (L4): approved lessons arrive as `learnedContext`, are re-checked against the base commit and framed as inert advice (learned-run.ts, learned-context.ts).
  "task.learnedContext.v1",
  // Test environment (wire-testenv): a setup draft run that is told `testEnvDetect` also reports the environment the detectors would propose (test-env-detect.ts).
  "task.testEnvDetect.v1",
  // Test environment (wire-testenv): a verification run that carries the environment's plan applies its test selection and round budget and reports the selection (verification/test-env-plan.ts).
  "task.testEnvironment.v1",
  // Evidence (S-2): the plan's `checks[].coveragePath` (the approved report) is read as a named coverage report (verification/evidence-raw.ts).
  "task.testEnvCoveragePath.v1",
  // N9 (INTG2): the prepare invocation's `registries` (a project's private package registries for the setup and readiness commands; registry-config.ts).
  "prepare.registries.v1",
  // Saved environments (SH25): the prepare invocation's `savedEnv` (a project's saved image to start from; saved-env/use.ts). Any problem with the image sets up fresh.
  "prepare.savedEnv.v1",
  // Saved project images: the prepare invocation's `savedEnvBuild` (a rebuild of the project's image after a read-only pinned preparation; saved-env/rebuild.ts).
  "prepare.savedEnvBuild.v1",
  // P1: a prepare invocation's `pins` (the heads the broker read) are checked against what the worker resolves (prepare.ts).
  "prepare.pins.v1",
  // Plug-in foundations P8: the repository credential exchange takes an ssh key as well as a token or a password (repository-credentials.ts, git-auth.ts).
  "repository.credentialKinds.v1",
  // SR-1 (switch `cr`): the second reviewer inside a review operation (verification/review.ts `secondReviewer`).
  SECOND_REVIEWER_FEATURE,
  // DR5: the design-review form of the plan check (design-review.ts, design-review-sessions.ts).
  DESIGN_REVIEW_WORKER_FEATURE,
  // NH-1: the nightly run (nightly-run.ts): the Prove sequence over the approved environment, with one rerun of failures and the coverage map, reported through the nightly action.
  NIGHTLY_RUN_FEATURE,
  // Standing instructions: the broker-built block of company rules and "How we work", placed in the system prompt of every session (pi-session.ts, run-agent-step.ts, verification/review.ts).
  STANDING_INSTRUCTIONS_FEATURE,
  // Lessons replay, the file arm: places a replay copy's lessons file and pointer in its checkout, out of the candidate (eval-files.ts).
  EVAL_FILES_FEATURE,
  // The approved plan a coding run keeps in its conversation summaries (compaction.ts).
  "task.workflowApprovedPlan.v1",
  // Test services (`task.testServices.v1`) is NOT listed here: it is advertised only by a worker that has a test-services configuration (test-services-run.ts `testServicesAdvertisedFeatures`, added in main.ts).
] as const satisfies readonly WorkerInvocationFeature[];
