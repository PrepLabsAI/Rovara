// agentx destroy's AWS calls, one method per step, each treating "already gone" as done so a
// re-run after a failure continues. Run with admin credentials (question 7). Every list method keeps
// only what the names.ts guards say belongs to the environment; runDestroy checks each name with
// those guards again before it calls a delete method here.
import { randomUUID } from "node:crypto";
import { DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand, UpdateTerminationProtectionCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { DeleteUserPoolCommand, DeleteUserPoolDomainCommand, DescribeUserPoolCommand, UpdateUserPoolCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteTableCommand, DescribeTableCommand, ListTagsOfResourceCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteVolumeCommand, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DeleteAliasCommand, DescribeKeyCommand, ListAliasesCommand, ListResourceTagsCommand, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { DeleteLogGroupCommand, DescribeLogGroupsCommand, ListTagsForResourceCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DeleteBucketCommand, DeleteObjectsCommand, GetBucketTaggingCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { DeleteSecretCommand, DescribeSecretCommand, ListSecretsCommand, RestoreSecretCommand } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@agentx/contracts";
import type { RetainedResource } from "./inventory.js";
import { isOwnedAlias, isOwnedSecret, isOwnedWorker } from "./names.js";

export interface DestroyStack { status: string; terminationProtection: boolean; roleArn?: string; outputs: Record<string, string> }
export interface DestroyApi {
  stack(name: string): Promise<DestroyStack | undefined>;
  template(name: string): Promise<string>;
  stackResources(name: string): Promise<Array<{ logicalId: string; type: string; physicalId: string | undefined }>>;
  disableTerminationProtection(name: string): Promise<void>;
  /** Starts the delete with its own ClientRequestToken, and answers that token. */
  deleteStack(name: string): Promise<string>;
  latestEvent(name: string): Promise<string | undefined>;
  /** The resources that failed to delete: with `token`, only that delete's events; without, those
   * since the stack's latest delete began. */
  failedResources(name: string, token?: string): Promise<string[]>;
  workerInstances(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  terminateInstances(ids: string[]): Promise<void>;
  workerVolumes(env: string): Promise<Array<{ id: string; state: string; tags: Record<string, string> }>>;
  deleteVolume(id: string): Promise<void>;
  resourceTags(resource: RetainedResource): Promise<Record<string, string> | undefined>;
  deleteBucket(name: string, onProgress: (deleted: number) => void): Promise<void>;
  deleteTable(name: string): Promise<void>;
  deleteLogGroup(name: string): Promise<void>;
  deleteUserPool(id: string, domainPrefix: string): Promise<void>;
  scheduleKeyDeletion(keyId: string): Promise<"scheduled" | "already">;
  aliases(env: string): Promise<Array<{ name: string }>>;
  deleteAlias(name: string): Promise<void>;
  secrets(env: string): Promise<Array<{ name: string; scheduled: boolean }>>;
  /** Reads whether the secret is scheduled for deletion itself, so one scheduled by hand is handled too. */
  deleteSecret(name: string): Promise<void>;
}

type Send = { send(command: unknown): Promise<unknown> };
const GONE = new Set(["NoSuchBucket", "ResourceNotFoundException", "NotFoundException", "InvalidVolume.NotFound", "NoSuchEntity"]);
const isGone = (error: unknown) => error instanceof Error && (GONE.has(error.name) || (error.name === "ValidationError" && /does not exist/.test(error.message)));
async function unlessGone<T>(run: () => Promise<T>, gone: T): Promise<T> {
  try { return await run(); } catch (error) { if (isGone(error)) return gone; throw error; }
}
/** DeleteVolume on a volume EC2 is already deleting answers IncorrectState. */
export const isVolumeGone = (error: unknown) => error instanceof Error && (error.name === "InvalidVolume.NotFound" || (error.name === "IncorrectState" && /delet/i.test(error.message)));
const tagMap = (tags: Array<{ Key?: string; Value?: string }> | undefined) => Object.fromEntries((tags ?? []).flatMap((tag) => (tag.Key === undefined ? [] : [[tag.Key, tag.Value ?? ""]])));
const workerFilters = (env: string) => [
  { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] }, { Name: "tag:Environment", Values: [env] }, { Name: "tag:agentx:env", Values: [env] },
];

const TABLE_RETRY_MS = 5_000;
const TABLE_ATTEMPTS = 36;
/** EC2 deletes a worker's root volume itself on termination: those are not ours to delete. */
const VOLUME_STATES = ["creating", "available", "in-use", "error"];

export function awsDestroyApi(
  clients: { cloudFormation: Send; ec2: Send; s3: Send; dynamodb: Send; logs: Send; cognito: Send; kms: Send; secrets: Send },
  options: { sleep?: (ms: number) => Promise<void> } = {},
): DestroyApi {
  const { cloudFormation, ec2, s3, dynamodb, logs, cognito, kms, secrets } = clients;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const events = async (name: string) => ((await cloudFormation.send(new DescribeStackEventsCommand({ StackName: name }))) as { StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string; ResourceStatusReason?: string }> }).StackEvents ?? [];
  return {
    stack: (name) => unlessGone(async () => {
      const stack = ((await cloudFormation.send(new DescribeStacksCommand({ StackName: name }))) as { Stacks?: Stack[] }).Stacks?.[0];
      if (stack === undefined || stack.StackStatus === "DELETE_COMPLETE") return undefined;
      return {
        status: stack.StackStatus ?? "UNKNOWN", terminationProtection: stack.EnableTerminationProtection === true,
        ...(stack.RoleARN === undefined ? {} : { roleArn: stack.RoleARN }),
        outputs: Object.fromEntries((stack.Outputs ?? []).flatMap((output) => (output.OutputKey === undefined ? [] : [[output.OutputKey, output.OutputValue ?? ""]]))),
      };
    }, undefined),
    async template(name) {
      return ((await cloudFormation.send(new GetTemplateCommand({ StackName: name, TemplateStage: "Original" }))) as { TemplateBody?: string }).TemplateBody ?? "{}";
    },
    async stackResources(name) {
      const resources: Array<{ logicalId: string; type: string; physicalId: string | undefined }> = [];
      let token: string | undefined;
      do {
        const page = (await cloudFormation.send(new ListStackResourcesCommand({ StackName: name, ...(token === undefined ? {} : { NextToken: token }) }))) as { StackResourceSummaries?: Array<{ LogicalResourceId?: string; ResourceType?: string; PhysicalResourceId?: string }>; NextToken?: string };
        resources.push(...(page.StackResourceSummaries ?? []).map((entry) => ({ logicalId: entry.LogicalResourceId ?? "", type: entry.ResourceType ?? "", physicalId: entry.PhysicalResourceId })));
        token = page.NextToken;
      } while (token !== undefined);
      return resources;
    },
    async disableTerminationProtection(name) { await cloudFormation.send(new UpdateTerminationProtectionCommand({ StackName: name, EnableTerminationProtection: false })); },
    // No RoleARN: CloudFormation deletes with the role the stack was deployed through.
    async deleteStack(name) {
      const token = `agentx-destroy-${randomUUID()}`;
      await cloudFormation.send(new DeleteStackCommand({ StackName: name, ClientRequestToken: token }));
      return token;
    },
    async latestEvent(name) {
      const latest = (await events(name))[0];
      return latest === undefined ? undefined : `${latest.LogicalResourceId ?? "stack"} ${latest.ResourceStatus ?? ""}`.trim();
    },
    async failedResources(name, token) {
      // Events come newest first. Stop at the stack's own latest DELETE_IN_PROGRESS: anything older
      // belongs to an earlier delete (a failed earlier run) and is not this delete's failure.
      const failed: string[] = [];
      let next: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const answer = (await cloudFormation.send(new DescribeStackEventsCommand({ StackName: name, ...(next === undefined ? {} : { NextToken: next }) }))) as { StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string; ResourceStatusReason?: string; ClientRequestToken?: string }>; NextToken?: string };
        for (const event of answer.StackEvents ?? []) {
          // With this delete's own token, events of any other request are never this delete's.
          if (token !== undefined && event.ClientRequestToken !== token) continue;
          if (event.LogicalResourceId === name && event.ResourceStatus === "DELETE_IN_PROGRESS") return failed;
          if (event.ResourceStatus === "DELETE_FAILED" && event.LogicalResourceId !== name) failed.push(`${event.LogicalResourceId ?? "resource"}: ${event.ResourceStatusReason ?? "no reason given"}`);
        }
        next = answer.NextToken;
        if (next === undefined) break;
      }
      return failed;
    },
    async workerInstances(env) {
      const found: Array<{ id: string; state: string; tags: Record<string, string> }> = [];
      let token: string | undefined;
      do {
        const page = (await ec2.send(new DescribeInstancesCommand({ Filters: [...workerFilters(env), { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] }], ...(token === undefined ? {} : { NextToken: token }) }))) as { Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string }; Tags?: Array<{ Key?: string; Value?: string }> }> }>; NextToken?: string };
        for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
          const tags = tagMap(instance.Tags);
          if (instance.InstanceId !== undefined && isOwnedWorker(env, tags)) found.push({ id: instance.InstanceId, state: instance.State?.Name ?? "unknown", tags });
        }
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async terminateInstances(ids) { if (ids.length > 0) await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids })); },
    async workerVolumes(env) {
      const found: Array<{ id: string; state: string; tags: Record<string, string> }> = [];
      let token: string | undefined;
      do {
        const page = (await ec2.send(new DescribeVolumesCommand({ Filters: [...workerFilters(env), { Name: "status", Values: VOLUME_STATES }], ...(token === undefined ? {} : { NextToken: token }) }))) as { Volumes?: Array<{ VolumeId?: string; State?: string; Tags?: Array<{ Key?: string; Value?: string }> }>; NextToken?: string };
        for (const volume of page.Volumes ?? []) {
          const tags = tagMap(volume.Tags);
          if (volume.VolumeId !== undefined && VOLUME_STATES.includes(volume.State ?? "") && isOwnedWorker(env, tags)) found.push({ id: volume.VolumeId, state: volume.State ?? "unknown", tags });
        }
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async deleteVolume(id) {
      try {
        await ec2.send(new DeleteVolumeCommand({ VolumeId: id }));
      } catch (error) {
        if (isVolumeGone(error)) return;
        throw error;
      }
    },
    async resourceTags(resource) {
      const id = resource.physicalId;
      switch (resource.type) {
        case "AWS::S3::Bucket":
          try {
            return tagMap(((await s3.send(new GetBucketTaggingCommand({ Bucket: id }))) as { TagSet?: Array<{ Key?: string; Value?: string }> }).TagSet);
          } catch (error) {
            if (error instanceof Error && error.name === "NoSuchTagSet") return {};
            if (isGone(error)) return undefined;
            throw error;
          }
        case "AWS::DynamoDB::Table":
          return unlessGone(async () => {
            const arn = ((await dynamodb.send(new DescribeTableCommand({ TableName: id }))) as { Table?: { TableArn?: string } }).Table?.TableArn;
            return arn === undefined ? undefined : tagMap(((await dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: arn }))) as { Tags?: Array<{ Key?: string; Value?: string }> }).Tags);
          }, undefined);
        case "AWS::Logs::LogGroup":
          return unlessGone(async () => {
            // The prefix also matches longer names, so read every page for the exact one.
            let arn: string | undefined;
            let token: string | undefined;
            do {
              const page = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: id, ...(token === undefined ? {} : { nextToken: token }) }))) as { logGroups?: Array<{ logGroupName?: string; logGroupArn?: string }>; nextToken?: string };
              arn = (page.logGroups ?? []).find((group) => group.logGroupName === id)?.logGroupArn;
              token = page.nextToken;
            } while (arn === undefined && token !== undefined);
            return arn === undefined ? undefined : ((await logs.send(new ListTagsForResourceCommand({ resourceArn: arn }))) as { tags?: Record<string, string> }).tags ?? {};
          }, undefined);
        case "AWS::Cognito::UserPool":
          return unlessGone(async () => ((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: id }))) as { UserPool?: { UserPoolTags?: Record<string, string> } }).UserPool?.UserPoolTags ?? {}, undefined);
        case "AWS::KMS::Key":
          return unlessGone(async () => Object.fromEntries((((await kms.send(new ListResourceTagsCommand({ KeyId: id }))) as { Tags?: Array<{ TagKey?: string; TagValue?: string }> }).Tags ?? []).flatMap((tag) => (tag.TagKey === undefined ? [] : [[tag.TagKey, tag.TagValue ?? ""]]))), undefined);
        case "AWS::SecretsManager::Secret":
          return unlessGone(async () => tagMap(((await secrets.send(new DescribeSecretCommand({ SecretId: id }))) as { Tags?: Array<{ Key?: string; Value?: string }> }).Tags), undefined);
        default:
          return {};
      }
    },
    async deleteBucket(name, onProgress) {
      let deleted = 0;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      try {
        for (;;) {
          const page = (await s3.send(new ListObjectVersionsCommand({ Bucket: name, ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }), ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }) }))) as { Versions?: Array<{ Key?: string; VersionId?: string }>; DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>; IsTruncated?: boolean; NextKeyMarker?: string; NextVersionIdMarker?: string };
          const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((entry) => (entry.Key === undefined ? [] : [{ Key: entry.Key, ...(entry.VersionId === undefined ? {} : { VersionId: entry.VersionId }) }]));
          for (let start = 0; start < objects.length; start += 1000) {
            const batch = objects.slice(start, start + 1000);
            const result = (await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: batch, Quiet: true } }))) as { Errors?: Array<{ Key?: string; Code?: string }> };
            if ((result.Errors ?? []).length > 0) throw agentXError("RUNTIME_UNAVAILABLE", `bucket ${name}: ${result.Errors!.length} objects could not be deleted (${result.Errors![0]?.Code ?? "no code"}); run agentx destroy again`);
            deleted += batch.length;
            onProgress(deleted);
          }
          if (page.IsTruncated !== true) break;
          keyMarker = page.NextKeyMarker;
          versionMarker = page.NextVersionIdMarker;
        }
        await s3.send(new DeleteBucketCommand({ Bucket: name }));
      } catch (error) {
        if (isGone(error)) return;
        throw error;
      }
    },
    async deleteTable(name) {
      await unlessGone(async () => {
        const table = ((await dynamodb.send(new DescribeTableCommand({ TableName: name }))) as { Table?: { TableStatus?: string; DeletionProtectionEnabled?: boolean } }).Table;
        if (table === undefined || table.TableStatus === "DELETING") return;
        // The table stays busy (ResourceInUseException) while an update settles, the protection
        // change included, so both calls are retried.
        const whenFree = async (run: () => Promise<unknown>) => {
          for (let attempt = 1; ; attempt += 1) {
            try {
              await run();
              return;
            } catch (error) {
              if (!(error instanceof Error && error.name === "ResourceInUseException")) throw error;
              if (attempt >= TABLE_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", `table ${name} is still busy after ${(TABLE_ATTEMPTS * TABLE_RETRY_MS) / 60_000} minutes; run agentx destroy again to continue`);
              await sleep(TABLE_RETRY_MS);
            }
          }
        };
        if (table.DeletionProtectionEnabled === true) await whenFree(() => dynamodb.send(new UpdateTableCommand({ TableName: name, DeletionProtectionEnabled: false })));
        await whenFree(() => dynamodb.send(new DeleteTableCommand({ TableName: name })));
      }, undefined);
    },
    async deleteLogGroup(name) { await unlessGone(() => logs.send(new DeleteLogGroupCommand({ logGroupName: name })), undefined); },
    async deleteUserPool(id, domainPrefix) {
      await unlessGone(async () => {
        const pool = ((await cognito.send(new DescribeUserPoolCommand({ UserPoolId: id }))) as { UserPool?: { DeletionProtection?: string; Domain?: string } }).UserPool;
        if (pool === undefined) return;
        if (pool.Domain !== undefined && pool.Domain !== domainPrefix) {
          throw agentXError("CONFIG_INVALID", `user pool ${id} has the domain ${pool.Domain}, which is not ${domainPrefix}; delete that domain yourself, then run agentx destroy again`);
        }
        // UpdateUserPool resets settings it is not given; the pool is deleted next, so that is fine.
        if (pool.DeletionProtection === "ACTIVE") await cognito.send(new UpdateUserPoolCommand({ UserPoolId: id, DeletionProtection: "INACTIVE" }));
        if (pool.Domain !== undefined) await cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: id, Domain: pool.Domain }));
        await cognito.send(new DeleteUserPoolCommand({ UserPoolId: id }));
      }, undefined);
    },
    async scheduleKeyDeletion(keyId) {
      // A key whose 7 days have passed is gone: a re-run counts it as already scheduled.
      return unlessGone<"scheduled" | "already">(async () => {
        const state = ((await kms.send(new DescribeKeyCommand({ KeyId: keyId }))) as { KeyMetadata?: { KeyState?: string } }).KeyMetadata?.KeyState;
        if (state === "PendingDeletion") return "already";
        await kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
        return "scheduled";
      }, "already");
    },
    async aliases(env) {
      const found: Array<{ name: string }> = [];
      let marker: string | undefined;
      do {
        const page = (await kms.send(new ListAliasesCommand({ ...(marker === undefined ? {} : { Marker: marker }) }))) as { Aliases?: Array<{ AliasName?: string }>; NextMarker?: string; Truncated?: boolean };
        found.push(...(page.Aliases ?? []).flatMap((alias) => (alias.AliasName !== undefined && isOwnedAlias(env, alias.AliasName) ? [{ name: alias.AliasName }] : [])));
        marker = page.Truncated === true ? page.NextMarker : undefined;
      } while (marker !== undefined);
      return found;
    },
    async deleteAlias(name) { await unlessGone(() => kms.send(new DeleteAliasCommand({ AliasName: name })), undefined); },
    async secrets(env) {
      const found: Array<{ name: string; scheduled: boolean }> = [];
      let token: string | undefined;
      do {
        const page = (await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [`agentx/${env}/`] }], IncludePlannedDeletion: true, ...(token === undefined ? {} : { NextToken: token }) }))) as { SecretList?: Array<{ Name?: string; DeletedDate?: Date }>; NextToken?: string };
        found.push(...(page.SecretList ?? []).flatMap((secret) => (secret.Name !== undefined && isOwnedSecret(env, secret.Name) ? [{ name: secret.Name, scheduled: secret.DeletedDate !== undefined }] : [])));
        token = page.NextToken;
      } while (token !== undefined);
      return found;
    },
    async deleteSecret(name) {
      await unlessGone(async () => {
        // A secret already scheduled for deletion (by an earlier run, or by hand) keeps its name until
        // the window ends; restoring it first lets the force delete free the name for a reinstall now.
        const scheduled = ((await secrets.send(new DescribeSecretCommand({ SecretId: name }))) as { DeletedDate?: Date }).DeletedDate !== undefined;
        if (scheduled) await secrets.send(new RestoreSecretCommand({ SecretId: name }));
        await secrets.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
      }, undefined);
    },
  };
}
