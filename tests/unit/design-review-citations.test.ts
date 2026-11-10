// Design review stage: a reviewer's citation must match something THAT reviewer was given. The broker applies the check to the answer it reads itself.
import { describe, expect, it } from "vitest";
import type { DesignCitation, RawDesignFinding, ReviewerRole } from "@agentx/contracts";
import { buildReviewerPacket, renderPacketDocument } from "../../packages/broker/src/core/design-review/packet.js";
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

  it("drops a forged digest on a real ref and says why", () => {
    const result = filterReviewerCitations([raw("critic", "1", [{ kind: "design", section: "§1" }, { kind: "source", ref: "src1:ITEM-1", digest: sha("f") }])], packets);
    expect(result.findings[0]!.citations).toEqual([{ kind: "design", section: "§1" }]);
    expect(result.droppedCitations.map((d) => d.reason)).toEqual(["source_digest_mismatch"]);
  });

  it("drops a ref that is not in the packet, even with a digest that is some other item's", () => {
    const result = filterReviewerCitations([raw("critic", "1", [{ kind: "source", ref: "never-given", digest: sha("3") }])], packets);
    expect(result.findings).toEqual([]);
    expect(result.droppedCitations.map((d) => d.reason)).toEqual(["source_not_in_packet"]);
  });

  it("drops a finding left with no citation and records its severity, so a lost blocker is visible", () => {
    const result = filterReviewerCitations([raw("critic", "1", [{ kind: "source", ref: "never-given", digest: sha("9") }], "blocker")], packets);
    expect(result.droppedFindings).toEqual([{ rawId: "critic-1", role: "critic", severity: "blocker", section: "§3", reason: "no_valid_citation" }]);
  });

  it("checks each citation against the packet of the reviewer that wrote it, not another reviewer's", () => {
    // ITEM-1 was given to the critic only. The codebase reviewer citing it saw nothing of the kind.
    const result = filterReviewerCitations([
      raw("critic", "1", [{ kind: "source", ref: "src1:ITEM-1", digest: sha("3") }]),
      raw("codebase", "1", [{ kind: "source", ref: "src1:ITEM-1", digest: sha("3") }]),
    ], packets);
    expect(result.findings.map((f) => f.rawId)).toEqual(["critic-1"]);
    expect(result.droppedFindings.map((f) => f.rawId)).toEqual(["codebase-1"]);
  });

  it("a reviewer with no packet gets no source or code citation accepted (fail closed), but a design citation stands", () => {
    const result = filterReviewerCitations([raw("zoom_out", "1", [{ kind: "source", ref: "design.md", digest: sha("1") }]), raw("zoom_out", "2", [{ kind: "design", section: "§2" }])], packets);
    expect(result.findings.map((f) => f.rawId)).toEqual(["zoom_out-2"]);
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

  it("a code citation to a packet file at the wrong commit is dropped", () => {
    expect(citationProblem(code({ commit: "deadbee" }), criticItems)).toBe("code_not_allowed");
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

describe("the citation check compares against the refs the frames show", () => {
  it("a reviewer that copies ref and digest from a rendered frame is accepted, an MCP item by sourceId:itemRef; a stale or route-label ref is dropped", async () => {
    const packet = await buildReviewerPacket({
      role: "critic", design: { ref: "design.md", revision: "r1", text: "# D" }, requirements: { ref: "requirements.md", revision: "r1", text: "R1" },
      baseCommits: { api: PIN }, sources: [{ kind: "repo_file", repo: "api", path: "src/a.ts" }, { kind: "mcp_item", sourceId: "tracker", itemRef: "ABC-1" }],
    }, { readRepoFile: async () => "code", readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: true, text: '<source-result item="ABC-1" untrusted="true">x</source-result>', fetchedAt: "2026-11-03T10:00:00.000Z" }) });
    const copied = packet.documents.map((document) => {
      const opener = /^<source-file kind="([a-z_]+)" ref="([^"]+)" at="([^"]+)" digest="([a-f0-9]{64})"/u.exec(renderPacketDocument(document))!;
      return { kind: opener[1]!, ref: opener[2]!, at: opener[3]!, digest: opener[4]! };
    });
    const mcp = copied.find((entry) => entry.kind === "mcp_item")!;
    expect(mcp.ref).toBe("tracker:ABC-1");
    const items = new Map<ReviewerRole, CitablePacketItem[]>([["critic", packet.items]]);
    const result = filterReviewerCitations([
      raw("critic", "ok", [{ kind: "source", ref: mcp.ref, digest: mcp.digest }]),
      raw("critic", "label", [{ kind: "source", ref: "ABC-1", digest: mcp.digest }]),
      raw("critic", "tool", [{ kind: "source", ref: "tracker:search:ABC-1", digest: mcp.digest }]),
      raw("critic", "code", [code({ commit: copied.find((entry) => entry.kind === "repo_file")!.at })]),
    ], items);
    expect(result.findings.map((finding) => finding.rawId)).toEqual(["critic-ok", "critic-code"]);
    expect(result.droppedCitations.map((dropped) => dropped.reason)).toEqual(["source_not_in_packet", "source_not_in_packet"]);
  });
});
