// "How we work": a project's process layer can't add or remove skills yet. A skill reaches every step but the check, the plan check and the reviewers included, and no less-safe rule
// covers it, so an overlay `skills` (adding or removing) is refused for a process layer wherever the overlay can be written or used: create, draft save, update of the base, publish
// (immediate and confirmed), rollback, and reading the layer as the project's process. Ordinary agents may still set them.
import { agentXError, type RecipeOverlay } from "@agentx/contracts";

export const PROCESS_SKILLS_MESSAGE = "How we work can't add skills yet.";

/** Whether the overlay adds or removes at least one skill. An empty `skills` object changes nothing. */
export const overlayHasSkills = (overlay: Pick<RecipeOverlay, "skills">): boolean => (overlay.skills?.add?.length ?? 0) > 0 || (overlay.skills?.remove?.length ?? 0) > 0;

/** Refuses (CONFIG_INVALID, 400) an overlay that adds or removes a skill when the agent is a process layer. */
export function requireNoSkillsForProcess(agent: { purpose?: string | undefined }, overlay: Pick<RecipeOverlay, "skills">): void {
  if (agent.purpose === "process" && overlayHasSkills(overlay)) throw agentXError("CONFIG_INVALID", PROCESS_SKILLS_MESSAGE);
}
