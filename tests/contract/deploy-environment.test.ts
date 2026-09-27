import { describe, expect, it } from "vitest";
import { environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import { deployEnvironment, type DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import { PROTECTED_PARTS, type DeployRequest, type StackDeployer, type StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

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
    template: () => {
      throw new Error("test setup: template() is not expected to be called by the orchestrator");
    },
    packagePath: () => {
      throw new Error("test setup: packagePath() is not expected to be called by the orchestrator");
    },
  };
}

const baseAnswers = (): DeployAnswers => ({
  env: ENV,
  region: "us-east-1",
  account: "123456789012",
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
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
      CapacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx_staging_capacity-AbCdEfGhIj",
      VpcId: "vpc-0123456789abcdef0",
      PrivateSubnetIds: "subnet-1,subnet-2",
    },
    [stackName("identity")]: {
      Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
      Audience: "client123",
      ClientId: "client123",
    },
    [stackName("control-plane")]: {
      ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com",
      SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask",
      SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo",
      SlackThreadsTableName: "t",
      TurnRecordsTableName: "tr",
      SlackThreadSessionBucketName: "b",
      SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x",
    },
    [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
    [stackName("slack")]: { OrchestratorArn: "arn:slack" },
  };
}

// ---- tests ---------------------------------------------------------------------------------------

describe("deploy environment", () => {
  it("installs every part in install order, feeding outputs forward and using the service role after access", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer, requests } = fakeDeployer(scriptedOutputs());

    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER,
    });

    expect(requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect(requests[0]!.part).toBe("access");
    expect(requests[0]!.roleArn).toBeUndefined();
    const accessRoleArn = scriptedOutputs()[stackName("access")]!.CloudFormationRoleArn;
    for (const request of requests.slice(1)) expect(request.roleArn).toBe(accessRoleArn);

    const runtimeRequest = requests.find((request) => request.part === "runtime")!;
    expect(runtimeRequest.parameters.ControlPlaneUrl).toBe(scriptedOutputs()[stackName("control-plane")]!.ApiEndpoint);

    for (const request of requests) {
      expect(request.terminationProtection).toBe(PROTECTED_PARTS.has(request.part));
    }
    expect(requests.every((request) => request.stackName === stackName(request.part))).toBe(true);
    expect(result.settingsWritten).toBe(true);
  });

  it("creates the callback signing key once and reuses it on later deploys", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();

    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER });

    expect(secrets.creates).toHaveLength(1);
    const firstKey = install.requests.find((request) => request.part === "control-plane")!.parameters.CallbackSigningKey;
    const secondKey = upgrade.requests.find((request) => request.part === "control-plane")!.parameters.CallbackSigningKey;
    expect(firstKey).toBeDefined();
    expect(firstKey!.length).toBeGreaterThanOrEqual(32);
    expect(secondKey).toBe(firstKey);
  });

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
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      parts: ["runtime", "control-plane"],
    });

    // Upgrade order deploys runtime before control-plane (unlike install order); both requested parts
    // are deployed, in that order, even though runtime's own parameters need control-plane's output.
    expect(upgrade.requests.map((request) => request.part)).toEqual(["runtime", "control-plane"]);
    const runtimeRequest = upgrade.requests.find((request) => request.part === "runtime")!;
    expect(runtimeRequest.parameters.ControlPlaneUrl).toBe(scriptedOutputs()[stackName("control-plane")]!.ApiEndpoint);
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
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER }),
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
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER }),
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
        mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER,
        parts: ["runtime"],
      }),
    ).rejects.toThrow(`stack ${stackName("access")} (environment staging's access stack) no longer reports outputs`);
  });

  it("refuses an upgrade of an environment that is not installed, and an install over an installed one", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();

    const freshUpgrade = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: freshUpgrade.deployer, store, secrets, holder: HOLDER }),
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

  it("deploys only the requested parts, in order, reading earlier parts' outputs", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    // A resumed/repeated install naming only one part: install mode with existing settings is refused
    // only when no `parts` is given.
    const resume = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: resume.deployer, store, secrets, holder: HOLDER,
      parts: ["runtime"],
    });

    expect(resume.requests.map((request) => request.part)).toEqual(["runtime"]);
    expect(resume.outputCalls).toEqual(
      expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("control-plane"), stackName("slack")]),
    );
    const runtimeRequest = resume.requests[0]!;
    expect(runtimeRequest.parameters.CapacityProviderArn).toBe(scriptedOutputs()[stackName("foundation")]!.CapacityProviderArn);
    expect(runtimeRequest.roleArn).toBe(scriptedOutputs()[stackName("access")]!.CloudFormationRoleArn);
    expect(result.settingsWritten).toBe(true);
  });

  it("holds the environment lock while deploying and releases it after a failure", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    let sawLockHeld = false;
    const deployer: StackDeployer = {
      async deploy(request) {
        if (request.part === "foundation") {
          sawLockHeld = store.values.has("/agentx/staging/lock");
          throw new Error("boom");
        }
        return outputs[request.stackName]!;
      },
      async outputs(name) {
        return outputs[name];
      },
    };

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("boom");

    expect(sawLockHeld).toBe(true);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("never writes the callback signing key into settings", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer } = fakeDeployer(scriptedOutputs());

    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER });

    const signingKey = secrets.creates[0]!.value;
    expect(signingKey.length).toBeGreaterThanOrEqual(32);
    const stored = store.values.get(settingsParameterName(ENV));
    expect(stored).toBeDefined();
    for (const value of store.values.values()) expect(value).not.toContain(signingKey);
  });
});
