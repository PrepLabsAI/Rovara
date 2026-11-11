// What a custom agent may do is what its project's rules already allow, and never more. The recipe an agent version holds is checked here against the project it runs on, and what runs is the NARROWER of the two:
//   - an `agent` step can use only the read-only workspace tools (the recipe contract's own limit, `STEP_TOOLS`), and none when it has no workspace. (A coding recipe's `build` step has the tools Rovara Code's own has:
//     a custom agent is not read-only, it is only never given more than its kind of step gets;)
//   - a connector tool the project's action policy denies cannot be granted (a refusal, not a silent skip), and a tool the policy says to ask about is added to the agent's always-ask list: a policy only ever adds;
//   - a grant that writes (`read_write`) is refused unless the host says it can serve writes behind an approval (`allowConnectorWrites`); this install has no tool bridge yet, so it says no;
//   - the agent's autonomy is held to the guardrails' ceiling;
//   - the sandbox's network is the project's `network.allowedDomains` and nothing in a recipe names a host, so a recipe cannot widen it. `frozenRecipe` returns a recipe that never has more than it was given.
import { ActionPolicySchema, agentXError, toolPatternMatches, type ActionPolicy, type AgentGuardrails, type ProjectDefinition, type RecipeProblem, type ResolvedRecipe } from "@agentx/contracts";

/** What the host knows of the project a run is on. */
export interface ProjectRules {
  /** The project's registered definition, or undefined when the project is not registered. */
  definition(project: string): Promise<Pick<ProjectDefinition, "actionPolicy"> & { archived?: boolean } | undefined>;
  /** Whether connector writes can be served (behind a person's approval). Absent or false: a `read_write` grant is refused. */
  allowConnectorWrites?: boolean;
}

const AUTONOMY = ["suggest", "prepare", "run"] as const;
const lower = <T extends (typeof AUTONOMY)[number]>(a: T, b: T): T => (AUTONOMY.indexOf(a) <= AUTONOMY.indexOf(b) ? a : b);

/** Whether a grant's tool pattern could name a tool the rule's pattern names (either matches the other: a pattern with a star may cover it). */
const overlaps = (grantPattern: string, rulePattern: string): boolean => toolPatternMatches(grantPattern, rulePattern) || toolPatternMatches(rulePattern, grantPattern) || grantPattern === rulePattern;

function policyOf(definition: { actionPolicy?: unknown } | undefined): ActionPolicy | undefined {
  if (definition?.actionPolicy === undefined) return undefined;
  const parsed = ActionPolicySchema.safeParse(definition.actionPolicy);
  // A policy that cannot be read is not "no policy": the caller refuses the run.
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "this project's action policy can't be read, so an agent can't run on it");
  return parsed.data;
}

/** What is wrong with a recipe on this project: grants the project denies or cannot serve. Empty when the recipe may run there. */
export async function projectRuleProblems(rules: ProjectRules, project: string, recipe: ResolvedRecipe): Promise<RecipeProblem[]> {
  const found = await rules.definition(project);
  if (found === undefined) return [{ path: "project", message: `${project} is not a project on this install` }];
  if (found.archived === true) return [{ path: "project", message: `${project} is archived, so it takes no new work` }];
  const problems: RecipeProblem[] = [];
  const policy = policyOf(found);
  recipe.tools.forEach((grant, index) => {
    const at = `tools.${String(index)}`;
    if (grant.access === "read_write" && rules.allowConnectorWrites !== true) problems.push({ path: `${at}.access`, message: "a tool that writes needs a person's approval for each change, which this install can't ask for yet; grant read access" });
    const connectorName = "name" in grant.connector ? grant.connector.name : undefined;
    for (const rule of policy?.rules ?? []) {
      if (rule.outcome !== "deny") continue;
      if (rule.connector !== undefined && connectorName !== undefined && rule.connector !== connectorName) continue;
      const patterns = grant.tools ?? ["*"];
      if (patterns.some((pattern) => overlaps(pattern, rule.tool))) problems.push({ path: `${at}.tools`, message: `the project's action policy denies ${rule.tool}${rule.reason === undefined ? "" : ` (${rule.reason})`}; take it out of the agent's tools` });
    }
  });
  return problems;
}

/**
 * The recipe a run is frozen with: the agent's own, narrowed by the project's rules and the guardrails. Only ever narrows: autonomy is lowered to the ceiling, the project's `ask` tools are added to
 * the agent's always-ask list, and nothing else is changed or added. Throws when the recipe may not run on the project at all (`projectRuleProblems`).
 */
export async function frozenRecipe(rules: ProjectRules, project: string, recipe: ResolvedRecipe, guardrails: Pick<AgentGuardrails, "maxAutonomy">): Promise<ResolvedRecipe> {
  const problems = await projectRuleProblems(rules, project, recipe);
  if (problems.length > 0) throw agentXError("AGENT_UNAVAILABLE", `this agent can't run on ${project}: ${problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ")}`);
  const policy = policyOf(await rules.definition(project));
  const asks = (policy?.rules ?? []).filter((rule) => rule.outcome === "ask").map((rule) => rule.tool);
  const alwaysAsk = [...new Set([...recipe.approvals.alwaysAsk, ...asks])].slice(0, 32);
  return { ...recipe, autonomy: lower(recipe.autonomy, guardrails.maxAutonomy), approvals: { alwaysAsk } };
}
