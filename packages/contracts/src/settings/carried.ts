/**
 * F1 lane L1a-0 / L1a-1: the "carried by" column. An upgrade (agentx upgrade / deploy of a named environment, `agentx upgrade --export`, and the production release pipeline) names the
 * parameters it supplies; what happens to a parameter it does NOT name used to depend on the ENGINE (the L1a-0 finding):
 *  - templates engine (packages/cli/src/deploy/templates-engine.ts, the release packages): CreateChangeSet got ONLY the supplied keys, so an omitted parameter RESET to the template's default;
 *  - cdk engine (cdk-engine.ts): `cdk deploy --parameters` gets only the supplied keys and the CDK CLI sends every other parameter as UsePreviousValue, so an omitted parameter was CARRIED;
 *  - the production release pipeline (scripts/release-production.ts, legacy stack names): `cdk deploy` as well, so every parameter it does not name was CARRIED.
 * L1a-1 gives every engine ONE rule (packages/cli/src/deploy/carry.ts): a parameter an upgrade does not supply KEEPS ITS DEPLOYED VALUE when the stack holds one and the new template still
 * declares it. The templates engine and the upgrade bundle now send UsePreviousValue for it; the cdk engine and the production release always did. Each row still says which mechanism
 * SUPPLIES its value on an upgrade, and the condition under which that mechanism supplies nothing (the deployed value is then carried, never reset).
 * tests/contract/settings-carry.test.ts pins the table, and the two engine tests (templates-engine.test.ts, cdk-engine.test.ts) pin each engine to the rule.
 */
import type { CarriedByKind } from "./types.js";

export interface CarriedBy {
  /** What supplies the value on an upgrade, and where it reads it from. */
  readonly supplies: string;
  /** What happens when it supplies nothing: since L1a-1 the deployed value is carried on every engine (deploy/carry.ts), except for the one case the text names. */
  readonly resetCondition: string;
}

export const CARRIED_BY: Readonly<Record<CarriedByKind, CarriedBy>> = {
  answers: {
    supplies: "The install answers (init, or the upgrade's answers file read from the environment's settings): stackParameters() computes it on every deploy.",
    resetCondition: "The answers do not hold the field (an optional one): the parameter is not named, so its deployed value is carried (carry.ts).",
  },
  "operator-kept": {
    supplies: "OPERATOR_PARAMETERS: an upgrade reads the deployed stack's value and sends it again (deploy-environment.ts keptOperatorParameters).",
    resetCondition: "The release's template no longer declares the parameter (it is dropped by name and reported), or the deployed stack holds no value for it (a parameter new to the template takes its default).",
  },
  "ssm-sign-in": {
    supplies: "The environment's stored sign-in settings in SSM (readStoredDeveloperSignIn): sent on every control-plane deploy of a named environment, never read back from the deployed stack.",
    resetCondition: "None. SSM holds no sign-in settings (an environment signed in by hand or in the console), or holds them without the separate Slack team id, or GitHub sign-in was never turned on: nothing is sent for those names and the deployed values are carried (they are in OPERATOR_PARAMETERS). When SSM does hold a choice it is sent and wins over the stack, including a choice that turns a method off.",
  },
  "settings-models": {
    supplies: "The environment settings' models block (settings.models, read through the install answers): the model ids, provider names, provider key secret ARNs and routing.",
    resetCondition: "None. The settings hold no value for it (a provider key set by hand on the stack, or lost from the settings): it is omitted and the deployed value is carried (the OpenRouter key is in OPERATOR_PARAMETERS; the engines carry the rest).",
  },
  "deployed-stack": {
    supplies: "The deployed control plane's own parameter (deployedGitHubAppId): an upgrade whose answers leave the field out keeps the deployed value.",
    resetCondition: "None: an upgrade refuses (CONFIG_INVALID) rather than reset it when the deployed value is absent or not numeric.",
  },
  "control-plane-outputs": {
    supplies: "The control plane stack's outputs, read from the live stack even when the control plane is not redeployed (optionalOutputs): the Slack stack's queue, table and adapter names.",
    resetCondition: "None for the four optional names: with no such output (an older control plane) the key is omitted and the deployed value is carried. SlackCompanyStateTableName and SlackCompanyTeamId are always sent, empty when the output is absent (parameters.ts), so that one case still sets them empty.",
  },
  "stack-outputs": {
    supplies: "Another stack's output (access, identity, foundation or control plane), required on every deploy.",
    resetCondition: "None: a missing output stops the deploy by name.",
  },
  none: {
    supplies: "Nothing: an upgrade does not name the parameter.",
    resetCondition: "None: every engine and the upgrade bundle carry the deployed value (carry.ts); a parameter new to the template takes its default.",
  },
};

/** What each engine does with a parameter an upgrade does not name: the same for all three (the one carry rule, deploy/carry.ts). The tests in tests/contract/settings-carry.test.ts hold these words to the engines. */
export const OMITTED_PARAMETER_BY_ENGINE = {
  templates: "is carried (templates-engine.ts sends UsePreviousValue for every deployed parameter the release's template declares and the deploy does not name)",
  cdk: "is carried (cdk-engine.ts sends only the supplied keys with --parameters; the CDK CLI sends the rest as UsePreviousValue)",
  productionRelease: "is carried (scripts/release-production.ts names only its own keys; cdk deploy sends the rest as UsePreviousValue)",
} as const;
