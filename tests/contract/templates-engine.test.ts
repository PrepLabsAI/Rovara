import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type { S3Client } from "@aws-sdk/client-s3";
import type { ReleaseManifest } from "@agentx/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { PROTECTED_PARTS, type DeployEvent, type DeployRequest } from "../../packages/cli/src/deploy/deployer.js";
import type { DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { templatesDeployer } from "../../packages/cli/src/deploy/templates-engine.js";

// ---- fakes -------------------------------------------------------------------------------------

type Reply = unknown;
interface Call {
  client: "s3" | "cloudFormation";
  name: string;
  input: Record<string, unknown>;
}

/** An SDK-shaped error: the SDK sets `name` to the service's error code. */
function awsError(name: string, message: string, httpStatusCode = 400): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode, requestId: "request-1" } });
  return error;
}
const notFound = () => awsError("NotFound", "UnknownError", 404);
const stackAbsent = (stackName: string) => awsError("ValidationError", `Stack with id ${stackName} does not exist`);
const stack = (StackStatus: string, outputs: Record<string, string> = {}, extra: { EnableTerminationProtection?: boolean; StackStatusReason?: string } = {}) => ({
  Stacks: [{ StackStatus, Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })), ...extra }],
});
const protectedStack = (StackStatus: string, outputs: Record<string, string> = {}) => stack(StackStatus, outputs, { EnableTerminationProtection: true });
/** A created change set, ready to execute. */
const ready = (Changes: unknown[] = []) => ({ Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes });
/** The change set once the stack operation it started is over. */
const executed = (ExecutionStatus = "EXECUTE_COMPLETE") => ({ Status: "CREATE_COMPLETE", ExecutionStatus });

/**
 * Minimal `{ send(command) }` fakes keyed on the command's class name (without "Command"). Each
 * command name has a queue of scripted replies consumed in order; an Error reply is thrown; a call
 * with no reply left fails the test.
 */
function fakeClients(script: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(script).map(([name, replies]) => [name, [...replies]]));
  const client = (label: Call["client"]) => ({
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name.replace(/Command$/, "");
      calls.push({ client: label, name, input: command.input });
      const queue = queues.get(name);
      if (queue === undefined || queue.length === 0) throw new Error(`unscripted call ${name}`);
      const reply = queue.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return {
    clients: {
      cloudFormation: client("cloudFormation") as unknown as CloudFormationClient,
      s3: client("s3") as unknown as S3Client,
    },
    calls,
    names: () => calls.map((call) => `${call.client}:${call.name}`),
    inputs: (name: string) => calls.filter((call) => call.name === name).map((call) => call.input),
  };
}

// ---- a small fake release ------------------------------------------------------------------------

const RUNTIME_ASSET = "a".repeat(64);
const CONTROL_PLANE_ASSET = "b".repeat(64);
let releaseDir: string;
const zipBytes: Record<string, Buffer> = {
  [RUNTIME_ASSET]: Buffer.from("runtime zip bytes"),
  [CONTROL_PLANE_ASSET]: Buffer.from("control plane zip bytes"),
};
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  releaseDir = await mkdtemp(join(tmpdir(), "agentx-templates-engine-"));
  for (const [assetId, bytes] of Object.entries(zipBytes)) await writeFile(join(releaseDir, `${assetId}.zip`), bytes);
});

function makeRelease(templateText?: (part: DeployPart, region: string, env: string) => string): LoadedRelease {
  const pkg = (assetId: string, part: DeployPart) => ({
    assetId,
    file: `packages/${assetId}.zip`,
    sha256: sha256(zipBytes[assetId]!),
    parts: [part],
    bucketParameter: `AssetParameters${assetId}Bucket`,
    keyParameter: `AssetParameters${assetId}Key`,
    hashParameter: `AssetParameters${assetId}Hash`,
    keyParameterValue: `packages/||${assetId}.zip`,
  });
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: "1.2.3",
    gitCommit: "c".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq",
    templates: [],
    packages: [pkg(RUNTIME_ASSET, "runtime"), pkg(CONTROL_PLANE_ASSET, "control-plane")],
    images: {},
  };
  return {
    manifest,
    dir: releaseDir,
    regions: () => ["us-east-1"],
    template: templateText ?? ((part, region, env) => JSON.stringify({ part, region, env })),
    packagePath: (assetId) => join(releaseDir, `${assetId}.zip`),
  };
}

const NOW = 1_700_000_000_123;
const CHANGE_SET = "agentx-1-2-3-1700000000";
const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";
const TEMPLATE_KEY = (part: DeployPart) => `templates/1.2.3/us-east-1/${part}.template.json`;
const TEMPLATE_URL = (part: DeployPart) => `https://bucket.s3.us-east-1.amazonaws.com/${TEMPLATE_KEY(part)}`;
const NO_CHANGES_REASON = "The submitted information didn't contain changes. Submit different information to create a change set.";

function deployer(fake: ReturnType<typeof fakeClients>, options: { release?: LoadedRelease; artifactBucket?: () => string } = {}) {
  return templatesDeployer({
    clients: fake.clients,
    release: options.release ?? makeRelease(),
    env: "staging",
    region: "us-east-1",
    artifactBucket: options.artifactBucket ?? (() => "bucket"),
    now: () => NOW,
    pollMs: 0,
  });
}

function request(part: DeployPart, extra: Partial<DeployRequest> = {}): DeployRequest & { events: DeployEvent[] } {
  const events: DeployEvent[] = [];
  return {
    part,
    stackName: `agentx-staging-${part}`,
    parameters: { PermissionsBoundaryArn: "" },
    ...(part === "access" ? {} : { roleArn: ROLE }),
    terminationProtection: PROTECTED_PARTS.has(part),
    onEvent: (event) => events.push(event),
    events,
    ...extra,
  };
}

// ---- tests ---------------------------------------------------------------------------------------

describe("templates engine", () => {
  it("creates a new stack with a change set through the service role, and protects it", async () => {
    const fake = fakeClients({
      HeadObject: [notFound()],
      PutObject: [{}, {}],
      // Only the read after the execution is over counts: no stale in-progress read in between.
      DescribeStacks: [stackAbsent("agentx-staging-runtime"), stack("CREATE_COMPLETE", { RuntimeArn: "arn:runtime" })],
      CreateChangeSet: [{ Id: "arn:changeset" }],
      DescribeChangeSet: [
        { Status: "CREATE_IN_PROGRESS", ExecutionStatus: "UNAVAILABLE" },
        ready([
          { Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "Worker", ResourceType: "AWS::BedrockAgentCore::Runtime" } },
          { Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "Role", ResourceType: "AWS::IAM::Role", Replacement: "False" } },
        ]),
        { Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" },
        executed("EXECUTE_IN_PROGRESS"),
        executed(),
      ],
      ExecuteChangeSet: [{}],
      UpdateTerminationProtection: [{}],
    });
    const req = request("runtime", { parameters: { PermissionsBoundaryArn: "", ModelId: "model" } });

    const outputs = await deployer(fake).deploy(req);

    expect(outputs).toEqual({ RuntimeArn: "arn:runtime" });
    expect(fake.names()).toEqual([
      "s3:HeadObject",
      "s3:PutObject",
      "s3:PutObject",
      "cloudFormation:DescribeStacks",
      "cloudFormation:CreateChangeSet",
      "cloudFormation:DescribeChangeSet",
      "cloudFormation:DescribeChangeSet",
      "cloudFormation:ExecuteChangeSet",
      "cloudFormation:DescribeChangeSet",
      "cloudFormation:DescribeChangeSet",
      "cloudFormation:DescribeChangeSet",
      "cloudFormation:DescribeStacks",
      "cloudFormation:UpdateTerminationProtection",
    ]);
    expect(fake.inputs("HeadObject")).toEqual([{ Bucket: "bucket", Key: `packages/${RUNTIME_ASSET}.zip` }]);
    const [packagePut, templatePut] = fake.inputs("PutObject");
    expect(packagePut).toMatchObject({ Bucket: "bucket", Key: `packages/${RUNTIME_ASSET}.zip`, Metadata: { sha256: sha256(zipBytes[RUNTIME_ASSET]!) } });
    expect(Buffer.from(packagePut!.Body as Uint8Array).equals(zipBytes[RUNTIME_ASSET]!)).toBe(true);
    expect(templatePut).toMatchObject({ Bucket: "bucket", Key: TEMPLATE_KEY("runtime") });
    expect(String(templatePut!.Body)).toBe(JSON.stringify({ part: "runtime", region: "us-east-1", env: "staging" }));
    expect(fake.inputs("DescribeStacks")[0]).toEqual({ StackName: "agentx-staging-runtime" });
    expect(fake.inputs("CreateChangeSet")).toEqual([
      {
        StackName: "agentx-staging-runtime",
        ChangeSetName: CHANGE_SET,
        ChangeSetType: "CREATE",
        TemplateURL: TEMPLATE_URL("runtime"),
        Parameters: [
          { ParameterKey: "PermissionsBoundaryArn", ParameterValue: "" },
          { ParameterKey: "ModelId", ParameterValue: "model" },
        ],
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        RoleARN: ROLE,
      },
    ]);
    expect(fake.inputs("DescribeChangeSet")[0]).toEqual({ StackName: "agentx-staging-runtime", ChangeSetName: CHANGE_SET });
    expect(fake.inputs("ExecuteChangeSet")).toEqual([{ StackName: "agentx-staging-runtime", ChangeSetName: CHANGE_SET, ClientRequestToken: CHANGE_SET }]);
    expect(fake.inputs("DescribeChangeSet").slice(2)).toEqual(Array(3).fill({ StackName: "agentx-staging-runtime", ChangeSetName: CHANGE_SET }));
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([{ StackName: "agentx-staging-runtime", EnableTerminationProtection: true }]);
    expect(req.events).toEqual([
      { kind: "uploading", what: `package ${RUNTIME_ASSET}` },
      { kind: "uploading", what: `template ${TEMPLATE_KEY("runtime")}` },
      {
        kind: "changes",
        stackName: "agentx-staging-runtime",
        changes: [
          { action: "Add", logicalId: "Worker", type: "AWS::BedrockAgentCore::Runtime", replacement: "" },
          { action: "Modify", logicalId: "Role", type: "AWS::IAM::Role", replacement: "False" },
        ],
      },
      { kind: "deploying", stackName: "agentx-staging-runtime" },
      { kind: "deployed", stackName: "agentx-staging-runtime" },
    ]);
  });

  it("does not protect a new stack whose request does not ask for termination protection", async () => {
    const fake = fakeClients({
      HeadObject: [{ Metadata: { sha256: sha256(zipBytes[CONTROL_PLANE_ASSET]!) } }],
      PutObject: [{}],
      DescribeStacks: [stackAbsent("agentx-staging-control-plane"), stack("CREATE_COMPLETE", { ApiEndpoint: "https://api" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed()],
      ExecuteChangeSet: [{}],
    });
    const req = request("control-plane");
    expect(req.terminationProtection).toBe(false);

    await expect(deployer(fake).deploy(req)).resolves.toEqual({ ApiEndpoint: "https://api" });
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([]);
  });

  it("deploys the access stack inline with the caller's credentials (no RoleARN, TemplateBody)", async () => {
    const fake = fakeClients({
      DescribeStacks: [stackAbsent("agentx-staging-access"), stack("CREATE_COMPLETE", { ArtifactBucketName: "bucket" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed()],
      ExecuteChangeSet: [{}],
      UpdateTerminationProtection: [{}],
    });
    const req = request("access", { parameters: { PermissionsBoundaryArn: "", OperatorPrincipalArn: "" } });
    const artifactBucket = () => {
      throw new Error("the artifact bucket is not known before the access stack exists");
    };

    const outputs = await deployer(fake, { artifactBucket }).deploy(req);

    expect(outputs).toEqual({ ArtifactBucketName: "bucket" });
    expect(fake.calls.filter((call) => call.client === "s3")).toEqual([]);
    expect(fake.inputs("CreateChangeSet")).toEqual([
      {
        StackName: "agentx-staging-access",
        ChangeSetName: CHANGE_SET,
        ChangeSetType: "CREATE",
        TemplateBody: JSON.stringify({ part: "access", region: "us-east-1", env: "staging" }),
        Parameters: [
          { ParameterKey: "PermissionsBoundaryArn", ParameterValue: "" },
          { ParameterKey: "OperatorPrincipalArn", ParameterValue: "" },
        ],
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      },
    ]);
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([{ StackName: "agentx-staging-access", EnableTerminationProtection: true }]);
    expect(req.events.map((event) => event.kind)).toEqual(["changes", "deploying", "deployed"]);
  });

  it("refuses an access template too large to deploy inline, before calling AWS", async () => {
    const fake = fakeClients({});
    const release = makeRelease(() => "x".repeat(51_201));
    await expect(deployer(fake, { release }).deploy(request("access"))).rejects.toThrow("the access template is too large to deploy inline");
    expect(fake.calls).toEqual([]);
  });

  it("skips a package upload when the object's recorded sha256 matches, and re-uploads when it differs", async () => {
    const expected = sha256(zipBytes[CONTROL_PLANE_ASSET]!);
    const noChangesScript = () => ({
      DescribeStacks: [stack("UPDATE_COMPLETE", { ApiEndpoint: "https://api" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: NO_CHANGES_REASON }],
      DeleteChangeSet: [{}],
    });

    const matching = fakeClients({ HeadObject: [{ Metadata: { sha256: expected } }], PutObject: [{}], ...noChangesScript() });
    await deployer(matching).deploy(request("control-plane"));
    expect(matching.inputs("HeadObject")).toEqual([{ Bucket: "bucket", Key: `packages/${CONTROL_PLANE_ASSET}.zip` }]);
    expect(matching.inputs("PutObject").map((input) => input.Key)).toEqual([TEMPLATE_KEY("control-plane")]);

    const differing = fakeClients({ HeadObject: [{ Metadata: { sha256: "0".repeat(64) } }], PutObject: [{}, {}], ...noChangesScript() });
    const req = request("control-plane");
    await deployer(differing).deploy(req);
    const puts = differing.inputs("PutObject");
    expect(puts.map((input) => input.Key)).toEqual([`packages/${CONTROL_PLANE_ASSET}.zip`, TEMPLATE_KEY("control-plane")]);
    expect(puts[0]!.Metadata).toEqual({ sha256: expected });
    expect(Buffer.from(puts[0]!.Body as Uint8Array).equals(zipBytes[CONTROL_PLANE_ASSET]!)).toBe(true);
    expect(req.events[0]).toEqual({ kind: "uploading", what: `package ${CONTROL_PLANE_ASSET}` });
  });

  it("surfaces an S3 error other than not-found instead of treating the package as missing", async () => {
    const fake = fakeClients({ HeadObject: [awsError("Forbidden", "Forbidden", 403)] });
    await expect(deployer(fake).deploy(request("control-plane"))).rejects.toThrow("Forbidden");
    expect(fake.names()).toEqual(["s3:HeadObject"]);
  });

  it.each([NO_CHANGES_REASON, "No updates are to be performed."])("treats a change set with no changes as success and deletes it (%s)", async (reason) => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_COMPLETE", { VpcId: "vpc-1" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: reason }],
      DeleteChangeSet: [{}],
    });
    const req = request("foundation");

    await expect(deployer(fake).deploy(req)).resolves.toEqual({ VpcId: "vpc-1" });

    expect(fake.inputs("CreateChangeSet")[0]).toMatchObject({ ChangeSetType: "UPDATE", TemplateURL: TEMPLATE_URL("foundation") });
    expect(fake.inputs("DeleteChangeSet")).toEqual([{ StackName: "agentx-staging-foundation", ChangeSetName: CHANGE_SET }]);
    expect(fake.inputs("ExecuteChangeSet")).toEqual([]);
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([]);
    expect(req.events).toEqual([
      { kind: "uploading", what: `template ${TEMPLATE_KEY("foundation")}` },
      { kind: "no-changes", stackName: "agentx-staging-foundation" },
    ]);
  });

  it("protects an unprotected stack on a rerun with no changes", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [stack("CREATE_COMPLETE", { VpcId: "vpc-1" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: NO_CHANGES_REASON }],
      DeleteChangeSet: [{}],
      UpdateTerminationProtection: [{}],
    });
    const req = request("foundation");
    await expect(deployer(fake).deploy(req)).resolves.toEqual({ VpcId: "vpc-1" });
    expect(fake.names().slice(-2)).toEqual(["cloudFormation:DeleteChangeSet", "cloudFormation:UpdateTerminationProtection"]);
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([{ StackName: "agentx-staging-foundation", EnableTerminationProtection: true }]);
    expect(req.events.at(-1)).toEqual({ kind: "no-changes", stackName: "agentx-staging-foundation" });
  });

  it("reports a change set with no changes that cannot be deleted, clearly", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_COMPLETE")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: NO_CHANGES_REASON }],
      DeleteChangeSet: [awsError("AccessDenied", "not authorized to perform cloudformation:DeleteChangeSet", 403)],
    });
    await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow(
      `stack agentx-staging-foundation has no changes, and its change set ${CHANGE_SET} could not be deleted: not authorized to perform cloudformation:DeleteChangeSet`,
    );
  });

  it("updates a stack whose last update rolled back", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_ROLLBACK_COMPLETE"), protectedStack("UPDATE_COMPLETE", { VpcId: "vpc-2" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed()],
      ExecuteChangeSet: [{}],
    });
    await expect(deployer(fake).deploy(request("foundation"))).resolves.toEqual({ VpcId: "vpc-2" });
    expect(fake.inputs("CreateChangeSet")[0]).toMatchObject({ ChangeSetType: "UPDATE" });
    // Already protected: nothing to change.
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([]);
  });

  it("fails a change set that fails validation with its reason, and deletes it", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [stack("UPDATE_COMPLETE")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: "Template format error: Unresolved resource dependencies [Missing]" }],
      DeleteChangeSet: [{}],
    });
    await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow(
      "change set for agentx-staging-foundation failed: Template format error: Unresolved resource dependencies [Missing]",
    );
    expect(fake.inputs("DeleteChangeSet")).toEqual([{ StackName: "agentx-staging-foundation", ChangeSetName: CHANGE_SET }]);
    expect(fake.inputs("ExecuteChangeSet")).toEqual([]);
  });

  it("refuses a stack in ROLLBACK_COMPLETE with the delete command to run", async () => {
    const fake = fakeClients({ PutObject: [{}], DescribeStacks: [stack("ROLLBACK_COMPLETE")] });
    await expect(deployer(fake).deploy(request("identity"))).rejects.toThrow(
      "stack agentx-staging-identity failed to create earlier and must be deleted before it can be deployed again (aws cloudformation delete-stack --stack-name agentx-staging-identity)",
    );
    expect(fake.inputs("CreateChangeSet")).toEqual([]);
  });

  it("treats REVIEW_IN_PROGRESS as a create", async () => {
    const fake = fakeClients({
      HeadObject: [{ Metadata: { sha256: sha256(zipBytes[RUNTIME_ASSET]!) } }],
      PutObject: [{}],
      DescribeStacks: [stack("REVIEW_IN_PROGRESS"), stack("CREATE_COMPLETE", { RuntimeArn: "arn:runtime" })],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed()],
      ExecuteChangeSet: [{}],
      UpdateTerminationProtection: [{}],
    });
    await expect(deployer(fake).deploy(request("runtime"))).resolves.toEqual({ RuntimeArn: "arn:runtime" });
    expect(fake.inputs("CreateChangeSet")[0]).toMatchObject({ ChangeSetType: "CREATE", RoleARN: ROLE });
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([{ StackName: "agentx-staging-runtime", EnableTerminationProtection: true }]);
  });

  it.each(["CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "DELETE_IN_PROGRESS"])(
    "refuses a stack that is busy (%s), naming its status",
    async (status) => {
      const fake = fakeClients({ PutObject: [{}], DescribeStacks: [stack(status)] });
      await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow(`stack agentx-staging-foundation is busy (${status}); try again when it finishes`);
      expect(fake.inputs("CreateChangeSet")).toEqual([]);
    },
  );

  it.each(["CREATE_FAILED", "ROLLBACK_FAILED", "UPDATE_ROLLBACK_FAILED", "DELETE_FAILED"])("refuses a stack that is failed (%s), naming its status", async (status) => {
    const fake = fakeClients({ PutObject: [{}], DescribeStacks: [stack(status)] });
    await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow(
      `stack agentx-staging-foundation is ${status}; fix it in the AWS console before deploying`,
    );
    expect(fake.inputs("CreateChangeSet")).toEqual([]);
  });

  it("surfaces a DescribeStacks ValidationError that is not a missing stack", async () => {
    const fake = fakeClients({ PutObject: [{}], DescribeStacks: [awsError("ValidationError", "1 validation error detected: Value at 'stackName' failed")] });
    await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow("1 validation error detected");
    expect(fake.inputs("CreateChangeSet")).toEqual([]);
  });

  /** A runtime update that rolls back, with the given stack events (newest first) and final stack. */
  function rollbackScript(eventPages: unknown[], finalStack = stack("UPDATE_ROLLBACK_COMPLETE")) {
    return fakeClients({
      HeadObject: [{ Metadata: { sha256: sha256(zipBytes[RUNTIME_ASSET]!) } }],
      PutObject: [{}],
      DescribeStacks: [stack("UPDATE_COMPLETE"), finalStack],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed("EXECUTE_FAILED")],
      ExecuteChangeSet: [{}],
      DescribeStackEvents: eventPages,
    });
  }
  const ours = { ClientRequestToken: CHANGE_SET };
  const earlier = { ClientRequestToken: "agentx-1-2-2-1600000000" };

  it("reports the root cause when a deploy rolls back, not the cancelled siblings after it", async () => {
    const fake = rollbackScript([
      {
        StackEvents: [
          { LogicalResourceId: "agentx-staging-runtime", ResourceStatus: "UPDATE_ROLLBACK_COMPLETE", ...ours },
          { LogicalResourceId: "agentx-staging-runtime", ResourceStatus: "UPDATE_ROLLBACK_IN_PROGRESS", ResourceStatusReason: "The following resource(s) failed to update: [Worker].", ...ours },
          { LogicalResourceId: "Endpoint", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "Resource update cancelled", ...ours },
          { LogicalResourceId: "Alarm", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "Resource creation CANCELLED", ...ours },
          { LogicalResourceId: "Worker", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "Resource handler returned message: image not found", ...ours },
          { LogicalResourceId: "agentx-staging-runtime", ResourceStatus: "UPDATE_IN_PROGRESS", ResourceStatusReason: "User Initiated", ...ours },
          { LogicalResourceId: "Old", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "an older failure", ...earlier },
        ],
      },
    ]);
    const req = request("runtime");
    await expect(deployer(fake).deploy(req)).rejects.toThrow(
      "stack agentx-staging-runtime ended in UPDATE_ROLLBACK_COMPLETE: Resource handler returned message: image not found",
    );
    expect(fake.inputs("DescribeStackEvents")).toEqual([{ StackName: "agentx-staging-runtime" }]);
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([]);
    expect(req.events.map((event) => event.kind)).toEqual(["uploading", "changes", "deploying"]);
  });

  it("follows stack event pages until it reaches events older than this deploy", async () => {
    const fake = rollbackScript([
      {
        StackEvents: [
          { LogicalResourceId: "agentx-staging-runtime", ResourceStatus: "UPDATE_ROLLBACK_COMPLETE", ...ours },
          { LogicalResourceId: "Endpoint", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "Resource update cancelled", ...ours },
        ],
        NextToken: "page-2",
      },
      {
        StackEvents: [
          { LogicalResourceId: "Worker", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "image not found", ...ours },
          { LogicalResourceId: "Old", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "an older failure", ...earlier },
        ],
        NextToken: "page-3",
      },
    ]);
    await expect(deployer(fake).deploy(request("runtime"))).rejects.toThrow("stack agentx-staging-runtime ended in UPDATE_ROLLBACK_COMPLETE: image not found");
    expect(fake.inputs("DescribeStackEvents")).toEqual([{ StackName: "agentx-staging-runtime" }, { StackName: "agentx-staging-runtime", NextToken: "page-2" }]);
  });

  it("never names a failure from an earlier deploy; falls back to the stack's own reason", async () => {
    const fake = rollbackScript(
      [
        {
          StackEvents: [
            { LogicalResourceId: "agentx-staging-runtime", ResourceStatus: "UPDATE_ROLLBACK_COMPLETE", ...ours },
            { LogicalResourceId: "Endpoint", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "Resource update cancelled", ...ours },
            { LogicalResourceId: "Old", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "a stale failure from the last deploy", ...earlier },
          ],
        },
      ],
      stack("UPDATE_ROLLBACK_COMPLETE", {}, { StackStatusReason: "The following resource(s) failed to update: [Worker]." }),
    );
    await expect(deployer(fake).deploy(request("runtime"))).rejects.toThrow(
      "stack agentx-staging-runtime ended in UPDATE_ROLLBACK_COMPLETE: The following resource(s) failed to update: [Worker].",
    );
  });

  it("says no resource reported a reason when neither the events nor the stack give one", async () => {
    const fake = rollbackScript([{ StackEvents: [{ LogicalResourceId: "Old", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "stale", ...earlier }] }]);
    await expect(deployer(fake).deploy(request("runtime"))).rejects.toThrow(
      "stack agentx-staging-runtime ended in UPDATE_ROLLBACK_COMPLETE: no failed resource reported a reason",
    );
  });

  it("does not protect a new stack whose create rolled back", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [stackAbsent("agentx-staging-identity"), stack("ROLLBACK_COMPLETE")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed("EXECUTE_FAILED")],
      ExecuteChangeSet: [{}],
      DescribeStackEvents: [{ StackEvents: [{ LogicalResourceId: "UserPool", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "domain already taken", ...ours }] }],
    });
    await expect(deployer(fake).deploy(request("identity"))).rejects.toThrow("stack agentx-staging-identity ended in ROLLBACK_COMPLETE: domain already taken");
    expect(fake.inputs("UpdateTerminationProtection")).toEqual([]);
  });

  it("refuses to execute a change set that is not available, and deletes it", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_COMPLETE")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "CREATE_COMPLETE", ExecutionStatus: "OBSOLETE", StatusReason: "the stack changed after this change set was created" }],
      DeleteChangeSet: [{}],
    });
    await expect(deployer(fake).deploy(request("foundation"))).rejects.toThrow(
      "change set for agentx-staging-foundation cannot be executed (OBSOLETE): the stack changed after this change set was created",
    );
    expect(fake.inputs("DeleteChangeSet")).toEqual([{ StackName: "agentx-staging-foundation", ChangeSetName: CHANGE_SET }]);
    expect(fake.inputs("ExecuteChangeSet")).toEqual([]);
  });

  it("gives up waiting after the timeout, saying the stack may still finish and how to watch it", async () => {
    let clock = NOW;
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_COMPLETE"), stack("UPDATE_IN_PROGRESS"), stack("UPDATE_IN_PROGRESS"), stack("UPDATE_IN_PROGRESS")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [ready(), executed()],
      ExecuteChangeSet: [{}],
    });
    const engine = templatesDeployer({
      clients: fake.clients,
      release: makeRelease(),
      env: "staging",
      region: "us-east-1",
      artifactBucket: () => "bucket",
      // Each reading of the clock is 30 seconds later.
      now: () => (clock += 30_000) - 30_000,
      pollMs: 0,
      timeoutMs: 60_000,
    });
    await expect(engine.deploy(request("foundation"))).rejects.toThrow(
      "stack agentx-staging-foundation is still UPDATE_IN_PROGRESS after 1 minutes; it may still finish — watch it with aws cloudformation describe-stacks --stack-name agentx-staging-foundation",
    );
  });

  it("uses the partition's S3 host in the template URL", async () => {
    const fake = fakeClients({
      PutObject: [{}],
      DescribeStacks: [protectedStack("UPDATE_COMPLETE")],
      CreateChangeSet: [{}],
      DescribeChangeSet: [{ Status: "FAILED", StatusReason: NO_CHANGES_REASON }],
      DeleteChangeSet: [{}],
    });
    const engine = templatesDeployer({
      clients: fake.clients,
      release: makeRelease(),
      env: "staging",
      region: "cn-north-1",
      partition: "aws-cn",
      artifactBucket: () => "bucket",
      now: () => NOW,
      pollMs: 0,
    });
    await engine.deploy(request("foundation"));
    expect(fake.inputs("CreateChangeSet")[0]!.TemplateURL).toBe("https://bucket.s3.cn-north-1.amazonaws.com.cn/templates/1.2.3/cn-north-1/foundation.template.json");
    expect(() => templatesDeployer({ clients: fake.clients, release: makeRelease(), env: "staging", region: "us-east-1", partition: "aws-xx", artifactBucket: () => "bucket" })).toThrow(
      "unknown partition aws-xx; expected aws, aws-cn, or aws-us-gov",
    );
  });

  it("refuses to upload a package whose file changed after the release was loaded", async () => {
    const tampered = join(releaseDir, "tampered.zip");
    await writeFile(tampered, "changed after load");
    const release = { ...makeRelease(), packagePath: () => tampered };
    const fake = fakeClients({ HeadObject: [notFound()] });
    await expect(deployer(fake, { release }).deploy(request("control-plane"))).rejects.toThrow(
      `release file packages/${CONTROL_PLANE_ASSET}.zip does not match release.json`,
    );
    expect(fake.inputs("PutObject")).toEqual([]);
  });

  describe("secret parameters", () => {
    const SECRET = "s3cr3t-value-that-must-not-leak-00000000000";
    const secretRequest = () =>
      request("control-plane", { parameters: { PermissionsBoundaryArn: "", OidcIssuer: "https://issuer", CallbackSigningKey: SECRET } });
    const packageUploaded = () => ({ HeadObject: [{ Metadata: { sha256: sha256(zipBytes[CONTROL_PLANE_ASSET]!) } }], PutObject: [{}] });

    async function failure(fake: ReturnType<typeof fakeClients>, req: DeployRequest): Promise<Error> {
      const error = await deployer(fake).deploy(req).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    }

    it("never includes a secret parameter value in any thrown error or event", async () => {
      const events: DeployEvent[] = [];
      const messages: string[] = [];

      // 1. A change set that fails with a reason echoing the value.
      const changeSetFails = fakeClients({
        ...packageUploaded(),
        DescribeStacks: [stack("UPDATE_COMPLETE")],
        CreateChangeSet: [{}],
        DescribeChangeSet: [{ Status: "FAILED", StatusReason: `Parameter CallbackSigningKey value ${SECRET} is invalid` }],
        DeleteChangeSet: [{}],
      });
      const first = secretRequest();
      const firstError = await failure(changeSetFails, first);
      expect(firstError.message).toMatch(/^change set for agentx-staging-control-plane failed: /);
      expect(changeSetFails.inputs("CreateChangeSet")[0]!.Parameters).toContainEqual({ ParameterKey: "CallbackSigningKey", ParameterValue: SECRET });
      messages.push(firstError.message);
      events.push(...first.events);

      // 2. A deploy that rolls back with a resource reason echoing the value.
      const rollsBack = fakeClients({
        ...packageUploaded(),
        DescribeStacks: [stack("UPDATE_COMPLETE"), stack("UPDATE_ROLLBACK_COMPLETE")],
        CreateChangeSet: [{}],
        DescribeChangeSet: [
          ready([{ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "Api", ResourceType: "AWS::Lambda::Function", Replacement: "False" } }]),
          executed("EXECUTE_FAILED"),
        ],
        ExecuteChangeSet: [{}],
        DescribeStackEvents: [
          {
            StackEvents: [
              { LogicalResourceId: "Api", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: `environment variable CALLBACK_KEY=${SECRET} rejected`, ClientRequestToken: CHANGE_SET },
            ],
          },
        ],
      });
      const second = secretRequest();
      const secondError = await failure(rollsBack, second);
      expect(secondError.message).toMatch(/^stack agentx-staging-control-plane ended in UPDATE_ROLLBACK_COMPLETE: /);
      messages.push(secondError.message);
      events.push(...second.events);

      // 3. A raw SDK error whose message echoes the value.
      const sdkError = fakeClients({
        ...packageUploaded(),
        DescribeStacks: [stack("UPDATE_COMPLETE")],
        CreateChangeSet: [awsError("ValidationError", `Parameter value ${SECRET} for CallbackSigningKey does not match the pattern`)],
      });
      const third = secretRequest();
      const thirdError = await failure(sdkError, third);
      expect(thirdError.name).toBe("ValidationError");
      expect((thirdError as { $metadata?: unknown }).$metadata).toEqual({ httpStatusCode: 400, requestId: "request-1" });
      expect(thirdError.message).toContain("does not match the pattern");
      messages.push(thirdError.message);
      events.push(...third.events);

      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(messages).toHaveLength(3);
      for (const message of messages) {
        expect(message).not.toContain(SECRET);
        expect(message).toContain("<redacted>");
      }
      for (const error of [firstError, secondError, thirdError]) {
        expect(error.stack ?? "").not.toContain(SECRET);
        expect(JSON.stringify(error)).not.toContain(SECRET);
      }
    });
  });

  describe("outputs", () => {
    it("returns a stack's outputs, and undefined only when the stack does not exist", async () => {
      const fake = fakeClients({
        DescribeStacks: [stack("UPDATE_COMPLETE", { ApiEndpoint: "https://api" }), stackAbsent("agentx-staging-slack"), awsError("AccessDenied", "not allowed", 403)],
      });
      const engine = deployer(fake);
      await expect(engine.outputs("agentx-staging-control-plane")).resolves.toEqual({ ApiEndpoint: "https://api" });
      await expect(engine.outputs("agentx-staging-slack")).resolves.toBeUndefined();
      await expect(engine.outputs("agentx-staging-slack")).rejects.toThrow("not allowed");
    });
  });
});
