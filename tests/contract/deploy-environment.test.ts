import { installGatewayFixture, readyCoreEngine, brokerTemplate } from "../support/install-gateway.js";
import { describe, expect, it, vi } from "vitest";
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import { deployEnvironment, type DeployAnswers, type DeployEnvironmentInput } from "../../packages/cli/src/deploy/deploy-environment.js";
import { type DeployRequest, type StackDeployer, type StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import { type DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

installGatewayFixture();

const ENV = "staging";
const HOLDER = "arn:aws:iam::123456789012:user/alice";
const stackName = (part: DeployPart) => environmentStackName(ENV, part);

// ---- fakes -------------------------------------------------------------------------------------

/** Records every deploy request and returns the scripted outputs for its stack name; `outputs()` reads the same map. */
function fakeDeployer(scripted: Record<string, StackOutputs>): { deployer: StackDeployer; requests: DeployRequest[]; outputCalls: string[] } {
  const requests: DeployRequest[] = [];
  const outputCalls: string[] = [];
  return {
    requests,
    outputCalls,
    deployer: {
      async deploy(request) {
        requests.push(request);
        const result = scripted[request.stackName];
        if (result === undefined) throw new Error(`test setup: no scripted outputs for ${request.stackName}`);
        return result;
      },
      async outputs(name) {
        outputCalls.push(name);
        return scripted[name];
      },
    },
  };
}

/** A deployed environment that reports no parameters: nothing for an upgrade to keep. */
const nothingDeployed = async (): Promise<Record<string, string> | undefined> => ({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" });

function memorySecrets(initial: Record<string, string> = {}): SecretValueStore & { creates: Array<{ name: string; value: string }> } {
  const values = new Map(Object.entries(initial));
  const creates: Array<{ name: string; value: string }> = [];
  return {
    creates,
    async get(name) {
      return values.get(name);
    },
    async create(name, value) {
      creates.push({ name, value });
      values.set(name, value);
    },
  };
}

/** A small fake release: no real templates or packages to load, just what stackParameters needs. */
function fakeRelease(): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: "1.2.3",
    gitCommit: "a".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq",
    templates: [],
    packages: [],
    images: {
      worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`,
      slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}`,
    },
  };
  return {
    manifest,
    dir: "/nonexistent",
    regions: () => ["us-east-1"],
    template: brokerTemplate,
    packagePath: () => {
      throw new Error("test setup: packagePath() is not expected to be called by the orchestrator");
    },
  };
}

/**
 * A release whose control-plane template declares exactly `parameterNames` (F24: `deployEnvironment`
 * parses this to decide which stored sign-in keys it may pass). Only `("control-plane", region)` is
 * ever requested; any other request throws, matching `fakeRelease()`'s own "not expected to be
 * called" contract for parts/regions a test does not exercise.
 */
function fakeReleaseWithControlPlaneParameters(parameterNames: readonly string[], region = "us-east-1"): LoadedRelease {
  return {
    ...fakeRelease(),
    regions: () => [region],
    template: (part, requestedRegion) => {
      if (part !== "control-plane" || requestedRegion !== region) {
        throw new Error(`test setup: template(${part}, ${requestedRegion}) is not expected to be called`);
      }
      return JSON.stringify({ Parameters: Object.fromEntries(parameterNames.map((name) => [name, { Type: "String" }])), Outputs: { ModelRunPriceVersion: { Value: "1" } } });
    },
  };
}

const baseAnswers = (): DeployAnswers => ({
  env: ENV,
  coreEngine: readyCoreEngine,
  region: "us-east-1",
  account: "123456789012",
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
});

/** Every part's scripted stack outputs, exactly enough for `stackParameters` to succeed for all six parts. */
function scriptedOutputs(): Record<string, StackOutputs> {
  return {
    [stackName("access")]: {
      ArtifactBucketName: "agentx-staging-access-artifactbucket-abc",
      CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
      OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
      PullThroughPrefix: "agentx-staging",
    },
    [stackName("foundation")]: {
      VpcId: "vpc-0123456789abcdef0",
      PrivateSubnetIds: "subnet-1,subnet-2",
      SessionManagerSecurityGroupId: "sg-0123456789abcdef0",
      DispatcherSecurityGroupId: "sg-0fedcba9876543210",
      WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k",
      Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker",
      Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c",
    },
    [stackName("identity")]: {
      Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
      Audience: "client123",
      ClientId: "client123",
    },
    [stackName("control-plane")]: {
      ModelRunPriceVersion: "1",
      ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com",
      SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask",
      SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo",
      SlackThreadsTableName: "t",
      TurnRecordsTableName: "tr",
      SlackThreadSessionBucketName: "b",
      SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x",
      OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts",
    },
    [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
    [stackName("slack")]: { OrchestratorArn: "arn:slack" },
  };
}

// ---- tests ---------------------------------------------------------------------------------------

describe("deploy environment", () => {

  it("writes settings with the engine, version, stacks, identity and access block after an install", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer } = fakeDeployer(scriptedOutputs());
    const now = () => Date.parse("2026-09-26T00:00:00.000Z");
    const answers: DeployAnswers = { ...baseAnswers(), permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/agentx-boundary" };

    const result = await deployEnvironment({ mode: "install", engine: "templates", answers, release: fakeRelease(), deployer, store, secrets, holder: HOLDER, now });

    expect(result.settingsWritten).toBe(true);
    const settings = await readEnvironmentSettings(store, ENV);
    expect(settings).toEqual({
      schemaVersion: 1,
      env: ENV,
      account: "123456789012",
      region: "us-east-1",
      engine: "templates",
      version: "1.2.3",
      naming: "environment",
      stacks: {
        access: stackName("access"),
        foundation: stackName("foundation"),
        identity: stackName("identity"),
        runtime: stackName("runtime"),
        "control-plane": stackName("control-plane"),
        slack: stackName("slack"),
      },
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", audience: "client123", clientId: "client123" },
      models: answers.models,
      access: {
        artifactBucket: "agentx-staging-access-artifactbucket-abc",
        cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
        operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
        pullThroughPrefix: "agentx-staging",
        permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/agentx-boundary",
      },
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("upgrades in upgrade order and reads outputs of parts it does not deploy", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
      parts: ["control-plane", "runtime"],
    });

    // Price-serving control plane precedes worker activation on upgrades too.
    expect(upgrade.requests.map((request) => request.part)).toEqual(["control-plane", "runtime"]);
    const controlPlaneRequest = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlaneRequest.parameters.PrivateSubnetIds).toBe(scriptedOutputs()[stackName("foundation")]!.PrivateSubnetIds);
    // access, foundation, identity and slack are not deployed this run: their outputs come from the existing stacks.
    expect(upgrade.outputCalls).toEqual(expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("slack")]));
    expect(result.outputs.access).toEqual(scriptedOutputs()[stackName("access")]);
    expect(result.outputs.foundation).toEqual(scriptedOutputs()[stackName("foundation")]);
    expect(result.settingsWritten).toBe(true);
  });

  it("refuses a different engine than the environment was installed with, before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await writeEnvironmentSettings(store, stagingSettings);
    const attempt = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging was installed with the templates engine; switching engines is not supported");
    expect(attempt.requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("refuses to deploy an environment adopted with legacy stack naming, before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await writeEnvironmentSettings(store, { ...stagingSettings, naming: "legacy", engine: "cdk" });
    const attempt = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging uses the legacy stack names; upgrading it with agentx deploy is not supported yet");
    expect(attempt.requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("refuses your own OIDC provider without clientId before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const answers: DeployAnswers = { ...baseAnswers(), identity: { mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx" } };
    const { deployer, requests } = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers, release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("bringing your own OIDC provider requires clientId to write environment settings (needed for agentx login)");

    expect(requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("throws instead of silently deploying a non-access part without the service role", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    const accessOutputs = { ...outputs[stackName("access")]! };
    delete (accessOutputs as Record<string, string>).CloudFormationRoleArn;
    outputs[stackName("access")] = accessOutputs;
    const { deployer, requests } = fakeDeployer(outputs);

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow(`stack ${stackName("access")} has no output CloudFormationRoleArn`);

    // Access itself deployed fine (it needs no role); nothing after it was ever attempted without one.
    expect(requests.map((request) => request.part)).toEqual(["access"]);
  });

  it("resumes a failed install with no settings yet, reading already-deployed parts' outputs directly", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    const failingAtRuntime: StackDeployer = {
      async deploy(request) {
        if (request.part === "runtime") throw new Error("runtime deploy failed");
        return outputs[request.stackName]!;
      },
      async outputs(name) {
        return outputs[name];
      },
    };

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: failingAtRuntime, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("runtime deploy failed");
    // The failed install never got far enough to write settings.
    expect(await readEnvironmentSettings(store, ENV)).toBeUndefined();

    // Resuming names only the parts still needed; access/foundation/identity/control-plane already
    // exist (from the failed attempt) but have no settings recording them yet.
    const resume = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: resume.deployer, store, secrets, holder: HOLDER,
      parts: ["runtime", "slack"],
    });

    expect(resume.requests.map((request) => request.part)).toEqual(["runtime", "slack"]);
    expect(resume.outputCalls).toEqual(
      expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("control-plane")]),
    );
    expect(result.settingsWritten).toBe(true);
  });

  it("throws when a stack settings lists (access or identity) no longer reports outputs, instead of silently dropping it from rewritten settings", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const missingAccess = scriptedOutputs();
    delete missingAccess[stackName("access")];
    const { deployer } = fakeDeployer(missingAccess);

    await expect(
      deployEnvironment({
        mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
        parts: ["runtime"],
      }),
    ).rejects.toThrow(`stack ${stackName("access")} (environment staging's access stack) no longer reports outputs`);
  });

  it("refuses an upgrade of an environment that is not installed, and an install over an installed one", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();

    const freshUpgrade = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: freshUpgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging is not installed; install it first");
    expect(freshUpgrade.requests).toEqual([]);

    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const reinstall = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: reinstall.deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("environment staging is already installed; use upgrade");
    expect(reinstall.requests).toEqual([]);
  });


  it("names the release version and region, instead of a bare SyntaxError, when the control-plane template cannot be read", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    const corruptRelease: LoadedRelease = {
      ...fakeRelease(),
      regions: () => ["us-east-1"],
      template: (part, region) => {
        if (part !== "control-plane" || region !== "us-east-1") throw new Error(`test setup: template(${part}, ${region}) is not expected to be called`);
        return "{ this is not valid json";
      },
    };
    const { deployer } = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: corruptRelease, deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("the release's control-plane template for us-east-1 could not be read; rebuild or re-download release 1.2.3");
  });

  it("passes every sign-in key through when the release covers no region at all, instead of silently dropping them all (F24 fallback)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    // fakeRelease()'s own template() always throws "not expected to be called by the orchestrator";
    // an empty regions() must mean it is never even asked (see templateParameterNames).
    const noRegionRelease: LoadedRelease = { ...fakeRelease(), regions: () => [] };
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: noRegionRelease, deployer, store, secrets, holder: HOLDER });

    const controlPlaneRequest = requests.find((request) => request.part === "control-plane")!;
    expect(controlPlaneRequest.parameters).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" });
  });

});

describe("deployEnvironment with lockHeld", () => {

  it("refuses lockHeld when there is no lock at all", async () => {
    const store = new MemoryParameterStore();
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"], lockHeld: true }),
    ).rejects.toThrow("is not held by");
    expect(requests).toEqual([]);
  });
});

describe("an upgrade keeps what the operator set (OPERATOR_PARAMETERS)", () => {
  const declared = ["BudgetMonthlyUsd", "BudgetScope", "SlackAppPostedMessages", "SlackThreadTurnsPerMinute", "SlackMemberWorkspaceLimit", "SlackOrganizationWorkspaceLimit", "TaskPeopleChangesEnabled", "TaskPeoplePublicInvitationsEnabled", "TaskPeoplePrivateInvitationsEnabled"];

  async function installed(): Promise<{ store: MemoryParameterStore; secrets: ReturnType<typeof memorySecrets> }> {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });
    return { store, secrets };
  }

  it("lets the answers' own budget win over the deployed one", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: { ...baseAnswers(), budget: { monthlyUsd: 40, scope: "tag" } }, release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async () => ({ BudgetMonthlyUsd: "250", BudgetScope: "account" }),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("40");
    expect(controlPlane.parameters.BudgetScope).toBe("tag");
  });

  it("refuses an upgrade that cannot read the deployed parameters, before deploying anything", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER }))
      .rejects.toThrow("an upgrade must read the deployed stacks' parameters");
    // F6: the refusal comes before the deploy loop, so no part deploys at all.
    expect(upgrade.requests).toEqual([]);
  });

  it("refuses, never skips, when the reader is missing at the part that needs it (the loop's own check)", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    // Forces the guard before the loop and the loop to disagree: the reader is there when the guard
    // looks, and gone when the control plane deploys. Skipping would reset the budget silently.
    let reads = 0;
    type GetterBoundaryInput = Omit<DeployEnvironmentInput, "deployedParameters"> & { deployedParameters: DeployEnvironmentInput["deployedParameters"] | undefined };
    const input: GetterBoundaryInput = {
      mode: "upgrade" as const, engine: "templates" as const, answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      get deployedParameters() { reads += 1; return reads === 1 ? nothingDeployed : undefined; },
    };
    await expect(deployEnvironment(input as DeployEnvironmentInput)).rejects.toThrow("an upgrade must read the deployed stacks' parameters");
    expect(upgrade.requests.filter((request) => request.part === "control-plane")).toEqual([]);
  });

  it("keeps the settings' alert address when it rewrites the settings (F16)", async () => {
    const { store, secrets } = await installed();
    const before = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...before, alertAddress: "ops@example.com" });
    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
    });
    expect(result.settingsWritten).toBe(true);
    expect((await readEnvironmentSettings(store, ENV))!.alertAddress).toBe("ops@example.com");
  });

});

describe("an upgrade whose answers leave github.appId out keeps the deployed GitHubAppId (switch-over gap 1)", () => {
  const withoutAppId = (): DeployAnswers => {
    const { account, installationId, privateKeySecretArn } = baseAnswers().github;
    return { ...baseAnswers(), github: { ...(account === undefined ? {} : { account }), ...(installationId === undefined ? {} : { installationId }), privateKeySecretArn } };
  };
  async function installedEnvironment(engine: "cdk" | "templates" = "cdk"): Promise<{ store: MemoryParameterStore; secrets: ReturnType<typeof memorySecrets> }> {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await deployEnvironment({ mode: "install", engine, answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store, secrets, holder: HOLDER });
    return { store, secrets };
  }
  const deployedControlPlane = (parameters: Record<string, string>) => async (name: string) => (name === stackName("control-plane") ? parameters : undefined);



  it("refuses before deploying anything when the deployed control plane has no GitHubAppId to keep, or a non-number one", async () => {
    for (const deployed of [{}, { GitHubAppId: "12a" }, { GitHubAppId: "****" }]) {
      const { store, secrets } = await installedEnvironment();
      const upgrade = fakeDeployer(scriptedOutputs());
      await expect(deployEnvironment({
        mode: "upgrade", engine: "cdk", answers: withoutAppId(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
        deployedParameters: deployedControlPlane(deployed),
      })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("github.appId") as unknown });
      expect(upgrade.requests).toEqual([]);
      // Refused before the lock is taken.
      expect(store.calls.filter((call) => call.op === "put" && call.name === lockParameterName(ENV))).toHaveLength(1);
    }
  });

  it("an install stays strict: no app id is refused before the lock or anything deploys", async () => {
    const store = new MemoryParameterStore();
    const install = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "install", engine: "cdk", answers: withoutAppId(), release: fakeRelease(), deployer: install.deployer, store, secrets: memorySecrets(), holder: HOLDER }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("an install needs the GitHub App id (github.appId in the answers)") as unknown });
    expect(install.requests).toEqual([]);
    expect(store.values.has(lockParameterName(ENV))).toBe(false);
  });
});

describe("a settings write drops the old monolith's legacy keys and says so (switch-over gap 2)", () => {
  it("an upgrade reads settings holding cloud and cloudSignIn, writes them without, and reports the names", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store, secrets, holder: HOLDER });
    const stored = JSON.parse(store.values.get(settingsParameterName(ENV))!) as Record<string, unknown>;
    store.values.set(settingsParameterName(ENV), JSON.stringify({ ...stored, cloud: { on: true }, cloudSignIn: { mode: "hosted" } }));
    const events: unknown[] = [];
    await deployEnvironment({
      mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store, secrets, holder: HOLDER,
      deployedParameters: nothingDeployed, onEvent: (event) => events.push(event),
    });
    expect(events).toContainEqual({ kind: "settings-legacy-keys-dropped", env: ENV, keys: ["cloud", "cloudSignIn"] });
    const rewritten = JSON.parse(store.values.get(settingsParameterName(ENV))!) as Record<string, unknown>;
    expect(rewritten).not.toHaveProperty("cloud");
    expect(rewritten).not.toHaveProperty("cloudSignIn");
  });
});


it("checks runtime-only upgrades with the installed broker and model settings", async () => {
  const store = new MemoryParameterStore(), secrets = memorySecrets();
  const installed = fakeDeployer(scriptedOutputs());
  await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: installed.deployer, store, secrets, holder: HOLDER });
  const upgrade = fakeDeployer(scriptedOutputs());
  await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
    parts: ["runtime"], deployedParameters: async () => ({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" }) })).resolves.toMatchObject({ settingsWritten: true });
  expect(upgrade.requests.map(({ part }) => part)).toEqual(["runtime"]);
});
it("refuses unchanged gateway settings on runtime-only upgrades before writes", async () => {
  const store = new MemoryParameterStore(); await writeEnvironmentSettings(store, stagingSettings);
  const secrets = memorySecrets(), upgrade = fakeDeployer(scriptedOutputs());
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
  await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(),
    deployer: upgrade.deployer, store, secrets, holder: HOLDER, parts: ["runtime"],
    deployedParameters: async () => ({ CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" }),
  })).rejects.toThrow("gateway must serve run prices");
  expect(upgrade.requests).toEqual([]); expect(secrets.creates).toEqual([]);
});

it("stops before the signing key or any stack deploy when the deployed control-plane parameters cannot be read", async () => {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, stagingSettings);
  const secrets = memorySecrets();
  const upgrade = fakeDeployer(scriptedOutputs());
  const readError = new Error("DescribeStacks throttled");

  await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(),
    deployer: upgrade.deployer, store, secrets, holder: HOLDER,
    deployedParameters: async () => { throw readError; },
  })).rejects.toBe(readError);

  expect(upgrade.requests).toEqual([]);
  expect(secrets.creates).toEqual([]);
});
