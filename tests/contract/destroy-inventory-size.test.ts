// The destroy inventory must fit SSM's 4096-byte standard tier (final review M6). It is measured here
// against the retained resources of a real synth of the installer's stacks, for a 20-character
// environment name, with every optional field filled and each physical ID as long as AWS makes it,
// so a new retained resource that would break agentx destroy fails this test first.
import { createHash } from "node:crypto";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { STACK_PARTS, type StackPart } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { COMPRESSED_INVENTORY_PREFIX, inventoryParameterName, mergeInventory, readInventory, retainedResources, writeInventory, type RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { isSecretId, retainedMismatch } from "../../packages/cli/src/destroy/names.js";
import { SSM_STANDARD_VALUE_LIMIT } from "../../packages/cli/src/init/install-state.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ENV = "abcdefghij-klmnopq12";
const REGION = "us-east-1";
const ACCOUNT = "123456789012";

type Resource = { Type: string; DeletionPolicy?: string; Properties?: Record<string, unknown> };

/** The longest physical ID AWS gives the resource: its own name when the template sets one as plain
 * text, else CloudFormation's generated name (stack name, logical ID and a random suffix). */
function physicalId(stackName: string, logicalId: string, resource: Resource): string {
  const named = (key: string) => (typeof resource.Properties?.[key] === "string" ? resource.Properties[key] : undefined);
  // CloudFormation's suffix is 13 random upper-case letters and digits: a fixed one would let a compressed inventory look smaller than a real one.
  const suffix = createHash("sha256").update(`${stackName}/${logicalId}`).digest().toString("base64").replace(/[^A-Za-z0-9]/g, "").toUpperCase().padEnd(13, "X").slice(0, 13);
  const generated = (limit: number) => `${stackName}-${logicalId}`.slice(0, limit - 14) + `-${suffix}`;
  switch (resource.Type) {
    case "AWS::S3::Bucket": return named("BucketName") ?? generated(63).toLowerCase();
    case "AWS::DynamoDB::Table": return named("TableName") ?? generated(255);
    case "AWS::Logs::LogGroup": return named("LogGroupName") ?? generated(512);
    case "AWS::KMS::Key": return "1234abcd-12ab-34cd-56ef-1234567890ab";
    case "AWS::SecretsManager::Secret": return `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${named("Name") ?? generated(256)}-AbCdEf`;
    case "AWS::Cognito::UserPool": return `${REGION}_AbCdEfGhI`;
    // Batch 17 (#994): an Elastic IP's physical ID is its public IPv4 address (at most 15 characters).
    case "AWS::EC2::EIP": return "255.255.255.255";
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
  const WEBHOOK_SECRET = `agentx/${ENV}/github-webhook-secret`;
  const worstCase = () => mergeInventory(undefined, {
    env: ENV, resources, launchTemplateId: "lt-0123456789abcdef0",
    github: { account: "a".repeat(39), accountType: "organization", slug: `agentx-${ENV}-${"s".repeat(6)}` },
    slackAppId: "A0123456789", connectors: ["linear", "jira", "asana"],
  });

  it("fits SSM's standard tier, with a margin, for a 20-character environment and every retained resource of a real synth", async () => {
    expect(ENV).toHaveLength(20);
    expect(resources.length).toBe(retainedCount);
    expect(resources.length).toBeGreaterThanOrEqual(11);
    const inventory = worstCase();
    // The plain JSON is over the limit by itself (the webhook secret slot's entry took it there): the stored value is the compressed form.
    expect(Buffer.byteLength(JSON.stringify(inventory))).toBeGreaterThan(SSM_STANDARD_VALUE_LIMIT);
    const store = new MemoryParameterStore();
    await writeInventory(store, inventory);
    const stored = store.values.get(inventoryParameterName(ENV)) ?? "";
    expect(stored.startsWith(COMPRESSED_INVENTORY_PREFIX)).toBe(true);
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(SSM_STANDARD_VALUE_LIMIT - 1024);
  });

  it("round-trips: what is read back is the full inventory, so destroy finds the webhook secret by the same ARN it was recorded with", async () => {
    const inventory = worstCase();
    const store = new MemoryParameterStore();
    await writeInventory(store, inventory);
    const read = await readInventory(store, ENV);
    expect(read).toEqual(inventory);
    const secret = read?.resources.find((resource) => resource.logicalId === "GithubWebhookSecret");
    expect(secret?.physicalId).toBe(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${WEBHOOK_SECRET}-AbCdEf`);
    // The identifier destroy deletes by, and the checks it makes before deleting, accept exactly that secret.
    expect(isSecretId(secret!.physicalId, WEBHOOK_SECRET)).toBe(true);
    expect(isSecretId(secret!.physicalId, `${WEBHOOK_SECRET}-other`)).toBe(false);
    expect(retainedMismatch(ENV, secret!, { "agentx:env": ENV })).toBeUndefined();
  });

  it("still reads an inventory an earlier release stored as plain JSON", async () => {
    const store = new MemoryParameterStore();
    const small = mergeInventory(undefined, { env: ENV, resources: resources.slice(0, 3) });
    store.values.set(inventoryParameterName(ENV), JSON.stringify(small));
    expect(await readInventory(store, ENV)).toEqual(small);
  });

  it("refuses a stored value that is neither plain JSON nor a valid compressed inventory, naming the parameter", async () => {
    const store = new MemoryParameterStore();
    store.values.set(inventoryParameterName(ENV), `${COMPRESSED_INVENTORY_PREFIX}not-deflate!`);
    await expect(readInventory(store, ENV)).rejects.toThrow(inventoryParameterName(ENV));
  });
});
