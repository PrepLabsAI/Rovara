// DEC 254h: GitHub sign-in's named-environment additions to the control-plane template. Each digest or snapshot test that pins the rest of the
// template asserts these exactly, then takes them out (in place): three parameters, four variables on the sign-in function, one read of the one
// GitHub secret, and the broker's two packed settings.
import { expect } from "vitest";
import { removePackedPieces, unpackedBrokerVariables } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Template = { Parameters?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = { Action?: string | string[]; Resource?: unknown };

const lambdaId = (template: Template, prefix: string): string => {
  const ids = Object.keys(template.Resources).filter((id) => id.startsWith(prefix) && /^[A-Za-z]+[0-9A-F]{8}$/.test(id) && id.slice(0, -8) === prefix && template.Resources[id]!.Type === "AWS::Lambda::Function");
  expect(ids, `one ${prefix} function`).toHaveLength(1);
  return ids[0]!;
};

export function withoutGithubSignIn<T>(input: T, env: string): T {
  const template = input as unknown as Template;
  const parameters = template.Parameters ?? {};
  const names = ["DeveloperSignInGithub", "DeveloperGithubClientId", "DeveloperGithubSince"];
  expect(Object.keys(parameters).filter((name) => names.includes(name))).toEqual(names);
  expect(parameters.DeveloperSignInGithub).toMatchObject({ Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  expect(parameters.DeveloperGithubClientId).toMatchObject({ Default: "" });
  expect(parameters.DeveloperGithubSince).toMatchObject({ Default: "0" });
  for (const name of names) delete parameters[name];
  const signIn = (template.Resources[lambdaId(template, "DeveloperSignInFunction")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect({ enabled: signIn.DEVELOPER_SIGNIN_GITHUB, clientId: signIn.DEVELOPER_GITHUB_CLIENT_ID, secret: signIn.DEVELOPER_GITHUB_SECRET_ID, since: signIn.DEVELOPER_GITHUB_SINCE })
    .toEqual({ enabled: { Ref: "DeveloperSignInGithub" }, clientId: { Ref: "DeveloperGithubClientId" }, secret: `agentx/${env}/developer-github`, since: { Ref: "DeveloperGithubSince" } });
  for (const variable of ["DEVELOPER_SIGNIN_GITHUB", "DEVELOPER_GITHUB_CLIENT_ID", "DEVELOPER_GITHUB_SECRET_ID", "DEVELOPER_GITHUB_SINCE"]) delete signIn[variable];
  let reads = 0;
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const document = resource.Properties.PolicyDocument as { Statement: Statement[] };
    document.Statement = document.Statement.filter((statement) => {
      if (!JSON.stringify(statement.Resource).includes("developer-github")) return true;
      expect(statement.Action).toEqual("secretsmanager:GetSecretValue");
      expect(JSON.stringify(statement.Resource)).toContain(`:secret:agentx/${env}/developer-github-??????`);
      expect(JSON.stringify(resource.Properties.Roles)).toContain("DeveloperSignInFunctionServiceRole");
      reads += 1;
      return false;
    });
  }
  expect(reads).toBe(1);
  const broker = (template.Resources[lambdaId(template, "Broker")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(unpackedBrokerVariables(broker)).toMatchObject({ DEVELOPER_SIGNIN_GITHUB: { Ref: "DeveloperSignInGithub" }, DEVELOPER_GITHUB_SINCE: { Ref: "DeveloperGithubSince" } });
  removePackedPieces(broker, "AGENTX_SETTINGS", ["gh", "gs"]);
  return input;
}
