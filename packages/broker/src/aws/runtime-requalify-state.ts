import { REQUALIFY_REFUSAL_PREFIX, agentXError } from "@agentx/contracts";

/**
 * A renewal that was running while the control plane was deployed carries the state the previous code wrote: its `instance` has no `workspaceId` or
 * `generation` (the runner was booted with a workspace id nobody recorded, so its challenge could never match it). The state still parses; this is what
 * the steps that continue such a run call, so it fails with one fixed reason (`requalify-refused:legacy-run-state`) on the normal failure path
 * (alert, end the new runner, release the lock, keep the old runner) and never with a parse error. The next daily check starts a fresh run.
 */
export function assertRunStateIsCurrent(state: { instance?: { workspaceId?: string | undefined; generation?: number | undefined } | undefined }): void {
  if (state.instance !== undefined) bootIdentityOf(state.instance);
}

/** The workspace id and generation the runner was booted with, or the legacy-state refusal when the run predates them. */
export function bootIdentityOf(instance: { workspaceId?: string | undefined; generation?: number | undefined }): { workspaceId: string; generation: number } {
  if (instance.workspaceId === undefined || instance.generation === undefined) throw agentXError("CONFIG_INVALID", `${REQUALIFY_REFUSAL_PREFIX}legacy-run-state`);
  return { workspaceId: instance.workspaceId, generation: instance.generation };
}
