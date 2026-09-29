// An AWS account in memory for agentx destroy: stacks that take simulated minutes to delete,
// worker instances and volumes, retained resources with tags, and secrets. Every mutating call is
// recorded in order in `calls`.
import { environmentStackName, type StackPart } from "@agentx/contracts";
import type { DestroyApi, DestroyStack } from "../../packages/cli/src/destroy/aws.js";
import type { RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { isSecretId } from "../../packages/cli/src/destroy/names.js";

// The installed staging environment every day-2 test uses: one copy, in doctor-fakes.ts.
export { PROGRESS, SETTINGS } from "./doctor-fakes.js";

export interface FakeStack extends DestroyStack { template: string; resources: Array<{ logicalId: string; type: string; physicalId: string }>; deleteMinutes?: number; failDeletes?: number; busyMinutes?: number; settledStatus?: string; /** GetTemplate fails, as for a stack with only a pending change set. */ noTemplate?: boolean }
export interface FakeAccount {
  stacks: Map<string, FakeStack>;
  instances: Array<{ id: string; state: string; tags: Record<string, string> }>;
  volumes: Array<{ id: string; state: string; tags: Record<string, string> }>;
  tags: Map<string, Record<string, string>>;   // physical id -> tags; absent means gone
  secrets: Array<{ name: string; scheduled: boolean }>;
  aliases: string[];
  calls: string[];
  /** The token each failedResources call was given. */
  failedTokens?: Array<string | undefined>;
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
    async template(name) {
      if (account.stacks.get(name)?.noTemplate === true) throw Object.assign(new Error(`Stack with id ${name} has no template`), { name: "ValidationError" });
      return account.stacks.get(name)?.template ?? "{}";
    },
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
    async failedResources(_name, token) { (account.failedTokens ??= []).push(token); return ["WorkerSecurityGroup: resource has a dependent object"]; },
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
      const matches = account.secrets.filter((secret) => isSecretId(name, secret.name));
      if (matches.some((secret) => forceDeleted.has(secret.name))) throw new Error(`test: ${name} was already force-deleted; RestoreSecret fails on it`);
      account.calls.push(`delete secret ${name}`);
      for (const secret of matches) { secret.scheduled = true; forceDeleted.add(secret.name); }
      gone({ part: "control-plane", logicalId: "", type: "", physicalId: name });
    },
  };
}

/** A Secrets Manager client for the real adapter's deleteSecret: `forceDeleted` secrets are listed as
 * scheduled once, refuse RestoreSecret (InvalidRequestException, as for a secret being force-deleted),
 * then are gone. Every other secret deletes normally. */
export function forceDeletedSecretsClient(forceDeleted: string[]) {
  const described = new Map<string, number>();
  const calls: string[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: { SecretId?: string } }): Promise<unknown> {
      const op = command.constructor.name.replace(/Command$/, "");
      const id = command.input.SecretId ?? "";
      const name = forceDeleted.find((entry) => isSecretId(id, entry));
      calls.push(`${op} ${id}`);
      if (op === "DescribeSecret") {
        if (name === undefined) return { Name: id };
        const count = (described.get(name) ?? 0) + 1;
        described.set(name, count);
        if (count === 1) return { Name: name, DeletedDate: new Date(0) };
        throw Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: "ResourceNotFoundException" });
      }
      if (op === "RestoreSecret" && name !== undefined) throw Object.assign(new Error("You can't perform this operation on the secret because it was deleted."), { name: "InvalidRequestException" });
      return {};
    },
  };
  return { calls, clients: { cloudFormation: client, ec2: client, s3: client, dynamodb: client, logs: client, cognito: client, kms: client, secrets: client } };
}
