// PH-S3-PREFIXES: each Code release role and model gateway build role (beta and production) writes only its own output artifacts into the
// pipeline's artifact bucket, which is not versioned and holds the Source artifact Production reads after approval. Synthesized template only.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_BUILD_ROLE_NAME,
  AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME,
  AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME,
  AGENTX_BETA_RELEASE_PROJECT_NAME,
  AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME,
  AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME,
  AGENTX_RELEASE_PIPELINE_NAME,
  AGENTX_RELEASE_PROJECT_NAME,
  ARTIFACT_KEY_NAME_CHARS,
  ARTIFACT_KEY_PIPELINE_CHARS,
  MODEL_GATEWAY_STATE_ARTIFACT_PREFIXES,
  MODEL_GATEWAY_STEPS,
  ReleasePipelineStack,
  artifactKeyPattern,
  modelGatewayStateArtifactName,
} from "../../infra/lib/release-pipeline.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
const BUCKET_ARN = "arn:aws:s3:::sample-artifact-bucket";
const template = Template.fromStack(new ReleasePipelineStack(new App(), "S3PrefixesPipeline", { env: { region: "us-east-1", account: "123456789012" } })).toJSON() as { Resources: Record<string, Resource> };
const resources = Object.entries(template.Resources);
const bucketId = resources.find(([, r]) => r.Type === "AWS::S3::Bucket")![0];

const globMatch = (pattern: string, text: string): boolean =>
  new RegExp(`^${pattern.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))).join("")}$`, "su").test(text);

function text(value: unknown): string {
  if (typeof value === "string") return value;
  const [[fn, arg]] = Object.entries(value as Record<string, unknown>) as [[string, unknown]];
  if (fn === "Fn::Join") return (arg as [string, unknown[]])[1].map(text).join((arg as [string, unknown[]])[0]);
  if (fn === "Fn::GetAtt" && (arg as string[])[0] === bucketId && (arg as string[])[1] === "Arn") return BUCKET_ARN;
  throw new Error(`cannot read ${JSON.stringify(value)}`);
}
const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const statementsOfRole = (roleLogicalId: string): Statement[] =>
  resources
    .filter(([, r]) => r.Type === "AWS::IAM::Policy" && list(r.Properties.Roles).some((ref) => (ref as { Ref?: string }).Ref === roleLogicalId))
    .flatMap(([, r]) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const projectRole = (projectName: string): string => {
  const project = resources.find(([, r]) => r.Type === "AWS::CodeBuild::Project" && r.Properties.Name === projectName)![1];
  return (project.Properties.ServiceRole as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
};

const GATEWAY_BETA_OUTPUTS = MODEL_GATEWAY_STEPS.map((s) => modelGatewayStateArtifactName("beta", s.artifactSuffix));
const GATEWAY_PROD_OUTPUTS = MODEL_GATEWAY_STEPS.map((s) => modelGatewayStateArtifactName("production", s.artifactSuffix));

const ROLES = {
  production: { id: projectRole(AGENTX_RELEASE_PROJECT_NAME), outputs: ["ReleaseManifest"], pattern: `${BUCKET_ARN}/AgentXProductionRele*/ReleaseMan*` },
  beta: { id: projectRole(AGENTX_BETA_RELEASE_PROJECT_NAME), outputs: ["BetaReleaseManifest"], pattern: `${BUCKET_ARN}/AgentXProductionRele*/BetaReleas*` },
  gatewayBeta: { id: projectRole(AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME), outputs: GATEWAY_BETA_OUTPUTS, pattern: `${BUCKET_ARN}/AgentXProductionRele*/GatewayBet*` },
  gatewayProduction: { id: projectRole(AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME), outputs: GATEWAY_PROD_OUTPUTS, pattern: `${BUCKET_ARN}/AgentXProductionRele*/GatewayPro*` },
} as const;
type RoleName = keyof typeof ROLES;

const pipeline = resources.find(([, r]) => r.Type === "AWS::CodePipeline::Pipeline")![1];
const actionsOfPipeline = (pipeline.Properties.Stages as Array<{ Actions: Array<{ InputArtifacts?: Array<{ Name: string }>; OutputArtifacts?: Array<{ Name: string }> }> }>).flatMap((stage) => stage.Actions);
const outputNames = [...new Set(actionsOfPipeline.flatMap((a) => (a.OutputArtifacts ?? []).map((o) => o.Name)))];
const allNames = [...new Set([...outputNames, ...actionsOfPipeline.flatMap((a) => (a.InputArtifacts ?? []).map((i) => i.Name))])];

const keysOf = (artifact: string): string[] => {
  const pipelines = [AGENTX_RELEASE_PIPELINE_NAME, AGENTX_RELEASE_PIPELINE_NAME.slice(0, ARTIFACT_KEY_PIPELINE_CHARS)];
  const names = [artifact, artifact.slice(0, ARTIFACT_KEY_NAME_CHARS), artifact.slice(0, 20)];
  return pipelines.flatMap((p) => names.map((n) => `${p}/${n}/AbCdEf1`));
};
const canDo = (role: RoleName, action: string, key: string): boolean => {
  const arn = `${BUCKET_ARN}/${key}`;
  const matches = (pattern: unknown) => globMatch(text(pattern), arn);
  const covers = (s: Statement) => list(s.Action).some((a) => globMatch(String(a).toLowerCase(), action.toLowerCase()));
  const statements = statementsOfRole(ROLES[role].id);
  const allowed = statements.some((s) => s.Effect === "Allow" && covers(s) && s.Resource !== undefined && list(s.Resource).some(matches));
  const denied = statements.some((s) => s.Effect === "Deny" && covers(s) && ((s.NotResource !== undefined && !list(s.NotResource).some(matches)) || (s.Resource !== undefined && list(s.Resource).some(matches))));
  return allowed && !denied;
};

describe("PH-S3-PREFIXES: Code-only artifact layout", () => {
  it("has only Source, the two Code release manifests, and Code's six model gateway state artifacts (no Cloud artifacts)", () => {
    expect(AGENTX_RELEASE_PIPELINE_NAME).toBe("AgentXProductionRelease");
    expect(ARTIFACT_KEY_PIPELINE_CHARS).toBe(20);
    expect(ARTIFACT_KEY_NAME_CHARS).toBe(10);
    expect(MODEL_GATEWAY_STATE_ARTIFACT_PREFIXES).toEqual({ beta: "GatewayBeta", production: "GatewayProd" });
    expect([...allNames].sort()).toEqual([
      "BetaReleaseManifest",
      "GatewayBetaCheck",
      "GatewayBetaDeploy",
      "GatewayBetaImage",
      "GatewayProdCheck",
      "GatewayProdDeploy",
      "GatewayProdImage",
      "ReleaseManifest",
      "Source",
    ]);
    expect(allNames.filter((name) => /Cloud|StateBeta|StateProd/u.test(name))).toEqual([]);
  });

  it("derives the key pattern: pipeline cut to 20 chars, artifact over 10 chars cut to 10", () => {
    expect(artifactKeyPattern("arn:aws:s3:::b", "ReleaseManifest")).toBe("arn:aws:s3:::b/AgentXProductionRele*/ReleaseMan*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "BetaReleaseManifest")).toBe("arn:aws:s3:::b/AgentXProductionRele*/BetaReleas*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "GatewayBetaImage")).toBe("arn:aws:s3:::b/AgentXProductionRele*/GatewayBet*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "GatewayProdImage")).toBe("arn:aws:s3:::b/AgentXProductionRele*/GatewayPro*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "Source")).toBe("arn:aws:s3:::b/AgentXProductionRele*/Source/*");
  });
});

describe("PH-S3-PREFIXES: what each build role may write", () => {
  for (const role of ["production", "beta", "gatewayBeta", "gatewayProduction"] as const) {
    const { id, outputs, pattern } = ROLES[role];

    it(`${role}: PutObject is scoped to its own output pattern, with an explicit NotResource Deny on everything else`, () => {
      const allows = statementsOfRole(id).filter((s) => s.Effect === "Allow" && list(s.Action).some((a) => String(a).startsWith("s3:")));
      const puts = allows.filter((s) => list(s.Action).some((a) => globMatch(String(a), "s3:PutObject")));
      expect(puts).toHaveLength(1);
      expect(puts[0]!.Action).toEqual(["s3:PutObject", "s3:AbortMultipartUpload"]);
      expect(list(puts[0]!.Resource).map(text)).toEqual([pattern]);
      expect(allows.flatMap((s) => list(s.Action)).sort()).toEqual(["s3:AbortMultipartUpload", "s3:GetBucket*", "s3:GetObject*", "s3:List*", "s3:PutObject"]);

      const denies = statementsOfRole(id).filter((s) => s.Effect === "Deny" && list(s.Action).some((a) => String(a).startsWith("s3:")));
      expect(denies).toHaveLength(1);
      expect(denies[0]).toMatchObject({ Sid: "DenyArtifactWritesOutsideOwnOutput", Action: ["s3:PutObject*", "s3:DeleteObject*", "s3:AbortMultipartUpload"] });
      expect(denies[0]!.Resource).toBeUndefined();
      expect(list(denies[0]!.NotResource).map(text)).toEqual([pattern]);
    });

    it(`${role}: evaluated over every artifact key, it writes only its own outputs and never Source or another role's outputs`, () => {
      const own = new Set<string>(outputs);
      for (const artifact of outputs) for (const key of keysOf(artifact)) expect(canDo(role, "s3:PutObject", key), key).toBe(true);
      for (const artifact of allNames.filter((n) => !own.has(n))) {
        for (const key of keysOf(artifact)) {
          expect(canDo(role, "s3:PutObject", key), key).toBe(false);
          expect(canDo(role, "s3:AbortMultipartUpload", key), key).toBe(false);
        }
      }
      for (const action of ["s3:DeleteObject", "s3:PutObjectAcl", "s3:PutObjectTagging"]) {
        for (const artifact of outputs) for (const key of keysOf(artifact)) expect(canDo(role, action, key), `${action} ${key}`).toBe(false);
      }
      for (const artifact of allNames) for (const key of keysOf(artifact)) expect(canDo(role, "s3:GetObject", key), key).toBe(true);
    });
  }

  it("keeps fixed names for the cross-account build roles (beta release access and beta ECR pull policy)", () => {
    expect(resources.find(([id]) => id === ROLES.beta.id)![1].Properties.RoleName).toBe(AGENTX_BETA_BUILD_ROLE_NAME);
    expect(resources.find(([id]) => id === ROLES.gatewayBeta.id)![1].Properties.RoleName).toBe(AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME);
    expect(resources.find(([id]) => id === ROLES.gatewayProduction.id)![1].Properties.RoleName).toBe(AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME);
  });
});

describe("PH-S3-PREFIXES: preflight roles and artifact bucket stay unchanged", () => {
  const s3Allows = (roleId: string) => statementsOfRole(roleId).filter((s) => s.Effect === "Allow" && list(s.Action).some((a) => String(a).startsWith("s3:")));

  it("the two preflight projects only read the artifact bucket", () => {
    for (const name of ["release-agentx-preflight-beta", "release-agentx-preflight-production"]) {
      expect(s3Allows(projectRole(name)).flatMap((s) => list(s.Action)).sort(), name).toEqual(["s3:GetBucket*", "s3:GetObject*", "s3:List*"]);
    }
  });

  it("the bucket itself is unchanged: S3-managed, no public access, 30-day expiry, retained, same logical id prefix", () => {
    const bucket = template.Resources[bucketId]!;
    expect(bucketId).toMatch(/^Artifacts[0-9A-F]{8}$/u);
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    expect(bucket.Properties.LifecycleConfiguration).toEqual({ Rules: [{ ExpirationInDays: 30, Status: "Enabled" }] });
    expect((bucket as unknown as { DeletionPolicy: string }).DeletionPolicy).toBe("Retain");
  });
});
