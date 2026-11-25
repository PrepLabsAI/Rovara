/**
 * A synthesized Cloud template as it was before the role boundary (model-gateway-boundary.ts, 2026-11-17): without the RoleBoundary policy, and
 * without the PermissionsBoundary and Path it put on each role. The byte-for-byte tests pin a template from before the boundary; this
 * keeps them pinning every other byte (tests/contract/cloud-role-boundary.test.ts checks the boundary itself).
 */
type Template = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };

export function withoutRoleBoundary<T extends Template>(template: T): T {
  const copy = structuredClone(template);
  const boundary = copy.Resources.RoleBoundary;
  if (boundary?.Type !== "AWS::IAM::ManagedPolicy") throw new Error("the template has no RoleBoundary policy");
  delete copy.Resources.RoleBoundary;
  for (const resource of Object.values(copy.Resources)) {
    if (resource.Type !== "AWS::IAM::Role" || resource.Properties === undefined) continue;
    if (JSON.stringify(resource.Properties.PermissionsBoundary) !== JSON.stringify({ Ref: "RoleBoundary" })) throw new Error("a role without the RoleBoundary");
    delete resource.Properties.PermissionsBoundary;
    delete resource.Properties.Path;
  }
  return copy;
}
