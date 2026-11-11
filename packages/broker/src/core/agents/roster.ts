// Which agent version an unattended run uses, and the recipe it is frozen with. An unattended run uses a PUBLISHED version only (a draft is never run by an event, a schedule or a chain), the agent must be
// active, a built-in the owner turned off cannot start new work, and the recipe passes the guardrails and the project's rules. What is returned is the narrowed recipe (`frozenRecipe`): never wider than the
// agent's own, the guardrails' autonomy ceiling or the project's action policy.
import { BUILTIN_AGENTS, builtinDefaultPin, isBuiltinAgentId, type AgentId, type OrgId, type ResolvedRecipe } from "@agentx/contracts";
import { coded } from "../automation/kit.js";
import { readGuardrails, validateRecipeForCompany, type ServableModels } from "./guardrails.js";
import { frozenRecipe, type ProjectRules } from "./rules.js";
import { resolveAgent, skillProblems, type AgentStore } from "./store.js";

export interface RosterDependencies {
  store: AgentStore;
  rules: ProjectRules;
  servableModels?: ServableModels | undefined;
  /** Whether this install can run the agent unattended: undefined when it can, else the reason in words (an install whose starter runs only some agents says so here, so a trigger or a chain is refused up front and not at the first event). */
  canRun?: ((agentId: AgentId) => string | undefined) | undefined;
}

const text = (error: unknown): string => (error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "it can't run");

export interface ResolvedForRun { ref: { agentId: AgentId; version: number }; recipe: ResolvedRecipe }

/** The version of `agentId` (its current one, or the one named) and its frozen recipe for a run on `project`. Throws `AGENT_UNAVAILABLE` or `NOT_FOUND` with the reason in words. */
export async function resolveAgentForAutonomousRun(deps: RosterDependencies, input: { orgId: OrgId; project: string; agentId: AgentId; version?: number | "draft" | undefined }): Promise<ResolvedForRun> {
  const { orgId, project, agentId } = input;
  if (input.version === "draft") throw coded("AGENT_UNAVAILABLE", "an unattended run uses a published version");
  const cannot = deps.canRun?.(agentId);
  if (cannot !== undefined) throw coded("AGENT_UNAVAILABLE", cannot);
  const table = deps.store.table;
  const guardrails = await readGuardrails(table, orgId);
  let version: number;
  if (isBuiltinAgentId(agentId)) {
    if (guardrails.disabledBuiltins.includes(agentId)) throw coded("AGENT_UNAVAILABLE", `${BUILTIN_AGENTS[agentId].name} is turned off. Turn it on in the guardrails first.`);
    version = input.version ?? builtinDefaultPin(agentId);
  } else {
    const record = await deps.store.get(orgId, agentId);
    if (record === undefined) throw coded("NOT_FOUND", "no agent has that ID");
    if (record.status === "archived") throw coded("AGENT_UNAVAILABLE", `${record.name} is archived, so it takes no new work`);
    const wanted = input.version ?? record.currentVersion;
    if (wanted === undefined) throw coded("AGENT_UNAVAILABLE", `${record.name} has no published version yet`);
    version = wanted;
  }
  let recipe: ResolvedRecipe;
  try {
    recipe = await resolveAgent(deps.store, orgId, agentId, version);
  } catch (error) {
    throw coded("AGENT_UNAVAILABLE", text(error));
  }
  const problems = [...await validateRecipeForCompany(table, orgId, recipe, { servableModels: deps.servableModels }), ...skillProblems(recipe)];
  if (problems.length > 0) throw coded("AGENT_UNAVAILABLE", problems.map((problem) => `${problem.path}: ${problem.message}`).join("; "));
  return { ref: { agentId, version }, recipe: await frozenRecipe(deps.rules, project, recipe, guardrails) };
}
