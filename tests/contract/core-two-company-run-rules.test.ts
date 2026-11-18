// Batch b18 Low 2: core-two-company-run and core-admin-stop-company mock the company-instructions point empty. This is the ONE two-company contract run WITHOUT that mock:
// the real root, the real company-rules adapter and a stubbed gateway fetch. Company A's start never reads company B's rules, and a wrong-company answer stops the start (fails closed).
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { COMPANY_INSTRUCTIONS_PATH } from "../../packages/broker/src/core-host/company-instructions-http.js";
import { makeKey, signerOf } from "../unit/policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
// Only the code adapters are replaced (as in the other two-company runs); company-instructions-http.js is NOT mocked.
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb", C: OrgId = "org_cccccccccccccccccccc";
const personA = "a".repeat(64), personB = "b".repeat(64), personC = "c".repeat(64);
const SIGNING = "k".repeat(32);
const MODEL = "claude-sonnet-4-6";
const gateway = "https://gateway.example";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "app" }] };

async function world() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const members = new Map([[personA, A], [personB, B], [personC, C]]);
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length), companyId = members.get(personId);
      return { Item: companyId === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: new Date(w.clock.now).toISOString() } };
    }
    // DEC 254zzz80: each person's "payments" grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(key.pk);
    if (grant !== null) return { Item: members.get(grant[2]!) === grant[1] ? { ...key, projectName: "payments", role: "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  const key = makeKey("t".repeat(16));
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}:${B}`, ROVARA_CORE_ALLOWED_COMPANIES: `${A}:${B}`, ROVARA_CORE_MODEL_GATEWAY_URL: gateway, ROVARA_CORE_AGENT_MODEL: MODEL, ROVARA_CORE_LESSONS: "on" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    taskTokens: () => ({ signer: taskKeySigner(signerOf(key)), issuer: "https://api.example/v1/auth" }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  for (const companyId of [A, B]) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, "payments", 1), definition: project }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, "payments"), latestRevision: 1 } });
  }
  const caller = (developerId: string) => ({ developerId, sessionId: "session", name: "Member" });
  const start = (developerId: string) => root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: "payments", instructions: "Add retry handling" }) }, caller(developerId));
  return { w, root, start };
}

/** Cloud's answers by company. The gateway answers for the token's company only: A has rules, B has its own. */
const RULES: Record<string, string> = { [A]: "A-ONLY-RULE: never commit secrets.", [B]: "B-ONLY-RULE: deploy on Fridays." };
const cidOf = (init: RequestInit | undefined): string => (JSON.parse(Buffer.from(String((init?.headers as Record<string, string>)["authorization"]).split(".")[1]!, "base64url").toString()) as { cid: string }).cid;
const asked: string[] = [];
function stubGateway(answerFor: (company: string) => string = (company) => company): void {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url) !== `${gateway}${COMPANY_INSTRUCTIONS_PATH}`) throw new Error(`unexpected fetch ${String(url)}`);
    const company = cidOf(init);
    asked.push(company);
    const answer = answerFor(company);
    return new Response(JSON.stringify({ company: answer, version: "3", rules: [{ text: RULES[answer]!, priority: "required" }] }), { status: 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); asked.length = 0; });

/** The fake store's row count (its class exposes it; the port type does not). */
const rowCount = (store: unknown): number => (store as { size: number }).size;
const pinOf = async (h: Awaited<ReturnType<typeof world>>, company: OrgId): Promise<string> => {
  const seam = (await h.root.app.runtimeFor(company)).flow.deps.standingInstructions!;
  return JSON.stringify(await seam.pinContent!("payments", await seam.pin("payments")));
};

it("with the company-rules point NOT mocked: A's start asks the gateway as A only and never holds B's rules; a wrong-company answer stops the start", async () => {
  // Control: each company starts, asking the gateway as itself; the standing block it pins holds only its own rules.
  stubGateway();
  const h = await world();
  const answerA = await h.start(personA);
  expect(answerA?.statusCode, answerA?.body).toBe(200);
  expect(asked).toEqual([A]);
  const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answerA!.body));
  expect(JSON.stringify(await h.w.store.get(taskKey(taskId)))).not.toContain("B-ONLY-RULE");
  const pinA = await pinOf(h, A);
  expect(pinA).toContain("A-ONLY-RULE");
  expect(pinA).not.toContain("B-ONLY-RULE");
  expect(new Set(asked)).toEqual(new Set([A]));
  const answerB = await h.start(personB);
  expect(answerB?.statusCode, answerB?.body).toBe(200);
  const pinB = await pinOf(h, B);
  expect(pinB).toContain("B-ONLY-RULE");
  expect(pinB).not.toContain("A-ONLY-RULE");

  // Fails closed: the gateway answers A's ask with company B's name and B's rules. A's start is refused, nothing is stored for it and B's rules are not in the answer.
  asked.length = 0;
  stubGateway((company) => (company === A ? B : company));
  const rows = rowCount(h.w.store);
  const written: string[] = [];
  const update = h.w.store.update.bind(h.w.store);
  h.w.store.update = async (request) => { written.push(`${request.key.pk}/${request.key.sk}`); return update(request); };
  const wrong = await h.start(personA);
  expect(wrong?.statusCode).not.toBe(200);
  expect(wrong?.body).toMatch(/company rules could not be read/iu);
  expect(wrong?.body).not.toContain("B-ONLY-RULE");
  expect(asked).toEqual([A]);
  // The only thing written is A's own refusal record (one new row), which holds none of B's rules.
  expect(written).toHaveLength(1);
  expect(written[0]).toMatch(new RegExp(`^ORG#${A}#AUDIT/EVENT#task\\.start_refused:`, "u"));
  expect(written.join()).not.toContain("B-ONLY-RULE");
  expect(rowCount(h.w.store)).toBe(rows + 1);
});
