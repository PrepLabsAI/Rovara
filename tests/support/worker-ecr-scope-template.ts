import { expect } from "vitest";

type Statement = { Sid?: string; Effect: string; Resource?: unknown };
type Resource = { Type: string; Properties?: { PolicyDocument?: { Statement: Statement[] } } };

/**
 * Worker ECR scope lane (2026-11-23): the legacy worker instance role's ECR read is narrowed from `repository/*` to its one worker repository, and the role gains the explicit
 * `NoSavedEnvironmentImages` Deny. This asserts the exact shape of those two changes in a legacy template and returns a copy with both put back (the read on `repository/*`, the
 * Deny removed), so the pre-lane full-template pin can be re-derived and the pin change is proven to be only this lane's. Touches nothing else.
 */
export function withoutWorkerEcrScope<T>(input: T): T {
  const copy = structuredClone(input);
  const resources = (copy as { Resources: Record<string, Resource> }).Resources;
  let reads = 0;
  let denies = 0;
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const statements = resource.Properties!.PolicyDocument!.Statement;
    for (const statement of [...statements]) {
      if (statement.Sid === "NoSavedEnvironmentImages") {
        denies += 1;
        expect(statement.Effect).toBe("Deny");
        statements.splice(statements.indexOf(statement), 1);
      } else if (statement.Sid === "EcrImageAccess") {
        reads += 1;
        const parts = (statement.Resource as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
        expect(parts.at(-1)).toBe(":repository/agentx-worker-production");
        parts[parts.length - 1] = ":repository/*";
      }
    }
  }
  expect([reads, denies], "one narrowed read and one Deny on the worker role").toEqual([1, 1]);
  return copy;
}
