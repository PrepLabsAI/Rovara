// DEC 253q (c): the gateway answers Code's eval monthly cap (POST /v1/product/eval/cap; Code's `eval-reservation` adapter's optional
// `monthlyCapMicros()`). 200 only with the token's company, a valid project, and a company budget that has a company monthly cap: the
// answer is min(company monthly cap, project monthly cap). Every "no" is the same fixed 404; a budget that can't be read is 503. Two
// companies never meet, and nothing from the request is echoed.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FixedCapsSource, type CapsSource } from "../../packages/model-gateway/src/caps.js";
import { CompanyBudgetCaps, NO_CAP } from "../../packages/model-gateway/src/company-caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { EVAL_AUTHORITY_AUDIENCE } from "../../packages/model-gateway/src/eval-authority.js";
import {
  answerEvalCap, createEvalCapHandler, EVAL_CAP_AUDIENCE, EVAL_CAP_CONNECTION_MS, EVAL_CAP_BODY_MAX, EVAL_CAP_PATH, EVAL_CAP_PER_MINUTE, EVAL_CAP_TOKEN_KIND, type EvalCapHandlerOptions,
} from "../../packages/model-gateway/src/eval-cap.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, mint, now } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const PROJECT = "web";
const COMPANIES = "cloud-companies";
const CANARY = "CANARY-eval-cap-7f3a";
const secs = now / 1000;

function mintCap(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const body = { iss: ISS, aud: EVAL_CAP_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const verify = () => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, EVAL_CAP_TOKEN_KIND);

const budgets = (company: number | null, project: number | null) => ({ companyMonthlyUsdMicros: company, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: project, taskUsdMicros: null });
/** Cloud's Companies table (the row company-dynamo.ts writes), read through the gateway's own CompanyBudgetCaps. */
function world() {
  const wire = new WireDynamo([COMPANIES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const seed = (cid: string, b: Record<string, unknown>, companyId = cid) => db.put(COMPANIES, { pk: `COMPANY#${cid}`, sk: "SETTINGS", companyId, version: 1, settings: { featureGates: {}, budgets: b } as never });
  const opts: EvalCapHandlerOptions = { verify: verify(), caps: new CompanyBudgetCaps(db, COMPANIES), now: () => now };
  return { wire, seed, opts };
}
const ask = (company: string = A, project: string = PROJECT) => ({ company, project });
async function call(opts: EvalCapHandlerOptions, body: unknown, o: { token?: string | undefined; headers?: Record<string, string>; method?: string; raw?: Buffer } = {}) {
  const bytes = o.raw ?? Buffer.from(JSON.stringify(body));
  const token = "token" in o ? o.token : mintCap();
  return answerEvalCap(opts, {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...o.headers },
    body: (async function* () { yield bytes; })(),
  });
}
const NOT_FOUND = { status: 404, body: { error: { type: "not_found", message: "not found" } } };
const UNAVAILABLE = { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } };
const UNSIGNED = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } };
const INVALID = { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } };
const TOO_LARGE = { status: 413, body: { error: { type: "invalid_request", message: "the request is too large" } } };
const ok = (monthlyCapMicros: number, company = A, project = PROJECT) => ({ status: 200, body: { company, project, monthlyCapMicros } });

describe("the cap: min(company monthly cap, project monthly cap)", () => {
  it("the project cap when it is lower, the company cap when it is lower", async () => {
    const w = world();
    await w.seed(A, budgets(50_000_000, 20_000_000));
    expect(await call(w.opts, ask())).toEqual(ok(20_000_000));
    const v = world();
    await v.seed(A, budgets(5_000_000, 20_000_000));
    expect(await call(v.opts, ask())).toEqual(ok(5_000_000));
  });
  it("a project with no cap of its own is held to the company cap (never NO_CAP)", async () => {
    const w = world();
    await w.seed(A, budgets(7_000_000, null));
    const answer = await call(w.opts, ask());
    expect(answer).toEqual(ok(7_000_000));
    expect((answer.body as { monthlyCapMicros: number }).monthlyCapMicros).not.toBe(NO_CAP);
  });
  it("a zero company cap is a zero cap, not a refusal", async () => {
    const w = world();
    await w.seed(A, budgets(0, null));
    expect(await call(w.opts, ask())).toEqual(ok(0));
  });
  it("the answer is exactly the contract's three members, and the read asked only about the token's company", async () => {
    const w = world();
    await w.seed(A, budgets(9, 4));
    const answer = await call(w.opts, ask());
    expect(Object.keys(answer.body as object).sort()).toEqual(["company", "monthlyCapMicros", "project"]);
    expect(w.wire.calls.filter((c) => c.operation === "GetItem").map((c) => c.keys)).toEqual([[{ pk: `COMPANY#${A}`, sk: "SETTINGS" }], [{ pk: `COMPANY#${A}`, sk: `SPEND_LIMIT#PROJECT#${PROJECT}` }]]);
  });
});

describe("no source: the fixed 404", () => {
  it("no settings row", async () => {
    expect(await call(world().opts, ask())).toEqual(NOT_FOUND);
  });
  it("a null company cap (the backend's all-null default), even with a project cap", async () => {
    const w = world();
    await w.seed(A, budgets(null, 20_000_000));
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("a row under this company's key that names another company", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20), B);
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("a body naming another company than the token, and nothing is read", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20)); await w.seed(B, budgets(60, 30));
    expect(await call(w.opts, ask(B))).toEqual(NOT_FOUND);
    expect(await call(w.opts, ask(A), { token: mintCap({ cid: B }) })).toEqual(NOT_FOUND);
    expect(w.wire.calls.filter((c) => c.operation === "GetItem")).toHaveLength(0);
  });
  it("a project the gateway could never have stored", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    for (const project of ["", "-x", "a/b", "p".repeat(129), "../web"]) expect(await call(w.opts, ask(A, project))).toEqual(NOT_FOUND);
  });
  it("a source answering a value that is not whole", async () => {
    for (const caps of [{}, { task: 1, projectMonth: 1 }, { task: 1, projectMonth: 1.5, companyMonth: 3 }, { task: 1, projectMonth: 2, companyMonth: -1 }, { task: 1, projectMonth: 2, companyMonth: "3" }, null]) {
      const opts: EvalCapHandlerOptions = { verify: verify(), caps: { capsFor: async () => caps as never } };
      expect(await call(opts, ask())).toEqual(NOT_FOUND);
    }
  });
});

describe("two companies", () => {
  it("company A's token reads only A's caps; B's token only B's", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20)); await w.seed(B, budgets(60, 30));
    expect(await call(w.opts, ask(A))).toEqual(ok(20, A));
    expect(await call(w.opts, ask(B), { token: mintCap({ cid: B }) })).toEqual(ok(30, B));
    const asked: string[] = [];
    const spy: CapsSource = { capsFor: async (scope) => { asked.push(scope.cid); return { task: 1, projectMonth: 1, companyMonth: 1 }; } };
    await call({ verify: verify(), caps: spy }, ask(A));
    await call({ verify: verify(), caps: spy }, ask(B));
    expect(asked).toEqual([A]);
  });
});

describe("a failed read", () => {
  it("is 503, and the cause is not echoed", async () => {
    const opts: EvalCapHandlerOptions = { verify: verify(), caps: { capsFor: async () => { throw new Error(`table down ${CANARY}`); } } };
    const answer = await call(opts, ask());
    expect(answer).toEqual(UNAVAILABLE);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
});

describe("the body: exactly the contract", () => {
  it("extra, missing or wrongly typed members are refused, and never echoed", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    const bad: unknown[] = [null, [], "x", 5, { company: A }, { project: PROJECT }, { ...ask(), extra: CANARY }, { ...ask(), monthlyCapMicros: 1 }, { company: 5, project: PROJECT }, { company: A, project: 5 }, { company: A, project: null }];
    for (const body of bad) {
      const answer = await call(w.opts, body);
      expect(answer).toEqual(INVALID);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    for (const answer of [await call(w.opts, ask(A, `${CANARY}/x`)), await call(w.opts, ask(`org_${CANARY}`))]) expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
  it("not JSON, or not declared JSON, is refused", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    expect(await call(w.opts, undefined, { raw: Buffer.from("{\"company\"") })).toEqual(INVALID);
    expect(await call(w.opts, ask(), { headers: { "content-type": "text/plain" } })).toEqual(INVALID);
    expect((await call(w.opts, ask(), { headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
  });
  it("over EVAL_CAP_BODY_MAX, read or declared, is 413; exactly at it is read", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    expect(EVAL_CAP_BODY_MAX).toBe(4_096);
    expect(await call(w.opts, undefined, { raw: Buffer.from(`${JSON.stringify(ask())}${" ".repeat(EVAL_CAP_BODY_MAX)}`) })).toEqual(TOO_LARGE);
    expect(await call(w.opts, ask(), { headers: { "content-length": String(EVAL_CAP_BODY_MAX + 1) } })).toEqual(TOO_LARGE);
    expect((await call(w.opts, undefined, { raw: Buffer.from(JSON.stringify(ask()).padEnd(EVAL_CAP_BODY_MAX, " ")) })).status).toBe(200);
  });
});

describe("the token: the install's task key, this audience", () => {
  it("no token, a key header, a broken token, a task token, another audience (incl. eval authority), issuer or key, expired: 401", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    expect(await call(w.opts, ask(), { token: undefined })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { "x-api-key": mint() } })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { authorization: `Basic ${mintCap()}` } })).toEqual(UNSIGNED);
    for (const token of [
      "x.y.z", mint(), mintCap({ aud: SERVICE_TOKEN_AUDIENCE }), mintCap({ aud: EVAL_AUTHORITY_AUDIENCE }), mintCap({ aud: "rovara-model-gateway" }), mintCap({}, { typ: "rovara-task+jwt" }),
      mintCap({ iss: "https://install-b.example/v1/auth" }), mintCap({}, { kid: "AAAAAAAAAAAAAAAA" }), mintCap({ iat: secs - 600, nbf: secs - 630, exp: secs - 540 }),
      mintCap({ exp: secs + 3600 }), mintCap({ cid: "org_x" }), mintCap({ extra: 1 }), `${mintCap().slice(0, -4)}AAAA`,
    ]) expect(await call(w.opts, ask(), { token })).toEqual(UNSIGNED);
  });
  it("only a POST", async () => {
    expect((await call(world().opts, ask(), { method: "GET" })).status).toBe(405);
  });
});

describe("the HTTP handler", () => {
  class FakeResponse extends EventEmitter {
    statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
    end(bytes?: string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
    text() { return Buffer.concat(this.chunks).toString(); }
  }
  const send = async (handler: ReturnType<typeof createEvalCapHandler>, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: EVAL_CAP_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${mintCap()}` } });
    const res = new FakeResponse();
    await handler(req as never, res as never);
    return res;
  };
  it("writes the answer as JSON, never cached", async () => {
    const w = world();
    await w.seed(A, budgets(50, 20));
    const res = await send(createEvalCapHandler(w.opts), ask());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(JSON.parse(res.text())).toEqual(ok(20).body);
  });
  it("past the per-minute limit: 429, and nothing is read", async () => {
    let reads = 0;
    const caps: CapsSource = { capsFor: async () => { reads++; return new FixedCapsSource({ task: 1, projectMonth: 1, companyMonth: 1 }).capsFor(); } };
    const handler = createEvalCapHandler({ verify: verify(), caps, now: () => now });
    for (let i = 0; i < EVAL_CAP_PER_MINUTE; i++) expect((await send(handler, ask())).statusCode).toBe(200);
    expect((await send(handler, ask())).statusCode).toBe(429);
    expect(reads).toBe(EVAL_CAP_PER_MINUTE);
  });
});

// L4-T3: the one additive member, `connected` (the project's own product key, re-read with the check the authority and the hold make). No new route.
describe("L4-T3: the cap answer says whether the project's AI key is connected", () => {
  const source = (answer: boolean | undefined | Error, seen: Array<{ iss: string; cid: string; pid: string }> = []) => ({
    connected: async (scope: { iss: string; cid: string; pid: string }) => { seen.push(scope); if (answer instanceof Error) throw answer; return answer; },
  });
  it("adds `connected` as the source answers, true or false, beside the same cap", async () => {
    for (const connected of [true, false]) {
      const w = world(); await w.seed(A, budgets(9, 4));
      expect(await call({ ...w.opts, connection: source(connected) }, ask())).toEqual({ status: 200, body: { company: A, project: PROJECT, monthlyCapMicros: 4, connected } });
    }
  });
  it("asks about exactly the token's company and the body's project, under the token's issuer", async () => {
    const w = world(); await w.seed(A, budgets(9, 4)); const seen: Array<{ iss: string; cid: string; pid: string }> = [];
    await call({ ...w.opts, connection: source(true, seen) }, ask());
    expect(seen).toEqual([{ iss: ISS, cid: A, pid: PROJECT }]);
  });
  it("with no connection source the answer is the three members it always was", async () => {
    const w = world(); await w.seed(A, budgets(9, 4));
    expect(Object.keys((await call(w.opts, ask())).body as object).sort()).toEqual(["company", "monthlyCapMicros", "project"]);
  });
  it("a connection that cannot be said (no answer, a fault) is left out, never guessed, and never fails the cap", async () => {
    for (const answer of [undefined, new Error("private store detail")]) {
      const w = world(); await w.seed(A, budgets(9, 4));
      const out = await call({ ...w.opts, connection: source(answer) }, ask());
      expect(out).toEqual(ok(4)); expect(JSON.stringify(out)).not.toContain("private store detail");
    }
  });
  it("a connection read that outlasts its own bound is left out and the cap is still answered (a hung read never costs the cap)", async () => {
    const w = world(); await w.seed(A, budgets(9, 4));
    const hung = { connected: (_scope: unknown, signal: AbortSignal) => new Promise<boolean>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) };
    const started = Date.now();
    expect(await call({ ...w.opts, connection: hung }, ask())).toEqual(ok(4));
    expect(Date.now() - started).toBeLessThan(EVAL_CAP_CONNECTION_MS + 5_000);
  });
  it("a refusal is still the same fixed refusal and the connection is not even read (no budget source, another company's body, a bad project)", async () => {
    const seen: Array<{ iss: string; cid: string; pid: string }> = [];
    expect(await call({ ...world().opts, connection: source(false, seen) }, ask())).toEqual(NOT_FOUND);
    const w = world(); await w.seed(A, budgets(9, 4));
    expect(await call({ ...w.opts, connection: source(false, seen) }, ask(B))).toEqual(NOT_FOUND);
    expect(await call({ ...w.opts, connection: source(false, seen) }, ask(A, "../x"))).toEqual(NOT_FOUND);
    expect(seen).toEqual([]);
  });
  it("is exactly what Code's adapter reads (its CapAnswerSchema, copied from PrepLabsAI/Rovara packages/broker/src/core-host/eval-authority-http.ts): strict, `connected` an optional boolean", async () => {
    const CodeCapAnswer = z.object({ company: z.string().regex(/^org_[0-9a-z]{20}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), monthlyCapMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), connected: z.boolean().optional() }).strict();
    const w = world(); await w.seed(A, budgets(9, 4));
    for (const opts of [w.opts, { ...w.opts, connection: source(true) }, { ...w.opts, connection: source(false) }, { ...w.opts, connection: source(undefined) }]) expect(CodeCapAnswer.safeParse((await call(opts, ask())).body).success).toBe(true);
  });
  it("two companies: company B's token is answered for B only, and A's connection is never asked for B", async () => {
    const w = world(); await w.seed(A, budgets(9, 4)); await w.seed(B, budgets(8, 3));
    const connection = { connected: async (scope: { cid: string }) => scope.cid === A };
    expect(await call({ ...w.opts, connection }, ask(A))).toMatchObject({ status: 200, body: { company: A, connected: true } });
    expect(await call({ ...w.opts, connection }, ask(B), { token: mintCap({ cid: B }) })).toMatchObject({ status: 200, body: { company: B, monthlyCapMicros: 3, connected: false } });
  });
});
