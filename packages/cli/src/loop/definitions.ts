// rovara loop (#355): a loop is data. Each step has an actor (the agent, a person or the loop's own code),
// the checks that run when it is claimed done, and edges that choose the next step from an outcome.
// Phase 1 ships the Do loop; Quick and Full (#356, #357) are more definitions on the same runtime.
import { z } from "zod";

export const ExitCheckSchema = z.enum(["require-summary"]);
export type ExitCheck = z.infer<typeof ExitCheckSchema>;

/** What moves a work item: the agent's claim passing its checks, a collaborator's reply, the issue closing, a stop. */
export const OutcomeSchema = z.enum(["done", "reply", "closed", "stopped"]);
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
    terminal: z.boolean().default(false),
  }).strict()).min(1),
  /** `from: "*"` applies from every step that is not terminal. */
  edges: z.array(z.object({ from: z.string(), to: z.string(), on: OutcomeSchema }).strict()),
}).strict().superRefine((loop, context) => {
  const ids = new Set(loop.steps.map((step) => step.id));
  if (ids.size !== loop.steps.length) context.addIssue({ code: "custom", message: "step ids must be unique" });
  if (!ids.has(loop.start)) context.addIssue({ code: "custom", message: `start step ${loop.start} is not declared` });
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

export const LOOPS: readonly LoopDefinition[] = [DO_LOOP];

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
