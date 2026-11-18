// L4-EGR: the egress addresses' additions to a named environment's templates, taken out of a synthesized template with their shape asserted first, so the snapshots and digests that pin
// "everything else" keep their recorded values. The additions are checked in full by tests/contract/egress-addresses-infrastructure.test.ts.
import { expect } from "vitest";
import { EGRESS_ADDRESSES_PARAMETER_PATTERN, EGRESS_ADDRESSES_VARIABLE, NAT_EGRESS_ADDRESSES_OUTPUT } from "@agentx/contracts";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Template = { Parameters?: Record<string, unknown>; Resources: Record<string, Resource>; Outputs?: Record<string, unknown> };

/**
 * Foundation (named): the two NAT Elastic IPs are kept when the stack is deleted (DeletionPolicy) and when a resource is replaced (UpdateReplacePolicy: Retain), and nothing else about them
 * changes; the NatEgressAddresses output lists both. A named environment's DeletionPolicy is RetainExceptOnCreate (infra/lib/retention.ts: Retain, except that a failed FIRST create
 * deletes what it made, so a retry works; no customer can have allow-listed an address that never finished creating).
 */
export function withoutNatEgressAddresses<T>(template: T): T {
  const synthesized = template as unknown as Template;
  for (const id of ["NatEip1", "NatEip2"]) {
    const eip = synthesized.Resources[id]!;
    expect(eip.Type).toBe("AWS::EC2::EIP");
    expect([eip.DeletionPolicy, eip.UpdateReplacePolicy], id).toEqual(["RetainExceptOnCreate", "Retain"]);
    delete eip.DeletionPolicy;
    delete eip.UpdateReplacePolicy;
  }
  expect(synthesized.Outputs?.[NAT_EGRESS_ADDRESSES_OUTPUT]).toStrictEqual({ Value: { "Fn::Join": [",", [{ "Fn::GetAtt": ["NatEip1", "PublicIp"] }, { "Fn::GetAtt": ["NatEip2", "PublicIp"] }]] } });
  delete synthesized.Outputs![NAT_EGRESS_ADDRESSES_OUTPUT];
  return template;
}

/** Control plane (named): the NatEgressAddresses parameter (empty by default, a short list of addresses at most) and the broker's one variable that reads it. The dispatcher has none. */
export function withoutNatEgressControlPlane<T>(template: T): T {
  const synthesized = template as unknown as Template;
  expect(synthesized.Parameters?.[NAT_EGRESS_ADDRESSES_OUTPUT]).toMatchObject({ Type: "String", Default: "", AllowedPattern: EGRESS_ADDRESSES_PARAMETER_PATTERN, MaxLength: 64 });
  delete synthesized.Parameters![NAT_EGRESS_ADDRESSES_OUTPUT];
  const functions = (pattern: RegExp) => Object.entries(synthesized.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
  const brokers = functions(/^Broker[0-9A-F]{8}$/u);
  expect(brokers).toHaveLength(1);
  const variables = (brokers[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables[EGRESS_ADDRESSES_VARIABLE]).toStrictEqual({ Ref: NAT_EGRESS_ADDRESSES_OUTPUT });
  delete variables[EGRESS_ADDRESSES_VARIABLE];
  for (const [, dispatcher] of functions(/^Dispatcher[0-9A-F]{8}$/u)) expect((dispatcher.Properties.Environment as { Variables: Record<string, unknown> }).Variables).not.toHaveProperty(EGRESS_ADDRESSES_VARIABLE);
  return template;
}
