// Saved environments: the saved image field of a prepare invocation, and the install of the registry's hooks. The rules are in `saved-env.ts` (`savedEnvForPrepare`, `savedEnvPullLogin`); this file only asks
// the installed resolver, and never lets it block or fail a preparation.
//
// What is sent, and when: the field is a REFERENCE (repository, digest, revision, key, the task's pinned revision). It is stored with the invocation (outbox, queue), so it holds no credential: the worker asks for
// the pull login at pull time (`saved-env-login.ts`). Only a developer task's start (and the continue of a held start) sends the task's approved-environment pin; a preparation without one (a thread workspace,
// project registration, a setup draft, a run that runs none of the project's code) is sent nothing.
import type { PrepareSavedEnv, SavedEnvRegistryAuth } from "@agentx/contracts";
import { savedEnvEnabled } from "./saved-env-switch.js";
import { savedEnvForPrepare, savedEnvPullLogin, type SavedEnvDeps } from "./saved-env.js";

export interface SavedEnvPrepareHooks {
  /** `{ savedEnv }` for a prepare payload, or nothing. */
  savedEnvPrepare(input: { orgId: string; projectName: string; testEnvPin: { revision: number; digest: string } }): Promise<{ savedEnv?: PrepareSavedEnv }>;
  /** The pull login for the image a running preparation was told to pull, or undefined. */
  savedEnvLogin(input: { orgId: string; projectName: string; digest: string }): Promise<SavedEnvRegistryAuth | undefined>;
}

/** `{ savedEnv }` for a prepare payload, or nothing. */
export async function savedEnvPrepareOf(
  hooks: Pick<SavedEnvPrepareHooks, "savedEnvPrepare"> | undefined,
  project: { name: string },
  options: { readOnly?: boolean; orgId: string | undefined; setupDraft?: boolean; testEnvPin?: { revision: number; digest: string } | undefined },
): Promise<{ savedEnv?: PrepareSavedEnv }> {
  if (hooks === undefined || options.readOnly === true || options.setupDraft === true || options.orgId === undefined || options.testEnvPin === undefined) return {};
  try { return await hooks.savedEnvPrepare({ orgId: options.orgId, projectName: project.name, testEnvPin: options.testEnvPin }); } catch { return {}; }
}

/**
 * The two hooks, from the registry's deps, and only while the saved-environments switch is on. With it off (or no deps) nothing is returned, so nothing is sent and no login is given.
 */
export function installSavedEnv(deps: SavedEnvDeps | undefined, env: NodeJS.ProcessEnv = process.env): SavedEnvPrepareHooks | undefined {
  if (deps === undefined || !savedEnvEnabled(env)) return undefined;
  return {
    savedEnvPrepare: ({ orgId, projectName, testEnvPin }) => savedEnvForPrepare(deps, { orgId, projectId: projectName }, testEnvPin),
    savedEnvLogin: async ({ orgId, projectName, digest }) => {
      const login = await savedEnvPullLogin(deps, { orgId, projectId: projectName }, digest);
      return login.ok ? login.auth : undefined;
    },
  };
}
