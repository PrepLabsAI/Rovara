// An AWS account in memory for agentx destroy: stacks that take simulated minutes to delete,
// worker instances and volumes, retained resources with tags, and secrets. Every mutating call is
// recorded in order in `calls`.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentStackName, type StackPart } from "@agentx/contracts";
import type { DestroyApi, DestroyStack } from "../../packages/cli/src/destroy/aws.js";
import type { RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import type { InstallProgress } from "../../packages/cli/src/init/install-state.js";
import { T0 } from "./init-fakes.js";
import { STAGING_SETTINGS } from "./setup-fakes.js";

// The same installed staging environment tests/support/doctor-fakes.ts describes (lane B); kept here
// so the destroy lane does not depend on the doctor lane's fakes.
export const SETTINGS: EnvironmentSettings = {
  ...STAGING_SETTINGS,
  stacks: { access: "agentx-staging-access", foundation: "agentx-staging-foundation", identity: "agentx-staging-identity", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
};
export const PROGRESS: InstallProgress = {
  schemaVersion: 1, env: "staging", steps: {}, updatedAt: new Date(T0).toISOString(),
  github: { account: "acme", appId: "123", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "456" },
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" },
  project: { name: "payments", revision: 1, channelName: "payments", channelId: "C0123456789", teamId: "T0TEAM" },
};

/** The project files one environment wrote, found by the register line agentx writes in their header
 * (the same rule as environmentProjectFiles in setup/project-add.ts, on the doctor lane). */
export async function headerProjectFiles(configDir: string, env: string): Promise<Array<{ path: string; launchTemplateId: string }>> {
  const line = /^#\s+agentx admin project register --env (\S+) --file .+? --deployment-mode ec2-ebs --launch-template-id (\S+)/m;
  const found: Array<{ path: string; launchTemplateId: string }> = [];
  for (const entry of (await readdir(configDir).catch(() => [])).filter((name) => name.endsWith(".yaml")).sort()) {
    const path = join(configDir, entry);
    const match = line.exec(await readFile(path, "utf8"));
    if (match?.[1] === env && match[2] !== undefined) found.push({ path, launchTemplateId: match[2] });
  }
  return found;
}

export interface FakeStack extends DestroyStack { template: string; resources: Array<{ logicalId: string; type: string; physicalId: string }>; deleteMinutes?: number; failDeletes?: number; busyMinutes?: number; settledStatus?: string }
export interface FakeAccount {
  stacks: Map<string, FakeStack>;
  instances: Array<{ id: string; state: string; tags: Record<string, string> }>;
  volumes: Array<{ id: string; state: string; tags: Record<string, string> }>;
  tags: Map<string, Record<string, string>>;   // physical id -> tags; absent means gone
  secrets: Array<{ name: string; scheduled: boolean }>;
  aliases: string[];
  calls: string[];
}

export const retainedTemplate = (resources: Array<{ logicalId: string; type: string }>) => JSON.stringify({ Resources: Object.fromEntries(resources.map((resource) => [resource.logicalId, { Type: resource.type, DeletionPolicy: "RetainExceptOnCreate" }])) });

/** A fully installed environment `env` in account 123456789012, with one worker, two volumes and the usual retained resources. */
export function installedAccount(env = "staging"): FakeAccount {
  const stack = (part: StackPart, resources: FakeStack["resources"] = [], extra: Partial<FakeStack> = {}): [string, FakeStack] => [environmentStackName(env, part), {
    status: "UPDATE_COMPLETE", terminationProtection: ["access", "foundation", "identity", "runtime"].includes(part), outputs: {},
    ...(part === "access" ? {} : { roleArn: `arn:aws:iam::123456789012:role/agentx-${env}-cloudformation` }),
    template: retainedTemplate(resources), resources, ...extra,
  }];
  const account: FakeAccount = {
    stacks: new Map([
      stack("access", [{ logicalId: "ArtifactBucket", type: "AWS::S3::Bucket", physicalId: `agentx-${env}-access-artifactbucket-1a` }]),
      stack("foundation", [{ logicalId: "VpcFlowLogs", type: "AWS::Logs::LogGroup", physicalId: `agentx-${env}-foundation-VpcFlowLogs-2b` }, { logicalId: "WorkspaceKey", type: "AWS::KMS::Key", physicalId: "key-3c" }], { outputs: { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" } }),
      stack("identity", [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_Pool4d" }]),
      stack("control-plane", [
        { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: `agentx-${env}-control-plane-State-5e` },
        { logicalId: "SlackThreadSessions", type: "AWS::S3::Bucket", physicalId: `agentx-${env}-control-plane-slackthreadsessions-6f` },
        { logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: `arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/${env}/slack-AbCdEf` },
      ], { deleteMinutes: 30 }),
      stack("runtime"),
      stack("slack"),
    ]),
    instances: [{ id: "i-worker1", state: "running", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } }],
    volumes: [
      { id: "vol-root1", state: "in-use", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } },
      { id: "vol-ws1", state: "available", tags: { DeploymentMode: "ec2-ebs", Environment: env, "agentx:env": env } },
    ],
    tags: new Map(),
    secrets: [{ name: `agentx/${env}/slack`, scheduled: false }, { name: `agentx/${env}/callback-signing-key`, scheduled: false }, { name: `agentx/${env}/github-app`, scheduled: false }],
    aliases: [`alias/agentx/${env}/workspaces`],
    calls: [],
  };
  for (const [, entry] of account.stacks) for (const resource of entry.resources) account.tags.set(resource.physicalId, { "agentx:env": env });
  return account;
}

export function fakeDestroyApi(account: FakeAccount, clock: { now: () => number }): DestroyApi {
  const deleting = new Map<string, number>();   // stack name -> time the delete finishes
  const stackNow = (name: string): FakeStack | undefined => {
    const entry = account.stacks.get(name);
    // A stack busy with an update settles once its minutes have passed.
    if (entry?.busyMinutes !== undefined && clock.now() >= entry.busyMinutes * 60_000) { entry.status = entry.settledStatus ?? "UPDATE_COMPLETE"; delete entry.busyMinutes; }
    const done = deleting.get(name);
    if (entry !== undefined && done !== undefined && clock.now() >= done) {
      if ((entry.failDeletes ?? 0) > 0) { entry.failDeletes = (entry.failDeletes ?? 0) - 1; entry.status = "DELETE_FAILED"; deleting.delete(name); return entry; }
      account.stacks.delete(name);
      deleting.delete(name);
      return undefined;
    }
    return entry;
  };
  const gone = (resource: RetainedResource) => account.tags.delete(resource.physicalId);
  // Secrets Manager lists a force-deleted secret, as scheduled for deletion, for a while; deleting it
  // again would restore it first, which fails on a secret being force-deleted.
  const forceDeleted = new Set<string>();
  return {
    async stack(name) { const entry = stackNow(name); return entry === undefined ? undefined : { status: entry.status, terminationProtection: entry.terminationProtection, outputs: entry.outputs, ...(entry.roleArn === undefined ? {} : { roleArn: entry.roleArn }) }; },
    async template(name) { return account.stacks.get(name)?.template ?? "{}"; },
    async stackResources(name) { return account.stacks.get(name)?.resources ?? []; },
    async disableTerminationProtection(name) { account.calls.push(`protection off ${name}`); account.stacks.get(name)!.terminationProtection = false; },
    async deleteStack(name) {
      const entry = account.stacks.get(name)!;
      if (entry.terminationProtection) throw new Error(`test: ${name} still has termination protection`);
      account.calls.push(`delete stack ${name}`);
      entry.status = "DELETE_IN_PROGRESS";
      deleting.set(name, clock.now() + (entry.deleteMinutes ?? 2) * 60_000);
      return `agentx-destroy-test-${name}`;
    },
    async latestEvent() { return "Resource DELETE_IN_PROGRESS"; },
    async failedResources() { return ["WorkerSecurityGroup: resource has a dependent object"]; },
    async workerInstances() { return account.instances.filter((instance) => instance.state !== "terminated"); },
    async terminateInstances(ids) { account.calls.push(`terminate ${ids.join(",")}`); for (const instance of account.instances) if (ids.includes(instance.id)) instance.state = "terminated"; for (const volume of account.volumes) volume.state = "available"; },
    async workerVolumes() { return account.volumes; },
    async deleteVolume(id) { account.calls.push(`delete volume ${id}`); account.volumes = account.volumes.filter((volume) => volume.id !== id); },
    async resourceTags(resource) { return account.tags.get(resource.physicalId); },
    async deleteBucket(name, onProgress) { account.calls.push(`delete bucket ${name}`); onProgress(3); account.tags.delete(name); },
    async deleteTable(name) { account.calls.push(`delete table ${name}`); account.tags.delete(name); },
    async deleteLogGroup(name) { account.calls.push(`delete log group ${name}`); account.tags.delete(name); },
    async deleteUserPool(id, domain) { account.calls.push(`delete user pool ${id} (domain ${domain})`); account.tags.delete(id); },
    async scheduleKeyDeletion(id) { account.calls.push(`schedule key ${id}`); return "scheduled"; },
    async aliases() { return account.aliases.map((name) => ({ name })); },
    async deleteAlias(name) { account.calls.push(`delete alias ${name}`); account.aliases = account.aliases.filter((alias) => alias !== name); },
    async secrets() { return account.secrets; },
    async deleteSecret(name) {
      const matches = account.secrets.filter((secret) => secret.name === name || name.includes(`:secret:${secret.name}-`));
      if (matches.some((secret) => forceDeleted.has(secret.name))) throw new Error(`test: ${name} was already force-deleted; RestoreSecret fails on it`);
      account.calls.push(`delete secret ${name}`);
      for (const secret of matches) { secret.scheduled = true; forceDeleted.add(secret.name); }
      gone({ part: "control-plane", logicalId: "", type: "", physicalId: name });
    },
  };
}
