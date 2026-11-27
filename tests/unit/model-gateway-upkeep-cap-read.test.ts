// L4-CAPR (lead 4): the gateway's signed read of one project's nightly-upkeep cap (GET /v1/service/companies/<company>/upkeep/<project>), which Code's nightly
// wiki refresh (Code #978) needs before it may start AI by itself. The core rules: the token is verified like the offered-models token (audience, issuer, key pin,
// expiry, life), the path's company must be the token's company, the project is the path's own name, `enforced: true` appears ONLY in a 200 built from the limit the
// agent route enforces and the meter's own upkeep row, and anything that does not read is 503. Two companies never meet, and nothing from the request is echoed.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CompanyUpkeepLimits } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_SPEND_LIMITS, GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { EVAL_CAP_AUDIENCE } from "../../packages/model-gateway/src/eval-cap.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import type { Meter, MeterScope } from "../../packages/model-gateway/src/meter.js";
import { SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { UPKEEP_DEFAULT_MONTH_MICROS, type UpkeepLimits } from "../../packages/model-gateway/src/upkeep-cap.js";
import {
  answerUpkeepCapRead, createUpkeepCapReadHandler, UPKEEP_CAP_READ_AUDIENCE, UPKEEP_CAP_READ_PER_MINUTE, UPKEEP_CAP_READ_TOKEN_KIND, type UpkeepCapReadHandlerOptions,
} from "../../packages/model-gateway/src/upkeep-cap-read.js";
import { answer, claims, jwk, keys, kid, mint, now } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

// ---- Code's contract, copied from PrepLabsAI/Rovara-Code PR #978 (packages/contracts/src/upkeep.ts at a53f17315) ---------------------------------------------------
const CodeUpkeepCapReadSchema = z.object({
  version: z.literal(1), company: z.string().regex(/^org_[0-9a-z]{20}$/), project: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u), enforced: z.literal(true),
  limitMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), spentMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const CODE_AUDIENCE = "rovara-model-gateway-upkeep-cap";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const secs = now / 1000;
const MONTH = "2027-01"; // `now` is 2027-01-15
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const SPEND_KIND = GATEWAY_COMPANY_SPEND_LIMITS.kinds.find((k) => k.kind === "upkeep_month")!;
const item = (company: string, project: string, micros: unknown, more: Record<string, unknown> = {}) => ({ pk: `COMPANY#${company}`, sk: `${SPEND_KIND.sortPrefix}${project}`, companyId: company, kind: "upkeep_month", id: project, monthlyUsdMicros: micros as number, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: "d".repeat(64), ...more });

function mintRead(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer = keys.privateKey): string {
  const body = { iss: ISS, aud: UPKEEP_CAP_READ_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), signer).toString("base64url")}`;
}
const verify = (clock: () => number = () => now) => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: clock }, UPKEEP_CAP_READ_TOKEN_KIND);

/** Cloud's Companies table (the upkeep_month items Cloud writes) read through the gateway's own CompanyUpkeepLimits, and the agent meter, on the wire. */
function world(clock: () => number = () => now) {
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const meter = new DynamoMeter({ db, tables: TABLES, now: clock });
  const limits: UpkeepLimits & { asked: string[] } = Object.assign(new CompanyUpkeepLimits(db, TABLES.companies), { asked: [] as string[] });
  const real = limits.limitFor.bind(limits);
  limits.limitFor = async (cid, pid, signal) => { limits.asked.push(`${cid}/${pid}`); return real(cid, pid, signal); };
  const reads: MeterScope[] = [];
  const spy: Pick<Meter, "read"> = { read: async (scope, options) => { reads.push(scope); return meter.read(scope, options); } };
  const opts: UpkeepCapReadHandlerOptions = { verify: verify(clock), limits, meter: spy, now: clock };
  const setLimit = (company: string, project: string, micros: unknown, more: Record<string, unknown> = {}) => db.put(TABLES.companies, item(company, project, micros, more));
  /** A settled nightly call: held to the upkeep row, so the upkeep row (and project and company rows) count it. */
  const spend = async (company: string, project: string, micros: number) => {
    const scope: MeterScope = { iss: ISS, cid: company, pid: project, tid: "task_1" };
    const held = await meter.reserve({ scope, caps: { task: 1e12, projectMonth: 1e12, companyMonth: 1e12, upkeepMonth: 1e12 }, estimateMicros: micros });
    if (!held.ok) throw new Error("not held");
    await meter.settle(held.reservation, micros);
  };
  return { wire, db, meter, limits, reads, opts, setLimit, spend };
}
const pathOf = (company: string, project: string) => `/v1/service/companies/${company}/upkeep/${project}`;
async function get(opts: UpkeepCapReadHandlerOptions, url: string, token: string | null = mintRead(), o: { headers?: Record<string, string>; method?: string } = {}) {
  return answerUpkeepCapRead(opts, { method: o.method ?? "GET", url, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...o.headers } });
}
const UNSIGNED = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } };
const NOT_FOUND = { status: 404, body: { error: { type: "not_found", message: "not found" } } };
const UNAVAILABLE = { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } };
const ok = (limitMicros: number, spentMicros: number, company = A, project = "web") => ({ status: 200, body: { version: 1, company, project, month: MONTH, enforced: true, limitMicros, spentMicros } });

describe("the answer: the limit the agent route enforces and the meter's own upkeep spend", () => {
  it("the project's own upkeep_month item, with what finished upkeep calls spent this month", async () => {
    const w = world(); await w.setLimit(A, "web", 40_000_000); await w.spend(A, "web", 7_500_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(40_000_000, 7_500_000));
  });
  it("no item: the default the agent route enforces for a project with none (never 'not enforced')", async () => {
    const w = world();
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(UPKEEP_DEFAULT_MONTH_MICROS, 0));
  });
  it("a $0 item is an enforced limit of 0, not a refusal and not the default", async () => {
    const w = world(); await w.setLimit(A, "web", 0);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(0, 0));
  });
  it("a used-up limit states spent at or above the limit", async () => {
    const w = world(); await w.setLimit(A, "web", 5_000_000); await w.spend(A, "web", 5_000_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(5_000_000, 5_000_000));
  });
  it("only attended spend is not upkeep spend: a project row of another kind never counts (spent comes from the upkeep row)", async () => {
    const w = world();
    const scope: MeterScope = { iss: ISS, cid: A, pid: "web", tid: "task_1" };
    const held = await w.meter.reserve({ scope, caps: { task: 1e12, projectMonth: 1e12, companyMonth: 1e12 }, estimateMicros: 3_000_000 }); // no upkeepMonth: attended work
    if (!held.ok) throw new Error("not held"); await w.meter.settle(held.reservation, 3_000_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(UPKEEP_DEFAULT_MONTH_MICROS, 0));
  });
  it("an open hold is not spend: spentMicros is the settled amount only (the row's spentMicros, never committed)", async () => {
    const w = world(); await w.setLimit(A, "web", 50_000_000);
    const held = await w.meter.reserve({ scope: { iss: ISS, cid: A, pid: "web", tid: "task_1" }, caps: { task: 1e12, projectMonth: 1e12, companyMonth: 1e12, upkeepMonth: 50_000_000 }, estimateMicros: 9_000_000 });
    expect(held.ok).toBe(true);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(50_000_000, 0));
  });
  it("Code's schema parses the answer, and the answer is exactly its seven members", async () => {
    const w = world(); await w.setLimit(A, "web", 12_345_678); await w.spend(A, "web", 1_000_001);
    const got = await get(w.opts, pathOf(A, "web"));
    expect(got.status).toBe(200);
    expect(CodeUpkeepCapReadSchema.safeParse(JSON.parse(JSON.stringify(got.body))).success).toBe(true);
    expect(Object.keys(got.body as object)).toEqual(["version", "company", "project", "month", "enforced", "limitMicros", "spentMicros"]);
    expect(CODE_AUDIENCE).toBe(UPKEEP_CAP_READ_AUDIENCE);
  });
  it("is exact and fresh on every call, never cached: a later spend and a changed limit show in the very next read (room = limit - spent is current)", async () => {
    const w = world(); await w.setLimit(A, "web", 10_000_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(10_000_000, 0));
    await w.spend(A, "web", 2_000_001);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(10_000_000, 2_000_001));
    await w.spend(A, "web", 1_999_999);
    await w.setLimit(A, "web", 6_000_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(6_000_000, 4_000_000));
    await w.setLimit(A, "web", 0);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(0, 4_000_000));
  });
  it("the month is the UTC month of the gateway's clock", async () => {
    let t = Date.UTC(2027, 1, 1, 0, 0, 0);
    const w = world(() => t);
    expect((await get(w.opts, pathOf(A, "web"), mintRead({ iat: t / 1000, nbf: t / 1000 - 30, exp: t / 1000 + 60 }))).body).toMatchObject({ month: "2027-02" });
    t = Date.UTC(2027, 0, 31, 23, 59, 59);
    expect((await get(w.opts, pathOf(A, "web"), mintRead({ iat: t / 1000, nbf: t / 1000 - 30, exp: t / 1000 + 60 }))).body).toMatchObject({ month: "2027-01" });
  });
  it("a spend counted in January is not this month's spend in February", async () => {
    let t = Date.UTC(2027, 0, 20); const w = world(() => t);
    await w.setLimit(A, "web", 9_000_000); await w.spend(A, "web", 4_000_000);
    t = Date.UTC(2027, 1, 2);
    const token = mintRead({ iat: t / 1000, nbf: t / 1000 - 30, exp: t / 1000 + 60 });
    expect(await get(w.opts, pathOf(A, "web"), token)).toMatchObject({ status: 200, body: { month: "2027-02", limitMicros: 9_000_000, spentMicros: 0 } });
  });
});

describe("unreadable is 503, never enforced: true", () => {
  it("a limit item that does not read (another company's, another kind's, another project's, a bad amount, a missing version) is 503 and no meter read follows", async () => {
    const bad: Array<[string, Record<string, unknown>, unknown]> = [
      ["another company's item", { companyId: B }, 1_000_000], ["another kind", { kind: "answers_month" }, 1_000_000], ["another project's id", { id: "api" }, 1_000_000],
      ["a negative amount", {}, -1], ["a string amount", {}, "1000000"], ["no version", { version: 0 }, 1_000_000], ["an amount over the budget maximum", {}, GATEWAY_COMPANY_BUDGET_MAX + 1],
    ];
    for (const [name, more, micros] of bad) {
      const w = world(); await w.setLimit(A, "web", micros, more);
      const got = await get(w.opts, pathOf(A, "web"));
      expect(got, name).toEqual(UNAVAILABLE);
      expect(w.reads, name).toEqual([]);
    }
  });
  it("a failed limit read is 503 (the table is down), and says nothing of why", async () => {
    const w = world();
    w.opts.limits = { limitFor: async () => { throw new Error("CANARY table down"); } };
    const got = await get(w.opts, pathOf(A, "web"));
    expect(got).toEqual(UNAVAILABLE);
    expect(JSON.stringify(got)).not.toContain("CANARY");
  });
  it("a limit that is not a whole number of micro-dollars is 503 (a source that answers 1.5, NaN, a negative or an unsafe number)", async () => {
    for (const amount of [1.5, Number.NaN, -1, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      const w = world();
      w.opts.limits = { limitFor: async () => amount };
      expect(await get(w.opts, pathOf(A, "web")), String(amount)).toEqual(UNAVAILABLE);
    }
  });
  it("a failed meter read is 503", async () => {
    const w = world(); await w.setLimit(A, "web", 1_000_000);
    w.opts.meter = { read: async () => { throw new Error("CANARY meter down"); } };
    const got = await get(w.opts, pathOf(A, "web"));
    expect(got).toEqual(UNAVAILABLE);
    expect(JSON.stringify(got)).not.toContain("CANARY");
  });
  it("a meter that answers no upkeep row, another company's row, another item's row or a spend that is not whole is 503 (never a zero)", async () => {
    const row = (over: Record<string, unknown>) => ({ item: "upkeep", company: A, spentMicros: 5, estimatedMicros: 0, reservedMicros: 0, committed: 5, overrun: false, ...over });
    const variants: Array<[string, unknown[]]> = [
      ["no rows", []], ["no upkeep row", [row({ item: "project" })]], ["another company's row", [row({ company: B })]],
      ["a fractional spend", [row({ spentMicros: 0.5 })]], ["a negative spend", [row({ spentMicros: -1 })]], ["a missing spend", [row({ spentMicros: undefined })]], ["a string spend", [row({ spentMicros: "5" })]],
    ];
    for (const [name, rows] of variants) {
      const w = world();
      w.opts.meter = { read: async () => rows as never };
      expect(await get(w.opts, pathOf(A, "web")), name).toEqual(UNAVAILABLE);
    }
  });
  it("a month that changed while reading is 503 (the meter's rows may be last month's)", async () => {
    let t = Date.UTC(2027, 0, 31, 23, 59, 59, 900);
    const w = world(() => t);
    const meter = w.opts.meter;
    w.opts.meter = { read: async (scope, options) => { const rows = await meter.read(scope, options); t = Date.UTC(2027, 1, 1, 0, 0, 0, 100); return rows; } };
    expect(await get(w.opts, pathOf(A, "web"), mintRead({ iat: Date.UTC(2027, 0, 31, 23, 59, 59) / 1000, nbf: Date.UTC(2027, 0, 31, 23, 59, 59) / 1000 - 30, exp: Date.UTC(2027, 0, 31, 23, 59, 59) / 1000 + 60 }))).toEqual(UNAVAILABLE);
  });
  it("no failure answer ever carries `enforced`", async () => {
    const w = world();
    for (const got of [await get(w.opts, pathOf(A, "web"), null), await get(w.opts, pathOf(B, "web")), await get(w.opts, "/v1/service/companies/x/upkeep/web"), await get(w.opts, pathOf(A, "web"), mintRead(), { method: "POST" })]) {
      expect(JSON.stringify(got.body)).not.toContain("enforced");
      expect(got.status).not.toBe(200);
    }
  });
});

describe("the service token", () => {
  const refused = async (w: ReturnType<typeof world>, token: string | null, o: { headers?: Record<string, string> } = {}, url = pathOf(A, "web")) => {
    expect(await get(w.opts, url, token, o)).toEqual(UNSIGNED);
    // Nothing was read for a refused call: no limit, no meter row.
    expect(w.limits.asked).toEqual([]); expect(w.reads).toEqual([]);
  };
  it("the good token is accepted (control for every refusal below)", async () => {
    const w = world(); expect((await get(w.opts, pathOf(A, "web"))).status).toBe(200);
  });
  it("refuses a token of another audience: the offered-models token, the eval cap token, a task token and a made-up audience", async () => {
    const w = world();
    await refused(w, mintRead({ aud: SERVICE_TOKEN_AUDIENCE }));
    await refused(w, mintRead({ aud: EVAL_CAP_AUDIENCE }));
    await refused(w, mintRead({ aud: "rovara-model-gateway" }));
    await refused(w, mintRead({ aud: "rovara-model-gateway-upkeep" }));
    await refused(w, mint());
  });
  it("refuses a token whose company is not the path's company (and reads nothing for either)", async () => {
    const w = world(); await w.setLimit(A, "web", 1_000_000); await w.setLimit(B, "web", 2_000_000);
    await refused(w, mintRead({ cid: B }), {}, pathOf(A, "web"));
    await refused(w, mintRead({ cid: A }), {}, pathOf(B, "web"));
  });
  it("refuses an expired token, a token not yet valid, and one that lives longer than 60 seconds", async () => {
    const w = world();
    await refused(w, mintRead({ iat: secs - 200, nbf: secs - 230, exp: secs - 100 }));
    await refused(w, mintRead({ iat: secs + 300, nbf: secs + 270, exp: secs + 360 }));
    await refused(w, mintRead({ iat: secs, nbf: secs - 30, exp: secs + 61 }));
    await refused(w, mintRead({ iat: secs - 120, nbf: secs - 150, exp: secs + 30 }));
  });
  it("refuses a token signed by another key, with another key id or another header type, an unsigned one, and a malformed one", async () => {
    const w = world();
    const other = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 });
    await refused(w, mintRead({}, {}, other.privateKey));
    await refused(w, mintRead({}, { kid: "AAAAAAAAAAAAAAAA" }));
    await refused(w, mintRead({}, { typ: "JWT" }));
    await refused(w, mintRead({}, { alg: "none" }));
    await refused(w, mintRead({ iss: "https://other-install.example/v1/auth" }));
    await refused(w, `${mintRead().split(".").slice(0, 2).join(".")}.`);
    await refused(w, "not a token");
    await refused(w, null);
  });
  it("refuses a token with an extra claim, a missing claim, or a company id of the wrong shape", async () => {
    const w = world();
    await refused(w, mintRead({ pid: "web" }));
    await refused(w, mintRead({ cid: undefined }));
    await refused(w, mintRead({ cid: "org_short" }));
    await refused(w, mintRead({ jti: "not-a-uuid" }));
  });
  it("refuses a call that also sends an x-api-key, a non-Bearer authorization and an empty one", async () => {
    const w = world();
    await refused(w, mintRead(), { headers: { "x-api-key": "k" } });
    expect(await get(w.opts, pathOf(A, "web"), null, { headers: { authorization: `Basic ${mintRead()}` } })).toEqual(UNSIGNED);
    expect(await get(w.opts, pathOf(A, "web"), "")).toEqual(UNSIGNED);
  });
  it("the verifier accepts the contract's token only: exact claims, typ rovara-service+jwt, at most 60 seconds", () => {
    expect(UPKEEP_CAP_READ_TOKEN_KIND.typ).toBe("rovara-service+jwt");
    expect(UPKEEP_CAP_READ_TOKEN_KIND.maxSeconds).toBe(60);
  });
});

describe("path, method and project scope", () => {
  it("only a project name of Code's own pattern is a route; every other shape is the fixed 404 and reads nothing", async () => {
    const w = world();
    for (const project of ["Web", "-web", "1web", "web_x", "a".repeat(64), "web%2F..", "web/extra", ""]) expect(await get(w.opts, pathOf(A, project)), project).toEqual(NOT_FOUND);
    expect(await get(w.opts, `${pathOf(A, "web")}?month=2026-01`)).toEqual(NOT_FOUND);
    expect(await get(w.opts, `${pathOf(A, "web")}/`)).toEqual(NOT_FOUND);
    expect(await get(w.opts, "/v1/service/companies/org_short/upkeep/web")).toEqual(NOT_FOUND);
    expect(w.limits.asked).toEqual([]); expect(w.reads).toEqual([]);
  });
  it("a 63-character project name is a route", async () => {
    const w = world(); expect((await get(w.opts, pathOf(A, "a".repeat(63)))).status).toBe(200);
  });
  it("only GET: any other method is the fixed 405 body, and reads nothing", async () => {
    const w = world();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) expect(await get(w.opts, pathOf(A, "web"), mintRead(), { method }), method).toEqual({ status: 405, body: NOT_FOUND.body });
    expect(w.limits.asked).toEqual([]);
  });
  it("one project's limit and spend never answer for another project", async () => {
    const w = world(); await w.setLimit(A, "web", 1_000_000); await w.setLimit(A, "api", 8_000_000);
    await w.spend(A, "web", 600_000); await w.spend(A, "api", 7_000_000);
    expect(await get(w.opts, pathOf(A, "web"))).toEqual(ok(1_000_000, 600_000, A, "web"));
    expect(await get(w.opts, pathOf(A, "api"))).toEqual(ok(8_000_000, 7_000_000, A, "api"));
    expect(await get(w.opts, pathOf(A, "other"))).toEqual(ok(UPKEEP_DEFAULT_MONTH_MICROS, 0, A, "other"));
  });
  it("reads exactly the token's company and the path's project, nothing else", async () => {
    const w = world();
    await get(w.opts, pathOf(A, "web"));
    expect(w.limits.asked).toEqual([`${A}/web`]);
    expect(w.reads.map((r) => [r.iss, r.cid, r.pid])).toEqual([[ISS, A, "web"]]);
  });
});

describe("two companies never meet", () => {
  it("each company's token reads its own limit and its own spend for the same project name", async () => {
    const w = world();
    await w.setLimit(A, "web", 11_000_000); await w.setLimit(B, "web", 22_000_000);
    await w.spend(A, "web", 1_100_000); await w.spend(B, "web", 2_200_000);
    expect(await get(w.opts, pathOf(A, "web"), mintRead({ cid: A }))).toEqual(ok(11_000_000, 1_100_000, A));
    expect(await get(w.opts, pathOf(B, "web"), mintRead({ cid: B }))).toEqual(ok(22_000_000, 2_200_000, B));
  });
  it("B's token for A's address learns nothing of A: the same fixed refusal whether A exists or not", async () => {
    const w = world(); await w.setLimit(A, "web", 11_000_000); await w.spend(A, "web", 1_100_000);
    const real = await get(w.opts, pathOf(A, "web"), mintRead({ cid: B }));
    const nobody = await get(w.opts, pathOf(`org_${"c".repeat(20)}`, "web"), mintRead({ cid: B }));
    expect(real).toEqual(UNSIGNED); expect(nobody).toEqual(UNSIGNED);
    expect(JSON.stringify(real)).not.toContain("11000000");
  });
  it("a company with no item gets the default, not another company's limit", async () => {
    const w = world(); await w.setLimit(A, "web", 11_000_000); await w.spend(A, "web", 1_100_000);
    expect(await get(w.opts, pathOf(B, "web"), mintRead({ cid: B }))).toEqual(ok(UPKEEP_DEFAULT_MONTH_MICROS, 0, B));
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as unknown; }
}
function http(handler: (req: never, res: never) => Promise<void>, url: string, token: string | null, method = "GET") {
  const req = Object.assign(Readable.from([]), { method, url, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  void handler(req as never, res as never);
  return done;
}

describe("the HTTP handler", () => {
  it("writes the answer as JSON with no-store, and a refusal the same way", async () => {
    const w = world(); await w.setLimit(A, "web", 3_000_000);
    const handler = createUpkeepCapReadHandler(w.opts);
    const good = await http(handler, pathOf(A, "web"), mintRead());
    expect(good.statusCode).toBe(200);
    expect(good.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(CodeUpkeepCapReadSchema.safeParse(good.json()).success).toBe(true);
    expect((await http(handler, pathOf(A, "web"), null)).statusCode).toBe(401);
  });
  it("is rate limited per serving task: over the minute's calls it answers 429 and reads nothing", async () => {
    const w = world();
    const handler = createUpkeepCapReadHandler(w.opts);
    for (let i = 0; i < UPKEEP_CAP_READ_PER_MINUTE; i++) expect((await http(handler, pathOf(A, "web"), null)).statusCode).toBe(401);
    w.limits.asked.length = 0;
    const over = await http(handler, pathOf(A, "web"), mintRead());
    expect(over.statusCode).toBe(429);
    expect(w.limits.asked).toEqual([]);
  });
});

// ---- in the deployed process ------------------------------------------------------------------------------------------------------------------------------------
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: ISS, [GATEWAY_ENV.installJwksUrl]: `${ISS}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const jwksFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });
const settleAll = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
function request(server: RunningGateway["server"], method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<FakeResponse> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
async function serve(upkeepLimit?: number) {
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  await db.put(TABLES.companies, { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: A, version: 1, settings: { featureGates: {}, budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
  if (upkeepLimit !== undefined) await db.put(TABLES.companies, item(A, "web", upkeepLimit));
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined,
    keys: { keyFor: async () => "rovara-install-key" },
    transport: async () => ({ status: 200, body: answer() }),
  });
  running.push(gateway);
  const read = (project = "web", token: string | null = mintRead(), company = A) => request(gateway.server, "GET", pathOf(company, project), token === null ? {} : { authorization: `Bearer ${token}` });
  const nightly = () => request(gateway.server, "POST", "/v1/messages", { "content-type": "application/json", "x-api-key": mint({ src: "nightly" }) }, { model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true });
  return { gateway, read, nightly };
}

describe("gateway process: the upkeep cap read", () => {
  it("the route is served by the deployed process (not the agent route), and a nightly call's spend shows in the next read", async () => {
    const s = await serve(90_000_000);
    const before = await s.read();
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ version: 1, company: A, project: "web", month: MONTH, enforced: true, limitMicros: 90_000_000, spentMicros: 0 });
    expect((await s.nightly()).statusCode).toBe(200);
    await settleAll();
    const after = (await s.read()).json() as { spentMicros: number; limitMicros: number };
    expect(after.spentMicros).toBeGreaterThan(0);
    expect(after.limitMicros).toBe(90_000_000);
  });
  it("with no item the default is stated; a $0 item is stated as 0 and the nightly call is paused, as the read says", async () => {
    expect(((await (await serve()).read()).json() as { limitMicros: number }).limitMicros).toBe(UPKEEP_DEFAULT_MONTH_MICROS);
    const s = await serve(0);
    expect((await s.read()).json()).toMatchObject({ enforced: true, limitMicros: 0, spentMicros: 0 });
    expect((await s.nightly()).statusCode).toBe(422);
  });
  it("the gateway does not whitelist token steps: a nightly call on ANY step (Code's repair_draft, wiki_build, setup_agent) is held to the same upkeep cap, and its spend shows in the read", async () => {
    const s = await serve(90_000_000);
    for (const stp of ["repair_draft", "wiki_build", "setup_agent"]) {
      const before = ((await s.read()).json() as { spentMicros: number }).spentMicros;
      const res = await request(s.gateway.server, "POST", "/v1/messages", { "content-type": "application/json", "x-api-key": mint({ src: "nightly", stp }) }, { model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true });
      expect(res.statusCode, stp).toBe(200);
      await settleAll();
      expect(((await s.read()).json() as { spentMicros: number }).spentMicros, stp).toBeGreaterThan(before);
    }
    const zero = await serve(0);
    const paused = await request(zero.gateway.server, "POST", "/v1/messages", { "content-type": "application/json", "x-api-key": mint({ src: "nightly", stp: "repair_draft" }) }, { model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true });
    expect(paused.statusCode).toBe(422);
    expect(paused.headers["x-rovara-upkeep-pause"]).toBe("no_budget");
  });
  it("an unsigned call, another company's token and an agent task token never read", async () => {
    const s = await serve(1_000_000);
    expect((await s.read("web", null)).statusCode).toBe(401);
    expect((await s.read("web", mintRead({ cid: B }))).statusCode).toBe(401);
    expect((await s.read("web", mint())).statusCode).toBe(401);
  });
});
