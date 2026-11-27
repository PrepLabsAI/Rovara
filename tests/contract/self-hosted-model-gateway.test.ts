import * as nodeCrypto from "node:crypto";
import vm from "node:vm";
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { HEALTH_ALARM_SUFFIXES, STACK_PARTS, environmentStackName, type ReleaseManifest } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { GATEWAY_TLS_CERT_CODE, SelfHostedModelGatewayStack } from "../../infra/lib/self-hosted-model-gateway.js";
import { deployEnvironment } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const FAKE_GATEWAY_HOST = "example.execute-api.us-east-1.amazonaws.com";
const FAKE_TASK_KID = "abcdefghijklmnop";

function fakeRelease(): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: "0.5.0",
    gitCommit: "a".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq",
    templates: STACK_PARTS.map((part) => ({
      region: "us-east-1",
      part,
      file: `templates/us-east-1/${part}.template.json`,
      sha256: "b".repeat(64),
    })),
    packages: [],
    images: {
      worker: `public.ecr.aws/rovara/agentx-worker@sha256:${"1".repeat(64)}`,
      slack: `public.ecr.aws/rovara/agentx-slack@sha256:${"2".repeat(64)}`,
      gateway: `public.ecr.aws/rovara/agentx-gateway@sha256:${"3".repeat(64)}`,
    },
  };
  return {
    dir: "/tmp/fake-release",
    manifest,
    regions: () => ["us-east-1"],
    template: (part) => JSON.stringify({
      Parameters: {},
      ...(part === "control-plane" ? { Outputs: { ModelRunPriceVersion: { Value: "1" } } } : {}),
    }),
    packagePath: (id) => `/tmp/fake-release/packages/${id}.zip`,
  };
}

describe("self-hosted Model Gateway stack (issue #1554)", () => {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxRegion: "us-east-1" });
  const stack = app.node.findChild("AgentXModelGateway") as Stack;
  const template = Template.fromStack(stack);
  const json = template.toJSON() as {
    Resources: Record<string, { Type: string; Properties: Record<string, unknown>; Condition?: string }>;
    Outputs: Record<string, unknown>;
  };

  it("synthesizes agentx-<env>-gateway for named environments only, inside foundation's VPC with no duplicate VPC", () => {
    expect(stack).toBeInstanceOf(SelfHostedModelGatewayStack);
    expect(stack.stackName).toBe("agentx-staging-gateway");
    expect(buildAgentXApp().node.tryFindChild("AgentXModelGateway")).toBeUndefined();
    const types = Object.values(json.Resources).map((r) => r.Type);
    expect(types).not.toContain("AWS::EC2::VPC");
    expect(types).not.toContain("AWS::EC2::NatGateway");
    expect(types).toContain("AWS::ElasticLoadBalancingV2::LoadBalancer");
    expect(types).toContain("AWS::ApiGatewayV2::VpcLink");
    expect(types).toContain("AWS::ApiGatewayV2::Api");
    expect(types).toContain("AWS::ECS::Service");
    expect(types).toContain("AWS::Scheduler::Schedule");
  });

  it("configures 60-minute ALB idle timeout, cold-start price seeding, /agentx/<env>/ role path, boundary, and registered alarms", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
      LoadBalancerAttributes: [
        { Key: "idle_timeout.timeout_seconds", Value: "3600" },
        { Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" },
      ],
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 2,
      LaunchType: "FARGATE",
      EnableExecuteCommand: false,
    });
    const tasks = Object.values(json.Resources).filter((r) => r.Type === "AWS::ECS::TaskDefinition");
    const serveTask = tasks.find((t) => String(t.Properties.Family).endsWith("-gateway"))!;
    const env = (serveTask.Properties.ContainerDefinitions as Array<{ Environment: Array<Record<string, unknown>> }>)[0]!.Environment;
    expect(env).toContainEqual({ Name: "GATEWAY_SEED_PRICES_ON_START", Value: "on" });
    expect(env).toContainEqual({ Name: "GATEWAY_ROVARA_AI_MODELS", Value: "on" });
    expect(env.some((e) => e.Name === "GATEWAY_COMPANY_TABLE")).toBe(false);
    // Conditional provider secret entries must use PascalCase Name/Value for CloudFormation.
    const conditionalEnv = env.filter((e) => "Fn::If" in e);
    expect(conditionalEnv).toHaveLength(3);
    for (const entry of conditionalEnv) {
      const tuple = entry["Fn::If"] as [string, Record<string, unknown>, unknown];
      expect(tuple[1]).toHaveProperty("Name");
      expect(tuple[1]).toHaveProperty("Value");
      expect(tuple[1]).not.toHaveProperty("name");
    }

    const roles = Object.values(json.Resources).filter((r) => r.Type === "AWS::IAM::Role");
    expect(roles.length).toBeGreaterThanOrEqual(4);
    for (const role of roles) {
      expect(role.Properties.Path).toBe("/agentx/staging/");
      expect(role.Properties.PermissionsBoundary).toBeDefined();
    }

    const alarms = Object.values(json.Resources).filter((r) => r.Type === "AWS::CloudWatch::Alarm");
    expect(alarms).toHaveLength(3);
    for (const alarm of alarms) {
      const name = String(alarm.Properties.AlarmName);
      expect(name.startsWith("agentx-staging-")).toBe(true);
      expect(HEALTH_ALARM_SUFFIXES).toContain(name.slice("agentx-staging-".length));
    }
    expect(Object.keys(json.Outputs).sort()).toEqual([
      "ClusterArn", "GatewayCaCertParameter", "GatewayHost", "GatewayUrl", "InternalGatewayUrl", "Issuer", "ServiceArn",
    ]);
  });

  it("keeps GATEWAY_TLS_CERT_CODE under CloudFormation's 4096-byte inline limit and mints a valid CA + leaf cert", async () => {
    expect(Buffer.byteLength(GATEWAY_TLS_CERT_CODE, "utf8")).toBeLessThan(4096);
    let imported: { cert: string; key: string; chain: string } | undefined;
    let storedCa: { name: string; value: string } | undefined;
    let cfnReply: Record<string, unknown> | undefined;

    const dnsName = "internal-agentx-staging-gateway-123456789.us-east-1.elb.amazonaws.com";
    const fakeRequire = (id: string): unknown => {
      if (id === "node:crypto") return nodeCrypto;
      if (id === "node:https") {
        return {
          request: (_url: string, _opts: unknown, cb: (res: { resume(): void; on(ev: string, fn: () => void): void }) => void) => ({
            on: () => undefined,
            end: (body: string) => {
              cfnReply = JSON.parse(body) as Record<string, unknown>;
              cb({ resume: () => undefined, on: (ev, fn) => { if (ev === "end") fn(); } });
            },
          }),
        };
      }
      if (id === "@aws-sdk/client-acm") {
        return {
          ACMClient: class {
            async send(cmd: { input: { Certificate: Buffer; PrivateKey: Buffer; CertificateChain: Buffer } }) {
              imported = {
                cert: cmd.input.Certificate.toString("utf8"),
                key: cmd.input.PrivateKey.toString("utf8"),
                chain: cmd.input.CertificateChain.toString("utf8"),
              };
              return { CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555" };
            }
          },
          ImportCertificateCommand: class { constructor(readonly input: unknown) {} },
          DeleteCertificateCommand: class { constructor(readonly input: unknown) {} },
        };
      }
      if (id === "@aws-sdk/client-ssm") {
        return {
          SSMClient: class {
            async send(cmd: { input: { Name: string; Value: string } }) {
              storedCa = { name: cmd.input.Name, value: cmd.input.Value };
              return {};
            }
          },
          PutParameterCommand: class { constructor(readonly input: unknown) {} },
          DeleteParameterCommand: class { constructor(readonly input: unknown) {} },
        };
      }
      throw new Error(`unexpected require: ${id}`);
    };
    const mod = { exports: {} as { handler?: (event: unknown) => Promise<void> } };
    vm.runInNewContext(GATEWAY_TLS_CERT_CODE, { require: fakeRequire, exports: mod.exports, module: mod, Buffer, Date, JSON, Promise, String });
    await mod.exports.handler!({
      RequestType: "Create",
      ResponseURL: "https://cfn.invalid/reply",
      StackId: "stack-1",
      RequestId: "req-1",
      LogicalResourceId: "GatewayTlsCert",
      ResourceProperties: { DnsName: dnsName, CaCertParameter: "/agentx/staging/gateway/ca-cert" },
    });
    expect(cfnReply?.Status).toBe("SUCCESS");
    expect(imported).toBeDefined();
    expect(storedCa?.name).toBe("/agentx/staging/gateway/ca-cert");
    expect(storedCa?.value).toBe(imported!.chain);
    const caCert = new nodeCrypto.X509Certificate(imported!.chain);
    const leafCert = new nodeCrypto.X509Certificate(imported!.cert);
    expect(caCert.ca).toBe(true);
    expect(leafCert.ca).toBe(false);
    expect(leafCert.verify(caCert.publicKey)).toBe(true);
    expect(leafCert.checkHost(dnsName)).toBe(dnsName);
  });

  it("breaks the control-plane <-> gateway cycle in deployEnvironment and wires CoreModelGatewayHost before runtime", async () => {
    const deployed: DeployRequest[] = [];
    const stackOutputs = new Map<string, StackOutputs>();
    const deployer: StackDeployer = {
      async deploy(request) {
        deployed.push(request);
        const out: StackOutputs = request.part === "access"
          ? { ArtifactBucketName: "bucket", CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-demo-cloudformation", OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-demo-operator", PullThroughPrefix: "agentx-demo" }
          : request.part === "foundation"
            ? { VpcId: "vpc-123", PrivateSubnetIds: "subnet-1,subnet-2", WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555", DispatcherSecurityGroupId: "sg-disp", SessionManagerSecurityGroupId: "sg-sm", Ec2WorkerLaunchTemplateId: "lt-1", Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/demo/worker", Ec2WorkerSubnets: "us-east-1a=subnet-1,us-east-1b=subnet-2" }
            : request.part === "identity"
              ? { Issuer: "https://cognito.example", Audience: "aud-1", ClientId: "client-1" }
              : request.part === "control-plane"
                ? { ApiEndpoint: "https://api.example", ModelRunPriceVersion: "1", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-demo-alerts", SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx/demo/slack", SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "threads", TurnRecordsTableName: "turns", SlackThreadSessionBucketName: "sessions", SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/demo/slack-AbCdEf" }
                : request.part === "gateway"
                  ? { GatewayHost: FAKE_GATEWAY_HOST, GatewayUrl: `https://${FAKE_GATEWAY_HOST}`, InternalGatewayUrl: "https://internal-alb.example" }
                  : {};
        stackOutputs.set(request.stackName, out);
        return out;
      },
      async outputs(stackName) { return stackOutputs.get(stackName); },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://${FAKE_GATEWAY_HOST}/healthz`) {
        return new Response(JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 1 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    try {
      const store = new MemoryParameterStore();
      let waitedOrigin: string | undefined;
      let jwksUrlCalled: string | undefined;
      const result = await deployEnvironment({
        mode: "install",
        engine: "templates",
        answers: {
          env: "demo",
          region: "us-east-1",
          account: "123456789012",
          models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
          coreEngine: { modelGatewayUrl: "", agentModel: "claude-sonnet-4-6" },
          identity: { mode: "cognito" },
          github: { appId: "12345", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/demo/github-app-AbCdEf" },
        },
        release: fakeRelease(),
        deployer,
        store,
        secrets: { get: async () => "k".repeat(40), create: async () => undefined },
        holder: "arn:aws:iam::123456789012:user/test",
        fetchTaskKeyIds: async (url) => { jwksUrlCalled = url; return FAKE_TASK_KID; },
        waitForGateway: async (origin) => { waitedOrigin = origin; },
      });

      expect(result.settingsWritten).toBe(true);
      expect(deployed.map((d) => d.part)).toEqual([
        "access", "foundation", "identity", "control-plane", "gateway", "control-plane", "runtime", "slack",
      ]);
      // Initial control-plane deploy deferred gateway host; second wired it in before runtime.
      expect(deployed[3]!.allowDeferredGateway).toBe(true);
      expect(deployed[3]!.parameters.CoreModelGatewayHost).toBeUndefined();
      expect(jwksUrlCalled).toBe("https://api.example");
      expect(deployed[4]!.parameters.CodeTaskKeyIds).toBe(FAKE_TASK_KID);
      expect(waitedOrigin).toBe(`https://${FAKE_GATEWAY_HOST}`);
      expect(deployed[5]!.allowDeferredGateway).toBeUndefined();
      expect(deployed[5]!.parameters.CoreModelGatewayHost).toBe(FAKE_GATEWAY_HOST);

      const settings = await readEnvironmentSettings(store, "demo");
      expect(settings?.stacks.gateway).toBe(environmentStackName("demo", "gateway"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
