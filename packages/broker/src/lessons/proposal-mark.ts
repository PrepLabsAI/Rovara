// How a lesson that began as a team suggestion (a tool outside Rovara, or one of Rovara's own agents; L4-AK3) is told apart. It carries one fixed source key, `proposed:tool` or `proposed:agent`, in
// `provenance.sources`: no new stored field and no new span kind, so a lesson learned before this reads as "not proposed" and nothing that reads provenance has to know a new word. The key survives a merge
// (sources are a union), so a suggestion folded into another lesson still says where one of its sightings came from.
import type { KnowledgeProposer } from "@agentx/contracts";
import { normId, type Lesson } from "./types.js";

export const PROPOSED_SOURCE: Readonly<Record<KnowledgeProposer, string>> = { tool: "proposed:tool", agent: "proposed:agent" };

/** Whether a lesson began as a team suggestion, and from which kind of proposer (a tool wins when both are among its sources: the weaker, outside one is what a reader should know). */
export function proposedByOf(lesson: Pick<Lesson, "provenance">): KnowledgeProposer | undefined {
  const sources = lesson.provenance.sources;
  if (sources.includes(PROPOSED_SOURCE.tool)) return "tool";
  if (sources.includes(PROPOSED_SOURCE.agent)) return "agent";
  return undefined;
}

/**
 * How many INDEPENDENT sightings a suggestion has: distinct tasks (an agent's) plus distinct people (a tool's, by the person whose sign-in the tool used). One person's tool saying the same thing twice is one sighting, and
 * so is one task's agent. Two of any mix are two. Only meaningful for a lesson that is a suggestion (`proposedByOf`).
 */
export function proposalSightings(lesson: Pick<Lesson, "provenance">): number {
  return new Set([...lesson.provenance.supportTasks.map((id) => `task:${id}`), ...lesson.provenance.authors.map((id) => `person:${normId(id)}`)]).size;
}
