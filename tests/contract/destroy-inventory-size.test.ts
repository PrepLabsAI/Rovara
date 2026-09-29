// The destroy inventory must fit SSM's 4096-byte standard tier (final review M6). It is measured here
// against the retained resources of a real synth of the installer's stacks, for a 20-character
// environment name, with every optional field filled and each physical ID as long as AWS makes it,
// so a new retained resource that would break agentx destroy fails this test first.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { STACK_PARTS, type StackPart } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { inventoryParameterName, mergeInventory, retainedResources, writeInventory, type RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { SSM_STANDARD_VALUE_LIMIT } from "../../packages/cli/src/init/install-state.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "abcdefghij-klmnopq12";
const REGION = "us-east-1";
const ACCOUNT = "123456789012";

type Resource = { Type: string; DeletionPolicy?: string; Properties?: Record<string, unknown> };

/** The longest physical ID AWS gives the resource: its own name when the template sets one as plain
 * text, else CloudFormation's generated name (stack name, logical ID and a random suffix). */
function physicalId(stackName: string, logicalId: string, resource: Resource): string {
  const named = (key: string) => (typeof resource.Properties?.[key] === "string" ? resource.Properties[key] as string : undefined);
  const generated = (limit: number) => `${stackName}-${logicalId}`.slice(0, limit - 14) + "-ABCDEFGHIJKLM";
  switch (resource.Type) {
    case "AWS::S3::Bucket": return named("BucketName") ?? generated(63).toLowerCase();
    case "AWS::DynamoDB::Table": return named("TableName") ?? generated(255);
    case "AWS::Logs::LogGroup": return named("LogGroupName") ?? generated(512);
    case "AWS::KMS::Key": return "1234abcd-12ab-34cd-56ef-1234567890ab";
    case "AWS::SecretsManager::Secret": return `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${named("Name") ?? generated(256)}-AbCdEf`;
    case "AWS::Cognito::UserPool": return `${REGION}_AbCdEfGhI`;
    default: return generated(255);
  }
}

let resources: RetainedResource[];
let retainedCount: number;
beforeAll(() => {
  const app = buildAgentXApp({ agentxEnv: ENV, agentxRegion: REGION });
  resources = [];
  retainedCount = 0;
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
    const part = STACK_PARTS.find((candidate) => stack.stackName === `agentx-${ENV}-${candidate}`) as StackPart;
    const template = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
    retainedCount += Object.values(template.Resources).filter((resource) => resource.DeletionPolicy === "Retain" || resource.DeletionPolicy === "RetainExceptOnCreate").length;
    const listed = Object.entries(template.Resources).map(([logicalId, resource]) => ({ logicalId, type: resource.Type, physicalId: physicalId(stack.stackName, logicalId, resource) }));
    resources.push(...retainedResources(part, JSON.stringify(template), listed));
  }
}, 300_000);

describe("the destroy inventory's size (final review M6)", () => {
  it("fits SSM's standard tier for a 20-character environment, with every retained resource of a real synth", async () => {
    expect(ENV).toHaveLength(20);
    expect(resources.length).toBe(retainedCount);
    expect(resources.length).toBeGreaterThanOrEqual(11);
    const inventory = mergeInventory(undefined, {
      env: ENV, resources, launchTemplateId: "lt-0123456789abcdef0",
      github: { account: "a".repeat(39), accountType: "organization", slug: `agentx-${ENV}-${"s".repeat(6)}` },
      slackAppId: "A0123456789", connectors: ["linear", "jira", "asana"],
    });
    const store = new MemoryParameterStore();
    await writeInventory(store, inventory);
    expect(Buffer.byteLength(store.values.get(inventoryParameterName(ENV)) ?? "")).toBeLessThanOrEqual(SSM_STANDARD_VALUE_LIMIT);
  });
});
