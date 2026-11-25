// RETAIN (arch ruling 2026-11-24): the nine resources that outlive their stack (infra/lib/retention.ts and the four files the lane edits), as a synthesized template shows them.
// `withoutRetainPolicies` checks the change is exactly this (DeletionPolicy and UpdateReplacePolicy on exactly these resources, nothing else) and puts the base's policies back, so the
// pins and snapshots recorded before the lane still hold (Rule D: a re-pin is only for exactly this change). tests/contract/retain-stateful-resources.test.ts pins the policies themselves.
import { expect } from "vitest";

type Resource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Template = { Resources: Record<string, Resource> };

/** Which layout the template is of: the legacy install (plain Retain) or a named environment (RetainExceptOnCreate). Only the legacy layout's NAT addresses changed; named ones were retained already. */
export type RetainLayout = "legacy" | "named";

/** The seven that were DESTROY (Delete, Delete) in every layout. All five keys, the channel state table and the adapter secret sit in the control plane stack. */
const WERE_DELETE: ReadonlyArray<{ logical: string; type: string }> = [
  { logical: "ChatGptConnectionKey", type: "AWS::KMS::Key" },
  { logical: "InvokeSigningKey", type: "AWS::KMS::Key" },
  { logical: "DeveloperSignInTokenKey", type: "AWS::KMS::Key" },
  { logical: "DeveloperSignInTaskTokenKey", type: "AWS::KMS::Key" },
  { logical: "DeveloperSignInPolicyHookKey", type: "AWS::KMS::Key" },
  { logical: "ChannelApiState", type: "AWS::DynamoDB::Table" },
  { logical: "ChannelApiSlackAdapterSecret", type: "AWS::SecretsManager::Secret" },
];
/** The two NAT addresses (foundation stack): no policy at all in the legacy layout before the lane. */
const WERE_UNSET: ReadonlyArray<{ logical: string; type: string }> = [
  { logical: "NatEip1", type: "AWS::EC2::EIP" },
  { logical: "NatEip2", type: "AWS::EC2::EIP" },
];

const find = (template: Template, logical: string, type: string): string[] =>
  Object.entries(template.Resources).filter(([id, resource]) => resource.Type === type && new RegExp(`^${logical}([0-9A-F]{8})?$`, "u").test(id)).map(([id]) => id);

const expectedDeletion = (layout: RetainLayout) => (layout === "legacy" ? "Retain" : "RetainExceptOnCreate");

/**
 * Puts one resource's policies back to what the base had: Delete and Delete for the seven, none for a legacy NAT address. Asserts the resource carries exactly the lane's policies first
 * (Retain/Retain in the legacy layout, RetainExceptOnCreate/Retain in a named one). Edits in place, so CDK's key order (UpdateReplacePolicy, DeletionPolicy) is unchanged. Returns `resource`.
 */
export function withoutRetainPolicy<T extends Resource>(resource: T, layout: RetainLayout, base: "Delete" | "unset" = "Delete"): T {
  expect([resource.DeletionPolicy, resource.UpdateReplacePolicy]).toStrictEqual([expectedDeletion(layout), "Retain"]);
  if (base === "unset") {
    delete resource.DeletionPolicy;
    delete resource.UpdateReplacePolicy;
  } else {
    resource.DeletionPolicy = "Delete";
    resource.UpdateReplacePolicy = "Delete";
  }
  return resource;
}

/**
 * Asserts the nine that are in the template are exactly the lane's change and takes it out: the seven key, table and secret resources of a control plane (`expectSeven` says how many are
 * left in this template: some tests take an earlier lane's resources out first) and, in the legacy layout, both NAT addresses of a foundation (a named environment's were retained before
 * the lane and stay as they are). A template holding none of them fails, so a rename cannot make the strip a no-op. Mutates and returns `input` (clone first to keep the original).
 */
export function withoutRetainPolicies<T>(input: T, layout: RetainLayout = "legacy", options: { expectSeven?: number } = {}): T {
  const template = input as unknown as Template;
  const sevens = WERE_DELETE.map(({ logical, type }) => find(template, logical, type));
  const eips = layout === "legacy" ? WERE_UNSET.map(({ logical, type }) => find(template, logical, type)) : [];
  for (const ids of [...sevens, ...eips]) expect(ids.length, "each of the nine at most once").toBeLessThanOrEqual(1);
  const sevenFound = sevens.filter((ids) => ids.length > 0).length;
  const missing = WERE_DELETE.filter((_, index) => sevens[index]!.length === 0).map(({ logical }) => logical).join(", ");
  if (options.expectSeven !== undefined) expect(sevenFound, `the keys, table and secret left in this template (missing: ${missing})`).toBe(options.expectSeven);
  else expect([0, WERE_DELETE.length], `the seven keys, table and secret are all in the stack or none is (missing: ${missing})`).toContain(sevenFound);
  if (layout === "legacy") expect([0, WERE_UNSET.length], "both NAT addresses are in the stack or neither is").toContain(eips.filter((ids) => ids.length > 0).length);
  expect(sevenFound + eips.filter((ids) => ids.length > 0).length, "the template holds some of the nine").toBeGreaterThan(0);
  for (const ids of sevens) for (const id of ids) withoutRetainPolicy(template.Resources[id]!, layout);
  for (const ids of eips) for (const id of ids) withoutRetainPolicy(template.Resources[id]!, layout, "unset");
  return input;
}
