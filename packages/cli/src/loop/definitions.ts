// rovara loop (#355, #356, #357): a loop is data. Each step has an actor (the agent, a person or the loop's own
// code), the checks that run when it is claimed done, and edges that choose the next step from an outcome. An
// agent step may produce an artifact (a requirements, design or plan document); a gate step approves one, which
// locks it. Steps grouped in a phase can be declared away together when the loop starts.
import { z } from "zod";

/** Checked when the agent claims a step done (exit-checks.ts); a failure keeps the step and says why. */
export const ExitCheckSchema = z.enum([
  "require-summary",
  /** The step's artifact exists with each of its required sections filled in. */
  "artifact-sections",
  /** Every artifact a gate approved is still as it was approved. */
  "approved-unchanged",
]);
export type ExitCheck = z.infer<typeof ExitCheckSchema>;

/** The documents a loop writes before code, in the order they derive from each other. */
export const ArtifactSchema = z.enum(["requirements", "design", "plan"]);
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * What moves a work item: the agent's claim passing its checks (done), a collaborator's reply, an approval or a
 * change request at a gate, the result of a step the loop runs itself (passed, failed, published), a phase declared
 * away (skipped), the issue closing, a stop.
 */
export const OutcomeSchema = z.enum(["done", "reply", "approved", "changes", "passed", "failed", "published", "skipped", "closed", "stopped"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** What a step the loop runs itself (actor `code`) does. */
export const ActionSchema = z.enum(["checks", "publish"]);
export type LoopAction = z.infer<typeof ActionSchema>;

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
    /** For an `agent` step: the artifact it writes. For a gate: the artifact it approves. */
    artifact: ArtifactSchema.optional(),
    /** For a `code` step: what the loop runs on entering it. */
    action: ActionSchema.optional(),
    /** For a `human` step that is a gate: `/rovara approve` moves it on `approved`, and locks its artifact. */
    gate: z.boolean().default(false),
    /** Steps that share a phase can be declared away together when the loop starts (`--skip <phase>`). */
    phase: z.string().regex(/^[a-z][a-z-]{0,30}$/).optional(),
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
    if (step.gate && step.artifact === undefined) context.addIssue({ code: "custom", message: `gate ${step.id} must name the artifact it approves` });
    if (step.exit.includes("artifact-sections") && step.artifact === undefined) context.addIssue({ code: "custom", message: `step ${step.id} checks an artifact's sections but writes none` });
    // A phase is left by its first step's `skipped` edge, so a declared skip always has somewhere to go.
    if (step.phase !== undefined && loop.steps.find((candidate) => candidate.phase === step.phase) === step
      && !loop.edges.some((edge) => edge.from === step.id && edge.on === "skipped")) {
      context.addIssue({ code: "custom", message: `phase ${step.phase} has no skipped edge from its first step ${step.id}` });
    }
  }
  for (const edge of loop.edges) {
    if (edge.from !== "*" && !ids.has(edge.from)) context.addIssue({ code: "custom", message: `edge from unknown step ${edge.from}` });
    if (!ids.has(edge.to)) context.addIssue({ code: "custom", message: `edge to unknown step ${edge.to}` });
  }
});
export type LoopDefinition = z.infer<typeof LoopDefinitionSchema>;
export type LoopStep = LoopDefinition["steps"][number];

const ENDINGS = [
  { from: "*", to: "ended", on: "closed" },
  { from: "*", to: "ended", on: "stopped" },
] as const;

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
    ...ENDINGS,
  ],
});

/** Code, the loop's checks and publishing, and the open pull request: what Quick and Full share after their plan. */
const DELIVERY_STEPS = [
  { id: "code", actor: "agent", label: "coding", exit: ["require-summary", "approved-unchanged"] },
  { id: "checks", actor: "code", label: "checking", action: "checks" },
  { id: "publish", actor: "code", label: "publishing", action: "publish" },
  { id: "pr-open", actor: "human", label: "pr-open" },
  { id: "ended", actor: "code", terminal: true },
] as const;
const DELIVERY_EDGES = [
  { from: "plan-review", to: "code", on: "approved" },
  { from: "plan-review", to: "plan", on: "changes" },
  { from: "code", to: "checks", on: "done" },
  { from: "checks", to: "publish", on: "passed" },
  { from: "checks", to: "code", on: "failed" },
  { from: "publish", to: "pr-open", on: "published" },
  { from: "publish", to: "pr-open", on: "failed" },
  { from: "pr-open", to: "code", on: "reply" },
  ...ENDINGS,
] as const;
const PLAN_STEPS = [
  { id: "plan", actor: "agent", label: "planning", artifact: "plan", exit: ["require-summary", "artifact-sections", "approved-unchanged"] },
  { id: "plan-review", actor: "human", label: "plan-review", artifact: "plan", gate: true },
] as const;

/**
 * The Quick loop: the agent plans, a person approves the plan, the agent codes it, the loop runs the repository's
 * checks and opens a pull request. Nothing is pushed before the plan is approved and the checks pass.
 */
export const QUICK_LOOP: LoopDefinition = LoopDefinitionSchema.parse({
  name: "quick",
  keyword: "quick",
  start: "plan",
  steps: [...PLAN_STEPS, ...DELIVERY_STEPS],
  edges: [{ from: "plan", to: "plan-review", on: "done" }, ...DELIVERY_EDGES],
});

/**
 * The Full loop: requirements, then a design, then a plan, each derived from the one before and each approved by a
 * person before the next is written; then Quick's delivery. The requirements and the design phases can be declared
 * away when the loop starts (`/rovara full --skip design ...`); the plan cannot.
 */
export const FULL_LOOP: LoopDefinition = LoopDefinitionSchema.parse({
  name: "full",
  keyword: "full",
  start: "requirements",
  steps: [
    { id: "requirements", actor: "agent", label: "requirements", artifact: "requirements", phase: "requirements", exit: ["require-summary", "artifact-sections"] },
    { id: "requirements-review", actor: "human", label: "requirements-review", artifact: "requirements", gate: true, phase: "requirements" },
    { id: "design", actor: "agent", label: "design", artifact: "design", phase: "design", exit: ["require-summary", "artifact-sections", "approved-unchanged"] },
    { id: "design-review", actor: "human", label: "design-review", artifact: "design", gate: true, phase: "design" },
    ...PLAN_STEPS,
    ...DELIVERY_STEPS,
  ],
  edges: [
    { from: "requirements", to: "requirements-review", on: "done" },
    { from: "requirements-review", to: "design", on: "approved" },
    { from: "requirements-review", to: "requirements", on: "changes" },
    { from: "requirements", to: "design", on: "skipped" },
    { from: "design", to: "design-review", on: "done" },
    { from: "design-review", to: "plan", on: "approved" },
    { from: "design-review", to: "design", on: "changes" },
    { from: "design", to: "plan", on: "skipped" },
    { from: "plan", to: "plan-review", on: "done" },
    ...DELIVERY_EDGES,
  ],
});

export const LOOPS: readonly LoopDefinition[] = [DO_LOOP, QUICK_LOOP, FULL_LOOP];

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

/** The phases a loop lets its starter declare away. */
export function skippablePhases(loop: LoopDefinition): string[] {
  return [...new Set(loop.steps.flatMap((step) => (step.phase === undefined ? [] : [step.phase])))];
}

/** The step an outcome leads to from `from`, or undefined when the loop declares no such edge. */
export function nextStep(loop: LoopDefinition, from: string, on: Outcome): string | undefined {
  if (stepOf(loop, from).terminal) return undefined;
  return (loop.edges.find((edge) => edge.from === from && edge.on === on) ?? loop.edges.find((edge) => edge.from === "*" && edge.on === on))?.to;
}

/** `step`, or, when its phase was declared away, the first step after every skipped phase. */
export function landingStep(loop: LoopDefinition, step: string, skipped: readonly string[]): string {
  let current = step;
  for (let hops = 0; hops < loop.steps.length; hops += 1) {
    const phase = stepOf(loop, current).phase;
    if (phase === undefined || !skipped.includes(phase)) return current;
    const next = nextStep(loop, current, "skipped");
    if (next === undefined) return current;
    current = next;
  }
  return current;
}
