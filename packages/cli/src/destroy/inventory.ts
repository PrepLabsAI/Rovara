// What agentx destroy must remove after the stacks are gone: every resource a stack retains
// (DeletionPolicy Retain or RetainExceptOnCreate), recorded in SSM before any stack is deleted, so
// a re-run after the stacks are gone still knows them. Also the plan shown before confirming, the
// typed confirmation, and the vendor steps printed at the end.
import { z } from "zod";
import { agentXError, EnvironmentNameSchema, environmentSettingsPrefix, environmentStackName, type StackPart } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { CONNECTOR_TYPES, SSM_STANDARD_VALUE_LIMIT, type ConnectorType } from "../init/install-state.js";

export const RETAINED_TYPES: readonly string[] = ["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret"];
/** Question 2: --keep-data keeps the data, and removes the rest (log groups included). */
export const KEPT_BY_KEEP_DATA: ReadonlySet<string> = new Set(["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret"]);

export interface RetainedResource { part: StackPart; logicalId: string; type: string; physicalId: string }

const PARTS = ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const;
const InventorySchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  resources: z.array(z.object({ part: z.enum(PARTS), logicalId: z.string().min(1).max(255), type: z.string().min(1).max(100), physicalId: z.string().min(1).max(2048) }).strict()).max(40),
  launchTemplateId: z.string().regex(/^lt-[0-9a-f]+$/).optional(),
  github: z.object({ account: z.string().min(1).max(39), accountType: z.enum(["organization", "user"]), slug: z.string().regex(/^[a-z0-9-]+$/) }).strict().optional(),
  slackAppId: z.string().regex(/^A[A-Z0-9]+$/).optional(),
  connectors: z.array(z.enum(CONNECTOR_TYPES)).max(3).optional(),
}).strict();
export type Inventory = z.infer<typeof InventorySchema>;

export function retainedResources(part: StackPart, templateBody: string, resources: Array<{ logicalId: string; type: string; physicalId: string | undefined }>): RetainedResource[] {
  let retained: (resource: { logicalId: string; type: string }) => boolean;
  try {
    const template = JSON.parse(templateBody) as { Resources?: Record<string, { DeletionPolicy?: string }> };
    const ids = new Set(Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.DeletionPolicy === "Retain" || resource.DeletionPolicy === "RetainExceptOnCreate").map(([id]) => id));
    retained = (resource) => ids.has(resource.logicalId);
  } catch {
    // An unreadable template: every resource of a type AgentX retains is treated as retained. One
    // the stack delete removed anyway is simply found gone later.
    retained = (resource) => RETAINED_TYPES.includes(resource.type);
  }
  return resources.flatMap((resource) => (retained(resource) && resource.physicalId !== undefined && resource.physicalId !== "" ? [{ part, logicalId: resource.logicalId, type: resource.type, physicalId: resource.physicalId }] : []));
}

export function inventoryParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}destroy/inventory`;
}

export async function readInventory(store: ParameterStore, env: string): Promise<Inventory | undefined> {
  const stored = await store.get(inventoryParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(stored.value); } catch { json = undefined; }
  const parsed = InventorySchema.safeParse(json);
  if (!parsed.success || parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `${inventoryParameterName(env)} is not an agentx destroy inventory for ${env}; delete it only if you are sure nothing of ${env} is left, then run agentx destroy again`);
  return parsed.data;
}

export async function writeInventory(store: ParameterStore, inventory: Inventory): Promise<void> {
  const json = JSON.stringify(InventorySchema.parse(inventory));
  if (Buffer.byteLength(json) > SSM_STANDARD_VALUE_LIMIT) {
    throw agentXError("CONFIG_INVALID", `the list of resources environment ${inventory.env}'s stacks keep is larger than SSM's ${SSM_STANDARD_VALUE_LIMIT}-byte limit; report this as an AgentX bug, and tear the environment down with docs/teardown.md meanwhile`);
  }
  await store.put(inventoryParameterName(inventory.env), json);
}

export function mergeInventory(stored: Inventory | undefined, found: Omit<Inventory, "schemaVersion">): Inventory {
  const key = (resource: RetainedResource) => `${resource.type}|${resource.physicalId}`;
  const resources = new Map((stored?.resources ?? []).map((resource) => [key(resource), resource]));
  for (const resource of found.resources) resources.set(key(resource), resource);
  const launchTemplateId = found.launchTemplateId ?? stored?.launchTemplateId;
  const github = found.github ?? stored?.github;
  const slackAppId = found.slackAppId ?? stored?.slackAppId;
  const connectors = found.connectors ?? stored?.connectors;
  return {
    schemaVersion: 1, env: found.env, resources: [...resources.values()],
    ...(launchTemplateId === undefined ? {} : { launchTemplateId }), ...(github === undefined ? {} : { github }),
    ...(slackAppId === undefined ? {} : { slackAppId }), ...(connectors === undefined ? {} : { connectors }),
  };
}

export function confirmationPrompts(input: { env: string; account: string; recorded: boolean }): Array<{ question: string; expected: string }> {
  const prompts = [{ question: `Type the environment's name, ${input.env}, to delete it and everything in it: `, expected: input.env }];
  if (input.env === "production" || !input.recorded) {
    const why = input.env === "production" ? "This environment is named production." : `AgentX has no record of creating ${input.env} (no settings and no install answers).`;
    prompts.push({ question: `${why} Type the AWS account id, ${input.account}, to go on: `, expected: input.account });
  }
  return prompts;
}

const REVOKE: Record<ConnectorType, string> = {
  linear: "Revoke the Linear API key AgentX used: Linear, Settings, Security and access, API keys.",
  jira: "Revoke the Jira service account's API token: id.atlassian.com, Security, API tokens, signed in as the service account.",
  asana: "Delete the Asana app AgentX used, or remove its bot from the project: app.asana.com/0/my-apps.",
};

export function vendorSteps(inventory: Inventory): string[] {
  const { github, slackAppId } = inventory;
  const githubPage = github === undefined ? undefined : github.accountType === "organization"
    ? `https://github.com/organizations/${github.account}/settings/apps/${github.slug}/advanced`
    : `https://github.com/settings/apps/${github.slug}/advanced`;
  return [
    github === undefined || githubPage === undefined
      ? "Delete the environment's GitHub App, if it had one: https://github.com/settings/apps (for an organization: its Settings, Developer settings, GitHub Apps), then Advanced, Delete GitHub App."
      : `Delete the GitHub App ${github.slug}: open ${githubPage} and choose Delete GitHub App.`,
    slackAppId === undefined
      ? "Delete the environment's Slack app, if it had one: https://api.slack.com/apps, the app, then Delete App at the bottom of Basic Information."
      : `Delete the Slack app: open https://api.slack.com/apps/${slackAppId}/general and choose Delete App at the bottom of the page.`,
    ...(inventory.connectors ?? []).map((type) => REVOKE[type]),
  ];
}

export interface DestroyPlan {
  env: string; account: string; region: string; stacks: Array<{ name: string; status: string }>; instances: number; volumes: number;
  resources: RetainedResource[]; secrets: number; parameters: number; localFiles: string[]; keepData: boolean;
}

const NOUNS: Record<string, [string, string]> = {
  "AWS::S3::Bucket": ["bucket (every version)", "buckets (every version)"], "AWS::DynamoDB::Table": ["table", "tables"], "AWS::Logs::LogGroup": ["log group", "log groups"],
  "AWS::Cognito::UserPool": ["Cognito user pool", "Cognito user pools"], "AWS::KMS::Key": ["KMS key (deleted after 7 days)", "KMS keys (deleted after 7 days)"], "AWS::SecretsManager::Secret": ["secret", "secrets"],
};
const counted = (resources: RetainedResource[]) => [...new Set(resources.map((resource) => resource.type))].map((type) => {
  const count = resources.filter((resource) => resource.type === type).length;
  const [one, many] = NOUNS[type] ?? [type, type];
  return `${count} ${count === 1 ? one : many}`;
});
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function destroyPlanText(plan: DestroyPlan): string[] {
  const deleted = plan.keepData ? plan.resources.filter((resource) => !KEPT_BY_KEEP_DATA.has(resource.type)) : plan.resources;
  const kept = plan.keepData ? plan.resources.filter((resource) => KEPT_BY_KEEP_DATA.has(resource.type)) : [];
  const controlPlane = environmentStackName(plan.env, "control-plane");
  return [
    `This deletes AgentX environment ${plan.env} in account ${plan.account}, region ${plan.region}:`,
    ...(plan.stacks.length === 0 ? [] : [`  stacks, in this order: ${plan.stacks.map((stack) => `${stack.name} (${stack.status})`).join(", ")}`]),
    ...(plan.instances + plan.volumes === 0 ? [] : [`  EC2 workers: ${plural(plan.instances, "instance", "instances")} and ${plural(plan.volumes, "workspace volume", "workspace volumes")}; deleting the volumes deletes every worker session's workspace`]),
    ...(deleted.length === 0 ? [] : [`  what the stacks keep, deleted after them: ${counted(deleted).join(", ")}`]),
    ...(plan.keepData ? [] : [`  secrets: ${plural(plan.secrets, "secret", "secrets")} under agentx/${plan.env}/, deleted without recovery`]),
    `  settings: ${plural(plan.parameters, "parameter", "parameters")} under /agentx/${plan.env}/`,
    ...(plan.localFiles.length === 0 ? [] : [`  on this computer: ${plan.localFiles.join(", ")}`]),
    ...(plan.keepData ? [`  --keep-data keeps: ${[...counted(kept), plural(plan.secrets, "secret", "secrets")].join(" and ")}`] : []),
    ...(plan.stacks.some((stack) => stack.name === controlPlane) ? [`  Deleting ${controlPlane} usually takes 20 to 40 minutes: its Lambda functions release their network interfaces slowly.`] : []),
    "Nothing here can be undone.",
  ];
}
