// rovara loop (#355, #356): the loop's decisions, with no I/O. An event and the item's state go in; the new state
// and the effects to carry out come out. The daemon supplies what needs I/O inside the events (a claim's failed
// exit checks, the plan's text and digest, a check run's output) and carries the effects out (daemon.ts), so every
// decision here is tested without GitHub, git, tmux or an agent.
import { nextStep, stepOf, type LoopAction, type LoopDefinition, type Outcome } from "./definitions.js";
import { checksFailedAssignment, codeAssignment, firstAssignment, planChangesAssignment, replyAssignment } from "./instructions.js";
import { tmuxSessionName } from "./naming.js";
import type { WorkItemState } from "./state.js";

/** The longest summary the agent may give; it is posted on the issue. */
export const SUMMARY_MAX = 4_000;
/** The most of the plan a review comment shows; GitHub takes 65,536 characters a comment. */
export const PLAN_SHOWN_MAX = 30_000;

export type LoopEvent =
  | { kind: "start"; loop: LoopDefinition; instruction: string; author: string; at: string }
  | { kind: "reply"; text: string; author: string; at: string }
  | { kind: "approve"; author: string; at: string; /** The plan's digest now, which the approval locks. */ planDigest?: string }
  | { kind: "changes"; text: string; author: string; at: string }
  /** The agent says its step is done. `failures`: the step's exit checks that failed. `plan`: the plan's text. */
  | { kind: "claim"; claimId: string; summary: string; failures: string[]; plan?: string; at: string }
  /** A step the loop ran itself finished. `detail`: what to say about it. */
  | { kind: "action-result"; action: LoopAction; outcome: "passed" | "failed" | "published"; detail: string; pullRequest?: { number: number; url: string }; at: string }
  | { kind: "closed"; at: string }
  | { kind: "stop"; author: string; at: string };

export type Effect =
  /** Set the issue's rovara:<label>, or remove it (undefined). */
  | { kind: "label"; label: string | undefined }
  /** Give the agent this, starting or resuming its session when it is not running. */
  | { kind: "assign"; text: string }
  /** A comment on the issue, from the loop. */
  | { kind: "comment"; body: string }
  | { kind: "end-session" }
  /** The answer to the agent's claim. */
  | { kind: "verdict"; claimId: string; outcome: "pass" | "block"; reason: string }
  /** Run a step of the loop's own (the daemon runs it, and answers with an action-result event). */
  | { kind: "run"; action: LoopAction }
  /** Add a reviewer's change request to the plan, so the agent and the record both have it. */
  | { kind: "record-feedback"; author: string; text: string };

export interface Decision { state: WorkItemState | undefined; effects: Effect[] }

const labelOf = (loop: LoopDefinition, step: string) => stepOf(loop, step).label;

/** Moves the item along `outcome`'s edge, with the label change and the run of a step the loop runs itself. */
function transition(loop: LoopDefinition, state: WorkItemState, outcome: Outcome, at: string): { state: WorkItemState; effects: Effect[] } | undefined {
  const to = nextStep(loop, state.step, outcome);
  if (to === undefined) return undefined;
  const effects: Effect[] = labelOf(loop, to) === labelOf(loop, state.step) ? [] : [{ kind: "label", label: labelOf(loop, to) }];
  const action = stepOf(loop, to).action;
  if (action !== undefined) effects.push({ kind: "run", action });
  return { state: { ...state, step: to, stepEnteredAt: at }, effects };
}

/** What a finished agent step says on the issue, by the step it moved to. */
function doneComment(loop: LoopDefinition, to: string, summary: string, plan: string | undefined): string {
  if (to === "plan-review") {
    const shown = plan === undefined ? "(the plan could not be read)" : plan.length > PLAN_SHOWN_MAX ? `${plan.slice(0, PLAN_SHOWN_MAX)}\n\n…(cut; the whole plan is in the worktree)` : plan;
    return `${summary}\n\n<details open><summary>The plan</summary>\n\n${shown}\n\n</details>\n\n---\nApprove it with \`/rovara approve\`, or reply with what to change.`;
  }
  if (stepOf(loop, to).action === "checks") return `${summary}\n\n---\nRunning the checks.`;
  return `${summary}\n\n---\nReply to continue, or close the issue to finish.`;
}

export function decide(loop: LoopDefinition, state: WorkItemState | undefined, event: LoopEvent, item: { repo: string; issue: number }): Decision {
  const running = state !== undefined && !stepOf(loop, state.step).terminal;
  switch (event.kind) {
    case "start": {
      if (running) {
        return { state, effects: [{ kind: "comment", body: `A loop is already running on this issue (step \`${state.step}\`). Reply to steer it, or comment \`/rovara stop\`.` }] };
      }
      const next: WorkItemState = {
        version: 1, repo: item.repo, issue: item.issue, loop: event.loop.name, step: event.loop.start, startedBy: event.author,
        instruction: event.instruction, startedAt: event.at, stepEnteredAt: event.at,
      };
      const gated = event.loop.steps.some((step) => step.gate);
      return {
        state: next,
        effects: [
          { kind: "label", label: labelOf(event.loop, event.loop.start) },
          { kind: "assign", text: firstAssignment(next, event.loop) },
          { kind: "comment", body: `Started the **${event.loop.name}** loop for @${event.author}.${gated ? " It plans first: nothing is pushed until the plan is approved and the checks pass." : ""} Reply here to steer it; close the issue or comment \`/rovara stop\` to end it. On the computer running it, \`tmux attach -t =${tmuxSessionName(item.repo, item.issue)}\` shows the agent.` },
        ],
      };
    }
    case "reply":
    case "changes": {
      if (!running) return { state, effects: [] };
      const step = stepOf(loop, state.step);
      // While the agent works, a reply or a change request is steering: it reaches the agent and the step stays.
      if (step.actor === "agent") return { state, effects: [{ kind: "assign", text: replyAssignment(event.author, event.text) }] };
      // At a gate, anything but an approval is a change request: it goes into the plan, and the plan goes back.
      if (step.gate) {
        const moved = transition(loop, state, "changes", event.at);
        if (moved === undefined) return { state, effects: [] };
        return { state: moved.state, effects: [...moved.effects, { kind: "record-feedback", author: event.author, text: event.text }, { kind: "assign", text: planChangesAssignment(event.author, event.text) }] };
      }
      const moved = transition(loop, state, "reply", event.at);
      if (moved === undefined) return { state, effects: [] };
      return { state: moved.state, effects: [...moved.effects, { kind: "assign", text: replyAssignment(event.author, event.text) }] };
    }
    case "approve": {
      if (!running || !stepOf(loop, state.step).gate) return { state, effects: running ? [{ kind: "comment", body: "Nothing is waiting for approval right now." }] : [] };
      const moved = transition(loop, state, "approved", event.at);
      if (moved === undefined) return { state, effects: [] };
      return {
        state: { ...moved.state, ...(event.planDigest === undefined ? {} : { planDigest: event.planDigest }), approvedBy: event.author },
        effects: [
          ...moved.effects,
          { kind: "comment", body: `Plan approved by @${event.author}. Coding starts; when it's done, the loop runs the checks and opens a pull request.` },
          { kind: "assign", text: codeAssignment(event.author) },
        ],
      };
    }
    case "claim": {
      const verdict = (outcome: "pass" | "block", reason: string): Effect => ({ kind: "verdict", claimId: event.claimId, outcome, reason });
      if (!running) return { state, effects: [verdict("block", "this loop has ended; there is nothing to complete")] };
      if (stepOf(loop, state.step).actor !== "agent") return { state, effects: [verdict("block", `step ${state.step} is not yours: ${stepOf(loop, state.step).actor === "human" ? "it is waiting for a person" : "the loop is running it"}`)] };
      if (event.failures.length > 0) return { state, effects: [verdict("block", event.failures.join("; "))] };
      const summary = event.summary.trim();
      const moved = transition(loop, state, "done", event.at);
      if (moved === undefined) return { state, effects: [verdict("block", `step ${state.step} has no next step`)] };
      return {
        state: { ...moved.state, summary },
        effects: [
          ...moved.effects.filter((effect) => effect.kind !== "run"),
          { kind: "comment", body: doneComment(loop, moved.state.step, summary, event.plan) },
          verdict("pass", `done: step ${state.step} is complete, and the issue was told. Stop here and wait; what comes next reaches you as a new message.`),
          // The loop's own step runs after the issue is told.
          ...moved.effects.filter((effect) => effect.kind === "run"),
        ],
      };
    }
    case "action-result": {
      if (!running || stepOf(loop, state.step).action !== event.action) return { state, effects: [] };
      const outcome: Outcome = event.outcome;
      const moved = transition(loop, state, outcome, event.at);
      if (moved === undefined) return { state, effects: [] };
      const next = event.pullRequest === undefined ? moved.state : { ...moved.state, pullRequest: event.pullRequest };
      if (event.action === "checks" && event.outcome === "failed") {
        return { state: next, effects: [...moved.effects, { kind: "comment", body: `The checks failed, so the change went back to the agent.\n\n${event.detail}` }, { kind: "assign", text: checksFailedAssignment(event.detail) }] };
      }
      if (event.action === "checks") return { state: next, effects: [{ kind: "comment", body: `The checks passed.\n\n${event.detail}` }, ...moved.effects] };
      if (event.outcome === "failed") return { state: next, effects: [...moved.effects, { kind: "comment", body: `I couldn't publish the change: ${event.detail}\n\nReply here to try again.` }] };
      return { state: next, effects: [...moved.effects, { kind: "comment", body: event.detail }] };
    }
    case "closed":
    case "stop": {
      if (!running) return { state, effects: [] };
      const moved = transition(loop, state, event.kind === "closed" ? "closed" : "stopped", event.at);
      if (moved === undefined) return { state, effects: [] };
      const said: Effect[] = event.kind === "stop" ? [{ kind: "comment", body: `Stopped by @${event.author}. The agent's session has ended; its branch \`${state.worktree?.branch ?? "(none)"}\` is kept.` }] : [];
      return { state: moved.state, effects: [...moved.effects, { kind: "end-session" }, ...said] };
    }
  }
}
