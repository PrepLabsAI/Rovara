// Design review stage: a reviewer's citation must match something THAT reviewer was given. The broker applies the check to the answer it reads itself.
import { describe, expect, it } from "vitest";
import type { DesignCitation, RawDesignFinding, ReviewerRole } from "@agentx/contracts";
import { filterReviewerCitations, citationProblem, checkResolveCitations, type CitablePacketItem } from "../../packages/broker/src/core/design-review/citations.js";

const sha = (c: string): string => c.repeat(64);
const PIN = "a".repeat(40);
const criticItems: CitablePacketItem[] = [
  { kind: "design", ref: "design.md", commitOrFetchedAt: "r1", digest: sha("1") },
  { kind: "repo_file", ref: "api:src/a.ts", commitOrFetchedAt: PIN, digest: sha("2") },
  { kind: "mcp_item", ref: "src1:ITEM-1", commitOrFetchedAt: "2026-11-03T10:00:00.000Z", digest: sha("3") },
];
const codebaseItems: CitablePacketItem[] = [{ kind: "design", ref: "design.md", commitOrFetchedAt: "r1", digest: sha("1") }];
const packets = new Map<ReviewerRole, CitablePacketItem[]>([["critic", criticItems], ["codebase", codebaseItems]]);
const code = (over: Partial<Extract<DesignCitation, { kind: "code" }>> = {}): DesignCitation => ({ kind: "code", repo: "api", path: "src/a.ts", startLine: 1, endLine: 2, anchor: "x", commit: PIN.slice(0, 8), ...over });
const raw = (role: ReviewerRole, id: string, citations: DesignCitation[], severity: RawDesignFinding["severity"] = "major"): RawDesignFinding =>
  ({ rawId: `${role}-${id}`, role, severity, section: "§3", text: `finding ${id}`, citations });

describe("filterReviewerCitations", () => {
  it("keeps a design citation, a source in the packet with its real digest, and a code citation to a packet file", () => {
    const result = filterReviewerCitations([raw("critic", "1", [{ kind: "design", section: "§3" }, { kind: "source", ref: "src1:ITEM-1", digest: sha("3") }, code()])], packets);
    expect(result.findings[0]!.citations).toHaveLength(3);
    expect(result.droppedCitations).toEqual([]);
    expect(result.droppedFindings).toEqual([]);
  });

  it("accepts a code citation at the round's pin for a file the reviewer opened itself, and refuses another commit, another repository or an unsafe path", () => {
    const pins = { api: PIN };
    const ok = (c: DesignCitation) => citationProblem(c, codebaseItems, pins);
    expect(ok(code({ path: "src/other.ts" }))).toBeUndefined();
    expect(ok(code({ path: "src/other.ts", commit: "deadbee" }))).toBe("code_not_allowed");
    expect(ok(code({ repo: "other" }))).toBe("code_not_allowed");
    expect(ok(code({ path: "../../etc/passwd" }))).toBe("code_not_allowed");
    expect(ok(code({ path: "/etc/passwd" }))).toBe("code_not_allowed");
    expect(citationProblem(code({ path: "src/other.ts" }), codebaseItems, {})).toBe("code_not_allowed");
    expect(citationProblem(code({ repo: "__proto__" }), codebaseItems, {})).toBe("code_not_allowed");
  });
});

describe("checkResolveCitations (the planner's evidence)", () => {
  const items = [...criticItems];
  it("drops fabricated evidence and flags a contest that is left with no design or code evidence", () => {
    const result = checkResolveCitations({
      items, pins: { api: PIN },
      resolutions: [
        { findingId: "m1", action: "contested", note: "n", evidence: [code({ repo: "other" }), { kind: "source", ref: "src1:ITEM-1", digest: sha("3") }] },
        { findingId: "m2", action: "contested", note: "n", evidence: [{ kind: "design", section: "§3" }, code({ repo: "other" })] },
        { findingId: "m3", action: "fixed", note: "n" },
      ],
      questions: [{ id: "q1", unclear: "u", evidence: [{ kind: "source", ref: "nope", digest: sha("3") }, { kind: "design", section: "§3" }], options: [{ id: "a", label: "A", consequence: "c" }, { id: "b", label: "B", consequence: "c" }], recommended: "a", why: "w" }],
    });
    expect(result.uncontestable).toEqual(["m1"]);
    expect(result.resolutions[1]!.evidence).toEqual([{ kind: "design", section: "§3" }]);
    expect(result.resolutions[2]).toEqual({ findingId: "m3", action: "fixed", note: "n" });
    expect(result.questions[0]!.evidence).toEqual([{ kind: "design", section: "§3" }]);
    expect(result.droppedCitations).toBe(3);
  });
});
