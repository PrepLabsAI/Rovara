// L4-AK3: what counts as an INDEPENDENT sighting of a team suggestion, tested on the rule itself (the route and the settle step are in propose.test.ts). Two sightings put a suggestion in front of people; one never does.
import { describe, expect, it } from "vitest";
import { earnedAttention } from "../../../packages/broker/src/lessons/process.js";
import { PROPOSED_SOURCE, proposalSightings, proposedByOf, requesterSourceOf } from "../../../packages/broker/src/lessons/proposal-mark.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { draft, lessonRecord } from "../lessons/lesson-helpers.js";

const suggestion = (over: { authors?: string[]; supportTasks?: string[]; sources?: string[] } = {}): Lesson => lessonRecord({
  status: "candidate", tier: 1, tierReasons: [], approvals: [], citations: [], citationChecks: [],
  provenance: { ...draft().provenance, minTrust: "system", memberSignal: false, measured: false, authors: over.authors ?? [], supportTasks: over.supportTasks ?? [], sources: over.sources ?? [PROPOSED_SOURCE.tool], inputSources: [] },
});

describe("independent sightings of a suggestion", () => {
  it("counts distinct tasks and distinct people, one of each is two", () => {
    expect(proposalSightings(suggestion({ authors: ["ann"] }))).toBe(1);
    expect(proposalSightings(suggestion({ supportTasks: ["t1"], sources: [PROPOSED_SOURCE.agent] }))).toBe(1);
    expect(proposalSightings(suggestion({ authors: ["ann", "bob"] }))).toBe(2);
    expect(proposalSightings(suggestion({ supportTasks: ["t1", "t2"], sources: [PROPOSED_SOURCE.agent] }))).toBe(2);
    expect(proposalSightings(suggestion({ authors: ["ann"], supportTasks: ["t1"] }))).toBe(2);
  });
  it("a person's ids that differ only in case or spaces are one person", () => {
    expect(proposalSightings(suggestion({ authors: ["Bob", "bob", " BOB "] }))).toBe(1);
    expect(proposalSightings(suggestion({ authors: ["Bob", "bob", "ann"] }))).toBe(2);
  });
  it("a person's own tool and their own task's agent are ONE sighting, in either order and whatever the spelling of their id", () => {
    const viaAgent = suggestion({ authors: ["Ann"], supportTasks: ["t1"], sources: [PROPOSED_SOURCE.tool, PROPOSED_SOURCE.agent, requesterSourceOf("ann")] });
    expect(proposalSightings(viaAgent)).toBe(1);
    // Someone else's tool is a second sighting of the same suggestion.
    expect(proposalSightings(suggestion({ authors: ["Ann", "bob"], supportTasks: ["t1"], sources: [PROPOSED_SOURCE.tool, PROPOSED_SOURCE.agent, requesterSourceOf("ann")] }))).toBe(2);
    // A second task of the same requester is still a second task.
    expect(proposalSightings(suggestion({ authors: ["ann"], supportTasks: ["t1", "t2"], sources: [PROPOSED_SOURCE.agent, requesterSourceOf("ann")] }))).toBe(2);
    // A requester source for someone else does not remove this person.
    expect(proposalSightings(suggestion({ authors: ["ann"], supportTasks: ["t1"], sources: [PROPOSED_SOURCE.agent, requesterSourceOf("bob")] }))).toBe(2);
  });
  it("the requester source holds a hash, never the person's id", () => {
    expect(requesterSourceOf("ann")).toMatch(/^requester:[0-9a-f]{16}$/u);
    expect(requesterSourceOf("ann")).not.toContain("ann");
    expect(requesterSourceOf("ANN")).toBe(requesterSourceOf("ann"));
    expect(requesterSourceOf("ann")).not.toBe(requesterSourceOf("bob"));
  });
  it("only two sightings earn a card (earnedAttention), one never does", () => {
    expect(earnedAttention(suggestion({ authors: ["ann"] }), 1)).toBe(false);
    expect(earnedAttention(suggestion({ authors: ["ann", "bob"] }), 1)).toBe(true);
    expect(earnedAttention(suggestion({ authors: ["ann"], supportTasks: ["t1"], sources: [PROPOSED_SOURCE.tool, requesterSourceOf("ann")] }), 1)).toBe(false);
    expect(proposedByOf(suggestion())).toBe("tool");
  });
});
