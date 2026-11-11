// Test services dependencies and a dev container do not combine yet. The sealed check runners (`docker exec --env-file` in the check sandbox) cannot be used with a project's dev container
// (the worker throws), so an environment that lists dependencies for a project that uses one is "not available yet": at approval, at the task's start and at dispatch. Today's behaviour for a project WITHOUT dependencies is
// not touched: this is asked only when the environment has dependencies.
import { agentXError, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { createStoreProjectSource } from "../task-flow/project-source.js";
import type { StoreOnly } from "./deps.js";

/** What a person reads. Fixed words. */
export const DEPENDENCIES_WITH_DEVCONTAINER_WORDS = "Test services are not available yet for a project that uses a dev container.";

type Store = StoreOnly;

/**
 * Whether the project's newest settings name a dev container. A project whose settings cannot be read counts as using one: with dependencies at stake, "cannot tell" is a refusal, never a pass. Never throws.
 */
export async function projectUsesDevcontainer(store: Store, orgId: OrgId, project: string): Promise<boolean> {
  try {
    const latest = await createStoreProjectSource(store.store, orgId).latest(project);
    return latest === undefined || latest.definition.devcontainer !== undefined;
  } catch {
    return true;
  }
}

/** Throws the refusal when the environment has dependencies and the project uses a dev container (or cannot be read). No dependencies: nothing is read and nothing is refused. */
export async function refuseDependenciesWithDevcontainer(store: Store, orgId: OrgId, project: string, body: Pick<TestEnvironmentBody, "dependencies">): Promise<void> {
  if (body.dependencies === undefined || body.dependencies.length === 0) return;
  if (await projectUsesDevcontainer(store, orgId, project)) throw agentXError("CONFIG_INVALID", DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
}
