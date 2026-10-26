// Integration of T4 (PLANVIEW) with T5 (PLANSELFCHECK): the card, the task page, the full-plan route and the unreadable-plan card show what the plan self-check stored
// (T5's record contract): its findings and notes, the fixed "not checked" line when there is no usable record, and the direction of each check on the unchanged code.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, planQualityFinding, WORKFLOW_BLOCK_REASONS, type PlanDocument } from "@agentx/contracts";
import {
  NOT_CHECKED_SENTENCE, PlanSelfCheckRecordSchema, loadPlanSelfCheck, planSelfCheckKeyOf, readPlanSelfCheck,
} from "../../packages/broker/src/developer/plan-self-check.js";
import { NOT_TRIED_SENTENCES } from "../../packages/broker/src/developer/plan-check-tried.js";
import { planCheckSummary } from "../../packages/broker/src/developer/plan-check-summary.js";
import { structuredExtraLines, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { renderPlanDocument } from "../../packages/broker/src/aws/plan-page/render-plan.js";
import { readTaskPlanDocument } from "../../packages/broker/src/aws/task-plan-document.js";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { planDocument } from "../support/plan-documents.js";

const SHA = "a".repeat(64);
const lint = planQualityFinding({ code: "check-command-lint", checkIds: ["proposed-1"], lint: "grep-count" });
const uncovered = planQualityFinding({ code: "claim-not-covered", claimIds: ["2"] });
const waived = planQualityFinding({ code: "checks-waived", count: 1 });
const broken = planQualityFinding({ code: "check-broken-on-base", checkIds: ["proposed-1"] });

/** A coding plan whose first check is a plain grep that the planner says already passes on the unchanged code (a check written backwards), and whose second runs code. */
const backwardsPlan = (overrides: Partial<PlanDocument> = {}): PlanDocument => planDocument({
  checks: { proposed: [
    { id: "proposed-1", label: "Retry is wired", command: { cwd: "repo/demo", executable: "grep", args: ["-c", "retry", "src/pay.ts"], timeoutSeconds: 60 } },
    { id: "proposed-2", label: "Unit tests", command: { cwd: "repo/demo", executable: "npx", args: ["vitest"], timeoutSeconds: 60 } },
  ], proves: { "proposed-1": ["1"], "proposed-2": ["2"] }, expectOnBase: { "proposed-1": "pass", "proposed-2": "fail" } },
  ...overrides,
});

const record = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, status: "checked", artifactId: "plan-v1", artifactSha256: SHA, checkedAt: "2026-10-25T10:00:00.000Z", findings: [], notes: [], autoRevisions: 0, ...overrides,
});
const json = (overrides: Record<string, unknown> = {}) => JSON.stringify(record(overrides));

describe("reading the stored self-check record (T5's contract)", () => {
  it("is 'checked' with the findings' fixed sentences, the ones a person must decide on first, then the notes", () => {
    const view = readPlanSelfCheck(json({ findings: [uncovered, waived, lint], notes: [{ code: "checks-not-tried", ownerSentence: "Proposed checks were not tried on the current code." }] }), SHA);
    expect(view.checked).toBe(true);
    // checks-waived is not revisable (a person decides); the other two are.
    expect(view.sentences).toEqual([waived.ownerSentence, uncovered.ownerSentence, lint.ownerSentence, "Proposed checks were not tried on the current code."]);
  });

  it("keeps what the dry run tried per check, as fixed classes the card can say", () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-1", class: "passed" }, { checkId: "proposed-2", class: "not-checked" }, { checkId: "proposed-3", class: "broken" }] }), SHA);
    expect(view.tried).toEqual({ "proposed-1": "passed", "proposed-3": "broken" });
  });

  it("is 'checked' with nothing to say for a checked plan with no findings and no notes", () => {
    expect(readPlanSelfCheck(json(), SHA)).toEqual({ checked: true, sentences: [], tried: {}, notTried: {} });
  });

  it("reads no object, unparsable text, a record of another document and a not-checked record as 'not checked', never as 'no problems'", () => {
    const notChecked = { checked: false, sentences: [NOT_CHECKED_SENTENCE], tried: {}, notTried: {} };
    expect(NOT_CHECKED_SENTENCE).toBe("Not checked by AgentX's plan check.");
    expect(readPlanSelfCheck(undefined, SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck("", SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck("undefined", SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck("{not json", SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck(json({ artifactSha256: "b".repeat(64) }), SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck(json({ status: "not-checked", reason: "disabled" }), SHA)).toEqual(notChecked);
    // A not-checked record's findings mean nothing, even if one were present.
    expect(readPlanSelfCheck(json({ status: "not-checked", reason: "rules-failed", findings: [uncovered] }), SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck(json({ schemaVersion: 2 }), SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck(json({ extra: true }), SHA)).toEqual(notChecked);
    expect(readPlanSelfCheck(" ".repeat(70_000), SHA)).toEqual(notChecked);
  });

  it("finds the record beside the document and fails closed when it cannot be read", async () => {
    expect(planSelfCheckKeyOf("private/o/w/plan-documents/a1.json")).toBe("private/o/w/plan-documents/a1.quality.json");
    expect(planSelfCheckKeyOf("private/o/w/plan-v1.md")).toBeUndefined();
    const artifact = { objectKey: "private/o/w/plan-documents/a1.json", sha256: SHA };
    expect((await loadPlanSelfCheck(async (key) => (key.endsWith("a1.quality.json") ? json({ findings: [uncovered] }) : undefined), artifact)).sentences).toEqual([uncovered.ownerSentence]);
    expect((await loadPlanSelfCheck(async () => { throw new Error("NoSuchKey"); }, artifact)).sentences).toEqual([NOT_CHECKED_SENTENCE]);
    expect((await loadPlanSelfCheck(async () => json(), { objectKey: "private/o/w/plan-v1.md", sha256: SHA })).sentences).toEqual([NOT_CHECKED_SENTENCE]);
  });

  it("accepts the record exactly as the broker writes it, tried classes included", () => {
    expect(PlanSelfCheckRecordSchema.safeParse(record({ tried: [{ checkId: "proposed-1", class: "failed" }] })).success).toBe(true);
    expect(PlanSelfCheckRecordSchema.safeParse(record({ tried: [{ checkId: "proposed-1", class: "weird" }] })).success).toBe(false);
  });
});

describe("the direction of a check on the unchanged code", () => {
  it("says which result the planner expects before the change, so a check written backwards can be spotted", () => {
    const summary = planCheckSummary(backwardsPlan());
    expect(summary.checks[0]).toMatchObject({ expectedOnBase: "pass" });
    expect(summary.checks[0]!.line).toContain("should pass now and after the change");
    expect(summary.checks[1]!.line).toContain("should fail now and pass after the change");
    // A check with no prediction says nothing about a direction.
    expect(planCheckSummary(backwardsPlan({ checks: { ...backwardsPlan().checks!, expectOnBase: {} } })).checks[0]!.line).not.toContain("should");
  });

  it("puts the dry run's result next to the direction, and says when it was not as expected", () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-1", class: "failed" }, { checkId: "proposed-2", class: "failed" }] }), SHA);
    const summary = planCheckSummary(backwardsPlan(), { selfCheck: view });
    expect(summary.checks[0]!.line).toContain("should pass now and after the change; tried on current code: failed, not as expected");
    expect(summary.checks[1]!.line).toContain("should fail now and pass after the change; tried on current code: failed as expected");
  });

  it("shows the direction on the card and the page", async () => {
    const plan = backwardsPlan();
    const summary = planCheckSummary(plan);
    const card = structuredExtraLines({ claims: [], claimCount: 1, decisionCount: 0, tiny: false, checkLines: summary.lines, selfCheckLines: [] }, 900).join("\n");
    expect(card).toContain('Check "Retry is wired" runs grep -c retry src/pay.ts; proves claim 1; should pass now and after the change');
    const html = await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan, openWhatChanged: false });
    expect(html).toContain("should pass now and after the change");
    expect(html).toContain("should fail now and pass after the change");
  });
});

describe("DRYMSG: what the card says of a check the dry run did not try, or tried with no expectation", () => {
  const three = (expectOnBase?: Record<string, "pass" | "fail">) => backwardsPlan({
    checks: { proposed: [
      { id: "proposed-1", label: "Text is gone", command: { cwd: "repo/demo", executable: "grep", args: ["retry", "src/pay.ts"], timeoutSeconds: 60 } },
      { id: "proposed-2", label: "Exits with 1", command: { cwd: "repo/demo", executable: "node", args: ["--eval", "process.exit(1)"], timeoutSeconds: 60 } },
      { id: "proposed-3", label: "Unit tests", command: { cwd: "repo/demo", executable: "npx", args: ["vitest"], timeoutSeconds: 60 } },
    ], proves: { "proposed-1": ["1"], "proposed-2": ["1"], "proposed-3": ["2"] }, ...(expectOnBase === undefined ? {} : { expectOnBase }) },
  });

  it("keeps the checks the dry run did not try, by class, apart from the ones it tried", () => {
    const tried = [{ checkId: "proposed-1", class: "not-checked" }, { checkId: "proposed-2", class: "not-run" }, { checkId: "proposed-3", class: "failed" }];
    const view = readPlanSelfCheck(json({ tried }), SHA);
    expect(view.notTried).toEqual({ "proposed-1": "not-checked", "proposed-2": "not-run" });
    expect(view.tried).toEqual({ "proposed-3": "failed" });
    // A record that is not this document's, and one with nothing tried, give nothing.
    expect(readPlanSelfCheck(json({ tried }), "b".repeat(64)).notTried).toEqual({});
    expect(readPlanSelfCheck(json(), SHA).notTried).toEqual({});
  });

  it("names each untried check with its own fixed reason, and says nothing of one that was tried", () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-1", class: "failed" }, { checkId: "proposed-2", class: "not-checked" }, { checkId: "proposed-3", class: "not-run" }] }), SHA);
    const summary = planCheckSummary(three({ "proposed-1": "fail" }), { selfCheck: view });
    expect(summary.checks[1]!.tried).toBe("not tried on current code: it needs tools the sandbox does not run");
    expect(summary.checks[1]!.tried).toBe(NOT_TRIED_SENTENCES["not-checked"]);
    expect(summary.checks[2]!.tried).toBe("not tried on current code: it ran out of time, was cancelled, or the sandbox could not start it");
    expect(summary.checks[1]!.line).toContain('Check "Exits with 1" runs node --eval process.exit(1); proves claim 1; not tried on current code: it needs tools the sandbox does not run');
    expect(summary.checks[2]!.line).toContain("; not tried on current code: it ran out of time");
    expect(summary.checks[0]!.line).toContain("tried on current code: failed as expected");
    expect(summary.checks[0]!.line).not.toContain("not tried");
    // The card's lines carry them, so the owner can tell which check and why.
    expect(summary.lines.filter((line) => line.includes("not tried on current code"))).toHaveLength(2);
  });

  it("says nothing of a try for a check with no record entry, and a result from the caller wins over a not-tried class", () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-2", class: "not-checked" }] }), SHA);
    const summary = planCheckSummary(three(), { selfCheck: view });
    expect(summary.checks[0]).not.toHaveProperty("tried");
    expect(planCheckSummary(three(), { selfCheck: view, triedOnCurrentCode: { "proposed-2": "failed" } }).checks[1]!.tried).toBe("tried on current code: failed, no expectation given");
  });

  it("says 'no expectation given' for a tried check whose plan has no expectOnBase, and keeps 'as expected' when it has one", () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-1", class: "failed" }, { checkId: "proposed-2", class: "passed" }, { checkId: "proposed-3", class: "broken" }] }), SHA);
    const without = planCheckSummary(three(), { selfCheck: view });
    expect(without.checks[0]!.tried).toBe("tried on current code: failed, no expectation given");
    expect(without.checks[1]!.tried).toBe("tried on current code: passed, no expectation given");
    expect(without.checks[2]!.tried).toBe("tried on current code: could not run");
    const withIt = planCheckSummary(three({ "proposed-1": "fail", "proposed-2": "fail" }), { selfCheck: view });
    expect(withIt.checks[0]!.tried).toBe("tried on current code: failed as expected");
    expect(withIt.checks[1]!.tried).toBe("tried on current code: passed, not as expected");
  });

  it("builds every sentence from the class alone: text a worker could put in the record reaches no line", () => {
    // The record schema only takes the fixed classes, so a free-text class is not a record at all.
    expect(readPlanSelfCheck(json({ tried: [{ checkId: "proposed-1", class: "node: command not found /secret/path" }] }), SHA)).toEqual({ checked: false, sentences: [NOT_CHECKED_SENTENCE], tried: {}, notTried: {} });
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-2", class: "not-checked" }, { checkId: "proposed-3", class: "not-run" }] }), SHA);
    const text = JSON.stringify(planCheckSummary(three(), { selfCheck: view }).checks.map((check) => check.tried));
    expect(text).toBe(JSON.stringify([null, NOT_TRIED_SENTENCES["not-checked"], NOT_TRIED_SENTENCES["not-run"]]));
  });

  it("shows an untried check on the task page too", async () => {
    const view = readPlanSelfCheck(json({ tried: [{ checkId: "proposed-2", class: "not-checked" }] }), SHA);
    const html = await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan: three(), openWhatChanged: false, selfCheck: view });
    expect(html).toContain("not tried on current code: it needs tools the sandbox does not run");
  });
});

describe("what the self-check found, on the card", () => {
  const structured = (selfCheckLines: string[], extra: Record<string, unknown> = {}) => {
    const summary = planCheckSummary(backwardsPlan());
    return { claims: ["Payments that time out are retried."], claimCount: 2, decisionCount: 0, tiny: false, decisions: [], checkLines: summary.lines, selfCheckLines, ...extra };
  };
  const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-25T10:00:00.000Z" }),
    revision: 4, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: SHA, producer: "p", objectKey: "private/o/w/plan.json", createdAt: "2026-10-25T10:00:00.000Z" }] });
  const card = (lines: string[], extra: Record<string, unknown> = {}) => workflowMessage({ taskId: workflow.taskId, workflow, taskPageUrl: "https://agentx.example.test/review/x/task",
    documentLink: { url: "https://agentx.example.test/review/x/task?doc=coding-plan&from=1#coding-plan" }, structured: structured(lines, extra) })!;
  const visible = (text: string) => text.replace(/<[^>]*\|([^>]*)>/g, "$1");

  it("lists the findings' sentences ahead of the checks, each as a bullet", () => {
    const extras = structuredExtraLines(structured([uncovered.ownerSentence, lint.ownerSentence]), 900);
    expect(extras.indexOf(`• ${uncovered.ownerSentence}`)).toBeGreaterThanOrEqual(0);
    expect(extras.indexOf(`• ${lint.ownerSentence}`)).toBeGreaterThan(extras.indexOf(`• ${uncovered.ownerSentence}`));
    expect(extras.findIndex((line) => line.startsWith("• Check \"") || line.startsWith("• As "))).toBeGreaterThan(extras.indexOf(`• ${lint.ownerSentence}`));
  });

  it("says 'Not checked by AgentX's plan check.' when the plan was not checked", () => {
    const text = visible(card([NOT_CHECKED_SENTENCE]).text);
    expect(text).toContain(`• ${NOT_CHECKED_SENTENCE}`);
    expect(text.length).toBeLessThanOrEqual(1_200);
  });

  it("says nothing about the plan check when it ran and found nothing", () => {
    const text = visible(card([]).text);
    expect(text).not.toContain("plan check");
    expect(text).not.toContain("Not checked");
  });

  it("is never silent and never past the brief limit, however many decisions, claims and findings crowd it", () => {
    const decisions = Array.from({ length: 6 }, (_, index) => ({ id: `d${index + 1}`, question: `Question number ${index + 1} is rather long and wordy?`.padEnd(120, "x"), answer: "A fairly long option label that goes on and on" }));
    const claims = Array.from({ length: 3 }, (_, index) => `${"Claim ".repeat(30)}${index}`);
    const many = [waived, uncovered, lint, broken, planQualityFinding({ code: "check-base-mismatch", checkIds: ["proposed-2"] })].map((finding) => finding.ownerSentence);
    for (const room of [20, 60, 120, 250, 400, 700]) {
      const lines = structuredExtraLines(structured(many, { decisions, decisionCount: 6, claims }), room);
      const cost = lines.reduce((total, line) => total + line.length + 1, 0);
      // Whatever the room, the plan check is said (a short notice when no finding fits; the claims' reserve makes room for it); with room, nothing exceeds it.
      if (room >= 120) expect(cost, `room ${room}`).toBeLessThanOrEqual(room);
      expect(lines.some((line) => line.includes("AgentX's plan check") || many.some((sentence) => line.includes(sentence.slice(0, 40)))), `room ${room} names the findings`).toBe(true);
    }
    const text = visible(card(many, { decisions, decisionCount: 6, claims }).text);
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(/• The proposed check|• 1\.1|• 2 |is proved by no check|plan check/i.test(text)).toBe(true);
  });

  it("reads 'And 1 more decision', not 'decisions', for a single decision left out", () => {
    const some = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `d${index + 1}`, question: "Which?", answer: "This one" }));
    // No checks listed: three decisions are spelled out, so four leave one.
    const lines = structuredExtraLines(structured([], { decisions: some(4), decisionCount: 4, checkLines: [] }), 900);
    expect(lines).toContain("And 1 more decision on the task page.");
    expect(lines.join("\n")).not.toContain("1 more decisions");
    // Checks listed too: two decisions are spelled out, so three leave one and four leave two.
    expect(structuredExtraLines(structured([], { decisions: some(3), decisionCount: 3 }), 900)).toContain("And 1 more decision on the task page.");
    expect(structuredExtraLines(structured([], { decisions: some(4), decisionCount: 4 }), 900)).toContain("And 2 more decisions on the task page.");
  });
});

describe("what the self-check found, on the task page", () => {
  /** The page's text, with the apostrophes the escaping turns into entities read back. */
  const page = async (selfCheck: Parameters<typeof renderPlanDocument>[0]["selfCheck"], plan = backwardsPlan()) =>
    (await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan, openWhatChanged: false, ...(selfCheck === undefined ? {} : { selfCheck }) })).replaceAll("&#39;", "'");

  it("lists every finding and note under its own heading, escaped", async () => {
    const view = readPlanSelfCheck(json({ findings: [uncovered, waived], notes: [{ code: "checks-not-tried", ownerSentence: "Proposed checks were not tried on the current code." }] }), SHA);
    const html = await page(view);
    expect(html).toContain("AgentX's plan check");
    for (const sentence of [uncovered.ownerSentence, waived.ownerSentence, "Proposed checks were not tried on the current code."]) expect(html).toContain(sentence);
    expect(html.indexOf(waived.ownerSentence)).toBeLessThan(html.indexOf(uncovered.ownerSentence));
    // A sentence is escaped, not trusted.
    expect(await page({ checked: true, sentences: ["<script>alert(1)</script> found"], tried: {}, notTried: {} })).not.toContain("<script>alert(1)</script>");
  });

  it("says 'Not checked by AgentX's plan check.' for a plan that was not checked, and when the page was given no record at all", async () => {
    expect(await page(readPlanSelfCheck(undefined, SHA))).toContain(NOT_CHECKED_SENTENCE);
    expect(await page(undefined)).toContain(NOT_CHECKED_SENTENCE);
  });

  it("says that the plan check ran and found nothing, when it did", async () => {
    const html = await page(readPlanSelfCheck(json(), SHA));
    expect(html).toContain("AgentX's plan check found no problems.");
    expect(html).not.toContain(NOT_CHECKED_SENTENCE);
  });

  it("is shown for a coding plan only, not for requirements or a design", async () => {
    for (const kind of ["requirements", "design"] as const) {
      const html = await renderPlanDocument({ anchor: kind, kind, version: 1, approved: false, current: true, plan: planDocument(), openWhatChanged: false });
      expect(html).not.toContain("plan check");
    }
  });

  it("reaches the rendered task page from the loaded document view", async () => {
    const view = {
      taskId: "11111111-1111-4111-8111-111111111111", title: "Retry payments", status: "Waiting for your approval", nextStep: "Approve or request changes.", path: "QUICK", stage: "Coding plan", role: "owner",
      documents: [{ kind: "coding plan", version: 1, approved: false, current: true, format: "structured", plan: backwardsPlan(), selfCheck: readPlanSelfCheck(json({ findings: [uncovered] }), SHA) }],
      checks: [], findings: [], pullRequests: [], history: [], revision: 7,
    } as unknown as TaskDocumentView;
    const web = createTaskWeb({ authenticateSession: async () => ({ developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" }), getTaskDocumentView: async () => view });
    const answer = await web({ method: "GET", path: `/review/${view.taskId}/task`, headers: { cookie: "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111" }, requestId: "r" },
      new URL(`https://agentx.example.test/review/${view.taskId}/task`));
    expect(answer.statusCode).toBe(200);
    expect(answer.body.replaceAll("&#39;", "'")).toContain(uncovered.ownerSentence);
  });
});

describe("the loaded task page and the full-plan route read the record beside the stored document", () => {
  it("attaches the record to each coding plan version of the page, and fails closed to 'not checked' without one", async () => {
    const fixture = pageTask();
    const first = fixture.addVersion("plan", backwardsPlan());
    fixture.objects.set(first.objectKey.replace(/\.json$/u, ".quality.json"), JSON.stringify(record({ artifactId: first.id, artifactSha256: first.sha256, findings: [uncovered] })));
    const second = fixture.addVersion("plan", backwardsPlan({ title: "Second try" }));
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    const plans = view.documents.filter((document) => document.kind === "coding plan" && document.format === "structured") as Array<{ version: number; selfCheck?: { checked: boolean; sentences: string[] } }>;
    expect(plans.find((entry) => entry.version === first.version)!.selfCheck).toMatchObject({ checked: true, sentences: [uncovered.ownerSentence] });
    // The second version has no record: not checked.
    expect(second.version).toBe(2);
    expect(plans.find((entry) => entry.version === 2)!.selfCheck).toEqual({ checked: false, sentences: [NOT_CHECKED_SENTENCE], tried: {}, notTried: {} });
  });

  it("returns the same lines from the full-plan route, with the dry run's classes against the checks", async () => {
    const fixture = pageTask();
    const artifact = fixture.addVersion("plan", backwardsPlan());
    fixture.objects.set(artifact.objectKey.replace(/\.json$/u, ".quality.json"), JSON.stringify(record({
      artifactId: artifact.id, artifactSha256: artifact.sha256, findings: [uncovered], tried: [{ checkId: "proposed-1", class: "failed" }] })));
    const task = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never;
    const { summary } = await readTaskPlanDocument(task, async (key) => fixture.objects.get(key), {});
    expect(summary.selfCheckLines).toEqual([uncovered.ownerSentence]);
    expect(summary.checks[0]!.line).toContain("tried on current code: failed, not as expected");
    // A document with no record is not checked.
    fixture.objects.delete(artifact.objectKey.replace(/\.json$/u, ".quality.json"));
    expect((await readTaskPlanDocument(task, async (key) => fixture.objects.get(key), {})).summary.selfCheckLines).toEqual([NOT_CHECKED_SENTENCE]);
  });

  it("does not trust a record whose digest is another document's", async () => {
    const fixture = pageTask();
    const artifact = fixture.addVersion("plan", backwardsPlan());
    fixture.objects.set(artifact.objectKey.replace(/\.json$/u, ".quality.json"), JSON.stringify(record({ artifactSha256: "c".repeat(64), findings: [] })));
    const task = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never;
    expect((await readTaskPlanDocument(task, async (key) => fixture.objects.get(key), {})).summary.selfCheckLines).toEqual([NOT_CHECKED_SENTENCE]);
  });
});

describe("an unreadable plan, after the automatic second try", () => {
  const workflow = (revision = 4) => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-25T10:00:00.000Z" }),
    revision, stage: "PLAN", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable });
  const message = (extra: Record<string, unknown>) => workflowMessage({ taskId: "11111111-1111-4111-8111-111111111111", workflow: workflow(), ...extra })!.text;

  it("says that AgentX tried once more and failed again", () => {
    expect(message({ planUnreadableCategory: "checks-shape", planUnreadableAutoRetried: true })).toContain("the checks it proposed did not match the required format. AgentX tried once more by itself and got the same problem.");
    expect(message({ planUnreadableCategory: "checks-shape" })).not.toContain("tried once more");
    expect(message({ planUnreadableAutoRetried: true })).toContain("tried once more");
  });
});
