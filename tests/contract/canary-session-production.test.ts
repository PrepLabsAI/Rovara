// tests/contract/canary-session-production.test.ts
// CANARY-SESSION, arch ruling condition 2: production can never have the canary session function. Three locks, each proven here:
//   1. the template: on the PRODUCTION synthesis, with the parameter set the production release path sends, the condition is false and no resource exists;
//   2. the release path: `npm run release:prod` (the production AND the beta pipeline run it, infra/lib/release-pipeline.ts) refuses, before anything is built or deployed, a release whose
//      parameters name CanarySession* and, unless it is the beta release, a control plane that already holds a non-empty CanarySession* value (cdk deploy keeps deployed values);
//   3. the function itself answers not_set_up unless CANARY_ENVIRONMENT is beta and its issuer is the stack's own (tests/contract/canary-session.test.ts).
import { readFileSync } from "node:fs";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CANARY_SESSION_PLACEMENT_ENVIRONMENT_PARAMETER, CANARY_SESSION_PLACEMENT_PARAMETERS, CONTROL_PLANE_FOUNDATION_PARAMETERS } from "@agentx/contracts";
import { AGENTX_BETA_RELEASE_PROJECT_NAME, AGENTX_RELEASE_PROJECT_NAME } from "../../infra/lib/release-pipeline.js";
import { assertNoCanaryPlacement, betaAccountFromEnvironment } from "../../scripts/release-production.js";
import { optionalControlPlaneParameters, type StackDescription } from "../../scripts/release-common.js";
import { canaryDeploy } from "../support/canary-session-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";

skipLambdaBundling();

type Stack = ReturnType<typeof legacyProductionStacks>[number];
let controlPlane: unknown;
let pipeline: Stack;
beforeAll(() => {
  const stacks = legacyProductionStacks();
  controlPlane = normalizedTemplate(stacks.find((stack) => stack.stackName === "AgentXControlPlane")!);
  pipeline = stacks.find((stack) => stack.stackName === "AgentXReleasePipeline")!;
}, 120_000);

const live = (parameters: Record<string, string>): StackDescription => ({ Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) });
const PLACED = { CanarySessionPlacementEnvironment: "beta", CanarySessionPerson: "a".repeat(64), CanarySessionCompany: "org_canaryco0000000000a1", CanarySessionStepRoleName: "example-beta-canary-step-role" };

describe("lock 1: the production template", () => {
  it("with the parameter set the production release sends, the condition is false and no canary resource, output or key-policy name exists", () => {
    // What release-production.ts sends to the control plane: the env-driven optionals, PublicApiUrl and the foundation outputs. Never a CanarySession parameter (lock 2).
    const sent: Record<string, string> = { PublicApiUrl: "https://api.example.dev", OidcIssuer: "https://idp.example.dev", AdminClaim: "groups", ...Object.fromEntries(CONTROL_PLANE_FOUNDATION_PARAMETERS.map((name) => [name, "x"])) };
    const { created, ruleOk } = canaryDeploy(controlPlane as never, sent);
    expect(created).toEqual([]);
    expect(ruleOk).toBe(true);
    const text = JSON.stringify(controlPlane);
    const deny = (controlPlane as { Resources: Record<string, { Type: string; Properties: { KeyPolicy?: unknown } }> }).Resources;
    const keyPolicy = JSON.stringify(Object.entries(deny).find(([id, resource]) => resource.Type === "AWS::KMS::Key" && id.startsWith("DeveloperSignInTokenKey"))![1].Properties.KeyPolicy);
    // The key policy resolves to the sign-in function's role alone while the condition is false.
    expect(keyPolicy).toContain('"Fn::If":["DeveloperSignInCanarySessionCanarySessionIsOn');
    expect(text).toContain("CanarySessionPlacementEnvironment");
  });

  it("every parameter set that is not exactly the beta one leaves the function out or fails the deploy: production's empty set builds nothing, every non-beta value is refused at the parameter", () => {
    for (const environment of ["production", "prod", "staging", "Beta", "beta-2"]) {
      const answer = canaryDeploy(controlPlane as never, { ...PLACED, CanarySessionPlacementEnvironment: environment });
      expect(answer.allowed, environment).toBe(false);
    }
    expect(canaryDeploy(controlPlane as never, {}).created).toEqual([]);
    expect(canaryDeploy(controlPlane as never, PLACED).created.length).toBeGreaterThan(0);
  });
});

describe("lock 2: the release path (scripts/release-production.ts, run by the production and the beta pipeline)", () => {
  it("never sends a CanarySession parameter itself, whatever the environment holds", () => {
    const saved = { ...process.env };
    try {
      for (const name of ["AGENTX_OIDC_ISSUER", "AGENTX_OIDC_AUDIENCE", "AGENTX_ADMIN_CLAIM", "AGENTX_ADMIN_VALUES", "AGENTX_CALLBACK_SIGNING_KEY", "AGENTX_GITHUB_APP_CREDENTIAL_REF", "AGENTX_GITHUB_APP_ID", "AGENTX_GITHUB_PRIVATE_KEY_SECRET_ARN"]) process.env[name] = "value";
      const sent = optionalControlPlaneParameters();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.join(" ")).not.toContain("CanarySession");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  const BETA = "999988887777";
  const OTHER = "111122223333";
  const check = (over: Partial<Parameters<typeof assertNoCanaryPlacement>[0]>) => assertNoCanaryPlacement({ account: OTHER, betaAccount: BETA, controlPlane: live({}), planned: [], ...over });

  it("refuses a release whose own parameters name a CanarySession parameter, in production and in beta, and says nothing was changed", () => {
    for (const account of [OTHER, BETA]) {
      expect(() => check({ account, planned: ["--parameters", "AgentXControlPlane:CanarySessionPlacementEnvironment=beta"] }), account).toThrow(/name CanarySession\*.*nothing was changed/u);
    }
  });

  it("refuses every release that does not run in the beta ACCOUNT when the live control plane holds any non-empty CanarySession value (a profile name earns nothing)", () => {
    for (const [account, betaAccount] of [[OTHER, BETA], [OTHER, undefined], [BETA, undefined], [OTHER, OTHER.replace("1", "2")]] as const) {
      for (const name of CANARY_SESSION_PLACEMENT_PARAMETERS) {
        expect(() => check({ account, betaAccount, controlPlane: live({ [name]: PLACED[name as keyof typeof PLACED] }) }), `${account} ${String(betaAccount)} ${name}`).toThrow(/exists only in beta.*nothing was changed/u);
      }
    }
    expect(() => check({ controlPlane: live(PLACED) })).toThrow(new RegExp(CANARY_SESSION_PLACEMENT_ENVIRONMENT_PARAMETER, "u"));
  });

  it("lets production through while the control plane holds the empty values (what it has today), a missing stack, or other parameters; and lets the release that runs in the beta account keep what was placed by hand", () => {
    const empty = Object.fromEntries(CANARY_SESSION_PLACEMENT_PARAMETERS.map((name) => [name, ""]));
    expect(() => check({ controlPlane: live({ ...empty, PublicApiUrl: "https://api.example.dev", CompanySignIn: "enabled" }), planned: ["--parameters", "AgentXControlPlane:PublicApiUrl=https://api.example.dev"] })).not.toThrow();
    expect(() => check({ controlPlane: undefined })).not.toThrow();
    expect(() => check({ account: BETA, controlPlane: live(PLACED) })).not.toThrow();
  });

  it("the beta account is the one in the beta release role's ARN, which only the beta project is given; anything else is no beta account", () => {
    expect(betaAccountFromEnvironment({ BETA_RELEASE_ROLE_ARN: `arn:aws:iam::${BETA}:role/example-release-role` })).toBe(BETA);
    for (const bad of [undefined, "", "agentx-beta", `arn:aws:iam::${BETA}:user/x`, `arn:aws:iam::${BETA}:role/a/b`, `arn:aws:iam::12:role/x`, `arn:aws:iam::${BETA}:role/x y`, `x arn:aws:iam::${BETA}:role/x`]) {
      expect(betaAccountFromEnvironment(bad === undefined ? {} : { BETA_RELEASE_ROLE_ARN: bad }), String(bad)).toBeUndefined();
    }
    expect(betaAccountFromEnvironment({ AGENTX_BETA_PROFILE: "agentx-beta" })).toBeUndefined();
  });

  it("the release runs the check before it builds, pushes or deploys anything (so a refusal leaves AWS as it was), and sends the live stack and its own parameters to it", () => {
    const source = readFileSync("scripts/release-production.ts", "utf8");
    const call = source.indexOf("assertNoCanaryPlacement({ account: identity.Account, betaAccount: betaAccountFromEnvironment(process.env), controlPlane: describeIfExists(runner, options.region, CONTROL_PLANE_STACK), planned: optionalControlPlaneParameters() });");
    expect(call).toBeGreaterThan(0);
    for (const first of ["ensureRepository(runner, options);", "buildAndPushWorker(", 'runner.run("npx", [\n    "cdk",\n    "deploy"']) expect(source.indexOf(first), first).toBeGreaterThan(call);
  });

  it("the script's literals equal the contracts' and the pipeline's: only the beta project is given the beta release role ARN (built from the BetaAccountId parameter), the production project is not", () => {
    const text = JSON.stringify(Template.fromStack(pipeline).toJSON());
    expect(CANARY_SESSION_PLACEMENT_ENVIRONMENT_PARAMETER).toBe("CanarySessionPlacementEnvironment");
    expect(CANARY_SESSION_PLACEMENT_PARAMETERS.every((name) => name.startsWith("CanarySession"))).toBe(true);
    const projects = Object.values((JSON.parse(text) as { Resources: Record<string, { Type: string; Properties: { Name?: string } }> }).Resources).filter((resource) => resource.Type === "AWS::CodeBuild::Project");
    const project = (name: string) => JSON.stringify(projects.find((candidate) => candidate.Properties.Name === name));
    expect(project(AGENTX_RELEASE_PROJECT_NAME)).toMatch(/npm run release:prod -- --region /u);
    expect(project(AGENTX_RELEASE_PROJECT_NAME)).not.toContain("BETA_RELEASE_ROLE_ARN");
    expect(project(AGENTX_BETA_RELEASE_PROJECT_NAME)).toMatch(/npm run release:prod -- --region /u);
    expect(project(AGENTX_BETA_RELEASE_PROJECT_NAME)).toContain("BETA_RELEASE_ROLE_ARN");
    expect(project(AGENTX_BETA_RELEASE_PROJECT_NAME)).toContain("BetaAccountId");
    const source = readFileSync("scripts/release-production.ts", "utf8");
    for (const literal of ['const BETA_RELEASE_ROLE_VARIABLE = "BETA_RELEASE_ROLE_ARN";', `const CANARY_PLACEMENT_ENVIRONMENT_PARAMETER = "${CANARY_SESSION_PLACEMENT_ENVIRONMENT_PARAMETER}";`, 'const CANARY_PLACEMENT_PREFIX = "CanarySession";']) expect(source).toContain(literal);
    // No account id and no profile name decides anything in the script: the exemption reads the account only.
    expect(source).not.toMatch(/BETA_RELEASE_PROFILE|input\.profile/u);
  });
});
