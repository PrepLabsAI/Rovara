// L4-EVS2 (DEC 254zzz20 D3): where the `eval-plan` answer's `environment` comes from. The worker can run a sealed eval in the project's saved environment (or after its approved install steps) since
// L4-EVS (#996); this is the broker half that decides WHICH one, from the company's own stores, for the run's own company and project only.
//
//   1. saved    the project's saved environment image (`SAVED_ENV#<project>` row, the store behind `GET /v1/app/projects/<p>/environment-image`): newest image `ready`, built for THIS project's newest APPROVED
//               test environment (revision AND digest: `imageForTask`, the rule a task's preparation uses), holding the plan's repository, in a project that is live. It is delivered with a short-lived pull
//               login for that one repository (`savedEnvPullLogin`) and the project's approved install steps as `fallbackInstall` when it has some. Only when the install's saved-environments switch is on and
//               the image registry can serve a worker's pull.
//   2. install  otherwise, the approved test environment's setup commands for the plan's repository (an argv each, no shell), cwd made relative to the checkout.
//   3. absent   otherwise: the eval runs on the bare worker image, exactly as before.
//
// FAIL CLOSED. Everything is read for (company, project) of the run's scope, never from the request. A row whose own company or project is not the scope's is not read as the scope's. A login whose repository is
// not THIS company's and THIS project's (`savedEnvRepositoryIsFor`) is dropped (the saved image is then not used; the install steps still can be). An unreadable approved environment gives absent; an unreadable
// saved-image row gives no saved image (the approved install steps, which come from a different row, are still the project's own). Any throw is "absent". Nothing here logs a value: one fixed event name per drop.
import {
  EVAL_INSTALL_COMMANDS_MAX, EvalEnvironmentSchema, EvalInstallCommandSchema, HostedSavedEnvRegistryAuthSchema, savedEnvRepositoryIsFor, testEnvDigest,
  type DocumentStore, type EvalEnvironment, type EvalInstallCommand, type ImageRegistry, type OrgId, type ProjectCommand, type TestEnvironment,
} from "@agentx/contracts";
import type { EvalPlanScope } from "../proof/eval-plan-delivery.js";
import type { ProjectSource } from "../task-flow/deps.js";
import { readApprovedTestEnvironment } from "../test-env/environment.js";
import { imageForTask, savedEnvPullLogin, type SavedEnvDeps } from "../test-env/saved-env.js";
import { documentSavedEnvStore } from "../test-env/saved-env-store.js";
import { savedEnvEnabled } from "../test-env/saved-env-switch.js";
import { testEnvironmentEnabled } from "../test-env/switch.js";

/** What the pull login of a saved image is minted from: the saved-image rows, the registry and the clock (the registry's push-side reads are not used here). */
export type EvalSavedEnvDeps = Pick<SavedEnvDeps, "store" | "session" | "now">;

/** The environment of the run's own company and project, or undefined (the bare image). The repository is the plan's `repository` (undefined for a single-repository project). Never throws. */
export type EvalEnvironmentSource = (scope: EvalPlanScope, repository: string | undefined) => Promise<EvalEnvironment | undefined>;

export type EvalEnvironmentSourceEvent =
  | "eval_environment_unreadable" | "eval_environment_install_unusable" | "eval_environment_saved_unusable" | "eval_environment_saved_scope_mismatch";

export interface EvalEnvironmentSourceDeps {
  readonly store: DocumentStore;
  readonly companyId: OrgId;
  readonly now: () => number;
  /** The install's switches. Absent: the process environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The project's registered repositories, name to path (the folder of the checkout in a workspace and in a saved image's seed), or undefined when it cannot be read. */
  readonly repositoryPaths: (project: string) => Promise<ReadonlyMap<string, string> | undefined>;
  /** The saved-image reads and the pull login, or undefined when this install keeps no saved images. Called for each ask. */
  readonly savedEnv?: (() => EvalSavedEnvDeps | undefined) | undefined;
  readonly log?: ((event: EvalEnvironmentSourceEvent) => void) | undefined;
}

/**
 * The saved-image deps of an install: the company's own saved-image rows over `store`, the registry (a hosted install holds the login to a cloud registry host), and the approved environment read for the
 * pull login's own check. `proveHolds` is a push-side read and is never used here. Undefined when the saved-environments switch is off.
 */
export function evalSavedEnvDepsOf(input: { store: DocumentStore; registry: ImageRegistry; envName: string; now: () => number; env?: NodeJS.ProcessEnv | undefined; hosted?: boolean | undefined }): EvalSavedEnvDeps | undefined {
  if (!savedEnvEnabled(input.env ?? process.env)) return undefined;
  const test = { store: input.store, now: input.now, ...(input.env === undefined ? {} : { env: input.env }) };
  return {
    store: documentSavedEnvStore({ store: input.store, now: input.now }),
    session: {
      config: { enabled: true, env: input.envName },
      ports: {
        registry: input.registry,
        ...(input.hosted === true ? { registryAuthSchema: HostedSavedEnvRegistryAuthSchema } : {}),
        readApproved: async (orgId, project) => {
          const found = await readApprovedTestEnvironment(test, orgId as OrgId, project);
          return found === undefined ? undefined : { revision: found.revision, digest: testEnvDigest(found.environment) };
        },
        proveHolds: async () => false,
        now: input.now,
      },
    },
    now: input.now,
  };
}

/** The project's registered repositories (name to path) from the project's own latest revision, or undefined when there is none or it cannot be read. Never throws. */
export function repositoryPathsOf(projects: Pick<ProjectSource, "latest">): EvalEnvironmentSourceDeps["repositoryPaths"] {
  return async (project) => {
    try {
      const found = await projects.latest(project);
      return found === undefined ? undefined : new Map(found.definition.repositories.map(repository => [repository.name, repository.path] as const));
    } catch { return undefined; }
  };
}

/** The checkout-relative directory of a command that runs in the workspace at `cwd` when the repository is at `repositoryPath`; undefined when it runs somewhere else. */
function checkoutDirectory(cwd: string, repositoryPath: string): string | undefined {
  if (cwd === repositoryPath) return ".";
  return cwd.startsWith(`${repositoryPath}/`) ? cwd.slice(repositoryPath.length + 1) : undefined;
}

/**
 * The approved install steps of one repository, or undefined when there are none or any one cannot be run as an eval install step (a step with its own variables, one outside the repository, too many, or a
 * shape the worker refuses): never a part of the list, since a half install reads as a broken eval.
 */
export function installStepsOf(commands: readonly ProjectCommand[], repositoryPath: string): readonly EvalInstallCommand[] | undefined {
  if (commands.length === 0 || commands.length > EVAL_INSTALL_COMMANDS_MAX) return undefined;
  const steps: EvalInstallCommand[] = [];
  for (const command of commands) {
    const cwd = checkoutDirectory(command.cwd, repositoryPath);
    if (cwd === undefined || (command.env !== undefined && Object.keys(command.env).length > 0)) return undefined;
    const step = EvalInstallCommandSchema.safeParse({ executable: command.executable, args: command.args, cwd });
    if (!step.success) return undefined;
    steps.push(step.data);
  }
  return steps;
}

export function createEvalEnvironmentSource(deps: EvalEnvironmentSourceDeps): EvalEnvironmentSource {
  const env = deps.env ?? process.env;
  const log = (event: EvalEnvironmentSourceEvent): void => { try { deps.log?.(event); } catch { /* logging never changes the answer */ } };
  return async (scope, repository) => {
    try {
      if (scope.companyId !== deps.companyId || typeof scope.project !== "string" || scope.project === "") return undefined;
      if (!testEnvironmentEnabled(env)) return undefined;
      // The approved environment: its setup steps and the pin a saved image must be built for. A read that fails (or a damaged approval) is absent, never a guess.
      let approved: TestEnvironment | undefined;
      try { approved = await readApprovedTestEnvironment({ store: deps.store, now: deps.now, env }, deps.companyId, scope.project); } catch { log("eval_environment_unreadable"); return undefined; }
      if (approved === undefined) return undefined;
      // The plan's repository (a single-repository project's plan names none). More than one repository and no name: which one is not known, so nothing.
      const repos = approved.environment.repos;
      const entry = repository === undefined ? (repos.length === 1 ? repos[0] : undefined) : repos.find(candidate => candidate.repositoryId === repository);
      if (entry === undefined) return undefined;
      const paths = await deps.repositoryPaths(scope.project).catch(() => undefined);
      const path = paths?.get(entry.repositoryId);
      if (path === undefined) { log("eval_environment_unreadable"); return undefined; }
      const install = installStepsOf(entry.setupCommands, path);
      if (install === undefined && entry.setupCommands.length > 0) log("eval_environment_install_unusable");

      const saved = await savedEnvironmentOf(deps, scope, { pin: { revision: approved.revision, digest: testEnvDigest(approved.environment) }, repositoryId: entry.repositoryId, directory: path, install }, log);
      if (saved !== undefined) return saved;
      return install === undefined ? undefined : EvalEnvironmentSchema.safeParse({ kind: "install", commands: install }).data;
    } catch {
      log("eval_environment_unreadable");
      return undefined;
    }
  };
}

async function savedEnvironmentOf(
  deps: EvalEnvironmentSourceDeps, scope: EvalPlanScope,
  want: { pin: { revision: number; digest: string }; repositoryId: string; directory: string; install: readonly EvalInstallCommand[] | undefined },
  log: (event: EvalEnvironmentSourceEvent) => void,
): Promise<EvalEnvironment | undefined> {
  try {
    const saved = deps.savedEnv?.();
    if (saved === undefined) return undefined;
    // An image is used only when the registry can serve a worker's pull (the same word a task's preparation asks).
    if (!saved.session.ports.registry.capabilities.workerPull) return undefined;
    const state = await saved.store.get(scope.companyId, scope.project);
    // The row must be this company's and this project's own, whatever key it was read at.
    if (state === undefined || state.orgId !== scope.companyId || state.projectId !== scope.project) return undefined;
    const image = imageForTask(state, want.pin, saved.now());
    const record = state.images[0];
    if (image === undefined || record === undefined || record.digest !== image.digest || !record.manifest.commits.some(commit => commit.repositoryId === want.repositoryId)) return undefined;
    const login = await savedEnvPullLogin(saved, { orgId: scope.companyId, projectId: scope.project }, image.digest);
    if (!login.ok) { log("eval_environment_saved_unusable"); return undefined; }
    // A login for another company's or project's repository is never given on.
    if (!savedEnvRepositoryIsFor(login.auth.repository, { orgId: scope.companyId, projectId: scope.project })) { log("eval_environment_saved_scope_mismatch"); return undefined; }
    const parsed = EvalEnvironmentSchema.safeParse({
      kind: "saved", repository: login.auth.repository, digest: image.digest, environmentKey: image.environmentKey, testEnvRevision: image.testEnvRevision, directory: want.directory, login: login.auth,
      ...(want.install === undefined ? {} : { fallbackInstall: want.install }),
    });
    if (!parsed.success) { log("eval_environment_saved_unusable"); return undefined; }
    return parsed.data;
  } catch {
    // An unreadable saved-image row: no saved image (the approved install steps are a different row and are still the project's own).
    log("eval_environment_unreadable");
    return undefined;
  }
}
