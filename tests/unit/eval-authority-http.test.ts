// DEC 253k: the `eval-reservation` plug-in point and Code's HTTP adapter for it (the Cloud model gateway's POST /v1/product/eval/authority).
// The gateway is the source of truth for "may this approval spend": its stored approval plus the project's own connected customer key. Anything but a 200 that answers
// exactly the company, project and approver that were asked about, with provider "customer" and connected true, is "spend not approved" (no grant, no hold, no call).
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, PluginConfigSchema, TASK_KEY_PURPOSE, type EvalReservationAdapter, type EvalSpendApprovalRecord, type EvalSpendPlan, type OrgId, type StoredDocument } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import {
  EVAL_AUTHORITY_AUDIENCE, EVAL_AUTHORITY_BODY_MAX_BYTES, EVAL_AUTHORITY_PATH, EVAL_RESERVATION_ADAPTER_NAME, evalAuthorityAdapter, evalReservationModules,
} from "../../packages/broker/src/core-host/eval-authority-http.js";
import { buildCoreRegistry, type CoreAdapterContext } from "../../packages/broker/src/core-host/registry.js";
import { createAdapterRegistry, registerCodeDefaults } from "../../packages/broker/src/ports/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { evalSpendKey } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { boundEvalReservation, createBoundEvalSpendCapabilities } from "../../packages/broker/src/core/setup-agent/eval-reservation.js";
import { evalSpendDigest, evalSpendInputsDigest } from "../../packages/contracts/src/eval-spend.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";

const ORG_A = "org_evalauthority000000a" as OrgId;
const ORG_B = "org_evalauthority000000b" as OrgId;
const PROJECT = "demo";
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const NOW = 1_800_000_000_000;
const APPROVER = { personId: "person-1", provider: "rovara-sign-in", role: "owner" as const, at: "2026-11-16T05:00:00.000Z" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const signing = (overrides: Record<string, unknown> = {}): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE, ...overrides }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
const principal = (overrides: Record<string, unknown> = {}) => ({ companyId: ORG_A, personId: APPROVER.personId, displayName: "Ada", roles: ["owner"], provider: APPROVER.provider, ...overrides });
const answer = (overrides: Record<string, unknown> = {}) => ({ company: ORG_A, project: PROJECT, principal: principal(), provider: "customer", connected: true, ...overrides });
const ok = (body: unknown = answer()) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

interface Seen { url: string; init: RequestInit }
function gateway(reply: (seen: Seen) => Response | Promise<Response> = () => ok()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { const s = { url: String(url), init: init ?? {} }; seen.push(s); return reply(s); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const adapter = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof evalAuthorityAdapter>[0]> = {}) => evalAuthorityAdapter({ gatewayUrl: GATEWAY, issuer: ISSUER, signer: signing(), fetch: fetchImpl, now: () => NOW, timeoutMs: 50, ...extra });
const ask = (a: EvalReservationAdapter, company: string = ORG_A, project = PROJECT, approver = APPROVER) => a.authority({ company, project, approver });
const bodyOf = (s: Seen) => JSON.parse(s.init.body as string) as Record<string, unknown>;
const tokenOf = (s: Seen) => String((s.init.headers as Record<string, string>)["authorization"]).replace(/^Bearer /u, "");

describe("the eval-reservation plug-in point", () => {
  it("is a point of one adapter, and Code registers no default (no adapter: spend not approved)", () => {
    expect(PLUGIN_POINTS).toContain("eval-reservation");
    expect(PLUGIN_POINT_CARDINALITY["eval-reservation"]).toBe("one");
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("eval-reservation")).toEqual([]);
    expect(boundEvalReservation(registry)).toBeUndefined();
  });
  it("the owner's config may name one adapter, never two", () => {
    const entry = (name: string) => ({ point: "eval-reservation", name, module: `@acme/${name}` });
    expect(PluginConfigSchema.safeParse({ version: 1, plugins: [entry("one")] }).success).toBe(true);
    expect(PluginConfigSchema.safeParse({ version: 1, plugins: [entry("one"), entry("two")] }).success).toBe(false);
  });
});

describe("the request (golden: what Cloud implements)", () => {
  it("is one POST to /v1/product/eval/authority with a bearer service token and the asked company, project and approver as its body", async () => {
    const g = gateway();
    const found = await ask(adapter(g.fetchImpl));
    expect(found).toEqual(answer());
    expect(g.seen).toHaveLength(1);
    const { url, init } = g.seen[0]!;
    expect(EVAL_AUTHORITY_PATH).toBe("/v1/product/eval/authority");
    expect(url).toBe(`${GATEWAY}/v1/product/eval/authority`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(Object.keys(init.headers as object).sort()).toEqual(["accept", "authorization", "content-type"]);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(bodyOf(g.seen[0]!)).toEqual({ company: ORG_A, project: PROJECT, approver: { personId: APPROVER.personId, provider: APPROVER.provider } });
    expect(Object.keys(bodyOf(g.seen[0]!))).toEqual(["company", "project", "approver"]);
  });

  it("the token is the task key's service token for this audience and this company, signed RS256", async () => {
    const g = gateway();
    await ask(adapter(g.fetchImpl));
    const [header, claims, signature] = tokenOf(g.seen[0]!).split(".") as [string, string, string];
    expect(Buffer.from(header, "base64url").toString()).toBe(JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid: KID }));
    const body = decode(claims);
    const iat = NOW / 1000;
    expect(EVAL_AUTHORITY_AUDIENCE).toBe("rovara-model-gateway-eval-authority");
    expect({ ...body, jti: "<uuid>" }).toEqual({ iss: ISSUER, aud: EVAL_AUTHORITY_AUDIENCE, jti: "<uuid>", iat, nbf: iat - 30, exp: iat + 60, cid: ORG_A });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("one company's ask never carries the other company's id", async () => {
    const g = gateway((s) => ok(answer({ company: bodyOf(s)["company"], principal: principal({ companyId: bodyOf(s)["company"] }) })));
    const a = adapter(g.fetchImpl);
    expect(await ask(a, ORG_A)).toMatchObject({ company: ORG_A });
    expect(await ask(a, ORG_B)).toMatchObject({ company: ORG_B });
    expect(JSON.stringify(g.seen[0])).not.toContain(ORG_B);
    expect(decode(tokenOf(g.seen[1]!).split(".")[1]!)["cid"]).toBe(ORG_B);
    expect(JSON.stringify(g.seen[1])).not.toContain(ORG_A);
  });

  it("a company, project or approver that is not well formed is refused before anything is signed or sent", async () => {
    const g = gateway();
    const signer = signing();
    const spy = vi.spyOn(signer, "sign");
    const a = adapter(g.fetchImpl, { signer });
    for (const company of ["", "org_x", `${ORG_A}/../x`, 5 as never]) expect(await ask(a, company)).toBeUndefined();
    for (const project of ["", "../x", "a b", "x".repeat(200), 5 as never]) expect(await ask(a, ORG_A, project)).toBeUndefined();
    for (const approver of [{ ...APPROVER, personId: "" }, { ...APPROVER, provider: "" }, { ...APPROVER, personId: 5 }, undefined, null]) expect(await a.authority({ company: ORG_A, project: PROJECT, approver: approver as never })).toBeUndefined();
    expect(g.seen).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reserve() holds nothing here: the worker takes the hold through the gateway's own /hold route", async () => {
    const g = gateway();
    expect(await adapter(g.fetchImpl).reserve({ approval: {} as EvalSpendApprovalRecord, calls: 1, costMicros: 1, revalidate: async () => true })).toBeUndefined();
    expect(g.seen).toEqual([]);
  });
});

describe("the accepted answer", () => {
  it("passes the principal's optional sign-in facts through as copies", async () => {
    const sent = principal({ authTime: "2026-11-16T05:00:00.000Z", methods: ["password"] });
    const g = gateway(() => ok(answer({ principal: sent })));
    const found = (await ask(adapter(g.fetchImpl)))!;
    expect(found.principal).toEqual(sent);
    expect(found.principal.roles).not.toBe(sent.roles);
  });
});

describe("anything but the exact answer is spend not approved (fail closed)", () => {
  const cases: Array<[string, (s: Seen) => Response | Promise<Response>]> = [
    ["not connected", () => ok(answer({ connected: false }))],
    ["connected missing", () => { const rest: Record<string, unknown> = answer(); delete rest["connected"]; return ok(rest); }],
    ["connected as a string", () => ok(answer({ connected: "true" }))],
    ["a Rovara-paid provider", () => ok(answer({ provider: "rovara" }))],
    ["provider missing", () => { const rest: Record<string, unknown> = answer(); delete rest["provider"]; return ok(rest); }],
    ["the wrong company in the answer", () => ok(answer({ company: ORG_B }))],
    ["the wrong company in the principal", () => ok(answer({ principal: principal({ companyId: ORG_B }) }))],
    ["the wrong project", () => ok(answer({ project: "other" }))],
    ["another person", () => ok(answer({ principal: principal({ personId: "person-2" }) }))],
    ["another identity provider", () => ok(answer({ principal: principal({ provider: "other-sign-in" }) }))],
    ["an extra member", () => ok({ ...answer(), payer: "rovara" })],
    ["an extra principal member", () => ok(answer({ principal: { ...principal(), admin: true } }))],
    ["a principal that is not an object", () => ok(answer({ principal: "person-1" }))],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["a 500", () => new Response("secret-gateway-detail", { status: 500 })],
    ["a 403", () => new Response("{}", { status: 403 })],
    ["a 201 with a good body", () => new Response(JSON.stringify(answer()), { status: 201 })],
    ["a redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["an oversize body", () => new Response(`${JSON.stringify(answer())}${" ".repeat(EVAL_AUTHORITY_BODY_MAX_BYTES)}`, { status: 200 })],
    ["a body that declares itself oversize", () => new Response(JSON.stringify(answer()), { status: 200, headers: { "content-length": String(EVAL_AUTHORITY_BODY_MAX_BYTES + 1) } })],
    ["a fetch that throws", () => { throw new Error("connect ECONNREFUSED gateway.internal:443"); }],
    ["a timeout (a gateway that never answers)", () => new Promise<Response>(() => undefined)],
    ["a body that never ends", () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"company"')); } }), { status: 200 })],
  ];
  for (const [name, reply] of cases) {
    it(name, async () => {
      const g = gateway(reply);
      expect(await ask(adapter(g.fetchImpl))).toBeUndefined();
    });
  }

  it("the whole ask is held to one short time, and the request is aborted", async () => {
    let signal: AbortSignal | undefined;
    const g = gateway((s) => { signal = s.init.signal ?? undefined; return new Promise<Response>(() => undefined); });
    const started = Date.now();
    expect(await ask(adapter(g.fetchImpl, { timeoutMs: 30 }))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  it("a signer that fails or is not the task key sends nothing", async () => {
    const g = gateway();
    for (const signer of [signing({ rovara_purpose: "sign-in" }), signing({ kid: "short" }), { publicJwk: async () => { throw new Error("kms down"); }, sign: async () => Buffer.alloc(0) } as TokenSigner]) {
      expect(await ask(adapter(g.fetchImpl, { signer }))).toBeUndefined();
    }
    expect(g.seen).toEqual([]);
  });
});

describe("turned on by ROVARA_CORE_MODEL_GATEWAY_URL", () => {
  const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: `${GATEWAY}/`, [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5" };
  const tokens = () => ({ signer: taskKeySigner(signing({ rovara_purpose: undefined })), issuer: ISSUER });
  const context = (env: NodeJS.ProcessEnv): CoreAdapterContext => ({ installCompanyId: ORG_A, now: () => new Date(NOW), env, clients: {}, log: () => undefined });

  it("no URL (or a broken one, or no task-token signer) means no adapter", () => {
    expect(evalReservationModules({}, tokens)).toEqual([]);
    expect(evalReservationModules({ [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5" }, tokens)).toEqual([]);
    expect(evalReservationModules({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.example" }, tokens)).toEqual([]);
    expect(evalReservationModules(ENV, undefined)).toEqual([]);
    expect(evalReservationModules(ENV, () => undefined)).toEqual([]);
    expect(evalReservationModules(ENV, () => ({ signer: tokens().signer, issuer: "" }))).toEqual([]);
  });

  it("with the gateway and the task key, the point holds the HTTP adapter, which asks the configured gateway", async () => {
    const g = gateway();
    const modules = evalReservationModules(ENV, tokens, g.fetchImpl);
    expect(modules.map((m) => [m.point, m.name])).toEqual([["eval-reservation", EVAL_RESERVATION_ADAPTER_NAME]]);
    const registry = await buildCoreRegistry({ modules, context: context(ENV), areas: [] });
    const bound = boundEvalReservation(registry)!;
    expect(bound).toBeDefined();
    expect(await ask(bound)).toEqual(answer());
    expect(g.seen[0]!.url).toBe(`${GATEWAY}/v1/product/eval/authority`);
    expect(decode(tokenOf(g.seen[0]!).split(".")[1]!)).toMatchObject({ iss: ISSUER, aud: EVAL_AUTHORITY_AUDIENCE, cid: ORG_A });
  });
});

describe("createEvalSpendCapabilities through the bound adapter", () => {
  const inputs = { evalSetHash: "a".repeat(64), judgePin: "b".repeat(64), modelVersion: "v1", model: "model", catalogRowId: "model", commandFingerprint: "c".repeat(64), settingsFingerprint: "d".repeat(64) };
  const plan: EvalSpendPlan = { selection: "evals/demo", inputs, estimate: { calls: 6, costMicros: 60 }, budget: { usual: { calls: 6, costMicros: 60 }, maximum: { calls: 400, costMicros: 4_000_000 } } };
  const members: SessionMembers = { companyRole: (p) => p.companyId === ORG_A ? "owner" : undefined, projectGrant: () => undefined };
  async function seeded(company: OrgId = ORG_A) {
    const store = new MemoryDocumentStore();
    const row: EvalSpendApprovalRecord = { entityType: "EVAL_SPEND_APPROVAL", schemaVersion: 1, company, project: PROJECT, revision: 1, digest: evalSpendDigest(company, PROJECT, plan), inputsDigest: evalSpendInputsDigest(inputs), plan, state: "approved", approvedBy: APPROVER };
    await store.put({ item: { ...evalSpendKey(company, PROJECT), ...row } as unknown as StoredDocument });
    return store;
  }
  const registryWith = (bound?: EvalReservationAdapter) => {
    const registry = createAdapterRegistry();
    if (bound !== undefined) registry.register("eval-reservation", "http", bound);
    return registry;
  };

  it("approved: the gateway's yes is a customer grant for this company and project", async () => {
    const g = gateway();
    const caps = createBoundEvalSpendCapabilities(registryWith(adapter(g.fetchImpl)), { store: await seeded(), companyId: ORG_A, members, project: PROJECT, current: async () => plan });
    expect(await caps.approval.read()).toMatchObject({ company: ORG_A, project: PROJECT, provider: "customer", connected: true, role: "owner" });
    expect(g.seen).toHaveLength(1);
  });

  it("with the HTTP adapter bound, the broker-side meter holds nothing and never asks the gateway for a hold", async () => {
    const g = gateway();
    const caps = createBoundEvalSpendCapabilities(registryWith(adapter(g.fetchImpl)), { store: await seeded(), companyId: ORG_A, members, project: PROJECT, current: async () => plan });
    const grant = (await caps.approval.read())!;
    expect(grant).toBeDefined();
    expect(await caps.meter.reserve({ approval: grant, calls: 1, costMicros: 1 })).toBeUndefined();
    expect(g.seen.every((s) => s.url === `${GATEWAY}${EVAL_AUTHORITY_PATH}`)).toBe(true);
  });

  it("boundEvalReservation: a registry that cannot say, or names two, binds nothing", () => {
    const one: EvalReservationAdapter = { authority: async () => undefined, reserve: async () => undefined };
    expect(boundEvalReservation({ names: () => { throw new Error("broken"); }, get: () => one as never })).toBeUndefined();
    expect(boundEvalReservation({ names: () => ["a", "b"], get: () => one as never })).toBeUndefined();
    expect(boundEvalReservation({ names: () => ["a"], get: () => one as never })).toBe(one);
  });

  it("no bound adapter (Code's default): spend not approved, and the gateway is never asked", async () => {
    const caps = createBoundEvalSpendCapabilities(registryWith(), { store: await seeded(), companyId: ORG_A, members, project: PROJECT, current: async () => plan });
    expect(await caps.approval.read()).toBeUndefined();
  });

  it("a caller cannot slip its own adapter past the registry", async () => {
    const yes: EvalReservationAdapter = { authority: async () => ({ company: ORG_A, project: PROJECT, principal: principal(), provider: "customer", connected: true }), reserve: async () => undefined };
    const withOwn = { store: await seeded(), companyId: ORG_A, members, project: PROJECT, current: async () => plan, adapter: yes };
    const caps = createBoundEvalSpendCapabilities(registryWith(), withOwn);
    expect(await caps.approval.read()).toBeUndefined();
  });

  for (const [name, reply] of [["not connected", () => ok(answer({ connected: false }))], ["wrong company", () => ok(answer({ company: ORG_B }))], ["wrong project", () => ok(answer({ project: "other" }))], ["a 500", () => new Response("", { status: 500 })]] as const) {
    it(`${name}: no grant`, async () => {
      const g = gateway(reply);
      const caps = createBoundEvalSpendCapabilities(registryWith(adapter(g.fetchImpl)), { store: await seeded(), companyId: ORG_A, members, project: PROJECT, current: async () => plan });
      expect(await caps.approval.read()).toBeUndefined();
    });
  }

  it("two companies: company B's capabilities never read company A's approval nor ask about it", async () => {
    const g = gateway();
    const caps = createBoundEvalSpendCapabilities(registryWith(adapter(g.fetchImpl)), { store: await seeded(ORG_A), companyId: ORG_B, members, project: PROJECT, current: async () => plan });
    expect(await caps.approval.read()).toBeUndefined();
    expect(g.seen).toEqual([]);
  });
});
