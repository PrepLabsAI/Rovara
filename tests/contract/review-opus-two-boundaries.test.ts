// Opus IAM review (two boundaries): the census with the context-gated stacks ON (autoRequalify, e2eQualificationTransport). Every action a runtime role's own policy grants must be
// allowed by the RUNTIME boundary, or the call fails at run time with AccessDenied.
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryStatements } from "../../infra/lib/access-policies.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const resourcesOf = (stack: Stack) => Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
function roleStatements(resources: Record<string, Resource>): Statement[] {
  return Object.values(resources).flatMap((r) => {
    if (r.Type === "AWS::IAM::Role") return ((r.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => p.PolicyDocument.Statement);
    if (r.Type === "AWS::IAM::Policy") return (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    return [];
  });
}

describe("review: runtime boundary census with every context flag on", () => {
  it("allows every action the runtime roles use, including the requalify machine's and the qualification transport's", () => {
    const app = buildAgentXApp({ agentxEnv: "staging", "agentx:autoRequalify": "enabled", "agentx:e2eQualificationTransport": "enabled" });
    const runtime = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "agentx-staging-cloudformation" })
      .filter((st) => st.Effect === "Allow");
    const allowed = new Set(runtime.flatMap((st) => st.Action));
    const services = new Set([...allowed].filter((a) => a.endsWith(":*")).map((a) => a.split(":")[0]));
    const actions = new Set(stacksOf(app).filter((s) => !s.stackName.endsWith("-access")).flatMap((s) => roleStatements(resourcesOf(s)))
      .filter((st) => st.Effect === "Allow").flatMap((st) => [st.Action].flat()));
    expect([...actions].filter((a) => !allowed.has(a) && !services.has(a.split(":")[0])).sort()).toEqual([]);
  }, 300_000);
});
