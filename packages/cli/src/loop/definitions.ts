// rovara loop (#355): a loop is data. Each step has an actor (the agent, a person or the loop's own code),
// the checks that run when it is claimed done, and edges that choose the next step from an outcome.
// Phase 1 shipped the Do loop; #356 adds Quick, whose code steps (checks, publish) the daemon runs itself.
import { z } from "zod";

/** Checked when the agent claims a step done (exit-checks.ts); a failure keeps the step and says why. */
export const ExitCheckSchema = z.enum(["require-summary", "plan-sections", "plan-unchanged"]);
export type ExitCheck = z.infer<typeof ExitCheckSchema>;

/**
 * What moves a work item: the agent's claim passing its checks (done), a collaborator's reply, an approval or a
 * change request at a gate, the result of a step the loop runs itself (passed, failed, published), the issue
 * closing, a stop.
 */
export const OutcomeSchema = z.enum(["done", "reply", "approved", "changes", "passed", "failed", "published", "closed", "stopped"]);

/** What a step the loop runs itself (actor `code`) does. */
export const ActionSchema = z.enum(["checks", "publish"]);
export type LoopAction = z.infer<typeof ActionSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;

export const LoopDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z-]{0,30}$/),
  /** The keyword that starts it: `/rovara <keyword> ...`. */
  keyword: z.string().regex(/^[a-z]{2,20}$/),
  start: z.string(),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z-]{0,30}$/),
    actor: z.enum(["agent", "human", "code"]),
    /** Shown on the issue as `rovara:<label>`; a terminal step removes the label. */
    label: z.string().regex(/^[a-z][a-z-]{0,30}$/).optional(),
    /** Checked when the agent claims this step done; a failed check keeps the step and says why. */
    exit: z.array(ExitCheckSchema).default([]),
    /** For a `code` step: what the loop runs on entering it. */
    action: ActionSchema.optional(),
    /** For a `human` step that is a gate: `/rovara approve` moves it on `approved`. */
    gate: z.boolean().default(false),
    terminal: z.boolean().default(false),
  }).strict()).min(1),
  /** `from: "*"` applies from every step that is not terminal. */
  edges: z.array(z.object({ from: z.string(), to: z.string(), on: OutcomeSchema }).strict()),
}).strict().superRefine((loop, context) => {
  const ids = new Set(loop.steps.map((step) => step.id));
  if (ids.size !== loop.steps.length) context.addIssue({ code: "custom", message: "step ids must be unique" });
  if (!ids.has(loop.start)) context.addIssue({ code: "custom", message: `start step ${loop.start} is not declared` });
  for (const step of loop.steps) {
    if ((step.actor === "code" && !step.terminal) !== (step.action !== undefined)) context.addIssue({ code: "custom", message: `step ${step.id}: a code step, and only a code step, names an action` });
    if (step.gate && step.actor !== "human") context.addIssue({ code: "custom", message: `step ${step.id}: only a person's step can be a gate` });
  }
  for (const edge of loop.edges) {
    if (edge.from !== "*" && !ids.has(edge.from)) context.addIssue({ code: "custom", message: `edge from unknown step ${edge.from}` });
    if (!ids.has(edge.to)) context.addIssue({ code: "custom", message: `edge to unknown step ${edge.to}` });
  }
});
export type LoopDefinition = z.infer<typeof LoopDefinitionSchema>;
export type LoopStep = LoopDefinition["steps"][number];

/**
 * The Do loop: no gates. The agent works on the instruction, says what it did, and waits; every reply is
 * more work; closing the issue (or `/rovara stop`) ends it.
 */
export const DO_LOOP: LoopDefinition = LoopDefinitionSchema.parse({
  name: "do",
  keyword: "do",
  start: "work",
  steps: [
    { id: "work", actor: "agent", label: "working", exit: ["require-summary"] },
    { id: "waiting", actor: "human", label: "waiting" },
    { id: "ended", actor: "code", terminal: true },
  ],
  edges: [
    { from: "work", to: "waiting", on: "done" },
    { from: "waiting", to: "work", on: "reply" },
    { from: "*", to: "ended", on: "closed" },
    { from: "*", to: "ended", on: "stopped" },
  ],
});

/**
 * The Quick loop: the agent plans, a person approves the plan, the agent codes it, the loop runs the repository's
 * checks and opens a pull request. Nothing is pushed before the plan is approved and the checks pass.
 */
export const QUICK_LOOP: LoopDefinition = LoopDefinitionSchema.parse({
  name: "quick",
  keyword: "quick",
  start: "plan",
  steps: [
    { id: "plan", actor: "agent", label: "planning", exit: ["require-summary", "plan-sections"] },
    { id: "plan-review", actor: "human", label: "plan-review", gate: true },
    { id: "code", actor: "agent", label: "coding", exit: ["require-summary", "plan-unchanged"] },
    { id: "checks", actor: "code", label: "checking", action: "checks" },
    { id: "publish", actor: "code", label: "publishing", action: "publish" },
    { id: "pr-open", actor: "human", label: "pr-open" },
    { id: "ended", actor: "code", terminal: true },
  ],
  edges: [
    { from: "plan", to: "plan-review", on: "done" },
    { from: "plan-review", to: "code", on: "approved" },
    { from: "plan-review", to: "plan", on: "changes" },
    { from: "code", to: "checks", on: "done" },
    { from: "checks", to: "publish", on: "passed" },
    { from: "checks", to: "code", on: "failed" },
    { from: "publish", to: "pr-open", on: "published" },
    { from: "publish", to: "pr-open", on: "failed" },
    { from: "pr-open", to: "code", on: "reply" },
    { from: "*", to: "ended", on: "closed" },
    { from: "*", to: "ended", on: "stopped" },
  ],
});

export const LOOPS: readonly LoopDefinition[] = [DO_LOOP, QUICK_LOOP];

export function loopNamed(name: string): LoopDefinition {
  const found = LOOPS.find((loop) => loop.name === name);
  if (found === undefined) throw new Error(`unknown loop ${name}`);
  return found;
}

export function stepOf(loop: LoopDefinition, id: string): LoopStep {
  const found = loop.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`loop ${loop.name} has no step ${id}`);
  return found;
}

/** The step an outcome leads to from `from`, or undefined when the loop declares no such edge. */
export function nextStep(loop: LoopDefinition, from: string, on: Outcome): string | undefined {
  if (stepOf(loop, from).terminal) return undefined;
  return (loop.edges.find((edge) => edge.from === from && edge.on === on) ?? loop.edges.find((edge) => edge.from === "*" && edge.on === on))?.to;
}
