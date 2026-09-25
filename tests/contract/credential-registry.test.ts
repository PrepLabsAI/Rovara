import { describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const secretValues: Record<string, string> = {
  "agentx/connectors/jira-sa": JSON.stringify({ apiKey: "jira-key-value" }),
  "agentx/connectors/jira-oauth": JSON.stringify({ clientId: "id", clientSecret: "jira-oauth-secret-value", scopes: ["read"] }),
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
  it("names the provider type behind a reference, and nothing for an unknown one", async () => {
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/jira-oauth" } });
    expect(await registry!.typeOf(githubApp.ref)).toBe("github-app");
    expect(await registry!.typeOf("jira-oauth")).toBe("oauth-client-credentials");
    expect(await registry!.typeOf("missing")).toBeUndefined();
  });

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

  it("passes invalidate through to the stored provider, so the next issue rereads the secret", async () => {
    let value = "jira-key-1";
    const source = { read: vi.fn(async () => JSON.stringify({ apiKey: value })) };
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets: source, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } });
    const provider = registry!.provider("jira-sa");
    expect(await provider.issue(undefined, "read")).toEqual({ token: "jira-key-1", bindings: {} });
    value = "jira-key-2";
    // Within the in-memory cache window, issue() alone must not pick up the change.
    expect(await provider.issue(undefined, "read")).toEqual({ token: "jira-key-1", bindings: {} });
    await provider.invalidate?.(undefined);
    expect(await provider.issue(undefined, "read")).toEqual({ token: "jira-key-2", bindings: {} });
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

  it("maps DecryptionFailure, InvalidRequestException and InvalidParameterException to CredentialUnavailable, naming only the secret", async () => {
    const { secretsManagerSource } = await import("../../packages/broker/src/aws/credentials.js");
    const failing = (name: string) => ({ send: vi.fn(async () => { throw Object.assign(new Error("aws-internal-detail: ciphertext blob invalid"), { name }); }) });
    for (const name of ["DecryptionFailure", "InvalidRequestException", "InvalidParameterException"]) {
      const error = await secretsManagerSource(failing(name)).read("agentx/connectors/x").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CredentialUnavailable);
      expect((error as Error).message).toBe("secret agentx/connectors/x cannot be decrypted or is scheduled for deletion");
      expect((error as Error).message).not.toContain("aws-internal-detail");
    }
  });

  it("extends the access-denied message to name the KMS key as a possible cause", async () => {
    const { secretsManagerSource } = await import("../../packages/broker/src/aws/credentials.js");
    const failing = { send: vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); }) };
    const error = await secretsManagerSource(failing).read("agentx/connectors/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialUnavailable);
    expect((error as Error).message).toBe("AgentX cannot read secret agentx/connectors/x; connector secrets must be named agentx/connectors/<name> in this account and region, or its KMS key does not allow the AgentX broker");
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
      const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "connector.token_cache_failed");
      expect(failures.map((line) => [line.operation, line.error])).toEqual([["put", "Error"], ["get", "Error"]]);
      expect(lines.join("\n")).not.toContain("throttled");
    } finally { log.mockRestore(); }
  });
});

describe("registry failure modes", () => {
  const register = (handler: Parameters<typeof adminCall>[0], ref: string, type: string, secretName: string) =>
    adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref, type, secretName } });

  it("answers RUNTIME_UNAVAILABLE naming only the secret when Secrets Manager fails transiently during registration", async () => {
    const throttling = { read: vi.fn(async () => { throw Object.assign(new Error("Rate exceeded for aws-internal-detail"), { name: "ThrottlingException" }); }) };
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets: throttling, githubApp } });
    const response = await register(handler, "jira-sa", "static-secret", "agentx/connectors/jira-sa");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE", message: "could not read secret agentx/connectors/jira-sa from Secrets Manager; try again" } });
    expect(JSON.stringify(response.body)).not.toMatch(/Rate exceeded|aws-internal-detail/);
  });

  it("answers CONFIG_INVALID naming only the secret when it cannot be decrypted, not RUNTIME_UNAVAILABLE", async () => {
    const { secretsManagerSource } = await import("../../packages/broker/src/aws/credentials.js");
    const undecryptable = secretsManagerSource({ send: vi.fn(async () => { throw Object.assign(new Error("aws-internal-detail: ciphertext blob"), { name: "DecryptionFailure" }); }) });
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets: undecryptable, githubApp } });
    const response = await register(handler, "jira-sa", "static-secret", "agentx/connectors/jira-sa");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "secret agentx/connectors/jira-sa cannot be decrypted or is scheduled for deletion" } });
    expect(JSON.stringify(response.body)).not.toMatch(/aws-internal-detail/);
  });

  it("keeps a transient Secrets Manager error a plain error on the provider path", async () => {
    let failing = false;
    const flaky = { read: vi.fn(async (name: string) => {
      if (failing) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      return secretValues[name];
    }) };
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets: flaky, githubApp } });
    expect((await register(handler, "jira-sa", "static-secret", "agentx/connectors/jira-sa")).status).toBe(201);
    failing = true;
    const error = await registry!.provider("jira-sa").issue(undefined, "read").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialUnavailable);
  });

  it("refuses an oauth-client-credentials registration whose secret has the static shape", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    expect((await register(handler, "jira-oauth", "oauth-client-credentials", "agentx/connectors/jira-sa")).body).toMatchObject({
      error: { code: "CONFIG_INVALID", message: 'credential jira-oauth: secret agentx/connectors/jira-sa must be JSON {"clientId": "...", "clientSecret": "...", "scopes": ["..."]}' },
    });
  });

  it("makes the same provider object return the new secret after re-registration with another secret name", async () => {
    const rotating = { read: vi.fn(async (name: string) => ({ ...secretValues, "agentx/connectors/jira-sa-2": JSON.stringify({ apiKey: "jira-key-2" }) })[name]) };
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets: rotating, githubApp } });
    await register(handler, "jira-sa", "static-secret", "agentx/connectors/jira-sa");
    const provider = registry!.provider("jira-sa");
    expect((await provider.issue(undefined, "read")).token).toBe("jira-key-value");
    expect((await register(handler, "jira-sa", "static-secret", "agentx/connectors/jira-sa-2")).body).toMatchObject({ replaced: true });
    expect((await provider.issue(undefined, "read")).token).toBe("jira-key-2");
  });

  it("treats a malformed stored record as unregistered and skips it in the list with a log line", async () => {
    const { db, handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    db.set({ pk: "CREDENTIALS", sk: "REF#broken", entityType: "CREDENTIAL", ref: "broken", type: "static-secret" });
    await expect(registry!.provider("broken").issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential broken is not registered; run agentx admin credential register"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
      expect((listed.body.credentials as Array<{ ref: string }>).map((entry) => entry.ref)).toEqual(["github-app"]);
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines).toContainEqual({ component: "broker", event: "connector.credential_record_invalid", credential: "broken" });
    } finally { log.mockRestore(); }
  });

  it("skips a stored record whose ref equals the built-in GitHub App reference, so list never returns it twice", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    db.set({
      pk: "CREDENTIALS", sk: `REF#${githubApp.ref}`, entityType: "CREDENTIAL",
      ref: githubApp.ref, type: "static-secret", secretName: "agentx/connectors/shadow-github-app",
      registeredBy: "someone", registeredAt: new Date().toISOString(),
    });
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    const refs = (listed.body.credentials as Array<{ ref: string }>).map((entry) => entry.ref);
    expect(refs).toEqual(["github-app"]);
    expect(listed.body.credentials).toContainEqual({ ref: "github-app", type: "github-app", secretName: githubApp.secretName, builtIn: true, tokenCached: false });
  });
});
