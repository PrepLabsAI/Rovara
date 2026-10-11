// Task 18 (gap 4): the read-only AgentX task page a brief Slack message links to.
import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { canonicalPlanJson, createCandidateManifest, createWorkflowSnapshot, workflowFindingFingerprint, type PlanDocument } from "@agentx/contracts";
import { claimAnchor } from "../../packages/broker/src/aws/plan-page/render-plan.js";
import { createTaskWeb, type TaskDocumentEntry, type TaskDocumentKind, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { TASK_PAGE_SCRIPT, TASK_PAGE_STYLE } from "../../packages/broker/src/aws/task-page-assets.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject, registerRevision, type Developer } from "../support/developer-task-broker.js";
import { planDocument } from "../support/plan-documents.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const markdownDoc = (kind: TaskDocumentKind, version: number, markdown: string, extra: { approved?: boolean; current?: boolean } = {}): TaskDocumentEntry =>
  ({ kind, version, approved: extra.approved ?? false, current: extra.current ?? true, format: "markdown", markdown });
const structuredDoc = (kind: TaskDocumentKind, version: number, plan: PlanDocument, extra: { approved?: boolean; current?: boolean; createdAt?: string } = {}): TaskDocumentEntry =>
  ({ kind, version, approved: extra.approved ?? false, current: extra.current ?? true, format: "structured", plan, ...(extra.createdAt === undefined ? {} : { createdAt: extra.createdAt }) });
const view: TaskDocumentView = { taskId, title: "Add greet <img src=x>", status: "Waiting for your approval", nextStep: "Approve or request changes in Slack.",
  path: "QUICK", stage: "Coding plan", role: "owner",
  documents: [markdownDoc("coding plan", 2, "# Plan\n<script>alert(1)</script>\n1. Add greet")],
  checks: [{ label: "npm test", passed: true }], findings: [{ role: "code", text: "Drops <b>last</b> line", origin: "INTRODUCED", file: "src/a.ts", line: 3 }],
  pullRequests: [], history: [] };
const request = (path: string, cookie?: string): AdaptedHttpRequest => ({ method: "GET", path, headers: cookie === undefined ? {} : { cookie }, requestId: "r" });
const caller = { developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const pageUrl = new URL(`https://agentx.example.test/review/${taskId}/task`);
const renderAt = (search: string, overrides: Partial<TaskDocumentView>) =>
  createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => ({ ...view, ...overrides }) })(request(`/review/${taskId}/task${search}`, SESSION), new URL(`${pageUrl.href}${search}`));
const render = (overrides: Partial<TaskDocumentView>) => renderAt("", overrides);
/** What a reader sees: the body's text, without tags, styles or attributes. */
const count = (html: string, pattern: RegExp): number => html.match(pattern)?.length ?? 0;
const visible = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ");

describe("read-only task page", () => {
  it("sends a signed-out reader to sign in and back to the task page", async () => {
    const web = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => view });
    const answer = await web(request(`/review/${taskId}/task`), new URL(`https://agentx.example.test/review/${taskId}/task`));
    expect(answer.statusCode).toBe(302);
    expect(answer.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${taskId}/task`)}`);
  });

  it("keeps the document and earlier version in the link through sign-in, and drops anything else", async () => {
    const web = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => view });
    const returnTo = async (search: string) => {
      const answer = await web(request(`/review/${taskId}/task${search}`), new URL(`https://agentx.example.test/review/${taskId}/task${search}`));
      return new URL(answer.headers.location!, "https://agentx.example.test").searchParams.get("return_to");
    };
    expect(await returnTo("?doc=coding-plan&from=2")).toBe(`/review/${taskId}/task?doc=coding-plan&from=2`);
    expect(await returnTo("?from=2&doc=design")).toBe(`/review/${taskId}/task?doc=design&from=2`);
    expect(await returnTo("?doc=requirements")).toBe(`/review/${taskId}/task?doc=requirements`);
    expect(await returnTo("?doc=design&from=1000")).toBe(`/review/${taskId}/task?doc=design`);
    expect(await returnTo("?doc=<script>&from=2")).toBe(`/review/${taskId}/task`);
    expect(await returnTo("?from=2&x=1")).toBe(`/review/${taskId}/task`);
  });

  it("shows the full document and findings escaped, with one script by nonce and a locked-down policy", async () => {
    const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view });
    const answer = await web(request(`/review/${taskId}/task`, SESSION), new URL(`https://agentx.example.test/review/${taskId}/task`));
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(answer.body).toContain("Drops &lt;b&gt;last&lt;/b&gt; line");
    expect(answer.body).toContain('id="findings"');
    expect(answer.body).not.toMatch(/<form|<script>alert/);
    const nonce = /<script nonce="([^"]+)">/.exec(answer.body)![1]!;
    expect(answer.body.match(/<script/g)).toHaveLength(1);
    expect(answer.body.match(/<style/g)).toHaveLength(1);
    const csp = answer.headers["content-security-policy"]!;
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    // The page may ask its own origin whether the task moved on, and nothing else.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(answer.headers["cache-control"]).toContain("no-store");
  });

  it("hides a task the reader may not see", async () => {
    const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => { throw Object.assign(new Error("x"), { code: "TASK_NOT_FOUND" }); } });
    expect((await web(request(`/review/${taskId}/task`, SESSION), new URL(`https://agentx.example.test/review/${taskId}/task`))).statusCode).toBe(404);
  });

  it("tells an eligible reader who to ask, with the owner's name escaped, and gives everyone else one wording that never confirms the task exists", async () => {
    const refuse = (code: string, owners?: string[]) => createTaskWeb({ authenticateSession: async () => caller,
      getTaskDocumentView: async () => { throw Object.assign(new Error("x"), { code, ...(owners === undefined ? {} : { owners }) }); } })(request(`/review/${taskId}/task`, SESSION), pageUrl);
    const denied = await refuse("TASK_ACCESS_DENIED", ["Maya <b>Chen</b>"]);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("You don&#39;t have access to this task. Ask Maya &lt;b&gt;Chen&lt;/b&gt; to add you.");
    expect(denied.body).not.toContain("<b>Chen");
    const nonceOf = (body: string) => /<style nonce="([^"]+)">/.exec(body)![1]!;
    const same = async (code: string) => { const answer = await refuse(code); return { status: answer.statusCode, body: answer.body.replaceAll(nonceOf(answer.body), "N") }; };
    const missing = await same("TASK_NOT_FOUND");
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("You don&#39;t have access to this task.");
    expect(missing.body).not.toContain("Ask ");
    expect(await same("FORBIDDEN")).toEqual(missing);
    expect(await same("NOT_FOUND")).toEqual(missing);
    // A refusal with no owner to name reads like any other.
    expect((await refuse("TASK_ACCESS_DENIED", [])).statusCode).toBe(404);
  });

  it("sends a reader whose session ended back to sign in, and answers only GET", async () => {
    const web = createTaskWeb({ authenticateSession: async () => undefined, getTaskDocumentView: async () => view });
    const expired = await web(request(`/review/${taskId}/task`, SESSION), pageUrl);
    expect(expired.statusCode).toBe(302);
    expect(expired.headers.location).toContain(encodeURIComponent(`/review/${taskId}/task`));
    const post = await createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view })({ ...request(`/review/${taskId}/task`, SESSION), method: "POST" }, pageUrl);
    expect(post.statusCode).toBe(405);
  });

  it("splits findings into this change's and older ones, and shows a file only when it is a plain relative path", async () => {
    const answer = await render({ findings: [
      { role: "security", text: "Token logged", origin: "INTRODUCED", file: "src/log.ts", line: 9 },
      { role: "code", text: "Old retry loop", origin: "PRE_EXISTING", file: "../../etc/passwd" },
      { role: "code", text: "Odd path", origin: "PRE_EXISTING", file: "/abs/path.ts" },
      { role: "code", text: "Link path", origin: "INTRODUCED", file: "https://evil.example/x.ts" },
    ] });
    const findings = answer.body.slice(answer.body.indexOf('id="findings"'));
    expect(findings.indexOf("Caused by this change")).toBeLessThan(findings.indexOf("Token logged"));
    expect(findings.indexOf("Already in the code (advisory)")).toBeGreaterThan(findings.indexOf("Token logged"));
    expect(findings.indexOf("Old retry loop")).toBeGreaterThan(findings.indexOf("Already in the code (advisory)"));
    expect(answer.body).toContain("src/log.ts:9");
    expect(answer.body).not.toContain("etc/passwd");
    expect(answer.body).not.toContain("/abs/path.ts");
    expect(answer.body).not.toContain("evil.example");
  });

  it("links pull requests only on GitHub over https, without passing on who sent the reader", async () => {
    const answer = await render({ pullRequests: [
      { url: "https://github.com/example/demo/pull/42", number: 42, state: "OPEN" },
      { url: "javascript:alert(1)", number: 43, state: "OPEN" },
      { url: "https://evil.example/pull/44", number: 44, state: "MERGED" },
    ] });
    expect(answer.body).toContain('href="https://github.com/example/demo/pull/42" rel="noopener noreferrer nofollow"');
    expect(answer.body).not.toContain("javascript:");
    expect(answer.body).not.toContain("evil.example");
    expect(answer.body).toContain("#44");
  });

  it("renders a model's links in a document as plain text, and says when a document couldn't be verified", async () => {
    const answer = await render({ documents: [markdownDoc("design", 1, "See [docs](https://evil.example/x) and <a href=\"https://evil.example\">here</a>", { approved: true })], unverified: ["coding plan"] });
    expect(answer.body).not.toMatch(/<a [^>]*evil\.example/);
    expect(answer.body).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(answer.body).toContain("The saved coding plan couldn't be verified, so it isn't shown.");
    expect(answer.body).toContain("Approved");
  });

  it("marks the checks AgentX proposed, and says plainly when no check applies or the proposal could not be read, all escaped", async () => {
    const proposed = await render({ checks: [{ label: "npm test", passed: true }, { label: "Unit <tests>", passed: undefined, proposed: true }] });
    expect(proposed.body).toContain("<li>npm test: Passed</li>");
    expect(proposed.body).toContain("<li>Unit &lt;tests&gt; (proposed by AgentX): Not run yet</li>");
    const reviewOnly = await render({ checks: [], checksNote: "No automated checks apply: Only <b>docs</b> change. Review only." });
    expect(reviewOnly.body).toContain("No automated checks apply: Only &lt;b&gt;docs&lt;/b&gt; change. Review only.");
    expect(reviewOnly.body).not.toContain("No checks are set up");
    const unreadable = await render({ checks: [{ label: "npm test", passed: undefined }], checksNote: "AgentX could not read the proposed checks." });
    expect(unreadable.body).toContain("AgentX could not read the proposed checks.");
    expect(unreadable.body).toContain("<li>npm test: Not run yet</li>");
  });

  describe("the cited code of a plan just stored", () => {
    const stored = "2026-10-09T12:00:00.000Z";
    const citing = planDocument({ claims: [{ id: "1", text: "Greets.", evidence: [{ kind: "code", path: "repo/app/greet.ts", startLine: 1, endLine: 3 }] }], decisions: [] });
    const show = (minutes: number) => render({ now: Date.parse(stored) + minutes * 60_000, documents: [structuredDoc("coding plan", 1, citing, { createdAt: stored })] });

    it("says it is loading at one minute and that it couldn't load at sixteen", async () => {
      expect((await show(1)).body).toContain("Loading code… refresh in a moment.");
      const late = (await show(16)).body;
      expect(late).toContain("Couldn't load this excerpt.");
      expect(late).not.toContain("Loading code");
    });
  });

  describe("the checks are shown once", () => {
    const plan = planDocument({ claims: [{ id: "1", text: "Greets." }], decisions: [] });
    const structuredChecks: TaskDocumentView["checks"] = [{ label: "npm test", passed: true }, { label: "Unit <tests>", passed: undefined, proposed: true, proves: ["1"] }];
    const section = (body: string): string => /<section id="checks" aria-label="Checks">[\s\S]*?<\/section>/.exec(body)![0];

    it("links to the coding plan's table from one line, after any checks note, when a structured coding plan has checks", async () => {
      const answer = await render({ documents: [structuredDoc("coding plan", 3, plan)], checks: structuredChecks, checksNote: "AgentX could not read the <b>proposed</b> checks." });
      expect(section(answer.body)).toBe('<section id="checks" aria-label="Checks"><h2>Checks</h2><p>AgentX could not read the &lt;b&gt;proposed&lt;/b&gt; checks.</p><p><a href="#coding-plan-v3-checks">See the checks in the coding plan.</a></p></section>');
      expect(answer.body).toContain('<section id="coding-plan-v3-checks" class="checks">');
      expect(answer.body).toContain("Unit &lt;tests&gt;");
      expect(count(answer.body, /npm test/g)).toBe(1);
    });

    it("links to the current coding plan, not an earlier version", async () => {
      const answer = await render({ documents: [structuredDoc("coding plan", 1, plan, { current: false }), structuredDoc("coding plan", 2, plan)], checks: structuredChecks });
      expect(section(answer.body)).toContain('href="#coding-plan-v2-checks"');
    });

    it("keeps today's section for a legacy coding plan, a coding plan with no checks, and a review-only plan", async () => {
      const legacy = await render({ documents: [markdownDoc("coding plan", 2, "# Plan")], checks: structuredChecks });
      expect(section(legacy.body)).toContain("<li>npm test: Passed</li>");
      expect(legacy.body).not.toContain("See the checks in the coding plan.");
      const none = await render({ documents: [structuredDoc("coding plan", 2, plan)], checks: [], checksNote: "No automated checks apply: Only docs change. Review only." });
      expect(section(none.body)).toContain("No automated checks apply: Only docs change. Review only.");
      expect(none.body).not.toContain("See the checks in the coding plan.");
      const designOnly = await render({ documents: [structuredDoc("design", 1, plan)], checks: structuredChecks });
      expect(section(designOnly.body)).toContain("<li>npm test: Passed</li>");
      expect(designOnly.body).not.toContain("See the checks in the coding plan.");
    });
  });

  it("uses plain words: no internal terms reach the reader", async () => {
    const answer = await render({ unverified: ["requirements"], pullRequests: [{ url: "https://github.com/example/demo/pull/42", number: 42, state: "UNKNOWN" }],
      checks: [{ label: "npm test", passed: true }, { label: "lint", passed: false }, { label: "e2e", passed: undefined }] });
    expect(visible(answer.body)).not.toMatch(/candidate|revision|digest|operation|artifact|workflow|SUCCEEDED|FAILED|invalid json/i);
    expect(visible(answer.body)).not.toMatch(/thread repl/i);
  });
});

describe("a task page that fits a phone and says each thing once", () => {
  const plan = planDocument({ title: "Retry failed payments", claims: [{ id: "1", text: "Greets." }], decisions: [] });
  const checksSection = (body: string): string | undefined => /<section id="checks" aria-label="Checks">[\s\S]*?<\/section>/.exec(body)?.[0];
  const style = async (): Promise<string> => /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec((await render({})).body)![1]!;

  it("shows the document's title once: the fold summary names version and approval only", async () => {
    const answer = await render({ path: "FULL", stage: "Requirements", documents: [structuredDoc("requirements", 2, planDocument({ title: "Unique plan title <i>x</i>" }), { approved: true })] });
    expect(answer.body).toContain("<summary>Requirements v2 · approved</summary>");
    expect(count(answer.body, /Unique plan title &lt;i&gt;x&lt;\/i&gt;/g)).toBe(1);
    const pending = await render({ documents: [structuredDoc("coding plan", 1, plan), markdownDoc("design", 1, "# Design")] });
    expect(pending.body).toContain("<summary>Coding plan v1 · not approved yet</summary>");
    expect(pending.body).toContain("<summary>Design v1 · not approved yet</summary>");
    expect(count(pending.body, /Retry failed payments/g)).toBe(1);
  });

  it("writes History times as 'Oct 9, 22:20 UTC' and keeps the exact time in the element", async () => {
    const answer = await render({ history: [
      { at: "2026-10-09T22:20:16.305Z", text: "Coding plan v1 was written" },
      { at: "2026-12-31T03:04:59.000Z", text: "Later" },
      { at: "not a time", text: "Odd <b>" },
    ] });
    const history = answer.body.slice(answer.body.indexOf('id="history"'));
    expect(history).toContain('<time datetime="2026-10-09T22:20:16.305Z">Oct 9, 22:20 UTC</time>');
    expect(history).toContain('<time datetime="2026-12-31T03:04:59.000Z">Dec 31, 03:04 UTC</time>');
    expect(visible(answer.body)).not.toContain("2026-10-09T22");
    expect(history).toContain("Odd &lt;b&gt;");
  });

  it("keeps the page-level Checks section until checks have run, except a review-only or unreadable note", async () => {
    const waiting: TaskDocumentView["checks"] = [{ label: "npm test", passed: undefined }, { label: "Unit", passed: undefined, proposed: true, proves: ["1"] }];
    expect(checksSection((await render({ stage: "Coding plan", checks: waiting })).body)).toBeUndefined();
    expect(checksSection((await render({ stage: "Coding", checks: waiting })).body)).toBeUndefined();
    const ran = await render({ stage: "Checks", checks: [{ label: "npm test", passed: true }, { label: "Unit", passed: false }] });
    expect(checksSection(ran.body)).toContain("<li>npm test: Passed</li>");
    expect(checksSection(ran.body)).toContain("<li>Unit: Didn't pass</li>");
    // A check whose result could not be told has still run.
    expect(checksSection((await render({ stage: "Checks", checks: [{ label: "npm test", passed: undefined, unclear: true }] })).body)).toContain("npm test: Couldn't tell");
    // The view's own flag wins over what the rows say.
    expect(checksSection((await render({ stage: "Checks", checksRan: false, checks: [{ label: "npm test", passed: true }] })).body)).toBeUndefined();
    expect(checksSection((await render({ stage: "Checks", checksRan: true, checks: waiting })).body)).toContain("<li>npm test: Not run yet</li>");
    // The review-only and unreadable notes stay.
    expect(checksSection((await render({ stage: "Coding plan", checks: [], checksNote: "No automated checks apply. Review only." })).body)).toContain("No automated checks apply. Review only.");
    expect(checksSection((await render({ stage: "Coding plan", checks: waiting, checksNote: "AgentX could not read the proposed checks." })).body)).toContain("AgentX could not read the proposed checks.");
  });

  it("says no checks are set up only once the checks step is reached, never at requirements, design or the coding plan", async () => {
    for (const stage of ["Requirements", "Design", "Coding plan", "Coding", ""]) {
      const body = (await render({ path: "FULL", stage, checks: [] })).body;
      expect(body, stage).not.toContain("No checks are set up");
      expect(checksSection(body), stage).toBeUndefined();
    }
    for (const stage of ["Checks", "Reviews", "Pull request"]) expect(checksSection((await render({ stage, checks: [] })).body), stage).toContain("No checks are set up for this task.");
  });

  it("does not show a Checks section right after the coding plan's own checks table before checks have run", async () => {
    const answer = await render({ stage: "Coding plan", documents: [structuredDoc("coding plan", 1, plan)], checks: [{ label: "Unit", passed: undefined, proposed: true, proves: ["1"] }] });
    expect(answer.body).toContain('class="checks"');
    expect(answer.body).not.toContain("See the checks in the coding plan.");
    expect(checksSection(answer.body)).toBeUndefined();
  });

  it("puts a space after the mark on the progress chips, and keeps the chips wrapping", async () => {
    const css = await style();
    expect(css).toContain('.step.current::before{content:"\\25cf\\00a0"}');
    expect(css).toContain('.step.done::before{content:"\\2713\\00a0"}');
    expect(css).toMatch(/\.progress\{display:flex;flex-wrap:wrap/);
  });

  it("fits a phone: code blocks scroll inside themselves with a visible scrollbar, long text wraps, nothing has a fixed width", async () => {
    const css = await style();
    expect(css).toMatch(/(^|\})pre\{[^}]*display:block[^}]*overflow-x:auto[^}]*max-width:100%/);
    expect(css).toMatch(/body\{[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/pre\.doc-text\{[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere/);
    // Always-visible scrollbars on code blocks and tables: the standard property and the WebKit pseudo-elements.
    expect(css).toMatch(/pre,\.checks table\{[^}]*scrollbar-color:/);
    expect(css).toMatch(/pre::-webkit-scrollbar,\.checks table::-webkit-scrollbar\{[^}]*height:/);
    expect(css).toMatch(/::-webkit-scrollbar-thumb\{/);
    expect(css).toMatch(/figure,details,table,blockquote,svg\{[^}]*max-width:100%/);
    expect(css).toContain("min-width:0");
    expect(css).toMatch(/\.checks table\{[^}]*overflow-x:auto/);
    // No fixed pixel or rem widths (a max-width in a media query is a breakpoint, not a width).
    expect(css.replace(/@media[^{]*\{/g, "")).not.toMatch(/(^|[;{\s])width:\s*[0-9.]+(px|rem|em|ch)/);
    expect(css).toContain("@media (max-width:35rem)");
  });

  it("keeps the checks table's short columns whole, wraps only the label at word boundaries, and stacks each check on a phone", async () => {
    const css = await style();
    const narrow = /@media \(max-width:35rem\)\{([\s\S]*)\}$/.exec(css)?.[1] ?? "";
    const base = css.slice(0, css.indexOf("@media (max-width:35rem)"));
    expect(base).toMatch(/\.checks th,\.checks td\{[^}]*word-break:normal;overflow-wrap:normal;white-space:nowrap/);
    expect(base).toMatch(/\.checks th\.check-label,\.checks td\.check-label\{[^}]*white-space:normal;overflow-wrap:break-word/);
    // Phone: each row is one block, the label first, then From, Proves and Status on one line separated by a middle dot.
    expect(narrow).toMatch(/\.checks table,\.checks tbody,\.checks tr\{display:block/);
    expect(narrow).toMatch(/\.checks td\{display:inline/);
    expect(narrow).toMatch(/\.checks td\.check-label\{display:block/);
    // The line can wrap on a phone: Proves and Status may break between words, and a breakable space (not a no-break one) surrounds each dot.
    expect(narrow).toContain('.checks td.check-proves::before,.checks td.check-status::before{content:"\\0020\\00b7\\0020"}');
    expect(narrow).not.toContain("\\00a0");
    expect(narrow).toMatch(/\.checks td\.check-proves,\.checks td\.check-status\{white-space:normal\}/);
    expect(narrow).toMatch(/\.checks thead\{[^}]*clip-path/);
    // The page-wide wrap rule still applies to the rest, and no mid-word break is forced inside the cells.
    expect(base).not.toMatch(/\.checks t[dh][^{]*\{[^}]*overflow-wrap:anywhere/);
  });

  it("sets the scrollbar deliberately: the standard properties, with the WebKit rules only where those are unsupported", async () => {
    const css = await style();
    expect(css).toContain("pre,.checks table{scrollbar-width:auto;scrollbar-color:var(--muted) var(--panel)}");
    // Overlay scrollbars hide until used, so code blocks also show an edge shadow where more text is out of view.
    expect(css).toMatch(/pre\{background:linear-gradient\([^}]*no-repeat local[^}]*no-repeat scroll[^}]*var\(--panel\)\}/);
    expect(css).toMatch(/@supports not \(scrollbar-color:auto\)\{pre::-webkit-scrollbar,\.checks table::-webkit-scrollbar\{[^}]*height:[^}]*\}pre::-webkit-scrollbar-thumb/);
  });

  describe("review notes and accepted findings", () => {
    const findings: TaskDocumentView["findings"] = [
      { role: "code", text: "Real <b>bug</b>", origin: "INTRODUCED", file: "src/a.ts", line: 3 },
      { role: "code", text: "The plan asked for this, but it is unwise", origin: "INTRODUCED", advisory: true },
      { role: "code", text: "Old retry loop", origin: "PRE_EXISTING" },
    ];
    const findingsSection = (body: string): string => body.slice(body.indexOf('id="findings"'), body.indexOf('aria-label="Pull requests"'));

    it("lists advisory notes under Notes (advisory), never under Caused by this change", async () => {
      const section = findingsSection((await render({ findings })).body);
      const caused = section.slice(section.indexOf("Caused by this change"), section.indexOf("Notes (advisory)"));
      expect(section.indexOf("Caused by this change")).toBeLessThan(section.indexOf("Notes (advisory)"));
      expect(section.indexOf("Notes (advisory)")).toBeLessThan(section.indexOf("Already in the code (advisory)"));
      expect(caused).toContain("Real &lt;b&gt;bug&lt;/b&gt;");
      expect(caused).not.toContain("The plan asked for this");
      const notes = section.slice(section.indexOf("Notes (advisory)"), section.indexOf("Already in the code (advisory)"));
      expect(notes).toContain("The plan asked for this, but it is unwise");
      expect(notes).not.toContain("Real");
      expect(section).toContain("Old retry loop");
    });

    it("shows no Notes (advisory) heading when there are none", async () => {
      expect((await render({ findings: [findings[0]!] })).body).not.toContain("Notes (advisory)");
    });

    it("lists accepted findings with the owner and the reason, escaped, and not as open findings", async () => {
      const section = findingsSection((await render({ findings: [findings[1]!], acceptedFindings: [
        { role: "security", text: "Token <i>logged</i>", reason: "Only in tests <b>here</b>", owner: "Maya Chen", at: "2026-10-09T22:20:16.305Z" },
        { role: "code", text: "Slow loop", reason: "Fine for now", owner: "Maya Chen", at: "2026-10-09T22:21:16.305Z" },
      ] })).body);
      expect(section).toContain("Accepted by the owner");
      const accepted = section.slice(section.indexOf("Accepted by the owner"));
      expect(accepted).toContain("Security review");
      expect(accepted).toContain("Token &lt;i&gt;logged&lt;/i&gt;");
      expect(accepted).toContain("Accepted by Maya Chen: Only in tests &lt;b&gt;here&lt;/b&gt;");
      expect(accepted).toContain("Slow loop");
      expect(accepted).toContain("Accepted by Maya Chen: Fine for now");
      expect(section).not.toContain("<b>here</b>");
      expect(section).not.toContain("No review findings for the current code.");
      const only = findingsSection((await render({ findings: [], acceptedFindings: [{ role: "code", text: "Slow loop", reason: "Fine", owner: "Maya Chen", at: "2026-10-09T22:21:16.305Z" }] })).body);
      expect(only).toContain("Slow loop");
      expect(only).not.toContain("No review findings for the current code.");
      expect(only).not.toContain("Caused by this change");
    });
  });
});

/** The element's opening tag as the page writes it. */
const openingTag = (html: string, id: string): string => new RegExp(`<[a-z]+ id="${id}"[^>]*>`).exec(html)?.[0] ?? "";

describe("the task page's documents, versions and history", () => {
  const v1 = planDocument({ claims: [{ id: "1", text: "Retries happen." }, { id: "2", text: "Nothing is charged twice." }], decisions: [] });
  const v2 = planDocument({ claims: [{ id: "1", text: "Retries happen after a pause." }, { id: "2", text: "Nothing is charged twice." }, { id: "3", text: "A retry is logged." }], decisions: [] });
  const twoVersions = [structuredDoc("coding plan", 1, v1, { current: false }), structuredDoc("coding plan", 2, v2)];

  it("opens the asked-for document from an older version, with a note and What changed open, and the other documents closed", async () => {
    const answer = await renderAt("?doc=coding-plan&from=1", { path: "FULL", stage: "Coding plan", documents: [
      markdownDoc("requirements", 1, "# Requirements", { approved: true }), markdownDoc("design", 1, "# Design", { approved: true }), ...twoVersions,
    ] });
    const body = answer.body;
    expect(body).toContain("You opened this from v1. Here's what changed since v1.");
    expect(body).toContain('<details class="changes" open>');
    expect(body.indexOf("You opened this from v1")).toBeLessThan(body.indexOf('id="coding-plan-v2"'));
    expect(body).toMatch(/<section id="coding-plan" class="kind" data-current="2"><details class="document" open>/);
    expect(body).toMatch(/<section id="requirements" class="kind" data-current="1"><details class="document">/);
    expect(body).toMatch(/<section id="design" class="kind" data-current="1"><details class="document">/);
    expect(body).toContain("<summary>Earlier versions (1)</summary>");
    expect(openingTag(body, "coding-plan-v1")).toContain('class="doc doc-coding-plan"');
    expect(body).toContain("This is v1. v2 is the current one.");
    // Workflow order: requirements, design, then the coding plan, then everything else.
    expect(body.indexOf('id="requirements"')).toBeLessThan(body.indexOf('id="design"'));
    expect(body.indexOf('id="design"')).toBeLessThan(body.indexOf('id="coding-plan"'));
    expect(body.indexOf('id="coding-plan"')).toBeLessThan(body.indexOf('aria-label="Checks"'));
  });

  it("names the version What changed compares against when the reader came from two or more versions back", async () => {
    const v3 = planDocument({ claims: [{ id: "1", text: "Retries happen after a long pause." }], decisions: [] });
    const answer = await renderAt("?doc=coding-plan&from=1", { path: "QUICK", stage: "Coding plan", documents: [
      structuredDoc("coding plan", 1, v1, { current: false }), structuredDoc("coding plan", 2, v2, { current: false }), structuredDoc("coding plan", 3, v3),
    ] });
    expect(answer.body).toContain("You opened this from v1. Here's what changed since v2.");
    expect(answer.body).toContain("What changed since v2");
    expect(answer.body).not.toContain("Here's what changed since v1");
  });

  it("promises no What changed when the version before the current one is Markdown", async () => {
    const answer = await renderAt("?doc=coding-plan&from=1", { path: "QUICK", stage: "Coding plan", documents: [
      markdownDoc("coding plan", 1, "# Old plan", { current: false }), structuredDoc("coding plan", 2, v2),
    ] });
    expect(answer.body).toContain("You opened this from v1. v2 is the current version.");
    expect(answer.body).not.toContain("Here's what changed");
    expect(answer.body).not.toContain("What changed since");
    expect(answer.body).not.toContain('<details class="changes" open>');
  });

  it("opens the current step's document when none is asked for, and shows no note without an older version", async () => {
    const documents = [markdownDoc("requirements", 1, "# Requirements", { approved: true }), structuredDoc("design", 2, v2), structuredDoc("design", 1, v1, { current: false })];
    const answer = await renderAt("", { path: "FULL", stage: "Design", documents });
    expect(answer.body).toMatch(/<section id="design"[^>]*><details class="document" open>/);
    expect(answer.body).toMatch(/<section id="requirements"[^>]*><details class="document">/);
    expect(answer.body).not.toContain("You opened this from");
    expect(answer.body).not.toContain('<details class="changes" open>');
    // From the current version, or a later one, is not "from an older version".
    expect((await renderAt("?doc=design&from=2", { path: "FULL", stage: "Design", documents })).body).not.toContain("You opened this from");
    expect((await renderAt("?doc=design&from=9", { path: "FULL", stage: "Design", documents })).body).not.toContain("You opened this from");
  });

  it("ignores a document or version it does not know", async () => {
    const documents = [structuredDoc("design", 2, v2), structuredDoc("design", 1, v1, { current: false }), ...twoVersions];
    // An unknown document: the current step's document opens, as with no query at all.
    for (const search of ["?doc=everything&from=1", "?doc=coding%20plan&from=1", "?doc[]=design&from[]=1", "?doc=&from=1", "?doc=DESIGN&from=1"]) {
      const answer = await renderAt(search, { path: "FULL", stage: "Design", documents });
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain("You opened this from");
      expect(answer.body).toMatch(/<section id="design"[^>]*><details class="document" open>/);
      expect(answer.body).toMatch(/<section id="coding-plan"[^>]*><details class="document">/);
    }
    // An unknown version: the document opens, with no note.
    for (const search of ["?doc=coding-plan&from=0", "?doc=coding-plan&from=-2", "?doc=coding-plan&from=one", "?doc=coding-plan&from=1.5", "?doc=coding-plan&from=1e1", "?doc=coding-plan&from=99999999999"]) {
      const answer = await renderAt(search, { path: "FULL", stage: "Design", documents });
      expect(answer.body).not.toContain("You opened this from");
      expect(answer.body).toMatch(/<section id="coding-plan"[^>]*><details class="document" open>/);
      expect(answer.body).not.toContain('<details class="changes" open>');
    }
  });

  it("marks the current step in the progress strip: seven steps for a full task, five for a quick one", async () => {
    const full = (await renderAt("", { path: "FULL", stage: "Checks" })).body;
    const strip = (html: string) => /<nav aria-label="Progress">([\s\S]*?)<\/nav>/.exec(html)![1]!;
    const steps = (html: string) => [...strip(html).matchAll(/<li[^>]*>(?:<a [^>]*>)?([^<]*)(?:<\/a>)?<\/li>/g)].map((match) => match[1]);
    expect(steps(full)).toEqual(["Requirements", "Design", "Coding plan", "Coding", "Checks", "Reviews", "Pull request"]);
    expect(strip(full).match(/aria-current="step"/g)).toHaveLength(1);
    expect(strip(full)).toMatch(/aria-current="step">(<a [^>]*>)?Checks</);
    const quick = (await renderAt("", { path: "QUICK", stage: "Coding" })).body;
    expect(steps(quick)).toEqual(["Coding plan", "Coding", "Checks", "Reviews", "Pull request"]);
    expect(strip(quick)).toMatch(/aria-current="step">(<a [^>]*>)?Coding</);
    expect((await renderAt("", { path: "QUICK", stage: "" })).body).not.toContain("aria-current");
  });

  describe("progress chips", () => {
    const strip = (html: string) => /<nav aria-label="Progress">([\s\S]*?)<\/nav>/.exec(html)![1]!;
    const chip = (html: string, name: string) => new RegExp(`<li class="([^"]*)"([^>]*)>(?:<a ([^>]*)>)?${name}(?:</a>)?</li>`).exec(strip(html));
    const href = (html: string, name: string) => /href="([^"]*)"/.exec(chip(html, name)?.[3] ?? "")?.[1];
    const allDocs = [markdownDoc("requirements", 1, "# R", { approved: true }), markdownDoc("design", 1, "# D", { approved: true }), markdownDoc("coding plan", 1, "# P", { approved: true })];
    const pr = [{ url: "https://github.com/example/demo/pull/42", number: 42, state: "OPEN" }];
    const full = { path: "FULL" as const, documents: allDocs, checks: [{ label: "npm test", passed: true }], checksRan: true };

    it("links each chip to its section, and the pull request chip to GitHub", async () => {
      const html = (await render({ ...full, stage: "Pull request", pullRequests: pr })).body;
      expect(href(html, "Requirements")).toBe("#requirements");
      expect(href(html, "Design")).toBe("#design");
      expect(href(html, "Coding plan")).toBe("#coding-plan");
      expect(href(html, "Coding")).toBe("#checks");
      expect(href(html, "Checks")).toBe("#checks");
      expect(href(html, "Reviews")).toBe("#findings");
      expect(href(html, "Pull request")).toBe("https://github.com/example/demo/pull/42");
      expect(chip(html, "Pull request")![3]).toContain('rel="noopener');
      // Every internal target exists on the page.
      for (const id of ["requirements", "design", "coding-plan", "checks", "findings"]) expect(html).toContain(`id="${id}"`);
    });

    it("leaves a step with no content yet as plain text, not a link", async () => {
      const html = (await render({ path: "FULL", stage: "Requirements", documents: [markdownDoc("requirements", 1, "# R")], checks: [], findings: [], pullRequests: [] })).body;
      expect(href(html, "Requirements")).toBe("#requirements");
      for (const name of ["Design", "Coding plan", "Coding", "Checks", "Pull request"]) {
        expect(chip(html, name), name).not.toBeNull();
        expect(chip(html, name)![3], name).toBeUndefined();
      }
      expect(strip(html).match(/<a /g) ?? []).toHaveLength(1);
    });

    it("never builds a link from a pull request address that is not on GitHub", async () => {
      const html = (await render({ ...full, stage: "Pull request", pullRequests: [{ url: "https://evil.example/x\"onmouseover=\"1", number: 1, state: "OPEN" }] })).body;
      expect(strip(html)).not.toContain("evil.example");
      expect(chip(html, "Pull request")![3]).toBeUndefined();
    });

    it("sends a task with several pull requests to the pull request list", async () => {
      const html = (await render({ ...full, stage: "Pull request", pullRequests: [...pr, { url: "https://github.com/example/other/pull/7", number: 7, state: "OPEN" }] })).body;
      expect(href(html, "Pull request")).toBe("#pull-requests");
      expect(html).toContain('id="pull-requests"');
    });

    it("keeps the pill look and a visible focus style for a chip link", async () => {
      const html = (await render({ ...full, stage: "Checks" })).body;
      expect(html).toMatch(/\.step a[^{]*\{[^}]*text-decoration/);
      expect(html).toMatch(/\.step a:focus[^{]*\{outline:3px solid var\(--focus\)/);
    });

    it("marks every step before the pull request done and the pull request current once it is open", async () => {
      const html = (await render({ ...full, stage: "Pull request", pullRequests: pr })).body;
      expect(strip(html).match(/aria-current="step"/g)).toHaveLength(1);
      expect(strip(html)).toMatch(/aria-current="step"><a [^>]*>Pull request</);
      for (const name of ["Requirements", "Design", "Coding plan", "Coding", "Checks", "Reviews"]) expect(chip(html, name)![1], name).toBe("step done");
      expect(chip(html, "Pull request")![1]).toBe("step current");
    });

    it("marks every step done once the pull request is merged", async () => {
      const html = (await render({ ...full, stage: "Complete", pullRequests: [{ ...pr[0]!, state: "MERGED" }] })).body;
      expect(strip(html)).not.toContain("aria-current");
      for (const name of ["Requirements", "Design", "Coding plan", "Coding", "Checks", "Reviews", "Pull request"]) expect(chip(html, name)![1], name).toBe("step done");
      expect(href(html, "Pull request")).toBe("https://github.com/example/demo/pull/42");
    });

    it("says no checks are set up on a merged task that had none", async () => {
      const html = (await render({ path: "FULL", documents: allDocs, checks: [], stage: "Complete" })).body;
      expect(html).toContain("No checks are set up for this task.");
    });
  });

  it("lists History newest first from versions and decisions, with no thread replies", async () => {
    const answer = await render({ history: [
      { at: "2026-10-07T10:00:00.000Z", text: "Coding plan v1 was written", link: "#coding-plan-v1" },
      { at: "2026-10-07T12:00:00.000Z", text: "Coding plan v2 was written <b>", link: "#coding-plan-v2" },
      { at: "2026-10-07T11:00:00.000Z", text: "Maya asked for changes to Coding plan v1: shorter" },
    ] });
    const history = answer.body.slice(answer.body.indexOf('id="history"'));
    expect(history.indexOf("Coding plan v2 was written")).toBeLessThan(history.indexOf("Maya asked for changes"));
    expect(history.indexOf("Maya asked for changes")).toBeLessThan(history.indexOf("Coding plan v1 was written"));
    expect(history).toContain("Coding plan v2 was written &lt;b&gt;");
    expect(history).toContain('<a href="#coding-plan-v2">');
    expect(visible(answer.body)).not.toMatch(/thread repl/i);
  });

  it("only links a History entry to a place inside the page", async () => {
    const answer = await render({ history: [{ at: "2026-10-07T10:00:00.000Z", text: "Odd", link: "https://evil.example/x" }] });
    expect(answer.body).not.toContain("evil.example");
  });

  it("still shows a saved Markdown document in a pre block, and a structured one as a reading page, never as raw JSON", async () => {
    const legacy = await render({});
    expect(legacy.body).toMatch(/<pre class="doc-text">[^<]*&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const structured = await render({ documents: twoVersions });
    expect(structured.body).toContain("Retries happen after a pause.");
    expect(structured.body).not.toContain("&quot;schemaVersion&quot;");
    expect(structured.body).toContain('id="coding-plan-v2-1"');
    // Older versions keep their own claim anchors.
    expect(structured.body).toContain('id="coding-plan-v1-1"');
  });

  it("has landmarks, one heading, the role line, a dark-mode style and a viewport, and says decisions are made in Slack", async () => {
    const body = (await render({})).body;
    expect(body).toContain("<header>");
    expect(body).toContain("<main>");
    expect(body).toContain('<nav aria-label="Progress">');
    expect(body.match(/<h1>/g)).toHaveLength(1);
    expect(body).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(body).toContain("@media (prefers-color-scheme:dark)");
    expect(body).toMatch(/summary:focus\{outline/);
    expect(body).toMatch(/a:focus[^{]*\{outline/);
    expect(body).toContain("You're the task owner.");
    expect(body).toContain("Decisions are made in Slack.");
    expect((await render({ role: "reader" })).body).toContain("You can read this task.");
    expect(body).not.toMatch(/ style="/);
  });

  describe("the script", () => {
    interface Fake {
      id: string; tagName: string; parentElement?: Fake; firstElementChild?: Fake; open: boolean; attributes: Record<string, string>;
      classes: Set<string>; scrolled: unknown[];
    }
    const element = (id: string, tagName: string, parent?: Fake, attributes: Record<string, string> = {}): Fake => {
      const fake: Fake = { id, tagName, attributes, classes: new Set(), scrolled: [], open: false };
      if (parent !== undefined) fake.parentElement = parent;
      return fake;
    };
    /** Runs the emitted script against a minimal page: elements by ID, a location, and the timers and listeners it sets. */
    function run(elements: Fake[], location: { hash: string; search: string }) {
      const byId = new Map(elements.map((item) => [item.id, item]));
      const listeners = new Map<string, () => void>();
      const timers: Array<{ fn: () => void; ms: number }> = [];
      for (const item of elements) {
        Object.assign(item, {
          getAttribute: (name: string) => item.attributes[name] ?? null,
          scrollIntoView: (options: unknown) => { item.scrolled.push(options); },
          classList: { add: (name: string) => item.classes.add(name), remove: (name: string) => item.classes.delete(name) },
        });
      }
      const sandbox = {
        location, document: { getElementById: (id: string) => byId.get(id) ?? null },
        window: { addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn); } },
        setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 0; },
        decodeURIComponent,
      };
      vm.runInNewContext(TASK_PAGE_SCRIPT, sandbox);
      return { listeners, timers };
    }
    const claimPage = () => {
      const section = element("coding-plan", "SECTION", undefined, { "data-current": "2" });
      const kind = element("", "DETAILS", section);
      section.firstElementChild = kind;
      const folded = element("", "DETAILS", kind);
      const parent = element("coding-plan-v2-2", "DETAILS", folded);
      const claim = element(claimAnchor("coding-plan", 2, "2.1"), "DETAILS", parent);
      const old = element("coding-plan-v1-2-1", "DETAILS", kind);
      return { section, kind, folded, parent, claim, old, all: [section, kind, folded, parent, claim, old] };
    };

    it("maps #<document>/<claim> to the current version's claim, opens every <details> around it, scrolls and flashes for two seconds", () => {
      const page = claimPage();
      const { timers } = run(page.all, { hash: "#coding-plan/2.1", search: "" });
      expect(page.claim.id).toBe("coding-plan-v2-2-1");
      expect(page.claim.scrolled).toEqual([{ block: "start" }]);
      for (const item of [page.kind, page.folded, page.parent, page.claim]) expect(item.open).toBe(true);
      expect(page.old.open).toBe(false);
      expect(page.claim.classes.has("flash")).toBe(true);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.ms).toBe(2000);
      timers[0]!.fn();
      expect(page.claim.classes.has("flash")).toBe(false);
    });

    it("builds the same anchors as the server for one, two and three level claim IDs", () => {
      for (const claimId of ["4", "1.2", "3.1.2"]) {
        const page = claimPage();
        const target = element(claimAnchor("coding-plan", 2, claimId), "DETAILS", page.kind);
        run([...page.all, target], { hash: `#coding-plan/${claimId}`, search: "" });
        expect(target.scrolled).toEqual([{ block: "start" }]);
      }
    });

    it("goes to a document from ?doc= when there is no hash, to any anchor in the hash, and again when the hash changes", () => {
      const page = claimPage();
      run(page.all, { hash: "", search: "?doc=coding-plan&from=1" });
      expect(page.section.scrolled).toEqual([{ block: "start" }]);
      expect(page.kind.open).toBe(true);
      const location = { hash: "#coding-plan-v1-2-1", search: "" };
      const again = claimPage();
      const second = run(again.all, location);
      expect(again.old.open).toBe(true);
      again.old.open = false;
      second.listeners.get("hashchange")!();
      expect(again.old.open).toBe(true);
      expect(again.old.scrolled).toHaveLength(2);
    });

    it("does nothing without a target, falls back to the document for a claim that is not there, and ignores unknown places", () => {
      const page = claimPage();
      const none = run(page.all, { hash: "", search: "" });
      expect(none.timers).toHaveLength(0);
      expect(page.section.scrolled).toEqual([]);
      const missing = claimPage();
      run(missing.all, { hash: "#coding-plan/9.9", search: "" });
      expect(missing.section.scrolled).toEqual([{ block: "start" }]);
      const unknown = claimPage();
      run(unknown.all, { hash: "#nothing-here/1", search: "" });
      expect(unknown.all.every((item) => item.scrolled.length === 0)).toBe(true);
    });
  });
});

describe("the task page says when the task has moved on", () => {
  const statusUrl = new URL(`https://agentx.example.test/review/${taskId}/task/status`);
  const statusRequest = (cookie?: string, method = "GET"): AdaptedHttpRequest => ({ ...request(`/review/${taskId}/task/status`, cookie), method });
  const freshnessWeb = (options: { signedIn?: boolean; freshness?: () => Promise<{ revision: number; stage: string }> } = {}) => createTaskWeb({
    authenticateSession: async () => options.signedIn === false ? undefined : caller,
    getTaskDocumentView: async () => view,
    getTaskFreshness: options.freshness ?? (async () => ({ revision: 7, stage: "Pull request" })),
  });

  it("embeds where the task stood in a hidden banner with a Refresh button, which a page without scripts never shows", async () => {
    const body = (await render({ revision: 4, stage: "Reviews" })).body;
    const banner = /<div id="moved-on"[^>]*>[\s\S]*?<\/div>/.exec(body)?.[0];
    expect(banner).toBeDefined();
    expect(banner).toMatch(/\shidden[\s>]/);
    expect(banner).toContain('data-version="4"');
    expect(banner).toContain('data-stage="Reviews"');
    expect(banner).toContain(`data-check="/review/${taskId}/task/status"`);
    expect(banner).toContain('role="status"');
    expect(banner).toContain("This task has moved on. Refresh to see the latest.");
    expect(banner).toContain('<button type="button" id="moved-on-refresh">Refresh</button>');
    expect(TASK_PAGE_STYLE).toContain("[hidden]{display:none");
    // Still one script and no form.
    expect(body.match(/<script/g)).toHaveLength(1);
    expect(body).not.toContain("<form");
  });

  it("answers the signed-in reader with where the task stands now, never stored", async () => {
    const answer = await freshnessWeb()(statusRequest(SESSION), statusUrl);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toContain("application/json");
    expect(answer.headers["cache-control"]).toContain("no-store");
    expect(JSON.parse(answer.body)).toEqual({ revision: 7, stage: "Pull request" });
  });

  it("refuses a signed-out reader without a redirect, hides a task the reader may not see, and answers only GET", async () => {
    const signedOut = await freshnessWeb({ signedIn: false })(statusRequest(), statusUrl);
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.headers.location).toBeUndefined();
    expect(signedOut.headers["cache-control"]).toContain("no-store");
    const hidden = await freshnessWeb({ freshness: async () => { throw Object.assign(new Error("x"), { code: "TASK_NOT_FOUND" }); } })(statusRequest(SESSION), statusUrl);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("revision");
    const denied = await freshnessWeb({ freshness: async () => { throw Object.assign(new Error("x"), { code: "TASK_ACCESS_DENIED", owners: ["Maya"] }); } })(statusRequest(SESSION), statusUrl);
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain("Maya");
    const post = await freshnessWeb()(statusRequest(SESSION, "POST"), statusUrl);
    expect(post.statusCode).toBe(405);
  });

  describe("the script", () => {
    function run(options: { version?: string; stage?: string; answer?: () => Promise<{ status: number; body?: unknown }> } = {}) {
      const banner = { hidden: true, attributes: { "data-version": options.version ?? "4", "data-stage": options.stage ?? "Reviews", "data-check": `/review/${taskId}/task/status` } as Record<string, string>,
        getAttribute(name: string) { return this.attributes[name] ?? null; } };
      const clicks: Array<() => void> = [];
      const refresh = { addEventListener: (name: string, fn: () => void) => { if (name === "click") clicks.push(fn); } };
      const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
      const documentListeners = new Map<string, () => void>();
      const fetches: Array<{ url: string; init: Record<string, unknown> }> = [];
      const clock = { now: 1_000_000 };
      const reloads: number[] = [];
      const document = {
        hidden: false,
        getElementById: (id: string) => id === "moved-on" ? banner : id === "moved-on-refresh" ? refresh : null,
        addEventListener: (name: string, fn: () => void) => { documentListeners.set(name, fn); },
      };
      const answer = options.answer ?? (async () => ({ status: 200, body: { revision: 4, stage: "Reviews" } }));
      const sandbox = {
        location: { hash: "", search: "", reload: () => { reloads.push(clock.now); } }, document,
        window: { addEventListener: () => undefined },
        setTimeout: () => 0,
        setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
        clearInterval: (handle: number) => { intervals[handle - 1]!.cleared = true; },
        Date: { now: () => clock.now },
        fetch: (url: string, init: Record<string, unknown>) => {
          fetches.push({ url, init });
          return answer().then((reply) => ({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body }));
        },
        decodeURIComponent, String,
      };
      vm.runInNewContext(TASK_PAGE_SCRIPT, sandbox);
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      const tick = async () => { clock.now += 20_000; for (const entry of intervals) if (!entry.cleared) entry.fn(); await settle(); await settle(); };
      return { banner, clicks, intervals, documentListeners, fetches, clock, reloads, document, tick, settle };
    }

    it("asks every 20 seconds, same origin and never cached, and leaves the banner hidden while nothing changed", async () => {
      const page = run();
      expect(page.intervals).toHaveLength(1);
      expect(page.intervals[0]!.ms).toBe(20_000);
      await page.tick();
      expect(page.fetches.map((entry) => entry.url)).toEqual([`/review/${taskId}/task/status`]);
      expect(page.fetches[0]!.init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
      expect(page.banner.hidden).toBe(true);
    });

    it("shows the banner once the task moved on, stops asking, and reloads only when Refresh is pressed", async () => {
      const page = run({ answer: async () => ({ status: 200, body: { revision: 5, stage: "Pull request" } }) });
      await page.tick();
      expect(page.banner.hidden).toBe(false);
      expect(page.intervals[0]!.cleared).toBe(true);
      expect(page.reloads).toEqual([]);
      page.clicks[0]!();
      expect(page.reloads).toHaveLength(1);
    });

    it("does not ask while the page is hidden, asks again when it is shown, and stops after 30 minutes", async () => {
      const page = run();
      page.document.hidden = true;
      await page.tick();
      expect(page.fetches).toHaveLength(0);
      page.document.hidden = false;
      page.documentListeners.get("visibilitychange")!();
      await page.settle();
      expect(page.fetches).toHaveLength(1);
      page.clock.now += 30 * 60 * 1000;
      await page.tick();
      expect(page.fetches).toHaveLength(1);
      expect(page.intervals[0]!.cleared).toBe(true);
    });

    it("does not ask again on showing the page when it asked under 5 seconds ago", async () => {
      const page = run();
      await page.tick();
      expect(page.fetches).toHaveLength(1);
      page.clock.now += 4_000;
      page.documentListeners.get("visibilitychange")!();
      await page.settle();
      expect(page.fetches).toHaveLength(1);
      page.clock.now += 1_000;
      page.documentListeners.get("visibilitychange")!();
      await page.settle();
      expect(page.fetches).toHaveLength(2);
    });

    it("stops quietly when the sign-in ended or the task is hidden, and ignores a failed answer", async () => {
      const signedOut = run({ answer: async () => ({ status: 401 }) });
      await signedOut.tick();
      expect(signedOut.intervals[0]!.cleared).toBe(true);
      expect(signedOut.banner.hidden).toBe(true);
      const failing = run({ answer: async () => { throw new Error("offline"); } });
      await failing.tick();
      expect(failing.intervals[0]!.cleared).toBe(false);
      expect(failing.banner.hidden).toBe(true);
    });
  });
});

describe("the task page through the broker", () => {
  const TEAMMATE: Developer = { developerId: "f".repeat(64), name: "Lee Park", provider: "slack", sessionId: "s-lee", slackUserId: "U0LEE0001" };
  const NEWCOMER: Developer = { developerId: "a".repeat(64), name: "Nia Fox", provider: "slack", sessionId: "s-nia", slackUserId: "U0NIA0001" };

  async function sharedPlanTask(extra: (saved: { ownerKey: string; workspaceId: string }) => Record<string, unknown> = () => ({})) {
    const slack = { down: false };
    const harness = await createDeveloperTaskBroker({ channelMembers: async (request) => {
      if (slack.down) throw new Error("Slack is down");
      return { ok: true, memberOf: request.slackUserId === MAYA.slackUserId || request.slackUserId === TEAMMATE.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [] };
    } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "test", shareToChannel: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const id = (started.body.task as { taskId: string }).taskId;
    const task = harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { ownerKey: string; workspaceId: string };
    const plan = `# Plan\n\nGoal: fix retry handling.\n\n1. Fix it\n${"P".repeat(2_000)}`;
    const objectKey = `private/${task.ownerKey}/${task.workspaceId}/artifacts/plan.md`;
    harness.s3.objects.set(objectKey, plan);
    const now = new Date().toISOString();
    const base = createWorkflowSnapshot({ taskId: id, ownerId: task.ownerKey, now });
    harness.db.set({ ...task, workflow: { ...base, revision: 3, stage: "PLAN_REVIEW", state: "WAITING",
      artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: createHash("sha256").update(plan).digest("hex"), producer: "test", objectKey, createdAt: now }], ...extra(task) } });
    for (const who of [MAYA, OMAR, TEAMMATE, NEWCOMER]) {
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name,
        ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const open = async (who: Developer, taskPageId = id, suffix = "") => {
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider,
        startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
      return await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskPageId}/task${suffix}`, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` },
        requestContext: { requestId: randomUUID(), http: { method: "GET" } },
      }) as { statusCode: number; headers: Record<string, string>; body: string };
    };
    return { harness, id, plan, objectKey, open, slack };
  }

  const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

  it("answers where the task stands at /task/status for the owner and a teammate, and the page embeds the same", async () => {
    const { open } = await sharedPlanTask();
    const owner = await open(MAYA, undefined, "/status");
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["cache-control"]).toContain("no-store");
    expect(JSON.parse(owner.body)).toEqual({ revision: 3, stage: "Coding plan" });
    expect((await open(MAYA)).body).toContain('data-version="3"');
    expect((await open(TEAMMATE, undefined, "/status")).statusCode).toBe(200);
    // Someone who may not see the task learns nothing, not even that it exists.
    const outsider = await open(NEWCOMER, undefined, "/status");
    expect(outsider.statusCode).toBe(404);
    expect(outsider.body).not.toContain("Maya");
  });

  it("answers a teammate 'not found' when Slack can't confirm their membership, and tells them it's the owner's approval", async () => {
    const { open, slack } = await sharedPlanTask();
    const member = await open(TEAMMATE);
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain("Waiting for the owner&#39;s approval");
    expect(member.body).not.toContain("your approval");
    slack.down = true;
    const unconfirmed = await open(TEAMMATE);
    expect(unconfirmed.statusCode).toBe(404);
    expect(unconfirmed.body).not.toContain("retry");
    // The owner's page needs no Slack lookup.
    expect((await open(MAYA)).statusCode).toBe(200);
  });

  it("reads documents only from the task's own storage, and shows the rest when one can't be read", async () => {
    const elsewhere = "# Design\n\nFrom another task.";
    const { harness, open } = await sharedPlanTask((saved) => {
      const now = new Date().toISOString();
      return { artifacts: [
        { id: "req-1", type: "requirements", version: 1, sha256: digestOf("# Requirements\n\nGone."), producer: "test", objectKey: `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/missing.md`, createdAt: now },
        { id: "design-1", type: "design", version: 1, sha256: digestOf(elsewhere), producer: "test", objectKey: `private/${"0".repeat(64)}/other-workspace/artifacts/design.md`, createdAt: now },
        { id: "plan-1", type: "plan", version: 1, sha256: digestOf(`# Plan\n\nGoal: fix retry handling.\n\n1. Fix it\n${"P".repeat(2_000)}`), producer: "test", objectKey: `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/plan.md`, createdAt: now },
      ] };
    });
    harness.s3.objects.set(`private/${"0".repeat(64)}/other-workspace/artifacts/design.md`, elsewhere);
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).not.toContain("From another task.");
    expect(owner.body).toContain("The saved design couldn't be verified, so it isn't shown.");
    expect(owner.body).toContain("The saved requirements couldn't be verified, so it isn't shown.");
    expect(owner.body).toContain("P".repeat(2_000));
  });

  it("shows only the latest review of each kind for the current code, and a check whose result is unknown as 'Couldn't tell'", async () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const review = (role: "CRITIC" | "SECURITY", text: string, recordedAt: string) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "t", version: "1",
      status: "FINDINGS", findings: [{ text, origin: "INTRODUCED" }], readOnly: true, recordedAt });
    const { open } = await sharedPlanTask(() => ({ stage: "REVIEW", state: "BLOCKED", candidate,
      checkPolicy: { required: [{ id: "unit", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] },
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: "2026-10-08T00:00:00.000Z", results: [{ checkId: "unit", status: "UNKNOWN" }] },
      reviews: [review("CRITIC", "Retried away", "2026-10-08T00:00:00.000Z"), review("CRITIC", "Latest code finding", "2026-10-08T01:00:00.000Z")] }));
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("Latest code finding");
    expect(owner.body).not.toContain("Retried away");
    expect(owner.body).toContain("npm test: Couldn't tell");
  });

  it("carries the advisory flag to the page (never for a security finding) and lists the owner's accepted findings with reason and owner, for the current code only", async () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const review = (role: "CRITIC" | "SECURITY", findings: unknown[]) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "t", version: "1",
      status: "FINDINGS", findings, readOnly: true, recordedAt: "2026-10-08T00:00:00.000Z" });
    const accept = (digest: string, role: "CRITIC" | "SECURITY", text: string, reason: string) => ({ candidateDigest: digest, role, fingerprint: workflowFindingFingerprint(role, { text }),
      text, reason, actorId: MAYA.developerId, at: "2026-10-09T22:20:16.305Z" });
    const { open } = await sharedPlanTask((saved) => ({ stage: "REVIEW", state: "BLOCKED", candidate, ownerKey: saved.ownerKey,
      reviews: [
        review("CRITIC", [{ text: "Accepted <b>bug</b>", origin: "INTRODUCED" }, { text: "Plan asked for it", origin: "INTRODUCED", advisory: true }, { text: "Old loop", origin: "PRE_EXISTING" }]),
        review("SECURITY", [{ text: "Secret in log", origin: "INTRODUCED", advisory: true }]),
      ],
      acceptedFindings: [accept(candidate.digest, "CRITIC", "Accepted <b>bug</b>", "Only in <i>tests</i>"), accept("c".repeat(64), "CRITIC", "From older code", "Old reason")] }));
    const body = (await open(MAYA)).body;
    const section = body.slice(body.indexOf('id="findings"'), body.indexOf('aria-label="Pull requests"'));
    const caused = section.slice(section.indexOf("Caused by this change"), section.indexOf("Notes (advisory)"));
    expect(caused).toContain("Secret in log");
    expect(caused).not.toContain("Plan asked for it");
    expect(caused).not.toContain("Accepted &lt;b&gt;bug");
    expect(section.slice(section.indexOf("Notes (advisory)"), section.indexOf("Already in the code"))).toContain("Plan asked for it");
    expect(section.slice(section.indexOf("Notes (advisory)"), section.indexOf("Already in the code"))).not.toContain("Secret in log");
    const accepted = section.slice(section.indexOf("Accepted by the owner"));
    expect(accepted).toContain("Accepted &lt;b&gt;bug&lt;/b&gt;");
    expect(accepted).toContain("Accepted by Maya Chen: Only in &lt;i&gt;tests&lt;/i&gt;");
    expect(accepted).not.toContain("From older code");
    expect(body).not.toContain("<i>tests</i>");
  });

  it("says whether checks have run: a result for the current code, not a result for older code", async () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const checkPolicy = { required: [{ id: "unit", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
    const results = (digest: string) => ({ candidateDigest: digest, producer: "t", environmentId: "w", recordedAt: "2026-10-08T00:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] });
    const ran = await sharedPlanTask(() => ({ stage: "REVIEW", state: "RUNNING", candidate, checkPolicy, verification: results(candidate.digest) }));
    expect((await ran.open(MAYA)).body).toContain("<li>npm test: Passed</li>");
    const older = await sharedPlanTask(() => ({ stage: "IMPLEMENT", state: "RUNNING", candidate, checkPolicy, verification: results("c".repeat(64)) }));
    expect((await older.open(MAYA)).body).not.toContain('aria-label="Checks"');
  });

  it("lists the coding plan's proposed checks after the project's, and says when the plan is review only", async () => {
    const command = { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 };
    const { open } = await sharedPlanTask(() => ({ checkPolicy: { required: [{ id: "unit", label: "npm test", command }], optional: [], selectedOptionalIds: [],
      proposed: [{ id: "proposed-1", label: "Typecheck <src>", command: { ...command, executable: "npx", args: ["tsc"] } }] } }));
    const owner = await open(MAYA);
    // Nothing has run yet, so the page-level Checks section waits; the plan's own table lists them.
    expect(owner.body).not.toContain('aria-label="Checks"');
    expect(owner.body).not.toContain("<li>npm test: Not run yet</li>");
    const none = await sharedPlanTask(() => ({ checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Only <i>docs</i> change." } }));
    expect((await none.open(MAYA)).body).toContain("No automated checks apply: Only &lt;i&gt;docs&lt;/i&gt; change. Review only.");
  });

  it("shows the owner and a member of the task's channel the full document, and hides it from anyone else", async () => {
    const { plan, open } = await sharedPlanTask();
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("P".repeat(2_000));
    expect(owner.body).toContain("Waiting for your approval");
    const member = await open(TEAMMATE);
    expect(member.statusCode).toBe(200);
    expect(member.body).toContain(plan.split("\n")[2]);
    const stranger = await open(OMAR);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain("retry");
  });

  describe("who may read the page", () => {
    const nonceless = (answer: { statusCode: number; body: string }) => ({ status: answer.statusCode, body: answer.body.replace(/nonce="[^"]+"/g, 'nonce="N"') });
    const closed = { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: false };

    it("refuses a channel member who cannot use the project, in the words everyone else gets", async () => {
      const { harness, open } = await sharedPlanTask();
      expect((await open(TEAMMATE)).statusCode).toBe(200);
      await registerRevision(harness.handler, 2, closed);
      const refused = await open(TEAMMATE);
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toContain("You don&#39;t have access to this task.");
      expect(refused.body).not.toContain("Ask ");
      expect(refused.body).not.toContain("Maya");
      expect(nonceless(refused)).toEqual(nonceless(await open(OMAR)));
      // The owner never depends on the project's channel policy.
      expect((await open(MAYA)).statusCode).toBe(200);
    });

    it("names the owner to a reader who can use the project but is not in the task's channel", async () => {
      const { harness, open } = await sharedPlanTask();
      grantProject(harness.db, NEWCOMER);
      const refused = await open(NEWCOMER);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toContain("You don&#39;t have access to this task. Ask Maya Chen to add you.");
      expect(refused.body).not.toContain("retry");
    });

    it("does not name the owner to a reader who cannot use the project, or who is not on the Slack workspace", async () => {
      const { harness, open } = await sharedPlanTask();
      expect((await open(NEWCOMER)).statusCode).toBe(404);
      grantProject(harness.db, OMAR);
      const noSlack = await open(OMAR);
      expect(noSlack.statusCode).toBe(404);
      expect(noSlack.body).not.toContain("Maya");
    });

    it("answers a missing task, an outsider and a failed lookup with the same status and page", async () => {
      const { open, slack } = await sharedPlanTask();
      const missing = nonceless(await open(OMAR, randomUUID()));
      expect(missing.status).toBe(404);
      expect(nonceless(await open(OMAR))).toEqual(missing);
      expect(nonceless(await open(NEWCOMER, randomUUID()))).toEqual(missing);
      slack.down = true;
      expect(nonceless(await open(TEAMMATE))).toEqual(missing);
    });

    it("still shows the page to the owner and to a channel member who can use the project", async () => {
      const { open } = await sharedPlanTask();
      expect((await open(MAYA)).statusCode).toBe(200);
      expect((await open(TEAMMATE)).statusCode).toBe(200);
    });
  });

  it("drops a document whose saved copy changed, and says so", async () => {
    const { harness, objectKey, open } = await sharedPlanTask();
    harness.s3.objects.set(objectKey, "# Plan\n\nSomething else entirely.");
    const owner = await open(MAYA);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).not.toContain("Something else entirely.");
    expect(owner.body).toContain("The saved coding plan couldn't be verified, so it isn't shown.");
  });
  describe("structured documents", () => {
    const first = planDocument({ claims: [{ id: "1", text: "Retries happen." }], decisions: [] });
    const second = planDocument({ claims: [{ id: "1", text: "Retries happen after a pause." }, { id: "2", text: "A retry is logged." }], decisions: [] });
    const structuredPlans = (saved: { ownerKey: string; workspaceId: string }, keyFor: (version: number) => string = (version) => `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/plan-v${version}.json`) => {
      const now = "2026-10-08T10:00:00.000Z";
      return [first, second].map((plan, index) => {
        const text = canonicalPlanJson(plan);
        return { text, artifact: { id: `plan-${index + 1}`, type: "plan", version: index + 1, sha256: digestOf(text), producer: "test", objectKey: keyFor(index + 1), createdAt: `2026-10-08T1${index}:00:00.000Z`, format: "structured" }, now };
      });
    };
    const decision = (overrides: Record<string, unknown>) => ({ requestId: randomUUID(), workflowRevision: 2, decision: "REQUEST_CHANGES", actorId: "d".repeat(64), actorRole: "TASK_OWNER", reason: "Wait between tries.", at: "2026-10-08T10:30:00.000Z", ...overrides });

    it("shows every version, builds History from versions and decisions, and never shows raw JSON", async () => {
      const plans: ReturnType<typeof structuredPlans> = [];
      const long = `${"Too long. ".repeat(40)}end`;
      const { harness, open } = await sharedPlanTask((saved) => {
        plans.push(...structuredPlans(saved));
        return { artifacts: plans.map((plan) => plan.artifact), decisions: [
          decision({ artifactDigest: plans[0]!.artifact.sha256, reason: long }),
          decision({ artifactDigest: plans[1]!.artifact.sha256, decision: "APPROVE", actorRole: "PROJECT_ADMIN", reason: "Looks right.", at: "2026-10-08T12:30:00.000Z" }),
        ] };
      });
      for (const plan of plans) harness.s3.objects.set(plan.artifact.objectKey, plan.text);
      const owner = await open(MAYA);
      expect(owner.statusCode).toBe(200);
      expect(owner.body).not.toContain("&quot;schemaVersion&quot;");
      expect(owner.body).toContain("Retries happen after a pause.");
      expect(owner.body).toContain('id="coding-plan-v1-1"');
      expect(owner.body).toContain("<summary>Earlier versions (1)</summary>");
      expect(owner.body).toContain("This is v1. v2 is the current one.");
      expect(owner.body).toContain("Changed since v1");
      const history = owner.body.slice(owner.body.indexOf('id="history"'));
      expect(history).toContain("Coding plan v1 was written");
      expect(history).toContain("Coding plan v2 was written");
      expect(history).toContain("A project admin approved Coding plan v2");
      expect(history).toContain("Maya Chen asked for changes to Coding plan v1: Too long. Too long.");
      expect(history).not.toContain("end");
      expect(history).toContain("…");
      expect(history.indexOf("A project admin approved Coding plan v2")).toBeLessThan(history.indexOf("Maya Chen asked for changes"));
      expect(history.indexOf("Maya Chen asked for changes")).toBeLessThan(history.indexOf("Coding plan v1 was written"));
      // The approved version says so; the earlier one, changes asked for, does not.
      expect(owner.body).toMatch(/Coding plan v2 · approved/);
      expect(owner.body).not.toMatch(/thread repl/i);
      const reader = await open(TEAMMATE);
      expect(reader.body).toContain("You can read this task.");
      expect(owner.body).toContain("You're the task owner.");
    });

    it("keeps the storage rule for structured documents, and drops a version that no longer matches its digest", async () => {
      const plans: ReturnType<typeof structuredPlans> = [];
      const { harness, open } = await sharedPlanTask((saved) => {
        plans.push(...structuredPlans(saved, (version) => version === 1 ? `private/${saved.ownerKey}/${saved.workspaceId}/artifacts/plan-v1.json` : `private/${"0".repeat(64)}/other/plan-v2.json`));
        return { artifacts: plans.map((plan) => plan.artifact) };
      });
      for (const plan of plans) harness.s3.objects.set(plan.artifact.objectKey, plan.text);
      const outside = await open(MAYA);
      expect(outside.statusCode).toBe(200);
      expect(outside.body).toContain("The saved coding plan couldn't be verified, so it isn't shown.");
      expect(outside.body).not.toContain("Retries happen.");
      // An older version that changed in storage is left out; the current one still shows.
      const other = await sharedPlanTask((saved) => ({ artifacts: structuredPlans(saved).map((plan) => plan.artifact) }));
      for (const [index, plan] of structuredPlans({ ownerKey: String(other.harness.db.get(`DEVTASK#${other.id}`, "META")?.ownerKey), workspaceId: String(other.harness.db.get(`DEVTASK#${other.id}`, "META")?.workspaceId) }).entries()) {
        other.harness.s3.objects.set(plan.artifact.objectKey, index === 0 ? canonicalPlanJson(planDocument({ title: "Swapped" })) : plan.text);
      }
      const answer = await other.open(MAYA);
      expect(answer.statusCode).toBe(200);
      expect(answer.body).toContain("Retries happen after a pause.");
      expect(answer.body).not.toContain("Swapped");
      expect(answer.body).not.toContain("couldn't be verified");
      expect(answer.body).not.toContain("Earlier versions");
    });
  });
});
