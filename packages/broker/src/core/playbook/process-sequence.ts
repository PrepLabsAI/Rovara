// "How we work": a project's process layer changes how the stages of Rovara Code work, not which stages there are. An overlay `sequence` (adding, removing, reordering or
// re-naming stages) is refused for a process layer at draft save, creation and publish; it is a later track. Ordinary agents may still set one.
import { agentXError, type RecipeOverlay } from "@agentx/contracts";

export const PROCESS_SEQUENCE_MESSAGE = "How we work can't change the order of stages yet.";

/** Refuses (CONFIG_INVALID, 400) an overlay with a `sequence` when the agent is a process layer. */
export function requireNoSequenceForProcess(agent: { purpose?: string | undefined }, overlay: Pick<RecipeOverlay, "sequence">): void {
  if (agent.purpose === "process" && overlay.sequence !== undefined) throw agentXError("CONFIG_INVALID", PROCESS_SEQUENCE_MESSAGE);
}
