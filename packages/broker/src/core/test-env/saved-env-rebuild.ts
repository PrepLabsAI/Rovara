// Saved project images: starting the rebuild job. The registry (`saved-env.ts`) queues a job WITH the commits it is for; this makes the job a PREPARATION on a fresh workspace and hands it to the dispatcher, which
// adds the lease token once, when it delivers (`leaseForDispatch`, see "what the dispatcher does" below).
//   - the workspace belongs to `ownerFor` (by default the person who approved the environment revision), is NOT their default workspace and is written WITHOUT the project index attributes, so it is in no list of
//     their workspaces or of the project's;
//   - the preparation is READ ONLY (no setup command runs on it) and PINNED to the job's commits (the same `pins` a setup run has): the worker refuses it if its own resolution of a branch head differs, so the build
//     is for exactly the commits the job was queued for, and the result is held to them again by `recordBuild`;
//   - `savedEnvBuild` carries the approved environment, the repository the push login will be for and the key's inputs, and NO credential: the stored dispatch (outbox, queue) never holds the lease token;
//   - one start per job (a marker row written only if absent), so a retried trigger does not make a second workspace.
// What the dispatcher does with a job's preparation (`payload.savedEnvBuild` present): before it delivers, it asks the registry for that job's token (`savedEnvLease`, saved-env-dispatch-lease.ts: `leaseForDispatch` for the
// stored job id and this operation) and puts the token it gets in `savedEnvBuild.leaseToken` of the invocation it sends (never in what it stores); a worker that does not list `PREPARE_SAVED_ENV_BUILD_FEATURE` is
// refused the job (the dispatch says `requires`), and a job whose lease cannot be handed over is not delivered at all.
// Fails closed: no approver, a moved approved environment, a repository the job has no commit for, or no build inputs (the base image and secret names, from the install) start nothing, and the job's lease runs out.
import { randomUUID } from "node:crypto";
import {
  PREPARE_SAVED_ENV_BUILD_FEATURE, savedEnvRepositoryName, testEnvDigest, when, workerProjectDefinition,
  type PrepareSavedEnvBuild, type RegistryView, type StoredDocument, type TestEnvironmentBody,
} from "@agentx/contracts";
import { collectBuildSystemProfiles, detectorGlobsWithBuildSystems } from "../../ports/build-systems.js";
import { buildOperation } from "../task-flow/accept.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceKey } from "../task-flow/keys.js";
import { legacyWorkspaceKey } from "../task-flow/legacy-keys.js";
import { taskOwnerKey } from "../../developer/task-records.js";
import { documentOf, type TestEnvDeps } from "./deps.js";
import { readApprovedBy, readApprovedTestEnvironment } from "./environment.js";
import type { RebuildJob, SavedEnvDeps, SavedEnvState } from "./saved-env.js";
import { savedEnvEnabled } from "./saved-env-switch.js";
import { startMarkerItem } from "./saved-env-markers.js";

/** What the install knows of the key's inputs: the base image the saved image is for, the project's secret NAMES, and the globs of the files that key the image. Undefined: the install cannot say, and no job is started. */
export interface SavedEnvBuildInputs { baseImageDigest: string; secretNames: readonly string[]; detectorGlobs: readonly string[] }

export type StartRebuildResult =
  | { started: true; workspaceId: string; operationId: string }
  | { started: false; why: "disabled" | "nothing_queued" | "no_project" | "approved_moved" | "no_owner" | "commits_mismatch" | "no_build_inputs" | "already_started" };

/**
 * The NAMES of the secrets an approved environment reads (never a value), in no particular order: the key holds them as a set. TODAY ONLY the `http_hook` accounts' `tokenSecretName` is one: no other field of the
 * environment names a secret, and the project's own secrets are not in the environment. A field added later that names a secret must be added here, or its change would not move the key.
 */
export function savedEnvSecretNames(environment: TestEnvironmentBody): string[] {
  return [...new Set(environment.accounts.flatMap((account) => (account.provisioner === "http_hook" ? [account.tokenSecretName] : [])))];
}

/**
 * The key's inputs for a project, from the approved environment, the base image the install says and the build systems registered on the `build-system` point. The globs are the environment's own
 * `selection.fullSuiteOn` plus every build system's key files (`detectorGlobsWithBuildSystems`): the SAME list is the job's `detectorGlobs` and the broker's own key's, so both sides hash the same files.
 * Undefined when there is no approved environment or no base image digest.
 */
export async function savedEnvBuildInputsOf(
  deps: { test: Pick<TestEnvDeps, "store" | "now" | "env" | "serviceCatalog" | "fixtureStore">; registry: Pick<RegistryView, "get" | "names">; baseImageDigest(): Promise<string | undefined> },
  orgId: string, project: string,
): Promise<(SavedEnvBuildInputs & { revision: number }) | undefined> {
  const approved = await readApprovedTestEnvironment(deps.test, orgId, project);
  const baseImageDigest = await deps.baseImageDigest();
  if (approved === undefined || baseImageDigest === undefined || !/^sha256:[a-f0-9]{64}$/u.test(baseImageDigest)) return undefined;
  const detectorGlobs = detectorGlobsWithBuildSystems(approved.environment.selection.fullSuiteOn, await collectBuildSystemProfiles(deps.registry));
  return { revision: approved.revision, baseImageDigest, secretNames: savedEnvSecretNames(approved.environment), detectorGlobs };
}

export interface RebuildStartDeps {
  flow: TaskFlowDeps;
  saved: SavedEnvDeps;
  test: TestEnvDeps;
  inputs: ((orgId: string, project: string) => Promise<SavedEnvBuildInputs | undefined>) | undefined;
  /** Who the rebuild runs as: a person id, or undefined (then nothing starts). Default: the person who approved the environment revision. */
  ownerFor?: (ids: { orgId: string; project: string; approvedRevision: number }) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv | undefined;
}

/** What both starts of a rebuild (this file's, and the system run's, `saved-env-run.ts`) read before they write anything: the queued job and everything it must still agree with. */
export interface RebuildFacts {
  job: RebuildJob;
  state: SavedEnvState;
  project: NonNullable<Awaited<ReturnType<TaskFlowDeps["projects"]["latest"]>>>;
  approved: NonNullable<Awaited<ReturnType<typeof readApprovedTestEnvironment>>>;
  build: SavedEnvBuildInputs;
}
export type RebuildFactsRefusal = "disabled" | "nothing_queued" | "no_project" | "approved_moved" | "commits_mismatch" | "no_build_inputs";

/**
 * The guards of a rebuild's start, all of them reads: the switch is on; the project has a queued job nobody has been given the lease of, whose lease is live; the project is live; the approved environment is still
 * the one the job was queued for; every repository of the project has a commit in the job and the job names no other; the install can say the build's inputs.
 */
export async function readRebuildFacts(deps: Omit<RebuildStartDeps, "ownerFor">, ids: { orgId: string; projectId: string }): Promise<{ ok: true; facts: RebuildFacts } | { ok: false; why: RebuildFactsRefusal }> {
  const saved = deps.saved;
  if (!savedEnvEnabled(deps.env ?? process.env) || !saved.session.config.enabled) return { ok: false, why: "disabled" };
  const state = await saved.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  // Only a queued job that nobody has been given the lease of, and whose lease is live.
  if (state === undefined || job === undefined || job.dispatchedAt !== undefined || Date.parse(job.leaseUntil) <= saved.now() || state.deleted === true || state.archived === true || !state.enabled) return { ok: false, why: "nothing_queued" };
  const project = await deps.flow.projects.latest(ids.projectId);
  if (project === undefined || project.archived === true) return { ok: false, why: "no_project" };
  // The environment the job was queued for is still the newest approved one: the build proves THIS body.
  const approved = await readApprovedTestEnvironment(deps.test, ids.orgId, ids.projectId);
  if (approved === undefined || approved.revision !== job.approved.revision || testEnvDigest(approved.environment) !== job.approved.digest) return { ok: false, why: "approved_moved" };
  // Every repository of the project has a commit in the job, and the job names no other: the pins are the job's commits, whole.
  const names = workerProjectDefinition(project.definition).repositories.map((repository) => repository.name);
  const committed = Object.keys(job.commits);
  if (names.length !== committed.length || names.some((name) => job.commits[name] === undefined)) return { ok: false, why: "commits_mismatch" };
  const build = await deps.inputs?.(ids.orgId, ids.projectId);
  if (build === undefined) return { ok: false, why: "no_build_inputs" };
  return { ok: true, facts: { job, state, project, approved, build } };
}

/** The preparation a rebuild is: read only, PINNED to the job's commits, carrying the job (`savedEnvBuild`) and no credential. The caller adds who it runs as and what it writes beside it. */
export function rebuildPreparation(saved: SavedEnvDeps, ids: { orgId: string; projectId: string }, facts: RebuildFacts): { pins: Array<{ repository: string; commit: string }>; savedEnvBuild: PrepareSavedEnvBuild } {
  const { job, approved, build, project } = facts;
  const names = workerProjectDefinition(project.definition).repositories.map((repository) => repository.name);
  return {
    pins: names.map((repository) => ({ repository, commit: job.commits[repository]! })),
    savedEnvBuild: {
      jobId: job.jobId, reason: job.reason, approved: job.approved, repository: savedEnvRepositoryName({ env: saved.session.config.env, orgId: ids.orgId, projectId: ids.projectId }),
      expectedKey: job.expectedKey, environment: approved.environment, commits: job.commits, detectorGlobs: [...build.detectorGlobs], secretNames: [...build.secretNames], baseImageDigest: build.baseImageDigest,
    },
  };
}

export async function startSavedEnvRebuild(deps: RebuildStartDeps, ids: { orgId: string; projectId: string }): Promise<StartRebuildResult> {
  const saved = deps.saved;
  const read = await readRebuildFacts(deps, ids);
  if (!read.ok) return { started: false, why: read.why };
  const { job, project, approved } = read.facts;
  const owner = await (deps.ownerFor ?? (async ({ orgId, project: name, approvedRevision }) => readApprovedBy(deps.test, orgId, name, approvedRevision)))({ orgId: ids.orgId, project: ids.projectId, approvedRevision: approved.revision });
  if (owner === undefined) return { started: false, why: "no_owner" };
  const { pins, savedEnvBuild } = rebuildPreparation(saved, ids, read.facts);

  const nowMs = saved.now();
  const now = new Date(nowMs).toISOString();
  const workspaceId = (deps.flow.newId ?? randomUUID)();
  const operationId = (deps.flow.newId ?? randomUUID)();
  const ownerKey = taskOwnerKey(owner, `saved-env-${job.jobId}`);
  // The workspace is written WITHOUT the project index attributes: it is in no list of workspaces, the project's or a person's.
  const workspace: StoredDocument = documentOf({
    ...workspaceKey(deps.flow.companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: deps.flow.companyId, orgId: deps.flow.companyId, ownerKey, projectName: ids.projectId, projectRevision: project.definition.revision,
    status: "PREPARING", activeOperationId: operationId, fence: 1, createdAt: now, updatedAt: now,
  });
  const prepare = buildOperation(deps.flow, {
    workspace: { pk: workspace.pk, id: workspaceId, fence: 1, ownerKey }, kind: "prepare", requestId: (deps.flow.newId ?? randomUUID)(), operationId, now, recordRequest: false,
    dispatch: {
      kind: "prepare", projectRevision: project.definition.revision, payload: JSON.parse(JSON.stringify({ readOnly: true, pins, savedEnvBuild })) as Record<string, never>,
      // The push login and the result are this preparation's alone; a worker that cannot build is refused the job, never sent it without the field.
      extraActions: ["saved-env-push-login", "saved-env-result"], requires: [PREPARE_SAVED_ENV_BUILD_FEATURE],
    },
    requester: { personId: owner, provider: "saved-env" },
  });
  const written = await deps.flow.store.transact([
    // The marker: one start per job, the ids the sweep needs to settle the end, a time to look again (the sparse index), and an expiry.
    { kind: "put", item: startMarkerItem({ orgId: ids.orgId, projectId: ids.projectId, jobId: job.jobId, workspaceId, operationId, createdAt: now, nowMs }), condition: when.absent() },
    { kind: "put", item: workspace, condition: when.absent() },
    { kind: "put", item: { ...legacyWorkspaceKey(workspaceId), entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId: workspace["companyId"]! }, condition: when.absent() },
    ...prepare.items,
  ]);
  if (!written.applied) return { started: false, why: "already_started" };
  // The message is handed to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the start.
  await deps.flow.outbox.relay({ companyId: deps.flow.companyId, ids: [prepare.operation.id] }).catch(() => undefined);
  return { started: true, workspaceId, operationId };
}
