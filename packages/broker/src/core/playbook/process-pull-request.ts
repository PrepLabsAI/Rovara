// "How we work": instructions written on the pull request stage are used nowhere (the pull request description never read them, and the feedback review drops a process layer's), so a project's
// process layer can't add or change them yet. Removing what is there stays allowed. Refused where the overlay is written or published: create, draft save, publish (immediate, confirmed and in
// the store). Ordinary agents may still set them.
import { HOW_WE_WORK_UNUSED_STAGE_NOTE, agentXError, type AgentId, type OrgId, type RecipeOverlay } from "@agentx/contracts";

export const PROCESS_PULL_REQUEST_MESSAGE = HOW_WE_WORK_UNUSED_STAGE_NOTE;

const pullRequestText = (overlay: Pick<RecipeOverlay, "steps"> | undefined): string => overlay?.steps?.pull_request?.instructions ?? "";

/** Refuses (CONFIG_INVALID, 400) an overlay whose pull request stage instructions are not what `previous` had (or are any, with no `previous`), when the agent is a process layer. */
export function requireNoNewPullRequestInstructionsForProcess(agent: { purpose?: string | undefined }, overlay: Pick<RecipeOverlay, "steps">, previous?: Pick<RecipeOverlay, "steps">): void {
  const text = pullRequestText(overlay);
  if (agent.purpose === "process" && text !== "" && text !== pullRequestText(previous)) throw agentXError("CONFIG_INVALID", PROCESS_PULL_REQUEST_MESSAGE);
}

/** The same check for a publish, and for a rollback (the target's overlay as `draft`): it is compared with the version that runs now (none for a first publish). */
export async function requireNoNewPullRequestInstructionsToPublish(
  store: { getVersion(orgId: OrgId, agentId: AgentId, version: number): Promise<{ overlay: RecipeOverlay } | undefined> },
  agent: { orgId: OrgId; agentId: AgentId; purpose?: string | undefined; currentVersion?: number | undefined }, draft: Pick<RecipeOverlay, "steps">,
): Promise<void> {
  if (agent.purpose !== "process" || pullRequestText(draft) === "") return;
  const running = agent.currentVersion === undefined ? undefined : await store.getVersion(agent.orgId, agent.agentId, agent.currentVersion);
  requireNoNewPullRequestInstructionsForProcess(agent, draft, running?.overlay);
}
