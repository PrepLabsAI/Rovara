import { describe, expect, it } from "vitest";
import {
  CredentialRegistrationSchema, OAuthClientCredentialsSecretSchema, StaticSecretSchema,
} from "../../packages/contracts/src/credentials.js";
import {
  IN_HOUSE_TOOL_COUNT, approvedToolCount, presentedNameProblems, toolBudget,
} from "../../packages/contracts/src/connectors.js";

describe("credential registration input", () => {
  it("accepts the two registrable types with a connector secret name", () => {
    expect(CredentialRegistrationSchema.parse({ ref: "linear-payments", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-payments" }))
      .toEqual({ ref: "linear-payments", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-payments" });
    expect(CredentialRegistrationSchema.safeParse({ ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" }).success).toBe(true);
  });

  it("refuses reserved and built-in types, other secret prefixes and extra fields", () => {
    for (const type of ["github-app", "per-user", "basic"]) {
      expect(CredentialRegistrationSchema.safeParse({ ref: "x", type, secretName: "agentx/connectors/x" }).success).toBe(false);
    }
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "prod/db-password" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/../x" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/.." }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/." }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "Bad Ref", type: "static-secret", secretName: "agentx/connectors/x" }).success).toBe(false);
    expect(CredentialRegistrationSchema.safeParse({ ref: "x", type: "static-secret", secretName: "agentx/connectors/x", tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });
});

describe("secret payloads", () => {
  it("parses a static key and client credentials with a fixed scope set", () => {
    expect(StaticSecretSchema.parse({ apiKey: "k" })).toEqual({ apiKey: "k" });
    expect(OAuthClientCredentialsSecretSchema.parse({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] }))
      .toEqual({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] });
  });

  it("refuses a secret that could redirect the broker or is missing fields", () => {
    expect(StaticSecretSchema.safeParse({ apiKey: "" }).success).toBe(false);
    expect(OAuthClientCredentialsSecretSchema.safeParse({ clientId: "id", clientSecret: "s", scopes: [] }).success).toBe(false);
    expect(OAuthClientCredentialsSecretSchema.safeParse({ clientId: "id", clientSecret: "s", scopes: ["read"], tokenEndpoint: "https://evil.test" }).success).toBe(false);
  });
});

describe("tool budget at registration", () => {
  it("counts in-house tools plus every approved connector tool", () => {
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "a", access: "read" }, { name: "b", access: "write" }] }] } };
    expect(approvedToolCount(definition as never)).toBe(2);
    expect(approvedToolCount({ repositories: [], integrations: { githubMcp: { tools: [{ name: "a", access: "read" }] } } } as never)).toBe(1);
    expect(approvedToolCount({ repositories: [] } as never)).toBe(0);
  });

  it("warns above 20 visible tools and refuses above 40", () => {
    expect(toolBudget(20 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 20 });
    expect(toolBudget(21 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 21, warning: "the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools." });
    expect(toolBudget(41 - IN_HOUSE_TOOL_COUNT)).toMatchObject({ maximum: 41, refusal: "this project could expose 41 tools; at most 40 are allowed. Approve fewer connector tools." });
  });

  it("names every approval whose presented name exceeds 64 characters", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: long, access: "read" }, { name: "short", access: "read" }] }] } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });

  it("names presented-name problems for the legacy githubMcp connector too", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { githubMcp: { tools: [{ name: long, access: "read" }] } } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });
});
