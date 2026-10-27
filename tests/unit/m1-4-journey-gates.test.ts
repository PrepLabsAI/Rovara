import { describe, expect, it } from "vitest";
import { publicationFencesOf, sendBackOfferedAfter } from "../support/m1-4-journey-gates.js";

// JOURNEY46: the two gates the Docker-only M1.4 journeys assert (renamed-export: publication checks not empty; wrong-action: send-back offered) are decided here from a verdict; this runs
// without Docker, so the helpers the journeys call are proved to give the right answer for each verdict.
const round = { candidateDigest: "a".repeat(64), roundId: "round-1", groupRunIds: ["run-1"], admissionSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) };
const admission = { runtimeBindings: [{ key: "web-1:web", value: {} }, { key: "web-1:api", value: {} }] } as never;

describe("the gates after an M1.4 journey's verdict", () => {
  it("fences the admitted runtime rows for a PASS and nothing for any other verdict", () => {
    expect(publicationFencesOf(admission, "PASS")).toEqual(["web-1:web", "web-1:api"]);
    expect(publicationFencesOf(admission, "FAILED")).toEqual([]);
    expect(publicationFencesOf(admission, "UNKNOWN")).toEqual([]);
    expect(publicationFencesOf({ runtimeBindings: [] } as never, "PASS")).toEqual([]);
  });

  it("offers send-back for a FAILED round and for no other verdict", () => {
    expect(sendBackOfferedAfter({ ...round, verdict: "FAILED" })).toBe(true);
    expect(sendBackOfferedAfter({ ...round, verdict: "UNKNOWN" })).toBe(false);
    expect(sendBackOfferedAfter({ ...round, verdict: "PASS" })).toBe(false);
  });

  it("records no send-back for a failed round that names no groups", () => {
    // The failed round the workflow records must name its own groups: an empty list is not a failure the owner can act on.
    expect(sendBackOfferedAfter({ ...round, groupRunIds: [], verdict: "FAILED" })).toBe(false);
  });
});
