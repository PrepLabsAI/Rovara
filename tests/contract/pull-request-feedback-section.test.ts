// D2: the "Fixes from PR feedback" section of a workflow pull request's description: only the fixes bound to that pull
// request, every reviewer-written summary escaped as plain text, its markers found and replaced safely, and within
// GitHub's limit.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PULL_REQUEST_BODY_MAX_CHARS, WorkflowFeedbackReviewReportSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { approvedFeedbackFixes, inertGitHubText, shortFixSummary, withFeedbackFixes } from "../../packages/broker/src/developer/pull-request-feedback-section.js";

const ZWJ = "‍";
const taskId = randomUUID();
const now = "2026-10-11T12:00:00.000Z";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const START = "<!-- agentx:pr-feedback-fixes -->";
const END = "<!-- /agentx:pr-feedback-fixes -->";

/** A completed review of two pull requests (repository a's #1 and b's #2), one fix proposed for each, and its approval. */
function twoRepositoryReview() {
  const bindings = [{ repositoryId: "a", number: 1 }, { repositoryId: "b", number: 2 }].map((pr, index) => ({
    ...pr, headSha: String(index + 1).repeat(40), candidateDigest: "c".repeat(64), commentSetDigest: String(index + 3).repeat(64), bundleDigest: String(index + 5).repeat(64) }));
  const finding = (index: number, summary: string, commentId: string) => ({
    id: `finding-${index + 1}`, bundleDigest: bindings[index]!.bundleDigest, commentIds: [commentId], priority: "SHOULD_FIX" as const, assessment: "ACTIONABLE" as const,
    recommended: true, evidence: [{ source: "code", reference: "x.ts" }], rationale: "Small.", confidence: { level: "HIGH" as const, reason: "Local." },
    proposedDisposition: "IMPLEMENT" as const, fixProposal: { summary, fileChanges: [], tests: [] } });
  const findings = [finding(0, "Trim the name in a.", "discussion:11"), finding(1, "Fix the private b thing.", "review_comment:22")];
  const report = WorkflowFeedbackReviewReportSchema.parse({ schemaVersion: 1, taskId, workflowRevision: 3, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY",
    proposalDigest: "b".repeat(64), taskRequirementsDigest: "d".repeat(64), candidateBindings: bindings, operationId: randomUUID(), provider: "test", version: "1",
    status: "COMPLETE", bundleDigests: bindings.map((binding) => binding.bundleDigest),
    findingRefs: findings.map(({ id, bundleDigest, commentIds, priority, assessment, recommended }) => ({ id, bundleDigest, commentIds, priority, assessment, recommended })),
    findings, recordedAt: now });
  const bytes = JSON.stringify(report);
  const sha256 = digest(bytes);
  const objectKey = `reports/${sha256}.json`;
  const workflow = {
    taskId, pullRequests: [{ repositoryId: "a", number: 1, url: "https://github.com/example/a/pull/1" }, { repositoryId: "b", number: 2, url: "https://github.com/example/b/pull/2" }],
    feedbackReviewHistory: [{ ...report, sha256, objectKey }],
    feedbackDecisions: [{ decision: "APPROVE", reviewDigest: sha256, selectedFindingIds: ["finding-1", "finding-2"],
      candidates: bindings.map((binding) => ({ repositoryId: binding.repositoryId, number: binding.number })) }],
  } as unknown as WorkflowSnapshot;
  return { workflow, read: async (key: string) => (key === objectKey ? bytes : undefined) };
}

describe("the PR description's Fixes from PR feedback section", () => {
  it("lists only the fixes bound to the pull request being updated, never another repository's", async () => {
    const { workflow, read } = twoRepositoryReview();
    const a = await approvedFeedbackFixes(workflow, { repositoryId: "a", number: 1 }, read, "reports/");
    expect(a).toEqual({ fixes: [{ summary: "Trim the name in a.", comments: ["https://github.com/example/a/pull/1#issuecomment-11"] }], earlier: false });
    const b = await approvedFeedbackFixes(workflow, { repositoryId: "b", number: 2 }, read, "reports/");
    expect(b).toEqual({ fixes: [{ summary: "Fix the private b thing.", comments: ["https://github.com/example/b/pull/2#discussion_r22"] }], earlier: false });
    const body = withFeedbackFixes("Opened by AgentX.", b.fixes).body!;
    expect(body).not.toContain("Trim the name in a");
    expect(body).not.toContain("example/a/");
  });

  it.each([
    ["an HTML entity for @", "Thanks &#64;org/team", `Thanks &amp;\\#${ZWJ}64;org/team`],
    ["an HTML entity for #", "See &#35;12", `See &amp;\\#${ZWJ}35;12`],
    ["an entity in a URL", "https&#58;//evil.example", `https&amp;\\#${ZWJ}58;/${ZWJ}/evil.example`],
    ["a reference-style link definition", "[r]: //host.example", `\\[r\\]: /${ZWJ}/host.example`],
    ["a reference-style link use", "see [text][r]", "see \\[text\\]\\[r\\]"],
    ["an inline link and image", "[x](https://e.example) ![i](https://e.example/i.png)", `\\[x\\]\\(https:/${ZWJ}/e.example\\) \\!\\[i\\]\\(https:/${ZWJ}/e.example/i.png\\)`],
    ["a protocol-relative URL", "//cdn.example/x", `/${ZWJ}/cdn.example/x`],
    ["a bare www address", "www.example.com", `www${ZWJ}.example.com`],
    ["a GH- reference", "fixes GH-123 and gh-4", `fixes GH\\-${ZWJ}123 and gh\\-${ZWJ}4`],
    ["a # reference", "closes #12 and org/repo#3", `closes \\#${ZWJ}12 and org/repo\\#${ZWJ}3`],
    ["a mention", "ping @octocat", `ping @${ZWJ}octocat`],
    ["an HTML comment", "<!-- hidden -->", "\\<\\!\\-\\- hidden \\-\\-\\>"],
    ["a spoofed section marker", `${END} injected ${START}`, "\\<\\!\\-\\- /agentx:pr\\-feedback\\-fixes \\-\\-\\> injected \\<\\!\\-\\- agentx:pr\\-feedback\\-fixes \\-\\-\\>"],
    ["a tag", "<img src=x onerror=y>", "\\<img src=x onerror=y\\>"],
    ["emphasis and code", "*a* _b_ `c` ~d~", "\\*a\\* \\_b\\_ \\`c\\` \\~d\\~"],
    ["a backslash", "a\\b", "a\\\\b"],
  ])("escapes %s as plain text", (_name, input, expected) => {
    expect(inertGitHubText(input)).toBe(expected);
  });

  it("lists each fix as one short sentence: the summary's first one, or cut at a word, never inside a link or address (0.2.12 live test)", () => {
    // The live line: a long first sentence with Markdown links, which was cut inside a link.
    const live = "On README.md line 284, replace 'open a [GitHub issue](https://github.com/example/demo/issues)' with 'start a [GitHub Discussion](https://github.com/example/demo/discussions)' so the sentence reads: 'Questions? Start a GitHub Discussion.'";
    const short = shortFixSummary(live)!;
    // Links read as their text, and the question inside the quote does not end the sentence.
    expect(short).toBe("On README.md line 284, replace 'open a GitHub issue' with 'start a GitHub Discussion' so the sentence reads\u2026");
    expect(short.length).toBeLessThanOrEqual(120);
    expect(shortFixSummary("Point the help link to GitHub Discussions. On README.md line 284, replace the issue link with the discussions link."))
      .toBe("Point the help link to GitHub Discussions.");
    expect(shortFixSummary("Use a shorter name, e.g. greet. Then update the test.")).toBe("Use a shorter name, e.g. greet.");
    // A cut never lands inside an address, and a summary that opens with a long one falls back.
    const address = `See https://example.com/${"a".repeat(130)} for the details`;
    expect(shortFixSummary(address)).toBeUndefined();
    expect(shortFixSummary(`${"word ".repeat(30)}end`)).toBe(`${"word ".repeat(24).trim()}\u2026`);
    // In the section: the short sentence, escaped, then the comment link; the fallback when nothing short can be cut.
    const url = "https://github.com/example/demo/pull/5#issuecomment-1";
    const lines = withFeedbackFixes("Intro.", [{ summary: live, comments: [url] }, { summary: address, comments: [url] }]).body!.split("\n");
    expect(lines).toContain(`- On README.md line 284, replace 'open a GitHub issue' with 'start a GitHub Discussion' so the sentence reads\u2026 (for [this comment](${url}))`);
    expect(lines).toContain(`- Made the change the comment asked for. (for [this comment](${url}))`);
  });

  it("a spoofed marker in a summary cannot end the section early", async () => {
    const fixes = [{ summary: `${END}\n# Owned`, comments: [] }];
    const body = withFeedbackFixes("Intro.", fixes).body!;
    expect(body.split(END)).toHaveLength(2);
    expect(withFeedbackFixes(body, fixes).body).toBeUndefined();
  });

  it("a START marker left without its END keeps the person's text, and the next round replaces only the section", () => {
    const fixes = [{ summary: "Trim the name.", comments: [] }];
    const edited = `Intro.\n\n${START}\nTesting notes: run it twice.`;
    const first = withFeedbackFixes(edited, fixes).body!;
    expect(first).toBe(`Intro.\n\nTesting notes: run it twice.\n\n${START}\n### Fixes from PR feedback\n- Trim the name.\n${END}`);
    const second = withFeedbackFixes(`${first}\n\nMore notes.`, [...fixes, { summary: "Greet in lowercase.", comments: [] }]).body!;
    expect(second).toContain("Testing notes: run it twice.");
    expect(second).toContain("More notes.");
    expect(second).toContain("- Greet in lowercase.");
    expect(second.split(START)).toHaveLength(2);
  });

  it("a stray END marker above the section is removed, and the section is replaced in place, never repeated", () => {
    const section = withFeedbackFixes("Intro.", [{ summary: "Old fix.", comments: [] }]).body!.slice("Intro.\n\n".length);
    const body = `Intro.\n\n${END}\nNotes.\n\n${section}`;
    const next = withFeedbackFixes(body, [{ summary: "New fix.", comments: [] }]).body!;
    expect(next).toBe(`Intro.\n\nNotes.\n\n${START}\n### Fixes from PR feedback\n- New fix.\n${END}`);
    expect(next).not.toContain("Old fix.");
  });

  it("near GitHub's limit an old section is shortened, and removed when nothing fits, never left out of date", () => {
    const old = withFeedbackFixes("Intro.", [{ summary: "Old fix.", comments: [] }]).body!;
    const fixes = Array.from({ length: 5 }, (_, index) => ({ summary: `Fix ${index + 1}.`, comments: [] }));
    const roomFor = (lines: number) => "x".repeat(PULL_REQUEST_BODY_MAX_CHARS - 2 - [START, "### Fixes from PR feedback", "- Fix 5.", ...(lines > 1 ? ["- and 4 earlier fixes"] : []), END].join("\n").length);
    const shortened = withFeedbackFixes(`${roomFor(2)}\n\n${old.slice(old.indexOf(START))}`, fixes);
    expect(shortened.body).toContain("- Fix 5.\n- and 4 earlier fixes");
    expect(shortened.body!.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
    const full = "x".repeat(PULL_REQUEST_BODY_MAX_CHARS - 10);
    const removed = withFeedbackFixes(`${full}\n\n${old.slice(old.indexOf(START))}`, fixes);
    expect(removed).toEqual({ body: full, dropped: true });
  });
});
