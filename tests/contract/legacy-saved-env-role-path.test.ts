/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- a synthesized CloudFormation template is untyped JSON */
// The legacy install's saved environment registry roles: `-c agentxLegacySavedEnvRoles=root|none|path` (infra/lib/saved-env-images.ts). The roles are fixed-name and an IAM role's path cannot change in
// place, so moving them to `/agentx/production/` takes two deploys: `none` (the roles are deleted), then `path` (they are created again under the path the broker's ROLE_ARN check accepts).
//   - default (`root` or absent) is today's template (tests/contract/legacy-templates.test.ts holds it byte for byte against its snapshot; asserted here as well);
//   - `none`: no saved environment role, repository creation template, output or broker variable, and nothing else removed;
//   - `path`: every role at Path /agentx/production/, ARNs the broker's savedEnvRoleSessionSettings accepts, and nothing else changed;
//   - a named environment refuses the context, and its roles are unchanged;
//   - the production release carries the context (AGENTX_LEGACY_SAVED_ENV_ROLES) and refuses to revert a moved install.
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentRolePath } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { savedEnvRoleSessionSettings } from "../../packages/broker/src/aws/saved-env-role-sessions.js";
import { assertSavedEnvRolesNotReverted, deployedSavedEnvRolesState, legacySavedEnvRolesContext, resolveLegacySavedEnvRolesContext } from "../../scripts/release-common.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { SAVED_ENV_BROKER_VARIABLES, SAVED_ENV_OUTPUT_KEYS, SAVED_ENV_ROLE_KINDS, idsOf, roleNameOf } from "../support/saved-env-images-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, any> };
type TemplateJson = { Resources: Record<string, Resource>; Outputs?: Record<string, { Value: unknown }> };
const synth = (context: Record<string, unknown>, stackName: string): TemplateJson => {
  const stack = buildAgentXApp(context).node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === stackName)!;
  return JSON.parse(JSON.stringify(Template.fromStack(stack).toJSON()).replace(/[a-f0-9]{64}/g, "<asset-hash>")) as TemplateJson;
};
const controlPlane = (context: Record<string, unknown>): TemplateJson => synth(context, "AgentXControlPlane");
/** A copy of the template without the registry side: its resources, its five outputs and the broker's four variables. */
const withoutRegistrySide = (input: TemplateJson): TemplateJson => {
  const template = structuredClone(input);
  for (const id of savedEnvResources(template)) delete template.Resources[id];
  for (const key of SAVED_ENV_OUTPUT_KEYS) delete template.Outputs?.[key];
  for (const resource of Object.values(template.Resources)) for (const name of SAVED_ENV_BROKER_VARIABLES) delete resource.Properties?.Environment?.Variables?.[name];
  return template;
};
const SWITCH = "agentxLegacySavedEnvRoles";
const savedEnvResources = (template: TemplateJson) => Object.keys(template.Resources).filter((id) => id.startsWith("SavedEnvImages"));
const brokerEnvironment = (template: TemplateJson): Record<string, unknown> =>
  Object.assign({}, ...Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::Lambda::Function" && SAVED_ENV_BROKER_VARIABLES.some((name) => name in (resource.Properties.Environment?.Variables ?? {})))
    .map((resource) => resource.Properties.Environment.Variables));

describe("legacy saved environment roles switch", () => {
  const byDefault = controlPlane({});

  it("the default and `root` are today's template", () => {
    expect(savedEnvResources(byDefault)).toHaveLength(7);
    for (const kind of SAVED_ENV_ROLE_KINDS) expect(byDefault.Resources[idsOf(byDefault).roles[kind]]!.Properties.Path, kind).toBeUndefined();
    expect(controlPlane({ [SWITCH]: "root" })).toEqual(byDefault);
  }, 240_000);

  it("`none` has no saved environment role, template, output or broker variable, and nothing else is different", () => {
    const none = controlPlane({ [SWITCH]: "none" });
    expect(savedEnvResources(none)).toEqual([]);
    expect(Object.values(none.Resources).filter((resource) => /img-(push|pull|manage)/u.test(JSON.stringify(resource.Properties?.RoleName ?? "")))).toEqual([]);
    expect(Object.values(none.Resources).some((resource) => resource.Type === "AWS::ECR::RepositoryCreationTemplate")).toBe(false);
    for (const key of SAVED_ENV_OUTPUT_KEYS) expect(none.Outputs?.[key], key).toBeUndefined();
    const text = JSON.stringify(none);
    for (const name of SAVED_ENV_BROKER_VARIABLES) expect(text, name).not.toContain(name);
    expect(text).not.toContain("rovara-env/");
    // exactly today's template minus the registry side
    expect(none).toEqual(withoutRegistrySide(byDefault));
  }, 240_000);

  it("`path` puts every role at /agentx/production/, under ARNs the broker accepts, and changes nothing else", () => {
    const path = controlPlane({ [SWITCH]: "path" });
    const ids = idsOf(path);
    const arns: Record<string, string> = {};
    for (const kind of SAVED_ENV_ROLE_KINDS) {
      const role = path.Resources[ids.roles[kind]]!;
      expect(role.Properties.Path, kind).toBe("/agentx/production/");
      expect(role.Properties.Path).toBe(environmentRolePath("production"));
      expect(role.Properties.RoleName).toBe(roleNameOf(kind, "production"));
      arns[kind] = `arn:aws:iam::111122223333:role${role.Properties.Path}${role.Properties.RoleName}`;
    }
    // the broker's variables hold exactly those roles' ARNs, as the stack makes them
    const variables = brokerEnvironment(path);
    expect(variables.ROVARA_SAVED_ENV_PUSH_ROLE_ARN).toEqual({ "Fn::GetAtt": [ids.roles.Push, "Arn"] });
    expect(variables.ROVARA_SAVED_ENV_PULL_ROLE_ARN).toEqual({ "Fn::GetAtt": [ids.roles.Pull, "Arn"] });
    expect(variables.ROVARA_SAVED_ENV_MANAGE_ROLE_ARN).toEqual({ "Fn::GetAtt": [ids.roles.Manage, "Arn"] });
    // and the broker's own check takes those ARNs
    const settings = savedEnvRoleSessionSettings({
      ROVARA_SAVED_ENV_PUSH_ROLE_ARN: arns.Push,
      ROVARA_SAVED_ENV_PULL_ROLE_ARN: arns.Pull,
      ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: arns.Manage,
      ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/production",
    }, "us-east-1");
    expect(settings?.env).toBe("production");
    expect(settings?.roleArns).toEqual({ push: arns.Push, pull: arns.Pull, manage: arns.Manage });
    // the root-path ARNs of today's template are the ones it refuses
    const rootArns = Object.fromEntries(SAVED_ENV_ROLE_KINDS.map((kind) => [kind, `arn:aws:iam::111122223333:role/${roleNameOf(kind, "production")}`]));
    expect(savedEnvRoleSessionSettings({
      ROVARA_SAVED_ENV_PUSH_ROLE_ARN: rootArns.Push, ROVARA_SAVED_ENV_PULL_ROLE_ARN: rootArns.Pull, ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: rootArns.Manage, ROVARA_SAVED_ENV_REPO_PREFIX: "rovara-env/production",
    }, "us-east-1")).toBeUndefined();
    // the same template as the default but for the three Path properties
    const withoutPath = structuredClone(path);
    for (const kind of SAVED_ENV_ROLE_KINDS) delete withoutPath.Resources[ids.roles[kind]]!.Properties.Path;
    expect(withoutPath).toEqual(byDefault);
  }, 240_000);

  it("refuses an unknown value", () => {
    expect(() => controlPlane({ [SWITCH]: "both" })).toThrow(/unsupported agentxLegacySavedEnvRoles/);
  }, 240_000);

  it("a named environment refuses the context and keeps its roles under its own path", () => {
    for (const value of ["none", "path", "root"]) expect(() => buildAgentXApp({ agentxEnv: "staging", [SWITCH]: value }), value).toThrow(/legacy install only/);
    const staging = synth({ agentxEnv: "staging" }, "agentx-staging-control-plane");
    const ids = idsOf(staging);
    for (const kind of SAVED_ENV_ROLE_KINDS) expect(staging.Resources[ids.roles[kind]]!.Properties.Path, kind).toBe("/agentx/staging/");
  }, 240_000);
});

describe("the production release carries the switch", () => {
  const moved = { Outputs: [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: "arn:aws:iam::111122223333:role/agentx/production/agentx-production-img-push" }] };
  const root = { Outputs: [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: "arn:aws:iam::111122223333:role/agentx-production-img-push" }] };
  const noRoles = { Outputs: [{ OutputKey: "ApiEndpoint", OutputValue: "https://example.invalid" }] };

  it("passes the context to the control plane deploy only when the variable is set", () => {
    expect(legacySavedEnvRolesContext({})).toEqual([]);
    expect(legacySavedEnvRolesContext({ AGENTX_LEGACY_SAVED_ENV_ROLES: "" })).toEqual([]);
    for (const value of ["root", "none", "path"]) expect(legacySavedEnvRolesContext({ AGENTX_LEGACY_SAVED_ENV_ROLES: value })).toEqual(["-c", `agentxLegacySavedEnvRoles=${value}`]);
    expect(() => legacySavedEnvRolesContext({ AGENTX_LEGACY_SAVED_ENV_ROLES: "bogus" })).toThrow(/must be one of/);
    const source = readFileSync("scripts/release-production.ts", "utf8");
    expect(source).toContain("...savedEnvRolesContext,");
    expect(source.indexOf("...savedEnvRolesContext,")).toBeGreaterThan(source.indexOf("function deployControlPlane"));
  });

  it("judges the saved roles from the deployed control plane: path, root or none (no role output)", () => {
    expect(deployedSavedEnvRolesState(moved)).toBe("path");
    expect(deployedSavedEnvRolesState(root)).toBe("root");
    expect(deployedSavedEnvRolesState(noRoles)).toBe("none");
    expect(deployedSavedEnvRolesState({})).toBe("none");
  });

  it("an install whose roles moved accepts only path, or an unset value", () => {
    expect(() => assertSavedEnvRolesNotReverted(moved, {})).not.toThrow();
    expect(() => assertSavedEnvRolesNotReverted(moved, { AGENTX_LEGACY_SAVED_ENV_ROLES: "" })).not.toThrow();
    expect(() => assertSavedEnvRolesNotReverted(moved, { AGENTX_LEGACY_SAVED_ENV_ROLES: "path" })).not.toThrow();
    expect(() => assertSavedEnvRolesNotReverted(moved, { AGENTX_LEGACY_SAVED_ENV_ROLES: "none" })).toThrow(/would revert them/);
    expect(() => assertSavedEnvRolesNotReverted(moved, { AGENTX_LEGACY_SAVED_ENV_ROLES: "root" })).toThrow(/would revert them/);
  });

  it("a control plane with no saved roles (between the two deploys) accepts only path, or none again", () => {
    expect(() => assertSavedEnvRolesNotReverted(noRoles, {})).toThrow(/under way/);
    expect(() => assertSavedEnvRolesNotReverted(noRoles, { AGENTX_LEGACY_SAVED_ENV_ROLES: "" })).toThrow(/under way/);
    expect(() => assertSavedEnvRolesNotReverted(noRoles, { AGENTX_LEGACY_SAVED_ENV_ROLES: "root" })).toThrow(/under way/);
    expect(() => assertSavedEnvRolesNotReverted(noRoles, { AGENTX_LEGACY_SAVED_ENV_ROLES: "path" })).not.toThrow();
    expect(() => assertSavedEnvRolesNotReverted(noRoles, { AGENTX_LEGACY_SAVED_ENV_ROLES: "none" })).not.toThrow();
  });

  it("an install with its roles at the root path accepts every value, as before the move", () => {
    for (const value of [undefined, "", "root", "none", "path"]) expect(() => assertSavedEnvRolesNotReverted(root, { AGENTX_LEGACY_SAVED_ENV_ROLES: value }), String(value)).not.toThrow();
  });

  it("derives the mode for the control plane deploy: path when the roles moved and nothing is given, else the explicit value", () => {
    const flag = (value: string) => ["-c", `agentxLegacySavedEnvRoles=${value}`];
    expect(resolveLegacySavedEnvRolesContext(moved, {})).toEqual(flag("path"));
    expect(resolveLegacySavedEnvRolesContext(moved, { AGENTX_LEGACY_SAVED_ENV_ROLES: "path" })).toEqual(flag("path"));
    expect(resolveLegacySavedEnvRolesContext(root, {})).toEqual([]);
    expect(resolveLegacySavedEnvRolesContext(root, { AGENTX_LEGACY_SAVED_ENV_ROLES: "none" })).toEqual(flag("none"));
    expect(resolveLegacySavedEnvRolesContext(noRoles, { AGENTX_LEGACY_SAVED_ENV_ROLES: "path" })).toEqual(flag("path"));
    expect(resolveLegacySavedEnvRolesContext(undefined, {})).toEqual([]);
    expect(resolveLegacySavedEnvRolesContext(undefined, { AGENTX_LEGACY_SAVED_ENV_ROLES: "none" })).toEqual(flag("none"));
    expect(() => resolveLegacySavedEnvRolesContext(undefined, { AGENTX_LEGACY_SAVED_ENV_ROLES: "bogus" })).toThrow(/must be one of/);
    expect(() => resolveLegacySavedEnvRolesContext(noRoles, {})).toThrow(/under way/);
  });

  it("the release pipeline's build project carries the variable only when its stack is built with the switch", () => {
    const environment = (context: Record<string, unknown>) => {
      const project = Object.values(synth(context, "AgentXReleasePipeline").Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project")!;
      return project.Properties.Environment as Record<string, unknown>;
    };
    expect(environment({}).EnvironmentVariables).toBeUndefined();
    expect(environment({ [SWITCH]: "root" }).EnvironmentVariables).toBeUndefined();
    expect(environment({ [SWITCH]: "path" }).EnvironmentVariables).toEqual([{ Name: "AGENTX_LEGACY_SAVED_ENV_ROLES", Type: "PLAINTEXT", Value: "path" }]);
    expect(environment({ [SWITCH]: "none" }).EnvironmentVariables).toEqual([{ Name: "AGENTX_LEGACY_SAVED_ENV_ROLES", Type: "PLAINTEXT", Value: "none" }]);
  }, 240_000);
});
