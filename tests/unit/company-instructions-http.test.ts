// L4-HW3c: Code's HTTP adapter for the `company-instructions` plug-in point on a deployed install (the Cloud model gateway's POST /v1/service/company-instructions).
// Cloud keeps the company's approved rules and the gateway reads them for the ONE company in the service token. The adapter answers the asked company's snapshot, an empty
// list as "no rules", and THROWS for anything else (a company with rules never starts a task without them). Size limits and framing stay the core's.
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_POINT_CARDINALITY, TASK_KEY_PURPOSE, type CompanyInstructionsSource, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import {
  COMPANY_INSTRUCTIONS_ADAPTER_NAME, COMPANY_INSTRUCTIONS_AUDIENCE, COMPANY_INSTRUCTIONS_BODY_MAX_BYTES, COMPANY_INSTRUCTIONS_PATH, COMPANY_INSTRUCTIONS_READ_FAILED, companyInstructionsAdapter, companyInstructionsModules,
} from "../../packages/broker/src/core-host/company-instructions-http.js";
import { buildCoreRegistry, type CoreAdapterContext } from "../../packages/broker/src/core-host/registry.js";
import { readCompanyInstructions } from "../../packages/broker/src/core/instructions/company-source.js";

const ORG_A = "org_companyinstr0000000a" as OrgId;
const ORG_B = "org_companyinstr0000000b" as OrgId;
const ISSUER = "https://api.staging.example/v1/auth";
const GATEWAY = "https://gateway.staging.example";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const signing = (overrides: Record<string, unknown> = {}): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig", rovara_purpose: TASK_KEY_PURPOSE, ...overrides }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
const RULES = [{ text: "Never commit secrets.", priority: "required" as const }, { text: "Prefer small pull requests.", priority: "preferred" as const }];
const answer = (overrides: Record<string, unknown> = {}) => ({ company: ORG_A, version: "4", rules: RULES, ...overrides });
const ok = (body: unknown = answer()) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

interface Seen { url: string; init: RequestInit }
function gateway(reply: (seen: Seen) => Response | Promise<Response> = () => ok()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => { const s = { url: String(url), init: init ?? {} }; seen.push(s); return reply(s); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const adapter = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof companyInstructionsAdapter>[0]> = {}) => companyInstructionsAdapter({ gatewayUrl: GATEWAY, issuer: ISSUER, signer: signing(), fetch: fetchImpl, now: () => NOW, timeoutMs: 50, ...extra });
const bodyOf = (s: Seen) => JSON.parse(s.init.body as string) as Record<string, unknown>;
const tokenOf = (s: Seen) => String((s.init.headers as Record<string, string>)["authorization"]).replace(/^Bearer /u, "");
const refused = (source: CompanyInstructionsSource, company: string = ORG_A) => source.current(company).then(() => "answered", (error: unknown) => (error as Error).message);

describe("the company-instructions plug-in point", () => {
  it("is a point of one adapter", () => {
    expect(PLUGIN_POINT_CARDINALITY["company-instructions"]).toBe("one");
  });
});

describe("the request (golden: what Cloud implements)", () => {
  it("is one POST to /v1/service/company-instructions with a bearer service token and exactly {company}", async () => {
    const g = gateway();
    const found = await adapter(g.fetchImpl).current(ORG_A);
    expect(found).toEqual({ version: "4", rules: RULES });
    expect(g.seen).toHaveLength(1);
    const { url, init } = g.seen[0]!;
    expect(COMPANY_INSTRUCTIONS_PATH).toBe("/v1/service/company-instructions");
    expect(url).toBe(`${GATEWAY}/v1/service/company-instructions`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(Object.keys(init.headers as object).sort()).toEqual(["accept", "authorization", "content-type"]);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(bodyOf(g.seen[0]!)).toEqual({ company: ORG_A });
    expect(Object.keys(bodyOf(g.seen[0]!))).toEqual(["company"]);
  });

  it("the token is the task key's service token for this audience and this company, signed RS256", async () => {
    const g = gateway();
    await adapter(g.fetchImpl).current(ORG_A);
    const [header, claims, signature] = tokenOf(g.seen[0]!).split(".") as [string, string, string];
    expect(Buffer.from(header, "base64url").toString()).toBe(JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid: KID }));
    const iat = NOW / 1000;
    expect(COMPANY_INSTRUCTIONS_AUDIENCE).toBe("rovara-model-gateway-company-instructions");
    expect({ ...decode(claims), jti: "<uuid>" }).toEqual({ iss: ISSUER, aud: COMPANY_INSTRUCTIONS_AUDIENCE, jti: "<uuid>", iat, nbf: iat - 30, exp: iat + 60, cid: ORG_A });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("one company's ask never carries the other company's id", async () => {
    const g = gateway((s) => ok(answer({ company: bodyOf(s)["company"], rules: [{ text: `Rule of ${String(bodyOf(s)["company"])}`, priority: "required" }] })));
    const a = adapter(g.fetchImpl);
    expect(JSON.stringify(await a.current(ORG_A))).toContain(`Rule of ${ORG_A}`);
    expect(JSON.stringify(await a.current(ORG_B))).toContain(`Rule of ${ORG_B}`);
    expect(JSON.stringify(g.seen[0])).not.toContain(ORG_B);
    expect(decode(tokenOf(g.seen[1]!).split(".")[1]!)["cid"]).toBe(ORG_B);
    expect(JSON.stringify(g.seen[1])).not.toContain(ORG_A);
  });

  it("a company that is not well formed is refused before anything is signed or sent", async () => {
    const g = gateway();
    const signer = signing();
    const spy = vi.spyOn(signer, "sign");
    const a = adapter(g.fetchImpl, { signer });
    for (const company of ["", "org_x", `${ORG_A}/../x`, 5 as never]) expect(await refused(a, company)).toBe(COMPANY_INSTRUCTIONS_READ_FAILED);
    expect(g.seen).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the accepted answer", () => {
  it("is the snapshot, as copies; the version is Cloud's settings version", async () => {
    const sent = answer();
    const g = gateway(() => ok(sent));
    const found = (await adapter(g.fetchImpl).current(ORG_A))!;
    expect(found).toEqual({ version: "4", rules: RULES });
    expect(found.rules[0]).not.toBe(sent.rules[0]);
  });
  it("an empty list is no rules (undefined), as the laptop's missing file", async () => {
    const g = gateway(() => ok(answer({ version: "0", rules: [] })));
    expect(await adapter(g.fetchImpl).current(ORG_A)).toBeUndefined();
  });
});

describe("anything but the exact answer fails closed: a throw, never 'no rules'", () => {
  const cases: Array<[string, (s: Seen) => Response | Promise<Response>]> = [
    ["the wrong company in the answer", () => ok(answer({ company: ORG_B }))],
    ["a missing company", () => { const rest: Record<string, unknown> = answer(); delete rest["company"]; return ok(rest); }],
    ["a missing version", () => { const rest: Record<string, unknown> = answer(); delete rest["version"]; return ok(rest); }],
    ["a version over 64 characters", () => ok(answer({ version: "9".repeat(65) }))],
    ["a numeric version", () => ok(answer({ version: 4 }))],
    ["a rule with a priority that does not exist", () => ok(answer({ rules: [{ text: "x", priority: "high" }] }))],
    ["a rule with an extra member", () => ok(answer({ rules: [{ text: "x", priority: "required", admin: true }] }))],
    ["rules that are not a list", () => ok(answer({ rules: "Never commit secrets." }))],
    ["an extra member", () => ok({ ...answer(), draft: [] })],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["the gateway's 404 (a gateway without the route is never read as no rules)", () => new Response(JSON.stringify({ error: { type: "not_found", message: "not found" } }), { status: 404 })],
    ["a 503", () => new Response("secret-gateway-detail", { status: 503 })],
    ["a 401", () => new Response("{}", { status: 401 })],
    ["a 201 with a good body", () => new Response(JSON.stringify(answer()), { status: 201 })],
    ["a redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["an oversize body", () => new Response(`${JSON.stringify(answer())}${" ".repeat(COMPANY_INSTRUCTIONS_BODY_MAX_BYTES)}`, { status: 200 })],
    ["a body that declares itself oversize", () => new Response(JSON.stringify(answer()), { status: 200, headers: { "content-length": String(COMPANY_INSTRUCTIONS_BODY_MAX_BYTES + 1) } })],
    ["a fetch that throws", () => { throw new Error("connect ECONNREFUSED gateway.internal:443"); }],
    ["a timeout (a gateway that never answers)", () => new Promise<Response>(() => undefined)],
    ["a body that never ends", () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"company"')); } }), { status: 200 })],
  ];
  for (const [name, reply] of cases) {
    it(name, async () => {
      const g = gateway(reply);
      const said = await refused(adapter(g.fetchImpl));
      // Fixed words only: nothing of the gateway's answer or fault is repeated.
      expect(said).toBe(COMPANY_INSTRUCTIONS_READ_FAILED);
    });
  }

  it("the whole ask is held to one short time, and the request is aborted", async () => {
    let signal: AbortSignal | undefined;
    const g = gateway((s) => { signal = s.init.signal ?? undefined; return new Promise<Response>(() => undefined); });
    const started = Date.now();
    expect(await refused(adapter(g.fetchImpl, { timeoutMs: 30 }))).toBe(COMPANY_INSTRUCTIONS_READ_FAILED);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  it("a signer that fails or is not the task key sends nothing", async () => {
    const g = gateway();
    for (const signer of [signing({ rovara_purpose: "sign-in" }), signing({ kid: "short" }), { publicJwk: async () => { throw new Error("kms down"); }, sign: async () => Buffer.alloc(0) } as TokenSigner]) {
      expect(await refused(adapter(g.fetchImpl, { signer }))).toBe(COMPANY_INSTRUCTIONS_READ_FAILED);
    }
    expect(g.seen).toEqual([]);
  });
});

describe("through the core: the same size limits as the laptop, and a failed read stops the step", () => {
  it("an answer within the limits becomes the company's snapshot", async () => {
    const g = gateway();
    expect(await readCompanyInstructions(adapter(g.fetchImpl), ORG_A)).toEqual({ version: "4", rules: RULES });
  });
  it("no rules is undefined; an over-budget answer is refused with the budget sentence, nothing cut", async () => {
    expect(await readCompanyInstructions(adapter(gateway(() => ok(answer({ rules: [] }))).fetchImpl), ORG_A)).toBeUndefined();
    const many = Array.from({ length: 31 }, (_, i) => ({ text: `rule ${String(i)}`, priority: "required" }));
    await expect(readCompanyInstructions(adapter(gateway(() => ok(answer({ rules: many }))).fetchImpl), ORG_A)).rejects.toThrow(/Company rules exceed the size budget/u);
    await expect(readCompanyInstructions(adapter(gateway(() => ok(answer({ rules: [{ text: "x".repeat(601), priority: "required" }] }))).fetchImpl), ORG_A)).rejects.toThrow(/Company rules exceed the size budget/u);
  });
  it("a gateway that cannot answer refuses the step in the core's words (the task does not start without the company's rules)", async () => {
    for (const reply of [() => new Response("", { status: 503 }), () => new Response("", { status: 404 }), () => new Promise<Response>(() => undefined)]) {
      await expect(readCompanyInstructions(adapter(gateway(reply).fetchImpl), ORG_A)).rejects.toThrow(/The company rules could not be read, so this step did not start/u);
    }
  });
});

describe("turned on by ROVARA_CORE_MODEL_GATEWAY_URL", () => {
  const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: `${GATEWAY}/`, [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5" };
  const tokens = () => ({ signer: taskKeySigner(signing({ rovara_purpose: undefined })), issuer: ISSUER });
  const context = (env: NodeJS.ProcessEnv): CoreAdapterContext => ({ installCompanyId: ORG_A, now: () => new Date(NOW), env, clients: {}, log: () => undefined });

  it("no URL (or a broken one, or no task-token signer) means no adapter, so a deployment without the gateway starts tasks exactly as before", () => {
    expect(companyInstructionsModules({}, tokens)).toEqual([]);
    expect(companyInstructionsModules({ [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-5-5" }, tokens)).toEqual([]);
    expect(companyInstructionsModules({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://gateway.example" }, tokens)).toEqual([]);
    expect(companyInstructionsModules(ENV, undefined)).toEqual([]);
    expect(companyInstructionsModules(ENV, () => undefined)).toEqual([]);
    expect(companyInstructionsModules(ENV, () => ({ signer: tokens().signer, issuer: "" }))).toEqual([]);
  });

  it("with the gateway and the task key, the point holds the HTTP adapter (never the laptop default), which asks the configured gateway", async () => {
    const g = gateway();
    const modules = companyInstructionsModules(ENV, tokens, g.fetchImpl);
    expect(modules.map((m) => [m.point, m.name, m.isDefault])).toEqual([["company-instructions", COMPANY_INSTRUCTIONS_ADAPTER_NAME, undefined]]);
    const registry = await buildCoreRegistry({ modules, context: context(ENV), areas: [] });
    expect(registry.names("company-instructions")).toEqual([COMPANY_INSTRUCTIONS_ADAPTER_NAME]);
    expect(await registry.require("company-instructions").current(ORG_A)).toEqual({ version: "4", rules: RULES });
    expect(g.seen[0]!.url).toBe(`${GATEWAY}/v1/service/company-instructions`);
    expect(decode(tokenOf(g.seen[0]!).split(".")[1]!)).toMatchObject({ iss: ISSUER, aud: COMPANY_INSTRUCTIONS_AUDIENCE, cid: ORG_A });
  });
});
