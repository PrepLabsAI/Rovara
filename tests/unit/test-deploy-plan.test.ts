import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "@aws-sdk/client-cloudformation";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LAMBDAS,
  DEFAULT_DEPLOY_UNITS,
  assertOnlyExpectedChanges,
  executeChangeSetAndWait,
  firstFailureReason,
  executorRepositoryUri,
  formatPlan,
  liftResources,
  liftSynthArguments,
  observedChanges,
  parseTestDeployArgs,
  patchLambdaCode,
  planTestDeploy,
  resolveArtifactBucket,
  resolveCodeArtifactBucket,
  resolveTestStacks,
  saveDescribedChangeSet,
  verifyStackResources,
  waitForStackUpdate,
  type BuiltArtifacts,
  type ChangeExpectation,
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
      expect: { action: "Modify", logicalIds: ["BrokerE1355FD6"], allowedAttributes: ["Properties.Code"], allowArnReevaluations: true },
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

  it("states in the printed plan that only no-op Arn re-evaluations are accepted beside the code units", () => {
    const text = formatPlan(plan(["broker", "dispatcher"]));
    expect(text).toContain("no-op re-evaluations caused by BrokerE1355FD6.Arn, DispatcherD4A12972.Arn");
    expect(formatPlan(plan(["worker-image"]))).not.toContain("no-op re-evaluations");
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

describe("assertOnlyExpectedChanges with a code-only Lambda update (real TEST change set)", () => {
  const live = JSON.parse(readFileSync(new URL("../fixtures/test-deploy/control-plane-code-change-set.json", import.meta.url), "utf8")) as { Changes: Change[] };
  const expectation = (logicalIds: readonly string[]) =>
    ({ action: "Modify", logicalIds, allowedAttributes: ["Properties.Code"], allowArnReevaluations: true }) as const;
  const both = expectation(["BrokerE1355FD6", "DispatcherD4A12972"]);
  const fresh = (): Change[] => structuredClone(live.Changes);
  const resource = (changes: Change[], logicalId: string) => {
    const found = changes.find((change) => change.ResourceChange?.LogicalResourceId === logicalId)?.ResourceChange;
    if (found === undefined) throw new Error(`fixture has no ${logicalId}`);
    return found;
  };
  const check = (changes: Change[], expected: ChangeExpectation = both) => assertOnlyExpectedChanges(observedChanges(changes), expected);

  it("accepts the saved change set for broker and dispatcher, reporting the dynamic entries separately", () => {
    const result = check(fresh());
    expect(result.noOpReevaluations).toHaveLength(8);
    expect(result.noOpReevaluations).toContain("BrokerApiInvokeC6C766F0");
    expect(result.noOpReevaluations).not.toContain("BrokerE1355FD6");
  });

  it("refuses the same change set when only the dispatcher is deployed, because the broker is not a code unit of that run", () => {
    expect(() => check(fresh(), expectation(["DispatcherD4A12972"]))).toThrow(/Modify BrokerE1355FD6/);
  });

  it("refuses a dependent whose detail is Static", () => {
    const changes = fresh();
    const detail = resource(changes, "BrokerIntegration").Details?.[0];
    if (detail === undefined) throw new Error("fixture detail");
    detail.Evaluation = "Static";
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent caused by another attribute of the code unit", () => {
    const changes = fresh();
    const detail = resource(changes, "BrokerIntegration").Details?.[0];
    if (detail === undefined) throw new Error("fixture detail");
    detail.CausingEntity = "BrokerE1355FD6.Version";
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent caused by a resource that is not a code unit of this run", () => {
    const changes = fresh();
    const detail = resource(changes, "BrokerIntegration").Details?.[0];
    if (detail === undefined) throw new Error("fixture detail");
    detail.CausingEntity = "SomethingElse.Arn";
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent that has one dynamic detail and one other detail", () => {
    const changes = fresh();
    const target = resource(changes, "BrokerIntegration");
    target.Details = [...(target.Details ?? []), { Target: { Attribute: "Properties", Name: "Other", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" }];
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent with no details", () => {
    const changes = fresh();
    resource(changes, "BrokerIntegration").Details = [];
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent whose change source is a parameter reference", () => {
    const changes = fresh();
    const detail = resource(changes, "BrokerIntegration").Details?.[0];
    if (detail === undefined) throw new Error("fixture detail");
    detail.ChangeSource = "ParameterReference";
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a dependent that would be replaced, even conditionally-looking ones that are not Conditional", () => {
    const changes = fresh();
    resource(changes, "BrokerApiInvokeC6C766F0").Replacement = "True";
    expect(() => check(changes)).toThrow(/BrokerApiInvokeC6C766F0.*replace/);
  });

  it("accepts Replacement Conditional only because the causing Arn cannot change", () => {
    const changes = fresh();
    expect(resource(changes, "BrokerApiInvokeC6C766F0").Replacement).toBe("Conditional");
    expect(() => check(changes)).not.toThrow();
  });

  it("refuses a dependent that is added or removed", () => {
    const added = fresh();
    resource(added, "BrokerIntegration").Action = "Add";
    expect(() => check(added)).toThrow(/Add BrokerIntegration/);
    const removed = fresh();
    resource(removed, "BrokerIntegration").Action = "Remove";
    expect(() => check(removed)).toThrow(/Remove BrokerIntegration/);
  });

  it("refuses an extra Add beside the otherwise accepted change set", () => {
    const changes = fresh();
    changes.push({ Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "Extra", ResourceType: "AWS::SQS::Queue", Details: [] } });
    expect(() => check(changes)).toThrow(/Add Extra/);
  });

  it("refuses dependents when the code unit's own change touches more than Code", () => {
    const changes = fresh();
    const broker = resource(changes, "BrokerE1355FD6");
    broker.Details = [...(broker.Details ?? []), { Target: { Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" }];
    expect(() => check(changes)).toThrow(/BrokerE1355FD6.*Properties.Environment/);
    expect(() => check(changes)).toThrow(/BrokerApiInvokeC6C766F0/);
  });

  it("refuses dependents when the code unit's own change replaces it", () => {
    const changes = fresh();
    resource(changes, "BrokerE1355FD6").Replacement = "True";
    expect(() => check(changes)).toThrow(/BrokerIntegration/);
  });

  it("refuses a code unit whose own detail is not a static direct modification", () => {
    const changes = fresh();
    const detail = resource(changes, "BrokerE1355FD6").Details?.[0];
    if (detail === undefined) throw new Error("fixture detail");
    detail.Evaluation = "Dynamic";
    detail.ChangeSource = "ResourceAttribute";
    detail.CausingEntity = "DispatcherD4A12972.Arn";
    expect(() => check(changes)).toThrow(/BrokerE1355FD6/);
  });

  it("does not accept dynamic dependents unless the expectation allows Arn re-evaluations", () => {
    expect(() => check(fresh(), { action: "Modify", logicalIds: ["BrokerE1355FD6", "DispatcherD4A12972"], allowedAttributes: ["Properties.Code"] })).toThrow(/Modify BrokerIntegration/);
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
    // Every control-plane Lambda by default, so a normal TEST deploy cannot leave one on old code.
    expect(parsed.only).toEqual(["control-plane-code", "worker-image"]);
    expect(parsed.only).toEqual([...DEFAULT_DEPLOY_UNITS]);
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


const ALL_IDS = [
  "BrokerE1355FD6", "DeveloperSignInFunction10B62B05", "DeveloperTaskNotifierFunction551419CC", "DispatcherD4A12972", "EvalBatchTickA4585B04",
  "OutboxPublisherD572F72E", "PlanEvidence3615C4CB", "SessionsReaper8FEF958E", "SessionsReconciler4316A0A2", "SessionsSteps3B98DD2B", "SlackIngress5C88FFA0",
];

describe("the control-plane-code unit", () => {
  const steps = plan(["control-plane-code"]);
  const builds = steps.filter((step): step is Extract<DeployStep, { kind: "build-lambda-zip" }> => step.kind === "build-lambda-zip");
  const changeSets = steps.filter((step): step is Extract<DeployStep, { kind: "create-change-set" }> => step.kind === "create-change-set");

  it("rebuilds every packaged control-plane Lambda in one change set, then verifies each one's CodeSha256", () => {
    expect(builds.map((build) => build.logicalId).sort()).toEqual([...ALL_IDS].sort());
    expect(steps.filter((step) => step.kind === "upload-artifact")).toHaveLength(ALL_IDS.length);
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0]).toMatchObject({
      stack: CONTROL_PLANE,
      template: { source: "lambda-code" },
      expect: { action: "Modify", allowedAttributes: ["Properties.Code"], allowArnReevaluations: true },
    });
    expect([...(changeSets[0]!.expect.logicalIds ?? [])].sort()).toEqual([...ALL_IDS].sort());
    const patched = changeSets[0]!.template.source === "lambda-code" ? changeSets[0]!.template.patches.map((patch) => patch.logicalId) : [];
    expect(patched.sort()).toEqual([...ALL_IDS].sort());
    expect(kinds(steps).filter((kind) => kind === "execute-change-set")).toHaveLength(1);
    const verifies = steps.filter((step): step is Extract<DeployStep, { kind: "verify-lambda-code" }> => step.kind === "verify-lambda-code");
    expect(verifies.map((verify) => verify.logicalId).sort()).toEqual([...ALL_IDS].sort());
    for (const verify of verifies) {
      const build = builds.find((candidate) => candidate.logicalId === verify.logicalId)!;
      expect(verify).toMatchObject({ stack: CONTROL_PLANE, expectedSha256Base64: { fromStep: build.id, output: "sha256Base64" } });
    }
    // The verifies come only after the one execute.
    expect(kinds(steps).indexOf("execute-change-set")).toBeLessThan(kinds(steps).indexOf("verify-lambda-code"));
  });

  it("copies boot.sh beside the session steps handler, as the release bundle does", () => {
    const sessionsSteps = builds.find((build) => build.logicalId === "SessionsSteps3B98DD2B");
    expect(sessionsSteps).toMatchObject({ entry: "packages/broker/src/aws/session-steps.ts", extraFiles: [{ from: "packages/worker/ec2/boot.sh", name: "boot.sh" }] });
    expect(builds.filter((build) => build.extraFiles !== undefined)).toHaveLength(1);
  });

  it("includes broker and dispatcher once when they are also named", () => {
    const both = plan(["control-plane-code", "broker", "dispatcher"]);
    expect(both).toEqual(steps);
  });

  it("keeps broker and dispatcher as units of their own", () => {
    const only = plan(["broker"]).filter((step) => step.kind === "build-lambda-zip");
    expect(only).toHaveLength(1);
  });

  it("names every packaged function the infra builds, except the installer's page", () => {
    const entries = new Set<string>();
    for (const file of readdirSync(new URL("../../infra/lib/", import.meta.url))) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(new URL(`../../infra/lib/${file}`, import.meta.url), "utf8");
      for (const match of text.matchAll(/packagedFunction\(\s*(?:this|scope),\s*"[A-Za-z]+",\s*"([^"]+)"/g)) entries.add(match[1]!);
    }
    // The setup page belongs to the installer stack, which test-deploy never changes.
    entries.delete("packages/cli/src/init/ui/setup-lambda.ts");
    expect([...entries].sort()).toEqual(Object.values(CONTROL_PLANE_LAMBDAS).map((lambda) => lambda.entry).sort());
  });

  it("says in the printed plan that the whole set changes only Code", () => {
    const text = formatPlan(steps);
    expect(text).toContain("DeveloperTaskNotifierFunction551419CC.Arn");
    expect(text).toContain("boot.sh");
    expect(text).toContain("abort unless the only changes are Modify");
  });
});

describe("assertOnlyExpectedChanges for every control-plane Lambda (change set derived from the TEST template)", () => {
  const live = JSON.parse(readFileSync(new URL("../fixtures/test-deploy/control-plane-all-code-change-set.json", import.meta.url), "utf8")) as { Changes: Change[] };
  const expectation = (logicalIds: readonly string[]) => ({ action: "Modify", logicalIds, allowedAttributes: ["Properties.Code"], allowArnReevaluations: true }) as const;
  const all = expectation(ALL_IDS);
  const fresh = (): Change[] => structuredClone(live.Changes);
  const find = (changes: Change[], logicalId: string) => changes.find((change) => change.ResourceChange?.LogicalResourceId === logicalId)!.ResourceChange!;

  it("accepts exactly the Code changes and the no-op Arn re-evaluations", () => {
    const result = assertOnlyExpectedChanges(observedChanges(fresh()), all);
    expect(result.noOpReevaluations).toContain("SlackIngressIntegration");
    expect(result.noOpReevaluations).toContain("SessionsProvisioner9C44055B");
    for (const logicalId of ALL_IDS) expect(result.noOpReevaluations).not.toContain(logicalId);
  });

  it("refuses when the same change set is judged against fewer code units", () => {
    expect(() => assertOnlyExpectedChanges(observedChanges(fresh()), expectation(ALL_IDS.filter((id) => id !== "SlackIngress5C88FFA0")))).toThrow(/Modify SlackIngress5C88FFA0/);
  });

  it("refuses a change set that is missing one of the code units", () => {
    const changes = fresh().filter((change) => change.ResourceChange?.LogicalResourceId !== "PlanEvidence3615C4CB");
    expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/missing the expected Modify PlanEvidence3615C4CB/);
  });

  it("refuses a code unit that also changes its environment", () => {
    const changes = fresh();
    find(changes, "DeveloperTaskNotifierFunction551419CC").Details?.push({ Target: { Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" });
    expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/DeveloperTaskNotifierFunction551419CC.*Properties.Environment/);
  });

  it("refuses an unrelated change, an added resource and a replaced code unit", () => {
    const unrelated = fresh();
    unrelated.push({ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "State", ResourceType: "AWS::DynamoDB::Table", Replacement: "False", Details: [{ Target: { Attribute: "Properties", Name: "BillingMode" }, Evaluation: "Static", ChangeSource: "DirectModification" }] } });
    expect(() => assertOnlyExpectedChanges(observedChanges(unrelated), all)).toThrow(/State/);
    const added = fresh();
    added.push({ Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "NewQueue", ResourceType: "AWS::SQS::Queue" } });
    expect(() => assertOnlyExpectedChanges(observedChanges(added), all)).toThrow(/Add NewQueue/);
    const replaced = fresh();
    find(replaced, "SessionsSteps3B98DD2B").Replacement = "True";
    expect(() => assertOnlyExpectedChanges(observedChanges(replaced), all)).toThrow(/SessionsSteps3B98DD2B.*replace/);
  });

  describe("a code unit that reads another code unit's Arn (Broker reads DeveloperSignIn's)", () => {
    const environment = (changes: Change[]) => {
      const detail = find(changes, "BrokerE1355FD6").Details?.find((candidate) => candidate.Target?.Name === "Environment");
      if (detail === undefined) throw new Error("fixture has no Broker Environment detail");
      return detail;
    };

    it("models the live shape: Broker's Code is Static and its Environment is a Dynamic re-evaluation caused by DeveloperSignIn's Arn", () => {
      const detail = environment(fresh());
      expect(detail).toMatchObject({ Evaluation: "Dynamic", ChangeSource: "ResourceAttribute", CausingEntity: "DeveloperSignInFunction10B62B05.Arn" });
      expect(find(fresh(), "BrokerE1355FD6").Details).toHaveLength(2);
    });

    it("accepts it, and still accepts Broker's own Arn dependents", () => {
      const result = assertOnlyExpectedChanges(observedChanges(fresh()), all);
      expect(result.noOpReevaluations).toContain("BrokerIntegration");
      expect(result.noOpReevaluations).not.toContain("BrokerE1355FD6");
    });

    it("refuses the same extra detail when it is Static", () => {
      const changes = fresh();
      environment(changes).Evaluation = "Static";
      delete environment(changes).CausingEntity;
      expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/BrokerE1355FD6/);
      const direct = fresh();
      environment(direct).ChangeSource = "DirectModification";
      expect(() => assertOnlyExpectedChanges(observedChanges(direct), all)).toThrow(/BrokerE1355FD6/);
    });

    it("refuses it when the cause is not a code unit of this change set", () => {
      const outside = fresh();
      environment(outside).CausingEntity = "State.Arn";
      expect(() => assertOnlyExpectedChanges(observedChanges(outside), all)).toThrow(/BrokerE1355FD6/);
      // DeveloperSignIn is a real function, but not a unit of this run: Broker's dependence on it is not accepted.
      expect(() => assertOnlyExpectedChanges(observedChanges(fresh()), expectation(ALL_IDS.filter((id) => id !== "DeveloperSignInFunction10B62B05")))).toThrow(/BrokerE1355FD6/);
    });

    it("refuses a cause that is another attribute of a unit, the unit itself, or no entity at all", () => {
      for (const cause of ["DeveloperSignInFunction10B62B05.Version", "BrokerE1355FD6.Arn", "DeveloperSignInFunction10B62B05", undefined]) {
        const changes = fresh();
        if (cause === undefined) delete environment(changes).CausingEntity;
        else environment(changes).CausingEntity = cause;
        expect(() => assertOnlyExpectedChanges(observedChanges(changes), all), String(cause)).toThrow(/BrokerE1355FD6/);
      }
    });

    it("refuses it when the unit that causes it is itself changed by more than its Code", () => {
      const changes = fresh();
      find(changes, "DeveloperSignInFunction10B62B05").Details?.push({ Target: { Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" });
      expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/DeveloperSignInFunction10B62B05/);
    });

    it("refuses it when the unit would be replaced, and a Dynamic detail on a unit without a Code change", () => {
      const replaced = fresh();
      find(replaced, "BrokerE1355FD6").Replacement = "True";
      expect(() => assertOnlyExpectedChanges(observedChanges(replaced), all)).toThrow(/BrokerE1355FD6.*replace/);
      const noCode = fresh();
      find(noCode, "BrokerE1355FD6").Details = [environment(noCode)];
      expect(() => assertOnlyExpectedChanges(observedChanges(noCode), all)).toThrow(/BrokerE1355FD6/);
    });

    it("refuses a cycle of two units that each only re-evaluate on the other", () => {
      const changes = fresh();
      find(changes, "BrokerE1355FD6").Details = [environment(changes)];
      find(changes, "DeveloperSignInFunction10B62B05").Details = [{ Target: { Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never" }, Evaluation: "Dynamic", ChangeSource: "ResourceAttribute", CausingEntity: "BrokerE1355FD6.Arn" }];
      expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/BrokerE1355FD6|DeveloperSignInFunction10B62B05/);
    });
  });

  it("refuses a dependent whose change is caused by something other than a code unit's Arn", () => {
    const changes = fresh();
    const detail = find(changes, "SlackIngressIntegration").Details?.[0];
    detail!.CausingEntity = "State.Arn";
    expect(() => assertOnlyExpectedChanges(observedChanges(changes), all)).toThrow(/SlackIngressIntegration/);
  });
});

describe("resolveCodeArtifactBucket for a function whose Code reads its bucket from a stack parameter", () => {
  const PARAMETER = "AssetParameters4cc08d20a47075d98e1d1c0c3ec8a5c2fde4f48a7ec4017107965683d0be0353S3BucketBC7C2282";
  function runnerWith(parameterValue: string | undefined, code: unknown = { S3Bucket: { Ref: PARAMETER } }) {
    const calls: string[][] = [];
    const result = (stdout: unknown) => ({ status: 0, stdout: JSON.stringify(stdout), stderr: "" });
    return {
      calls,
      aws(args: readonly string[]) {
        calls.push([...args]);
        if (args[1] === "describe-stacks") {
          const stack = args[args.indexOf("--stack-name") + 1];
          if (stack === ACCESS) return result({ Outputs: [{ OutputKey: "ArtifactBucketName", OutputValue: ACCESS_BUCKET }] });
          return result({ Parameters: parameterValue === undefined ? [] : [{ ParameterKey: PARAMETER, ParameterValue: parameterValue }] });
        }
        if (args[1] === "get-template") return result({ Resources: { DeveloperSignInFunction10B62B05: { Type: "AWS::Lambda::Function", Properties: { Code: code } } } });
        if (args[1] === "get-bucket-versioning") return result({ Status: "Enabled" });
        throw new Error(`unexpected aws call ${args.join(" ")}`);
      },
    };
  }

  it("accepts it when the parameter's current value is the access bucket", () => {
    expect(resolveCodeArtifactBucket(runnerWith(ACCESS_BUCKET), "us-east-1", ENV, "DeveloperSignInFunction10B62B05")).toBe(ACCESS_BUCKET);
  });

  it("refuses, naming both buckets, when the parameter names another bucket", () => {
    expect(() => resolveCodeArtifactBucket(runnerWith(CONTROL_BUCKET), "us-east-1", ENV, "DeveloperSignInFunction10B62B05"))
      .toThrow(new RegExp(`${ACCESS_BUCKET}.*${CONTROL_BUCKET}|${CONTROL_BUCKET}.*${ACCESS_BUCKET}`));
  });

  it("refuses when the parameter is not on the stack, or the bucket is neither a literal nor a parameter", () => {
    expect(() => resolveCodeArtifactBucket(runnerWith(undefined), "us-east-1", ENV, "DeveloperSignInFunction10B62B05")).toThrow(/S3Bucket/);
    expect(() => resolveCodeArtifactBucket(runnerWith(ACCESS_BUCKET, { S3Bucket: { "Fn::ImportValue": "x" } }), "us-east-1", ENV, "DeveloperSignInFunction10B62B05")).toThrow(/S3Bucket/);
  });
});

describe("saveDescribedChangeSet", () => {
  const change = (action: string, logicalId: string): Change => ({ Type: "Resource", ResourceChange: { Action: action as never, LogicalResourceId: logicalId, ResourceType: "AWS::Lambda::Function", Details: [] } });

  it("writes the described change set, every page of its changes, under the evidence directory before anything executes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-deploy-evidence-"));
    try {
      const path = saveDescribedChangeSet(dir, { StackName: "agentx-x-control-plane", ChangeSetName: "test-deploy-code-1", Status: "CREATE_COMPLETE", Capabilities: ["CAPABILITY_IAM"],
        CreationTime: new Date("2026-10-20T10:00:00.000Z") }, [change("Modify", "BrokerFunction1"), change("Add", "NewQueue")]);
      expect(path.startsWith(dir)).toBe(true);
      expect(path).toMatch(/change-set-agentx-x-control-plane-test-deploy-code-1\.json$/);
      const saved = JSON.parse(readFileSync(path, "utf8")) as { StackName: string; ChangeSetName: string; Status: string; CreationTime: string; Changes: Change[] };
      expect(saved).toMatchObject({ StackName: "agentx-x-control-plane", ChangeSetName: "test-deploy-code-1", Status: "CREATE_COMPLETE", CreationTime: "2026-10-20T10:00:00.000Z" });
      expect(saved.Changes.map((item) => item.ResourceChange?.LogicalResourceId)).toEqual(["BrokerFunction1", "NewQueue"]);
      expect(observedChanges(saved.Changes).map((item) => `${item.action} ${item.logicalId}`)).toEqual(["Modify BrokerFunction1", "Add NewQueue"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps a stack or change set name from steering the file outside the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-deploy-evidence-"));
    try {
      const path = saveDescribedChangeSet(dir, { StackName: "../../etc/x", ChangeSetName: "a/b" }, []);
      expect(path.startsWith(join(dir, "change-set-"))).toBe(true);
      expect(path.slice(dir.length + 1)).not.toContain("/");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
