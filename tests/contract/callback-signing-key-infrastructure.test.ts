// DEC 254v(c): the callback signing key reaches no Lambda's environment. The stack keeps it in one Secrets Manager secret (made from the NoEcho CallbackSigningKey parameter, so an upgrade
// carries the existing value over without anyone reading it), gives each function the secret's NAME, and lets exactly the functions that sign with it read exactly that secret.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties: Json; DeletionPolicy?: string; Condition?: string; DependsOn?: unknown }
interface Statement { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown }

const named = Template.fromStack(new ControlPlaneStack(new App(), "CallbackKeyNamed", { naming: environmentNaming("staging") })).toJSON() as { Resources: Record<string, Resource>; Parameters: Json };
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "CallbackKeyLegacy")).toJSON() as { Resources: Record<string, Resource>; Parameters: Json };

const variablesOf = (resource: Resource): Record<string, unknown> => (resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
const functions = (template: typeof named) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
const secretOf = (template: typeof named, name: string) => Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::SecretsManager::Secret" && resource.Properties.Name === name)!;
const statementsOf = (template: typeof named, logicalPrefix: string): Statement[] => {
  const [, fn] = functions(template).find(([id]) => id.startsWith(logicalPrefix))!;
  const roleId = (fn.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
  return Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(`"${roleId}"`))
    .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
};

const READERS = {
  named: ["Broker", "EvalBatchTick", "SessionsReconciler"],
  legacy: ["Broker", "EvalBatchTick"],
};
const roleIdOf = (template: typeof named, logicalPrefix: string): string => {
  const [, fn] = functions(template).find(([id]) => new RegExp(`^${logicalPrefix}[0-9A-F]{8}$`, "u").test(id))!;
  return (fn.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
};

describe.each([["named (staging)", named, "agentx/staging/callback-key", READERS.named], ["legacy (production)", legacy, "agentx/production/callback-key", READERS.legacy]] as const)(
  "the callback signing key, %s", (_label, template, secretName, readers) => {
  const [secretId, secret] = secretOf(template, secretName);

  it("is in no function's environment: not as a value, not by reference to the parameter", () => {
    for (const [id, fn] of functions(template)) {
      const variables = variablesOf(fn);
      expect(variables, id).not.toHaveProperty("CALLBACK_SIGNING_KEY");
      expect(JSON.stringify(variables), id).not.toContain("CallbackSigningKey\"");
    }
  });

  it("is a parameter's value read in one place only: the secret's own text", () => {
    expect(JSON.stringify(template.Resources).match(/"Ref":"CallbackSigningKey"/g)).toHaveLength(1);
    expect(secret.Properties.SecretString).toEqual({ Ref: "CallbackSigningKey" });
    expect(template.Parameters.CallbackSigningKey).toMatchObject({ NoEcho: true, MinLength: 32 });
    // Retained, like the Slack secret: a stack delete leaves it, and `agentx destroy` removes retained secrets under agentx/<env>/.
    expect(secret.DeletionPolicy).toBe("Retain");
  });

  it("goes to each reader as the secret's name, and to no function as a value", () => {
    for (const prefix of readers) {
      const [, fn] = functions(template).find(([id]) => new RegExp(`^${prefix}[0-9A-F]{8}$`, "u").test(id))!;
      expect(variablesOf(fn).CALLBACK_SIGNING_KEY_SECRET_ID, prefix).toBe(secretName);
    }
    const named = functions(template).filter(([, fn]) => variablesOf(fn).CALLBACK_SIGNING_KEY_SECRET_ID !== undefined).map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""));
    expect(named.filter((prefix) => prefix !== "Dispatcher").sort()).toEqual([...readers].sort());
  });

  it("is readable by exactly its readers, through the secret's own policy: one statement, GetSecretValue only, on this secret (a policy on a secret has no other resource)", () => {
    const policies = Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::SecretsManager::ResourcePolicy");
    const mine = policies.filter(([, resource]) => JSON.stringify(resource.Properties.SecretId) === JSON.stringify({ Ref: secretId }));
    expect(mine).toHaveLength(1);
    const document = mine[0]![1].Properties.ResourcePolicy as { Statement: Array<Record<string, unknown>> };
    expect(document.Statement).toHaveLength(1);
    const statement = document.Statement[0]!;
    expect(statement).toMatchObject({ Sid: "ReadCallbackSigningKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" });
    expect(statement).not.toHaveProperty("Condition");
    const principals = ([(statement.Principal as { AWS: unknown }).AWS].flat() as Array<{ "Fn::GetAtt": string[] }>).map((entry) => entry["Fn::GetAtt"][0]).sort();
    expect(principals).toEqual(readers.map((prefix) => roleIdOf(template, prefix)).sort());
  });

  it("is granted to no role by any identity policy, with a wildcard or otherwise (the dispatcher's conditional read aside)", () => {
    for (const [policyId, resource] of Object.entries(template.Resources).filter(([, entry]) => entry.Type === "AWS::IAM::Policy")) {
      for (const statement of (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement) {
        const actions = [statement.Action].flat();
        if (!policyId.includes("DispatcherCorePolicy")) expect(JSON.stringify(statement.Resource), `${policyId} ${statement.Sid ?? ""}`).not.toContain(secretId);
        expect(actions.some((action) => action === "secretsmanager:*" || action === "*"), policyId).toBe(false);
      }
    }
  });
});

describe("the named environment's dispatcher", () => {
  const [secretId] = secretOf(named, "agentx/staging/callback-key");
  const [, dispatcher] = functions(named).find(([id]) => /^Dispatcher[0-9A-F]{8}$/u.test(id))!;
  const variable = variablesOf(dispatcher).CALLBACK_SIGNING_KEY_SECRET_ID as { "Fn::If": [string, string, string] };

  it("gets the secret's name only while the core switch is not off", () => {
    expect(variable["Fn::If"][1]).toBe("agentx/staging/callback-key");
    expect(variable["Fn::If"][2]).toBe("");
    expect(variablesOf(dispatcher)).not.toHaveProperty("CALLBACK_SIGNING_KEY");
  });

  it("may read exactly that secret, in the policy that exists only under that condition, and nowhere else on its role", () => {
    const dispatcherRole = (dispatcher.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
    const holders = Object.entries(named.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(`"${dispatcherRole}"`)
      && JSON.stringify(resource.Properties.PolicyDocument).includes(secretId));
    expect(holders).toHaveLength(1);
    expect(holders[0]![1].Condition).toBe(variable["Fn::If"][0]);
    const reads = (holders[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement.filter((statement) => [statement.Action].flat().includes("secretsmanager:GetSecretValue"));
    expect(reads).toEqual([{ Sid: "ReadCallbackSigningKey", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: secretId } }]);
  });
});
