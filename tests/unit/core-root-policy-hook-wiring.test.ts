// CORE-ROOT-HOOK-WIRING-TEST-20261117: the broker's core root hands the company rules service (enginePolicyHook) to the engine's per-task limit (projectTaskCapReader), so the
// limit its admission enforces before a model run is the one the settings page shows. The root's rules-service client takes an injected fetch (policyHookFetch), so this is exercised
// through the root's own registry with no network: replacing the hook with `undefined` (which still compiles) or dropping the injected fetch fails here.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped, policyHookKeyThumbprint, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { PROJECT_TASK_CAP_REACHED } from "../../packages/broker/src/core-host/hosted-modules.js";
import { RUN_START_ACTION } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { ADDRESS, ISSUER, fakeService, makeKey, signerOf } from "./policy-hook-fixture.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

const A = COMPANY_A_ID as OrgId;
const hookKey = makeKey("hook");
const JWKS = "https://rules.example/keys";
const HOOK = JSON.stringify({ address: ADDRESS, jwks: JWKS, thumbprints: [policyHookKeyThumbprint(hookKey.jwk)] });

const hrefOf = (url: Parameters<typeof globalThis.fetch>[0]): string => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
afterEach(() => { vi.unstubAllGlobals(); });

/** The root over a fake world; the rules service locks each company's `model_budget_usd` as `locks` says (absent: no lock). */
function world(locks: Record<string, number>, options: { env?: NodeJS.ProcessEnv; fetch?: boolean } = {}) {
  const w = createFakeWorld();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets", "model-keys"].includes(module.point));
  const service = fakeService({ key: hookKey, now: () => w.clock.now, answer: (asked) => ({ locks: Object.hasOwn(locks, String(asked.q["cid"])) ? { model_budget_usd: locks[String(asked.q["cid"])] } : {} }) });
  const keysAsked: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (hrefOf(url) === JWKS && (init?.method ?? "GET") === "GET") { keysAsked.push(hrefOf(url)); return new Response(JSON.stringify({ keys: [hookKey.jwk] })); }
    return await service.fetch(url, init);
  };
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    return { Item: await w.store.get(command.input.Key as { pk: string; sk: string }) };
  } };
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_TASK_CAP_USD: "25", ROVARA_POLICY_HOOK: HOOK, ...options.env },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    policyHookInstall: () => ({ issuer: ISSUER, signer: signerOf(makeKey("install")) }),
    ...(options.fetch === false ? {} : { policyHookFetch: fetch }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
  });
  const task = async (companyId: string, project: string) => {
    const taskId = randomUUID();
    await w.store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, project } });
    return taskId;
  };
  const projectLimit = (companyId: string, project: string, usd: number) => w.store.put({ item: {
    pk: companyScoped(companyId, `PROJECT_SETTINGS#${project}`), sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: project, overrides: { model_budget_usd: usd }, revision: 1,
    updatedAt: new Date(w.clock.now).toISOString(), updatedBy: "d".repeat(64),
  } });
  const runStart = async (companyId: string, taskId: string) => (await root.app.registry()).require("admission").admit({ companyId, idempotencyKey: `${RUN_START_ACTION}:${randomUUID()}`, action: RUN_START_ACTION, subject: { type: "task", id: taskId } });
  return { root, task, projectLimit, runStart, asked: service.asked, keysAsked };
}

describe("the broker root's engine limit goes through the company rules service (enginePolicyHook into projectTaskCapReader)", () => {
  it("a company limit below the project's own refuses the model run at the company's limit, through the injected fetch only", async () => {
    const global = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", global);
    const h = world({ [A]: 0 });
    await h.projectLimit(A, "web", 20);
    const taskId = await h.task(A, "web");
    expect(await h.runStart(A, taskId)).toEqual({ allowed: false, code: "task_cap", message: PROJECT_TASK_CAP_REACHED });
    // Asked twice (the stop's reading, then its words), always for the asking company; the answering keys come through the same injected fetch.
    expect(h.asked.map((asked) => asked.q["cid"])).toEqual([A, A]);
    expect(h.keysAsked).toEqual([JWKS, JWKS]);
    expect(global).not.toHaveBeenCalled();
  });

  it("without the injected fetch the root asks through the global fetch (the deployed broker); a rules service that does not answer refuses", async () => {
    const global = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", global);
    const h = world({ [A]: 0 }, { fetch: false });
    const taskId = await h.task(A, "web");
    expect(await h.runStart(A, taskId)).toMatchObject({ allowed: false, code: "spend_unknown" });
    expect(global).toHaveBeenCalled();
  });
});
