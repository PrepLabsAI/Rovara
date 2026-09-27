// The templates deploy engine: deploys a release's pre-synthesized templates with the AWS SDK. Code
// packages and templates go to the access stack's artifact bucket; each stack is deployed as a
// CloudFormation change set through the service role (the access stack, which creates that role and
// bucket, is deployed inline with the caller's own credentials).
import { readFile } from "node:fs/promises";
import {
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  UpdateTerminationProtectionCommand,
  type Change,
  type CloudFormationClient,
  type DescribeChangeSetCommandOutput,
  type Stack,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { AgentXError, agentXError } from "@agentx/contracts";
import type { DeployEvent, DeployRequest, StackDeployer, StackOutputs } from "./deployer.js";
import { sha256Hex } from "./hash.js";
import { SECRET_PARAMETERS } from "./parameters.js";
import type { LoadedRelease } from "./release.js";

export interface TemplatesEngineClients {
  cloudFormation: CloudFormationClient;
  s3: S3Client;
}

/** CloudFormation's limit on an inline TemplateBody. */
const MAX_INLINE_TEMPLATE_BYTES = 51_200;
const CAPABILITIES = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] as const;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const NO_CHANGES = ["didn't contain changes", "No updates are to be performed"];
/** Change set execution statuses after which the stack operation it started is over. */
const EXECUTION_ENDED = new Set(["EXECUTE_COMPLETE", "EXECUTE_FAILED", "OBSOLETE"]);
/** Change set statuses meaning it is gone or going: fail fast instead of waiting for the timeout. */
const DELETED_CHANGE_SET_STATUSES = new Set(["DELETE_PENDING", "DELETE_IN_PROGRESS", "DELETE_COMPLETE", "DELETE_FAILED"]);
/** Looking for this deploy's rollback reason pages through stack events at most this many times, even if none of
 * them ever carries this deploy's ClientRequestToken. */
const MAX_EVENT_PAGES = 20;

/** "1 minute" or "N minutes"; never grammatically wrong the way a bare `${n} minutes` would be at n=1. */
function minutesPhrase(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** S3's DNS suffix per partition. */
const S3_HOST_SUFFIX: Readonly<Record<string, string>> = {
  aws: "amazonaws.com",
  "aws-cn": "amazonaws.com.cn",
  "aws-us-gov": "amazonaws.com",
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** DescribeStacks on a missing stack throws a ValidationError saying it does not exist; nothing else means absent. */
function isStackAbsent(error: unknown): boolean {
  return errorName(error) === "ValidationError" && error instanceof Error && /does not exist/.test(error.message);
}

/** HeadObject on a missing key throws NotFound (a 404 with no body). */
function isObjectAbsent(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  return errorName(error) === "NotFound" || status === 404;
}

function stackOutputs(stack: Stack): StackOutputs {
  const outputs: StackOutputs = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) outputs[output.OutputKey] = output.OutputValue;
  }
  return outputs;
}

/** Whether the stack last changed (its last update, or its creation if never updated) at or after `since`. */
function changedSince(stack: Stack, since: number): boolean {
  const changed = stack.LastUpdatedTime ?? stack.CreationTime;
  return changed !== undefined && changed.getTime() >= since;
}

function describedChanges(changes: Change[]): Extract<DeployEvent, { kind: "changes" }>["changes"] {
  return changes.flatMap((change) =>
    change.ResourceChange === undefined
      ? []
      : [
          {
            action: change.ResourceChange.Action ?? "",
            logicalId: change.ResourceChange.LogicalResourceId ?? "",
            type: change.ResourceChange.ResourceType ?? "",
            replacement: change.ResourceChange.Replacement ?? "",
          },
        ],
  );
}

/** The SDK names this ChangeSetNotFoundException; its message is "ChangeSet [<name>] does not exist". */
function isChangeSetNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === "ChangeSetNotFoundException" || error.name === "ChangeSetNotFound");
}

/** Replaces every secret parameter's value in text; CloudFormation and the SDK may echo parameter values in reasons and errors. */
function redactor(parameters: Record<string, string>): (text: string) => string {
  const secrets = [...SECRET_PARAMETERS].map((name) => parameters[name]).filter((value): value is string => value !== undefined && value !== "");
  return (text) => secrets.reduce((redacted, secret) => redacted.split(secret).join("<redacted>"), text);
}

export function templatesDeployer(input: {
  clients: TemplatesEngineClients;
  release: LoadedRelease;
  env: string;
  region: string;
  /** default "aws" */
  partition?: string;
  /** read lazily: known only after the access stack exists */
  artifactBucket: () => string;
  now?: () => number;
  pollMs?: number;
  /** How long one deploy may wait on CloudFormation; default 3 hours. */
  timeoutMs?: number;
}): StackDeployer {
  const { clients, release, env, region } = input;
  const cloudFormation = clients.cloudFormation;
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const version = release.manifest.version;
  const partition = input.partition ?? "aws";
  const s3HostSuffix = S3_HOST_SUFFIX[partition];
  if (s3HostSuffix === undefined) throw new Error(`unknown partition ${partition}; expected aws, aws-cn, or aws-us-gov`);

  async function describeStack(stackName: string): Promise<Stack | undefined> {
    try {
      const { Stacks } = await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = Stacks?.[0];
      if (stack === undefined) throw new Error(`DescribeStacks returned no stack for ${stackName}`);
      return stack;
    } catch (error) {
      if (isStackAbsent(error)) return undefined;
      throw error;
    }
  }

  async function uploadPackages(request: DeployRequest, bucket: string, emit: (event: DeployEvent) => void): Promise<void> {
    for (const pkg of release.manifest.packages) {
      if (!pkg.parts.includes(request.part)) continue;
      const key = `packages/${pkg.assetId}.zip`;
      let recorded: string | undefined;
      try {
        const head = await clients.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        recorded = head.Metadata?.sha256;
      } catch (error) {
        if (!isObjectAbsent(error)) throw error;
      }
      if (recorded === pkg.sha256) continue;
      const body = await readFile(release.packagePath(pkg.assetId));
      // The file was verified when the release was loaded; check the bytes actually uploaded too.
      const actual = sha256Hex(body);
      if (actual !== pkg.sha256) throw new Error(`release file ${pkg.file} does not match release.json`);
      emit({ kind: "uploading", what: `package ${pkg.assetId}` });
      await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip", Metadata: { sha256: actual } }));
    }
  }

  /** Uploads the template and returns where CreateChangeSet finds it; the access stack's goes inline. */
  async function templateSource(request: DeployRequest, emit: (event: DeployEvent) => void): Promise<{ TemplateURL: string } | { TemplateBody: string }> {
    if (!release.regions().includes(region)) {
      throw agentXError("CONFIG_INVALID", `release ${version} does not cover region ${region}; it covers: ${release.regions().join(", ") || "no region"}`);
    }
    const text = release.template(request.part, region, env);
    if (request.part === "access") {
      if (Buffer.byteLength(text, "utf8") > MAX_INLINE_TEMPLATE_BYTES) throw new Error("the access template is too large to deploy inline");
      return { TemplateBody: text };
    }
    const bucket = input.artifactBucket();
    await uploadPackages(request, bucket, emit);
    const key = `templates/${version}/${region}/${request.part}.template.json`;
    emit({ kind: "uploading", what: `template ${key}` });
    await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: "application/json" }));
    return { TemplateURL: `https://${bucket}.s3.${region}.${s3HostSuffix}/${key}` };
  }

  /** CREATE for a missing stack or one awaiting its first change set; UPDATE when it can be updated; otherwise refuses (CONFIG_INVALID) saying what to do. */
  function changeSetType(stackName: string, stack: Stack | undefined): "CREATE" | "UPDATE" {
    if (stack === undefined) return "CREATE";
    const status = stack.StackStatus ?? "";
    if (status === "ROLLBACK_COMPLETE") {
      throw agentXError(
        "CONFIG_INVALID",
        `stack ${stackName} failed to create earlier and must be deleted before it can be deployed again (aws cloudformation delete-stack --stack-name ${stackName} --region ${region})`,
      );
    }
    // A stack in REVIEW_IN_PROGRESS has only ever had a CREATE change set that was never executed.
    if (status === "REVIEW_IN_PROGRESS") return "CREATE";
    if (status.endsWith("_IN_PROGRESS")) throw agentXError("CONFIG_INVALID", `stack ${stackName} is busy (${status}); try again when it finishes`);
    if (status.endsWith("_FAILED")) throw agentXError("CONFIG_INVALID", `stack ${stackName} is ${status}; fix it in the AWS console before deploying`);
    return "UPDATE";
  }

  async function deploy(request: DeployRequest): Promise<StackOutputs> {
    const { stackName } = request;
    const emit = (event: DeployEvent) => request.onEvent?.(event);
    const startedAt = now();
    const changeSetName = `agentx-${version.replaceAll(".", "-")}-${Math.floor(startedAt / 1000)}`;
    const changeSetId = { StackName: stackName, ChangeSetName: changeSetName };

    /** Waits one poll interval while the stack is `status`, or throws once this deploy has waited longer than the timeout. */
    async function waitForStack(status: string): Promise<void> {
      if (now() - startedAt >= timeoutMs) {
        throw new Error(
          `stack ${stackName} is still ${status} after ${minutesPhrase(timeoutMs)}; it may still finish; watch it with aws cloudformation describe-stacks --stack-name ${stackName}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }

    /** Best-effort delete of this deploy's change set: never throws, only describes what happened. */
    async function attemptChangeSetDelete(): Promise<string> {
      try {
        await cloudFormation.send(new DeleteChangeSetCommand(changeSetId));
        return "; it was deleted";
      } catch (error) {
        return `; it could not be deleted: ${errorMessage(error)}`;
      }
    }

    /**
     * Polls until the change set is CREATE_COMPLETE (returning it with all its changes) or FAILED. Fails fast,
     * without waiting for the timeout, when the change set is already being deleted or is gone. On a timeout,
     * names the change set's own status (never the stack's, which may already have moved on) and makes a
     * best-effort attempt to delete the stalled change set, mentioning the outcome either way.
     */
    async function awaitChangeSet(): Promise<DescribeChangeSetCommandOutput> {
      for (;;) {
        const described = await cloudFormation.send(new DescribeChangeSetCommand(changeSetId));
        const status = described.Status ?? "";
        if (status === "FAILED") return described;
        if (DELETED_CHANGE_SET_STATUSES.has(status)) {
          throw new Error(`change set ${changeSetName} for stack ${stackName} is ${status}; deploy again`);
        }
        if (status === "CREATE_COMPLETE") {
          const changes = [...(described.Changes ?? [])];
          let nextToken = described.NextToken;
          while (nextToken !== undefined) {
            const page = await cloudFormation.send(new DescribeChangeSetCommand({ ...changeSetId, NextToken: nextToken }));
            changes.push(...(page.Changes ?? []));
            nextToken = page.NextToken;
          }
          return { ...described, Changes: changes };
        }
        if (now() - startedAt >= timeoutMs) {
          const shown = status === "" ? "creating its change set" : status;
          const outcome = await attemptChangeSetDelete();
          throw new Error(`change set ${changeSetName} for stack ${stackName} is still ${shown} after ${minutesPhrase(timeoutMs)}${outcome}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }
    }

    /** Deletes the change set; when that fails, throws naming what happened before and why the delete failed. */
    async function deleteChangeSet(before: string): Promise<void> {
      try {
        await cloudFormation.send(new DeleteChangeSetCommand(changeSetId));
      } catch (error) {
        throw new Error(`${before}, and its change set ${changeSetName} could not be deleted: ${errorMessage(error)}`, { cause: error });
      }
    }

    /**
     * Polls the change set until the stack operation it started is over, then the stack until it is settled.
     * CloudFormation can remove an executed change set while the operation runs (seen live creating a new
     * stack), so a change set that is gone hands over to the stack, whose status is the real outcome. The
     * stack may not have started this operation yet when that happens, so a settled status then counts
     * only when the stack last changed at or after `executedAt`; an older one is the previous operation's
     * result and polling continues (within the timeout).
     */
    async function awaitExecution(executedAt: number): Promise<Stack> {
      let changeSetGone = false;
      for (;;) {
        let executionStatus: string;
        try {
          const { ExecutionStatus } = await cloudFormation.send(new DescribeChangeSetCommand(changeSetId));
          executionStatus = ExecutionStatus ?? "";
        } catch (error) {
          if (isChangeSetNotFound(error)) {
            changeSetGone = true;
            break;
          }
          throw error;
        }
        if (EXECUTION_ENDED.has(executionStatus)) break;
        await waitForStack(executionStatus === "" ? "executing its change set" : executionStatus);
      }
      for (;;) {
        const stack = await describeStack(stackName);
        if (stack === undefined) throw new Error(`stack ${stackName} disappeared while deploying`);
        const status = stack.StackStatus ?? "";
        if (!status.endsWith("_IN_PROGRESS") && (!changeSetGone || changedSince(stack, executedAt))) return stack;
        await waitForStack(status);
      }
    }

    /** The root cause of this deploy's failure: the oldest FAILED resource reason from this operation (by its request token) that isn't a cancellation. */
    async function failureReason(stack: Stack, token: string): Promise<string> {
      const ours: StackEvent[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      paging: for (;;) {
        pages++;
        const page = await cloudFormation.send(new DescribeStackEventsCommand({ StackName: stackName, ...(nextToken === undefined ? {} : { NextToken: nextToken }) }));
        const events = page.StackEvents ?? [];
        for (const event of events) {
          // Events are newest first: once a page reaches an event older than this deploy started, nothing
          // further back can be ours, no matter how many pages remain.
          if (event.Timestamp !== undefined && event.Timestamp.getTime() < startedAt) break paging;
          if (event.ClientRequestToken === token) ours.push(event);
        }
        // Once we've found some of ours, a page that also carries a foreign token means we've reached events
        // from before this operation began.
        if (ours.length > 0 && events.some((event) => event.ClientRequestToken !== token)) break;
        nextToken = page.NextToken;
        if (nextToken === undefined || pages >= MAX_EVENT_PAGES) break;
      }
      const rootCause = ours
        .filter((event) => (event.ResourceStatus ?? "").endsWith("_FAILED") && event.ResourceStatusReason !== undefined)
        .filter((event) => !/cancelled/i.test(event.ResourceStatusReason ?? ""))
        .at(-1);
      return rootCause?.ResourceStatusReason ?? stack.StackStatusReason ?? "no failed resource reported a reason";
    }

    /** Turns termination protection on when the request asks for it and the stack does not have it yet. */
    async function protect(stack: Stack): Promise<void> {
      if (!request.terminationProtection || stack.EnableTerminationProtection === true) return;
      await cloudFormation.send(new UpdateTerminationProtectionCommand({ StackName: stackName, EnableTerminationProtection: true }));
    }

    const source = await templateSource(request, emit);
    const current = await describeStack(stackName);
    const type = changeSetType(stackName, current);

    await cloudFormation.send(
      new CreateChangeSetCommand({
        ...changeSetId,
        ChangeSetType: type,
        ...source,
        Parameters: Object.entries(request.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
        Capabilities: [...CAPABILITIES],
        ...(request.roleArn === undefined ? {} : { RoleARN: request.roleArn }),
      }),
    );

    const changeSet = await awaitChangeSet();
    const reason = changeSet.StatusReason ?? "no reason given";
    if (changeSet.Status === "FAILED") {
      if (current !== undefined && NO_CHANGES.some((phrase) => reason.includes(phrase))) {
        await deleteChangeSet(`stack ${stackName} has no changes`);
        await protect(current);
        emit({ kind: "no-changes", stackName });
        return stackOutputs(current);
      }
      const failure = `change set for ${stackName} failed: ${reason}`;
      await deleteChangeSet(failure);
      throw agentXError("CONFIG_INVALID", failure);
    }
    if (changeSet.ExecutionStatus !== "AVAILABLE") {
      const failure = `change set for ${stackName} cannot be executed (${changeSet.ExecutionStatus ?? "no execution status"}): ${reason}`;
      await deleteChangeSet(failure);
      throw agentXError("CONFIG_INVALID", failure);
    }

    const changes = describedChanges(changeSet.Changes ?? []);
    emit({ kind: "changes", stackName, changes });
    if (request.confirm !== undefined) {
      const proceed = await request.confirm({ stackName, changes });
      if (!proceed) {
        // Best effort: whether or not the delete itself succeeds, the deploy was declined, and that
        // (not the delete's own outcome) is the whole story here.
        await attemptChangeSetDelete();
        throw new Error(`deploy of ${stackName} not executed; confirmation declined`);
      }
    }
    // Every stack event this execution causes carries this token, which picks out its failures later.
    const token = changeSetName;
    const executedAt = now();
    await cloudFormation.send(new ExecuteChangeSetCommand({ ...changeSetId, ClientRequestToken: token }));
    emit({ kind: "deploying", stackName });

    const deployed = await awaitExecution(executedAt);
    const status = deployed.StackStatus ?? "";
    if (status !== "CREATE_COMPLETE" && status !== "UPDATE_COMPLETE") {
      throw new Error(`stack ${stackName} ended in ${status}: ${await failureReason(deployed, token)}`);
    }

    await protect(deployed);
    emit({ kind: "deployed", stackName });
    return stackOutputs(deployed);
  }

  return {
    async deploy(request) {
      const redact = redactor(request.parameters);
      try {
        return await deploy(request);
      } catch (error) {
        // Rebuild any error whose message carries a secret value, so neither the message nor the stack
        // does; the request metadata (ids and status only) is kept for support cases.
        if (error instanceof AgentXError && redact(error.message) !== error.message) {
          // Keeps the refusal's code; the message is rebuilt without its "CODE: " prefix, which
          // agentXError adds again.
          throw agentXError(error.code, redact(error.message.slice(`${error.code}: `.length)));
        }
        if (error instanceof Error && redact(error.message) !== error.message) {
          const safe = new Error(redact(error.message));
          safe.name = error.name;
          const metadata = (error as { $metadata?: unknown }).$metadata;
          if (metadata !== undefined) Object.assign(safe, { $metadata: metadata });
          throw safe;
        }
        throw error;
      }
    },
    async outputs(stackName) {
      const stack = await describeStack(stackName);
      return stack === undefined ? undefined : stackOutputs(stack);
    },
  };
}
