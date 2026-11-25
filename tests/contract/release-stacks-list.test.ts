// RELEASE-STACKS: every CloudFormation stack the release scripts name is in AGENTX_RELEASE_STACKS, so the release roles can read it.
// Why: train 41 added the AgentXApiAddress stack, which scripts/release-production.ts only READS (describe-stacks), and the beta release failed with AccessDenied because the role's
// ReadReleaseStacks grant is generated from that list. The release never deploys that stack (cdk deploy names only the control plane, foundation, runtime and Slack orchestrator), so DescribeStacks is the only action it needs.
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { LEGACY_ADDRESS_STACK_NAME } from "../../packages/contracts/src/api-address.js";
import { BetaReleaseAccessStack } from "../../infra/lib/beta-release-access.js";
import { AGENTX_RELEASE_STACKS, ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const SCRIPTS = ["scripts/release-production.ts", "scripts/release-common.ts"] as const;

/** Stack names the scripts declare as constants: `const X_STACK = "AgentX..."`, plus the address stack the script loads from contracts. */
function declaredStacks(): Map<string, string> {
  const names = new Map<string, string>([["LEGACY_ADDRESS_STACK_NAME", LEGACY_ADDRESS_STACK_NAME]]);
  for (const path of SCRIPTS) for (const match of read(path).matchAll(/^(?:export )?const ([A-Z_]*STACK[A-Z_]*) = "([^"]+)";/gmu)) names.set(match[1]!, match[2]!);
  return names;
}

/** Every stack argument of describeStack / stackExists / describeIfExists in the scripts, resolved to a name; an argument this test cannot resolve fails, so a new call shape is looked at. */
function stackArguments(): string[] {
  const declared = declaredStacks();
  const resolved: string[] = [];
  for (const path of SCRIPTS) {
    for (const match of read(path).matchAll(/\b(?:describeStack|stackExists|describeIfExists)\(\s*[^,()]+,\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*([A-Za-z_.]+)\s*\)/gu)) {
      const argument = match[1]!;
      if (argument === "image.stack" || argument === "stack") continue; // the wrapper's own parameter and the images' `stack:` fields: the callers' arguments are resolved here, the fields below
      const name = declared.get(argument);
      expect(name, `${path}: stack argument ${argument} is not a constant this test knows; declare it as a *_STACK constant`).toBeDefined();
      resolved.push(name!);
    }
    for (const match of read(path).matchAll(/^\s+stack: ([A-Z_]+),/gmu)) {
      expect(declared.get(match[1]!), `${path}: stack field ${match[1]}`).toBeDefined();
      resolved.push(declared.get(match[1]!)!);
    }
  }
  return resolved;
}

describe("AGENTX_RELEASE_STACKS covers every stack the release scripts name", () => {
  it("lists each declared stack constant and each stack the scripts describe", () => {
    const declared = [...declaredStacks().values()];
    expect(declared.length).toBeGreaterThanOrEqual(5);
    for (const name of new Set([...declared, ...stackArguments()])) expect(AGENTX_RELEASE_STACKS, `${name} is named by the release scripts but is not in AGENTX_RELEASE_STACKS`).toContain(name);
  });

  it("reads the address stack the release guards the public API URL with", () => {
    expect(stackArguments()).toContain("AgentXApiAddress");
    expect(AGENTX_RELEASE_STACKS).toContain("AgentXApiAddress");
    // [0] stays the GitHub App stack for CI's proof.
    expect(AGENTX_RELEASE_STACKS[0]).toBe("AgentXControlPlane");
  });
});

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };
const statementsOf = (template: Template, roleMatch?: string): Statement[] =>
  (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{ Properties: { Roles: unknown; PolicyDocument: { Statement: Statement[] } } }>)
    .filter((policy) => roleMatch === undefined || JSON.stringify(policy.Properties.Roles).includes(roleMatch))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);

describe("the release roles read each listed stack, and only read it", () => {
  const pipeline = Template.fromStack(new ReleasePipelineStack(new App(), "TestReleaseStacks", { env: { region: "us-east-1" } }));
  const beta = Template.fromStack(new BetaReleaseAccessStack(new App(), "TestBetaReleaseStacks", { env: { region: "us-east-1" } }));
  const cases: Array<[string, Statement[]]> = [
    ["production release build (release account)", statementsOf(pipeline, '"ReleaseBuildRole')],
    ["beta build (release account, CI proof)", statementsOf(pipeline, "BetaReleaseBuildRole")],
    ["beta release access role (beta account)", statementsOf(beta)],
  ];
  for (const [label, statements] of cases) {
    it(`${label}: DescribeStacks on exactly stack/<name>/* for every listed stack, nothing else on a stack`, () => {
      const stacks = statements.find((statement) => statement.Sid === "ReadReleaseStacks");
      expect(stacks, label).toBeDefined();
      expect(stacks!.Action).toBe("cloudformation:DescribeStacks");
      const resources = JSON.stringify(stacks!.Resource);
      for (const name of AGENTX_RELEASE_STACKS) expect(resources).toContain(`:stack/${name}/*"`);
      expect(resources).toContain(":stack/AgentXApiAddress/*"); // literal, so emptying the list cannot pass this by itself
      expect((stacks!.Resource as unknown[]).length).toBe(AGENTX_RELEASE_STACKS.length);
      // No other statement touches CloudFormation: deploys go through the CDK bootstrap roles.
      const other = statements.filter((statement) => statement.Sid !== "ReadReleaseStacks").flatMap((statement) => [statement.Action].flat());
      expect(other.filter((action) => action.startsWith("cloudformation:"))).toEqual([]);
    });
  }
});
