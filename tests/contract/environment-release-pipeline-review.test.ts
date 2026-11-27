import { createHash } from "node:crypto";
import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { EnvironmentReleasePipelineStack, POLICY_HASH_COMMAND, environmentReleaseNames, type ReleaseRoleKey } from "../../infra/lib/environment-release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// Lead-4 Opus review of lane P1 (staging release pipeline). The first test pins the production pipeline's RAW template (the lane's own test hashes a
// normalized template that rewrites every 64-hex string, so a changed gitleaks sha256 in prod's buildspec passed it). The others are the review's
// findings F1-F4 as tests: they FAIL on 894278638 and pass once the fixes land.

const names = environmentReleaseNames("staging");
const json = Template.fromStack(
  new EnvironmentReleasePipelineStack(new App(), "ReviewEnvironmentReleasePipeline", {
    environment: "staging",
    region: "us-west-2",
    repository: { owner: "ExampleOrg", name: "example-repo", branch: "code/next" },
  }),
).toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
function flat(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flat).join("");
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("Fn::Join" in record) return (record["Fn::Join"] as [string, unknown[]])[1].map(flat).join((record["Fn::Join"] as [string, unknown[]])[0]);
    if ("Ref" in record) return `\${${String(record.Ref)}}`;
    if ("Fn::GetAtt" in record) return `\${${(record["Fn::GetAtt"] as string[]).join(".")}}`;
    return JSON.stringify(record);
  }
  return String(value);
}
interface Allow { actions: string[]; resources: string[] }
function allowsOf(key: ReleaseRoleKey): Allow[] {
  const id = Object.entries(json.Resources).find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === names.role(key))?.[0];
  if (id === undefined) throw new Error(`no role ${key}`);
  return Object.values(json.Resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && (r.Properties.Roles as Array<{ Ref: string }>).some((role) => role.Ref === id))
    .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Array<{ Effect: string; Action?: unknown; Resource?: unknown }> }).Statement)
    .filter((s) => s.Effect === "Allow")
    .map((s) => ({ actions: list(s.Action as string | string[]), resources: list(s.Resource).map(flat) }));
}

describe("P1 review: production pipeline", () => {
  it("leaves the production release pipeline's RAW template as pinned (sha256 recorded from d66d3c158 and 894278638: equal; re-pinned by L1, L9b, PROD-APPROVAL-BOUND and PIPELINE-CODE-RELEASE-BY-TRIGGER)", () => {
    const stack = buildAgentXApp().node.children.find((child) => child.node.id === "AgentXReleasePipeline") as Stack;
    const digest = createHash("sha256").update(JSON.stringify(Template.fromStack(stack).toJSON())).digest("hex");
    // L1 (2026-11-24): re-pinned from 01152c761e64805857a650b5473c6e80ceac9fd586f39e062df2a836f2dc72c0; the changed resources are listed at PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts, which holds the same pin.
    // PH-S3-PREFIXES (2026-11-25): re-pinned from 291ca54736e9e0f05f06fcbed1c04e118baea14d90ab4e5867786548eb1cdc80; see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts for the three changed resources (re-pinned again when the own-prefix s3:AbortMultipartUpload was added).
    // PIPELINE-NAMESPACE-FIX (2026-11-25): re-pinned from 5d132f12052ae5d438250549e7edca670208048e96421b91b4688586219eb679; only the Cloud source action's Namespace changed (see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts).
    // L1-RELEASE-TAG-TRIGGER (2026-11-25): re-pinned from a1a1b3c352ec39a5cdb923036fb981ad32e749c770beb6d00119dfa968fbbecd; only the Pipeline's CLOUD_REF and CLOUD_PROD defaults and descriptions and CLOUD_SOURCE_COMMIT on the Beta Cloud Preflight changed (see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts).
    // PROD-APPROVAL-BOUND (2026-11-25): re-pinned from 6afbab33423ee9f888a3b10ea01311b6a1c3a46599d6521b25551d844b84d325; the Production stage gains its ApproveProduction manual approval, second, after the read-only Code Preflight (run orders after it +1, a new action role with no policy, one more AssumeRole statement for the pipeline role, the transition's reason text and the same text in the Production Code Preflight's gate command; the five hunks, the fifth being two read-only-clone Deny statements on the Production Code Preflight role, are listed at PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts).
    // RELEASE-STACKS-ADDRESS (2026-11-25): re-pinned from 7e66d04fc164d8a3edc90962636c21a8d514ec15369e0275dc04fa8283a30d46; only the two release builds' ReadReleaseStacks statements gained stack/AgentXApiAddress/* (see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts).
    // PIPELINE-CODE-RELEASE-BY-TRIGGER (2026-11-25): re-pinned from ddd23afa7a00a60f4559a3fd980009d3b476e0a5cead70d1e3e0307faa5f927b; see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts for the changed resources.
    // ISSUE-1578 (2026-11-27): re-pinned from f666faa65ac67edcd17eae5a4387458ea6c299e6bc67d426d08490cdea306e3f; Cloud removed from AgentXProductionRelease and Code deploys its own model gateway (see PRODUCTION_PIPELINE_TEMPLATE_SHA256 in environment-release-pipeline.test.ts).
    // REPO-RENAME (2026-11-27): re-pinned from df1212323e4debfdaa5a5ef1aa49caba306fe23bba2b43c2fa398cc0c2783b8f; the repository is now PrepLabsAI/Rovara-Code, so only the GitHub source action's FullRepositoryId, the connection parameter's description and the two release-ci-proof --repository arguments changed (reverting the name gives the old digest).
    expect(digest).toBe("5b05c7f56bf04cf2ddd98889a44714025db9c2362a74194843a14d6ec769ab04");
  });
});

describe("P1 review: findings (fail on 894278638)", () => {
  it("F1: the Deploy role assumes no role at all (the CDK bootstrap deploy-role passes the admin cfn-exec role and is outside this boundary)", () => {
    const assumes = allowsOf("deploy").filter((s) => s.actions.some((a) => a === "sts:AssumeRole" || a === "sts:*"));
    expect(assumes).toEqual([]);
  });

  it("F4: only Preview creates change sets; Deploy can only execute the ones Preview made and Decide judged", () => {
    const creators = (["build", "preview", "gates", "decide", "guard", "deploy", "postcheck", "canary"] as const)
      .filter((key) => allowsOf(key).some((s) => s.actions.includes("cloudformation:CreateChangeSet")));
    expect(creators).toEqual(["preview"]);
  });

  it("F2: the pin covers every file of the gate pack that a stage runs (deploy.sh, guard.sh, postcheck.sh, preview.sh, gates.sh, the build scripts)", () => {
    // Today the manifest lists only the policy files and evaluator/: the scripts that run with the Deploy, Guard and PostCheck roles are unpinned.
    expect(POLICY_HASH_COMMAND).not.toMatch(/find auto-approve-policy\.json manual-paths\.txt rollback-floor\.txt order\.txt evaluator /u);
  });

  it("F3: every run-record write prefix is unambiguous (no leading wildcard: runs/*/build/* also matches runs/<e>/gates/build/x and runs/<e>/89/build/x)", () => {
    const leading = (["check", "build", "preview", "gates", "decide", "guard", "deploy", "postcheck", "canary", "approver"] as const).flatMap((key) =>
      allowsOf(key)
        .filter((s) => s.actions.includes("s3:PutObject"))
        .flatMap((s) => s.resources)
        .filter((resource) => /\/runs\/\*\//u.test(resource))
        .map((resource) => `${key}: ${resource}`),
    );
    expect(leading).toEqual([]);
  });
});
