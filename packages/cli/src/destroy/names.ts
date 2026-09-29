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

/** S3's longest bucket name: CloudFormation shortens a generated bucket name only to fit it. */
const BUCKET_NAME_MAX = 63;

/** A generated name starts with its stack's name and "-". CloudFormation fits a generated bucket
 * name into 63 characters as <start of the stack name>-<start of the logical id>-<random>, lowercased
 * (agentx-live15ea-control-p-slackthreadsessions6fd21-taqjchbygr25, seen in the Task 20 live check),
 * and S3 then returns no stack-name tag. For a long environment name the cut can reach into
 * agentx-<env>- itself. So a bucket name exactly 63 characters long also matches that shape, bound
 * to this resource's own stack name and logical id. Tables and log groups have no such limit and
 * keep the full-prefix rule. A sibling environment (prod-c beside prod) can pass the name check; the
 * agentx:env tag is what blocks it. */
function generatedNameMatches(env: string, resource: RetainedResource): boolean {
  const id = resource.physicalId.toLowerCase();
  const stack = environmentStackName(env, resource.part).toLowerCase();
  if (id.startsWith(`${stack}-`)) return true;
  if (resource.type !== "AWS::S3::Bucket" || id.length !== BUCKET_NAME_MAX) return false;
  const logicalId = resource.logicalId.toLowerCase();
  for (let first = id.indexOf("-"); first !== -1; first = id.indexOf("-", first + 1)) {
    for (let second = id.indexOf("-", first + 1); second !== -1; second = id.indexOf("-", second + 1)) {
      const [p1, p2, suffix] = [id.slice(0, first), id.slice(first + 1, second), id.slice(second + 1)];
      if (p1.length > 0 && stack.startsWith(p1) && p2.length > 0 && logicalId.startsWith(p2) && /^[a-z0-9]+$/.test(suffix)) return true;
    }
  }
  return false;
}

/** Why a retained resource is not this environment's to delete, or undefined when it is. It comes
 * from this environment's own stack inventory; it must also carry this environment's tag. When it
 * carries CloudFormation's stack-name tag, that must be its own stack; without that tag, a generated
 * name must match its own stack (generatedNameMatches). */
export function retainedMismatch(env: string, resource: RetainedResource, tags: Record<string, string> | undefined): string | undefined {
  if (!valid(env) || tags?.["agentx:env"] !== env) return `it does not carry agentx:env=${env}`;
  const own = environmentStackName(env, resource.part);
  const stackTag = tags[STACK_NAME_TAG];
  if (stackTag !== undefined && stackTag !== own) return `it belongs to stack ${stackTag}, not ${own}`;
  if (stackTag === undefined && GENERATED_NAMES.has(resource.type) && !generatedNameMatches(env, resource)) return `its name does not match stack ${own}`;
  if (resource.type === "AWS::SecretsManager::Secret" && !(resource.physicalId.includes(`:secret:agentx/${env}/`) || resource.physicalId.startsWith(`agentx/${env}/`))) {
    return `its name is not under agentx/${env}/`;
  }
  return undefined;
}

export const isOwnedRetained = (env: string, resource: RetainedResource, tags: Record<string, string> | undefined): boolean => retainedMismatch(env, resource, tags) === undefined;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `id` is the secret `name` itself, or its ARN: Secrets Manager ends an ARN with "-" and six
 * random characters, so agentx/<env>/github never matches agentx/<env>/github-app's ARN. */
export function isSecretId(id: string, name: string): boolean {
  return id === name || new RegExp(`:secret:${escapeRegExp(name)}-[A-Za-z0-9]{6}$`).test(id);
}
