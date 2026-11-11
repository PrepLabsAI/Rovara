// the pull login exchange. The worker names nothing; the broker decides from the grant, the running preparation and the digest it recorded with the operation.
import { describe, expect, it } from "vitest";
import { HostedSavedEnvRegistryAuthSchema } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { countOperationAttribute, readSavedEnvOperation } from "../../packages/broker/src/core/test-env/saved-env-operations.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { SAVED_ENV_LOGIN_MAX_PER_OPERATION, exchangeSavedEnvLoginCore, type SavedEnvLoginContext } from "../../packages/broker/src/core/test-env/saved-env-login.js";

const REGISTRY = "127.0.0.1:5999";
const REPOSITORY = "rovara-env/test/oaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const DIGEST = `sha256:${"d".repeat(64)}`;
const login = { registry: REGISTRY, repository: REPOSITORY, username: "AWS" as const, password: PASSWORD, expiresAt: "2026-11-02T13:00:00.000Z" };

function context(over: Partial<SavedEnvLoginContext> & { operation?: Partial<Awaited<ReturnType<SavedEnvLoginContext["readOperation"]>>> } = {}) {
  const asked: unknown[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let counted = 0;
  const base: SavedEnvLoginContext = {
    enabled: true,
    inspectGrant: () => ({ workspaceId: "ws", operationId: "op" }),
    readOperation: async () => ({ kind: "prepare", status: "RUNNING", savedEnvDigest: DIGEST, orgId: "org-1", projectName: "payments", workspace: { status: "PREPARING", activeOperationId: "op" }, ...over.operation }),
    countLogin: async () => { counted += 1; return counted <= SAVED_ENV_LOGIN_MAX_PER_OPERATION; },
    login: async (input) => { asked.push(input); return login; },
    log: (event) => { logged.push(event); },
  };
  const rest: Partial<SavedEnvLoginContext> = { ...over };
  delete (rest as { operation?: unknown }).operation;
  return { context: { ...base, ...rest }, asked, logged };
}
const call = (c: SavedEnvLoginContext, over: { grant?: string | undefined; body?: unknown; workspaceId?: string; operationId?: string } = {}) =>
  exchangeSavedEnvLoginCore(c, { grant: "grant" in over ? over.grant : "g", workspaceId: over.workspaceId ?? "ws", operationId: over.operationId ?? "op", body: "body" in over ? over.body : {} });

describe("the saved environment login exchange", () => {
  it("gives the login for the digest recorded WITH THE OPERATION, for the workspace's own org and project, and logs the digest and expiry but never the login", async () => {
    const { context: c, asked, logged } = context();
    expect(await call(c)).toEqual({ login });
    expect(asked).toEqual([{ orgId: "org-1", projectName: "payments", digest: DIGEST }]);
    expect(JSON.stringify(logged)).toContain(DIGEST);
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it("reads the login through the schema it is given: a hosted install's schema refuses a login that names a loopback registry, where Code's own takes it", async () => {
    await expect(call(context({ registryAuthSchema: HostedSavedEnvRegistryAuthSchema }).context)).rejects.toThrow();
    expect(await call(context().context)).toEqual({ login });
  });

  it("is refused when the switch is off, there is no grant, or the grant is for another workspace or operation", async () => {
    await expect(call(context({ enabled: false }).context)).rejects.toThrow();
    await expect(call(context().context, { grant: undefined })).rejects.toThrow();
    await expect(call(context().context, { workspaceId: "ws-2" })).rejects.toThrow();
    await expect(call(context().context, { operationId: "op-2" })).rejects.toThrow();
    await expect(call(context({ inspectGrant: () => { throw new Error("forbidden"); } }).context)).rejects.toThrow();
  });

  it("is given to a running PREPARE only: not to a task, a finished or queued-out preparation, or one that is no longer the workspace's active operation", async () => {
    for (const operation of [{ kind: "task" }, { status: "SUCCEEDED" }, { status: "FAILED" }, { workspace: { status: "READY", activeOperationId: "op" } }, { workspace: { status: "PREPARING", activeOperationId: "other" } }]) {
      const { context: c, asked } = context({ operation });
      await expect(call(c)).rejects.toThrow();
      expect(asked).toEqual([]);
    }
  });

  it("an operation that was told no image gets no login, and the request cannot name an image or a project: any field in the body is refused", async () => {
    const { context: c, asked } = context({ operation: { savedEnvDigest: undefined } });
    await expect(call(c)).rejects.toThrow();
    for (const body of [{ digest: DIGEST }, { orgId: "org-2" }, [], null, "x"]) await expect(call(context().context, { body })).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("no login from the registry (the image went stale, the project moved on) is a refusal, and a login for another shape is not passed on", async () => {
    await expect(call(context({ login: async () => undefined }).context)).rejects.toThrow();
    await expect(call(context({ login: async () => ({ ...login, registry: "evil.example.com" }) }).context)).rejects.toThrow();
  });

  it("gives at most three logins per operation, then refuses with FORBIDDEN and asks the registry no more", async () => {
    const { context: c, asked } = context();
    for (let n = 0; n < SAVED_ENV_LOGIN_MAX_PER_OPERATION; n += 1) await call(c);
    await expect(call(c)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(asked).toHaveLength(SAVED_ENV_LOGIN_MAX_PER_OPERATION);
  });

  it("counts only a request that passed every other check", async () => {
    let counted = 0;
    const base = context({ countLogin: async () => { counted += 1; return true; } }).context;
    await expect(call(base, { grant: undefined })).rejects.toThrow();
    await expect(call({ ...base, enabled: false })).rejects.toThrow();
    expect(counted).toBe(0);
    await call(base);
    expect(counted).toBe(1);
  });
});

describe("the operation as the handlers read it, and the counter on its record", () => {
  const seeded = async (dispatch: Record<string, unknown> = {}) => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...operationKey("ws-1", "op-1"), entityType: "OPERATION", kind: "prepare", status: "RUNNING", dispatch: { kind: "prepare", payload: dispatch } } as never });
    await store.put({ item: { ...workspaceKey("ws-1"), entityType: "WORKSPACE", orgId: "org_aaaaaaaaaaaaaaaaaaaa", projectName: "payments", status: "PREPARING", activeOperationId: "op-1" } });
    return store;
  };

  it("names the image and the job from what the BROKER stored with the dispatch, nothing from the worker", async () => {
    const store = await seeded({ savedEnv: { digest: DIGEST }, savedEnvBuild: { jobId: "job-1" } });
    expect(await readSavedEnvOperation(store, "ws-1", "op-1")).toEqual({
      kind: "prepare", status: "RUNNING", savedEnvJobId: "job-1", savedEnvDigest: DIGEST, orgId: "org_aaaaaaaaaaaaaaaaaaaa", projectName: "payments", workspace: { status: "PREPARING", activeOperationId: "op-1" },
    });
    expect(await readSavedEnvOperation(await seeded(), "ws-1", "op-1")).toMatchObject({ savedEnvJobId: undefined, savedEnvDigest: undefined });
  });

  it("an operation or a workspace that is not there is NOT_FOUND", async () => {
    await expect(readSavedEnvOperation(new MemoryDocumentStore(), "ws-1", "op-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts a login on that operation only while it is under the limit, and never on an operation that is not there", async () => {
    const store = await seeded();
    const results: boolean[] = [];
    for (let attempt = 0; attempt < SAVED_ENV_LOGIN_MAX_PER_OPERATION + 2; attempt += 1) results.push(await countOperationAttribute(store, "ws-1", "op-1", "savedEnvLoginCount", SAVED_ENV_LOGIN_MAX_PER_OPERATION));
    expect(results).toEqual([true, true, true, false, false]);
    expect((await store.get(operationKey("ws-1", "op-1")))?.["savedEnvLoginCount"]).toBe(SAVED_ENV_LOGIN_MAX_PER_OPERATION);
    expect(await countOperationAttribute(store, "ws-1", "op-missing", "savedEnvLoginCount", 3)).toBe(false);
  });

  it("two requests at once cannot both take the last slot", async () => {
    const store = await seeded();
    const answers = await Promise.all(Array.from({ length: 6 }, () => countOperationAttribute(store, "ws-1", "op-1", "savedEnvPushLoginCount", 3)));
    expect(answers.filter(Boolean)).toHaveLength(3);
  });
});
