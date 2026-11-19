// Lane L4-NETG (DEC 254zzz77): the setting that turns the worker hosts' sandbox egress gateway on, on the synthesised templates and in the session steps handler. What must hold:
//   1. one stack parameter WorkerSandboxEgress: bridge by default, exactly bridge | gateway, named environments only, kept by an upgrade, set with `agentx config set workerSandboxEgress`;
//   2. ONLY the session steps (which build the boot configuration) read it, as a plain variable: no packed setting, nothing on the broker or the dispatcher, and no new resource of any other kind;
//   3. the handler adds AGENTX_SANDBOX_EGRESS=gateway to a launch's boot configuration only for exactly `gateway`; `bridge` adds nothing, so its user data is byte-identical to before.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { WORKER_SANDBOX_EGRESS_DEFAULT, WORKER_SANDBOX_EGRESS_PARAMETER, WORKER_SANDBOX_EGRESS_SETTING_VARIABLE, WORKER_SANDBOX_EGRESS_VALUES } from "@agentx/contracts";
import { workerSandboxEgressGateway } from "../../packages/contracts/src/worker-sandbox-egress.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { createSessionStepsHandler } from "../../packages/broker/src/aws/session-steps.js";
import { configKey } from "../../packages/cli/src/config/keys.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Json = { Parameters: Record<string, { Default?: string; AllowedValues?: string[]; Type?: string }>; Resources: Record<string, Resource> };
const named = Template.fromStack(new ControlPlaneStack(new App(), "NetgNamedControlPlane", { naming: environmentNaming("staging") }));
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "NetgLegacyControlPlane"));
const json = named.toJSON() as Json;
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");

describe("the stack parameter WorkerSandboxEgress", () => {
  it("is bridge by default, exactly bridge or gateway, a plain string, named environments only", () => {
    expect(WORKER_SANDBOX_EGRESS_PARAMETER).toBe("WorkerSandboxEgress");
    expect(json.Parameters.WorkerSandboxEgress).toMatchObject({ Type: "String", Default: "bridge", AllowedValues: ["bridge", "gateway"] });
    expect(WORKER_SANDBOX_EGRESS_DEFAULT).toBe("bridge");
    expect([...WORKER_SANDBOX_EGRESS_VALUES]).toEqual(["bridge", "gateway"]);
    expect((legacy.toJSON() as Json).Parameters).not.toHaveProperty("WorkerSandboxEgress");
  });

  it("is read by the session steps only, as a plain variable: not packed, not on the broker or the dispatcher, and nothing else in the template refers to it", () => {
    const users = Object.entries(json.Resources).filter(([, resource]) => /"Ref":"WorkerSandboxEgress"/u.test(JSON.stringify(resource))).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
    expect(users).toEqual(["SessionsSteps"]);
    const steps = Object.entries(json.Resources).find(([id, resource]) => /^SessionsSteps[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
    expect((steps[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables[WORKER_SANDBOX_EGRESS_SETTING_VARIABLE]).toStrictEqual({ Ref: "WorkerSandboxEgress" });
    for (const id of ["Broker", "Dispatcher"]) {
      const fn = Object.entries(json.Resources).find(([key, resource]) => new RegExp(`^${id}[0-9A-F]{8}$`, "u").test(key) && resource.Type === "AWS::Lambda::Function")!;
      expect(JSON.stringify(fn[1].Properties.Environment)).not.toContain(WORKER_SANDBOX_EGRESS_SETTING_VARIABLE);
    }
  });

  it("adds no resource of its own and no DNS resolver resource (the gateway forwards to the VPC resolver, never around it)", () => {
    expect(Object.values(json.Resources).filter((resource) => resource.Type.startsWith("AWS::Route53Resolver::")).length).toBe(0);
    // The only places the name appears in the template text: the parameter, and the one variable's reference.
    const text = JSON.stringify(json);
    expect(text.match(/WorkerSandboxEgress/gu)?.length).toBe(2);
  });

  it("is an operator setting an upgrade keeps, set with `agentx config set workerSandboxEgress`", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("WorkerSandboxEgress");
    const key = configKey("workerSandboxEgress");
    expect(key.target).toEqual({ kind: "stack-parameter", part: "control-plane", parameter: "WorkerSandboxEgress" });
    expect(key.defaultValue).toBe("bridge");
    expect(key.parse("gateway")).toBe("gateway");
    expect(key.parse(" bridge ")).toBe("bridge");
    for (const bad of ["Gateway", "on", "1", "", "bridge,gateway"]) expect(() => key.parse(bad), bad).toThrow();
  });
});

describe("the session steps handler", () => {
  const launch = async (more: { sandboxEgressGateway?: boolean }): Promise<string> => {
    const handler = createSessionStepsHandler({
      sessions: { markVolume: vi.fn(), markInstance: vi.fn(), markReady: vi.fn(), markFailed: vi.fn(), markDeleted: vi.fn() },
      workerSettings: async () => ({ workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`, modelProvider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", promptCacheRetention: "long" as const }),
      invokePublicKey: async () => `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
      bootScript: () => bootScript,
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      logGroupName: "/agentx/production/worker",
      ping: async () => ({ status: "Healthy" }),
      ...more,
    });
    const result = await handler({ action: "launchConfiguration", workspaceId: "11111111-2222-4333-8444-555555555555", generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as { userData: string };
    return gunzipSync(Buffer.from(result.userData, "base64")).toString("utf8");
  };

  it("adds AGENTX_SANDBOX_EGRESS=gateway to the boot configuration only when the deployed setting is exactly gateway; otherwise the user data is exactly what it was", async () => {
    const off = await launch({});
    expect(off).not.toContain("export AGENTX_SANDBOX_EGRESS");
    expect(await launch({ sandboxEgressGateway: false })).toBe(off);
    const on = await launch({ sandboxEgressGateway: true });
    expect(on).toContain("export AGENTX_SANDBOX_EGRESS='gateway'");
    expect(on.split("\n").filter((line) => !off.split("\n").includes(line))).toEqual(["export AGENTX_SANDBOX_EGRESS='gateway'"]);
  });

  it("the deployed handler reads the setting from the one variable, exactly `gateway` and nothing else", () => {
    expect(workerSandboxEgressGateway({})).toBe(false);
    for (const value of ["bridge", "Gateway", "gateway ", "1", "true", ""]) expect(workerSandboxEgressGateway({ ROVARA_WORKER_SANDBOX_EGRESS: value }), value).toBe(false);
    expect(workerSandboxEgressGateway({ ROVARA_WORKER_SANDBOX_EGRESS: "gateway" })).toBe(true);
    expect(readFileSync(new URL("../../packages/broker/src/aws/session-steps.ts", import.meta.url), "utf8")).toContain("sandboxEgressGateway: workerSandboxEgressGateway(process.env),");
  });
});

describe("the project's S3 lift reaches the worker through the existing prepare payload (DEC 254zzz90)", () => {
  it("the broker sends the exact S3 hosts of the project's allowed websites in a prepare invocation, only to a worker that lists the feature and only when there are some; no new route, role or permission is added", () => {
    const dispatch = readFileSync(new URL("../../packages/broker/src/core/task-flow/dispatch.ts", import.meta.url), "utf8");
    expect(dispatch).toContain("const s3Hosts = features.includes(PREPARE_EGRESS_S3_FEATURE) ? projectAllowedS3Hosts(project.definition.network?.allowedDomains) : [];");
    expect(dispatch).toContain("...(s3Hosts.length === 0 ? {} : { egressS3Allow: s3Hosts }),");
    const worker = readFileSync(new URL("../../packages/worker/src/main.ts", import.meta.url), "utf8");
    expect(worker.indexOf("await publishEgressS3Allow(invocation.payload.egressS3Allow);")).toBeGreaterThan(-1);
    expect(worker.indexOf("await publishEgressS3Allow(")).toBeLessThan(worker.indexOf("await prepareWorkspace({"));
    expect(readFileSync(new URL("../../packages/worker/src/implemented-features.ts", import.meta.url), "utf8")).toContain('"prepare.egressS3.v1"');
  });
});
