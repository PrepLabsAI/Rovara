import { expect } from "vitest";

type Resource = { Type: string; Properties?: Record<string, unknown> };

/** The managed policies the legacy runtime boundary adds, one per stack that holds runtime roles (infra/lib/legacy-runtime-boundary.ts). */
export const RUNTIME_BOUNDARY_NAME_PREFIX = "agentx-production-runtime-boundary-";

/**
 * Owner-approved legacy addition (DEC 254zzz443): the runtime boundary policy and a `PermissionsBoundary`
 * on each runtime role of a legacy stack. Asserts the shape of what it takes out (one policy, every role
 * pointing at it, nothing else on a role changed by this helper) and returns a copy without it, so the
 * historical snapshots and pins stay as they were recorded. Never removes a role or any other property.
 *
 * `expectedRoles` is the number of roles that must carry the boundary: all of the stack's roles, except
 * those in `exceptRoles` (the release pipeline's roles are never bounded).
 */
export function withoutLegacyRuntimeBoundary<T>(input: T, options: { readonly exceptRoles?: readonly string[] } = {}): T {
  const copy = structuredClone(input);
  const resources = (copy as { Resources: Record<string, Resource> }).Resources;
  const policies = Object.entries(resources).filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy");
  const boundaries = policies.filter(([, r]) => String(r.Properties?.ManagedPolicyName).startsWith(RUNTIME_BOUNDARY_NAME_PREFIX));
  if (boundaries.length === 0) return copy;
  expect(boundaries, "exactly one runtime boundary policy per stack").toHaveLength(1);
  const [policyId] = boundaries[0]!;
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Role") continue;
    if (options.exceptRoles?.includes(id)) {
      expect(resource.Properties?.PermissionsBoundary, `${id} is never bounded`).toBeUndefined();
      continue;
    }
    expect(resource.Properties?.PermissionsBoundary, `${id} carries the runtime boundary`).toStrictEqual({ Ref: policyId });
    delete resource.Properties!.PermissionsBoundary;
  }
  delete resources[policyId];
  return copy;
}
