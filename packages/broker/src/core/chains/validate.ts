// Chain validation. `chainGraphProblems` checks the shape of the graph (where edges lead, what can run, what can finish, loops without a bound) and is pure. `validateChainForPublish` adds what needs the
// install: each agent step is pinned to a published version, the recipe of that version passes the guardrails, and no coding agent has to choose a branch. `autonomousTriggerProblems` is what an event or
// schedule trigger needs of a published chain on top of that (a run limit, and a gate the owner can decide).
import {
  AgentXError, agentXError, builtinDefaultPin, isBuiltinAgentId, recipeRunner,
  type ChainDefinition, type ChainStep, type ChainStepId, type OrgId, type PinnedChainDefinition, type ResolvedRecipe, type StepTarget,
} from "@agentx/contracts";
import { readGuardrailsWithRevision, validateRecipeForCompany } from "../agents/guardrails.js";
import { skillProblems, resolveAgent } from "../agents/store.js";
import type { RosterDependencies } from "../agents/roster.js";

/** One thing wrong with a chain: where (`steps.2.next.to`) and what (`no step is called x`). `formatChainProblem` joins them as one line. */
export interface ChainProblem {
  path: string;
  message: string;
}

export function formatChainProblem(problem: ChainProblem): string {
  return `${problem.path}: ${problem.message}`;
}

type DraftStep = ChainDefinition["steps"][number];

// ---- the graph

interface Edge {
  /** Where the edge is written, for a problem: `steps.1.next`, `steps.1.next.choices.0`, `steps.2.onApprove`. */
  path: string;
  to: StepTarget;
  bounded: boolean;
}

/** Every edge a step can send the run along; a step that ends the run has none, but see `endsRun`. */
function edgesOf(step: DraftStep | ChainStep, index: number): Edge[] {
  const at = `steps.${String(index)}`;
  if (step.kind === "gate") {
    return [
      { path: `${at}.onApprove`, to: step.onApprove.to, bounded: step.onApprove.maxTraversals !== undefined },
      { path: `${at}.onReject`, to: step.onReject.to, bounded: step.onReject.maxTraversals !== undefined },
    ];
  }
  const next = step.next;
  if (next.kind === "go") return [{ path: `${at}.next`, to: next.to, bounded: next.maxTraversals !== undefined }];
  if (next.kind === "branch") {
    return next.choices.map((choice, choiceIndex) => ({ path: `${at}.next.choices.${String(choiceIndex)}`, to: choice.to, bounded: choice.maxTraversals !== undefined }));
  }
  return [];
}

/**
 * What is wrong with the shape of a design: a start or an edge that names no step, a branch default that is not a choice (or a choice id used twice),
 * a step no path from the start reaches, a design no path of which reaches the end, and a loop with no `maxTraversals` on any edge of it.
 * Pure: it reads only the design.
 */
export function chainGraphProblems(def: ChainDefinition): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const indexOf = new Map<ChainStepId, number>();
  def.steps.forEach((step, index) => {
    if (!indexOf.has(step.id)) indexOf.set(step.id, index);
  });
  const startKnown = indexOf.has(def.start);
  if (!startKnown) problems.push({ path: "start", message: `no step is called ${def.start}` });

  const edges = def.steps.map((step, index) => edgesOf(step, index));
  def.steps.forEach((step, index) => {
    for (const edge of edges[index]!) {
      if (edge.to !== "$end" && !indexOf.has(edge.to)) problems.push({ path: `${edge.path}.to`, message: `no step is called ${edge.to}` });
    }
    if (step.kind === "agent" && step.next.kind === "branch") {
      const next = step.next;
      const seen = new Set<string>();
      next.choices.forEach((choice, choiceIndex) => {
        if (seen.has(choice.id)) problems.push({ path: `steps.${String(index)}.next.choices.${String(choiceIndex)}.id`, message: `${choice.id} is used by more than one choice` });
        seen.add(choice.id);
      });
      if (next.default !== undefined && !next.choices.some((choice) => choice.id === next.default)) {
        problems.push({ path: `steps.${String(index)}.next.default`, message: "not one of this branch's choices" });
      }
    }
  });

  if (startKnown) problems.push(...reachabilityProblems(def, indexOf, edges));
  const looping = stepOnUnboundedLoop(def, indexOf, edges);
  if (looping !== undefined) {
    problems.push({ path: `steps.${String(looping)}`, message: `${def.steps[looping]!.id} is in a loop with no limit; set maxTraversals on the edge that goes back` });
  }
  return problems;
}

/** Steps no path from the start reaches, and whether any path from the start reaches `$end`. */
function reachabilityProblems(def: ChainDefinition, indexOf: Map<ChainStepId, number>, edges: Edge[][]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const reached = new Set<number>();
  const queue = [indexOf.get(def.start)!];
  let finishes = false;
  while (queue.length > 0) {
    const index = queue.pop()!;
    if (reached.has(index)) continue;
    reached.add(index);
    const step = def.steps[index]!;
    if (step.kind === "agent" && step.next.kind === "end") finishes = true;
    for (const edge of edges[index]!) {
      if (edge.to === "$end") finishes = true;
      else if (indexOf.has(edge.to)) queue.push(indexOf.get(edge.to)!);
    }
  }
  def.steps.forEach((step, index) => {
    if (!reached.has(index)) problems.push({ path: `steps.${String(index)}`, message: `${step.id} can never run` });
  });
  if (!finishes) problems.push({ path: "start", message: "this chain can never finish" });
  return problems;
}

/**
 * The index of the first step on a loop that no `maxTraversals` limits, or undefined. Edges with a bound are left out; a step is on a loop of what is
 * left when it can reach itself. (Kahn's algorithm would also list steps that are only downstream of a loop, so the walk below is what names one.)
 */
function stepOnUnboundedLoop(def: ChainDefinition, indexOf: Map<ChainStepId, number>, edges: Edge[][]): number | undefined {
  const out: number[][] = def.steps.map((_step, index) =>
    edges[index]!.flatMap((edge) => (edge.bounded || edge.to === "$end" || !indexOf.has(edge.to) ? [] : [indexOf.get(edge.to)!])),
  );
  for (let index = 0; index < def.steps.length; index += 1) {
    if (reaches(out, index, index)) return index;
  }
  return undefined;
}

/** Whether `to` can be reached from `from` along at least one edge. */
function reaches(out: number[][], from: number, to: number): boolean {
  const seen = new Set<number>();
  const stack = [...out[from]!];
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (index === to) return true;
    if (seen.has(index)) continue;
    seen.add(index);
    stack.push(...out[index]!);
  }
  return false;
}

// ---- publishing

type PinnedStep = PinnedChainDefinition["steps"][number];

const UNKNOWN_AGENT = "unknown agent";

/** An AgentXError's text without the code in front of it. */
function plainMessage(error: AgentXError): string {
  return error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;
}

interface StepPin {
  /** The version the step runs, absent when the agent could not be pinned. */
  version?: number;
  problems: ChainProblem[];
}

/** The recipe of a pinned agent version, and what the guardrails say of it. */
async function recipeOfVersion(deps: RosterDependencies, orgId: OrgId, agentId: string, version: number, at: string): Promise<{ recipe?: ResolvedRecipe; problems: ChainProblem[] }> {
  let recipe: ResolvedRecipe;
  try {
    recipe = await resolveAgent(deps.store, orgId, agentId, version);
  } catch (error) {
    if (error instanceof AgentXError) return { problems: [{ path: at, message: plainMessage(error) }] };
    throw error;
  }
  const found = [...await validateRecipeForCompany(deps.store.table, orgId, recipe, { servableModels: deps.servableModels }), ...skillProblems(recipe)];
  return { recipe, problems: found.map((problem) => ({ path: `${at}.${problem.path}`, message: problem.message })) };
}

/** Pins one agent step: a built-in to the release this install ships (or the one named), a custom agent to its current version (or the one named); the recipe that version resolves to must pass the guardrails; and a coding agent cannot be followed by a branch, because it has no way to say which. */
async function pinAgentStep(deps: RosterDependencies, orgId: OrgId, step: Extract<ChainDefinition["steps"][number], { kind: "agent" }>, index: number, disabledBuiltins: readonly string[]): Promise<StepPin> {
  const at = `steps.${String(index)}.agent`;
  const { agentId } = step.agent;
  const problem = (path: string, message: string): StepPin => ({ problems: [{ path, message }] });
  const wanted = step.agent.version;
  let version: number;
  if (isBuiltinAgentId(agentId)) {
    if (disabledBuiltins.includes(agentId)) return problem(at, `${agentId} is turned off. Turn it on in the guardrails first.`);
    version = wanted === "current" ? builtinDefaultPin(agentId) : wanted;
  } else {
    const record = await deps.store.get(orgId, agentId);
    if (record === undefined) return problem(at, UNKNOWN_AGENT);
    if (record.status === "archived") return problem(at, `${record.name} is archived`);
    if (wanted === "current") {
      if (record.currentVersion === undefined) return problem(at, `${record.name} has no published version`);
      version = record.currentVersion;
    } else {
      version = wanted;
      if (await deps.store.getVersion(orgId, agentId, version) === undefined) return problem(`${at}.version`, `${record.name} has no version ${String(version)}`);
    }
  }
  const { recipe, problems } = await recipeOfVersion(deps, orgId, agentId, version, at);
  if (recipe === undefined) return { problems };
  if (step.next.kind === "branch" && recipeRunner(recipe) === "coding") problems.push({ path: `steps.${String(index)}.next`, message: "a coding agent can't choose a branch; add a step after it to decide" });
  return { version, problems };
}

/**
 * Checks a design for publishing and pins it: the graph problems, then for each agent step the problems above. `pinned` has every agent version a number. If `problems` is not empty, a step that could not be
 * pinned keeps the version the person wrote, so `pinned` does not parse as a published chain: the caller must publish only when `problems` is empty. `guardrailsRevision` is the revision of the guardrails this was
 * checked against, for the store's publish. It reads and writes nothing.
 */
export async function validateChainForPublish(deps: RosterDependencies, orgId: OrgId, def: ChainDefinition): Promise<{ pinned: PinnedChainDefinition; problems: ChainProblem[]; guardrailsRevision: number }> {
  const guardrails = await readGuardrailsWithRevision(deps.store.table, orgId);
  const problems = chainGraphProblems(def);
  const steps: unknown[] = [];
  for (const [index, step] of def.steps.entries()) {
    if (step.kind !== "agent") { steps.push(step); continue; }
    const pin = await pinAgentStep(deps, orgId, step, index, guardrails.guardrails.disabledBuiltins);
    problems.push(...pin.problems);
    steps.push(pin.version === undefined ? step : { ...step, agent: { ...step.agent, version: pin.version } });
  }
  if (problems.length === 0 && def.steps.length === 0) throw agentXError("CONFIG_INVALID", "a chain needs a step");
  return { pinned: { ...def, steps: steps as PinnedStep[] }, problems, guardrailsRevision: guardrails.revision };
}

// ---- event and schedule triggers

const RUN_LIMIT_MESSAGE = "set a limit on one run before adding an event or schedule trigger";
const APPROVERS_MESSAGE = "no one starts an event or schedule run, so a gate must name the owner (or named people) to decide it";

/** What a chain needs to be started by an event or a schedule: a limit on one run (nobody is watching the spend), and no gate only the starter can decide (an event or a schedule has no person to be the starter). */
export function autonomousTriggerProblems(chain: { pinned: PinnedChainDefinition }): ChainProblem[] {
  const problems: ChainProblem[] = [];
  if (chain.pinned.limits?.maxRunUsd === undefined) problems.push({ path: "limits.maxRunUsd", message: RUN_LIMIT_MESSAGE });
  chain.pinned.steps.forEach((step, index) => {
    if (step.kind === "gate" && step.approvers.every((rule) => rule.kind === "starter")) problems.push({ path: `steps.${String(index)}.approvers`, message: APPROVERS_MESSAGE });
  });
  return problems;
}
