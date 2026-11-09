// SH25: the prepare invocation's saved environment field: its schema, the feature a worker lists for it, and the options the worker builds from it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREPARE_SAVED_ENV_FEATURE, PrepareSavedEnvSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, savedEnvRepositoryName } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { createSavedEnvLoginProvider } from "../../packages/worker/src/saved-env/login.js";
import { savedEnvOptionsOf } from "../../packages/worker/src/saved-env/use.js";

afterEach(() => vi.restoreAllMocks());
const repository = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "payments" });
const secret = ["login", "-", "p".repeat(30)].join("");
const registry = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const payload = { repository, digest: `sha256:${"d".repeat(64)}`, testEnvRevision: 4, environmentKey: "a".repeat(64), taskTestEnvRevision: 4 };
const login = { registry, repository, username: "AWS" as const, password: secret, expiresAt: "2026-11-02T13:00:00.000Z" };

describe("the saved environment field", () => {
  it("is strict: a tag, another repository name, a login of any kind, an extra field and a missing pin are refused (a stored invocation holds no credential)", () => {
    expect(PrepareSavedEnvSchema.safeParse(payload).success).toBe(true);
    for (const bad of [
      { ...payload, digest: "latest" },
      { ...payload, repository: "evil/repo" },
      { ...payload, auth: login },
      { ...payload, use: { auth: login } },
      { ...payload, password: secret },
      { ...payload, extra: 1 },
      { repository, digest: payload.digest, testEnvRevision: 4, environmentKey: payload.environmentKey },
      { ...payload, taskTestEnvRevision: 0 },
    ]) expect(PrepareSavedEnvSchema.safeParse(bad).success).toBe(false);
  });

  it("rides on a prepare invocation, and only a prepare invocation's strict payload takes it", () => {
    const base = { protocolVersion: 1, kind: "prepare", operationId: "7c0f4b9e-1111-4222-8333-444455556666", workspaceId: "7c0f4b9e-1111-4222-8333-444455557777", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const project = { name: "payments", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "svc-read" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", savedEnv: payload } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", savedEnv: { ...payload, junk: true } } }).success).toBe(false);
  });

  it("is a feature the schema knows and this worker lists", () => {
    expect(PREPARE_SAVED_ENV_FEATURE).toBe("prepare.savedEnv.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(PREPARE_SAVED_ENV_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(PREPARE_SAVED_ENV_FEATURE);
  });

  it("the worker builds its options from it, and a fallback is a log line with the digest and the step and no credential", async () => {
    const docker = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const getLogin = async () => login;
    const options = savedEnvOptionsOf(PrepareSavedEnvSchema.parse(payload), getLogin, docker);
    expect(options).toMatchObject({ ref: payload, login: getLogin, docker });
    options.onFallback?.("pull");
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ component: "worker", event: "saved-env.fallback", digest: payload.digest, step: "pull" });
    expect(line).not.toContain(secret);
  });
});

describe("the worker's request for the pull login", () => {
  const invocation = { kind: "prepare", workspaceId: "ws-1", operationId: "op-1", payload: { repositoryGrant: "grant-1" } } as never;

  it("POSTs to the preparation's own operation with its grant, and returns the login without logging it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = createSavedEnvLoginProvider({ controlPlaneUrl: "https://cp.example.test/", invocation, fetchImplementation: async (url, init) => { calls.push({ url: typeof url === "string" ? url : "unexpected", init: init! }); return new Response(JSON.stringify({ login }), { status: 200 }); } });
    expect(await provider()).toEqual(login);
    expect(calls[0]!.url).toBe("https://cp.example.test/v1/internal/workspaces/ws-1/operations/op-1/saved-env-login");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["x-agentx-repository-grant"]).toBe("grant-1");
    expect(log).not.toHaveBeenCalled();
  });

  it("fails with a fixed sentence that carries neither the answer nor the login", async () => {
    for (const fetchImplementation of [
      async () => new Response(`denied ${secret}`, { status: 403 }),
      async () => new Response("not json", { status: 200 }),
      async () => new Response(JSON.stringify({ login: { ...login, registry: "evil.example.com" } }), { status: 200 }),
      async () => { throw new Error(`down ${secret}`); },
    ] as Array<typeof fetch>) {
      const error = await createSavedEnvLoginProvider({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation })().then(() => undefined, (caught: unknown) => caught);
      expect(String((error as Error).message)).toContain("Rovara could not get a login for the saved environment");
      expect(String((error as Error).message)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
