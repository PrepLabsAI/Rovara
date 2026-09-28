// A failed first create must clean up after itself in a named environment (live check, 2026-09-27):
// a create rolled back with DeletionPolicy Retain left the fixed-name secret agentx/<env>/slack
// behind, and every retry then failed with "already exists". RetainExceptOnCreate still keeps the
// data on a delete or a replacing update. The legacy deployment does not change.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Resource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string };
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
        "Artifacts AWS::S3::Bucket", "DeveloperSignInTable AWS::DynamoDB::Table", "SlackSecret AWS::SecretsManager::Secret", "SlackThreadSessions AWS::S3::Bucket",
        "SlackThreads AWS::DynamoDB::Table", "State AWS::DynamoDB::Table", "TurnRecords AWS::DynamoDB::Table",
      ],
      "agentx-staging-foundation": ["VpcFlowLogs AWS::Logs::LogGroup", "WorkspaceKey AWS::KMS::Key"],
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
  });

  it("leave only the Cognito user pool as Retain: its deletion protection would fail a rollback's delete, and its name is not unique, so it never blocks a retry", () => {
    const retained = Object.entries(named).flatMap(([stackName, resources]) => kept(resources, "Retain").map((entry) => `${stackName} ${entry}`));
    expect(retained).toEqual(["agentx-staging-identity UserPool AWS::Cognito::UserPool"]);
  });

  it("do not change the legacy deployment", () => {
    const legacy = templates({});
    const retained = Object.entries(legacy).flatMap(([stackName, resources]) => kept(resources, "Retain").map((entry) => `${stackName} ${entry}`));
    expect(retained).toEqual([
      "AgentXControlPlane Artifacts AWS::S3::Bucket", "AgentXControlPlane SlackSecret AWS::SecretsManager::Secret", "AgentXControlPlane SlackThreadSessions AWS::S3::Bucket",
      "AgentXControlPlane SlackThreads AWS::DynamoDB::Table", "AgentXControlPlane State AWS::DynamoDB::Table", "AgentXControlPlane TurnRecords AWS::DynamoDB::Table",
      "AgentXProductionFoundation VpcFlowLogs AWS::Logs::LogGroup", "AgentXProductionFoundation WorkspaceKey AWS::KMS::Key",
      "AgentXReleasePipeline Artifacts AWS::S3::Bucket",
    ]);
    for (const resources of Object.values(legacy)) expect(kept(resources, "RetainExceptOnCreate")).toEqual([]);
  }, 300_000);
});
