import { beforeAll, describe, expect, it, vi } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";
import { denyNetwork } from "./model-gateway-no-network.js";
import { createTokenHttp, VertexTokens, VERTEX_TOKEN_MARGIN_MS, type TokenHttp } from "../../packages/model-gateway/src/product-vertex-token.js";
import { parseVertexConnect, type VertexCredential } from "../../packages/model-gateway/src/product-vertex-credential.js";
import { AWS_REGION, FakeGoogle, ROLE_ARN, audienceOf, keyFile, sessionArn } from "./model-gateway-vertex-fake.js";
beforeAll(denyNetwork);

const T0 = 1_800_000_000_000;
const A = `org_${"a".repeat(20)}`; const B = `org_${"b".repeat(20)}`;
const iss = "https://install-a.example/v1/auth";
const row = (cid: string, sourceId = "src_vx", versionId = "11111111-1111-4111-8111-111111111111", owner = "web") => ({ iss, cid, owner, sourceId, versionId });
const federation = (pool: string, serviceAccount?: string): VertexCredential => parseVertexConnect(JSON.stringify({ scheme: "federation", projectId: "acme-tests", location: "us-central1", audience: audienceOf(pool), ...(serviceAccount === undefined ? {} : { serviceAccount }) }))!;
function world() {
  const google = new FakeGoogle(T0);
  let canary = 0;
  const tokens = new VertexTokens({ http: google.http, aws: async () => google.base, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION, now: () => google.now, canaryCompany: () => `org_${String(++canary).padStart(20, "9")}` });
  return { google, tokens };
}

describe("Vertex token minting: workload identity federation", () => {
  it("assumes the federation role with the company as session name, exchanges the signed subject token, and uses the federated token", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const minted = await tokens.token(row(A), federation("pool-a"));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(google.whoIs(minted.token)).toBe(sessionArn(A));
    expect(google.calls.map((c) => c.host)).toEqual([`sts.${AWS_REGION}.amazonaws.com`, "sts.googleapis.com"]);
    expect(new URLSearchParams(google.requests[0]!.body.toString()).get("RoleSessionName")).toBe(A);
  });
  it("impersonates the named service account when the credential names one", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const sa = "rovara-tests@acme-tests.iam.gserviceaccount.com";
    google.allowImpersonation(sa, A);
    const minted = await tokens.token(row(A), federation("pool-a", sa));
    expect(minted.ok && google.whoIs(minted.token)).toBe(`sa:${sa}`);
    expect(google.calls.at(-1)).toEqual({ host: "iamcredentials.googleapis.com", path: `/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken` });
  });
  it("two companies: A pasting B's pool is refused by B's condition; each company only ever gets its own token", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A); google.exactPool(audienceOf("pool-b"), B);
    expect(await tokens.token(row(A), federation("pool-b"))).toEqual({ ok: false, reason: "refused" });
    const a = await tokens.token(row(A), federation("pool-a")); const b = await tokens.token(row(B), federation("pool-b"));
    expect(a.ok && google.whoIs(a.token)).toBe(sessionArn(A)); expect(b.ok && google.whoIs(b.token)).toBe(sessionArn(B));
    // A warm process serving A then B with the SAME source id and version never reuses A's token or A's AWS session.
    const google2 = world(); google2.google.openPool(audienceOf("pool-x"));
    const ta = await google2.tokens.token(row(A), federation("pool-x")); const tb = await google2.tokens.token(row(B), federation("pool-x"));
    expect(ta.ok && tb.ok && ta.token !== tb.token).toBe(true);
    expect(tb.ok && google2.google.whoIs(tb.token)).toBe(sessionArn(B));
    expect(google2.google.requests.filter((r) => r.host.endsWith("amazonaws.com")).map((r) => new URLSearchParams(r.body.toString()).get("RoleSessionName"))).toEqual([A, B]);
  });
  it("refuses a session name that is not a company id (never caller-supplied, never truncated)", async () => {
    const { google, tokens } = world();
    google.openPool(audienceOf("pool-a"));
    expect(await tokens.token(row("org_short"), federation("pool-a"))).toEqual({ ok: false, reason: "unavailable" });
    expect(google.calls).toHaveLength(0);
  });
});

describe("Vertex token cache", () => {
  it("reuses a token until 5 minutes before it expires, then mints a new one", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const first = await tokens.token(row(A), federation("pool-a"));
    google.now += 3600_000 - VERTEX_TOKEN_MARGIN_MS - 1;
    const again = await tokens.token(row(A), federation("pool-a"));
    expect(again).toEqual(first);
    expect(google.calls.filter((c) => c.host === "sts.googleapis.com")).toHaveLength(1);
    google.now += 1;
    const fresh = await tokens.token(row(A), federation("pool-a"));
    expect(fresh.ok && first.ok && fresh.token !== first.token).toBe(true);
    expect(google.calls.filter((c) => c.host === "sts.googleapis.com")).toHaveLength(2);
  });
  it("is keyed by install, company, owner, source and version: rotation or another project never reuses a token", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const cred = federation("pool-a");
    const t1 = await tokens.token(row(A), cred);
    const t2 = await tokens.token(row(A, "src_vx", "22222222-2222-4222-8222-222222222222"), cred);
    const t3 = await tokens.token(row(A, "src_other"), cred);
    const t4 = await tokens.token(row(A, "src_vx", "11111111-1111-4111-8111-111111111111", "api"), cred);
    const t5 = await tokens.token({ ...row(A), iss: "https://install-b.example/v1/auth" }, cred);
    const all = [t1, t2, t3, t4, t5].map((t) => (t.ok ? t.token : "x"));
    expect(new Set(all).size).toBe(5);
  });
  it("forget drops the cached token (a Vertex 401) so the next call mints again", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const first = await tokens.token(row(A), federation("pool-a"));
    tokens.forget(row(A));
    const second = await tokens.token(row(A), federation("pool-a"));
    expect(first.ok && second.ok && first.token !== second.token).toBe(true);
  });
  it("concurrent calls for one source share one exchange", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    const results = await Promise.all([1, 2, 3].map(() => tokens.token(row(A), federation("pool-a"))));
    expect(new Set(results.map((r) => (r.ok ? r.token : "")))).toHaveProperty("size", 1);
    expect(google.calls.filter((c) => c.host === "sts.googleapis.com")).toHaveLength(1);
  });
  it("a token that lives less than the margin is used once and not cached; a refusal is never cached", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    google.ttlSeconds = 200;
    const a = await tokens.token(row(A), federation("pool-a")); const b = await tokens.token(row(A), federation("pool-a"));
    expect(a.ok && b.ok && a.token !== b.token).toBe(true);
    google.ttlSeconds = 30;
    expect(await tokens.token(row(A), federation("pool-a"))).toEqual({ ok: false, reason: "unavailable" });
    google.ttlSeconds = 3600;
    google.fail.set("sts.googleapis.com", 403);
    expect(await tokens.token(row(A, "src_new"), federation("pool-a"))).toEqual({ ok: false, reason: "refused" });
    google.fail.delete("sts.googleapis.com");
    expect((await tokens.token(row(A, "src_new"), federation("pool-a"))).ok).toBe(true);
  });
  it("re-uses the company's AWS session until 5 minutes before it expires; never across companies", async () => {
    const { google, tokens } = world();
    google.openPool(audienceOf("pool-a"));
    await tokens.token(row(A, "src_1"), federation("pool-a"));
    await tokens.token(row(A, "src_2"), federation("pool-a"));
    expect(google.calls.filter((c) => c.host.endsWith("amazonaws.com"))).toHaveLength(1);
    await tokens.token(row(B, "src_1"), federation("pool-a"));
    expect(google.calls.filter((c) => c.host.endsWith("amazonaws.com"))).toHaveLength(2);
    google.now += 3600_000 - VERTEX_TOKEN_MARGIN_MS;
    await tokens.token(row(A, "src_3"), federation("pool-a"));
    expect(google.calls.filter((c) => c.host.endsWith("amazonaws.com"))).toHaveLength(3);
  });
});

describe("Vertex token outcomes", () => {
  it("Google refusals are 'refused'; Google or AWS outages are 'unavailable'; no Google text leaks", async () => {
    const cases: Array<[string, number, "refused" | "unavailable"]> = [["sts.googleapis.com", 400, "refused"], ["sts.googleapis.com", 401, "refused"], ["sts.googleapis.com", 403, "refused"], ["sts.googleapis.com", 404, "refused"], ["sts.googleapis.com", 429, "unavailable"], ["sts.googleapis.com", 500, "unavailable"], ["sts.googleapis.com", 302, "unavailable"], [`sts.${AWS_REGION}.amazonaws.com`, 403, "unavailable"], [`sts.${AWS_REGION}.amazonaws.com`, 500, "unavailable"], ["iamcredentials.googleapis.com", 403, "refused"], ["iamcredentials.googleapis.com", 503, "unavailable"]];
    for (const [host, status, reason] of cases) {
      const { google, tokens } = world();
      google.exactPool(audienceOf("pool-a"), A); google.allowImpersonation("sa-name@acme-tests.iam.gserviceaccount.com", A);
      google.fail.set(host, status);
      const result = await tokens.token(row(A), federation("pool-a", "sa-name@acme-tests.iam.gserviceaccount.com"));
      expect(result, `${host} ${status}`).toEqual({ ok: false, reason });
    }
  });
  it("a malformed 200 or a transport throw is 'unavailable'", async () => {
    for (const http of [async () => ({ status: 200, body: Buffer.from("not json") }), async () => { throw new Error(`boom ${"q".repeat(3)}`); }] as TokenHttp[]) {
      const google = new FakeGoogle(T0); google.openPool(audienceOf("pool-a"));
      const tokens = new VertexTokens({ http: async (r) => (r.host.endsWith("amazonaws.com") ? google.http(r) : http(r)), aws: async () => google.base, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION, now: () => T0 });
      expect(await tokens.token(row(A), federation("pool-a"))).toEqual({ ok: false, reason: "unavailable" });
    }
  });
  it("missing gateway AWS credentials are 'unavailable' and nothing is sent", async () => {
    const google = new FakeGoogle(T0);
    const tokens = new VertexTokens({ http: google.http, aws: async () => { throw new Error("no creds"); }, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION, now: () => T0 });
    expect(await tokens.token(row(A), federation("pool-a"))).toEqual({ ok: false, reason: "unavailable" });
    expect(google.calls).toHaveLength(0);
  });
  it("refuses a bad role ARN or region at construction", () => {
    const google = new FakeGoogle(T0);
    expect(() => new VertexTokens({ http: google.http, aws: async () => google.base, federationRoleArn: "arn:aws:iam::1:role/x", awsRegion: AWS_REGION })).toThrow();
    expect(() => new VertexTokens({ http: google.http, aws: async () => google.base, federationRoleArn: ROLE_ARN, awsRegion: "mars-1" })).toThrow();
  });
});

describe("Vertex connection test (the negative probe)", () => {
  it("a pool bound to the company's exact ARN passes; the canary company is refused", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    expect(await tokens.probe(A, federation("pool-a"))).toBe("ok");
    const sessions = google.requests.filter((r) => r.host.endsWith("amazonaws.com")).map((r) => new URLSearchParams(r.body.toString()).get("RoleSessionName"));
    expect(sessions[0]).toBe(A); expect(sessions[1]).toMatch(/^org_[0-9a-z]{20}$/u); expect(sessions[1]).not.toBe(A);
  });
  it("a role-wide condition lets the canary through: too open", async () => {
    const { google, tokens } = world();
    google.openPool(audienceOf("pool-a"));
    expect(await tokens.probe(A, federation("pool-a"))).toBe("too_open");
  });
  it("a pool that refuses the company itself is refused; outages are unavailable", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), B);
    expect(await tokens.probe(A, federation("pool-a"))).toBe("refused");
    google.fail.set("sts.googleapis.com", 503);
    expect(await tokens.probe(A, federation("pool-a"))).toBe("unavailable");
  });
  it("the probe never fills the call cache", async () => {
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    await tokens.probe(A, federation("pool-a"));
    const before = google.calls.length;
    await tokens.token(row(A), federation("pool-a"));
    expect(google.calls.slice(before).some((c) => c.host === "sts.googleapis.com")).toBe(true);
  });
});

describe("Vertex token minting: service-account key file (fallback)", () => {
  const keyCredential = (k = keyFile()) => ({ cred: parseVertexConnect(JSON.stringify({ scheme: "service_account_key", location: "europe-west4", keyFile: k.file }))!, k });
  it("signs an RS256 JWT with the key and exchanges it at oauth2.googleapis.com", async () => {
    const { google, tokens } = world();
    const { cred, k } = keyCredential(); google.registerKeyFile(k.file, k.publicKey);
    const minted = await tokens.token(row(A), cred);
    expect(minted.ok && google.whoIs(minted.token)).toBe(`sa:${k.file.client_email}`);
    expect(google.calls).toEqual([{ host: "oauth2.googleapis.com", path: "/token" }]);
  });
  it("a key Google does not know is refused; the private key never appears in a result, request header or error", async () => {
    const { google, tokens } = world();
    const { cred, k } = keyCredential();
    const result = await tokens.token(row(A), cred);
    expect(result).toEqual({ ok: false, reason: "refused" });
    const body = k.pem.split("\n")[1]!;
    for (const r of google.requests) { expect(r.body.toString()).not.toContain(body); expect(JSON.stringify(r.headers)).not.toContain(body); }
    expect(JSON.stringify(result)).not.toContain(body);
    expect(await tokens.probe(A, cred)).toBe("refused");
  });
  it("probe of a working key file is ok (no canary for a key file)", async () => {
    const { google, tokens } = world();
    const { cred, k } = keyCredential(); google.registerKeyFile(k.file, k.publicKey);
    expect(await tokens.probe(A, cred)).toBe("ok");
    expect(google.calls.every((c) => c.host === "oauth2.googleapis.com")).toBe(true);
  });
  it("JWT clock edges: iat is the injected clock, exp is one hour later", async () => {
    const { google, tokens } = world();
    const { cred, k } = keyCredential(); google.registerKeyFile(k.file, k.publicKey);
    await tokens.token(row(A), cred);
    const assertion = new URLSearchParams(google.requests[0]!.body.toString()).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as { iat: number; exp: number };
    expect(claims.iat).toBe(Math.floor(T0 / 1000)); expect(claims.exp - claims.iat).toBe(3600);
  });
});

describe("token transport", () => {
  function fakeRequest(status = 200, body = "{}") {
    const seen: Array<Record<string, unknown>> = [];
    const request = ((options: Record<string, unknown>, callback: (res: EventEmitter & { statusCode: number; destroy(): void }) => void) => {
      seen.push(options);
      const req = new EventEmitter() as EventEmitter & { end(b: Buffer): void; destroy(): void; setTimeout?: unknown };
      req.end = () => { const res = Object.assign(new EventEmitter(), { statusCode: status, destroy: () => undefined }); callback(res); res.emit("data", Buffer.from(body)); res.emit("end"); };
      req.destroy = () => undefined;
      return req;
    }) as unknown as typeof https.request;
    return { seen, request };
  }
  it("only the fixed token hosts, https on 443, no agent reuse across hosts, TLS checked", async () => {
    const { seen, request } = fakeRequest();
    const http = createTokenHttp(request);
    for (const host of ["sts.googleapis.com", "iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.us-west-2.amazonaws.com"]) expect((await http({ host, path: "/x", method: "POST", headers: {}, body: Buffer.alloc(0) })).status).toBe(200);
    expect(seen.every((o) => o.port === 443 && o.rejectUnauthorized === true && o.agent === false && o.method === "POST")).toBe(true);
    for (const host of ["us-central1-aiplatform.googleapis.com", "generativelanguage.googleapis.com", "evil.example", "sts.googleapis.com.evil.example", "169.254.169.254", "sts.us-west-2.amazonaws.com.evil"]) {
      await expect(http({ host, path: "/x", method: "POST", headers: {}, body: Buffer.alloc(0) })).rejects.toThrow();
    }
    expect(seen).toHaveLength(4);
  });
  it("bounds the answer size", async () => {
    const { request } = fakeRequest(200, "x".repeat(70 * 1024));
    await expect(createTokenHttp(request)({ host: "sts.googleapis.com", path: "/v1/token", method: "POST", headers: {}, body: Buffer.alloc(0) })).rejects.toThrow();
  });
  it("the real https.request is denied in these tests (no Google host is ever reached)", async () => {
    const spy = vi.spyOn(https, "request");
    await expect(createTokenHttp()({ host: "sts.googleapis.com", path: "/v1/token", method: "POST", headers: {}, body: Buffer.alloc(0) })).rejects.toThrow();
    spy.mockRestore();
  });
});

describe("the AWS subject token, checked by an independent SigV4 (review L5)", () => {
  it("the GetCallerIdentity signature matches a from-first-principles SigV4 over the canonical query and the signed target resource", async () => {
    const { createHash, createHmac } = await import("node:crypto");
    const { google, tokens } = world();
    google.exactPool(audienceOf("pool-a"), A);
    expect((await tokens.token(row(A), federation("pool-a"))).ok).toBe(true);
    const exchange = google.requests.find((r) => r.host === "sts.googleapis.com")!;
    const subject = JSON.parse(decodeURIComponent(new URLSearchParams(exchange.body.toString()).get("subject_token")!)) as { url: string; method: string; headers: Array<{ key: string; value: string }> };
    const h = Object.fromEntries(subject.headers.map((x) => [x.key.toLowerCase(), x.value]));
    expect(subject.url).toBe(`https://sts.${AWS_REGION}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15`);
    expect(Object.keys(h).sort()).toEqual(["authorization", "host", "x-amz-date", "x-amz-security-token", "x-goog-cloud-target-resource"]);
    const akid = /Credential=([A-Z0-9]+)\//u.exec(h.authorization!)![1]!;
    const session = google.sessions.get(akid)!;
    // Written out by hand, independent of aws.ts signRequest.
    const signed = "host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource";
    const canonical = ["POST", "/", "Action=GetCallerIdentity&Version=2011-06-15", `host:sts.${AWS_REGION}.amazonaws.com`, `x-amz-date:${h["x-amz-date"]}`, `x-amz-security-token:${session.token}`, `x-goog-cloud-target-resource:${audienceOf("pool-a")}`, "", signed, createHash("sha256").update("").digest("hex")].join("\n");
    const day = h["x-amz-date"]!.slice(0, 8);
    const scope = `${day}/${AWS_REGION}/sts/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", h["x-amz-date"], scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    let k: Buffer = createHmac("sha256", `AWS4${session.secret}`).update(day).digest();
    for (const part of [AWS_REGION, "sts", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
    const signature = createHmac("sha256", k).update(toSign).digest("hex");
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${akid}/${scope}, SignedHeaders=${signed}, Signature=${signature}`);
    expect(h["x-amz-date"]).toBe(new Date(T0).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, ""));
  });
});
