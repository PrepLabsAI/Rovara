// Lead 4 TA12: a run stopped at a spending limit ends with the words of THAT limit (task, project month, company month, person month, company day) and what to do, never the one generic sentence for all.
import { describe, expect, it } from "vitest";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, BUDGET_LIMIT_KINDS, budgetExhaustedWords } from "@agentx/contracts";
import { ModelBudgetExhaustedError, budgetExhaustedFromMarker } from "../../packages/model-runtime/src/index.js";
import { budgetScopeOfProxyBody, budgetExhaustedMarker } from "../../packages/model-runtime/src/budget.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { SPEND_UNKNOWN_STOP_REASON, spendStopReason } from "../../packages/broker/src/core/task-flow/money-stop.js";

const WORDS = {
  task: "Stopped: this task reached its own spending limit. A project admin, or a company owner or admin, can raise it on Spending limits; then choose Continue to resume.",
  project: "Stopped: this project reached its monthly AI spending limit. A company owner or admin can raise it on Spending limits; then choose Continue to resume.",
  org: "Stopped: your company reached its monthly AI spending limit. A company owner or admin can raise it on Spending limits; then choose Continue to resume.",
  member: "Stopped: your monthly AI spending limit was reached. A company owner or admin can raise it on Spending limits; then choose Continue to resume.",
  company_day: "Stopped: your company reached today's AI spending limit. It starts again tomorrow (UTC); until then, ask whoever runs the install to raise it. Then choose Continue to resume.",
} as const;

describe("the words a spent limit ends a run with", () => {
  it("each limit has its own fixed sentence, naming the limit and what to do", () => {
    expect([...BUDGET_LIMIT_KINDS].sort()).toEqual(Object.keys(WORDS).sort());
    for (const kind of BUDGET_LIMIT_KINDS) expect(budgetExhaustedWords(kind)).toBe(WORDS[kind]);
    expect(new Set(BUDGET_LIMIT_KINDS.map((kind) => budgetExhaustedWords(kind))).size).toBe(BUDGET_LIMIT_KINDS.length);
    for (const kind of ["task", "project", "org", "member"] as const) expect(budgetExhaustedWords(kind)).toContain("Spending limits");
  });

  it("a scope no customer sets, or none, keeps the generic words", () => {
    for (const scope of ["agent", "chain", "test", "", undefined, "constructor", "__proto__"]) expect(budgetExhaustedWords(scope)).toBe(BUDGET_EXHAUSTED_FAILURE_MESSAGE);
  });

  it("the gateway's refusal ends the run with the words of the limit it names (Key=, Project=, Team=, User=)", () => {
    for (const [message, scope] of [["Budget has been exceeded! Key=task", "task"], ["Budget has been exceeded! Project=p", "project"], ["Budget has been exceeded! Team=t", "org"], ["ExceededBudget: User=u", "member"]] as const) {
      const body = JSON.stringify({ error: { type: "budget_exceeded", message } });
      expect(budgetScopeOfProxyBody(422, body)).toBe(scope);
      // The stream carries the scope as a marker; the worker's turn turns it into the run's error with that limit's words.
      const marker = budgetExhaustedMarker(scope);
      expect(budgetExhaustedFromMarker(marker)?.message).toBe(WORDS[scope]);
      expect(failedTurn({ stopReason: "error", errorMessage: marker })?.message).toBe(WORDS[scope]);
      expect(new ModelBudgetExhaustedError(scope).message).toBe(WORDS[scope]);
    }
    expect(failedTurn({ stopReason: "error", errorMessage: budgetExhaustedMarker("agent") })?.message).toBe(BUDGET_EXHAUSTED_FAILURE_MESSAGE);
  });

  it("a run stopped by its task's cap and one stopped by the company's day say which, and spend that could not be read keeps its own words", () => {
    expect(spendStopReason("task_cap")).toBe(WORDS.task);
    expect(spendStopReason("company_day_cap")).toBe(WORDS.company_day);
    expect(spendStopReason("spend_unknown")).toBe(SPEND_UNKNOWN_STOP_REASON);
  });
});
