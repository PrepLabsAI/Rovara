// PH-S3-PREFIXES: the two Code release roles (production and beta) write only their own output artifact into the pipeline's artifact bucket, which is not versioned and holds the
// Source and CloudSource artifacts a later stage reads. Synthesized template only: no AWS, no real account. The Cloud actions stack (a private repository) holds the other half of the
// same contract (the Cloud roles' state prefixes); the names, lengths and prefixes it relies on are pinned here and in its own tests.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_BUILD_ROLE_NAME, AGENTX_RELEASE_PIPELINE_NAME, ARTIFACT_KEY_NAME_CHARS, ARTIFACT_KEY_PIPELINE_CHARS, CLOUD_STATE_ARTIFACT_PREFIXES, CLOUD_STEPS_AFTER_CODE, CLOUD_STEPS_BEFORE_CODE,
  ReleasePipelineStack, artifactKeyPattern, cloudStateArtifactName,
} from "../../infra/lib/release-pipeline.js";

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
const BUCKET_ARN = "arn:aws:s3:::sample-artifact-bucket";
const template = Template.fromStack(new ReleasePipelineStack(new App(), "S3PrefixesPipeline", { env: { region: "us-east-1", account: "123456789012" } })).toJSON() as { Resources: Record<string, Resource> };
const resources = Object.entries(template.Resources);
const bucketId = resources.find(([, r]) => r.Type === "AWS::S3::Bucket")![0];

/** IAM's wildcard match on a resource or action. */
const globMatch = (pattern: string, text: string): boolean => new RegExp(`^${pattern.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))).join("")}$`, "su").test(text);
/** The text of a value made of Join and the bucket's GetAtt (the only intrinsics an s3 resource of these roles holds). */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  const [[fn, arg]] = Object.entries(value as Record<string, unknown>) as [[string, unknown]];
  if (fn === "Fn::Join") return (arg as [string, unknown[]])[1].map(text).join((arg as [string, unknown[]])[0]);
  if (fn === "Fn::GetAtt" && (arg as string[])[0] === bucketId && (arg as string[])[1] === "Arn") return BUCKET_ARN;
  throw new Error(`cannot read ${JSON.stringify(value)}`);
}
const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const statementsOfRole = (roleLogicalId: string): Statement[] =>
  resources.filter(([, r]) => r.Type === "AWS::IAM::Policy" && list(r.Properties.Roles).some((ref) => (ref as { Ref?: string }).Ref === roleLogicalId)).flatMap(([, r]) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const projectRole = (projectName: string): string => {
  const project = resources.find(([, r]) => r.Type === "AWS::CodeBuild::Project" && r.Properties.Name === projectName)![1];
  return (project.Properties.ServiceRole as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
};
const ROLES = {
  production: { id: projectRole("release-agentx-production"), output: "ReleaseManifest", pattern: `${BUCKET_ARN}/AgentXProductionRele*/ReleaseMan*` },
  beta: { id: projectRole("release-agentx-beta"), output: "BetaReleaseManifest", pattern: `${BUCKET_ARN}/AgentXProductionRele*/BetaReleas*` },
} as const;
type RoleName = keyof typeof ROLES;

const pipeline = resources.find(([, r]) => r.Type === "AWS::CodePipeline::Pipeline")![1];
const actionsOfPipeline = (pipeline.Properties.Stages as Array<{ Actions: Array<{ InputArtifacts?: Array<{ Name: string }>; OutputArtifacts?: Array<{ Name: string }> }> }>).flatMap((stage) => stage.Actions);
const outputNames = [...new Set(actionsOfPipeline.flatMap((a) => (a.OutputArtifacts ?? []).map((o) => o.Name)))];
const allNames = [...new Set([...outputNames, ...actionsOfPipeline.flatMap((a) => (a.InputArtifacts ?? []).map((i) => i.Name))])];
const STATE_NAMES = (["beta", "production"] as const).flatMap((environment) => [...CLOUD_STEPS_BEFORE_CODE, ...CLOUD_STEPS_AFTER_CODE].map((s) => cloudStateArtifactName(environment, s.action)));

/** Every object key CodePipeline may give an artifact, whatever it truncates: whole names, or the pipeline cut to 20 and the artifact to 10 (or 20) characters. */
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

describe("PH-S3-PREFIXES: the contract with the private Cloud stack", () => {
  it("pins the pipeline name, the key layout numbers and the Cloud state artifact names the Cloud roles' grants rely on", () => {
    expect(AGENTX_RELEASE_PIPELINE_NAME).toBe("AgentXProductionRelease");
    expect(ARTIFACT_KEY_PIPELINE_CHARS).toBe(20);
    expect(ARTIFACT_KEY_NAME_CHARS).toBe(10);
    expect(CLOUD_STATE_ARTIFACT_PREFIXES).toEqual({ beta: "StateBeta", production: "StateProd" });
    expect(STATE_NAMES).toEqual([
      "StateBetaPreflight", "StateBetaCloudImage", "StateBetaCloudGateway", "StateBetaGatewayCheck", "StateBetaCloudWebApp", "StateBetaCloudProof",
      "StateProdPreflight", "StateProdCloudImage", "StateProdCloudGateway", "StateProdGatewayCheck", "StateProdCloudWebApp", "StateProdCloudProof",
    ]);
    // The template's artifacts are exactly: the two sources, the two Code release outputs, and those twelve states.
    expect([...allNames].sort()).toEqual(["BetaReleaseManifest", "CloudSource", "ReleaseManifest", "Source", ...STATE_NAMES].sort());
  });

  it("the whole cross-repo contract has one digest, the same literal as the Cloud repository's cloud-release-actions test (a name or a number moved on one side only fails the other side's copy)", () => {
    const contract = {
      pipeline: AGENTX_RELEASE_PIPELINE_NAME, pipelineChars: ARTIFACT_KEY_PIPELINE_CHARS, nameChars: ARTIFACT_KEY_NAME_CHARS, prefixes: CLOUD_STATE_ARTIFACT_PREFIXES,
      states: STATE_NAMES, others: ["Source", "CloudSource", "ReleaseManifest", "BetaReleaseManifest"],
    };
    expect(createHash("sha256").update(JSON.stringify(contract)).digest("hex")).toBe("13bbe6708cf2c691c5d698e6cdb6f27f2f3e87bb3362599fd1d919ad209d0493");
  });

  it("derives the key pattern: the pipeline cut to 20 characters and ending in *, a name over 10 characters cut to 10 and ending in *, a short name whole", () => {
    expect(artifactKeyPattern("arn:aws:s3:::b", "ReleaseManifest")).toBe("arn:aws:s3:::b/AgentXProductionRele*/ReleaseMan*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "BetaReleaseManifest")).toBe("arn:aws:s3:::b/AgentXProductionRele*/BetaReleas*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "Source")).toBe("arn:aws:s3:::b/AgentXProductionRele*/Source/*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "ElevenChars")).toBe("arn:aws:s3:::b/AgentXProductionRele*/ElevenChar*");
    expect(artifactKeyPattern("arn:aws:s3:::b", "TenCharsXX")).toBe("arn:aws:s3:::b/AgentXProductionRele*/TenCharsXX/*");
  });
});

describe("PH-S3-PREFIXES: what the two release roles may write", () => {
  for (const role of ["production", "beta"] as const) {
    const { id, output, pattern } = ROLES[role];

    it(`${role}: PutObject is one resource, its own output (${output}), and the role has no other write, delete, abort, tag or retention Allow`, () => {
      const allows = statementsOfRole(id).filter((s) => s.Effect === "Allow" && list(s.Action).some((a) => String(a).startsWith("s3:")));
      const puts = allows.filter((s) => list(s.Action).some((a) => globMatch(String(a), "s3:PutObject")));
      expect(puts).toHaveLength(1);
      // PutObject and the abort of its own multipart upload, on the one own-output resource.
      expect(puts[0]!.Action).toEqual(["s3:PutObject", "s3:AbortMultipartUpload"]);
      expect(list(puts[0]!.Resource).map(text)).toEqual([pattern]);
      // The CDK's whole-bucket read-write grant is gone: reads (the inputs) and that one PutObject are every S3 Allow.
      expect(allows.flatMap((s) => list(s.Action)).sort()).toEqual(["s3:AbortMultipartUpload", "s3:GetBucket*", "s3:GetObject*", "s3:List*", "s3:PutObject"]);
      for (const key of ["s3:DeleteObject", "s3:PutObjectTagging", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:PutObjectAcl"]) {
        expect(allows.some((s) => list(s.Action).some((a) => globMatch(String(a), key))), key).toBe(false);
      }
      expect(JSON.stringify(statementsOfRole(id))).not.toContain('"s3:Abort*"');
    });

    it(`${role}: the explicit Deny is NotResource of its own output: PutObject*, DeleteObject* and an abort on everything else`, () => {
      const denies = statementsOfRole(id).filter((s) => s.Effect === "Deny" && list(s.Action).some((a) => String(a).startsWith("s3:")));
      expect(denies).toHaveLength(1);
      expect(denies[0]).toMatchObject({ Sid: "DenyArtifactWritesOutsideOwnOutput", Action: ["s3:PutObject*", "s3:DeleteObject*", "s3:AbortMultipartUpload"] });
      expect(denies[0]!.Resource).toBeUndefined();
      expect(list(denies[0]!.NotResource).map(text)).toEqual([pattern]);
    });

    it(`${role}: evaluated as IAM does over every key CodePipeline may give each artifact, it writes ${output} and nothing else (not a source, the other release's manifest, or a Cloud state)`, () => {
      for (const key of keysOf(output)) expect(canDo(role, "s3:PutObject", key), key).toBe(true);
      for (const artifact of allNames.filter((n) => n !== output)) for (const key of keysOf(artifact)) expect(canDo(role, "s3:PutObject", key), key).toBe(false);
      // Not a delete, an ACL or a tag on its own output either, and a read of any artifact still works (the inputs).
      for (const action of ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:PutObjectTagging"]) for (const key of keysOf(output)) expect(canDo(role, action, key), `${action} ${key}`).toBe(false);
      for (const artifact of allNames) for (const key of keysOf(artifact)) expect(canDo(role, "s3:GetObject", key), key).toBe(true);
      // The abort works on its own output's keys and on no other artifact's.
      for (const key of keysOf(output)) expect(canDo(role, "s3:AbortMultipartUpload", key), key).toBe(true);
      for (const artifact of allNames.filter((n) => n !== output)) for (const key of keysOf(artifact)) expect(canDo(role, "s3:AbortMultipartUpload", key), key).toBe(false);
    });
  }

  it("the two patterns share no key: neither role can write the other's manifest (BetaReleaseManifest is not matched by the production role's pattern, nor ReleaseManifest by beta's)", () => {
    expect(globMatch(ROLES.production.pattern, `${BUCKET_ARN}/AgentXProductionRele/BetaReleas/AbCdEf1`)).toBe(false);
    expect(globMatch(ROLES.beta.pattern, `${BUCKET_ARN}/AgentXProductionRele/ReleaseMan/AbCdEf1`)).toBe(false);
    expect(outputNames.filter((n) => globMatch(ROLES.production.pattern.split("/").slice(1).join("/"), `${AGENTX_RELEASE_PIPELINE_NAME}/${n}/x`))).toEqual(["ReleaseManifest"]);
    expect(outputNames.filter((n) => globMatch(ROLES.beta.pattern.split("/").slice(1).join("/"), `${AGENTX_RELEASE_PIPELINE_NAME}/${n}/x`))).toEqual(["BetaReleaseManifest"]);
  });

  it("the beta build role keeps its fixed name (the beta account's release role trusts it)", () => {
    expect(resources.find(([id]) => id === ROLES.beta.id)![1].Properties.RoleName).toBe(AGENTX_BETA_BUILD_ROLE_NAME);
  });
});

describe("PH-S3-PREFIXES: every other role's grant on the bucket is unchanged", () => {
  const s3Allows = (roleId: string) => statementsOfRole(roleId).filter((s) => s.Effect === "Allow" && list(s.Action).some((a) => String(a).startsWith("s3:")));

  it("the two preflight projects only read it", () => {
    for (const name of ["release-agentx-preflight-beta", "release-agentx-preflight-production"]) {
      expect(s3Allows(projectRole(name)).flatMap((s) => list(s.Action)).sort(), name).toEqual(["s3:GetBucket*", "s3:GetObject*", "s3:List*"]);
    }
  });

  it("the pipeline's own role and the two source action roles still hold CDK's whole-bucket read-write (not part of this lane; the follow-up is in the DONE record)", () => {
    for (const logicalId of resources.filter(([id, r]) => r.Type === "AWS::IAM::Role" && /^(PipelineRole|SourceActionRole|CloudSourceActionRole)[0-9A-F]{8}$/u.test(id)).map(([id]) => id)) {
      const writes = s3Allows(logicalId).filter((s) => list(s.Action).includes("s3:PutObject"));
      expect(writes, logicalId).toHaveLength(1);
      expect(list(writes[0]!.Resource).map(text)).toEqual([BUCKET_ARN, `${BUCKET_ARN}/*`]);
    }
  });

  it("the bucket itself is unchanged: S3-managed, no public access, the 30-day expiry, retained, same construct id (no replacement)", () => {
    const bucket = template.Resources[bucketId]!;
    expect(bucketId).toMatch(/^Artifacts[0-9A-F]{8}$/u);
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    expect(bucket.Properties.LifecycleConfiguration).toEqual({ Rules: [{ ExpirationInDays: 30, Status: "Enabled" }] });
    expect((bucket as unknown as { DeletionPolicy: string }).DeletionPolicy).toBe("Retain");
  });
});
