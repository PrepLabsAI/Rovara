/**
 * The model gateway's CDK app branch, moved from Rovara Cloud's infra/lib/app.ts (#1478). `-c rovaraModelGateway=<env>` makes the
 * gateway's two stacks and nothing of Code's: its image repository first, then the service that runs an image from it. The stacks
 * keep Cloud's names and construct ids, so Code deploys the same CloudFormation stacks Cloud did; nothing is renamed or replaced.
 */
import { Aspects, Tags, type App } from "aws-cdk-lib";
import { RequireCloudBoundary } from "./model-gateway-boundary.js";
import { ENVIRONMENT_TAG_KEY, parseSourceKindsSwitch } from "./model-gateway-contracts.js";
import {
  MODEL_GATEWAY_CONTEXT_KEY,
  MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY,
  MODEL_GATEWAY_PRODUCT_CONTEXT_KEY,
  MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY,
  MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY,
  MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY,
  MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY,
  ModelGatewayImagesStack,
  ModelGatewayStack,
  modelGatewayImagesStackName,
  modelGatewayStackName,
  providerSecretNamesMode,
} from "./model-gateway.js";

/**
 * `-c rovaraAiSourceKinds=<kind>,...` names the company AI source kinds the owner switched on after each one's real-key check passed.
 * The same value goes to Cloud (CLOUD_AI_SOURCE_KINDS) and to the gateway (GATEWAY_AI_SOURCE_KINDS). Absent: none switched on.
 */
export const AI_SOURCE_KINDS_CONTEXT_KEY = "rovaraAiSourceKinds";
/** Absent: nothing. A string: the checked list (a bad value stops the synth). Anything else is refused. */
export function aiSourceKindsContext(value: unknown): { aiSourceKinds?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`${AI_SOURCE_KINDS_CONTEXT_KEY} must be AI source kinds, comma-separated`);
  try { parseSourceKindsSwitch(value); } catch { throw new Error(`${AI_SOURCE_KINDS_CONTEXT_KEY} must be AI source kinds, comma-separated (anthropic, openai, openrouter, bedrock, endpoint)`); }
  return { aiSourceKinds: value };
}

/** Rovara's AI for agents: absent is off; a non-empty string is the allow-list; the exempt and disabled lists never alone. */
export function rovaraAiContext(models: unknown, exempt: unknown, disabled?: unknown): { rovaraAi?: { models: string; exempt?: string; disabled?: string } } {
  if (models === undefined) {
    if (exempt !== undefined) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} needs ${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}`);
    if (disabled !== undefined) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY} needs ${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}`);
    return {};
  }
  if (typeof models !== "string" || models === "") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY} must be <agent model>=<bedrock id> pairs`);
  if (exempt !== undefined && typeof exempt !== "string") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} must be company ids`);
  if (disabled !== undefined && typeof disabled !== "string") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY} must be model names`);
  return { rovaraAi: { models, ...(exempt === undefined || exempt === "" ? {} : { exempt }), ...(disabled === undefined ? {} : { disabled }) } };
}

/** An opt-in switch read from CDK context: absent is off, "on" is on, anything else is refused (never guessed). */
export function productAiOn(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (value === "on") return true;
  throw new Error(`${name} must be "on" or absent`);
}

/** Adds the gateway's stacks when `-c rovaraModelGateway=<env>` is set and says whether it did; unset, the app is untouched. */
export function maybeModelGateway(app: App): boolean {
  const gatewayEnv = app.node.tryGetContext(MODEL_GATEWAY_CONTEXT_KEY) as unknown;
  if (gatewayEnv === undefined) return false;
  if (typeof gatewayEnv !== "string" || gatewayEnv === "") throw new Error(`${MODEL_GATEWAY_CONTEXT_KEY} must name the Rovara Cloud environment, for example staging`);
  // Every role of the gateway's stacks carries the environment's permissions boundary (model-gateway-boundary.ts); a stack that forgets it fails here.
  Aspects.of(app).add(new RequireCloudBoundary());
  const env = { region: (app.node.tryGetContext("agentxRegion") as string | undefined) ?? "us-east-1" };
  const images = new ModelGatewayImagesStack(app, "RovaraModelGatewayImages", {
    description: `Rovara Cloud ${gatewayEnv}: the model gateway's image repository`,
    stackName: modelGatewayImagesStackName(gatewayEnv),
    env,
    environmentName: gatewayEnv,
  });
  Tags.of(images).add(ENVIRONMENT_TAG_KEY, gatewayEnv);
  const gateway = new ModelGatewayStack(app, "RovaraModelGateway", {
    description: `Rovara Cloud ${gatewayEnv}: the model gateway (two Fargate tasks behind HTTPS), its meter, ledger and price tables, and alarms`,
    stackName: modelGatewayStackName(gatewayEnv),
    env,
    environmentName: gatewayEnv,
    repository: images.repository,
    ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_PRODUCT_CONTEXT_KEY), MODEL_GATEWAY_PRODUCT_CONTEXT_KEY) ? { productAi: true } : {}),
    ...rovaraAiContext(app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY), app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY), app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY)),
    ...aiSourceKindsContext(app.node.tryGetContext(AI_SOURCE_KINDS_CONTEXT_KEY)),
    ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY), MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY) ? { offeredPrices: true } : {}),
    providerSecretNames: providerSecretNamesMode(app.node.tryGetContext(MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY)),
  });
  Tags.of(gateway).add(ENVIRONMENT_TAG_KEY, gatewayEnv);
  return true;
}
