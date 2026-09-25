import { z } from "zod";
import { ConnectorNameSchema, connectorApprovals } from "./connectors.js";

/**
 * The orchestrator's in-house tools, which action policy rules may name. Kept equal to the
 * orchestrator's ORCHESTRATION_TOOL_NAMES by a test, as IN_HOUSE_TOOL_COUNT is.
 */
export const IN_HOUSE_TOOL_NAMES = [
  "agentx_submit_task",
  "agentx_create_pull_request",
  "agentx_task_status",
  "agentx_task_result",
  "agentx_follow_up",
  "agentx_manage_pull_request",
] as const;

/** A tool name in which `*` stands for any run of characters, such as `delete_*`. */
export const ToolPatternSchema = z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/);

/**
 * One administrator rule. With `connector`, `tool` matches that connector's own tool names
 * (`save_item`); without it, `tool` matches the names the model sees (`tracker__save_item`,
 * `agentx_create_pull_request`). `whenArguments` limits the rule to calls that set one of those
 * arguments. A rule either decides (`outcome`) or reclassifies the action (`treatAs`): a read and a
 * create run, a change goes to the classifier, a destructive action always asks.
 */
export const ActionPolicyRuleSchema = z.object({
  tool: ToolPatternSchema,
  connector: ConnectorNameSchema.optional(),
  whenArguments: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(16).optional(),
  outcome: z.enum(["allow", "ask", "deny"]).optional(),
  treatAs: z.enum(["read", "create", "change", "destructive"]).optional(),
  reason: z.string().min(1).max(200).optional(),
}).strict().refine((rule) => (rule.outcome === undefined) !== (rule.treatAs === undefined), "an action policy rule sets exactly one of outcome and treatAs");

/** A project's additions to the action gate's built-in defaults (feature 014). */
export const ActionPolicySchema = z.object({
  rules: z.array(ActionPolicyRuleSchema).min(1).max(64),
}).strict();

/** Whether a tool name matches a rule's pattern, where `*` is any run of characters. */
export function toolPatternMatches(pattern: string, name: string): boolean {
  // The pattern alphabet has no regular-expression metacharacters besides `*`.
  return new RegExp(`^${pattern.split("*").join(".*")}$`, "u").test(name);
}

type PolicyProject = Parameters<typeof connectorApprovals>[0] & { actionPolicy?: ActionPolicy | undefined };

/**
 * Registration refuses a rule that can never apply: one that names a connector the project does
 * not configure, or whose pattern matches none of the tools it could govern.
 */
export function actionPolicyProblems(project: PolicyProject): string[] {
  const connectors = connectorApprovals(project);
  const presented = [...IN_HOUSE_TOOL_NAMES, ...connectors.flatMap((connector) => connector.tools.map((tool) => `${connector.name}__${tool.name}`))];
  const problems: string[] = [];
  for (const [index, rule] of (project.actionPolicy?.rules ?? []).entries()) {
    const label = `action policy rule ${index + 1}`;
    if (rule.connector === undefined) {
      if (!presented.some((name) => toolPatternMatches(rule.tool, name))) problems.push(`${label}: ${rule.tool} matches no tool this project offers`);
      continue;
    }
    const connector = connectors.find((entry) => entry.name === rule.connector);
    if (!connector) problems.push(`${label}: connector ${rule.connector} is not configured`);
    else if (!connector.tools.some((tool) => toolPatternMatches(rule.tool, tool.name))) problems.push(`${label}: ${rule.tool} matches no approved ${rule.connector} tool`);
  }
  return problems;
}

export type ActionPolicyRule = z.infer<typeof ActionPolicyRuleSchema>;
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;
