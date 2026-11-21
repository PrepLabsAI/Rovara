// FR-048: agentx config's fixed, documented keys. Each maps to exactly one place: a stack parameter,
// an SSM value (the environment settings) or a control-plane setting. docs/day-two.md lists the
// same table.
import { CHATGPT_DEFAULT_PREFERRED_MODEL, CORE_AGENT_MODEL_CHOICE_DEFAULT, CORE_AGENT_MODEL_CHOICE_PARAMETER, CORE_AGENT_MODEL_CHOICE_VALUES, CORE_AGENT_MODEL_MAX_LENGTH, CORE_AGENT_MODEL_PARAMETER, CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_PARAMETER, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_PARAMETER, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PARAMETER, CORE_MODEL_GATEWAY_HOST_PATTERN, ChatGptModelIdSchema, MODEL_FALLBACK_NONE, isClaudeAgentModel, isCoreAgentModelId, isCoreAnswersModelId, isCoreLearningModelId, MODEL_FALLBACK_PATTERN, agentXError, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";
import { catalogModel } from "@agentx/model-runtime/catalog";
import { AlertEmailSchema, MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import type { DeployPart } from "../deploy/parameters.js";
import type { ModelRole } from "../init/prerequisites.js";

export type { ModelRole } from "../init/prerequisites.js";

export type ConfigTarget =
  /** `also`: the same value goes to these stacks' parameters too, one after the other (models.fallback: the runtime and the Slack stack both need it). */
  | { kind: "stack-parameter"; part: DeployPart; parameter: string; also?: ReadonlyArray<{ part: DeployPart; parameter: string }> }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: DeployPart; parameter: string } }
  // #343: Sign in with ChatGPT's settings, held by the control plane alone (no stack parameter).
  | { kind: "chatgpt-setting"; field: "enabled" | "preferredModel" };

export interface ConfigKey {
  key: string;
  description: string;
  target: ConfigTarget;
  /** The template's default, shown when the stack reports no value. */
  defaultValue?: string;
  /** The AI navigation model choice (Task 4.10): held to the models Rovara can use with the environment's provider and region before anything changes. It has no coding-model test call. */
  e2eAgentModel?: true;
  /** The coding roles' fallback model (Task 4.10D): `none`, or a Bedrock model of the pinned catalog that passes the one-token test call before anything changes. */
  fallbackModel?: true;
  /** The core engine's model gateway settings come as a pair (core-host/gateway-model-access.ts): the other key of the pair, named so config set can say when one is set without the other. */
  corePairedWith?: string;
  /** DEC 254g: a non-Claude value must be one the model gateway offers now, checked live through the admin sign-in before any deploy (fail closed). */
  gatewayOffered?: true;
  /** How the stored value is shown (list, get and the change line), where it is not the value the person typed: coreEngine.modelGatewayUrl stores the host and shows the origin. */
  shown?: (stored: string) => string;
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


/** Saved image role outputs required before enabling the install switch (L4-SE-OUTPUT-CONTRACT: role ARNs carry the environment path /agentx/<env>/). */
export const SAVED_ENV_REGISTRY_OUTPUTS = ["SavedEnvImgPushRoleArn", "SavedEnvImgPullRoleArn", "SavedEnvImgManageRoleArn", "SavedEnvRepoPrefix", "SavedEnvRegistryReady"] as const;

export function savedEnvRegistryReadiness(outputs: Record<string, string> | undefined, env: string, account: string): string[] {
  const missing = SAVED_ENV_REGISTRY_OUTPUTS.filter((key) => outputs?.[key] === undefined || outputs[key] === "");
  if (missing.length > 0) return [...missing];
  const expected = {
    SavedEnvImgPushRoleArn: `arn:aws:iam::${account}:role/agentx/${env}/agentx-${env}-img-push`,
    SavedEnvImgPullRoleArn: `arn:aws:iam::${account}:role/agentx/${env}/agentx-${env}-img-pull`,
    SavedEnvImgManageRoleArn: `arn:aws:iam::${account}:role/agentx/${env}/agentx-${env}-img-manage`,
    SavedEnvRepoPrefix: `rovara-env/${env}`,
    SavedEnvRegistryReady: "1",
  };
  return SAVED_ENV_REGISTRY_OUTPUTS.filter((key) => outputs?.[key] !== expected[key]);
}

const savedEnvSwitchValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "on") return "1";
  if (trimmed === "off") return "0";
  return refuse("savedEnvironments.switch", "on or off");
};


/** Empty (the default) or `none`: the core engine's model gateway is not configured, and the core refuses the switch by name. Stored as empty, the stack parameter's default. */
const CORE_GATEWAY_UNSET = new Set(["", "none"]);

/**
 * coreEngine.modelGatewayUrl: empty, or the model gateway's https origin. Checked before any deploy, as the broker reads it: https, no user name or password, no path, query or
 * fragment, and a host the stack parameter takes (lowercase DNS labels, an optional port, at most CORE_MODEL_GATEWAY_HOST_MAX_LENGTH characters). Stored as that host: the stack
 * parameter CoreModelGatewayHost holds it and the functions read `https://<host>` (a URL's slashes cannot be packed into the broker's settings). The refusal never echoes the value,
 * which could hold credentials.
 */
export const coreModelGatewayUrl = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (CORE_GATEWAY_UNSET.has(trimmed)) return "";
  const allowed = `empty (none) or the model gateway's https origin, such as https://gateway.example.com, with no user name, password, path, query or fragment and a host of at most ${CORE_MODEL_GATEWAY_HOST_MAX_LENGTH} characters`;
  let url: URL;
  try { url = new URL(trimmed); } catch { return refuse(key, allowed); }
  const lowered = trimmed.toLowerCase();
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || trimmed.includes("@")
    || (lowered !== url.origin && lowered !== `${url.origin}/`)) return refuse(key, allowed);
  if (url.host.length > CORE_MODEL_GATEWAY_HOST_MAX_LENGTH || !new RegExp(CORE_MODEL_GATEWAY_HOST_PATTERN, "u").test(url.host)) return refuse(key, allowed);
  return url.host;
};

/** What `config list` and `config get` show for coreEngine.modelGatewayUrl: the origin the functions read, from the host the stack holds. */
export const coreModelGatewayShown = (stored: string): string => (stored === "" ? "" : `https://${stored}`);

/**
 * coreEngine.agentModel (DEC 254g): empty, or ANY model the model gateway offers, named exactly as the gateway names it. This is the first, offline check: a well-formed id (contracts
 * isCoreAgentModelId: the stack pattern's lowercase letters, digits and `. _ : -`; no URL, path, credentials or separator) and, for Claude, its existing rule (an Anthropic engine name
 * this Rovara's model catalog knows; never a Bedrock `us.anthropic....` id). Whether the gateway OFFERS a non-Claude id is checked live before any deploy (`gatewayOffered`,
 * gateway-offered.ts): Code holds no list of its own. The refusal never echoes the value.
 */
export const coreAgentModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (CORE_GATEWAY_UNSET.has(trimmed)) return "";
  if (!isCoreAgentModelId(trimmed) || (isClaudeAgentModel(trimmed) && catalogModel({ provider: "anthropic", modelId: trimmed }) === undefined)) {
    return refuse(key, `empty (none), an Anthropic model id this Rovara knows, such as claude-sonnet-4-6 (not a Bedrock us.anthropic. id), or the exact id of a model the model gateway offers, such as zai.glm-5 (lowercase letters, digits and . _ : - only, at most ${CORE_AGENT_MODEL_MAX_LENGTH} characters)`);
  }
  return trimmed;
};

/**
 * coreEngine.answersModel (L4-AM, DEC 254zzn(2)): empty (the agent model answers, as before), or ONE Anthropic model id this Rovara's catalog knows (such as claude-haiku-5-5) that the hosted answers
 * and the hosted start-box classifier run on instead. Held to the agent model's Claude rule (contracts isCoreAgentModelId, then the catalog) and to a Claude engine name: the answers purpose runs on
 * the company's own Anthropic account, so a Bedrock `us.anthropic....` id or a model such as zai.glm-5 cannot be served there and is refused here, before any deploy. The refusal never echoes the value.
 */
export const coreAnswersModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (CORE_GATEWAY_UNSET.has(trimmed)) return "";
  if (!isCoreAnswersModelId(trimmed) || catalogModel({ provider: "anthropic", modelId: trimmed }) === undefined) {
    return refuse(key, `empty (none: answers use the agent model) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: the answers run on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_ANSWERS_MODEL_MAX_LENGTH} characters)`);
  }
  return trimmed;
};

/**
 * coreEngine.learningModel (DEC 254zzz58/63): the INSTALL default; empty (Claude Haiku 5.5, claude-haiku-5-5), or ONE Anthropic model id this Rovara's catalog knows (such as claude-haiku-5-5) that
 * the hosted lessons' learning calls run on, separate from the agent model. A company may choose its own (its AI settings), which wins for it. A Claude engine name only: the learning route used runs on the company's own Anthropic account, so a Bedrock
 * `us.anthropic....` id or a model such as zai.glm-5 is refused here, before any deploy. The catalog must know it (the per-call cap is priced from it). The refusal never echoes the value.
 */
export const coreLearningModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (CORE_GATEWAY_UNSET.has(trimmed)) return "";
  if (!isCoreLearningModelId(trimmed) || catalogModel({ provider: "anthropic", modelId: trimmed }) === undefined) {
    return refuse(key, `empty (none: Claude Haiku 5.5, claude-haiku-5-5) or an Anthropic model id this Rovara knows, such as claude-haiku-5-5 (not a Bedrock us.anthropic. id, and not a model other than Claude: lessons learn on the company's own Anthropic account; lowercase letters, digits and . - only, at most ${CORE_LEARNING_MODEL_MAX_LENGTH} characters)`);
  }
  return trimmed;
};

const oneOf = (key: string, values: readonly string[]) => (value: string): string =>
  (values.includes(value.trim()) ? value.trim() : refuse(key, `one of ${values.join(", ")}`));

// A Bedrock model or inference-profile id, or an OpenRouter slug: no spaces, at most 200 characters.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const modelId = (key: string) => (value: string): string => (MODEL_ID.test(value.trim()) ? value.trim() : refuse(key, "a model id"));

/** `default` (Rovara's recommendation) or a model id; the environment's provider and region decide which ids are usable, which only the command knows. */
const e2eAgentModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  return trimmed === "default" || MODEL_ID.test(trimmed) ? trimmed : refuse(key, "default or a model id");
};

/** `none`, or the id of a Bedrock model in the pinned catalog: the fallback is never a model this Rovara does not know. */
const fallbackModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === MODEL_FALLBACK_NONE) return trimmed;
  if (MODEL_FALLBACK_PATTERN.test(trimmed) && catalogModel({ provider: "amazon-bedrock", modelId: trimmed }) !== undefined) return trimmed;
  return refuse(key, "none or a Bedrock model of this Rovara's model catalog");
};

const email = (key: string) => (value: string): string => (AlertEmailSchema.safeParse(value.trim()).success ? value.trim() : refuse(key, "an email address"));

const parameter = (part: DeployPart, name: string): ConfigTarget => ({ kind: "stack-parameter", part, parameter: name });

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "models.orchestrator", description: "the model the Slack orchestrator uses", target: parameter("slack", "ModelId"), model: "orchestrator", parse: modelId("models.orchestrator") },
  { key: "models.classifier", description: "the model the gate classifier uses", target: parameter("slack", "GateClassifierModelId"), model: "classifier", parse: modelId("models.classifier") },
  { key: "models.worker", description: "the model the coding worker uses", target: parameter("runtime", "ModelId"), model: "worker", parse: modelId("models.worker") },
  {
    key: "models.e2eAgent", description: "the AI model that navigates your app in browser checks: default (Rovara's recommendation) or a model id Rovara can use with your provider",
    target: parameter("runtime", "E2eAgentModelId"), defaultValue: "default", e2eAgentModel: true, parse: e2eAgentModel("models.e2eAgent"),
  },
  {
    key: "models.fallback", description: "the Bedrock model the coding worker, orchestrator and classifier run on when their provider's key secret is missing: none (no fallback; the call fails by name) or a Bedrock model id",
    target: { kind: "stack-parameter", part: "runtime", parameter: "ModelFallback", also: [{ part: "slack", parameter: "ModelFallback" }] }, defaultValue: "none", fallbackModel: true, parse: fallbackModel("models.fallback"),
  },
  {
    key: "models.chatgpt.enabled", description: "true: people may connect their own ChatGPT plan and their tasks run on it; false: every task uses the worker model",
    target: { kind: "chatgpt-setting", field: "enabled" }, defaultValue: "false", parse: oneOf("models.chatgpt.enabled", ["true", "false"]),
  },
  {
    key: "models.chatgpt.preferredModel", description: "the model tasks on a ChatGPT plan prefer, where the person's plan allows it",
    target: { kind: "chatgpt-setting", field: "preferredModel" }, defaultValue: CHATGPT_DEFAULT_PREFERRED_MODEL,
    parse: (value) => (ChatGptModelIdSchema.safeParse(value.trim()).success ? value.trim() : refuse("models.chatgpt.preferredModel", "a model ID such as gpt-6.1-sol")),
  },
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
  // Spec 062: channel adapters (FR-020) and Slack through the channel API as the built-in adapter (FR-074).
  { key: "channels.adapters", description: "enabled: administrators can register channel adapters (WhatsApp and others) and the channel API takes their signed requests; disabled: none",
    target: parameter("control-plane", "ChannelAdapters"), defaultValue: "disabled", parse: oneOf("channels.adapters", ["enabled", "disabled"]) },
  { key: "slack.viaChannel", description: "enabled: Slack goes through the channel API as the built-in Slack adapter; disabled: Slack's own path, as before",
    target: parameter("control-plane", "SlackViaChannel"), defaultValue: "disabled", parse: oneOf("slack.viaChannel", ["enabled", "disabled"]) },
  // Core switch-on blocker (2026-11-17): where the core's model calls go, kept across upgrades. Both are needed; either empty leaves the core refusing work by name.
  { key: "coreEngine.modelGatewayUrl", description: "the Cloud model gateway's https origin the core engine's agents call AI through (no path or credentials); empty (the default, or none) leaves the core engine refusing work. Set coreEngine.agentModel too",
    target: parameter("control-plane", CORE_MODEL_GATEWAY_HOST_PARAMETER), defaultValue: "", corePairedWith: "coreEngine.agentModel", shown: coreModelGatewayShown, parse: coreModelGatewayUrl("coreEngine.modelGatewayUrl") },
  { key: "coreEngine.agentModel", description: "the model every core engine step runs on through the model gateway: an Anthropic model id, such as claude-sonnet-4-6, or any model the gateway offers (checked live), such as zai.glm-5; empty (the default, or none) leaves the core engine refusing work. Set coreEngine.modelGatewayUrl too",
    target: parameter("control-plane", CORE_AGENT_MODEL_PARAMETER), defaultValue: "", corePairedWith: "coreEngine.modelGatewayUrl", gatewayOffered: true, parse: coreAgentModel("coreEngine.agentModel") },
  // DEC 254zm: Code's workers run test services only once the install's five starter copies are in place: run scripts/test-services-mirror.ts --copy, then --verify, then set this to mirrored.
  { key: "testServices.images", description: "none (the default): this install's workers do not run test services; mirrored: the five starter image copies were made and checked (scripts/test-services-mirror.ts --verify), so workers pull them at boot and run test services",
    target: parameter("control-plane", "TestServiceImages"), defaultValue: "none", parse: oneOf("testServices.images", ["none", "mirrored"]) },
  { key: "savedEnvironments.switch", description: "on: enable saved environment images after the control plane publishes all three image roles and the registry template; off (the default): keep saved environments disabled",
    target: parameter("control-plane", "SavedEnvironments"), defaultValue: "0", shown: (stored) => stored === "1" ? "on" : "off", parse: savedEnvSwitchValue },
  // L4-NETG (DEC 254zzz77): how the EC2 worker hosts' task sandboxes and devcontainers reach the internet. Applies to workers booted AFTER the change; a running worker keeps its boot until it stops.
  { key: "workerSandboxEgress", description: "bridge (the default): task sandboxes and devcontainers reach the internet through the worker host's own network, as before; gateway: the commands the agent runs (shell, setup, checks, install steps, the dev container's own processes) sit on an internal network whose only exit is the host's egress gateway (the install's DNS list applies, raw IP connections and the push-capable registries are refused, S3 is refused unless a project lifts a bucket); a worker whose gateway cannot start does not boot. The image build steps of a dev container (Dockerfile RUN, features) and the end-to-end verifier's build commands go out the same way, and Docker's default bridge is walled. The Docker daemon's own build fetches (`ADD <url>`, a `FROM` base image, a dev container's features) and the host's own image pulls go through the gateway's daemon proxy: only names the install's DNS list allows, no raw addresses, no S3 buckets (packages/worker/ec2/README.md, Sandbox egress gateway). Not covered: what the install's DNS list allows (github.com push, Slack and Atlassian web APIs, a project's additions and lifted S3 buckets) and Rovara's own services. Takes effect for workers booted after the change (named environments only)",
    target: parameter("control-plane", "WorkerSandboxEgress"), defaultValue: "bridge", parse: oneOf("workerSandboxEgress", ["bridge", "gateway"]) },
  { key: "coreEngine.answersModel", description: "the model the hosted Just answer and the start-box classifier run on through the model gateway (not coding tasks, which keep coreEngine.agentModel): an Anthropic model id, such as claude-haiku-5-5; empty (the default, or none) uses coreEngine.agentModel, as before",
    target: parameter("control-plane", CORE_ANSWERS_MODEL_PARAMETER), defaultValue: "", parse: coreAnswersModel("coreEngine.answersModel") },
  { key: "coreEngine.learningModel", description: "the model the hosted lessons learn with (the reflector and the judges) through the model gateway, on the company's own Anthropic account (not coding tasks, which keep coreEngine.agentModel): an Anthropic model id, such as claude-haiku-5-5; empty (the default, or none) uses claude-haiku-5-5; a company may choose its own in its AI settings, which wins for that company",
    target: parameter("control-plane", CORE_LEARNING_MODEL_PARAMETER), defaultValue: "", parse: coreLearningModel("coreEngine.learningModel") },
  { key: "mcp.confirmElicitation", description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button or the CLI", target: parameter("control-plane", "McpConfirmElicitation"), defaultValue: "enabled", parse: oneOf("mcp.confirmElicitation", ["enabled", "disabled"]) },
  // DEC 254zg (a): Code's company layer, one switch for every function that reads COMPANY_SIGNIN and every company-only grant; the Slack service's stack takes the same value.
  { key: "company.signIn", description: "enabled: Code's company layer is on (company membership sign-in, invites, Add to Slack, Slack company mode); disabled (the default): it is off, and the template holds no company-only grant. Close self-serve (company.selfServe disabled) and migrate the members before enabling it (named environments only)",
    target: { kind: "stack-parameter", part: "control-plane", parameter: "CompanySignIn", also: [{ part: "slack", parameter: "CompanySignIn" }] }, defaultValue: "disabled", parse: oneOf("company.signIn", ["enabled", "disabled"]) },
  { key: "company.selfServe", description: "enabled: a person with an operator's invite code may create their own company, only while company.signIn is enabled too; disabled (the default): self-serve create is refused, whatever the stored self-serve setting says (named environments only)",
    target: parameter("control-plane", "CompanySelfServe"), defaultValue: "disabled", parse: oneOf("company.selfServe", ["enabled", "disabled"]) },
  // DEC 254zk: per-company Slack bots (Slack company mode, #845), set by a deploy or here: the control plane's SlackCompanyWorkspaces and the Slack service's copy.
  { key: "slack.companyWorkspaces", description: "enabled: Slack workspaces other than the install's own use their company's own bot token and company checks, only while company.signIn is enabled too; disabled (the default): only the install's workspace is served, as before (named environments only)",
    target: { kind: "stack-parameter", part: "control-plane", parameter: "SlackCompanyWorkspaces", also: [{ part: "slack", parameter: "SlackCompanyWorkspacesState" }] }, defaultValue: "disabled", parse: oneOf("slack.companyWorkspaces", ["enabled", "disabled"]) },
  // Live switches check 2026-11-18: a switch the broker read that nothing in infra set (DEC 254n(1)).
  { key: "coreEngine.agentModelChoice", description: "on: each company picks its core engine model from the models the gateway offers it (setup's AI and spending step), coreEngine.agentModel being the default; off (the default): every company runs coreEngine.agentModel (named environments only)",
    target: parameter("control-plane", CORE_AGENT_MODEL_CHOICE_PARAMETER), defaultValue: CORE_AGENT_MODEL_CHOICE_DEFAULT, parse: oneOf("coreEngine.agentModelChoice", CORE_AGENT_MODEL_CHOICE_VALUES) },
];

export function configKey(name: string): ConfigKey {
  const found = CONFIG_KEYS.find((entry) => entry.key === name);
  if (found === undefined) throw agentXError("CONFIG_INVALID", `unknown config key ${name}; agentx config list shows every key`);
  return found;
}

export function whereText(target: ConfigTarget, env: string): string {
  switch (target.kind) {
    case "stack-parameter":
      return `stack parameter ${target.parameter} on ${[target, ...(target.also ?? [])].map((each) => environmentStackName(env, each.part)).join(" and ")}`;
    case "settings":
      return `SSM ${environmentSettingsPrefix(env)}settings (${target.field})`;
    case "control-plane-setting":
      return `control-plane setting WORKSPACE_LIMITS.${target.field} (install-time default ${target.installDefault.parameter})`;
    case "chatgpt-setting":
      return `control-plane setting CHATGPT.${target.field}`;
  }
}
