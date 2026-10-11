import { describe, expect, it } from "vitest";
import type { PlanClaim, PlanDecision, PlanDocument, PlanEvidenceBundle } from "@agentx/contracts";
import { claimAnchor, renderPlanDocument, type RenderPlanInput } from "../../packages/broker/src/aws/plan-page/render-plan.js";
import type { PageCommentView } from "../../packages/broker/src/aws/plan-page/comments.js";
import { resolvePlanEvidence } from "../../packages/broker/src/developer/plan-evidence.js";
import { planDocument } from "../support/plan-documents.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function input(overrides: Partial<RenderPlanInput> = {}): RenderPlanInput {
  return { anchor: "design", kind: "design", version: 1, approved: false, current: true, plan: planDocument(), openWhatChanged: false, ...overrides };
}
const claims = (count: number): PlanClaim[] => Array.from({ length: count }, (_, index) => ({ id: String(index + 1), text: `Claim number ${index + 1}.` }));
const decision = (index: number, claimId = "1"): PlanDecision => ({
  id: `d${index}`,
  claimId,
  question: `Question ${index}?`,
  options: [{ id: "yes", label: `Yes ${index}`, consequence: `Consequence of yes ${index}.` }, { id: "no", label: `No ${index}`, consequence: `Consequence of no ${index}.` }],
  recommended: "yes",
});
const count = (html: string, pattern: RegExp): number => html.match(pattern)?.length ?? 0;

describe("the plan page renderer", () => {
  it("builds claim anchors with dashes for dots", () => {
    expect(claimAnchor("design", 2, "1.2.3")).toBe("design-v2-1-2-3");
    expect(claimAnchor("coding-plan", 1, "4")).toBe("coding-plan-v1-4");
  });

  it("opens with a heading, a status line and a link to the document", async () => {
    const html = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", version: 3, approved: true }));
    expect(html).toContain('<section id="coding-plan-v3" class="doc');
    expect(html).toContain("Coding plan v3");
    expect(html).toContain("Approved");
    expect(html).toContain('href="#coding-plan-v3"');
    const pending = await renderPlanDocument(input());
    expect(pending).toContain("Design v1");
    expect(pending).toContain("Not approved yet");
  });

  it("says which version is current on an older version", async () => {
    const html = await renderPlanDocument(input({ current: false, currentVersion: 3 }));
    expect(html).toContain("This is v1. v3 is the current one.");
    expect(await renderPlanDocument(input())).not.toContain("is the current one");
  });

  it("shows five level-one claims open and folds the rest", async () => {
    const html = await renderPlanDocument(input({ plan: planDocument({ claims: claims(12), decisions: [] }) }));
    expect(html).toContain("Show 7 more");
    expect(count(html, /<details id="design-v1-\d+" class="claim level-1" open>/g)).toBe(5);
    const folded = html.slice(html.indexOf('<details class="more">'));
    expect(folded).toContain("Claim number 12.");
    expect(folded).not.toContain(" open>");
    // The five shown come before the fold.
    expect(html.indexOf("Claim number 5.")).toBeLessThan(html.indexOf("Show 7 more"));
    expect(html.indexOf("Claim number 6.")).toBeGreaterThan(html.indexOf("Show 7 more"));
  });

  it("nests children with their own anchors and folds children past five", async () => {
    const children = Array.from({ length: 7 }, (_, index) => ({ id: `1.${index + 1}`, text: `Child ${index + 1}.` }));
    const html = await renderPlanDocument(input({ version: 2, plan: planDocument({ claims: [{ id: "1", text: "Parent.", children: [{ ...children[0]!, children: [{ id: "1.1.1", text: "Grandchild." }] }, ...children.slice(1)] }], decisions: [] }) }));
    for (const id of ["design-v2-1", "design-v2-1-1", "design-v2-1-1-1", "design-v2-1-7"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Show 2 more");
    expect(html).toMatch(/<details id="design-v2-1-1" class="claim level-2">/);
  });

  it("badges a new and a changed claim against the previous version", async () => {
    const previous = planDocument({ claims: [{ id: "1", text: "Old wording." }, { id: "2", text: "Same." }], decisions: [] });
    const plan = planDocument({ claims: [{ id: "1", text: "New wording." }, { id: "2", text: "Same." }, { id: "3", text: "Brand new." }], decisions: [] });
    const html = await renderPlanDocument(input({ version: 2, plan, previous: { version: 1, plan: previous } }));
    const summary = (id: string): string => html.match(new RegExp(`<details id="design-v2-${id}"[^>]*><summary>(.*?)</summary>`))![1]!;
    expect(summary("1")).toContain("Changed since v1");
    expect(summary("1")).not.toContain(">New<");
    expect(summary("3")).toContain(">New<");
    expect(summary("2")).not.toContain("badge");
  });

  it("badges a claim changed after the earlier step was approved", async () => {
    const approvedEarlier = planDocument({ claims: [{ id: "1", text: "As approved." }, { id: "2", text: "Untouched." }], decisions: [] });
    const plan = planDocument({ claims: [{ id: "1", text: "Reworded since." }, { id: "2", text: "Untouched." }], decisions: [] });
    const html = await renderPlanDocument(input({ plan, approvedEarlier }));
    expect(count(html, /Changed after approval/g)).toBe(1);
    expect(html.match(/<details id="design-v1-1"[^>]*><summary>(.*?)<\/summary>/)![1]).toContain("Changed after approval");
  });

  it("does not badge a claim whose text is unchanged but that gained evidence or children after approval", async () => {
    const approvedEarlier = planDocument({ claims: [{ id: "1", text: "Same words." }, { id: "2", text: "Also same." }], decisions: [] });
    const plan = planDocument({
      claims: [
        { id: "1", text: "Same words.", evidence: [{ kind: "quote", text: "Added later.", author: "Priya" }] },
        { id: "2", text: "Also same.", children: [{ id: "2.1", text: "A new child." }] },
      ],
      decisions: [],
    });
    const html = await renderPlanDocument(input({ plan, approvedEarlier }));
    expect(html).not.toContain("Changed after approval");
  });

  it("lists what changed, open only when the reader came from an older version", async () => {
    const previous = planDocument({
      claims: [{ id: "1", text: "Old wording." }, { id: "2", text: "Dropped claim." }],
      decisions: [decision(1)],
    });
    const plan = planDocument({ claims: [{ id: "1", text: "New wording." }, { id: "3", text: "Added claim." }], decisions: [decision(2, "3")] });
    const closed = await renderPlanDocument(input({ version: 2, plan, previous: { version: 1, plan: previous } }));
    expect(closed).toContain('<details class="changes">');
    expect(closed).toContain("What changed since v1");
    const section = closed.slice(closed.indexOf('<details class="changes"'), closed.indexOf("</details>", closed.indexOf('<details class="changes"')));
    for (const word of ["Added", "Added claim.", "Changed", "New wording.", "Removed", "Dropped claim.", "Question 2?", "Question 1?"]) expect(section).toContain(word);
    const open = await renderPlanDocument(input({ version: 2, plan, previous: { version: 1, plan: previous }, openWhatChanged: true }));
    expect(open).toContain('<details class="changes" open>');
    expect(await renderPlanDocument(input())).not.toContain("What changed");
  });

  it("shows the first reason cut to 120 characters, and every reason inside", async () => {
    const long = `${"A long reason. ".repeat(20)}end`;
    const html = await renderPlanDocument(input({ plan: planDocument({ why: [{ text: long, author: "Priya" }, { text: "Second reason.", author: "Sam" }] }) }));
    const summary = html.match(/<details class="why"><summary>(.*?)<\/summary>/)![1]!;
    expect(Array.from(summary).length).toBeLessThanOrEqual(120);
    expect(summary.endsWith("…")).toBe(true);
    expect(html).toContain("Second reason.");
    expect(html).toContain("Sam");
  });

  it("shows a code excerpt with numbered lines and the short commit", async () => {
    const evidence: PlanEvidenceBundle = {
      schemaVersion: 1,
      excerpts: [{ claimId: "1", index: 0, path: "payments/src/charge.ts", startLine: 10, endLine: 12, status: "ok", commit: COMMIT, lines: ["const a = 1 < 2;", "", "return a;"] }],
    };
    const html = await renderPlanDocument(input({ evidence }));
    expect(html).toContain("<figcaption>payments/src/charge.ts, lines 10-12, 0123456</figcaption>");
    expect(html).not.toContain(COMMIT);
    expect(html).toContain('<span class="ln">10</span><span class="code-text">const a = 1 &lt; 2;</span>');
    expect(html).toContain('<span class="ln">11</span><span class="code-text"></span>');
    expect(html).toContain('<span class="ln">12</span><span class="code-text">return a;</span>');
    expect(html).toContain("Today a timeout throws.");
    expect(html).not.toContain("Showing the first 80 lines.");
    const cutHtml = await renderPlanDocument(input({ evidence: { ...evidence, excerpts: [{ ...evidence.excerpts[0]!, cut: true }] } }));
    expect(cutHtml).toContain("Showing the first 80 lines.");
  });

  it("wraps long evidence rows while preserving source line identity and hostile text", async () => {
    const source = `${"x".repeat(800)}\t<svg onload=alert(1)>`;
    const html = await renderPlanDocument(input({ evidence: {
      schemaVersion: 1,
      excerpts: [{ claimId: "1", index: 0, path: "src/long.ts", startLine: 41, endLine: 42, status: "ok", lines: [source, "\tsecond\trow"] }],
    } }));
    expect(html).toContain('<span class="code-line"><span class="ln">41</span><span class="code-text">');
    expect(html).toContain('<span class="ln">42</span><span class="code-text">\tsecond\trow</span></span>');
    expect(html).toContain(`${"x".repeat(800)}\t&lt;svg onload=alert(1)&gt;`);
    expect(html).not.toContain("<svg onload");
    expect((html.match(/class="code-line"/g) ?? [])).toHaveLength(2);
  });

  it("says Not found at the commit for a wrong line range, from the resolver to the page", async () => {
    const plan = planDocument({ claims: [{ id: "1", text: "A claim.", evidence: [
      { kind: "code", path: "repo/app/a.ts", startLine: 5, endLine: 9 },
      { kind: "code", path: "elsewhere/b.ts", startLine: 1, endLine: 2 },
    ] }], decisions: [] });
    const evidence = await resolvePlanEvidence(plan, {
      repositories: [{ name: "app", path: "repo/app", url: "https://github.com/example/app.git" }],
      base: [{ repositoryId: "app", baseCommitSha: COMMIT }],
      readFile: async () => "one\ntwo\n",
    });
    const html = await renderPlanDocument(input({ plan, evidence }));
    expect(html).toContain("Not found at 0123456");
    expect(html).toContain("Not found in this task's repositories");
  });

  it("captions a clamped excerpt with its real range", async () => {
    const plan = planDocument({ claims: [{ id: "1", text: "A claim.", evidence: [{ kind: "code", path: "repo/app/a.ts", startLine: 2, endLine: 9 }] }], decisions: [] });
    const evidence = await resolvePlanEvidence(plan, {
      repositories: [{ name: "app", path: "repo/app", url: "https://github.com/example/app.git" }],
      base: [{ repositoryId: "app", baseCommitSha: COMMIT }],
      readFile: async () => "one\ntwo\nthree\n",
    });
    const html = await renderPlanDocument(input({ plan, evidence }));
    expect(html).toContain("<figcaption>repo/app/a.ts, lines 2-3, 0123456</figcaption>");
    expect(html).not.toContain("lines 2-9");
    expect(html).toContain('<span class="ln">3</span><span class="code-text">three</span>');
  });

  it("says in plain words why an excerpt is not shown", async () => {
    const base = { claimId: "1", index: 0, path: "payments/src/charge.ts", startLine: 10, endLine: 24 } as const;
    const show = async (excerpt: PlanEvidenceBundle["excerpts"][number] | undefined): Promise<string> =>
      renderPlanDocument(input(excerpt === undefined ? {} : { evidence: { schemaVersion: 1, excerpts: [excerpt] } }));
    expect(await show({ ...base, status: "not_found", commit: COMMIT })).toContain("Not found at 0123456");
    expect(await show({ ...base, status: "not_found" })).toContain("Not found in this task's repositories");
    expect(await show({ ...base, status: "unavailable" })).toContain("Couldn't load this excerpt.");
    expect(await show({ ...base, status: "skipped" })).toContain("Not loaded: this plan cites more than 40 excerpts.");
    const none = await show(undefined);
    expect(none).toContain("Couldn't load this excerpt.");
    expect(none).toContain("payments/src/charge.ts");
  });

  it("says code is shown for the current version only on an older version, without calling it a failure", async () => {
    const older = await renderPlanDocument(input({ version: 1, current: false, currentVersion: 3 }));
    expect(older).toContain("payments/src/charge.ts, lines 10-24");
    expect(older).toContain("Code is shown for the current version only (v3).");
    expect(older).not.toContain("Couldn't load this excerpt.");
    // The current version with no bundle (for example one that failed its check) still reports it.
    const current = await renderPlanDocument(input({ version: 3, current: true, currentVersion: 3 }));
    expect(current).toContain("Couldn't load this excerpt.");
    expect(current).not.toContain("current version only");
    // A real "unavailable" status on an older version that does carry a bundle keeps its own words.
    const unavailable = await renderPlanDocument(input({ version: 1, current: false, currentVersion: 3,
      evidence: { schemaVersion: 1, excerpts: [{ claimId: "1", index: 0, path: "payments/src/charge.ts", startLine: 10, endLine: 24, status: "unavailable" }] } }));
    expect(unavailable).toContain("Couldn't load this excerpt.");
  });

  it("says the code is loading for a current version stored under 15 minutes ago with no bundle, and that it couldn't load after that", async () => {
    const createdAt = "2026-10-09T12:00:00.000Z";
    const at = (minutes: number): number => Date.parse(createdAt) + minutes * 60_000;
    const loading = await renderPlanDocument(input({ createdAt, now: at(1) }));
    expect(loading).toContain("Loading code… refresh in a moment.");
    expect(loading).not.toContain("Couldn't load this excerpt.");
    expect(loading).toContain("payments/src/charge.ts, lines 10-24");
    expect(await renderPlanDocument(input({ createdAt, now: at(14.9) }))).toContain("Loading code… refresh in a moment.");
    const late = await renderPlanDocument(input({ createdAt, now: at(16) }));
    expect(late).toContain("Couldn't load this excerpt.");
    expect(late).not.toContain("Loading code");
    // With a bundle the excerpt's own status decides; an older version keeps its own sentence.
    const unavailable = await renderPlanDocument(input({ createdAt, now: at(1), evidence: { schemaVersion: 1, excerpts: [{ claimId: "1", index: 0, path: "payments/src/charge.ts", startLine: 10, endLine: 24, status: "unavailable" }] } }));
    expect(unavailable).toContain("Couldn't load this excerpt.");
    expect(unavailable).not.toContain("Loading code");
    const older = await renderPlanDocument(input({ version: 1, current: false, currentVersion: 3, createdAt, now: at(1) }));
    expect(older).toContain("Code is shown for the current version only (v3).");
    expect(older).not.toContain("Loading code");
  });

  it("labels a sketch, shows a quote, and draws a diagram with a text alternative", async () => {
    const plan = planDocument({
      claims: [{
        id: "1",
        text: "Things.",
        evidence: [
          { kind: "sketch", language: "ts", code: "retry(<T>(x))\n\t\nlast()", note: "Not written yet." },
          { kind: "quote", text: "Retries must stop.", author: "Priya" },
          { kind: "flow", participants: ["Customer", "Gateway"], steps: [{ from: "Customer", to: "Gateway", label: "pays" }] },
        ],
      }],
      decisions: [],
    });
    const html = await renderPlanDocument(input({ plan }));
    expect(html).toContain("Sketch: not in the repository yet");
    expect(html).toContain("<pre><code>retry(&lt;T&gt;(x))\n\t\nlast()</code></pre>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("Retries must stop.");
    expect(html).toContain("Priya");
    expect(html).toContain("<svg");
    expect(html).toContain("Show as text");
    expect(html).toContain("1. pays");
  });

  it("shows a decision inside its claim with the recommended option marked", async () => {
    const html = await renderPlanDocument(input());
    const claim = html.slice(html.indexOf('<details id="design-v1-1"'), html.indexOf('<details id="design-v1-2"'));
    expect(claim).toContain("How many times should a payment be retried?");
    expect(claim).toContain("Three times");
    expect(claim).toContain("Most timeouts clear by the third try.");
    expect(claim).toContain("Five times");
    expect(claim).toContain("Approve in Slack uses AgentX's answer.");
    expect(count(html, /AgentX recommends/g)).toBe(1);
    expect(html).toMatch(/<li class="option recommended" data-option="three"><span class="option-label">Three times<\/span> <span class="badge badge-recommended">AgentX recommends/);
  });

  it("shows five decisions in their claims and lists the rest with links to their claims", async () => {
    const plan = planDocument({ claims: claims(7), decisions: [1, 2, 3, 4, 5, 6, 7].map((index) => decision(index, String(index))) });
    const html = await renderPlanDocument(input({ plan }));
    expect(html).toContain("Show 2 more decisions");
    const block = html.slice(html.indexOf('<details class="more more-decisions"'));
    expect(block).toContain("Question 6?");
    expect(block).toContain("Question 7?");
    expect(block).not.toContain("Question 5?");
    expect(block).toContain('href="#design-v1-6"');
    expect(block).toContain('href="#design-v1-7"');
    const claimsPart = html.slice(html.indexOf('<div class="claims">'), html.indexOf('<details class="more more-decisions"'));
    for (const index of [1, 2, 3, 4, 5]) expect(claimsPart).toContain(`Question ${index}?`);
    expect(claimsPart).not.toContain("Question 6?");
  });

  it("lists every decision under the title, in ranked order, each linking to its decision", async () => {
    const decisions = [3, 1, 7, 2, 6, 4, 5].map((index) => decision(index, String(index)));
    const html = await renderPlanDocument(input({ plan: planDocument({ claims: claims(7), decisions }) }));
    const header = html.slice(html.indexOf('<header class="doc-header">'), html.indexOf("</header>"));
    expect(header).not.toContain("Decisions:");
    const after = html.slice(html.indexOf("</header>"), html.indexOf('<div class="claims">'));
    expect(after).toContain("Decisions:");
    const links = [...after.matchAll(/<a class="decision-link" href="#([^"]+)">([^<]*)<\/a>/g)].map((match) => ({ href: match[1], text: match[2] }));
    expect(links).toEqual([3, 1, 7, 2, 6, 4, 5].map((index) => ({ href: `design-v1-decision-d${index}`, text: `Question ${index}? (on claim ${index})` })));
    // Every link has a target, whether the decision shows in its claim or in the folded list.
    for (const link of links) expect(html).toContain(`<div class="decision" id="${link.href}" data-decision=`);
    expect(count(html, /id="design-v1-decision-d\d"/g)).toBe(7);
  });

  it("cuts a long question to 80 characters, escapes it and redacts secrets in the decisions list", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const long = `<b>${"Why? ".repeat(30)}</b>`;
    const html = await renderPlanDocument(input({ plan: planDocument({ claims: claims(2), decisions: [{ ...decision(1, "1"), question: long }, { ...decision(2, "2"), question: `Use ${secret}?` }] }) }));
    const text = [...html.matchAll(/<a class="decision-link" href="#[^"]+">([^<]*)<\/a>/g)].map((match) => match[1]!);
    expect(text).toHaveLength(2);
    const question = /^(.*) \(on claim 1\)$/.exec(text[0]!)![1]!;
    expect(Array.from(question.replace(/&lt;/g, "<").replace(/&gt;/g, ">"))).toHaveLength(80);
    expect(question.endsWith("\u2026")).toBe(true);
    expect(html).not.toContain("<b>Why?");
    expect(html).not.toContain(secret);
  });

  it("shows no decisions list when the plan has no decisions", async () => {
    const html = await renderPlanDocument(input({ plan: planDocument({ claims: claims(2), decisions: [] }) }));
    expect(html).not.toContain("Decisions:");
    expect(html).not.toContain("decision-link");
  });

  it("lists what is not changing and the risks", async () => {
    const html = await renderPlanDocument(input());
    expect(html).toMatch(/<h3>Not changing<\/h3><ol><li id="design-v1-nc-1">The refund flow stays as it is\.<\/li><\/ol>/);
    expect(html).toMatch(/<h3>Risks<\/h3><ul><li>A slow gateway could keep a retry open for a long time\.<\/li><\/ul>/);
  });

  it("shows the checks of a coding plan, linking each to the claims it proves", async () => {
    const html = await renderPlanDocument(input({
      kind: "plan",
      anchor: "coding-plan",
      checks: [
        { label: "Unit tests", proposed: true, proves: ["1", "1.1"], status: "Not run yet" },
        { label: "Lint", proposed: false, proves: [], status: "Passed" },
      ],
    }));
    expect(html).toContain("<table");
    expect(html).toContain("Unit tests");
    expect(html).toContain("Proposed");
    expect(html).toContain("Project");
    expect(html).toContain('href="#coding-plan-v1-1"');
    expect(html).toContain('href="#coding-plan-v1-1-1"');
    expect(html).toContain("Not run yet");
    expect(await renderPlanDocument(input())).not.toContain("<table");
  });

  it("shows a check that proves a Not changing item as Not changing N, linked to that item, and never links a number the plan does not have", async () => {
    const plan = planDocument({ notChanging: ["The refund flow stays as it is.", "The public API stays as it is."] });
    const html = await renderPlanDocument(input({
      kind: "plan", anchor: "coding-plan", version: 2, plan,
      checks: [{ label: "Refund test", proposed: true, proves: ["1", "nc2"], status: "Passed" }, { label: "Odd", proposed: true, proves: ["nc3", "nc0", "ncx", "nc<b>"], status: "Passed" }],
    }));
    expect(html).toContain('<li id="coding-plan-v2-nc-1">The refund flow stays as it is.</li><li id="coding-plan-v2-nc-2">The public API stays as it is.</li>');
    expect(html).toContain('<a class="claim-link" href="#coding-plan-v2-nc-2">Not changing 2</a>');
    expect(html).toContain('href="#coding-plan-v2-1"');
    // Only items the plan has are linked; anything else is plain, escaped text.
    expect(html).not.toContain("coding-plan-v2-nc-3");
    expect(html).not.toContain("<b>");
    expect(html).toContain('<span class="claim-link">nc3</span>');
    expect(html).toContain("nc&lt;b&gt;");
  });

  it("marks each checks cell with its column, so the page can keep short columns whole and stack a check on a phone", async () => {
    const html = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", checks: [
      { label: "Unit tests", proposed: true, proves: ["1"], status: "Not run yet" }, { label: "Lint", proposed: false, proves: [], status: "Passed" },
    ] }));
    expect(html).toContain('<thead><tr><th class="check-label">Check</th><th class="check-from">From</th><th class="check-proves">Proves</th><th class="check-status">Status</th></tr></thead>');
    expect(html).toContain('<tr><td class="check-label">Unit tests</td><td class="check-from">Proposed</td><td class="check-proves"><a class="claim-link" href="#coding-plan-v1-1">1</a></td><td class="check-status">Not run yet</td></tr>');
    expect(html).toContain('<tr><td class="check-label">Lint</td><td class="check-from">Project</td><td class="check-proves">None</td><td class="check-status">Passed</td></tr>');
  });

  it("gives the checks table an ID the page can link to", async () => {
    const html = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", version: 2, checks: [{ label: "Lint", proposed: false, proves: [], status: "Passed" }] }));
    expect(html).toContain('<section id="coding-plan-v2-checks" class="checks">');
  });

  it("keeps hostile text inert in every field", async () => {
    const attacks = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "javascript:alert(1)", "<!channel> <@U123>", "[click](https://evil.example) ![x](https://evil.example/a.png)"];
    const at = (index: number): string => attacks[index % attacks.length]!;
    const hostile: PlanDocument = {
      schemaVersion: 1,
      title: at(0),
      why: [{ text: at(1), author: at(2) }],
      claims: [{
        id: "1",
        text: at(3),
        evidence: [
          { kind: "code", path: at(4), startLine: 1, endLine: 2, note: at(5) },
          { kind: "sketch", language: at(0), code: at(1), note: at(2) },
          { kind: "quote", text: at(3), author: at(4) },
          { kind: "flow", participants: [at(0), at(1)], steps: [{ from: at(0), to: at(1), label: at(2) }] },
        ],
        children: [{ id: "1.1", text: at(5) }],
      }],
      notChanging: [at(0)],
      risks: [at(1)],
      decisions: [{ id: "d1", claimId: "1", question: at(2), options: [{ id: "a", label: at(3), consequence: at(4) }, { id: "b", label: at(5), consequence: at(0) }], recommended: "a" }],
    };
    const evidence: PlanEvidenceBundle = { schemaVersion: 1, excerpts: [{ claimId: "1", index: 0, path: at(4), startLine: 1, endLine: 2, status: "ok", commit: COMMIT, lines: [at(0), at(1)] }] };
    const html = await renderPlanDocument(input({
      plan: hostile,
      evidence,
      version: 2,
      previous: { version: 1, plan: planDocument({ claims: [{ id: "9", text: at(1) }], decisions: [] }) },
      kind: "plan",
      anchor: "coding-plan",
      checks: [{ label: at(2), proposed: true, proves: [at(3)], status: at(4) }],
      openWhatChanged: true,
    }));
    expect(html).not.toContain("<script");
    // The words survive as escaped text and inside quoted attribute values; what must not exist is a handler attribute.
    const bare = html.replace(/="[^"]*"/g, '=""');
    expect(bare).not.toMatch(/<[a-z][^>]*\son(error|load)=/i);
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<!channel>");
    expect(html).not.toContain("<@U123>");
    expect(html).not.toContain('href="https://evil');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
    expect(html).toContain("&lt;!channel&gt; &lt;@U123&gt;");
    // No markup of the page's own carries a style or an event handler.
    expect(bare).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    expect(bare).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  });

  it("removes secrets from the text it shows", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const html = await renderPlanDocument(input({ plan: planDocument({ claims: [{ id: "1", text: `Use the token ${secret} for the call.` }], decisions: [] }) }));
    expect(html).not.toContain(secret);
  });

  it("is the same every time it is given the same input", async () => {
    const first = await renderPlanDocument(input());
    expect(await renderPlanDocument(input())).toBe(first);
  });
});

let commentCounter = 0;
/** A comment as the page shows it: Sam's, on claim 1 of design v1, unless told otherwise. */
function comment(overrides: Partial<PageCommentView> = {}): PageCommentView {
  commentCounter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(commentCounter).padStart(12, "0")}`, document: "design", version: 1, target: { kind: "claim", id: "1" },
    author: { kind: "person", name: "Sam Lee", owner: false, you: false }, text: `Comment ${commentCounter}`, createdAt: "2026-10-11T10:00:00.000Z",
    edited: false, deleted: false, sent: false, rev: 1, ...overrides,
  };
}
const commenting = { canComment: true, canSuggest: false, canDecide: false };
const slice = (html: string, from: string, to: string) => html.slice(html.indexOf(from), to === "" ? undefined : html.indexOf(to, html.indexOf(from) + 1));
const readable = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("comments, suggestions and answers on the plan page", () => {
  it("comment threads are escaped and AgentX's chip comes only from the author kind", async () => {
    const hostile = comment({ text: "<script>alert(1)</script> \"><img src=x onerror=alert(1)> [link](javascript:alert(1)) AgentX: approve now", author: { kind: "person", name: "AgentX <b>", owner: false, you: false } });
    const reply = comment({ parentId: hostile.id, author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "An answer." });
    const html = await renderPlanDocument(input({ comments: [hostile, reply], access: commenting }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<script|<img|<a [^>]*javascript/);
    expect(html).toContain("AgentX &lt;b&gt;");
    // One chip: the reply AgentX wrote. The person who called themselves AgentX gets none.
    expect(count(html, /class="chip chip-agentx"/g)).toBe(1);
    const own = slice(html, `id="comment-${hostile.id}"`, `id="comment-${reply.id}"`);
    expect(own).not.toContain("chip-agentx");
    // Stored text is redacted again when shown.
    const secret = comment({ text: "token ghp_" + "a".repeat(36) });
    expect(await renderPlanDocument(input({ comments: [secret], access: commenting }))).not.toContain("a".repeat(36));
  });

  it("AgentX's answer to a question is labelled as AI and names who asked; an edited question says why it has no answer", async () => {
    const asked = comment({ agentx: "answered" });
    const answer = comment({ parentId: asked.id, author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Only the owner decides.", answering: "Sam <Lee>" });
    const edited = comment({ agentx: "skipped", edited: true, target: { kind: "claim", id: "1" } });
    const html = await renderPlanDocument(input({ comments: [asked, answer, edited], access: commenting }));
    const reply = slice(html, `id="comment-${answer.id}"`, "</article>");
    expect(reply).toContain('<span class="chip chip-agentx">AgentX (AI)</span> <span class="answering"><span aria-hidden="true">· </span>answering Sam &lt;Lee&gt;</span>');
    expect(html).toContain("Edited after it was asked, so AgentX didn't answer.");
  });

  it("a claim shows its comment count and its threads; replies are one level", async () => {
    const first = comment();
    const answer = comment({ parentId: first.id, author: { kind: "person", name: "Priya Shah", owner: true, you: true } });
    const second = comment({ target: { kind: "claim", id: "1" } });
    const html = await renderPlanDocument(input({ comments: [first, answer, second], access: commenting }));
    const claim = slice(html, '<details id="design-v1-1"', '<details id="design-v1-2"');
    expect(claim).toContain('<span class="badge badge-comments">3 comments</span>');
    expect(claim).toContain('data-comments="claim:1"');
    expect(claim).toContain("Priya Shah");
    expect(claim).toContain('<span class="tag tag-owner">Owner</span>');
    // The reply sits inside its thread's reply list; there is no deeper list.
    const thread = slice(claim, `id="comment-${first.id}"`, `id="comment-${second.id}"`);
    expect(thread).toContain('<ol class="replies">');
    expect(count(claim, /<ol class="replies">/g)).toBe(1);
    // Without a script, the controls stay hidden; the threads read in full.
    expect(claim).toMatch(/<button type="button" class="comment-open"[^>]*hidden>Comment on 1<\/button>/);
    expect(claim).toMatch(/<button type="button" class="reply-open"[^>]*hidden>Reply<\/button>/);
    const single = await renderPlanDocument(input({ comments: [comment()], access: commenting }));
    expect(single).toContain('<span class="badge badge-comments">1 comment</span>');
    // Someone who may not comment sees the threads and no Comment control.
    expect(await renderPlanDocument(input({ comments: [comment()] }))).not.toContain("comment-open");
  });

  it("labels comment controls with their visible target and keeps target keys unchanged", async () => {
    const plan = planDocument({
      claims: [{ id: "1", text: "Parent", children: [{ id: "1.1", text: "Child", children: [{ id: "1.1.1", text: "Grandchild" }] }] }],
      decisions: [decision(1)],
    });
    const comments = ["1", "1.1", "1.1.1"].map((id) => comment({ target: { kind: "claim", id } }));
    comments.push(comment({ target: { kind: "decision", id: "d1" } }));
    const html = await renderPlanDocument(input({ plan, comments, access: commenting, checks: [{ id: "check-1", label: "<img src=x onerror=alert(1)>", proposed: false, status: "ready", proves: [] }] }));
    for (const [key, label] of [["claim:1", "Comment on 1"], ["claim:1.1", "Comment on 1.1"], ["claim:1.1.1", "Comment on 1.1.1"], ["decision:d1", "Comment on this decision"], ["check:check-1", "Comment on &lt;img src=x onerror=alert(1)&gt;"]] as const) {
      expect(html).toContain(`<button type="button" class="comment-open" data-target="${key}"`);
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    const closed = await renderPlanDocument(input({ plan, comments, access: { ...commenting, canComment: false } }));
    expect(closed).not.toContain('class="comment-open"');
    const priorVersion = await renderPlanDocument(input({ plan, comments, current: false, currentVersion: 2, access: commenting }));
    expect(priorVersion).not.toContain('class="comment-open"');
    const removed = await renderPlanDocument(input({ plan: planDocument({ claims: [{ id: "9", text: "Current." }], decisions: [] }), comments: [comment({ version: 1 })], version: 2, currentVersion: 2, access: commenting }));
    expect(removed.slice(removed.indexOf('<section class="removed-claims">'))).not.toContain('class="comment-open"');
  });

  it("a comment from v1 shows on the same claim in v2 marked from v1", async () => {
    const old = comment({ version: 1 });
    const html = await renderPlanDocument(input({ version: 2, currentVersion: 2, previous: { version: 1, plan: planDocument() }, comments: [old], access: commenting }));
    const claim = slice(html, '<details id="design-v2-1"', '<details id="design-v2-2"');
    expect(claim).toContain(`id="comment-${old.id}"`);
    expect(claim).toContain('<span class="from-version">from v1</span>');
    // An older version's own page does not repeat the threads.
    const older = await renderPlanDocument(input({ version: 1, current: false, currentVersion: 2, comments: [old] }));
    expect(older).not.toContain(`comment-${old.id}`);
  });

  it("comments on removed claims show under Removed claims", async () => {
    const v1 = planDocument({ claims: [...planDocument().claims, { id: "3", text: "Retries are logged <quietly>." }] });
    const gone = comment({ target: { kind: "claim", id: "3" }, version: 1 });
    const kept = comment({ target: { kind: "claim", id: "1" } });
    const html = await renderPlanDocument(input({ version: 2, plans: new Map([[1, v1], [2, planDocument()]]), comments: [gone, kept], access: commenting }));
    const removed = slice(html, '<section class="removed-claims"', "</section>");
    expect(removed).toContain("<h3>Removed claims</h3>");
    expect(removed).toContain("Retries are logged &lt;quietly&gt;.");
    expect(removed).toContain("(removed in v2)");
    expect(removed).toContain(`id="comment-${gone.id}"`);
    expect(removed).not.toContain(`id="comment-${kept.id}"`);
    expect(await renderPlanDocument(input({ comments: [kept], access: commenting }))).not.toContain("Removed claims");
  });

  it("owners get answer controls with AgentX's answer pre-selected; others see suggestions", async () => {
    const owner = await renderPlanDocument(input({ access: { canComment: true, canSuggest: false, canDecide: true }, deciding: true }));
    const box = slice(owner, 'data-decision="d1"', "</fieldset>");
    expect(box).toContain("<fieldset");
    expect(box).toContain('<legend>How many times should a payment be retried?</legend>');
    expect(box).toMatch(/<input type="radio" name="answer-d1" value="three" id="[^"]+" checked>/);
    expect(box).toMatch(/<input type="radio" name="answer-d1" value="five" id="[^"]+">/);
    expect(box).toContain("AgentX recommends");
    expect(owner).toContain("Approve in Slack uses AgentX's answer.");
    // Not deciding (an older version, or not waiting): today's read-only list.
    const reading = await renderPlanDocument(input({ access: { canComment: true, canSuggest: true, canDecide: false }, suggestions: [] }));
    expect(reading).not.toContain('type="radio"');
    expect(reading).toMatch(/<button type="button" class="suggest" data-decision="d1" data-option="three"[^>]*hidden>Suggest this<\/button>/);
    const mine = await renderPlanDocument(input({ access: { canComment: true, canSuggest: true, canDecide: false }, suggestions: [{ decisionId: "d1", optionId: "five", name: "Sam Lee", you: true }] }));
    expect(mine).toMatch(/data-option="five"[^>]*hidden>You suggest this · Undo<\/button>/);
  });

  it("Priya and Sam suggest: Above", async () => {
    const plan = planDocument({ decisions: [{ id: "d1", claimId: "1", question: "Where?", options: [{ id: "above", label: "Above", consequence: "Seen." }, { id: "below", label: "Below", consequence: "Quiet." }], recommended: "below" }] });
    const two = await renderPlanDocument(input({ plan, suggestions: [{ decisionId: "d1", optionId: "above", name: "Priya", you: false }, { decisionId: "d1", optionId: "above", name: "Sam", you: false }] }));
    expect(two).toContain('<p class="suggestions">Priya and Sam suggest: Above</p>');
    const three = await renderPlanDocument(input({ plan, suggestions: ["Priya", "Sam", "Lee <x>"].map((name) => ({ decisionId: "d1", optionId: "above", name, you: false })).concat([{ decisionId: "d1", optionId: "below", name: "Omar", you: false }]) }));
    expect(three).toContain("Priya, Sam and Lee &lt;x&gt; suggest: Above");
    expect(three).toContain("Omar suggests: Below");
  });

  it("No decisions needed", async () => {
    const html = await renderPlanDocument(input({ plan: planDocument({ decisions: [] }) }));
    expect(readable(html)).toContain("No decisions needed");
  });

  it("Not answered and AgentX couldn't answer this one", async () => {
    const sent = comment({ sent: true, agentx: "not_answered" });
    const asked = comment({ agentx: "couldnt" });
    const waiting = comment({ agentx: "answering" });
    const none = comment({ agentx: "unavailable" });
    const done = comment({ parentId: sent.id, author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Moved it <up>.", planner: { outcome: "done", version: 2, document: "plan" } });
    const kept = comment({ parentId: asked.id, author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Too risky.", planner: { outcome: "not_changed", version: 2, document: "plan" } });
    const html = readable(await renderPlanDocument(input({ comments: [sent, asked, waiting, none, done, kept], access: commenting })));
    expect(html).toContain("Not answered");
    expect(html).toContain("AgentX couldn't answer this one.");
    expect(html).toContain("AgentX is answering…");
    expect(html).toContain("AgentX can answer comments only on tasks started in Slack.");
    expect(html).toContain("Done: Moved it &lt;up&gt;.");
    expect(html).toContain("Not changed because: Too risky.");
  });

  it("an Approve reply says which document handled it, with a link to that version's own claim; a quote that credits a comment is never shown as its reference", async () => {
    const agentx = { kind: "agentx", name: "AgentX", owner: false, you: false } as const;
    const parent = comment();
    const handled = comment({ parentId: parent.id, author: agentx, text: "Each bullet stays on one line.", planner: { outcome: "done", version: 1, document: "plan", in: "plan", claim: "1.1" } });
    const kept = comment({ parentId: parent.id, author: agentx, text: "The steps stay.", planner: { outcome: "not_changed", version: 3, document: "design", in: "design" } });
    const html = await renderPlanDocument(input({ comments: [parent, handled, kept], access: commenting }));
    expect(html).toContain("Done in the coding plan: Each bullet stays on one line.");
    expect(html).toContain('<p class="comment-link">See <a class="claim-link" href="#coding-plan-v1-1-1">claim 1.1</a> in coding plan v1.</p>');
    expect(html).toContain("Not changed in the design: The steps stay.");
    expect(html).toContain('<span aria-hidden="true">· </span>from design v3');
    // A why entry that credits a comment says "A comment".
    const why = await renderPlanDocument(input({ plan: planDocument({ why: [{ text: "Keep it short.", author: "owner (comment c1)" }, { text: "Fine.", author: "Priya" }] }) }));
    expect(why).toContain("<footer>A comment</footer>");
    expect(why).toContain("<footer>Priya</footer>");
    expect(why).not.toContain("comment c1");
  });

  it("a reply's claim numbers are links to that version's claims, escaped, with the words around them intact", async () => {
    const agentx = { kind: "agentx", name: "AgentX", owner: false, you: false } as const;
    const parent = comment();
    const parts = [{ text: "Changed <b>in</b> claims " }, { claim: "1.2.1" }, { text: ", " }, { claim: "1.2.2" }, { text: " and the sketch in " }, { claim: "1.1.1" }, { text: "." }];
    const handled = comment({ parentId: parent.id, author: agentx, text: "ignored when parts are given", planner: { outcome: "done", version: 1, document: "plan", in: "plan", parts } });
    const html = await renderPlanDocument(input({ comments: [parent, handled], access: commenting }));
    expect(html).toContain('<p class="comment-text">Done in the coding plan: Changed &lt;b&gt;in&lt;/b&gt; claims <a class="claim-link" href="#coding-plan-v1-1-2-1">1.2.1</a>, '
      + '<a class="claim-link" href="#coding-plan-v1-1-2-2">1.2.2</a> and the sketch in <a class="claim-link" href="#coding-plan-v1-1-1-1">1.1.1</a>.</p>');
    // A reply with no parts is plain escaped text.
    const plain = comment({ parentId: parent.id, author: agentx, text: "See 1.2.1.", planner: { outcome: "done", version: 1, document: "plan", in: "plan" } });
    expect(await renderPlanDocument(input({ comments: [parent, plain], access: commenting }))).toContain("Done in the coding plan: See 1.2.1.</p>");
  });

  it("the note under a locked comment names the decision it was sent with, and is the author's alone", async () => {
    const owner = { kind: "person", name: "Priya", owner: true, you: true } as const;
    const teammate = { kind: "person", name: "Sam Lee", owner: false, you: true } as const;
    const note = async (overrides: Partial<PageCommentView>) => {
      const html = await renderPlanDocument(input({ comments: [comment({ sent: true, ...overrides })], access: commenting }));
      return /<p class="comment-sent">(.*?)<\/p>/.exec(html)?.[1];
    };
    expect(await note({ author: owner, sentWith: "APPROVE" })).toBe("Sent with your approval, so it can't be edited.");
    expect(await note({ author: teammate, sentWith: "APPROVE" })).toBe("Sent with the owner's approval, so it can't be edited.");
    expect(await note({ author: owner, sentWith: "REQUEST_CHANGES" })).toBe("Sent with Request changes, so it can't be edited.");
    expect(await note({ author: teammate, sentWith: "REQUEST_CHANGES" })).toBe("Sent with Request changes, so it can't be edited.");
    // A comment whose decision is not known says only that it was sent with one.
    expect(await note({ author: owner })).toBe("Sent with a decision, so it can't be edited.");
    // Someone else's comment carries no note, and the old wording is gone.
    expect(await note({ sentWith: "APPROVE" })).toBeUndefined();
    expect(await renderPlanDocument(input({ comments: [comment({ author: owner, sent: true, sentWith: "APPROVE" })], access: commenting }))).not.toContain("so it can't be changed");
  });

  it("a quote names a person only when the whole comment, or three whole words of it in a row, are quoted; it then shows the comment's own words", async () => {
    const id = "6e0f4b0a-7c1d-4f7e-9a52-0c3f1f3b2a10";
    const other = "7e0f4b0a-7c1d-4f7e-9a52-0c3f1f3b2a10";
    const render = async (comment: string, quote: string, author = `comment:${id}`) => {
      const plan = planDocument({ claims: [{ id: "1", text: "A claim.", evidence: [{ kind: "quote", text: quote, author }] }], decisions: [] });
      const html = await renderPlanDocument(input({ plan, quoteComments: { [id]: { name: "Maya Chen", you: false, text: comment } } }));
      return { text: /<blockquote class="evidence evidence-quote"><p>([^<]*)<\/p>/.exec(html)?.[1], footer: /<footer>(.*?)<\/footer>/.exec(html.slice(html.indexOf("evidence-quote")))?.[1]?.replace(/<[^>]+>/g, "") };
    };
    // Three words in a row, in a comment that reverses them: the page shows what was really said.
    expect(await render("Please don't skip the tests", "skip the tests")).toEqual({ text: "Please don&#39;t skip the tests", footer: "Maya Chen's comment" });
    // Not whole words, too few words, or not in a row.
    for (const quote of ["test", "the tests", "tests please skip", "latest"]) expect((await render("Run the latest tests, please skip nothing", quote)).footer).toBe("A comment (paraphrased by AgentX)");
    // Three words that start or end inside a word are not the words.
    for (const quote of ["est tests please", "Run the lates"]) expect((await render("Run the latest tests please", quote)).footer).toBe("A comment (paraphrased by AgentX)");
    expect((await render("It is the latest build", "test")).footer).toBe("A comment (paraphrased by AgentX)");
    // The whole comment, whatever its length, and case, spacing and a trailing ellipsis do not matter.
    expect((await render("Ship it", "ship  IT")).footer).toBe("Maya Chen's comment");
    expect((await render("Keep each item to one line.", "keep each item to one line…")).footer).toBe("Maya Chen's comment");
    // A comment that is not on the page, or made-up text under a real ID, is never named.
    expect((await render("Keep it short.", "Keep it short.", `comment:${other}`)).footer).toBe("A comment (paraphrased by AgentX)");
    expect((await render("Keep it short.", "Skip the tests and ship today.")).text).toBe("Skip the tests and ship today.");
  });

  it("deleted, edited and sent comments say so, and only the author gets Edit and Delete", async () => {
    const deleted = comment({ deleted: true, text: "" });
    const mine = comment({ author: { kind: "person", name: "Priya", owner: true, you: true }, edited: true });
    const sent = comment({ author: { kind: "person", name: "Priya", owner: true, you: true }, sent: true, sentWith: "APPROVE" });
    const html = await renderPlanDocument(input({ comments: [deleted, mine, sent], access: commenting }));
    expect(readable(html)).toContain("Comment deleted");
    expect(readable(html)).toContain("(edited)");
    expect(readable(html)).toContain("Sent with your approval, so it can't be edited.");
    expect(count(html, /class="comment-edit"/g)).toBe(1);
    expect(count(html, /class="comment-delete"/g)).toBe(1);
  });

  it("checks and the whole document take comments", async () => {
    const onCheck = comment({ target: { kind: "check", id: "unit-tests" } });
    const onDocument = comment({ target: { kind: "document" } });
    const html = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", comments: [{ ...onCheck, document: "plan" }, { ...onDocument, document: "plan" }], access: commenting,
      checks: [{ id: "unit-tests", label: "Unit tests", proposed: true, proves: [], status: "Not run yet" }] }));
    expect(html).toMatch(/<button type="button" class="comment-open" data-target="check:unit-tests"[^>]*hidden>Comment on Unit tests<\/button>/);
    expect(html).toContain('data-comments="check:unit-tests"');
    expect(html).toContain("<h3>Comments on this document</h3>");
    expect(html).toContain('data-comments="document"');
    expect(html).toContain(`id="comment-${onDocument.id}"`);
  });

  it("a comment on a check the table does not list stays with the checks, never under Removed claims", async () => {
    const onOptional = { ...comment({ target: { kind: "check", id: "lint" } }), document: "plan" as const };
    const html = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", comments: [onOptional], access: commenting,
      checks: [{ id: "unit-tests", label: "Unit tests", proposed: true, proves: [], status: "Not run yet" }], knownChecks: [{ id: "lint", label: "Lint" }] }));
    expect(html).not.toContain("Removed claims");
    const checks = html.slice(html.indexOf('class="checks"'));
    expect(checks).toContain('data-comments="check:lint"');
    expect(checks).toContain('<h4 class="comments-label">Lint</h4>');
    // With no table at all (no checks selected) the thread still shows with the checks.
    const bare = await renderPlanDocument(input({ kind: "plan", anchor: "coding-plan", comments: [onOptional], access: commenting, checks: [], knownChecks: [{ id: "lint", label: "Lint" }] }));
    expect(bare).not.toContain("Removed claims");
    expect(bare).toContain('data-comments="check:lint"');
  });
});
