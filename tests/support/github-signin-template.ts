// DEC 254h: GitHub sign-in's named-environment additions to the control-plane template. Each digest or snapshot test that pins the rest of the
// template asserts these exactly, then takes them out (in place): three parameters, four variables on the sign-in function, one read of the one
// GitHub secret, and the broker's two packed settings; and it puts back the two broker variables moved to make room for them (CHANNEL_ADAPTERS, COMPANY_READS).
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
  const environment = template.Resources[lambdaId(template, "Broker")]!.Properties.Environment as { Variables: Record<string, unknown> };
  const broker = environment.Variables;
  expect(unpackedBrokerVariables(broker)).toMatchObject({ DEVELOPER_SIGNIN_GITHUB: { Ref: "DeveloperSignInGithub" }, DEVELOPER_GITHUB_SINCE: { Ref: "DeveloperGithubSince" } });
  removePackedPieces(broker, "AGENTX_SETTINGS", ["gh", "gs"]);
  // The room GitHub sign-in made in the broker's 4 KB (tests/contract/lambda-environment-size.test.ts): the channel adapters' switch is packed (ca) and COMPANY_READS is derived
  // by the broker, so neither is a variable of its own. Asserted exactly, then put back as the two variables they were, where they were (a function's variables keep the order
  // the constructs added them in: CHANNEL_ADAPTERS after AGENTX_SETTINGS, COMPANY_READS after DEVELOPER_OIDC_ISSUER), so each pin taken before GitHub sign-in still holds.
  expect(Object.keys(broker).filter((name) => name === "CHANNEL_ADAPTERS" || name === "COMPANY_READS")).toEqual([]);
  expect(unpackedBrokerVariables(broker)).toMatchObject({ CHANNEL_ADAPTERS: { Ref: "ChannelAdapters" }, COMPANY_READS: "enabled" });
  removePackedPieces(broker, "AGENTX_SETTINGS", ["ca"]);
  const after: Record<string, [string, unknown]> = { AGENTX_SETTINGS: ["CHANNEL_ADAPTERS", { Ref: "ChannelAdapters" }], DEVELOPER_OIDC_ISSUER: ["COMPANY_READS", "enabled"] };
  expect(Object.keys(after).filter((name) => name in broker)).toEqual(Object.keys(after));
  environment.Variables = Object.fromEntries(Object.entries(broker).flatMap((entry) => (after[entry[0]] === undefined ? [entry] : [entry, after[entry[0]]!])));
  return input;
}
