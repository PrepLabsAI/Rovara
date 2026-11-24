// RETAIN (arch ruling 2026-11-24): nine resources must never be deleted with their stack or by a failed replacement, in every layout.
// A stack delete or a replacing update with DeletionPolicy/UpdateReplacePolicy Delete would schedule the five KMS keys for deletion, drop the channel
// state table and the generated adapter signing secret, and release the two NAT addresses customers allow-list. This test fails if any of the nine
// goes back to Delete (or loses its policies), in the legacy layout (production, beta's current layout) and in a named environment.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties?: Record<string, unknown> };
type Templates = Record<string, Record<string, Resource>>;

function templates(context: Record<string, string>): Templates {
  const app = buildAgentXApp(context);
  return Object.fromEntries(app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .map((stack) => [stack.node.id, (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources]));
}

/** The nine: stack id (the construct id, the same in every layout), logical id without CDK's 8-character hash, resource type. */
const NINE: ReadonlyArray<{ stack: string; logical: string; type: string }> = [
  { stack: "AgentXControlPlane", logical: "ChatGptConnectionKey", type: "AWS::KMS::Key" },
  { stack: "AgentXControlPlane", logical: "InvokeSigningKey", type: "AWS::KMS::Key" },
  { stack: "AgentXControlPlane", logical: "DeveloperSignInTokenKey", type: "AWS::KMS::Key" },
  { stack: "AgentXControlPlane", logical: "DeveloperSignInTaskTokenKey", type: "AWS::KMS::Key" },
  { stack: "AgentXControlPlane", logical: "DeveloperSignInPolicyHookKey", type: "AWS::KMS::Key" },
  { stack: "AgentXControlPlane", logical: "ChannelApiState", type: "AWS::DynamoDB::Table" },
  { stack: "AgentXControlPlane", logical: "ChannelApiSlackAdapterSecret", type: "AWS::SecretsManager::Secret" },
  { stack: "AgentXProductionFoundation", logical: "NatEip1", type: "AWS::EC2::EIP" },
  { stack: "AgentXProductionFoundation", logical: "NatEip2", type: "AWS::EC2::EIP" },
];

/** The one resource of this type whose logical id is the prefix plus CDK's hash (so ChannelApiState never matches ChannelApiStateX or a policy). */
function pick(resources: Record<string, Resource>, logical: string, type: string): Resource {
  const found = Object.entries(resources).filter(([id, resource]) => resource.Type === type && new RegExp(`^${logical}([0-9A-F]{8})?$`).test(id));
  expect(found.map(([id]) => id), `${logical} ${type}`).toHaveLength(1);
  return found[0]![1];
}

const LAYOUTS: ReadonlyArray<{ name: string; context: Record<string, string>; deletion: string }> = [
  // The legacy layout (production and beta today) keeps plain Retain.
  { name: "legacy", context: {}, deletion: "Retain" },
  // A named environment: retention.ts turns Retain into RetainExceptOnCreate (a failed FIRST create still cleans up; a delete or a replacement keeps the resource).
  { name: "named production", context: { agentxEnv: "production", agentxIdentity: "oidc" }, deletion: "RetainExceptOnCreate" },
  { name: "named beta", context: { agentxEnv: "beta", agentxIdentity: "oidc" }, deletion: "RetainExceptOnCreate" },
];

describe("the nine resources that outlive their stack", () => {
  const built = new Map<string, Templates>();
  beforeAll(() => { for (const layout of LAYOUTS) built.set(layout.name, templates(layout.context)); }, 300_000);

  for (const layout of LAYOUTS) {
    it(`${layout.name}: all nine keep DeletionPolicy ${layout.deletion} and UpdateReplacePolicy Retain, and none is Delete`, () => {
      const stacks = built.get(layout.name)!;
      for (const { stack, logical, type } of NINE) {
        const resource = pick(stacks[stack]!, logical, type);
        expect([logical, resource.DeletionPolicy, resource.UpdateReplacePolicy]).toEqual([logical, layout.deletion, "Retain"]);
      }
    });
  }

  it("the five KMS keys keep their 7-day pending window (it applies only if someone later deletes a key on purpose)", () => {
    for (const layout of LAYOUTS) {
      for (const { stack, logical, type } of NINE.filter((entry) => entry.type === "AWS::KMS::Key")) {
        // The ChatGPT key and the sign-in keys set a window; the invoke key too.
        expect(pick(built.get(layout.name)![stack]!, logical, type).Properties?.PendingWindowInDays, `${layout.name} ${logical}`).toBe(7);
      }
    }
  });

  it("the adapter secret and the channel table keep their fixed names and key schema, so the policy change cannot hide a replacement", () => {
    const legacy = built.get("legacy")!.AgentXControlPlane!;
    expect(pick(legacy, "ChannelApiSlackAdapterSecret", "AWS::SecretsManager::Secret").Properties?.Name).toBe("agentx/production/channel-adapter/slack");
    const table = pick(legacy, "ChannelApiState", "AWS::DynamoDB::Table").Properties as { KeySchema: unknown; TimeToLiveSpecification: unknown };
    expect(table.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
    expect(table.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    const named = built.get("named production")!.AgentXControlPlane!;
    expect(pick(named, "ChannelApiSlackAdapterSecret", "AWS::SecretsManager::Secret").Properties?.Name).toBe("agentx/production/channel-adapter/slack");
  });
});
