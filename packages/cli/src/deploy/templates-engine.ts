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
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { DeployEvent, DeployRequest, StackDeployer, StackOutputs } from "./deployer.js";
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
const NO_CHANGES = ["didn't contain changes", "No updates are to be performed"];

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

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
  /** read lazily: known only after the access stack exists */
  artifactBucket: () => string;
  now?: () => number;
  pollMs?: number;
}): StackDeployer {
  const { clients, release, env, region } = input;
  const cloudFormation = clients.cloudFormation;
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const version = release.manifest.version;
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, pollMs));

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
      emit({ kind: "uploading", what: `package ${pkg.assetId}` });
      const body = await readFile(release.packagePath(pkg.assetId));
      await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip", Metadata: { sha256: pkg.sha256 } }));
    }
  }

  /** Uploads the template and returns where CreateChangeSet finds it; the access stack's goes inline. */
  async function templateSource(request: DeployRequest, emit: (event: DeployEvent) => void): Promise<{ TemplateURL: string } | { TemplateBody: string }> {
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
    return { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/${key}` };
  }

  /** CREATE for a missing stack or one awaiting its first change set; UPDATE when it can be updated; otherwise throws saying what to do. */
  function changeSetType(stackName: string, stack: Stack | undefined): "CREATE" | "UPDATE" {
    if (stack === undefined) return "CREATE";
    const status = stack.StackStatus ?? "";
    if (status === "ROLLBACK_COMPLETE") {
      throw new Error(
        `stack ${stackName} failed to create earlier and must be deleted before it can be deployed again (aws cloudformation delete-stack --stack-name ${stackName})`,
      );
    }
    // A stack in REVIEW_IN_PROGRESS has only ever had a CREATE change set that was never executed.
    if (status === "REVIEW_IN_PROGRESS") return "CREATE";
    if (status.endsWith("_IN_PROGRESS")) throw new Error(`stack ${stackName} is busy (${status}); try again when it finishes`);
    if (status.endsWith("_FAILED")) throw new Error(`stack ${stackName} is ${status}; fix it in the AWS console before deploying`);
    return "UPDATE";
  }

  /** Polls until the change set is CREATE_COMPLETE (returning all its changes) or FAILED (returning its reason). */
  async function awaitChangeSet(stackName: string, changeSetName: string): Promise<{ failed: false; changes: Change[] } | { failed: true; reason: string }> {
    for (;;) {
      const described = await cloudFormation.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
      if (described.Status === "FAILED") return { failed: true, reason: described.StatusReason ?? "no reason given" };
      if (described.Status === "CREATE_COMPLETE") {
        const changes = [...(described.Changes ?? [])];
        let nextToken = described.NextToken;
        while (nextToken !== undefined) {
          const page = await cloudFormation.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName, NextToken: nextToken }));
          changes.push(...(page.Changes ?? []));
          nextToken = page.NextToken;
        }
        return { failed: false, changes };
      }
      await wait();
    }
  }

  async function deleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    await cloudFormation.send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
  }

  /** Polls until the stack leaves every *_IN_PROGRESS status. */
  async function awaitStack(stackName: string): Promise<Stack> {
    for (;;) {
      const stack = await describeStack(stackName);
      if (stack === undefined) throw new Error(`stack ${stackName} disappeared while deploying`);
      if (!(stack.StackStatus ?? "").endsWith("_IN_PROGRESS")) return stack;
      await wait();
    }
  }

  /** The newest FAILED resource status reason (DescribeStackEvents lists newest first). */
  async function latestFailureReason(stackName: string): Promise<string> {
    const { StackEvents } = await cloudFormation.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const failed = (StackEvents ?? []).find((event) => (event.ResourceStatus ?? "").endsWith("_FAILED") && event.ResourceStatusReason !== undefined);
    return failed?.ResourceStatusReason ?? "no failed resource reported a reason";
  }

  async function deploy(request: DeployRequest): Promise<StackOutputs> {
    const { stackName } = request;
    const emit = (event: DeployEvent) => request.onEvent?.(event);

    const source = await templateSource(request, emit);
    const current = await describeStack(stackName);
    const type = changeSetType(stackName, current);

    const changeSetName = `agentx-${version.replaceAll(".", "-")}-${Math.floor(now() / 1000)}`;
    await cloudFormation.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: type,
        ...source,
        Parameters: Object.entries(request.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
        Capabilities: [...CAPABILITIES],
        ...(request.roleArn === undefined ? {} : { RoleARN: request.roleArn }),
      }),
    );

    const changeSet = await awaitChangeSet(stackName, changeSetName);
    if (changeSet.failed) {
      if (NO_CHANGES.some((phrase) => changeSet.reason.includes(phrase))) {
        await deleteChangeSet(stackName, changeSetName);
        emit({ kind: "no-changes", stackName });
        return current === undefined ? {} : stackOutputs(current);
      }
      let cleanup = "";
      try {
        await deleteChangeSet(stackName, changeSetName);
      } catch {
        cleanup = ` (the failed change set ${changeSetName} could not be deleted)`;
      }
      throw new Error(`change set for ${stackName} failed: ${changeSet.reason}${cleanup}`);
    }

    emit({ kind: "changes", stackName, changes: describedChanges(changeSet.changes) });
    await cloudFormation.send(new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
    emit({ kind: "deploying", stackName });

    const deployed = await awaitStack(stackName);
    const status = deployed.StackStatus ?? "";
    if (status !== "CREATE_COMPLETE" && status !== "UPDATE_COMPLETE") {
      throw new Error(`stack ${stackName} ended in ${status}: ${await latestFailureReason(stackName)}`);
    }

    if (type === "CREATE" && request.terminationProtection) {
      await cloudFormation.send(new UpdateTerminationProtectionCommand({ StackName: stackName, EnableTerminationProtection: true }));
    }
    emit({ kind: "deployed", stackName });
    return stackOutputs(deployed);
  }

  return {
    async deploy(request) {
      const redact = redactor(request.parameters);
      try {
        return await deploy(request);
      } catch (error) {
        // Rebuild any error whose message carries a secret value, so neither the message nor the stack does.
        if (error instanceof Error && redact(error.message) !== error.message) {
          const safe = new Error(redact(error.message));
          safe.name = error.name;
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
