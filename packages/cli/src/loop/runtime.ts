// rovara loop (#355, #356, #357): the loop's decisions, with no I/O. An event and the item's state go in; the new
// state and the effects to carry out come out. The daemon supplies what needs I/O inside the events (a claim's
// failed exit checks, an artifact's text and digest, a check run's output) and carries the effects out
// (daemon.ts), so every decision here is tested without GitHub, git, tmux or an agent.
import { landingStep, nextStep, stepOf, type Artifact, type LoopAction, type LoopDefinition, type Outcome } from "./definitions.js";
import { artifactAssignment, changesAssignment, checksFailedAssignment, codeAssignment, firstAssignment, replyAssignment, reviewsFailedAssignment } from "./instructions.js";
import { artifactPath, tmuxSessionName } from "./naming.js";
import type { WorkItemState } from "./state.js";

/** The longest summary the agent may give; it is posted on the issue. */
export const SUMMARY_MAX = 4_000;
/** The most of an artifact a review comment shows; GitHub takes 65,536 characters a comment. */
export const ARTIFACT_SHOWN_MAX = 30_000;

export type LoopEvent =
  | { kind: "start"; loop: LoopDefinition; instruction: string; author: string; at: string; /** Phases declared away. */ skip?: string[] }
  | { kind: "reply"; text: string; author: string; at: string }
  | { kind: "approve"; author: string; at: string; /** The digest of the artifact the gate approves, now; the approval locks it. */ digest?: string }
  | { kind: "changes"; text: string; author: string; at: string }
  /** The agent says its step is done. `failures`: the step's exit checks that failed. `artifact`: the step's artifact's text. */
  | { kind: "claim"; claimId: string; summary: string; failures: string[]; artifact?: string; at: string }
  /** A step the loop ran itself finished. `detail`: what to say about it. */
  | { kind: "action-result"; action: LoopAction; outcome: "passed" | "failed" | "blocked" | "published"; detail: string; pullRequest?: { number: number; url: string }; at: string }
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
  /** Add a reviewer's change request to an artifact, so the agent and the record both have it. */
  | { kind: "record-feedback"; artifact: Artifact; author: string; text: string };

export interface Decision { state: WorkItemState | undefined; effects: Effect[] }

const labelOf = (loop: LoopDefinition, step: string) => stepOf(loop, step).label;
const ARTIFACT_NAMES: Record<Artifact, string> = { requirements: "requirements", design: "design", plan: "plan" };

/**
 * Moves the item along `outcome`'s edge, past any phase declared away, with the label change and the run of a step
 * the loop runs itself.
 */
function transition(loop: LoopDefinition, state: WorkItemState, outcome: Outcome, at: string): { state: WorkItemState; effects: Effect[] } | undefined {
  const edge = nextStep(loop, state.step, outcome);
  if (edge === undefined) return undefined;
  const to = landingStep(loop, edge, state.skipped ?? []);
  const effects: Effect[] = labelOf(loop, to) === labelOf(loop, state.step) ? [] : [{ kind: "label", label: labelOf(loop, to) }];
  const action = stepOf(loop, to).action;
  if (action !== undefined) effects.push({ kind: "run", action });
  return { state: { ...state, step: to, stepEnteredAt: at }, effects };
}

/** What the agent is told on arriving at an agent step after a gate. */
function arrivalAssignment(loop: LoopDefinition, state: WorkItemState, approver: string, approved: Artifact): string {
  const step = stepOf(loop, state.step);
  if (step.artifact !== undefined) return artifactAssignment(state, step.artifact, { approver, approved });
  return codeAssignment(approver, approved, state.issue);
}

/** What a finished agent step says on the issue, by the step it moved to. */
function doneComment(loop: LoopDefinition, to: string, summary: string, artifact: string | undefined): string {
  const next = stepOf(loop, to);
  if (next.gate && next.artifact !== undefined) {
    const name = ARTIFACT_NAMES[next.artifact];
    const shown = artifact === undefined ? `(the ${name} could not be read)` : artifact.length > ARTIFACT_SHOWN_MAX ? `${artifact.slice(0, ARTIFACT_SHOWN_MAX)}\n\n…(cut; the whole document is in the worktree)` : artifact;
    return `${summary}\n\n<details open><summary>The ${name}</summary>\n\n${shown}\n\n</details>\n\n---\nApprove the ${name} with \`/rovara approve\`, or reply with what to change.`;
  }
  if (next.action === "checks") return `${summary}\n\n---\nRunning the checks.`;
  return `${summary}\n\n---\nReply to continue, or close the issue to finish.`;
}

export function decide(loop: LoopDefinition, state: WorkItemState | undefined, event: LoopEvent, item: { repo: string; issue: number }): Decision {
  const running = state !== undefined && !stepOf(loop, state.step).terminal;
  switch (event.kind) {
    case "start": {
      if (running) {
        return { state, effects: [{ kind: "comment", body: `A loop is already running on this issue (step \`${state.step}\`). Reply to steer it, or comment \`/rovara stop\`.` }] };
      }
      const skipped = event.skip ?? [];
      const start = landingStep(event.loop, event.loop.start, skipped);
      const next: WorkItemState = {
        version: 1, repo: item.repo, issue: item.issue, loop: event.loop.name, step: start, startedBy: event.author,
        instruction: event.instruction, startedAt: event.at, stepEnteredAt: event.at, ...(skipped.length === 0 ? {} : { skipped }),
      };
      const gated = event.loop.steps.some((step) => step.gate);
      const skippedLine = skipped.length === 0 ? "" : ` @${event.author} declared these phases away: ${skipped.map((phase) => `**${phase}**`).join(", ")}.`;
      return {
        state: next,
        effects: [
          { kind: "label", label: labelOf(event.loop, start) },
          { kind: "assign", text: firstAssignment(next, event.loop) },
          { kind: "comment", body: `Started the **${event.loop.name}** loop for @${event.author}.${skippedLine}${gated ? " Nothing is pushed until every document is approved and the checks pass." : ""} Reply here to steer it; close the issue or comment \`/rovara stop\` to end it. On the computer running it, \`tmux attach -t =${tmuxSessionName(item.repo, item.issue)}\` shows the agent.` },
        ],
      };
    }
    case "reply":
    case "changes": {
      if (!running) return { state, effects: [] };
      const step = stepOf(loop, state.step);
      // While the agent works, a reply or a change request is steering: it reaches the agent and the step stays.
      if (step.actor === "agent") return { state, effects: [{ kind: "assign", text: replyAssignment(event.author, event.text) }] };
      // At a gate, anything but an approval is a change request: it goes into the artifact, and the artifact goes back.
      if (step.gate && step.artifact !== undefined) {
        const artifact = step.artifact;
        const moved = transition(loop, state, "changes", event.at);
        if (moved === undefined) return { state, effects: [] };
        return { state: moved.state, effects: [...moved.effects, { kind: "record-feedback", artifact, author: event.author, text: event.text }, { kind: "assign", text: changesAssignment(artifact, event.author, event.text) }] };
      }
      const moved = transition(loop, state, "reply", event.at);
      if (moved === undefined) return { state, effects: [] };
      return { state: moved.state, effects: [...moved.effects, { kind: "assign", text: replyAssignment(event.author, event.text) }] };
    }
    case "approve": {
      const step = running ? stepOf(loop, state.step) : undefined;
      // #358: a step a person can wave on without a document (reviews that still block): the approval publishes.
      if (running && step !== undefined && !step.gate && nextStep(loop, state.step, "approved") !== undefined) {
        const waved = transition(loop, state, "approved", event.at);
        if (waved === undefined) return { state, effects: [] };
        return { state: { ...waved.state, reviewRounds: 0 }, effects: [{ kind: "comment", body: `@${event.author} accepted the review findings, so the change is published as it is.` }, ...waved.effects] };
      }
      if (!running || step?.gate !== true || step.artifact === undefined) return { state, effects: running ? [{ kind: "comment", body: "Nothing is waiting for approval right now." }] : [] };
      const artifact = step.artifact;
      const moved = transition(loop, state, "approved", event.at);
      if (moved === undefined) return { state, effects: [] };
      const approvals = { ...state.approvals, ...(event.digest === undefined ? {} : { [artifact]: { digest: event.digest, by: event.author, at: event.at } }) };
      const next = { ...moved.state, approvals };
      const name = ARTIFACT_NAMES[artifact];
      const after = stepOf(loop, next.step).artifact;
      const what = after === undefined ? "Coding starts; when it's done, the loop runs the checks and the reviews, then opens a pull request." : `The ${ARTIFACT_NAMES[after]} comes next, from it.`;
      return {
        state: next,
        effects: [
          ...moved.effects,
          { kind: "comment", body: `The ${name} ${artifact === "requirements" ? "were" : "was"} approved by @${event.author}, and ${artifact === "requirements" ? "are" : "is"} locked at \`${artifactPath(item.issue, artifact)}\`. ${what}` },
          { kind: "assign", text: arrivalAssignment(loop, next, event.author, artifact) },
        ],
      };
    }
    case "claim": {
      const verdict = (outcome: "pass" | "block", reason: string): Effect => ({ kind: "verdict", claimId: event.claimId, outcome, reason });
      if (!running) return { state, effects: [verdict("block", "this loop has ended; there is nothing to complete")] };
      const step = stepOf(loop, state.step);
      if (step.actor !== "agent") return { state, effects: [verdict("block", `step ${state.step} is not yours: ${step.actor === "human" ? "it is waiting for a person" : "the loop is running it"}`)] };
      if (event.failures.length > 0) return { state, effects: [verdict("block", event.failures.join("; "))] };
      const summary = event.summary.trim();
      const moved = transition(loop, state, "done", event.at);
      if (moved === undefined) return { state, effects: [verdict("block", `step ${state.step} has no next step`)] };
      return {
        state: { ...moved.state, summary },
        effects: [
          ...moved.effects.filter((effect) => effect.kind !== "run"),
          { kind: "comment", body: doneComment(loop, moved.state.step, summary, event.artifact) },
          verdict("pass", `done: step ${state.step} is complete, and the issue was told. Stop here and wait; what comes next reaches you as a new message.`),
          // The loop's own step runs after the issue is told.
          ...moved.effects.filter((effect) => effect.kind === "run"),
        ],
      };
    }
    case "action-result": {
      if (!running || stepOf(loop, state.step).action !== event.action) return { state, effects: [] };
      const moved = transition(loop, state, event.outcome, event.at);
      if (moved === undefined) return { state, effects: [] };
      const next = event.pullRequest === undefined ? moved.state : { ...moved.state, pullRequest: event.pullRequest };
      if (event.action === "checks" && event.outcome === "failed") {
        return { state: next, effects: [...moved.effects, { kind: "comment", body: `The checks failed, so the change went back to the agent.\n\n${event.detail}` }, { kind: "assign", text: checksFailedAssignment(event.detail) }] };
      }
      if (event.action === "checks") return { state: next, effects: [{ kind: "comment", body: `The checks passed.\n\n${event.detail}` }, ...moved.effects] };
      if (event.action === "reviews") {
        if (event.outcome === "passed") return { state: { ...next, reviewRounds: 0 }, effects: [{ kind: "comment", body: `The reviews passed.\n\n${event.detail}` }, ...moved.effects] };
        const rounds = (state.reviewRounds ?? 0) + 1;
        if (event.outcome === "failed") {
          return { state: { ...next, reviewRounds: rounds }, effects: [...moved.effects, { kind: "comment", body: `The reviews found problems that block the change, so it went back to the agent (round ${rounds}).\n\n${event.detail}` }, { kind: "assign", text: reviewsFailedAssignment(event.detail, state.issue) }] };
        }
        return { state: { ...next, reviewRounds: 0 }, effects: [...moved.effects, { kind: "comment", body: `The reviews still block the change, so a person decides.\n\n${event.detail}\n\n---\nPublish it as it is with \`/rovara approve\`, or reply with what the agent should do.` }] };
      }
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
