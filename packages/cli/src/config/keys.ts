// FR-048: agentx config's fixed, documented keys. Each maps to exactly one place: a stack parameter,
// an SSM value (the environment settings) or a control-plane setting. docs/day-two.md lists the
// same table.
import { CODE_SETTING_ROWS, CORE_AGENT_MODEL_MAX_LENGTH, CORE_ANSWERS_MODEL_MAX_LENGTH, CORE_LEARNING_MODEL_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_MAX_LENGTH, CORE_MODEL_GATEWAY_HOST_PATTERN, ChatGptModelIdSchema, MODEL_FALLBACK_NONE, configKeySpecsFromRows, isClaudeAgentModel, isCoreAgentModelId, isCoreAnswersModelId, isCoreLearningModelId, MODEL_FALLBACK_PATTERN, agentXError, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";
import type { ConfigKeySpec, ConfigValidator } from "@agentx/contracts";
import { catalogModel } from "@agentx/model-runtime/catalog";
import { AlertEmailSchema } from "../deploy/answer-schemas.js";
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
    return refuse(key, `empty (none), an Anthropic model id this Rovara knows, such as claude-sonnet-4-6 (not a Bedrock us.anthropic. id), or the exact id of a model the model gateway offers, such as zai.glm-5 (lowercase letters, digits and . _ : - or an exact vendor/model ID, at most ${CORE_AGENT_MODEL_MAX_LENGTH} characters)`);
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

/** The parse function a row's validator names: the data kinds are built here from their parameters, the rest are the functions above. */
function parseFor(key: string, validator: ConfigValidator): (value: string) => string {
  switch (validator.kind) {
    case "oneOf": return oneOf(key, validator.values);
    case "wholeNumber": return wholeNumber(key, validator.min, validator.max);
    case "modelId": return modelId(key);
    case "e2eAgentModel": return e2eAgentModel(key);
    case "fallbackModel": return fallbackModel(key);
    case "email": return email(key);
    case "chatgptModelId": return (value) => (ChatGptModelIdSchema.safeParse(value.trim()).success ? value.trim() : refuse(key, "a model ID such as gpt-6.1-sol"));
    case "coreModelGatewayUrl": return coreModelGatewayUrl(key);
    case "coreAgentModel": return coreAgentModel(key);
    case "coreAnswersModel": return coreAnswersModel(key);
    case "coreLearningModel": return coreLearningModel(key);
    case "savedEnvSwitch": return savedEnvSwitchValue;
  }
}

const SHOWN: Readonly<Record<NonNullable<ConfigKeySpec["shown"]>, (stored: string) => string>> = {
  coreModelGatewayUrl: coreModelGatewayShown,
  savedEnvSwitch: (stored) => (stored === "1" ? "on" : "off"),
};

function configKeyOf(spec: ConfigKeySpec): ConfigKey {
  return {
    key: spec.key,
    description: spec.description,
    target: spec.target,
    ...(spec.defaultValue === undefined ? {} : { defaultValue: spec.defaultValue }),
    ...(spec.e2eAgentModel === undefined ? {} : { e2eAgentModel: spec.e2eAgentModel }),
    ...(spec.fallbackModel === undefined ? {} : { fallbackModel: spec.fallbackModel }),
    ...(spec.corePairedWith === undefined ? {} : { corePairedWith: spec.corePairedWith }),
    ...(spec.gatewayOffered === undefined ? {} : { gatewayOffered: spec.gatewayOffered }),
    ...(spec.shown === undefined ? {} : { shown: SHOWN[spec.shown] }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    parse: parseFor(spec.key, spec.validator),
  };
}

/** Every `agentx config` key, derived from Code's settings rows (packages/contracts/src/settings/install-rows.ts): adding a key is adding a row, and `docs/day-two.md`'s table is generated from the same rows. */
export const CONFIG_KEYS: readonly ConfigKey[] = configKeySpecsFromRows(CODE_SETTING_ROWS).map(configKeyOf);

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
