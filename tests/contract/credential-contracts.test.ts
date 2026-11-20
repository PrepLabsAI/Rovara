import { describe, expect, it } from "vitest";
import {
  CredentialRegistrationSchema, OAuthClientCredentialsSecretSchema, StaticSecretSchema,
} from "../../packages/contracts/src/credentials.js";
import {
  IN_HOUSE_TOOL_COUNT, approvedToolCount, presentedNameProblems, toolBudget,
} from "../../packages/contracts/src/connectors-node.js";

describe("secret payloads", () => {
  it("parses a static key and client credentials with a fixed scope set", () => {
    expect(StaticSecretSchema.parse({ apiKey: "k" })).toEqual({ apiKey: "k" });
    expect(OAuthClientCredentialsSecretSchema.parse({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] }))
      .toEqual({ clientId: "id", clientSecret: "s", scopes: ["read", "write"] });
  });

});

describe("tool budget at registration", () => {
  it("counts in-house tools plus every approved connector tool", () => {
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "a", access: "read" }, { name: "b", access: "write" }] }] } };
    expect(approvedToolCount(definition as never)).toBe(2);
    expect(approvedToolCount({ repositories: [], integrations: { githubMcp: { tools: [{ name: "a", access: "read" }] } } } as never)).toBe(1);
    expect(approvedToolCount({ repositories: [] } as never)).toBe(0);
  });

  it("never warns about many tools, because tools above 20 load on demand, and refuses only above the sanity limit of 200", () => {
    expect(toolBudget(20 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 20 });
    expect(toolBudget(60 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 60 });
    expect(toolBudget(200 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 200 });
    expect(toolBudget(201 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 201, refusal: "this project could expose 201 tools; at most 200 are allowed. Approve fewer connector tools." });
  });

  it("names presented-name problems for the legacy githubMcp connector too", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { githubMcp: { tools: [{ name: long, access: "read" }] } } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });
});

describe("connector secret names per environment", () => {
  const registration = (secretName: string) => CredentialRegistrationSchema.safeParse({ ref: "linear", type: "static-secret", secretName });

  it("accepts the legacy and the environment forms", () => {
    expect(registration("agentx/connectors/linear").success).toBe(true);
    expect(registration("agentx/staging/connectors/linear").success).toBe(true);
  });

});
