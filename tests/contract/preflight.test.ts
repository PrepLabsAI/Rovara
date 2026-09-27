import { describe, expect, it } from "vitest";
import { validateInstanceRegion, validateRuntimeSessionId } from "../../scripts/preflight.js";
import { evaluateEc2Preflight, type Ec2PreflightFacts } from "../../scripts/ec2-preflight.js";

describe("local preflight", () => {
  it("accepts a documented Instances region", () => {
    expect(() => validateInstanceRegion("us-west-2")).not.toThrow();
  });

  it("rejects an unsupported Instances region", () => {
    expect(() => validateInstanceRegion("eu-west-3")).toThrow(/not recorded as supported/);
  });

  it("enforces AgentCore runtime session ID lengths", () => {
    expect(() => validateRuntimeSessionId("short")).toThrow(/between 33 and 256/);
    expect(() => validateRuntimeSessionId("a".repeat(33))).not.toThrow();
  });
});

describe("EC2 worker preflight (#87)", () => {
  const healthy: Ec2PreflightFacts = {
    launchTemplate: { instanceType: "m6g.medium", imageId: "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", httpTokens: "required", hopLimit: 1 },
    image: { imageId: "ami-0123456789abcdef0", architecture: "arm64", state: "available" },
    subnets: [
      { subnetId: "subnet-0aaaaaaaaaaaaaaaa", availabilityZone: "us-east-1a", state: "available", freeAddresses: 4000 },
      { subnetId: "subnet-0bbbbbbbbbbbbbbbb", availabilityZone: "us-east-1b", state: "available", freeAddresses: 4000 },
    ],
    instanceTypeZones: ["us-east-1a", "us-east-1b", "us-east-1c"],
    signingKey: { enabled: true, keySpec: "ECC_NIST_P256", keyUsage: "SIGN_VERIFY" },
    workspaceKey: { enabled: true },
    workerSettings: {
      workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
      modelProvider: "amazon-bedrock",
      modelId: "amazon.nova-pro-v1:0",
      promptCacheRetention: "long",
    },
    stateMachines: [{ name: "provisioner", status: "ACTIVE" }, { name: "deleter", status: "ACTIVE" }],
    vcpuQuota: 32,
    runningStandardVcpus: 4,
    lambdaConcurrency: 1000,
  };
  const levelOf = (facts: Ec2PreflightFacts, name: string) => evaluateEc2Preflight(facts).find((check) => check.name === name)!.level;

  it("passes every check for a ready environment", () => {
    expect(evaluateEc2Preflight(healthy).filter((check) => check.level !== "pass")).toEqual([]);
  });

  it.each([
    ["launch template", { launchTemplate: undefined }],
    ["IMDSv2 at hop limit 1", { launchTemplate: { ...healthy.launchTemplate, hopLimit: 2 } }],
    ["IMDSv2 at hop limit 1", { launchTemplate: { ...healthy.launchTemplate, httpTokens: "optional" } }],
    ["worker AMI", { image: { imageId: "ami-0123456789abcdef0", architecture: "x86_64", state: "available" } }],
    ["worker AMI", { image: undefined }],
    ["subnets", { subnets: [] }],
    ["subnets", { subnets: [{ subnetId: "subnet-0aaaaaaaaaaaaaaaa", availabilityZone: "us-east-1a" }] }],
    ["instance type offered", { instanceTypeZones: ["us-east-1a"] }],
    ["invoke signing key", { signingKey: { enabled: false, keySpec: "ECC_NIST_P256", keyUsage: "SIGN_VERIFY" } }],
    ["invoke signing key", { signingKey: { enabled: true, keySpec: "RSA_2048", keyUsage: "SIGN_VERIFY" } }],
    ["workspace volume key", { workspaceKey: undefined }],
    ["worker settings", { workerSettings: { ...healthy.workerSettings, modelId: undefined } }],
    ["worker settings", { workerSettings: { ...healthy.workerSettings, workerImage: "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production:latest" } }],
    ["session state machines", { stateMachines: [{ name: "provisioner", status: "ACTIVE" }, { name: "deleter" }] }],
    ["On-Demand vCPU quota", { vcpuQuota: 4, runningStandardVcpus: 4 }],
    ["On-Demand vCPU quota", { vcpuQuota: undefined }],
  ] as Array<[string, Partial<Ec2PreflightFacts>]>)("fails %s when it is not ready", (name, change) => {
    const facts = { ...healthy, ...change };
    for (const key of Object.keys(change) as Array<keyof Ec2PreflightFacts>) if (change[key] === undefined) delete facts[key];
    expect(levelOf(facts, name)).toBe("fail");
  });

  it("only warns about low subnet addresses and Lambda concurrency", () => {
    expect(levelOf({ ...healthy, lambdaConcurrency: 10 }, "Lambda concurrency")).toBe("warn");
    expect(levelOf({ ...healthy, subnets: healthy.subnets.map((subnet) => ({ ...subnet, freeAddresses: 3 })) }, "subnet addresses")).toBe("warn");
  });
});
