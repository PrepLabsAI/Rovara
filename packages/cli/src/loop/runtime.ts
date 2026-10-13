// rovara loop (#355): the loop's decisions, with no I/O. An event and the item's state go in; the new state
// and the effects to carry out come out. The daemon carries them out (daemon.ts), so every decision here
// is tested without GitHub, git, tmux or an agent.
import { nextStep, stepOf, type LoopDefinition, type Outcome } from "./definitions.js";
import { firstAssignment, replyAssignment } from "./instructions.js";
import { tmuxSessionName } from "./naming.js";
import type { WorkItemState } from "./state.js";

/** The longest summary the agent may give; it is posted on the issue. */
export const SUMMARY_MAX = 4_000;

export type LoopEvent =
  | { kind: "start"; loop: LoopDefinition; instruction: string; author: string; at: string }
  | { kind: "reply"; text: string; author: string; at: string }
  | { kind: "claim"; claimId: string; summary: string; at: string }
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
  | { kind: "verdict"; claimId: string; outcome: "pass" | "block"; reason: string };

export interface Decision { state: WorkItemState | undefined; effects: Effect[] }

const labelOf = (loop: LoopDefinition, step: string) => stepOf(loop, step).label;

/** Moves the item along `outcome`'s edge, with the label change; undefined when the loop has no such edge. */
function transition(loop: LoopDefinition, state: WorkItemState, outcome: Outcome, at: string): { state: WorkItemState; effects: Effect[] } | undefined {
  const to = nextStep(loop, state.step, outcome);
  if (to === undefined) return undefined;
  const effects: Effect[] = labelOf(loop, to) === labelOf(loop, state.step) ? [] : [{ kind: "label", label: labelOf(loop, to) }];
  return { state: { ...state, step: to, stepEnteredAt: at }, effects };
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
      return {
        state: next,
        effects: [
          { kind: "label", label: labelOf(event.loop, event.loop.start) },
          { kind: "assign", text: firstAssignment(next) },
          { kind: "comment", body: `Started the **${event.loop.name}** loop for @${event.author}. Reply here to steer it; close the issue or comment \`/rovara stop\` to end it. On the computer running it, \`tmux attach -t =${tmuxSessionName(item.repo, item.issue)}\` shows the agent.` },
        ],
      };
    }
    case "reply": {
      if (!running) return { state, effects: [] };
      const assign: Effect = { kind: "assign", text: replyAssignment(event.author, event.text) };
      // While the agent works, a reply is steering: it reaches the agent and the step stays.
      if (stepOf(loop, state.step).actor === "agent") return { state, effects: [assign] };
      const moved = transition(loop, state, "reply", event.at);
      if (moved === undefined) return { state, effects: [] };
      return { state: moved.state, effects: [...moved.effects, assign] };
    }
    case "claim": {
      const verdict = (outcome: "pass" | "block", reason: string): Effect => ({ kind: "verdict", claimId: event.claimId, outcome, reason });
      if (!running) return { state, effects: [verdict("block", "this loop has ended; there is nothing to complete")] };
      const step = stepOf(loop, state.step);
      if (step.actor !== "agent") return { state, effects: [verdict("block", `step ${state.step} is waiting for a person, not for you`)] };
      const summary = event.summary.trim();
      for (const check of step.exit) {
        if (check === "require-summary" && summary === "") return { state, effects: [verdict("block", "give a summary of what you did; it is posted on the issue")] };
        if (check === "require-summary" && summary.length > SUMMARY_MAX) return { state, effects: [verdict("block", `the summary is longer than ${SUMMARY_MAX} characters; shorten it`)] };
      }
      const moved = transition(loop, state, "done", event.at);
      if (moved === undefined) return { state, effects: [verdict("block", `step ${state.step} has no next step`)] };
      return {
        state: { ...moved.state, summary },
        effects: [
          ...moved.effects,
          { kind: "comment", body: `${summary}\n\n---\nReply to continue, or close the issue to finish.` },
          verdict("pass", `done: step ${state.step} is complete, and the issue was told. Stop here and wait; a reply will come to you as a new message.`),
        ],
      };
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
