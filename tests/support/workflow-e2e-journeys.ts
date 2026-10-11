// Shared pieces of the journey suites in tests/integration/workflow-e2e: the usual plan and edit, the broker log
// capture with the journey invariants checked after every test, and readers for what the owner saw and what the model
// was given.
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import type { WorkflowOptionalCheck } from "@agentx/contracts";
import { planAnswer, planDocument } from "./plan-documents.js";
import { visibleSlackText } from "./strict-slack.js";
import { JARGON, registerJourneyInvariants } from "./workflow-e2e-invariants.js";
import type { WorkflowE2E } from "./workflow-e2e.js";

/** A small structured coding plan with no decisions. */
export const PLAN_DOCUMENT = planDocument({
  title: "Add greet(name)",
  why: [{ text: "Users should be greeted by name.", author: "Maya" }],
  claims: [
    { id: "1", text: "Add greet to greeting.ts." },
    { id: "2", text: "Run node --version." },
  ],
  decisions: [],
});
export const PLAN = planAnswer(PLAN_DOCUMENT);
/** The coder's one edit. */
export const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];
/** A project-approved optional check, and the coding-plan form's answer that selects it. */
export const LINT: WorkflowOptionalCheck = { id: "lint", label: "Lint the change", command: { cwd: "repo/demo", executable: "node", args: ["--check", "greeting.ts"], timeoutSeconds: 30 } };
export const SELECT_LINT = { workflow_checks: { selected_options: { selected_options: [{ value: LINT.id }] } } };
export const TEAMMATE = "U0TEAMMATE1";

/**
 * Captures the broker's structured log lines (not printed) and checks every journey's invariants after each test.
 * Call once at the top of a describe; answers a reader of the captured lines.
 */
export function journeySuite(): () => string[] {
  let log: MockInstance<typeof console.log> | undefined;
  const logged = () => (log?.mock.calls ?? []).map(([line]) => String(line));
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log?.mockRestore(); });
  // Registered after the spy's afterEach, so it runs first (vitest runs afterEach hooks in reverse) and reads the lines.
  registerJourneyInvariants({ logs: logged });
  return logged;
}

/** Every text a person could read in Slack: messages, their edits, private replies, button answers and modals. */
export function everythingShown(e2e: WorkflowE2E): string[] {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "text" || key === "initial_value") && typeof entry === "string") texts.push(visibleSlackText(entry));
      else collect(entry);
    }
  };
  for (const message of [...e2e.slack.posts, ...e2e.slack.updates, ...e2e.slack.ephemerals]) {
    texts.push(visibleSlackText(message.text));
    collect(message.blocks);
  }
  for (const response of e2e.slack.responses) texts.push(response.text);
  for (const opened of e2e.slack.views) collect(opened.view);
  return texts;
}

/** Nothing shown in Slack uses a word the owner should never see. */
export function expectNoJargon(e2e: WorkflowE2E): void {
  expect(everythingShown(e2e).filter((text) => JARGON.test(text))).toEqual([]);
}

/** The thread's posts, as the owner reads them (links shown as their labels). */
export function said(e2e: WorkflowE2E): string[] {
  return e2e.slack.posts.map((post) => visibleSlackText(post.text));
}

/** Every distinct model input so far: session-opening prompts and the latest user message of every later call. */
export function modelInputs(e2e: WorkflowE2E, since: { prompts: number; turns: number } = { prompts: 0, turns: 0 }): string[] {
  return [...new Set([...e2e.prompts.slice(since.prompts), ...e2e.turns.slice(since.turns).map((turn) => turn.userText)])];
}

export function markInputs(e2e: WorkflowE2E): { prompts: number; turns: number } {
  return { prompts: e2e.prompts.length, turns: e2e.turns.length };
}

/** The workflow-mode runs the worker was given, in order (`IMPLEMENT`, `REVIEW`, or `publish`). */
export function runs(e2e: WorkflowE2E): string[] {
  return e2e.invocations.map((invocation) => (invocation.kind === "task" ? String(invocation.payload.workflowMode) : invocation.kind));
}

/** The buttons (action IDs) a message offers. */
export function actionIds(message: { blocks?: unknown[] | undefined }): string[] {
  const ids: string[] = [];
  for (const block of message.blocks ?? []) {
    for (const element of (block as { elements?: Array<{ action_id?: string }> }).elements ?? []) if (element.action_id !== undefined) ids.push(element.action_id);
  }
  return ids;
}

/** A Quick task taken to its coding plan card (PLAN_REVIEW/WAITING). */
export async function atPlanReview(e2e: WorkflowE2E, request = "quick: Add a greet(name) function"): Promise<void> {
  expect(await e2e.mention(request)).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
}

/** The owner-approved PR feedback fix reaches the coder with this line. */
export const FEEDBACK_FIX = "Implement only the owner-approved PR feedback";
/** The coder's PR feedback fix: greet trims the name. */
export const FIXED = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name.trim()}`;\n}\n" }];
/** The coder: EDITS for the task, FIXED for an approved PR feedback fix. */
export const editsOrFix = (latest: string) => (latest.includes(FEEDBACK_FIX) ? FIXED : EDITS);

/** What the thread says once a pull request (or a fix pushed to it) waits for its merge. */
export const OPENED_PR = (number: number) => `Draft pull request opened: PR #${number}. Review it and merge it on GitHub; I'll finish this task when it's merged.`;
export const PUSHED_FIX = (number: number) => `Pushed the fix to PR #${number}. Review it and merge it on GitHub; I'll finish this task when it's merged.`;
export const MERGED = "The pull request is merged. This task is complete.";

/**
 * A Quick task taken to its open draft pull request (WAIT_FOR_MERGE/WAITING): the mention, the coding plan's approval,
 * coding, checks, reviews and the publication. Answers GitHub's pull request.
 */
export async function openDraftPr(e2e: WorkflowE2E): Promise<WorkflowE2E["github"]["pullRequests"][number]> {
  await atPlanReview(e2e);
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  expect(e2e.github.pullRequests).toHaveLength(1);
  return e2e.github.pullRequests[0]!;
}
