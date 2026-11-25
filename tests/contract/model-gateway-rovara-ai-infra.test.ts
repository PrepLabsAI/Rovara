// DEC 240 in the gateway stack: Rovara's AI for agents. Made only with -c rovaraModelGatewayRovaraAi=<allow-list> beside
// -c rovaraModelGatewayProductAi=on, refused for production at synth. The serving role then gets EXACTLY bedrock:InvokeModel and
// bedrock:InvokeModelWithResponseStream on the allow-listed system inference profiles in its Region and, only through those
// profiles (bedrock:InferenceProfileArn), their foundation models in the profile's Regions. No other Bedrock action or resource.
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { parseRovaraAiModels, ROVARA_AI_US_CONVERSE_MODELS as GATEWAY_US_CONVERSE_MODELS, ROVARA_AI_US_MODELS as GATEWAY_US_MODELS } from "../../packages/model-gateway/src/agent-ai.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { rovaraAiContext } from "../../infra/lib/model-gateway-app.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_ENV, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, ROVARA_AI_US_CONVERSE_MODELS, ROVARA_AI_US_MODELS, rovaraAiModelIds } from "../../infra/lib/model-gateway.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const app = (context: Record<string, string>, env = "staging") => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: env, agentxRegion: "us-west-2", ...context });
const synth = (context: Record<string, string>) => Template.fromStack(app(context).node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource> };
const MODELS = "claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5,claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0";
const FOUNDERS = `org_${"f".repeat(20)}`;
const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };
const on = synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: FOUNDERS });
const without = synth(productOn);

// CDK moves statements past the inline size limit into a managed "overflow" policy on the same role: both are read.
// The role boundary (model-gateway-boundary.ts) is a ManagedPolicy attached to no role: a ceiling, not a grant, so it is not read here.
const statements = (t: { Resources: Record<string, Resource> }): Statement[] => Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy" || (r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.Roles !== undefined)).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const actionsOf = (s: Statement) => [s.Action].flat();
const bedrock = (t: { Resources: Record<string, Resource> }) => statements(t).filter((s) => actionsOf(s).some((a) => a.startsWith("bedrock:")));
const join = (parts: unknown[]) => ({ "Fn::Join": ["", parts] });
const profileArn = (id: string) => join(["arn:", { Ref: "AWS::Partition" }, ":bedrock:us-west-2:", { Ref: "AWS::AccountId" }, `:inference-profile/${id}`]);
const modelArn = (region: string, model: string) => join(["arn:", { Ref: "AWS::Partition" }, `:bedrock:${region}::foundation-model/${model}`]);
const serveEnv = (t: { Resources: Record<string, Resource> }) => {
  const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1];
  const container = (task.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  return Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));
};

describe("Rovara's AI in the gateway stack (DEC 240)", () => {
  it("absent: no Bedrock grant and no Rovara's AI setting (the template as before)", () => {
    expect(bedrock(without)).toEqual([]);
    expect(serveEnv(without)[GATEWAY_ENV.rovaraAiModels]).toBeUndefined();
    expect(rovaraAiContext(undefined, undefined)).toEqual({});
  });

  it("on: exactly the two invoke actions, on the allow-listed profiles and (only through them) their models", () => {
    const granted = bedrock(on);
    expect(granted.map((s) => s.Sid).sort()).toEqual(["RovaraAiProfileModels", "RovaraAiProfiles"]);
    for (const s of granted) {
      expect(s.Effect).toBe("Allow");
      expect([...actionsOf(s)].sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    }
    const bySid: Record<string, Statement> = Object.fromEntries(granted.map((s) => [s.Sid ?? "", s]));
    const profiles = [profileArn("us.anthropic.claude-sonnet-5-5"), profileArn("us.anthropic.claude-haiku-4-5-20251001-v1:0")];
    expect(bySid.RovaraAiProfiles!.Resource).toEqual(profiles);
    expect(bySid.RovaraAiProfiles!.Condition).toBeUndefined();
    expect(bySid.RovaraAiProfileModels!.Resource).toEqual(["us-east-1", "us-east-2", "us-west-2"].map((r) => modelArn(r, "anthropic.claude-sonnet-5-5"))
      .concat(["us-east-1", "us-east-2", "us-west-2"].map((r) => modelArn(r, "anthropic.claude-haiku-4-5-20251001-v1:0"))));
    expect(bySid.RovaraAiProfileModels!.Condition).toEqual({ StringEquals: { "bedrock:InferenceProfileArn": profiles } });
    // Nothing else of Bedrock: no wildcard action, no control plane, no Marketplace, no other model.
    const all = statements(on).flatMap(actionsOf);
    expect(all.filter((a) => /^(bedrock|aws-marketplace|bedrock-mantle):/u.test(a)).sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModelWithResponseStream"]);
    expect(JSON.stringify(granted)).not.toContain("*");
  });

  it("on: the process gets the allow-list and the operator's exempt list as set", () => {
    const env = serveEnv(on);
    expect(env[GATEWAY_ENV.rovaraAiModels]).toBe(MODELS);
    expect(MODEL_GATEWAY_ENV.rovaraAiSourceId).toBe(GATEWAY_ENV.rovaraAiSourceId);
    const role = Object.keys(on.Resources).find(id => id.startsWith("ServeTaskRole") && on.Resources[id]!.Type === "AWS::IAM::Role")!;
    expect(env[GATEWAY_ENV.rovaraAiSourceId]).toEqual(join([{ "Fn::GetAtt": [role, "Arn"] }, "@us-west-2"]));
    expect(env[GATEWAY_ENV.rovaraAiExempt]).toBe(FOUNDERS);
    expect(MODEL_GATEWAY_ENV.rovaraAiModels).toBe(GATEWAY_ENV.rovaraAiModels);
    expect(MODEL_GATEWAY_ENV.rovaraAiExempt).toBe(GATEWAY_ENV.rovaraAiExempt);
    expect(serveEnv(synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS }))[GATEWAY_ENV.rovaraAiExempt]).toBeUndefined();
  });

  it("on: the built-in allow-list of DEC 243 and 243c (five Claude models on us. profiles, fourteen other coding models), the same lists the process reads", () => {
    const t = synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "on" });
    expect(ROVARA_AI_US_MODELS).toBe(GATEWAY_US_MODELS);
    expect(ROVARA_AI_US_CONVERSE_MODELS).toBe(GATEWAY_US_CONVERSE_MODELS);
    expect(serveEnv(t)[GATEWAY_ENV.rovaraAiModels]).toBe(`${GATEWAY_US_MODELS},${GATEWAY_US_CONVERSE_MODELS}`);
    expect([...parseRovaraAiModels(`${GATEWAY_US_MODELS},${GATEWAY_US_CONVERSE_MODELS}`, "us-west-2")]).toHaveLength(23);
    const profiles = ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-haiku-5-5", "us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-opus-5-5", "us.anthropic.claude-fable-5-2", "us.amazon.nova-2-lite-v1:0", "us.amazon.nova-pro-v1:0", "us.moonshotai.kimi-k3", "us.moonshotai.kimi-k3.1"];
    const bySid: Record<string, Statement> = Object.fromEntries(bedrock(t).map((s) => [s.Sid ?? "", s]));
    expect(bySid.RovaraAiProfiles!.Resource).toEqual(profiles.map(profileArn));
    // 9 profiles x 3 US Regions, only through those profiles; the 13 in-Region models in us-west-2 only.
    expect([bySid.RovaraAiProfileModels!.Resource].flat()).toHaveLength(27);
    expect([bySid.RovaraAiModels!.Resource].flat()).toEqual(["qwen.qwen3-coder-480b-a35b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-235b-a22b-2507-v1:0", "mistral.devstral-2-123b", "mistral.mistral-large-3-675b-instruct", "deepseek.v3-v1:0", "moonshotai.kimi-k2.5", "zai.glm-5", "zai.glm-4.7", "openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0", "moonshot.kimi-k2-thinking", "minimax.minimax-m2.5"].map((m) => modelArn("us-west-2", m)));
    expect(Object.keys(bySid).sort()).toEqual(["RovaraAiModels", "RovaraAiProfileModels", "RovaraAiProfiles"]);
    // Every policy that carries a Bedrock action is attached to the serving role only.
    // (Except the role boundary, attached to nothing: it bounds every role and grants nothing.)
    for (const r of Object.values(t.Resources).filter((x) => (x.Type === "AWS::IAM::Policy" || (x.Type === "AWS::IAM::ManagedPolicy" && x.Properties.Roles !== undefined)) && JSON.stringify(x.Properties.PolicyDocument).includes("bedrock:"))) {
      expect((r.Properties.Roles as Array<{ Ref: string }>).map((role) => role.Ref)).toEqual([expect.stringMatching(/^ServeTaskRole/u)]);
      expect(r.Properties.Users).toBeUndefined(); expect(r.Properties.Groups).toBeUndefined();
    }
  });

  it("DEC 243c: a non-Claude model in this Region is granted there only; one on its us. profile only through that profile", () => {
    const list = "claude-haiku-5-5=us.anthropic.claude-haiku-5-5,qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0,us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1";
    const t = synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: list });
    const bySid: Record<string, Statement> = Object.fromEntries(bedrock(t).map((s) => [s.Sid ?? "", s]));
    expect(Object.keys(bySid).sort()).toEqual(["RovaraAiModels", "RovaraAiProfileModels", "RovaraAiProfiles"]);
    for (const s of Object.values(bySid)) expect([...actionsOf(s)].sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    expect([bySid.RovaraAiModels!.Resource].flat()).toEqual([modelArn("us-west-2", "qwen.qwen3-coder-480b-a35b-v1:0")]);
    expect(bySid.RovaraAiModels!.Condition).toBeUndefined();
    expect(bySid.RovaraAiProfiles!.Resource).toEqual([profileArn("us.anthropic.claude-haiku-5-5"), profileArn("us.moonshotai.kimi-k3.1")]);
    expect([bySid.RovaraAiProfileModels!.Resource].flat()).toEqual(expect.arrayContaining(["us-east-1", "us-east-2", "us-west-2"].map((r) => modelArn(r, "moonshotai.kimi-k3.1"))));
    expect(bySid.RovaraAiProfileModels!.Condition).toEqual({ StringEquals: { "bedrock:InferenceProfileArn": [profileArn("us.anthropic.claude-haiku-5-5"), profileArn("us.moonshotai.kimi-k3.1")] } });
  });

  it("allowed for production with product AI (Rovara-cloud#247), with no exempt companies there", () => {
    const production = Template.fromStack(app({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, rovaraAiSourceKinds: "openai" }, "production").node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource> };
    expect(JSON.stringify(production.Resources)).toContain("GATEWAY_ROVARA_AI_MODELS");
    expect(() => app({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: `org_${"a".repeat(20)}`, rovaraAiSourceKinds: "openai" }, "production")).toThrow(/exempt/u);
  });

  it("refused at synth: without product AI (company-key mode), global or another geography, bad lists", () => {
    expect(() => synth({ [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS })).toThrow(/needs rovaraModelGatewayProductAi=on/u);
    for (const bad of ["claude-sonnet-5-5=anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=global.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=eu.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=us.meta.llama3", "x=us.anthropic.claude-a", "claude-a=us.anthropic.claude-a,claude-a=us.anthropic.claude-b"]) {
      expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: bad })).toThrow();
    }
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "founders" })).toThrow();
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: FOUNDERS })).toThrow();
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "" })).toThrow();
  });

  it("synth and the process accept and refuse the same allow-lists", () => {
    for (const value of ["qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0", "us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1", "moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1", "kimi=us.moonshotai.kimi-k3.1", "global.moonshotai.kimi-k3.1=global.moonshotai.kimi-k3.1", "eu.xai.grok-4.7=eu.xai.grok-4.7", MODELS, GATEWAY_US_MODELS, "claude-sonnet-5-5=anthropic.claude-sonnet-5-5", "claude-a=global.anthropic.claude-a", "claude-a=eu.anthropic.claude-a", "claude-a=us.anthropic.claude-a=x", "a=us.anthropic.claude-a", ""]) {
      let synthOk = true; let processOk = true;
      try { rovaraAiModelIds(value, "us-west-2"); } catch { synthOk = false; }
      try { parseRovaraAiModels(value, "us-west-2"); } catch { processOk = false; }
      expect([value, synthOk]).toEqual([value, processOk]);
    }
  });
});

describe("models held back from the offered list (GATEWAY_AGENT_MODELS_DISABLED)", () => {
  it("absent: no setting (the gateway's default list applies, and the template is as before); set: passed as given, empty included", () => {
    expect(serveEnv(on)[GATEWAY_ENV.agentModelsDisabled]).toBeUndefined();
    expect(MODEL_GATEWAY_ENV.agentModelsDisabled).toBe(GATEWAY_ENV.agentModelsDisabled);
    expect(serveEnv(synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY]: "claude-opus-5-5" }))[GATEWAY_ENV.agentModelsDisabled]).toBe("claude-opus-5-5");
    expect(serveEnv(synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY]: "" }))[GATEWAY_ENV.agentModelsDisabled]).toBe("");
    expect(rovaraAiContext(MODELS, undefined, undefined)).toEqual({ rovaraAi: { models: MODELS } });
  });
  it("refused: never alone, not a list of model names", () => {
    expect(() => rovaraAiContext(undefined, undefined, "claude-opus-5-5")).toThrow(/needs rovaraModelGatewayRovaraAi/u);
    expect(() => rovaraAiContext(MODELS, undefined, 5)).toThrow();
    for (const bad of ["a b", "../x", "claude-opus-5-5,", "a,a"]) expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY]: bad })).toThrow();
  });
});

it("DEC 328: the sole install-setting grant is GetItem on the exact reserved partition and Companies ARN", () => {
  const grant = statements(on).filter(s => s.Sid === "ReadInstallRovaraAi");
  expect(grant).toEqual([{
    Sid: "ReadInstallRovaraAi", Effect: "Allow", Action: "dynamodb:GetItem",
    Resource: join(["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-west-2:", { Ref: "AWS::AccountId" }, ":table/", { Ref: "CompanyTableName" }]),
    Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["INSTALL#ROVARA_AI"] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }]);
  expect(statements(without).filter(s => s.Sid === "ReadInstallRovaraAi")).toEqual(grant);
  // No wildcard/prefix or wider install read/write sneaks into another grant.
  expect(statements(on).filter(s => JSON.stringify(s).includes("INSTALL#"))).toEqual(grant);
});
