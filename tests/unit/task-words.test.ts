// F2-A (A1): the ONE words table of Code (`packages/contracts/src/task-words.ts`): complete over the engine's stages and the status model's states, the mock's words and nothing the owner ruled out ("Failed" and "Blocked" are never
// a task's state; there is no "retrying" pill), no raw code in a word, no two pills with the same words, the decision moves are real action ids that leave out merge, stop and close, one label per action id. And the status switch that moved
// out of the session summary (K4) still answers the same state key for every case it had.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_WORDS, DECISION_MOVES, NEEDS_ROLE_WORDS, PHASES, PHASE_KEYS, PILLS, PILL_KEYS, PILL_TONES, REASON_WORDS, ROLE_KEYS, ROLE_WORDS, STATUS_LINES, STEPS, STEP_STATE_KEYS, STEP_STATE_WORDS, TASK_ACTION_IDS,
  TASK_STATUS_STATES, TASK_STATUS_WORDS, WorkflowStageSchema, pillOf, roundWords, stepRetryLabel, taskStatusText,
} from "@agentx/contracts";
import { defaultTaskDisplay } from "../../packages/broker/src/core/sessions/display.js";
import type { SessionTaskFacts } from "../../packages/broker/src/core/sessions/facts.js";
import { statusOfTask } from "../../packages/broker/src/core/task-view/status.js";

const everyWord = (): string[] => [
  ...Object.values(PHASES), ...STEPS.flatMap((row) => [row.title, ...(row.quickTitle === undefined ? [] : [row.quickTitle])]), ...Object.values(STEP_STATE_WORDS),
  ...Object.values(PILLS).map((row) => row.words), ...Object.values(NEEDS_ROLE_WORDS), ...Object.values(ROLE_WORDS), ...Object.values(REASON_WORDS),
  ...Object.values(STATUS_LINES).flatMap((line) => Object.values(line)), ...Object.values(ACTION_WORDS).flatMap((row) => [row.label, row.done]),
];

describe("the phases and steps", () => {
  it("are the mock's five phases in the mock's order, and every step has a phase of them, in phase order", () => {
    expect(PHASE_KEYS.map((key) => PHASES[key])).toEqual(["Prepare", "Spec", "Build", "Verify", "Deliver"]);
    expect(new Set(STEPS.map((row) => row.key)).size).toBe(STEPS.length);
    for (const row of STEPS) expect(PHASE_KEYS, row.key).toContain(row.phase);
    const order = STEPS.map((row) => PHASE_KEYS.indexOf(row.phase));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("carry the mock's built-in step titles, and a Quick design review is the lighter one", () => {
    expect(STEPS.map((row) => row.title)).toEqual([
      "Start the sandbox", "Understand the request", "Spec layer 1: What and why", "Spec layer 2: Approach", "Design review", "Spec layer 3: Steps", "Approve the spec", "Build", "Run the tests", "Mutation spot-check", "AI product checks",
      "Browser check", "Code review", "Secret scan", "Security scan", "Approval before the pull request", "Open the pull request",
    ]);
    expect(STEPS.find((row) => row.key === "design")?.quickTitle).toBe("Design review (lighter)");
  });

  it("cover every engine stage: the stages the engine runs name a step, and the two ends are pills", () => {
    for (const stage of WorkflowStageSchema.options) {
      if (stage === "MERGED") expect(PILLS.merged.words).toBe("Merged");
      else if (stage === "CLOSED") expect(PILLS.closed.words).toBe("Closed");
      else expect(STEPS.some((row) => row.stages.includes(stage)), stage).toBe(true);
    }
    for (const row of STEPS) for (const stage of row.stages) expect(WorkflowStageSchema.options, `${row.key}: ${stage}`).toContain(stage);
  });

  it("has screen-reader words for each of the strip's seven step states", () => {
    expect(STEP_STATE_KEYS).toHaveLength(7);
    for (const key of STEP_STATE_KEYS) expect(STEP_STATE_WORDS[key].length, key).toBeGreaterThan(0);
  });
});

describe("the pills", () => {
  it("are the mock's words plus the owner's three, each with a tone and an icon, and no two share words", () => {
    expect(PILL_KEYS.map((key) => PILLS[key].words)).toEqual(["Needs you", "Needs the task owner", "Rovara is working", "Rovara is fixing it", "Waiting", "In review", "Stopped", "Merged", "Closed"]);
    expect(Object.values(NEEDS_ROLE_WORDS)).toEqual(["Needs the task owner", "Needs a project admin", "Needs a company admin"]);
    for (const key of PILL_KEYS) { expect(PILL_TONES, key).toContain(PILLS[key].tone); expect(PILLS[key].icon.length, key).toBeGreaterThan(0); }
    const words = [...PILL_KEYS.filter((key) => key !== "needs_role").map((key) => PILLS[key].words), ...Object.values(NEEDS_ROLE_WORDS)];
    expect(new Set(words).size).toBe(words.length);
  });

  it("never say Failed, Blocked or a retry, and the superseded failure-grammar words are not in the table", () => {
    const pillWords = [...PILL_KEYS.map((key) => PILLS[key].words), ...Object.values(NEEDS_ROLE_WORDS)].join(" | ");
    expect(pillWords).not.toMatch(/failed|blocked|retry|retrying/iu);
    expect(PILL_KEYS as readonly string[]).not.toContain("retrying");
    expect(everyWord().join(" | ")).not.toContain("Waiting for a machine");
    expect(everyWord().join(" | ")).not.toContain("Rovara is retrying");
  });

  it("names the one fixed set of role words, and builds the role pill from it", () => {
    expect(ROLE_KEYS.map((key) => ROLE_WORDS[key])).toEqual(["task owner", "co-owner", "project admin", "company admin"]);
    expect(pillOf("needs_role", "task_owner")).toMatchObject({ key: "needs_role", words: "Needs the task owner", tone: "attention" });
    expect(pillOf("needs_role", "company_admin").words).toBe("Needs a company admin");
    expect(pillOf("in_review")).toMatchObject({ words: "In review", tone: "ok" });
  });

  it("holds no raw code in any word (no snake case, no upper case engine name)", () => {
    for (const word of everyWord()) {
      expect(word, word).not.toMatch(/_/u);
      expect(word, word).not.toMatch(/\b[A-Z]{3,}\b/u);
      expect(word.trim(), word).toBe(word);
    }
    expect(roundWords("Rovara is fixing the failing checks", 2, 3)).toBe("Rovara is fixing the failing checks (round 2 of 3)");
  });
});

describe("the actions", () => {
  it("has one label for each action id, with the mock's where the mock has the action", () => {
    expect(Object.keys(ACTION_WORDS).sort()).toEqual([...TASK_ACTION_IDS].sort());
    const labels = TASK_ACTION_IDS.map((id) => ACTION_WORDS[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of TASK_ACTION_IDS) { expect(ACTION_WORDS[id].label.length, id).toBeGreaterThan(0); expect(ACTION_WORDS[id].label.length, id).toBeLessThanOrEqual(120); }
    expect(ACTION_WORDS["plan.approve"].label).toBe("Approve");
    expect(ACTION_WORDS["work.send-back"].label).toBe("Send back with instructions");
    expect(ACTION_WORDS["task.stop"].label).toBe("Stop here and keep the work");
    expect(ACTION_WORDS["task.close"].label).toBe("Close task");
  });

  it("makes only real moves a decision, and leaves out merge, stop, close, continue, the People moves and keeping the pull request", () => {
    for (const id of DECISION_MOVES) expect(TASK_ACTION_IDS as readonly string[], id).toContain(id);
    expect(new Set(DECISION_MOVES).size).toBe(DECISION_MOVES.length);
    for (const id of ["task.merge", "task.stop", "task.close", "task.continue", "pull-request.keep", "people.view", "people.add", "people.set-role", "people.take-ownership"]) expect(DECISION_MOVES, id).not.toContain(id);
    for (const id of ["plan.approve", "plan.request-changes", "plan.reject", "task.answer", "step.retry", "task.review", "work.send-back", "findings.resolve", "feedback.fix", "feedback.dismiss", "feedback.answer", "feedback.retry-review", "pull-request.open"]) expect(DECISION_MOVES, id).toContain(id);
  });

  it("labels a retry by the step that stopped", () => {
    expect(stepRetryLabel("IMPLEMENT")).toBe("Retry coding");
    expect(stepRetryLabel("VERIFY")).toBe("Choose checks and retry");
    expect(stepRetryLabel("REVIEW")).toBe("Retry reviews");
    expect(stepRetryLabel("PULL_REQUEST")).toBe("Open the pull request again");
    expect(stepRetryLabel("SOMETHING_ELSE")).toBe("Retry");
  });
});

describe("the status model's words (the legacy column) and the switch that moved out of the session summary", () => {
  it("keeps words for every legacy state, and the status text still reads from them", () => {
    for (const state of TASK_STATUS_STATES) expect(TASK_STATUS_WORDS[state].length, state).toBeGreaterThan(0);
    expect(taskStatusText({ state: "building" })).toBe("Building");
    expect(taskStatusText({ state: "needs_you", reason: "The plan is waiting." })).toBe("Needs you: the plan is waiting");
    expect(taskStatusText({ state: "from_a_newer_server" })).toBe("Status unavailable");
  });

  const facts = (over: Partial<SessionTaskFacts>): SessionTaskFacts => ({ companyId: "c", taskId: "t", project: "p", ownerDeveloperId: "a".repeat(64), runStatus: "RUNNING", updatedAt: "2026-11-24T10:00:00.000Z", ...over });
  const at = (stage: string, state: string, extra: Record<string, unknown> = {}): Partial<SessionTaskFacts> => ({ workflow: { stage, state, ...extra } });

  it("answers the same state key as before for every case the session summary had", () => {
    const cases: Array<[string, Partial<SessionTaskFacts>, string, { ended?: boolean; status?: "running" | "failed" }?]> = [
      ["merged", at("MERGED", "COMPLETE"), "merged"],
      ["answered", at("PLAN_REVIEW", "COMPLETE", { outcome: "ANSWERED" }), "closed"],
      ["failed prepare", { ...at("UNDERSTAND", "RUNNING"), failedPrepare: {} }, "failed"],
      ["ended failed", at("IMPLEMENT", "RUNNING"), "failed", { ended: true, status: "failed" }],
      ["ended closed", at("IMPLEMENT", "RUNNING"), "closed", { ended: true }],
      ["budget", { ...at("IMPLEMENT", "RUNNING"), budgetPaused: true }, "paused_budget"],
      ["blocked", at("REVIEW", "BLOCKED"), "needs_you"],
      ["plan waiting", at("PLAN_REVIEW", "WAITING"), "needs_you"],
      ["questions waiting", at("UNDERSTAND", "WAITING"), "needs_you"],
      ["pull request waits", at("WAIT_FOR_MERGE", "WAITING"), "ready_to_merge"],
      ["understand", at("UNDERSTAND", "RUNNING"), "understanding"],
      ["plan", at("PLAN", "RUNNING"), "planning"], ["critique", at("PLAN_CRITIQUE", "RUNNING"), "planning"], ["plan review running", at("PLAN_REVIEW", "RUNNING"), "planning"],
      ["implement", at("IMPLEMENT", "RUNNING"), "building"],
      ["verify", at("VERIFY", "RUNNING"), "checking"], ["review", at("REVIEW", "RUNNING"), "checking"], ["pull request", at("PULL_REQUEST", "RUNNING"), "checking"],
      ["no workflow", {}, "building"],
    ];
    for (const [name, over, state, input] of cases) {
      const shown = defaultTaskDisplay(facts(over), input?.status ?? "running", input?.ended === undefined ? {} : { ended: input.ended });
      expect(shown.state, name).toBe(state);
      expect(statusOfTask(facts(over), input?.status ?? "running", input?.ended === undefined ? {} : { ended: input.ended }), name).toEqual(shown);
    }
  });

  it("says its sentences from the table and tells everyone else who is waited on", () => {
    const blocked = defaultTaskDisplay(facts(at("REVIEW", "BLOCKED")), "running");
    expect(blocked).toEqual({ state: "needs_you", ...STATUS_LINES.blocked });
    expect(blocked.nextOthers).toBe("Waiting for the task owner.");
    expect(defaultTaskDisplay(facts(at("WAIT_FOR_MERGE", "WAITING")), "running").nextOthers).toBe("The pull request is in review.");
    expect(defaultTaskDisplay(facts({ ...at("IMPLEMENT", "RUNNING"), budgetPaused: true }), "running")).toMatchObject({ reason: "it reached its spending limit" });
  });

  it("says only that the checks follow once the pull request is open (a fix round), and keeps the first-round words before it", () => {
    expect(defaultTaskDisplay(facts(at("IMPLEMENT", "RUNNING")), "running")).toEqual({ state: "building", ...STATUS_LINES.building });
    expect(defaultTaskDisplay(facts(at("IMPLEMENT", "RUNNING", { pullRequests: [] })), "running").next).toBe("Checks and a pull request follow.");
    const afterPullRequest = defaultTaskDisplay(facts(at("IMPLEMENT", "RUNNING", { pullRequests: [{ number: 1 }] })), "running");
    expect(afterPullRequest).toEqual({ state: "building", ...STATUS_LINES.buildingAfterPullRequest });
    expect(afterPullRequest.next).toBe("Checks follow.");
  });
});

describe("the file", () => {
  it("imports nothing from the engine (types only), so a browser-safe surface can read it", () => {
    const source = readFileSync(join(import.meta.dirname, "../../packages/contracts/src/task-words.ts"), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    for (const line of imports) expect(line).toMatch(/^import type /u);
  });
});
