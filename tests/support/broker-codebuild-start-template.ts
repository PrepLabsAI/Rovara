// BROKER-CODEBUILD-START: the broker's StartBuild grant moved out of its DefaultPolicy into its own inline role policy (infra/lib/control-plane.ts, BrokerCodeBuildStart) and became conditional:
// the Allow requires every StartBuild override condition key ABSENT, and StartBuildBatch is denied. It is in BOTH control planes (the legacy deployment and the named environments). The
// DefaultPolicy keeps `codebuild:BatchGetBuilds` alone.
// Each digest or snapshot test that pins the rest of the template asserts the new policy exactly, then takes it out and puts the DefaultPolicy statement back as it was recorded
// (["codebuild:StartBuild", "codebuild:BatchGetBuilds"] in one statement), so the pins it holds stay the ones recorded before this change. The policy is also evaluated, key by key, in
// tests/contract/broker-codebuild-scope.test.ts. A template without it is returned as it is.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] };
type Template = { Resources: Record<string, Resource> };

const POLICY_ID = /^BrokerCodeBuildStart[0-9A-F]{8}$/u;

/** Written out here, independently of infra/lib/codebuild-start-overrides.ts, so dropping a key there fails the tests. One per StartBuild override argument that has a key (see that file). */
export const STARTBUILD_OVERRIDE_KEYS = [
  "codebuild:source", "codebuild:source.buildspec", "codebuild:source.location", "codebuild:source.auth.type", "codebuild:source.auth.resource", "codebuild:source.insecureSsl",
  "codebuild:cache.location", "codebuild:environment.environmentVariables.name",
  "codebuild:environment", "codebuild:environment.image", "codebuild:environment.type", "codebuild:environment.computeType", "codebuild:environment.certificate",
  "codebuild:environment.imagePullCredentialsType", "codebuild:environment.privilegedMode", "codebuild:environment.environmentVariables", "codebuild:environment.registryCredential",
  "codebuild:environment.fleet.fleetArn",
  "codebuild:secondarySources", "codebuild:secondarySources.buildspec", "codebuild:secondarySources.location",
  "codebuild:secondaryArtifacts", "codebuild:artifacts", "codebuild:cache", "codebuild:logsConfig",
  "codebuild:encryptionKey", "codebuild:serviceRole", "codebuild:autoRetryLimit",
] as const;

/** The policy's statements for a project resource, exactly: the conditional StartBuild Allow and the unconditional StartBuildBatch Deny. */
export const brokerCodeBuildStartStatements = (projectResource: unknown) => [
  { Action: "codebuild:StartBuild", Condition: { Null: Object.fromEntries(STARTBUILD_OVERRIDE_KEYS.map((key) => [key, "true"])) }, Effect: "Allow", Resource: projectResource },
  { Action: "codebuild:StartBuildBatch", Effect: "Deny", Resource: "*" },
];

export function withoutBrokerCodeBuildStart<T>(input: T): T {
  const resources = (input as unknown as Template).Resources;
  const found = Object.keys(resources).filter((id) => POLICY_ID.test(id));
  expect(found.length, "at most one BrokerCodeBuildStart policy").toBeLessThanOrEqual(1);
  if (found.length === 0) return input;
  const id = found[0]!;
  const policy = resources[id]!;
  expect(policy.Type).toBe("AWS::IAM::Policy");
  const roles = Object.keys(resources).filter((candidate) => /^BrokerServiceRole[0-9A-F]{8}$/u.test(candidate) && resources[candidate]!.Type === "AWS::IAM::Role");
  expect(roles).toHaveLength(1);
  expect(policy.Properties.Roles).toEqual([{ Ref: roles[0]! }]);
  expect(Object.keys(policy.Properties).sort()).toEqual(["PolicyDocument", "PolicyName", "Roles"]);
  const document = policy.Properties.PolicyDocument as { Version: string; Statement: Array<{ Resource?: unknown }> };
  expect(document.Version).toBe("2012-10-17");
  expect(document.Statement).toHaveLength(2);
  // The Allow's resource is the gate-project ARN pattern; the broker's DefaultPolicy statement for BatchGetBuilds must name the same resource, and gets StartBuild back.
  const projectResource = document.Statement[0]!.Resource;
  expect(document.Statement).toEqual(brokerCodeBuildStartStatements(projectResource));
  const defaultPolicies = Object.entries(resources).filter(([other, candidate]) => other !== id && candidate.Type === "AWS::IAM::Policy" && JSON.stringify(candidate.Properties.Roles) === JSON.stringify([{ Ref: roles[0]! }])
    && (candidate.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement.some((statement) => statement.Action === "codebuild:BatchGetBuilds"));
  expect(defaultPolicies, "the broker's one policy with BatchGetBuilds (the DefaultPolicy)").toHaveLength(1);
  const [defaultId, defaultPolicy] = defaultPolicies[0]!;
  const defaults = (defaultPolicy.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement.filter((statement) => statement.Action === "codebuild:BatchGetBuilds");
  expect(defaults, "the broker's one BatchGetBuilds statement").toHaveLength(1);
  expect(defaults[0], "BatchGetBuilds is unconditioned on the same project resource").toEqual({ Action: "codebuild:BatchGetBuilds", Effect: "Allow", Resource: projectResource });
  defaults[0]!.Action = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"];
  // Deploy order: the DefaultPolicy (which loses StartBuild) depends on this policy, so the conditional Allow exists first. That DependsOn is the only dependency on it, and is taken out too.
  expect(defaultPolicy.DependsOn, "the DefaultPolicy depends on BrokerCodeBuildStart").toEqual([id]);
  delete defaultPolicy.DependsOn;
  expect(Object.entries(resources).filter(([other, candidate]) => other !== id && other !== defaultId && JSON.stringify(candidate.DependsOn ?? []).includes(id)), "nothing else depends on the policy").toEqual([]);
  delete resources[id];
  return input;
}
