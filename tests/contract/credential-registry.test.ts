import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const secretValues: Record<string, string> = {
  "agentx/connectors/jira-sa": JSON.stringify({ apiKey: "jira-key-value" }),
  "agentx/connectors/linear": JSON.stringify({ clientId: "id", clientSecret: "linear-secret-value", scopes: ["read"] }),
};
const secrets = { read: vi.fn(async (name: string) => secretValues[name]) };

describe("credential registry routes", () => {
  it("registers, lists with the built-in GitHub App first, and never returns a secret value", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const registered = await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ replaced: false, credential: { ref: "jira-sa", type: "static-secret", builtIn: false, tokenCached: false } });
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.status).toBe(200);
    expect((listed.body.credentials as Array<{ ref: string }>).map((entry) => entry.ref)).toEqual(["github-app", "jira-sa"]);
    expect(listed.body.credentials).toContainEqual({ ref: "github-app", type: "github-app", secretName: githubApp.secretName, builtIn: true, tokenCached: false });
    expect(JSON.stringify([registered.body, listed.body])).not.toMatch(/jira-key-value|linear-secret-value/);
  });

  it("requires the administrator claim", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials", admin: false })).status).toBe(403);
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", admin: false, body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } })).status).toBe(403);
  });

  it("refuses the built-in reference, a missing secret and a secret of the wrong shape, naming only the secret", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const refuse = async (body: Record<string, unknown>) => adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    expect((await refuse({ ref: "github-app", type: "static-secret", secretName: "agentx/connectors/jira-sa" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "github-app is the built-in GitHub App credential and cannot be replaced" } });
    expect((await refuse({ ref: "missing", type: "static-secret", secretName: "agentx/connectors/missing" })).body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "credential missing: secret agentx/connectors/missing was not found" } });
    const wrong = await refuse({ ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" });
    expect(wrong.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: 'credential linear: secret agentx/connectors/linear must be JSON {"apiKey": "..."}' } });
    expect(JSON.stringify(wrong.body)).not.toContain("linear-secret-value");
  });

  it("replacing a credential deletes its cached tokens and reports tokenCached", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    db.set({ pk: "CREDENTIAL#linear", sk: "TOKEN#abc", token: "cached-token", expiresAt: Date.now() + 3_600_000 });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" })).body.credentials).toContainEqual(expect.objectContaining({ ref: "linear", tokenCached: true }));
    const replaced = await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    expect(replaced.body).toMatchObject({ replaced: true, credential: { tokenCached: false } });
    expect(db.get("CREDENTIAL#linear", "TOKEN#abc")).toBeUndefined();
  });

  it("answers RUNTIME_UNAVAILABLE when the deployment has no credential configuration", async () => {
    const { handler } = await createAdminBroker({});
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" })).body).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
  });
});

describe("registry providers", () => {
  it("resolves the record on each issue and reports unregistered or unusable references as unavailable", async () => {
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const provider = registry!.provider("jira-sa");
    await expect(provider.issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential jira-sa is not registered; run agentx admin credential register"));
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } });
    expect(await provider.issue(undefined, "read")).toEqual({ token: "jira-key-value", bindings: {} });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    await expect(registry!.provider("linear").issue(undefined, "read")).rejects.toThrow(CredentialUnavailable);
    await expect(registry!.provider("github-app").issue(undefined, "read")).rejects.toThrow("credential github-app is the built-in GitHub App and serves only the github connector");
  });
});

describe("Secrets Manager source and token cache", () => {
  it("maps a missing secret to undefined and an access denial to CredentialUnavailable", async () => {
    const { secretsManagerSource } = await import("../../packages/broker/src/aws/credentials.js");
    const failing = (name: string) => ({ send: vi.fn(async () => { throw Object.assign(new Error("denied"), { name }); }) });
    await expect(secretsManagerSource(failing("ResourceNotFoundException")).read("agentx/connectors/x")).resolves.toBeUndefined();
    await expect(secretsManagerSource(failing("AccessDeniedException")).read("agentx/connectors/x")).rejects.toBeInstanceOf(CredentialUnavailable);
    await expect(secretsManagerSource(failing("ThrottlingException")).read("agentx/connectors/x")).rejects.not.toBeInstanceOf(CredentialUnavailable);
  });

  it("logs and swallows a token cache write failure without the token", async () => {
    const { DynamoTokenCache } = await import("../../packages/broker/src/aws/credentials.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const cache = new DynamoTokenCache({ send: vi.fn(async () => { throw new Error("throttled"); }) } as never, "state", "linear");
      await expect(cache.put("abc", { token: "secret-token", expiresAt: 1 })).resolves.toBeUndefined();
      await expect(cache.get("abc")).resolves.toBeUndefined();
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes("connector.token_cache_failed"))).toBe(true);
      expect(lines.join("\n")).not.toContain("secret-token");
    } finally { log.mockRestore(); }
  });
});
