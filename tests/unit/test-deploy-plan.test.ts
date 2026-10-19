import { describe, expect, it } from "vitest";
import {
  assertOnlyExpectedChanges,
  executeChangeSetAndWait,
  firstFailureReason,
  executorRepositoryUri,
  formatPlan,
  liftResources,
  liftSynthArguments,
  parseTestDeployArgs,
  patchLambdaCode,
  planTestDeploy,
  resolveArtifactBucket,
  resolveCodeArtifactBucket,
  resolveTestStacks,
  verifyStackResources,
  waitForStackUpdate,
  type BuiltArtifacts,
  type DeployStep,
  type StackParameters,
  type TemplatePlan,
} from "../../scripts/test-deploy.js";

const ENV = "agentxlivetest123";
const CONTROL_PLANE = "agentx-agentxlivetest123-control-plane";
const RUNTIME = "agentx-agentxlivetest123-runtime";
const OLD_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"a".repeat(64)}`;

const artifacts: BuiltArtifacts = { revision: "0123456789ab", outputDir: "/tmp/test-deploy-0123456789ab" };
const previous: StackParameters = {
  "control-plane": { OidcIssuer: "https://issuer.example", CallbackSigningKey: "****", AdminValues: "admin" },
  runtime: { ModelId: "model", ModelProvider: "provider", WorkerImageUri: OLD_IMAGE },
};

const plan = (only: Parameters<typeof planTestDeploy>[0]["only"], allowlist?: readonly string[]) =>
  planTestDeploy({ env: ENV, only, artifacts, previous }, allowlist);
const kinds = (steps: DeployStep[]) => steps.map((step) => step.kind);

describe("planTestDeploy", () => {
  it("plans a Broker-only deploy as build, upload, change set, execute, verify", () => {
    const steps = plan(["broker"]);
    expect(kinds(steps)).toEqual([
      "build-lambda-zip",
      "upload-artifact",
      "create-change-set",
      "execute-change-set",
      "verify-lambda-code",
    ]);
    const [build, upload, changeSet, execute, verify] = steps as [
      Extract<DeployStep, { kind: "build-lambda-zip" }>,
      Extract<DeployStep, { kind: "upload-artifact" }>,
      Extract<DeployStep, { kind: "create-change-set" }>,
      Extract<DeployStep, { kind: "execute-change-set" }>,
      Extract<DeployStep, { kind: "verify-lambda-code" }>,
    ];
    expect(build).toMatchObject({ logicalId: "BrokerE1355FD6", entry: "packages/broker/src/aws/broker.ts" });
    // Code goes to the access stack's versioned artifact bucket, not the control-plane stack's unversioned one.
    expect(upload).toMatchObject({ bucketFromStack: "access", logicalId: "BrokerE1355FD6", from: build.id });
    expect(changeSet).toMatchObject({
      stack: CONTROL_PLANE,
      template: { source: "lambda-code", patches: [{ logicalId: "BrokerE1355FD6", zip: upload.id }] },
      expect: { action: "Modify", logicalIds: ["BrokerE1355FD6"], allowedAttributes: ["Properties.Code"] },
    });
    expect(execute).toMatchObject({ stack: CONTROL_PLANE, createdBy: changeSet.id });
    // The Lambda CodeSha256 is the base64 of the zip's sha256: the plan binds it to the build step.
    expect(verify).toMatchObject({
      stack: CONTROL_PLANE,
      logicalId: "BrokerE1355FD6",
      expectedSha256Base64: { fromStep: build.id, output: "sha256Base64" },
    });
  });

  it("sets every control-plane parameter to UsePreviousValue and changes none", () => {
    const changeSet = plan(["broker"]).find((step) => step.kind === "create-change-set");
    expect(changeSet?.kind === "create-change-set" && changeSet.parameters).toEqual([
      { key: "AdminValues", usePreviousValue: true },
      { key: "CallbackSigningKey", usePreviousValue: true },
      { key: "OidcIssuer", usePreviousValue: true },
    ]);
  });

  it("changes Broker and Dispatcher code in one control-plane change set", () => {
    const steps = plan(["dispatcher", "broker"]);
    expect(kinds(steps)).toEqual([
      "build-lambda-zip",
      "upload-artifact",
      "build-lambda-zip",
      "upload-artifact",
      "create-change-set",
      "execute-change-set",
      "verify-lambda-code",
      "verify-lambda-code",
    ]);
    const changeSets = steps.filter((step) => step.kind === "create-change-set");
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0]).toMatchObject({
      expect: { action: "Modify", logicalIds: ["BrokerE1355FD6", "DispatcherD4A12972"] },
    });
  });

  it("plans a worker-image deploy as ECR push then a runtime change set that changes only WorkerImageUri", () => {
    const steps = plan(["worker-image"]);
    expect(kinds(steps)).toEqual(["ecr-push", "create-change-set", "execute-change-set", "verify-stack-parameter"]);
    const push = steps[0] as Extract<DeployStep, { kind: "ecr-push" }>;
    // The repository comes from the image the stack runs today, never from a new or production one.
    expect(push.repositoryUri).toBe("123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker");
    const changeSet = steps[1] as Extract<DeployStep, { kind: "create-change-set" }>;
    expect(changeSet.stack).toBe(RUNTIME);
    expect(changeSet.template).toEqual({ source: "previous" });
    expect(changeSet.parameters).toEqual([
      { key: "ModelId", usePreviousValue: true },
      { key: "ModelProvider", usePreviousValue: true },
      { key: "WorkerImageUri", value: { fromStep: push.id, output: "imageUri" } },
    ]);
    expect(changeSet.expect).toMatchObject({ action: "Modify", logicalIdPrefixes: ["WorkerImageParameter"] });
    expect(steps[3]).toMatchObject({ key: "WorkerImageUri", expected: { fromStep: push.id, output: "imageUri" } });
  });

  it("publishes the image before it changes the Broker, as the release pipeline does", () => {
    const stacks = plan(["broker", "worker-image"])
      .filter((step) => step.kind === "create-change-set")
      .map((step) => step.kind === "create-change-set" && step.stack);
    expect(stacks).toEqual([RUNTIME, CONTROL_PLANE]);
  });

  it("never touches a stack other than the control-plane and runtime stacks for the env", () => {
    const steps = plan(["broker", "dispatcher", "worker-image"]);
    const stacks = new Set(steps.flatMap((step) => ("stack" in step ? [step.stack] : [])));
    expect(stacks).toEqual(new Set([CONTROL_PLANE, RUNTIME]));
    // The access stack is only read, for its artifact bucket: no step changes it, and the only mention is the upload's bucket source.
    expect(JSON.stringify(steps).replaceAll('"bucketFromStack":"access"', "")).not.toMatch(/foundation|identity|slack|access/);
  });

  it("refuses an env that is not an allowlisted TEST installation", () => {
    for (const env of ["production", "agentxlivetest124", "AgentXLiveTest123", ""]) {
      expect(() => planTestDeploy({ env, only: ["broker"], artifacts, previous })).toThrow(
        "test-deploy only targets allowlisted TEST installations",
      );
    }
    expect(() => plan(["broker"], [])).toThrow("test-deploy only targets allowlisted TEST installations");
  });

  it("ships the allowlist with exactly the TEST installation", () => {
    expect(() => plan(["broker"])).not.toThrow();
  });

  const OLD_EXECUTOR = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor@sha256:${"d".repeat(64)}`;

  it("plans an executor-image deploy as ECR push then a runtime change set that changes only ExecutorImageUri", () => {
    const withParameter: StackParameters = { ...previous, runtime: { ...previous.runtime, ExecutorImageUri: OLD_EXECUTOR } };
    const steps = planTestDeploy({ env: ENV, only: ["executor-image"], artifacts, previous: withParameter });
    expect(kinds(steps)).toEqual(["ecr-push", "create-change-set", "execute-change-set", "verify-stack-parameter"]);
    const push = steps[0] as Extract<DeployStep, { kind: "ecr-push" }>;
    // Next to the worker's repository, which the stack's current WorkerImageUri names: nothing new is created.
    expect(push).toMatchObject({ image: "executor", repositoryUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor", revision: artifacts.revision });
    const changeSet = steps[1] as Extract<DeployStep, { kind: "create-change-set" }>;
    expect(changeSet.stack).toBe(RUNTIME);
    expect(changeSet.template).toEqual({ source: "previous" });
    expect(changeSet.parameters).toEqual([
      { key: "ExecutorImageUri", value: { fromStep: push.id, output: "imageUri" } },
      { key: "ModelId", usePreviousValue: true },
      { key: "ModelProvider", usePreviousValue: true },
      { key: "WorkerImageUri", usePreviousValue: true },
    ]);
    expect(changeSet.expect).toEqual({ action: "Modify", logicalIdPrefixes: ["WorkerExecutorImageParameter"], allowedAttributes: ["Properties.Value"] });
    expect(steps[3]).toMatchObject({ stack: RUNTIME, key: "ExecutorImageUri", expected: { fromStep: push.id, output: "imageUri" } });
  });

  it("adds the ExecutorImageUri parameter and its SSM setting the first time, as the only change, lifted from a synth of the runtime stack", () => {
    // The deployed runtime stack predates ExecutorImageUri, so it has neither the parameter nor the setting yet.
    const steps = plan(["executor-image"]);
    const changeSet = steps.find((step) => step.kind === "create-change-set") as Extract<DeployStep, { kind: "create-change-set" }>;
    expect(changeSet.template).toEqual({
      source: "lift-resources",
      logicalIdPrefix: "WorkerExecutorImageParameter",
      parameterNames: ["ExecutorImageUri"],
      construct: "AgentXProductionRuntime",
      cdkContext: {},
      identityMode: "cognito",
    });
    expect(changeSet.expect).toEqual({ action: "Add", logicalIdPrefixes: ["WorkerExecutorImageParameter"] });
    expect(changeSet.parameters).toContainEqual({ key: "ExecutorImageUri", value: { fromStep: "push-executor-image", output: "imageUri" } });
    expect(changeSet.parameters.filter((parameter) => "usePreviousValue" in parameter).map((parameter) => parameter.key)).toEqual(["ModelId", "ModelProvider", "WorkerImageUri"]);
  });

  it("passes the environment's identity mode to the synth the lifted template comes from", () => {
    const steps = planTestDeploy({ env: ENV, only: ["executor-image"], artifacts, previous, identityMode: "oidc" });
    const changeSet = steps.find((step) => step.kind === "create-change-set");
    expect(changeSet?.kind === "create-change-set" && changeSet.template).toMatchObject({ source: "lift-resources", identityMode: "oidc" });
  });

  it("pushes both images and changes the runtime stack once for each when asked for both, worker first", () => {
    const steps = plan(["executor-image", "worker-image"]);
    expect(kinds(steps)).toEqual(["ecr-push", "create-change-set", "execute-change-set", "verify-stack-parameter", "ecr-push", "create-change-set", "execute-change-set", "verify-stack-parameter"]);
    expect(steps.filter((step) => step.kind === "ecr-push").map((step) => step.kind === "ecr-push" && step.image)).toEqual(["worker", "executor"]);
    const prefixes = steps.filter((step) => step.kind === "create-change-set").map((step) => step.kind === "create-change-set" && step.changeSetPrefix);
    expect(new Set(prefixes).size).toBe(2);
    expect(new Set(steps.flatMap((step) => ("stack" in step ? [step.stack] : [])))).toEqual(new Set([RUNTIME]));
  });

  it("derives the executor repository from the worker's, and refuses a worker repository it cannot map", () => {
    const registry = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
    expect(executorRepositoryUri(`${registry}/agentx-test/worker`)).toBe(`${registry}/agentx-test/executor`);
    expect(executorRepositoryUri(`${registry}/agentx-staging/agentx/agentx-worker`)).toBe(`${registry}/agentx-staging/agentx/agentx-executor`);
    expect(() => executorRepositoryUri(`${registry}/agentx-test/images`)).toThrow(/executor repository/);
    // A worker word elsewhere in the path is not the repository's own name.
    expect(() => executorRepositoryUri(`${registry}/worker-team/images`)).toThrow(/executor repository/);
  });

  it("states in the printed plan which image is pushed and that no repository is created", () => {
    const text = formatPlan(plan(["executor-image"]));
    expect(text).toContain("executor image");
    expect(text).toContain("agentx-test/executor");
    expect(text).toMatch(/never creates a repository/);
  });

  it("states in the printed plan that code goes to the access stack's versioned bucket", () => {
    const text = formatPlan(plan(["broker"]));
    expect(text).toContain("access stack's versioned artifact bucket");
    expect(text).not.toContain("control-plane artifact bucket");
  });

  it("plans qualification-transport as a guarded add-only change set on the control-plane stack", () => {
    const steps = plan(["qualification-transport"]);
    expect(kinds(steps)).toEqual(["create-change-set", "execute-change-set", "verify-stack-resources"]);
    expect(steps[2]).toMatchObject({ stack: CONTROL_PLANE, createdBy: steps[0]?.id, logicalIdPrefix: "E2eQualificationTransport", expectedStatus: "CREATE_COMPLETE" });
    expect(steps[0]).toMatchObject({
      stack: CONTROL_PLANE,
      template: {
        source: "lift-resources",
        logicalIdPrefix: "E2eQualificationTransport",
        cdkContext: { "agentx:e2eQualificationTransport": "enabled" },
      },
      expect: { action: "Add", logicalIdPrefixes: ["E2eQualificationTransport"] },
    });
  });

  it("does not mix qualification-transport with code units that share its stack", () => {
    expect(() => plan(["qualification-transport", "broker"])).toThrow(/qualification-transport.*on its own/);
  });

  it("requires something to deploy and a worker image to derive the repository from", () => {
    expect(() => plan([])).toThrow("nothing to deploy");
    expect(() =>
      planTestDeploy({
        env: ENV,
        only: ["worker-image"],
        artifacts,
        previous: { ...previous, runtime: { ModelId: "model" } },
      }),
    ).toThrow("WorkerImageUri");
  });
});

describe("resolveTestStacks", () => {
  it("names the stacks the way the CLI resolves a named environment", () => {
    expect(resolveTestStacks(ENV)).toEqual({ "control-plane": CONTROL_PLANE, runtime: RUNTIME });
  });
});

const ACCESS = "agentx-agentxlivetest123-access";
const ACCESS_BUCKET = "agentx-agentxlivetest123-ac-artifactbucket7410c9ef-tdepjp3jep13";
const CONTROL_BUCKET = "agentx-agentxlivetest123-control-artifacts82dd59a1-syx0unxsewcf";

/** A runner that answers the AWS reads the bucket guards make and records every call. */
function fakeAws(options: { versioning?: string; brokerBucket?: unknown } = {}) {
  const calls: string[][] = [];
  const result = (stdout: unknown) => ({ status: 0, stdout: JSON.stringify(stdout), stderr: "" });
  return {
    calls,
    aws(args: readonly string[]) {
      calls.push([...args]);
      const stackName = args[args.indexOf("--stack-name") + 1];
      if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
        if (stackName === ACCESS) return result({ Outputs: [{ OutputKey: "ArtifactBucketName", OutputValue: ACCESS_BUCKET }] });
        return result({ Outputs: [{ OutputKey: "ArtifactBucketName", OutputValue: CONTROL_BUCKET }] });
      }
      if (args[0] === "cloudformation" && args[1] === "get-template") {
        return result({ Resources: { BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: options.brokerBucket ?? ACCESS_BUCKET, S3Key: "k" } } } } });
      }
      if (args[0] === "s3api" && args[1] === "get-bucket-versioning") {
        return result(options.versioning === undefined ? { Status: "Enabled" } : options.versioning === "" ? {} : { Status: options.versioning });
      }
      throw new Error(`unexpected aws call ${args.join(" ")}`);
    },
  };
}

describe("resolveArtifactBucket", () => {
  it("takes the bucket from the access stack's ArtifactBucketName and checks its versioning", () => {
    const runner = fakeAws();
    expect(resolveArtifactBucket(runner, "us-east-1", ENV)).toBe(ACCESS_BUCKET);
    expect(runner.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["cloudformation describe-stacks", "s3api get-bucket-versioning"]);
    expect(runner.calls[0]).toContain(ACCESS);
    expect(runner.calls.flat()).not.toContain(CONTROL_PLANE);
    expect(runner.calls[1]).toContain(ACCESS_BUCKET);
  });

  it.each([["Suspended"], [""]])("refuses a bucket whose versioning is %j, naming it", (versioning) => {
    expect(() => resolveArtifactBucket(fakeAws({ versioning }), "us-east-1", ENV)).toThrow(new RegExp(`${ACCESS_BUCKET}.*versioning.*Enabled`));
  });
});

describe("resolveCodeArtifactBucket", () => {
  it("returns the versioned access bucket when the deployed Code already uses it", () => {
    const runner = fakeAws();
    expect(resolveCodeArtifactBucket(runner, "us-east-1", ENV, "BrokerE1355FD6")).toBe(ACCESS_BUCKET);
    expect(runner.calls.find((call) => call[1] === "get-template")).toEqual(expect.arrayContaining(["--stack-name", CONTROL_PLANE, "--template-stage", "Original"]));
  });

  it("refuses, naming both buckets, when the deployed Code uses another one", () => {
    expect(() => resolveCodeArtifactBucket(fakeAws({ brokerBucket: CONTROL_BUCKET }), "us-east-1", ENV, "BrokerE1355FD6"))
      .toThrow(new RegExp(`${ACCESS_BUCKET}.*${CONTROL_BUCKET}|${CONTROL_BUCKET}.*${ACCESS_BUCKET}`));
  });

  it("refuses when the deployed Code does not name a literal bucket", () => {
    expect(() => resolveCodeArtifactBucket(fakeAws({ brokerBucket: { Ref: "Bucket" } }), "us-east-1", ENV, "BrokerE1355FD6")).toThrow(/S3Bucket/);
  });

  it("does not look at the deployed Code when the bucket is not versioned", () => {
    const runner = fakeAws({ versioning: "Suspended" });
    expect(() => resolveCodeArtifactBucket(runner, "us-east-1", ENV, "BrokerE1355FD6")).toThrow(/versioning/);
    expect(runner.calls.some((call) => call[1] === "get-template")).toBe(false);
  });
});

describe("assertOnlyExpectedChanges", () => {
  const addOnly = { action: "Add", logicalIdPrefixes: ["E2eQualificationTransport"] } as const;
  const policyAdd = { action: "Add", logicalId: "E2eQualificationTransport", type: "AWS::IAM::Policy" };

  it("accepts a change set that only adds the qualification policy", () => {
    expect(() => assertOnlyExpectedChanges([policyAdd], addOnly)).not.toThrow();
  });

  it("aborts, listing it, when the Broker is also modified", () => {
    const broker = { action: "Modify", logicalId: "BrokerE1355FD6", type: "AWS::Lambda::Function" };
    expect(() => assertOnlyExpectedChanges([policyAdd, broker], addOnly)).toThrow(/Modify BrokerE1355FD6/);
  });

  it("aborts when anything is removed", () => {
    const removed = { action: "Remove", logicalId: "E2eQualificationTransport", type: "AWS::IAM::Policy" };
    expect(() => assertOnlyExpectedChanges([policyAdd, removed], addOnly)).toThrow(/Remove E2eQualificationTransport/);
  });

  it("aborts when an added resource has another logical id", () => {
    const other = { action: "Add", logicalId: "SomethingElse", type: "AWS::SQS::Queue" };
    expect(() => assertOnlyExpectedChanges([policyAdd, other], addOnly)).toThrow(/Add SomethingElse/);
  });

  it("aborts on an empty change set", () => {
    expect(() => assertOnlyExpectedChanges([], addOnly)).toThrow("no changes");
  });

  const codeOnly = { action: "Modify", logicalIds: ["BrokerE1355FD6"], allowedAttributes: ["Properties.Code"] } as const;
  const brokerCode = {
    action: "Modify",
    logicalId: "BrokerE1355FD6",
    type: "AWS::Lambda::Function",
    replacement: "False",
    attributes: ["Properties.Code"],
  };

  it("accepts a Lambda change that only changes Code", () => {
    expect(() => assertOnlyExpectedChanges([brokerCode], codeOnly)).not.toThrow();
  });

  it("aborts when the Lambda change touches more than Code, or replaces the function", () => {
    expect(() =>
      assertOnlyExpectedChanges([{ ...brokerCode, attributes: ["Properties.Code", "Properties.Environment"] }], codeOnly),
    ).toThrow(/Properties.Environment/);
    expect(() => assertOnlyExpectedChanges([{ ...brokerCode, replacement: "True" }], codeOnly)).toThrow(/replac/);
  });

  it("aborts when an expected change is missing", () => {
    expect(() => assertOnlyExpectedChanges([policyAdd], codeOnly)).toThrow(/BrokerE1355FD6/);
  });
});

describe("liftResources", () => {
  const deployed = {
    Parameters: { RoleName: { Type: "String" } },
    Resources: {
      ArtifactsABC123: { Type: "AWS::S3::Bucket" },
      BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "old.zip" } } },
    },
  };
  const policy = {
    Type: "AWS::IAM::Policy",
    Properties: {
      Roles: [{ Ref: "RoleName" }],
      PolicyDocument: { Statement: [{ Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["ArtifactsABC123", "Arn"] }, "/x"]] } }] },
    },
  };

  it("adds only the matching new resources to the deployed template", () => {
    const synthesized = {
      Resources: {
        ArtifactsABC123: { Type: "AWS::S3::Bucket", Properties: { changed: true } },
        BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "new.zip" } } },
        E2eQualificationTransport: policy,
      },
    };
    const merged = liftResources(deployed, synthesized, "E2eQualificationTransport");
    expect(Object.keys(merged.Resources ?? {}).sort()).toEqual(["ArtifactsABC123", "BrokerE1355FD6", "E2eQualificationTransport"]);
    expect(merged.Resources?.BrokerE1355FD6).toEqual(deployed.Resources.BrokerE1355FD6);
    expect(merged.Resources?.ArtifactsABC123).toEqual(deployed.Resources.ArtifactsABC123);
    expect(merged.Resources?.E2eQualificationTransport).toEqual(policy);
  });

  it("refuses when the synthesized template has no such resource", () => {
    expect(() => liftResources(deployed, { Resources: {} }, "E2eQualificationTransport")).toThrow(/E2eQualificationTransport/);
  });

  it("refuses a lifted resource that refers to something the deployed stack does not have", () => {
    const dangling = { Resources: { E2eQualificationTransport: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Missing" }] } } } };
    expect(() => liftResources(deployed, dangling, "E2eQualificationTransport")).toThrow(/Missing/);
  });
});

describe("patchLambdaCode", () => {
  const template = {
    Resources: {
      BrokerE1355FD6: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Key: "old.zip" }, Handler: "index.handler" } },
      Other: { Type: "AWS::SQS::Queue", Properties: {} },
    },
  };
  const code = { S3Bucket: "bucket", S3Key: "new.zip", S3ObjectVersion: "v1" };

  it("replaces only the Code of the named function and does not mutate its input", () => {
    const patched = patchLambdaCode(template, [{ logicalId: "BrokerE1355FD6", code }]);
    expect(patched.Resources?.BrokerE1355FD6).toEqual({
      Type: "AWS::Lambda::Function",
      Properties: { Code: code, Handler: "index.handler" },
    });
    expect(patched.Resources?.Other).toEqual(template.Resources.Other);
    expect(template.Resources.BrokerE1355FD6.Properties.Code).toEqual({ S3Key: "old.zip" });
  });

  it("refuses a resource that is missing or is not a Lambda function with a Code field", () => {
    expect(() => patchLambdaCode(template, [{ logicalId: "Nope", code }])).toThrow(/Nope/);
    expect(() => patchLambdaCode(template, [{ logicalId: "Other", code }])).toThrow(/Other/);
  });
});

describe("parseTestDeployArgs", () => {
  it("requires env and profile, defaults to a dry run and the code and worker-image units", () => {
    const parsed = parseTestDeployArgs(["--env", ENV, "--profile", "agentx-test"]);
    expect(parsed).toMatchObject({ env: ENV, profile: "agentx-test", apply: false, region: "us-east-1" });
    expect(parsed.only).toEqual(["broker", "dispatcher", "worker-image"]);
    expect(() => parseTestDeployArgs(["--profile", "agentx-test"])).toThrow("--env is required");
    expect(() => parseTestDeployArgs(["--env", ENV])).toThrow("--profile is required");
  });

  it("parses --apply and --only, and rejects unknown units and options", () => {
    const parsed = parseTestDeployArgs(["--env", ENV, "--profile", "p", "--apply", "--only", "broker,qualification-transport"]);
    expect(parsed).toMatchObject({ apply: true, only: ["broker", "qualification-transport"] });
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "foundation"])).toThrow(/unknown deploy unit foundation/);
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--force"])).toThrow("unknown option --force");
  });

  it("rejects positional arguments instead of ignoring them", () => {
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "broker"])).toThrow("unexpected argument broker");
    expect(() => parseTestDeployArgs(["apply", "--env", ENV, "--profile", "p"])).toThrow("unexpected argument apply");
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--apply", "now"])).toThrow("unexpected argument now");
    // A value that belongs to an option is not positional.
    expect(() => parseTestDeployArgs(["--env", ENV, "--profile", "p", "--only", "broker"])).not.toThrow();
    expect(() => parseTestDeployArgs(["--env", ENV, "--env", ENV, "--profile", "p"])).toThrow("--env was given twice");
  });
});

describe("waitForStackUpdate", () => {
  const SINCE = new Date("2026-10-19T10:00:00Z");
  const before = new Date("2026-10-19T09:00:00Z");
  const after = new Date("2026-10-19T10:05:00Z");
  const states = (list: Array<{ status: string; lastUpdatedTime?: Date }>) => { let calls = 0; return { read: async () => list[Math.min(calls++, list.length - 1)]!, calls: () => calls }; };
  const clock = () => { let t = 0; return () => (t += 1); };
  const fast = { sleep: async () => undefined, intervalMs: 1, timeoutMs: 1_000 };

  it("waits through the update and its cleanup, then accepts UPDATE_COMPLETE", async () => {
    const fake = states([
      { status: "UPDATE_IN_PROGRESS", lastUpdatedTime: after },
      { status: "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", lastUpdatedTime: after },
      { status: "UPDATE_COMPLETE", lastUpdatedTime: after },
    ]);
    await waitForStackUpdate(fake.read, SINCE, { ...fast, now: clock() });
    expect(fake.calls()).toBe(3);
  });

  it("keeps waiting while a settled status is stale: LastUpdatedTime has not moved past the one recorded before execute", async () => {
    const fake = states([
      { status: "UPDATE_COMPLETE", lastUpdatedTime: before },
      { status: "UPDATE_COMPLETE", lastUpdatedTime: SINCE },
      { status: "UPDATE_IN_PROGRESS", lastUpdatedTime: after },
      { status: "UPDATE_COMPLETE", lastUpdatedTime: after },
    ]);
    await waitForStackUpdate(fake.read, SINCE, { ...fast, now: clock() });
    expect(fake.calls()).toBe(4);
  });

  it("accepts a stack that has never been updated before (nothing recorded)", async () => {
    await expect(waitForStackUpdate(states([{ status: "UPDATE_COMPLETE", lastUpdatedTime: after }]).read, undefined, { ...fast, now: clock() })).resolves.toBeUndefined();
  });

  it("fails on a rollback, naming the status and the first failure reason", async () => {
    const fake = states([{ status: "UPDATE_ROLLBACK_IN_PROGRESS", lastUpdatedTime: after }, { status: "UPDATE_ROLLBACK_COMPLETE", lastUpdatedTime: after }]);
    await expect(waitForStackUpdate(fake.read, SINCE, { ...fast, now: clock(), describeFailure: async () => "E2eQualificationTransport: boom" }))
      .rejects.toThrow(/UPDATE_ROLLBACK_COMPLETE.*E2eQualificationTransport: boom/);
  });

  it("still names the status when no failure reason can be found", async () => {
    const fake = states([{ status: "UPDATE_ROLLBACK_COMPLETE", lastUpdatedTime: after }]);
    await expect(waitForStackUpdate(fake.read, SINCE, { ...fast, now: clock(), describeFailure: async () => undefined })).rejects.toThrow(/UPDATE_ROLLBACK_COMPLETE/);
  });

  it("fails when the stack is still updating after the time allowed", async () => {
    const fake = states([{ status: "UPDATE_IN_PROGRESS", lastUpdatedTime: after }]);
    await expect(waitForStackUpdate(fake.read, SINCE, { ...fast, timeoutMs: 5, now: clock() })).rejects.toThrow(/still UPDATE_IN_PROGRESS/);
  });

  it("fails when the update never starts in the time allowed, saying so", async () => {
    const fake = states([{ status: "UPDATE_COMPLETE", lastUpdatedTime: before }]);
    await expect(waitForStackUpdate(fake.read, SINCE, { ...fast, timeoutMs: 5, now: clock() })).rejects.toThrow(/did not start/);
  });
});

describe("firstFailureReason", () => {
  const SINCE = new Date("2026-10-19T10:00:00Z");
  const event = (offsetMinutes: number, logicalId: string, status: string, reason?: string) =>
    ({ Timestamp: new Date(SINCE.getTime() + offsetMinutes * 60_000), LogicalResourceId: logicalId, ResourceStatus: status, ResourceStatusReason: reason });

  it("returns the earliest failed event of this update, ignoring older failures and the rollback it caused", () => {
    // DescribeStackEvents lists newest first.
    const events = [
      event(4, "Stack", "UPDATE_ROLLBACK_COMPLETE"),
      event(3, "E2eOther", "UPDATE_FAILED", "Resource update cancelled"),
      event(2, "E2eQualificationTransport", "CREATE_FAILED", "boom"),
      event(1, "Stack", "UPDATE_IN_PROGRESS"),
      event(-60, "Old", "CREATE_FAILED", "ancient"),
    ];
    expect(firstFailureReason(events, SINCE)).toBe("E2eQualificationTransport CREATE_FAILED: boom");
  });

  it("is undefined when the update has no failed event", () => {
    expect(firstFailureReason([event(1, "Stack", "UPDATE_IN_PROGRESS"), event(-60, "Old", "CREATE_FAILED", "ancient")], SINCE)).toBeUndefined();
  });
});

describe("executeChangeSetAndWait", () => {
  const identity = { StackName: "agentx-x-runtime", ChangeSetName: "test-deploy-qualification-1" };
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));
  const fast = { sleep: async () => undefined, intervalMs: 1, timeoutMs: 1_000 };

  /** A CloudFormation that serves stack states in order, and refuses the change set once it has been executed, as the real one does. */
  const fakeCloudFormation = (stackStates: Array<{ StackStatus: string; LastUpdatedTime?: Date }>, events: unknown[] = []) => {
    const sent: string[] = [];
    let stackReads = 0;
    let executed = false;
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        sent.push(name);
        if (name === "DescribeStacksCommand") return { Stacks: [{ StackName: identity.StackName, CreationTime: t(-600), ...stackStates[Math.min(stackReads++, stackStates.length - 1)]! }] };
        if (name === "ExecuteChangeSetCommand") { executed = true; return {}; }
        if (name === "DescribeChangeSetCommand") {
          if (executed) throw Object.assign(new Error(`ChangeSet [${identity.ChangeSetName}] does not exist`), { name: "ChangeSetNotFoundException" });
          return { ExecutionStatus: "AVAILABLE" };
        }
        if (name === "DescribeStackEventsCommand") return { StackEvents: events };
        throw new Error(`unexpected ${name}`);
      },
    };
    return { client: client as unknown as Parameters<typeof executeChangeSetAndWait>[0], sent };
  };

  it("succeeds although the executed change set no longer exists, by watching the stack", async () => {
    const fake = fakeCloudFormation([
      { StackStatus: "UPDATE_COMPLETE", LastUpdatedTime: t(0) },
      { StackStatus: "UPDATE_COMPLETE", LastUpdatedTime: t(0) },
      { StackStatus: "UPDATE_IN_PROGRESS", LastUpdatedTime: t(5) },
      { StackStatus: "UPDATE_COMPLETE", LastUpdatedTime: t(5) },
    ]);
    await executeChangeSetAndWait(fake.client, identity, fast);
    expect(fake.sent).not.toContain("DescribeChangeSetCommand");
    // The stack is read before the change set is executed, never after it.
    expect(fake.sent.indexOf("DescribeStacksCommand")).toBeLessThan(fake.sent.indexOf("ExecuteChangeSetCommand"));
  });

  it("fails on a rollback, naming the reason from the stack's events", async () => {
    const fake = fakeCloudFormation(
      [{ StackStatus: "UPDATE_COMPLETE", LastUpdatedTime: t(0) }, { StackStatus: "UPDATE_ROLLBACK_COMPLETE", LastUpdatedTime: t(5) }],
      [{ Timestamp: t(6), LogicalResourceId: "E2eQualificationTransport", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "boom" }],
    );
    await expect(executeChangeSetAndWait(fake.client, identity, fast)).rejects.toThrow(/UPDATE_ROLLBACK_COMPLETE.*E2eQualificationTransport CREATE_FAILED: boom/);
  });
});

describe("verifyStackResources", () => {
  it("reads each named resource back with DescribeStackResource and requires its status", async () => {
    const asked: string[] = [];
    const describe = async (logicalId: string) => { asked.push(logicalId); return { ResourceStatus: "CREATE_COMPLETE", PhysicalResourceId: `phys-${logicalId}` }; };
    await expect(verifyStackResources(describe, ["E2eQualificationTransport"], "CREATE_COMPLETE")).resolves.toEqual(["E2eQualificationTransport"]);
    expect(asked).toEqual(["E2eQualificationTransport"]);
  });

  it("fails on another status, a missing resource, or nothing to verify", async () => {
    await expect(verifyStackResources(async () => ({ ResourceStatus: "CREATE_FAILED" }), ["E2eQualificationTransport"], "CREATE_COMPLETE")).rejects.toThrow(/E2eQualificationTransport.*CREATE_FAILED/);
    await expect(verifyStackResources(async () => undefined, ["E2eQualificationTransport"], "CREATE_COMPLETE")).rejects.toThrow(/E2eQualificationTransport/);
    await expect(verifyStackResources(async () => ({ ResourceStatus: "CREATE_COMPLETE" }), [], "CREATE_COMPLETE")).rejects.toThrow(/no resource to verify/);
  });
});

describe("liftSynthArguments", () => {
  const lift = { source: "lift-resources", logicalIdPrefix: "E2eQualificationTransport", construct: "AgentXControlPlane", cdkContext: { "agentx:e2eQualificationTransport": "enabled" }, identityMode: "cognito" } as Extract<TemplatePlan, { source: "lift-resources" }>;
  const args = (overrides: Partial<typeof lift> = {}, profile = "agentx-test") =>
    liftSynthArguments({ ...lift, ...overrides }, { env: ENV, region: "us-east-1", profile, outDir: "/tmp/out" });

  it("gives cdk synth the profile and the same app and context the repo's deploy engine passes", () => {
    const list = args();
    expect(list.slice(0, 4)).toEqual(["--no-install", "cdk", "synth", "AgentXControlPlane"]);
    expect(list).toEqual(expect.arrayContaining(["--exclusively", "--app", "node infra/dist/bin/agentx.js", "-c", `agentxEnv=${ENV}`, "-c", "agentxRegion=us-east-1", "-c", "agentx:e2eQualificationTransport=enabled", "--output", "/tmp/out"]));
    expect(list.slice(list.indexOf("--profile"), list.indexOf("--profile") + 2)).toEqual(["--profile", "agentx-test"]);
    // Cognito is the engine's default and adds no identity context; an own-OIDC environment adds it.
    expect(list.join(" ")).not.toContain("agentxIdentity");
    expect(args({ identityMode: "oidc" }).join(" ")).toContain("-c agentxIdentity=oidc");
  });
});
