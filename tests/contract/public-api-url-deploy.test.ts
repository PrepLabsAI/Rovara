// CODE-PUBLIC-URL (owner DEC 254zzz505, rev 9.2), the CLI's side: the address stack's PublicApiOrigin output is the only value a create or an update of the control plane may carry (an empty
// value or a mismatch is refused, nothing is deployed), a first or changed value on a running install needs the explicit confirm, the foundation's DNS firewall must carry the same
// host, and an install with no address stack and no value changes in no way.
import { describe, expect, it } from "vitest";
import { PUBLIC_API_ORIGIN_OUTPUT, controlPlaneBase, environmentStackName, publicApiAddressStackName } from "@agentx/contracts";
import { installGatewayFixture, readyCoreEngine, brokerTemplate } from "../support/install-gateway.js";
import { deployEnvironment, type DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import { OPERATOR_PARAMETERS, type DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import { planPublicApiUrl, withDeclaredPublicApiUrl } from "../../packages/cli/src/deploy/public-api-url.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

installGatewayFixture();

const ENV = "staging";
const HOLDER = "arn:aws:iam::123456789012:user/alice";
const ORIGIN = "https://api.example.dev";
const RAW = ["https://abc", "execute-api", "us-east-1", "amazonaws", "com"].join(".");
const stackName = (part: DeployPart) => environmentStackName(ENV, part);
const ADDRESS = publicApiAddressStackName(ENV);

function fakeDeployer(scripted: Record<string, StackOutputs>): { deployer: StackDeployer; requests: DeployRequest[] } {
  const requests: DeployRequest[] = [];
  return {
    requests,
    deployer: {
      async deploy(request) {
        requests.push(request);
        const result = scripted[request.stackName];
        if (result === undefined) throw new Error(`test setup: no scripted outputs for ${request.stackName}`);
        return result;
      },
      async outputs(name) { return scripted[name]; },
    },
  };
}
const secrets = (): SecretValueStore => { const values = new Map<string, string>(); return { get: async (name) => values.get(name), create: async (name, value) => { values.set(name, value); } }; };
function release(): LoadedRelease {
  return {
    manifest: { schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [], images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` } },
    dir: "/nonexistent", regions: () => ["us-east-1"], template: brokerTemplate, packagePath: () => { throw new Error("not expected"); },
  };
}
const answers = (extra: Partial<DeployAnswers> = {}): DeployAnswers => ({
  env: ENV, coreEngine: readyCoreEngine, region: "us-east-1", account: "123456789012",
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
  ...extra,
});
function scripted(address?: StackOutputs): Record<string, StackOutputs> {
  return {
    [stackName("access")]: { ArtifactBucketName: "bucket", CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", PullThroughPrefix: "agentx-staging" },
    [stackName("foundation")]: { VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2", SessionManagerSecurityGroupId: "sg-0123456789abcdef0", DispatcherSecurityGroupId: "sg-0fedcba9876543210", WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k", Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker", Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" },
    [stackName("identity")]: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123", ClientId: "client123" },
    [stackName("control-plane")]: { ModelRunPriceVersion: "1", ApiEndpoint: RAW, SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask", SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b", SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts" },
    [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
    [stackName("slack")]: { OrchestratorArn: "arn:slack" },
    ...(address === undefined ? {} : { [ADDRESS]: address }),
  };
}
const GATEWAY = { CoreModelGatewayHost: "gateway.example", CoreAgentModel: "claude-sonnet-4-6" };
const declaresIt = (): ((part: DeployPart) => ReadonlySet<string>) => () => new Set(["PublicApiUrl"]);
const install = (outputs: Record<string, StackOutputs>, extra: Partial<DeployAnswers> = {}) => {
  const run = fakeDeployer(outputs);
  return { run, result: () => deployEnvironment({ mode: "install", engine: "templates", answers: answers(extra), release: release(), deployer: run.deployer, store: new MemoryParameterStore(), secrets: secrets(), holder: HOLDER, declaredParameters: declaresIt() }) };
};
const parametersOf = (requests: DeployRequest[], part: DeployPart) => requests.find((request) => request.part === part)!.parameters;

describe("an install with an address stack", () => {
  it("feeds its PublicApiOrigin to the foundation, the control plane and the Slack service, and never to another stack", async () => {
    const { run, result } = install(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }));
    await result();
    expect(parametersOf(run.requests, "foundation").PublicApiUrl).toBe(ORIGIN);
    expect(parametersOf(run.requests, "control-plane").PublicApiUrl).toBe(ORIGIN);
    expect(parametersOf(run.requests, "slack").ControlPlaneUrl).toBe(ORIGIN);
    for (const part of ["access", "identity", "runtime"] as const) expect(parametersOf(run.requests, part)).not.toHaveProperty("PublicApiUrl");
  });

  it.each([
    ["an empty PublicApiUrl", { publicApiUrl: "" }, /is empty but the address stack's PublicApiOrigin is https:\/\/api\.example\.dev/u],
    ["a PublicApiUrl that differs", { publicApiUrl: "https://api.other.dev" }, /does not equal the address stack's PublicApiOrigin/u],
  ] as const)("refuses %s, and deploys nothing", async (_label, extra, message) => {
    const { run, result } = install(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }), extra);
    await expect(result()).rejects.toThrow(message);
    expect(run.requests).toEqual([]);
  });

  it("refuses an address stack with no PublicApiOrigin, and deploys nothing", async () => {
    const { run, result } = install(scripted({}));
    await expect(result()).rejects.toThrow(/output is empty or not an https origin/u);
    expect(run.requests).toEqual([]);
  });

  it("an install declared to have an address stack refuses to proceed without one", async () => {
    const { run, result } = install(scripted(), { requirePublicApiAddress: true });
    await expect(result()).rejects.toThrow(/declared to have an address stack, but none was found/u);
    expect(run.requests).toEqual([]);
  });

  it("refuses a template that cannot carry the address, rather than dropping it", async () => {
    const run = fakeDeployer(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }));
    await expect(deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: release(), deployer: run.deployer, store: new MemoryParameterStore(), secrets: secrets(), holder: HOLDER, declaredParameters: () => new Set(["CallbackSigningKey"]) }))
      .rejects.toThrow(/has no PublicApiUrl parameter, so it cannot carry the public address/u);
    expect(run.requests.filter((request) => request.part !== "access")).toEqual([]);
  });
});

describe("an install with no address stack and no value (no behaviour change)", () => {
  it("sends no PublicApiUrl to any stack, and the Slack service gets the raw API host", async () => {
    const { run, result } = install(scripted());
    await result();
    for (const request of run.requests) expect(request.parameters, request.part).not.toHaveProperty("PublicApiUrl");
    expect(parametersOf(run.requests, "slack").ControlPlaneUrl).toBe(RAW);
  });
});

describe("an upgrade of a running install", () => {
  const upgrade = (outputs: Record<string, StackOutputs>, deployed: Record<string, Record<string, string>>, extra: { parts?: DeployPart[]; confirm?: boolean; answers?: Partial<DeployAnswers> } = {}) => {
    const run = fakeDeployer(outputs);
    const store = new MemoryParameterStore();
    const first = fakeDeployer(scripted());
    return {
      run,
      result: async () => {
        await deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: release(), deployer: first.deployer, store, secrets: secrets(), holder: HOLDER, declaredParameters: declaresIt() });
        return deployEnvironment({
          mode: "upgrade", engine: "templates", answers: answers(extra.answers), release: release(), deployer: run.deployer, store, secrets: secrets(), holder: HOLDER, declaredParameters: declaresIt(),
          deployedParameters: async (name) => deployed[name], ...(extra.parts === undefined ? {} : { parts: extra.parts }), ...(extra.confirm === true ? { confirmPublicApiUrlChange: true } : {}),
        });
      },
    };
  };
  const running = (controlPlane: string, foundation = controlPlane): Record<string, Record<string, string>> => ({
    [stackName("control-plane")]: { ...GATEWAY, PublicApiUrl: controlPlane }, [stackName("foundation")]: { PublicApiUrl: foundation },
  });

  it("refuses a first address (an issuer change) without the explicit confirm, naming what it changes, and deploys nothing", async () => {
    const { run, result } = upgrade(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }), running(""));
    const refusal = result();
    await expect(refusal).rejects.toThrow(/changes its token issuer: Cloud's sealed company AI keys, spend meters and Bedrock external ids/u);
    await expect(refusal).rejects.toThrow(/--confirm-public-api-url-change/u);
    expect(run.requests).toEqual([]);
  });

  it("with the confirm, carries the address to the foundation and the control plane", async () => {
    const { run, result } = upgrade(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }), running(""), { confirm: true });
    await result();
    expect(parametersOf(run.requests, "foundation").PublicApiUrl).toBe(ORIGIN);
    expect(parametersOf(run.requests, "control-plane").PublicApiUrl).toBe(ORIGIN);
  });

  it("a rebuilt or routine upgrade whose running value already is the address needs no confirm", async () => {
    const { run, result } = upgrade(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }), running(ORIGIN));
    await result();
    expect(parametersOf(run.requests, "control-plane").PublicApiUrl).toBe(ORIGIN);
  });

  it("an address changed in the address stack is an issuer change too", async () => {
    const { run, result } = upgrade(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: "https://api.other.dev" }), running(ORIGIN));
    await expect(result()).rejects.toThrow(/changes its token issuer/u);
    expect(run.requests).toEqual([]);
  });

  it("keeps the running address when nothing else sets it (every upgrade carries it), and gives it to the Slack service", async () => {
    const { run, result } = upgrade(scripted(), running(ORIGIN));
    await result();
    expect(parametersOf(run.requests, "control-plane").PublicApiUrl).toBe(ORIGIN);
    expect(parametersOf(run.requests, "foundation").PublicApiUrl).toBe(ORIGIN);
    expect(parametersOf(run.requests, "slack").ControlPlaneUrl).toBe(ORIGIN);
  });

  it("refuses to give the control plane an address the foundation's DNS firewall does not carry (workers would be blocked)", async () => {
    const { run, result } = upgrade(scripted({ [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN }), running(ORIGIN, ""), { parts: ["control-plane"] });
    await expect(result()).rejects.toThrow(/the foundation's DNS firewall does not allow https:\/\/api\.example\.dev/u);
    expect(run.requests).toEqual([]);
  });

  it("an install that never had an address is untouched: no parameter, the raw API host", async () => {
    const { run, result } = upgrade(scripted(), { [stackName("control-plane")]: { ...GATEWAY, PublicApiUrl: "" }, [stackName("foundation")]: { PublicApiUrl: "" } });
    await result();
    expect(parametersOf(run.requests, "control-plane").PublicApiUrl).toBe("");
    expect(parametersOf(run.requests, "slack").ControlPlaneUrl).toBe(RAW);
  });
});

describe("planPublicApiUrl and withDeclaredPublicApiUrl", () => {
  const base = { env: ENV, mode: "upgrade" as const, deploySet: new Set<DeployPart>(["control-plane", "foundation"]), proposed: undefined, required: false, confirmChange: false, addressOutputs: async () => undefined, deployedParameters: undefined };
  it("plans nothing where nothing sets a value", async () => {
    expect(await planPublicApiUrl(base)).toBeUndefined();
  });
  it("reads the address stack by its name (agentx-<env>-address)", async () => {
    const asked: string[] = [];
    await planPublicApiUrl({ ...base, addressOutputs: async (name) => { asked.push(name); return undefined; } });
    expect(asked).toEqual(["agentx-staging-address"]);
  });
  it("drops an empty value a template does not declare, and refuses a non-empty one", () => {
    expect(withDeclaredPublicApiUrl({ A: "1", PublicApiUrl: "" }, new Set(["A"]))).toEqual({ A: "1" });
    expect(() => withDeclaredPublicApiUrl({ PublicApiUrl: ORIGIN }, new Set(["A"]))).toThrow(/cannot carry the public address/u);
    expect(withDeclaredPublicApiUrl({ PublicApiUrl: ORIGIN }, new Set(["PublicApiUrl"]))).toEqual({ PublicApiUrl: ORIGIN });
    expect(withDeclaredPublicApiUrl({ A: "1" }, new Set(["A"]))).toEqual({ A: "1" });
  });
  it("an upgrade keeps PublicApiUrl on the foundation and the control plane", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("PublicApiUrl");
    expect(OPERATOR_PARAMETERS.foundation).toEqual(["PublicApiUrl"]);
  });
});

describe("what the CLI records and prints for the control plane (its base URL)", () => {
  it("is the origin of the issuer output, which follows PublicApiUrl, and the raw ApiEndpoint where there is none", () => {
    expect(controlPlaneBase({ ApiEndpoint: RAW, DeveloperSignInIssuer: `${ORIGIN}/v1/auth` })).toBe(ORIGIN);
    expect(controlPlaneBase({ ApiEndpoint: RAW, DeveloperSignInIssuer: `${RAW}/v1/auth` })).toBe(RAW);
    expect(controlPlaneBase({ ApiEndpoint: RAW })).toBe(RAW);
    expect(controlPlaneBase({ DeveloperSignInIssuer: "/v1/auth", ApiEndpoint: RAW })).toBe(RAW);
    expect(controlPlaneBase({})).toBeUndefined();
  });

  it.each([["the permanent address", ORIGIN], ["the API's own host", RAW]])("an install whose issuer output names %s records it as the settings' control plane URL (login and the sign-in callbacks)", async (_label, base) => {
    const outputs = scripted(base === ORIGIN ? { [PUBLIC_API_ORIGIN_OUTPUT]: ORIGIN } : undefined);
    outputs[stackName("control-plane")] = { ...outputs[stackName("control-plane")]!, DeveloperSignInIssuer: `${base}/v1/auth` };
    const store = new MemoryParameterStore();
    const run = fakeDeployer(outputs);
    await deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: release(), deployer: run.deployer, store, secrets: secrets(), holder: HOLDER, declaredParameters: declaresIt() });
    expect((await readEnvironmentSettings(store, ENV))?.controlPlaneUrl).toBe(base);
  });
});
