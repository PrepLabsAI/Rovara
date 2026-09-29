// FR-048: agentx config's fixed, documented keys. Each maps to exactly one place: a stack parameter,
// an SSM value (the environment settings) or a control-plane setting. docs/day-two.md lists the
// same table.
import { agentXError, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";
import { AlertEmailSchema, MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import type { DeployPart } from "../deploy/parameters.js";
import type { ModelRole } from "../init/prerequisites.js";

export type { ModelRole } from "../init/prerequisites.js";

export type ConfigTarget =
  | { kind: "stack-parameter"; part: DeployPart; parameter: string }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: DeployPart; parameter: string } };

export interface ConfigKey {
  key: string;
  description: string;
  target: ConfigTarget;
  /** The template's default, shown when the stack reports no value. */
  defaultValue?: string;
  /** Model keys pass a one-token test call before anything changes (FR-049). */
  model?: ModelRole;
  /** The value to store, or CONFIG_INVALID saying what is allowed. */
  parse(value: string): string;
}

const refuse = (key: string, allowed: string): never => {
  throw agentXError("CONFIG_INVALID", `${key} must be ${allowed}; nothing changed`);
};

const wholeNumber = (key: string, min: number, max: number) => (value: string): string => {
  const trimmed = value.trim();
  if (!/^[0-9]{1,8}$/.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) return refuse(key, `a whole number from ${min} to ${max}`);
  return String(Number(trimmed));
};

const oneOf = (key: string, values: readonly string[]) => (value: string): string =>
  (values.includes(value.trim()) ? value.trim() : refuse(key, `one of ${values.join(", ")}`));

// A Bedrock model or inference-profile id, or an OpenRouter slug: no spaces, at most 200 characters.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const modelId = (key: string) => (value: string): string => (MODEL_ID.test(value.trim()) ? value.trim() : refuse(key, "a model id"));

const email = (key: string) => (value: string): string => (AlertEmailSchema.safeParse(value.trim()).success ? value.trim() : refuse(key, "an email address"));

const parameter = (part: DeployPart, name: string): ConfigTarget => ({ kind: "stack-parameter", part, parameter: name });

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "models.orchestrator", description: "the model the Slack orchestrator uses", target: parameter("slack", "ModelId"), model: "orchestrator", parse: modelId("models.orchestrator") },
  { key: "models.classifier", description: "the model the gate classifier uses", target: parameter("slack", "GateClassifierModelId"), model: "classifier", parse: modelId("models.classifier") },
  { key: "models.worker", description: "the model the coding worker uses", target: parameter("runtime", "ModelId"), model: "worker", parse: modelId("models.worker") },
  {
    key: "limits.workspacesPerMember", description: "the most workspaces one person may have open",
    target: { kind: "control-plane-setting", field: "perPerson", installDefault: { part: "control-plane", parameter: "SlackMemberWorkspaceLimit" } },
    defaultValue: "3", parse: wholeNumber("limits.workspacesPerMember", 1, 50),
  },
  {
    key: "limits.workspacesPerOrg", description: "the most workspaces the whole organization may have open",
    target: { kind: "control-plane-setting", field: "perOrganization", installDefault: { part: "control-plane", parameter: "SlackOrganizationWorkspaceLimit" } },
    defaultValue: "20", parse: wholeNumber("limits.workspacesPerOrg", 1, 1000),
  },
  { key: "limits.threadTurnsPerMinute", description: "the most requests one Slack thread may start in a minute", target: parameter("control-plane", "SlackThreadTurnsPerMinute"), defaultValue: "6", parse: wholeNumber("limits.threadTurnsPerMinute", 1, 60) },
  { key: "slack.appPostedMessages", description: "accept: answer mentions a person posts through another app; ignore: only typed mentions", target: parameter("control-plane", "SlackAppPostedMessages"), defaultValue: "accept", parse: oneOf("slack.appPostedMessages", ["accept", "ignore"]) },
  { key: "alerts.address", description: "where alarms go: an email address, or a PagerDuty or Opsgenie address (kept secret)", target: { kind: "settings", field: "alertAddress" }, parse: email("alerts.address") },
  { key: "alerts.slowTurnMinutes", description: "a turn slower than this many minutes raises the SlowTurns alarm", target: parameter("slack", "SlowTurnMinutes"), defaultValue: "5", parse: wholeNumber("alerts.slowTurnMinutes", 1, 60) },
  { key: "budget.monthlyUsd", description: "the monthly AWS budget in whole US dollars; 0 for none", target: parameter("control-plane", "BudgetMonthlyUsd"), defaultValue: "0", parse: wholeNumber("budget.monthlyUsd", 0, MAX_BUDGET_USD) },
  { key: "budget.scope", description: "tag: costs tagged agentx:env for this environment; account: the whole account", target: parameter("control-plane", "BudgetScope"), defaultValue: "tag", parse: oneOf("budget.scope", ["tag", "account"]) },
];

export function configKey(name: string): ConfigKey {
  const found = CONFIG_KEYS.find((entry) => entry.key === name);
  if (found === undefined) throw agentXError("CONFIG_INVALID", `unknown config key ${name}; agentx config list shows every key`);
  return found;
}

export function whereText(target: ConfigTarget, env: string): string {
  switch (target.kind) {
    case "stack-parameter":
      return `stack parameter ${target.parameter} on ${environmentStackName(env, target.part)}`;
    case "settings":
      return `SSM ${environmentSettingsPrefix(env)}settings (${target.field})`;
    case "control-plane-setting":
      return `control-plane setting WORKSPACE_LIMITS.${target.field} (install-time default ${target.installDefault.parameter})`;
  }
}
