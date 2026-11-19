// L4-HARD (c), owner 2026-11-18: the ChatGPT-token KMS key gets the Deny its sibling keys have. Before: the broker's role was allowed by the key policy, but the default root statement
// (kms:*, delegating to IAM) also let any account principal with kms:Decrypt in its own IAM policy open developers' ChatGPT tokens. After: Encrypt, Decrypt, ReEncrypt* and
// GenerateDataKey* are denied to every principal but the broker's role, whatever their IAM policy grants. Named environments only (the legacy deployment keeps its identity grant, as mainline deploys it).
import type { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { chatGptKeyDenyStatement, withoutChatGptKeyDeny } from "../support/chatgpt-key-deny-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Principal: unknown; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const synth = (env?: string) => {
  const app: App = env === undefined ? buildAgentXApp() : buildAgentXApp({ agentxEnv: env });
  const stack = app.node.children.find((c) => (c as { stackName?: string }).stackName?.endsWith("-control-plane") || (c as { stackName?: string }).stackName === "AgentXControlPlane") as unknown as Parameters<typeof Template.fromStack>[0];
  return Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
};
const named = synth("staging");
const legacy = synth();
const keyOf = (t: { Resources: Record<string, Resource> }) => Object.entries(t.Resources).filter(([id, r]) => /^ChatGptConnectionKey/u.test(id) && r.Type === "AWS::KMS::Key");
const brokerId = (t: { Resources: Record<string, Resource> }) => Object.keys(t.Resources).find((id) => /^BrokerServiceRole[0-9A-F]{8}$/u.test(id))!;
const keyStatements = (t: { Resources: Record<string, Resource> }) => (keyOf(t)[0]![1].Properties.KeyPolicy as { Statement: Statement[] }).Statement;

const BROKER = "arn:aws:iam::123456789012:role/broker";
/** KMS key-policy evaluation with the account's root delegating to IAM (the default statement): explicit Deny wins; an Allow needs the key policy (the broker) or the root delegation (any principal whose own IAM policy allows). */
function allowed(statements: Statement[], caller: string, action: string, iamAllows: boolean): boolean {
  const matches = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(action);
  const actions = (s: Statement) => [s.Action].flat();
  const denies = statements.filter((s) => s.Effect === "Deny" && actions(s).some(matches)).some((s) => {
    const condition = s.Condition?.ArnNotEquals?.["aws:PrincipalArn"];
    if (condition === undefined) return true;
    return ![condition].flat().map((c) => (typeof c === "string" ? c : BROKER)).includes(caller);
  });
  if (denies) return false;
  const brokerAllow = caller === BROKER && statements.some((s) => s.Effect === "Allow" && s.Sid === undefined && actions(s).some(matches) && JSON.stringify(s.Principal).includes("GetAtt"));
  const rootDelegation = statements.some((s) => s.Effect === "Allow" && actions(s).includes("kms:*") && JSON.stringify(s.Principal).includes(":root"));
  return brokerAllow || (rootDelegation && iamAllows);
}

describe("the ChatGPT-token key's Deny (named environments)", () => {
  it("has exactly the broker Allow, the default root statement and the one Deny, with the Deny's exact shape", () => {
    expect(keyOf(named)).toHaveLength(1);
    const statements = keyStatements(named);
    expect(statements.map((s) => s.Sid ?? s.Effect)).toEqual(["Allow", "Allow", "UseOnlyAsBroker"]);
    expect(statements.at(-1)).toEqual(chatGptKeyDenyStatement(brokerId(named)));
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: "kms:*" });
    expect(statements[1]).toMatchObject({ Effect: "Allow", Action: ["kms:Encrypt", "kms:Decrypt"], Principal: { AWS: { "Fn::GetAtt": [brokerId(named), "Arn"] } } });
  });

  it("simulation: only the broker uses the key; an account admin whose IAM policy allows kms:Decrypt is denied (the old hole); the broker still works", () => {
    const s = keyStatements(named);
    for (const action of ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom"]) {
      expect(allowed(s, "arn:aws:iam::123456789012:role/AccountAdmin", action, true), `admin ${action}`).toBe(false);
      expect(allowed(s, "arn:aws:iam::123456789012:user/root-user", action, true), `user ${action}`).toBe(false);
    }
    expect(allowed(s, BROKER, "kms:Encrypt", true)).toBe(true);
    expect(allowed(s, BROKER, "kms:Decrypt", true)).toBe(true);
    // The broker has no more than before: no key management, no signing, no extra data-key rights from the key policy's own Allow.
    expect(allowed(s, BROKER, "kms:ScheduleKeyDeletion", false)).toBe(false);
    // Control: without the Deny the same admin could decrypt (the hole this closes).
    const without = s.filter((x) => x.Sid !== "UseOnlyAsBroker");
    expect(allowed(without, "arn:aws:iam::123456789012:role/AccountAdmin", "kms:Decrypt", true)).toBe(true);
    expect(allowed(without, "arn:aws:iam::123456789012:role/AccountAdmin", "kms:Decrypt", false)).toBe(false);
  });

  it("is named-only: the legacy template (production, as mainline deploys it) has no key-policy Deny and keeps the identity grant", () => {
    expect(keyOf(legacy)).toHaveLength(1);
    expect(keyStatements(legacy).map((s) => s.Effect)).toEqual(["Allow"]);
    expect(JSON.stringify(legacy)).not.toContain("UseOnlyAsBroker");
  });

  it("withoutChatGptKeyDeny takes out exactly that statement, refuses a different one, and leaves the legacy template as it is", () => {
    const t = structuredClone(named);
    withoutChatGptKeyDeny(t);
    expect(keyStatements(t).map((s) => s.Sid ?? s.Effect)).toEqual(["Allow", "Allow"]);
    const widened = structuredClone(named);
    const deny = keyStatements(widened).at(-1)!;
    deny.Action = [...[deny.Action].flat(), "kms:Sign"];
    expect(() => withoutChatGptKeyDeny(widened)).toThrow();
    const noCondition = structuredClone(named);
    delete keyStatements(noCondition).at(-1)!.Condition;
    expect(() => withoutChatGptKeyDeny(noCondition)).toThrow();
    const copy = structuredClone(legacy);
    expect(withoutChatGptKeyDeny(copy)).toEqual(legacy);
  });
});
