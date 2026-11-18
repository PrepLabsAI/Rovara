// How a lesson that began as a team suggestion (a tool outside Rovara, or one of Rovara's own agents; L4-AK3) is told apart. It carries one fixed source key, `proposed:tool` or `proposed:agent`, in
// `provenance.sources`: no new stored field and no new span kind, so a lesson learned before this reads as "not proposed" and nothing that reads provenance has to know a new word. The key survives a merge
// (sources are a union), so a suggestion folded into another lesson still says where one of its sightings came from.
import { createHash } from "node:crypto";
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

/** The source key that records, without the person's id, WHO REQUESTED the task an agent's suggestion came from (a short hash of the normalised id): it lets the sightings rule leave that person out of the count of other people. */
export const REQUESTER_SOURCE_PREFIX = "requester:";
const requesterHash = (id: string): string => createHash("sha256").update(`proposal-requester\u0000${normId(id)}`).digest("hex").slice(0, 16);
export const requesterSourceOf = (personId: string): string => `${REQUESTER_SOURCE_PREFIX}${requesterHash(personId)}`;

/**
 * How many INDEPENDENT sightings a suggestion has: distinct tasks (an agent's) plus distinct people (a tool's, by the person whose sign-in the tool used). One person's tool saying the same thing twice is one sighting, and
 * so is one task's agent. A person who REQUESTED one of the tasks behind it (their task's agent suggested it) is that task's sighting already: their own tool saying the same is not another person's. Two of any other mix
 * are two. Only meaningful for a lesson that is a suggestion (`proposedByOf`).
 */
export function proposalSightings(lesson: Pick<Lesson, "provenance">): number {
  const requesters = new Set(lesson.provenance.sources.filter((source) => source.startsWith(REQUESTER_SOURCE_PREFIX)));
  const people = lesson.provenance.authors.filter((id) => !requesters.has(requesterSourceOf(id)));
  return new Set([...lesson.provenance.supportTasks.map((id) => `task:${id}`), ...people.map((id) => `person:${normId(id)}`)]).size;
}
