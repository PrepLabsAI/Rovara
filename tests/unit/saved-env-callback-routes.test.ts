import { describe, expect, it, vi } from "vitest";
import { HostedSavedEnvRegistryAuthSchema, savedEnvRepositoryName } from "@agentx/contracts";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { checkRebuild, leaseForDispatch } from "../../packages/broker/src/core/test-env/saved-env.js";
import { savedEnvWorld, dig, imageOf } from "../support/saved-env-world.js";
import { queuedJobId } from "../support/saved-env-job.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const COMPANY = "org_staging0000000000001";
const KEY = "k".repeat(32);
const ACTIONS = ["saved-env-push-login", "saved-env-result", "saved-env-fallback", "saved-env-login"] as const;
async function world(enabled = true) {
  const w = savedEnvWorld({ ids: { orgId: COMPANY, projectId: "app" } });
  const checked = await checkRebuild(w.deps, w.ids, "poll");
  const leased = await leaseForDispatch(w.deps, w.ids, OP, queuedJobId(checked));
  if (!leased.ok) throw new Error("not leased");
  w.seed({ ...w.row(), images: [imageOf(dig(1))] });
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workspaceKey(COMPANY, WS), companyId: COMPANY, orgId: COMPANY, projectName: "app", status: "PREPARING", activeOperationId: OP } });
  await store.put({ item: { ...operationKey(COMPANY, WS, OP), companyId: COMPANY, id: OP, workspaceId: WS, kind: "prepare", status: "RUNNING", fence: 1, dispatch: { payload: { savedEnvBuild: { jobId: leased.job.jobId }, savedEnv: { digest: dig(1) } } } } });
  const auth = { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", repository: savedEnvRepositoryName({ env: "test", orgId: COMPANY, projectId: "app" }), username: "AWS" as const, password: "p".repeat(32), expiresAt: new Date(w.clock.now + 900_000).toISOString() };
  w.registry.login = async () => ({ auth, expiresAtMs: w.clock.now + 900_000 });
  const log = vi.fn();
  const handler = createCallbackHandler({ flow: { store, companyId: COMPANY, callbackSigningKey: KEY, log } as never, blobs: {} as never, grants: {} as never,
    ...(enabled ? { savedEnv: { deps: w.deps, inspectGrant: (grant: string) => { if (grant !== "own-grant") throw new Error("bad grant"); return { workspaceId: WS, operationId: OP }; }, registryAuthSchema: HostedSavedEnvRegistryAuthSchema } } : {}) });
  const capability = (patch = {}) => new CallbackCapabilities(Buffer.from(KEY)).issue({ workspaceId: WS, operationId: OP, fence: 1, actions: [...ACTIONS] as CallbackAction[], expiresInSeconds: 300, ...patch });
  const body = (action: string) => action === "saved-env-login" ? {} : action === "saved-env-fallback" ? { step: "pull" } : { jobId: leased.job.jobId, leaseToken: leased.job.leaseToken, ...(action === "saved-env-result" ? { result: { ok: false, reason: "not_proved" } } : {}) };
  const request = (action: string, headers = {}, workspace = WS, operation = OP) => handler({ method: "POST", path: `/v1/internal/workspaces/${workspace}/operations/${operation}/${action}`, headers, body: JSON.stringify(body(action)) });
  return { w, store, capability, request, auth, log };
}
describe("saved environment worker callbacks", () => {
  it("refuses missing, forged, wrong-action, expired, wrong workspace/operation and fence capabilities on every route", async () => {
    const h = await world();
    for (const action of ACTIONS) {
      for (const token of [undefined, "forged", h.capability({ actions: ["events"] }), h.capability({ expiresInSeconds: -1 }), h.capability({ workspaceId: OTHER }), h.capability({ operationId: OTHER }), h.capability({ fence: 2 })]) {
        const answer = await h.request(action, { ...(token === undefined ? {} : { "x-agentx-callback-capability": token }), "x-agentx-repository-grant": "own-grant" });
        expect(answer.statusCode, `${action}: ${token}`).toBe(409);
        expect(h.log.mock.calls.at(-1)).toEqual([{ component: "callbacks", event: "saved_env.callback", route: action, operationId: OP, result: (JSON.parse(answer.body) as { error: { code: string } }).error.code }]);
      }
    }
    expect(h.w.logins).toEqual([]);
    expect(h.log).toHaveBeenCalledTimes(ACTIONS.length * 7);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(h.capability());
  });
  it("serves all four core handlers only to their own live preparation", async () => {
    for (const action of ACTIONS) {
      const h = await world();
      const answer = await h.request(action, { "x-agentx-callback-capability": h.capability(), "x-agentx-repository-grant": "own-grant" });
      expect(answer.statusCode, answer.body).toBe(200);
      expect(h.log.mock.calls).toEqual([[{ component: "callbacks", event: "saved_env.callback", route: action, operationId: OP, result: "ok" }]]);
      expect(JSON.stringify(h.log.mock.calls)).not.toContain(h.auth.password);
      if (action.endsWith("login")) {
        expect(JSON.parse(answer.body)).toEqual({ login: h.auth });
        expect(answer.headers?.["cache-control"]).toBe("no-store");
      }
    }
  });
  it("refuses ended, wrong-company operations and missing repository grants", async () => {
    for (const patch of [{ status: "SUCCEEDED" }, { companyId: "org_staging0000000000002" }]) {
      const h = await world();
      const row = (await h.store.get(operationKey(COMPANY, WS, OP)))!;
      await h.store.put({ item: { ...row, ...patch } });
      for (const action of ACTIONS) expect((await h.request(action, { "x-agentx-callback-capability": h.capability(), "x-agentx-repository-grant": "own-grant" })).statusCode).not.toBe(200);
    }
    const h = await world();
    for (const action of ["saved-env-login", "saved-env-fallback"]) expect((await h.request(action, { "x-agentx-callback-capability": h.capability() })).statusCode).toBe(403);
  });
});
