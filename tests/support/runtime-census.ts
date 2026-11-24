// The runtime census: every Allow action in every role policy of every stack of a named environment synthesized with EVERY context flag ON (tests/support/context-flags.ts), so a stack behind a
// flag cannot hide a role from the boundary tests.
import { buildAgentXApp } from "../../infra/lib/app.js";
import { GATE_FLAGS_ON } from "./context-flags.js";

// No aws-cdk-lib import here (the port guard allows the CDK only in the infra code and in *.test.* files): the app is synthesized through its own CloudAssembly.
type App = ReturnType<typeof buildAgentXApp>;
type Statement = { Effect: string; Action: string | string[] };
type Resource = { Type: string; Properties: Record<string, unknown> };

/**
 * The CI runner stack (`agentxCiRunner`) reads GitHub through CodeConnections / CodeStar connections, which NO boundary has ever allowed (the single boundary did not either): a pre-existing gap,
 * not caused by the split. Why it does not matter on a named environment: it is NOT environment-scoped. app.ts creates it from the context flag alone (any environment, or none; it is not gated to the
 * legacy install in code), but it takes no naming (fixed stack id `AgentXCiRunner`, fixed project `rovara-ci-tests`), no release deploys it ("only when asked for ... by hand", ci-runner.ts), and
 * the environment's CloudFormation role could not deploy it anyway (F1: stack writes only on `agentx-<env>-*` stacks). It is deployed by hand into the CI account, outside any environment boundary.
 * Were it ever synthesized with an environment, its role would carry the runtime boundary and the GitHub connection actions would be capped out, exactly as under the single boundary.
 * Pinned exactly so any other missing action fails.
 */
export const KNOWN_OLD_GAPS: Readonly<Record<string, readonly string[]>> = {
  AgentXCiRunner: ["codeconnections:GetConnection", "codeconnections:GetConnectionToken", "codeconnections:UseConnection", "codestar-connections:GetConnection", "codestar-connections:GetConnectionToken", "codestar-connections:UseConnection"],
};

export const censusApp = (): App => buildAgentXApp({ agentxEnv: "staging", ...GATE_FLAGS_ON });
/** Every stack of the app, synthesized: `{ name, resources }`. */
export const synthesizedStacks = (app: App): Array<{ name: string; resources: Record<string, Resource> }> => app.synth().stacks.map((stack) => ({ name: stack.stackName, resources: (stack.template as { Resources: Record<string, Resource> }).Resources }));

/** `stack name -> actions` of every Allow statement of every role policy (inline, AWS::IAM::Policy, managed policy) in every stack except the access stack. */
export function runtimeRoleActions(app: App): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { name, resources } of synthesizedStacks(app).filter((candidate) => !candidate.name.endsWith("-access"))) {
    const documents = Object.values(resources).flatMap((resource) => {
      if (resource.Type === "AWS::IAM::Role") return ((resource.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Statement[] } }>).map((policy) => policy.PolicyDocument);
      if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") return [resource.Properties.PolicyDocument as { Statement: Statement[] }];
      return [];
    });
    found.set(name, new Set(documents.flatMap((document) => document.Statement).filter((statement) => statement.Effect === "Allow").flatMap((statement) => [statement.Action].flat())));
  }
  return found;
}

/** The actions some stack's roles use that the boundary neither names nor allows by its service wildcard, as `stack action`, less the pinned old gaps. */
export function actionsOutside(app: App, allowedActions: ReadonlySet<string>): string[] {
  const services = new Set([...allowedActions].filter((action) => action.endsWith(":*")).map((action) => action.split(":")[0]));
  const outside: string[] = [];
  for (const [stack, actions] of runtimeRoleActions(app)) {
    const old = KNOWN_OLD_GAPS[stack] ?? [];
    for (const action of actions) if (!allowedActions.has(action) && !services.has(action.split(":")[0]) && !old.includes(action)) outside.push(`${stack} ${action}`);
  }
  return outside.sort();
}
