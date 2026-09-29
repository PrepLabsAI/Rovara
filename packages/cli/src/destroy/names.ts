// agentx destroy checks every name here before deleting anything, so it never reaches a different
// named environment's resources. Prefixes carry their separator ("agentx/<env>/", "/agentx/<env>/"),
// because "/" cannot appear in an environment name, so agentx/prod/ never matches agentx/prod-eu/. A
// name that is not a valid environment name (empty, or with a "/") owns nothing, so it can never widen
// a prefix.
//
// These guards cannot protect the older production deployment: for env "production", its
// /agentx/production/* parameters and alias/agentx/production/invoke-signing pass them. runDestroy
// refuses that deployment up front (ruling F21); these guards do not.
import { EnvironmentNameSchema, environmentStackName, STACK_PARTS, type StackPart } from "@agentx/contracts";
import type { RetainedResource } from "./inventory.js";

export const DELETE_BEFORE_WORKERS: readonly StackPart[] = ["slack", "runtime", "control-plane"];
export const DELETE_AFTER_WORKERS: readonly StackPart[] = ["identity", "foundation", "access"];

/** Resource types whose names CloudFormation generates from the stack name. */
const GENERATED_NAMES = new Set(["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup"]);

const valid = (env: string) => EnvironmentNameSchema.safeParse(env).success;

export const isOwnedStack = (env: string, name: string) => valid(env) && STACK_PARTS.some((part) => environmentStackName(env, part) === name);
export const isOwnedSecret = (env: string, name: string) => valid(env) && name.startsWith(`agentx/${env}/`);
export const isOwnedParameter = (env: string, name: string) => valid(env) && (name === `/agentx/${env}` || name.startsWith(`/agentx/${env}/`));
export const isOwnedAlias = (env: string, alias: string) => valid(env) && alias.startsWith(`alias/agentx/${env}/`);

/** All three tags: the legacy deployment's workers carry Environment=production but no agentx:env. */
export const isOwnedWorker = (env: string, tags: Record<string, string>) =>
  valid(env) && tags.DeploymentMode === "ec2-ebs" && tags.Environment === env && tags["agentx:env"] === env;

/** CloudFormation's own tag on the resources it creates. */
const STACK_NAME_TAG = "aws:cloudformation:stack-name";

/** A retained resource comes from this environment's own stack inventory; it must also carry this
 * environment's tag. When it carries CloudFormation's stack-name tag, that must be its own stack
 * (a generated bucket name can be shortened for a long environment name, so the name alone can miss
 * it); without that tag, a generated name must start with its own stack's name. */
export function isOwnedRetained(env: string, resource: RetainedResource, tags: Record<string, string> | undefined): boolean {
  if (!valid(env) || tags?.["agentx:env"] !== env) return false;
  const stackTag = tags[STACK_NAME_TAG];
  if (stackTag !== undefined && stackTag !== environmentStackName(env, resource.part)) return false;
  if (stackTag === undefined && GENERATED_NAMES.has(resource.type)) return resource.physicalId.toLowerCase().startsWith(`${environmentStackName(env, resource.part)}-`.toLowerCase());
  if (resource.type === "AWS::SecretsManager::Secret") return resource.physicalId.includes(`:secret:agentx/${env}/`) || resource.physicalId.startsWith(`agentx/${env}/`);
  return true;
}
