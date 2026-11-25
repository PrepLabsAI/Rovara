/**
 * F1 lane L0: the one typed settings table. This file holds the TYPES of a settings row; row.ts validates one, rows.ts holds Code's rows.
 *
 * What a row is: a setting somebody may change, with the one place it is stored, who may change it, where it is shown and who reads it. Two layers share the schema:
 *  - the INSTALL layer (what an operator sets on a stack: CloudFormation parameters, the broker's packed settings, `agentx config set` keys, the kept-on-upgrade list);
 *  - the CUSTOMER layer (what a company, a project or a person sets in the product: money limits, rules, switches).
 * Code keeps the rows of the stores Code owns, Cloud the rows of the stores Cloud owns; both are written with `defineRow` against this schema, and no key may be in both
 * (keys.ts: assertNoKeyInBoth). This file has no dependency except the stack part names, so it can move whole into the browser-safe API package (F3) when that lands.
 *
 * Browser-safe on purpose: types and plain data only, no AWS SDK, no CDK, no node.
 */
import type { StackPart } from "../environments.js";

/** Where a setting may be set, widest to narrowest. `install` is the operator's stack; `repo-file` is the project's own configuration file in the repository. */
export type SettingLevelName = "install" | "company" | "project" | "person" | "repo-file";
/** The repository whose store holds the value at a level. */
export type SettingOwner = "code" | "cloud";
export interface SettingLevel { level: SettingLevelName; owner: SettingOwner }

/** What a setting's value may be. Install rows use `choice`, `int` and `text` (what the template's AllowedValues, MinValue/MaxValue and AllowedPattern say). */
export type SettingType =
  | { kind: "bool" }
  | { kind: "choice"; values: readonly string[] }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "usd"; min?: number; max?: number }
  | { kind: "minutes"; min?: number; max?: number }
  | { kind: "text"; max?: number; pattern?: string }
  | { kind: "list"; item: "text" | "int"; max: number }
  | { kind: "host" };

/** `higher`: a higher stored value loosens the rule (a cap); `lower`: a lower one does; `on`: switching it on loosens; `off`: switching it off loosens. Absent: the value loosens nothing. */
export type SettingLoosens = "higher" | "lower" | "on" | "off";
export type SettingWho = "install-operator" | "company-admin" | "project-admin" | "person";
/** Where a person can change the value: the web app, `agentx config set`, the project's file, a Slack command, or the stack's own parameters (install answers, the console). */
export type SettingSurface = "web" | "cli-config-set" | "config-file" | "slack" | "stack-parameter";
/**
 * The component that reads the value at run time. A row with none is refused. `stack` is the template's own wiring (a condition, a resource property or a function's environment
 * variable that is not one of the packed broker settings); an install row that is packed into the broker's AGENTX_SETTINGS is read by the `broker`.
 */
export type SettingReader = "broker" | "dispatcher" | "worker" | "gateway" | "cloud-server" | "web" | "cli" | "stack";
/** The id of the EXISTING store adapter that holds the value. Phase 1 moves no data. */
export type SettingStoreId = "stack-parameter" | "ssm-settings" | "control-plane-setting";

/** The install class of a stack parameter: set from the install answers, set by an operator after install, or computed by the CLI from other stacks (never typed by a person). */
export type InstallClass = "answer" | "operator" | "internal";

/** One stack's parameter. A row's value may be copied to further stacks' parameters (`also`), set together. */
export interface StackParameterRef { part: StackPart; parameter: string }

/**
 * Whether the parameter is in the template the layout synthesises. `neither` is a name no template declares (today only the legacy install's layout literal, which is not a parameter),
 * so the row records the fact and the synth test pins it.
 */
export type SettingDeclaredIn = "both" | "named" | "legacy" | "neither";

/** How an upgrade supplies the value (carried.ts holds each kind's reset condition). */
export type CarriedByKind =
  | "answers"
  | "operator-kept"
  | "ssm-sign-in"
  | "settings-models"
  | "deployed-stack"
  | "control-plane-outputs"
  | "stack-outputs"
  | "none";

/** The broker's AGENTX_SETTINGS entry for a row (broker-environment.ts reads it back). */
export interface PackedSetting {
  /** The camelCase name the broker's code and tests use (BROKER_SETTINGS[key]). */
  readonly key: string;
  /** Two lowercase letters, once each, never reused. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
  /** Position in the generated BROKER_SETTINGS (the order today's literal has). */
  readonly order: number;
  /** The value is a host and the variable gets its https origin. */
  readonly httpsOrigin?: true;
  /** An on/off switch packed as one character, "1" or "0". */
  readonly switchFlag?: true;
}

/** `rollout`: an existing default-off flag. The row names the lane that decides it; a new flag may not be added this way (rule 1: no new default-off feature switches). */
export interface SettingRollout { dueBy: string }

export interface InstallInfo {
  /** The stack the row's primary parameter is on. */
  readonly part: StackPart;
  /** The CloudFormation parameter's logical id. Absent for a literal the stack writes that is not a parameter (the legacy install's layout marker). */
  readonly parameter?: string;
  readonly also?: readonly StackParameterRef[];
  readonly class: InstallClass;
  readonly declaredIn: SettingDeclaredIn;
  /** Position in OPERATOR_PARAMETERS[part] for every stack of the row: the parameter is kept at its deployed value on an upgrade. Absent: not kept. */
  readonly kept?: number;
  readonly packed?: PackedSetting;
  readonly carriedBy: readonly CarriedByKind[];
  /** A NoEcho parameter: never printed. */
  readonly secret?: true;
}

/** How `agentx config set` checks a value before anything changes (the CLI maps each kind to its parse function; the kinds with parameters are plain data here). */
export type ConfigValidator =
  | { kind: "oneOf"; values: readonly string[] }
  | { kind: "wholeNumber"; min: number; max: number }
  | { kind: "modelId" }
  | { kind: "e2eAgentModel" }
  | { kind: "fallbackModel" }
  | { kind: "email" }
  | { kind: "chatgptModelId" }
  | { kind: "coreModelGatewayUrl" }
  | { kind: "coreAgentModel" }
  | { kind: "coreAnswersModel" }
  | { kind: "coreLearningModel" }
  | { kind: "savedEnvSwitch" };

/** Where `config set` writes: the row's own stack parameter (and its `also` copies), or one of the three other places. */
export type ConfigTargetSpec =
  | { kind: "stack-parameter" }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization" }
  | { kind: "chatgpt-setting"; field: "enabled" | "preferredModel" };

/** How the stored value is shown where it is not the value the person typed. */
export type ConfigShown = "coreModelGatewayUrl" | "savedEnvSwitch";

/** The docs table's three free-text cells, kept verbatim (docs/day-two.md is generated from them, L1b). */
export interface ConfigDocs { /** Position in the guide's table (the guide's order is not `config list` order). */ order: number; where: string; default: string; notes: string }

export interface ConfigKeyInfo {
  /** The `agentx config` key, one place for each. */
  readonly key: string;
  readonly description: string;
  /** Position in CONFIG_KEYS (config list prints them in this order). */
  readonly order: number;
  readonly target: ConfigTargetSpec;
  readonly validator: ConfigValidator;
  /** The template's default, shown when the stack reports no value (absent: none). */
  readonly defaultValue?: string;
  /** The AI navigation model choice: held to the models Rovara can use with the environment's provider and region. */
  readonly e2eAgentModel?: true;
  /** The coding roles' fallback model: `none`, or a Bedrock model of the pinned catalog that passes a one-token test call. */
  readonly fallbackModel?: true;
  /** The core engine's model gateway settings come as a pair: the other key of the pair. */
  readonly corePairedWith?: string;
  /** A non-Claude value must be one the model gateway offers now, checked live before any deploy. */
  readonly gatewayOffered?: true;
  readonly shown?: ConfigShown;
  /** Model keys pass a one-token test call before anything changes. */
  readonly model?: "orchestrator" | "classifier" | "worker";
  readonly docs: ConfigDocs;
}

export interface SettingRow {
  /** Dotted, unique across both repositories: `<area>.<name>`; an install parameter without a config key is `install.<part>.<Parameter>`. */
  readonly key: string;
  readonly levels: readonly SettingLevel[];
  readonly type: SettingType;
  /** The value when nothing is stored, or the word REQUIRED. */
  readonly default: string;
  readonly unit?: "usd" | "minutes" | "count";
  readonly loosens?: SettingLoosens;
  readonly who: SettingWho;
  readonly surfaces: readonly SettingSurface[];
  readonly reader: SettingReader;
  readonly store: SettingStoreId;
  /** True for money and access rows: an unreadable value refuses, it never falls back to a looser one. */
  readonly failClosed: boolean;
  /** What the person sees; for an install row, the template's own description. */
  readonly words: string;
  /** Whether a change is recorded in the admin change history. */
  readonly audit: boolean;
  /** Customer rows: the private reference and reason a default will not do (rule 2). */
  readonly request?: { ref: string; reason: string };
  readonly install?: InstallInfo;
  readonly configKey?: ConfigKeyInfo;
  readonly rollout?: SettingRollout;
}

/** A setting a lane retired: readers drop the stored field without failing. `storedAs` says where it lives so a clean-up lane can find it. */
export interface SettingTombstone {
  readonly key: string;
  readonly retiredIn: string;
  readonly storedAs: string;
}

/** A stored key that is data (a name, an id), not a setting, with the reason (the stored-key enumeration test's exit for them). */
export interface NotASetting {
  readonly storedKey: string;
  readonly reason: string;
}
