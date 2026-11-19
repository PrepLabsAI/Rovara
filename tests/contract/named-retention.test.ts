// A failed first create must clean up after itself in a named environment (live check, 2026-09-27):
// a create rolled back with DeletionPolicy Retain left the fixed-name secret agentx/<env>/slack
// behind, and every retry then failed with "already exists". RetainExceptOnCreate still keeps the
// data on a delete or a replacing update. The legacy deployment does not change.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties?: { Name?: unknown; RepositoryName?: unknown } };
type Templates = Record<string, Record<string, Resource>>;

function templates(context: Record<string, string>): Templates {
  const app = buildAgentXApp(context);
  return Object.fromEntries(app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .map((stack) => [stack.stackName, (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources]));
}
const kept = (resources: Record<string, Resource>, policy: string) =>
  Object.entries(resources).filter(([, resource]) => resource.DeletionPolicy === policy).map(([id, resource]) => `${id.replace(/[0-9A-F]{8}$/, "")} ${resource.Type}`).sort();

let named: Templates;
beforeAll(() => { named = templates({ agentxEnv: "staging" }); }, 300_000);

describe("retained resources in a named environment", () => {
  it("covers every stack the installer creates", () => {
    expect(Object.keys(named).sort()).toEqual([
      "agentx-staging-access", "agentx-staging-control-plane", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-slack",
    ]);
  });

  it("are RetainExceptOnCreate, so a failed first create deletes them, and still kept on replacement", () => {
    const expected: Record<string, string[]> = {
      "agentx-staging-access": ["ArtifactBucket AWS::S3::Bucket"],
      "agentx-staging-control-plane": [
        // DEC 254za (#872): the callback signing key's own secret, kept like the Slack secret (its name is checked below).
        "Artifacts AWS::S3::Bucket", "CallbackSigningKeySecret AWS::SecretsManager::Secret", "DeveloperSignInTable AWS::DynamoDB::Table", "SlackSecret AWS::SecretsManager::Secret", "SlackThreadSessions AWS::S3::Bucket",
        "SlackThreads AWS::DynamoDB::Table", "State AWS::DynamoDB::Table", "TurnRecords AWS::DynamoDB::Table",
      ],
      // Batch 13 (#906, DEC 254zm): the five test-service starter copy repositories, kept so a pinned copy outlives a replacement (their names are checked below).
      "agentx-staging-foundation": [
        "Ec2WorkersTestServiceMirrorRepository0 AWS::ECR::Repository", "Ec2WorkersTestServiceMirrorRepository1 AWS::ECR::Repository", "Ec2WorkersTestServiceMirrorRepository2 AWS::ECR::Repository",
        "Ec2WorkersTestServiceMirrorRepository3 AWS::ECR::Repository", "Ec2WorkersTestServiceMirrorRepository4 AWS::ECR::Repository",
        // Batch 17 (#994, owner DEC 254zzz18): the two NAT addresses are kept, so Rovara's outbound addresses survive a replacement.
        "NatEip1 AWS::EC2::EIP", "NatEip2 AWS::EC2::EIP",
        "VpcFlowLogs AWS::Logs::LogGroup", "WorkspaceKey AWS::KMS::Key",
      ],
      "agentx-staging-identity": [],
      "agentx-staging-runtime": [],
      "agentx-staging-slack": [],
    };
    for (const [stackName, resources] of Object.entries(named)) {
      expect(kept(resources, "RetainExceptOnCreate"), stackName).toEqual(expected[stackName]);
      for (const [id, resource] of Object.entries(resources)) {
        if (resource.DeletionPolicy === "RetainExceptOnCreate") expect(resource.UpdateReplacePolicy, `${stackName} ${id}`).toBe("Retain");
      }
    }
    // DEC 254za: the one retained secret #872 adds is exactly agentx/<env>/callback-key.
    const callbackSecrets = Object.entries(named["agentx-staging-control-plane"]!).filter(([id]) => id.startsWith("CallbackSigningKeySecret") && !id.includes("Policy"));
    expect(callbackSecrets.map(([, resource]) => resource.Properties?.Name)).toEqual(["agentx/staging/callback-key"]);
    // Batch 13 (#906): exactly the five starter copy repositories, outside the environment's pull-through prefix.
    const mirrors = Object.entries(named["agentx-staging-foundation"]!).filter(([id]) => id.startsWith("Ec2WorkersTestServiceMirrorRepository"));
    expect(mirrors.map(([, resource]) => resource.Properties?.RepositoryName).sort()).toEqual([
      "agentx-staging--test-services/mongo-7/mongo", "agentx-staging--test-services/mysql-8/mysql", "agentx-staging--test-services/postgres-16/postgres",
      "agentx-staging--test-services/postgres-17/postgres", "agentx-staging--test-services/redis-7/redis",
    ]);
  });

  it("retains the Cognito user pool and attempt-specific Slack diagnostic records", () => {
    const retained = Object.entries(named).flatMap(([stackName, resources]) => kept(resources, "Retain").map((entry) => `${stackName} ${entry}`));
    expect(retained).toEqual([
      "agentx-staging-identity UserPool AWS::Cognito::UserPool",
      "agentx-staging-slack ActionLogs AWS::Logs::LogGroup",
      "agentx-staging-slack ActionLogsKey AWS::KMS::Key",
      "agentx-staging-slack ActionLogsSource AWS::Logs::DeliverySource",
      "agentx-staging-slack Logs AWS::Logs::LogGroup",
    ]);
  });

  it("do not change the legacy deployment", () => {
    const legacy = templates({});
    const retained = Object.entries(legacy).flatMap(([stackName, resources]) => kept(resources, "Retain").map((entry) => `${stackName} ${entry}`));
    expect(retained).toEqual([
      // Spec 064: developer records and session history outlive the stack, as in named environments.
      // DEC 254za (#872): the callback signing key's own secret (agentx/production/callback-key, checked below), Retain like the Slack secret.
      "AgentXControlPlane Artifacts AWS::S3::Bucket", "AgentXControlPlane CallbackSigningKeySecret AWS::SecretsManager::Secret", "AgentXControlPlane DeveloperSignInTable AWS::DynamoDB::Table", "AgentXControlPlane SlackSecret AWS::SecretsManager::Secret", "AgentXControlPlane SlackThreadSessions AWS::S3::Bucket",
      "AgentXControlPlane SlackThreads AWS::DynamoDB::Table", "AgentXControlPlane State AWS::DynamoDB::Table", "AgentXControlPlane TurnRecords AWS::DynamoDB::Table",
      "AgentXProductionFoundation VpcFlowLogs AWS::Logs::LogGroup", "AgentXProductionFoundation WorkspaceKey AWS::KMS::Key",
      "AgentXReleasePipeline Artifacts AWS::S3::Bucket",
    ]);
    for (const resources of Object.values(legacy)) expect(kept(resources, "RetainExceptOnCreate")).toEqual([]);
    const callbackSecrets = Object.entries(legacy.AgentXControlPlane!).filter(([id]) => id.startsWith("CallbackSigningKeySecret") && !id.includes("Policy"));
    expect(callbackSecrets.map(([, resource]) => resource.Properties?.Name)).toEqual(["agentx/production/callback-key"]);
  }, 300_000);
});
