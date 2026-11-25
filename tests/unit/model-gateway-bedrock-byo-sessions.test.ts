// DEC 238 slice 1: the customer's role assumed per company, through Rovara's broker, against a fake STS and a fake Bedrock (no
// network). The external id and session name always come from the company asked for; sessions are cached per key-store row and
// never shared between companies; the connection test must see two canaries refused, and tells a model that is not enabled yet
// apart from a role that may not call it.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BedrockExternalIds, type BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import { BedrockSessions, BEDROCK_SESSION_MARGIN_MS, PROBE_BUDGET_MS } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import type { TokenHttpRequest } from "../../packages/model-gateway/src/product-vertex-token.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";

const ISS = "https://code.example.test/v1/auth";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const CANARY = "org_cccccccccccccccccccc";
const BROKER = "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging";
const ROLE_A = `arn:aws:iam::111111111111:role/RovaraBedrockInvoke-${A}`;
const ROLE_B = `arn:aws:iam::222222222222:role/RovaraBedrockInvoke-${B}`;
const SONNET = "us.anthropic.claude-sonnet-5-5";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const START = Date.parse("2026-11-16T00:00:00Z");
/** What AWS really answered (HTTP 200) to InvokeModel on us.anthropic.claude-haiku-4-5-20251001-v1:0 with max_tokens 0, run in a Bedrock account on 2026-11-25 (the owner's own call). */
const REAL_MAX_TOKENS_0_ANSWER = readFileSync(new URL("../fixtures/model-gateway-bedrock/invoke-max-tokens-0-haiku-4-5.json", import.meta.url), "utf8");
const connection = (roleArn: string, models: Record<string, string> = { "claude-sonnet-5-5": SONNET }): BedrockConnection => ({ scheme: "assume_role", roleArn, region: "eu-west-1", models, allowGlobal: false });

type Trust = "strict" | "no_external_id" | "no_session_name" | "refuse";
function fakeAws(clock: { at: number }) {
  const key = randomBytes(32);
  const externalIds = new BedrockExternalIds({ generateMac: async (input) => ({ Mac: new Uint8Array(createHmac("sha256", key).update(input.Message).digest()) }) }, "k");
  /** Each customer role: whom it trusts (its company) and how strictly. */
  const roles = new Map<string, { cid: string; trust: Trust }>([[ROLE_A, { cid: A, trust: "strict" }], [ROLE_B, { cid: B, trust: "strict" }]]);
  const calls: Array<{ roleArn: string; session: string; externalId?: string; signedBy: string }> = [];
  let issued = 0; let down = false;
  /** Make one STS call fail with an error body (a throttle, or a 403 that is not AccessDenied). */
  let fail: ((call: { roleArn: string; session: string; externalId?: string }) => { status: number; code: string } | undefined) | undefined;
  const credentials = (prefix: string) => { issued += 1; return { id: `ASIA${prefix}${String(issued).padStart(12, "0")}`, expiration: new Date(clock.at + 3600_000).toISOString() }; };
  const http = async (request: TokenHttpRequest) => {
    if (down) throw new Error("sts down");
    expect(request.host).toBe("sts.us-west-2.amazonaws.com");
    const form = new URLSearchParams(request.body.toString("utf8"));
    const roleArn = form.get("RoleArn")!; const session = form.get("RoleSessionName")!; const externalId = form.get("ExternalId") ?? undefined;
    const signedBy = /Credential=([A-Z0-9]+)\//u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    calls.push({ roleArn, session, ...(externalId === undefined ? {} : { externalId }), signedBy });
    const failed = fail?.({ roleArn, session, ...(externalId === undefined ? {} : { externalId }) });
    if (failed !== undefined) return { status: failed.status, body: Buffer.from(`<ErrorResponse><Error><Type>Sender</Type><Code>${failed.code}</Code><Message>Rate exceeded</Message></Error></ErrorResponse>`) };
    let ok: boolean;
    if (roleArn === BROKER) ok = signedBy.startsWith("AKIATASK") && /^org_/u.test(session) && externalId === undefined;
    else {
      const role = roles.get(roleArn);
      const expected = role === undefined ? undefined : await externalIds.of(ISS, role.cid);
      ok = role !== undefined && signedBy.startsWith("ASIABROKER") && role.trust !== "refuse"
        && (role.trust === "no_external_id" || externalId === expected) && (role.trust === "no_session_name" || session === role.cid);
    }
    if (!ok) return { status: 403, body: Buffer.from("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>") };
    const c = credentials(roleArn === BROKER ? "BROKER" : "CUSTOMER");
    return { status: 200, body: Buffer.from(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${c.id}</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>${c.expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`) };
  };
  return { http, externalIds, roles, calls, set down(v: boolean) { down = v; }, set fail(f: typeof fail) { fail = f; } };
}
function sessions(options: { bedrock?: (region: string, creds: () => Promise<{ accessKeyId: string }>) => ProviderTransport; log?: (line: Record<string, string | number | boolean>) => void } = {}) {
  const clock = { at: START };
  const aws = fakeAws(clock);
  const s = new BedrockSessions({
    http: aws.http, aws: async () => ({ accessKeyId: "AKIATASK0000000000", secretAccessKey: "x" }), brokerRoleArn: BROKER, awsRegion: "us-west-2", issuer: ISS,
    externalIds: aws.externalIds, now: () => clock.at, canaryCompany: () => CANARY, log: options.log ?? (() => undefined), ...(options.bedrock === undefined ? {} : { bedrock: options.bedrock }),
  });
  return { s, aws, clock };
}
const row = (cid: string, versionId = "11111111-1111-4111-8111-111111111111") => ({ iss: ISS, cid, owner: "_company", sourceId: "src_bedrock", versionId });
const BROKER_SIGNED = expect.stringMatching(/^ASIABROKER/u) as unknown as string;
const ANY_SIGNER = expect.any(String) as unknown as string;
const answer = (status: number, text = "{}"): ProviderTransport => async () => ({ status, body: (async function* () { yield Buffer.from(text); })() });

describe("the customer's role, per company", () => {
  it("assumes broker then role with the company's own external id and its company id as the session name (two companies)", async () => {
    const { s, aws } = sessions();
    const a = await s.credentials(row(A), connection(ROLE_A));
    const b = await s.credentials(row(B), connection(ROLE_B));
    expect(a.ok && b.ok).toBe(true);
    const customers = aws.calls.filter((c) => c.roleArn !== BROKER);
    expect(customers).toEqual([
      { roleArn: ROLE_A, session: A, externalId: await aws.externalIds.of(ISS, A), signedBy: BROKER_SIGNED },
      { roleArn: ROLE_B, session: B, externalId: await aws.externalIds.of(ISS, B), signedBy: BROKER_SIGNED },
    ]);
    // Broker sessions are per company too.
    expect(aws.calls.filter((c) => c.roleArn === BROKER).map((c) => c.session)).toEqual([A, B]);
    if (a.ok && b.ok) expect(a.credentials.accessKeyId).not.toBe(b.credentials.accessKeyId);
  });

  it("company B pointing at company A's role is refused by A's trust policy (B's external id and session name are sent)", async () => {
    const { s, aws } = sessions();
    expect(await s.credentials(row(B), connection(ROLE_A))).toEqual({ ok: false, reason: "refused" });
    const sent = aws.calls.filter((c) => c.roleArn === ROLE_A);
    expect(sent).toEqual([{ roleArn: ROLE_A, session: B, externalId: await aws.externalIds.of(ISS, B), signedBy: ANY_SIGNER }]);
  });

  it("A's cached session is never handed to B, even when B points at A's role (two companies, one warm process)", async () => {
    const { s, aws } = sessions();
    const a = await s.credentials(row(A), connection(ROLE_A));
    expect(a.ok).toBe(true);
    // Same source id and version as A's row: only the company tells them apart.
    expect(await s.credentials(row(B), connection(ROLE_A))).toEqual({ ok: false, reason: "refused" });
    expect(aws.calls.filter((c) => c.roleArn === ROLE_A).map((c) => c.session)).toEqual([A, B]);
    const [x, y] = await Promise.all([s.credentials(row(A), connection(ROLE_A)), s.credentials(row(B), connection(ROLE_A))]);
    expect(x.ok).toBe(true); expect(y.ok).toBe(false);
  });

  it("caches per row until 5 minutes before expiry, never across companies or after a version change; refusals are not cached", async () => {
    const { s, aws, clock } = sessions();
    await s.credentials(row(A), connection(ROLE_A));
    const first = aws.calls.length;
    await s.credentials(row(A), connection(ROLE_A));
    expect(aws.calls.length).toBe(first);
    // Another version of the row (a rotate): assumed again.
    await s.credentials(row(A, "22222222-2222-4222-8222-222222222222"), connection(ROLE_A));
    expect(aws.calls.filter((c) => c.roleArn === ROLE_A)).toHaveLength(2);
    clock.at += 3600_000 - BEDROCK_SESSION_MARGIN_MS + 1;
    await s.credentials(row(A), connection(ROLE_A));
    expect(aws.calls.filter((c) => c.roleArn === ROLE_A)).toHaveLength(3);
    aws.roles.set(ROLE_A, { cid: A, trust: "refuse" });
    s.forget(row(A));
    expect((await s.credentials(row(A), connection(ROLE_A))).ok).toBe(false);
    aws.roles.set(ROLE_A, { cid: A, trust: "strict" });
    expect((await s.credentials(row(A), connection(ROLE_A))).ok).toBe(true);
  });

  it("a cached session is for the role it was made for: the same row naming another role assumes that role", async () => {
    const { s, aws } = sessions();
    const second = `${ROLE_A}-two`;
    aws.roles.set(second, { cid: A, trust: "strict" });
    await s.credentials(row(A), connection(ROLE_A));
    expect((await s.credentials(row(A), connection(second))).ok).toBe(true);
    expect(aws.calls.filter((c) => c.roleArn !== BROKER).map((c) => c.roleArn)).toEqual([ROLE_A, second]);
  });

  it("concurrent calls for one row share one assume; an STS outage is unavailable", async () => {
    const { s, aws } = sessions();
    const [x, y] = await Promise.all([s.credentials(row(A), connection(ROLE_A)), s.credentials(row(A), connection(ROLE_A))]);
    expect(x).toEqual(y);
    expect(aws.calls.filter((c) => c.roleArn === ROLE_A)).toHaveLength(1);
    const other = sessions(); other.aws.down = true;
    expect(await other.s.credentials(row(A), connection(ROLE_A))).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a row of another install or a role outside the fixed prefix is never assumed", async () => {
    const { s, aws } = sessions();
    expect((await s.credentials({ ...row(A), iss: "https://other.example/v1/auth" }, connection(ROLE_A))).ok).toBe(false);
    expect((await s.credentials(row(A), connection("arn:aws:iam::111111111111:role/Admin"))).ok).toBe(false);
    expect(aws.calls).toEqual([]);
  });
});

describe("the connection test", () => {
  it("ok only when the company gets a session AND both canaries are refused; each model checked at $0", async () => {
    const sent: ProviderRequest[] = [];
    const { s, aws } = sessions({ bedrock: (region) => { expect(region).toBe("eu-west-1"); return async (request) => { sent.push(request); return answer(400, '{"message":"max_tokens: must be at least 1"}')(request); }; } });
    expect(await s.probe(A, connection(ROLE_A, { "claude-sonnet-5-5": SONNET, "claude-haiku-4-5": HAIKU }))).toEqual({ result: "ok", models: { [SONNET]: "ready", [HAIKU]: "ready" } });
    const canaries = aws.calls.filter((c) => c.roleArn === ROLE_A).slice(1);
    expect(canaries).toEqual([
      { roleArn: ROLE_A, session: A, externalId: await aws.externalIds.of(ISS, CANARY), signedBy: ANY_SIGNER },
      { roleArn: ROLE_A, session: CANARY, externalId: await aws.externalIds.of(ISS, A), signedBy: ANY_SIGNER },
    ]);
    // The model check: InvokeModel, max_tokens 0 (AWS answers 200 with no output: 0 output tokens billed).
    expect(sent.map((r) => r.path).sort()).toEqual([`/model/${encodeURIComponent(HAIKU)}/invoke`, `/model/${encodeURIComponent(SONNET)}/invoke`].sort());
    for (const r of sent) expect(JSON.parse(Buffer.from(r.body).toString("utf8"))).toEqual({ anthropic_version: "bedrock-2023-05-31", max_tokens: 0, messages: [{ role: "user", content: "." }] });
  });

  it("too open when the role ignores the external id, or ignores the session name", async () => {
    for (const trust of ["no_external_id", "no_session_name"] as const) {
      const { s, aws } = sessions({ bedrock: () => answer(400) });
      aws.roles.set(ROLE_A, { cid: A, trust });
      expect((await s.probe(A, connection(ROLE_A))).result, trust).toBe("too_open");
    }
  });

  it("a canary that STS throttles (or any error but AccessDenied) proves nothing: the test is unavailable, never ok", async () => {
    for (const [status, code] of [[400, "Throttling"], [400, "ExpiredToken"], [403, "RegionDisabledException"], [500, "InternalFailure"]] as const) {
      for (const which of ["external id", "session name"] as const) {
        const { s, aws } = sessions({ bedrock: () => answer(400) });
        // The role is too open, and the canary that would show it (the 2nd call on the role for a role that ignores the external
        // id, the 3rd for one that ignores the session name; the 1st is the real company) errors instead of answering.
        aws.roles.set(ROLE_A, { cid: A, trust: which === "external id" ? "no_external_id" : "no_session_name" });
        const target = which === "external id" ? 2 : 3; let seen = 0;
        aws.fail = (call) => call.roleArn === ROLE_A && ++seen === target ? { status, code } : undefined;
        expect((await s.probe(A, connection(ROLE_A))).result, `${code} ${which}`).toBe("unavailable");
      }
    }
  });

  it("on the call path a throttle is unavailable, never refused (so no refusal is recorded)", async () => {
    const { s, aws } = sessions();
    aws.fail = (call) => call.roleArn === ROLE_A ? { status: 400, code: "Throttling" } : undefined;
    expect(await s.credentials(row(A), connection(ROLE_A))).toEqual({ ok: false, reason: "unavailable" });
    aws.fail = (call) => call.roleArn === ROLE_A ? { status: 403, code: "AccessDenied" } : undefined;
    expect(await s.credentials(row(A), connection(ROLE_A))).toEqual({ ok: false, reason: "refused" });
  });

  it("refused when the company can't assume it (wrong role, or another company's role); nothing is cached by a test", async () => {
    const { s, aws } = sessions({ bedrock: () => answer(400) });
    expect((await s.probe(B, connection(ROLE_A))).result).toBe("refused");
    aws.roles.set(ROLE_A, { cid: A, trust: "refuse" });
    expect((await s.probe(A, connection(ROLE_A))).result).toBe("refused");
    aws.roles.set(ROLE_A, { cid: A, trust: "strict" });
    await s.probe(A, connection(ROLE_A));
    const before = aws.calls.length;
    await s.credentials(row(A), connection(ROLE_A));
    expect(aws.calls.length).toBeGreaterThan(before);
  });

  it("tells each model's state from Bedrock's answer, never from a guess", async () => {
    const cases: Array<[ProviderTransport, string]> = [
      [answer(400, '{"message":"Malformed input request: max_tokens"}'), "ready"],
      [answer(403, '{"message":"Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions"}'), "not_enabled"],
      [answer(403, '{"message":"You don\'t have access to the model with the specified model ID."}'), "not_enabled"],
      [answer(403, '{"message":"User: arn:aws:sts::1:assumed-role/x is not authorized to perform: bedrock:InvokeModel"}'), "refused"],
      [answer(400, '{"message":"The provided model identifier is invalid."}'), "not_found"],
      [answer(404, "{}"), "not_found"],
      [answer(429, '{"message":"Too many tokens, please wait before trying again."}'), "no_quota"],
      [answer(400, 'ServiceQuotaExceededException\n{"message":"quota"}'), "no_quota"],
      [answer(400, 'ThrottlingException\nToo many tokens'), "no_quota"],
      // AWS's real answer to max_tokens 0 (a 200 Messages response with no output) is a working model.
      [answer(200, REAL_MAX_TOKENS_0_ANSWER), "ready"],
      // A 2xx that is not that shape proves nothing: AWS did not answer the check. Never ready, never a model state.
      [answer(200, '{"content":[{"type":"text","text":"."}]}'), "no_answer"],
      // Any stop reason of a Messages answer is a working model (only Haiku 4.5's "max_tokens" was seen live; a model that stops otherwise must not read "check again" forever).
      [answer(200, '{"type":"message","content":[],"stop_reason":"end_turn"}'), "ready"],
      [answer(200, '{"type":"message","content":[{"type":"text","text":""}],"stop_reason":"stop_sequence"}'), "ready"],
      [answer(200, '{"type":"message","stop_reason":"max_tokens"}'), "no_answer"],
      [answer(200, '{"type":"error","content":[]}'), "no_answer"],
      [answer(200, "not json"), "no_answer"],
      [answer(200, "{}"), "no_answer"],
      [answer(204, ""), "no_answer"],
      // AWS not answering is never a model state.
      [answer(503, "{}"), "no_answer"],
      [answer(408, "{}"), "no_answer"],
      [answer(424, "{}"), "no_answer"],
      // review: narrow. Only the error type the transport names FIRST (or a 429) is no_quota; AWS words that merely mention a throttle or a quota are not.
      [answer(400, 'ValidationException\n{"message":"max_tokens must be at least 1 (see ThrottlingException and quota docs)"}'), "ready"],
      [answer(403, 'AccessDeniedException\n{"message":"User: x is not authorized to perform: bedrock:InvokeModel (ServiceQuotaExceededException)"}'), "refused"],
      [answer(503, 'ServiceUnavailableException\n{"message":"throttled upstream"}'), "no_answer"],
      [async () => { throw new Error("socket"); }, "no_answer"],
    ];
    for (const [transport, state] of cases) {
      const { s } = sessions({ bedrock: () => transport });
      expect((await s.probe(A, connection(ROLE_A))).models, state).toEqual({ [SONNET]: state });
    }
  });

  it("asks once more when AWS answers 5xx or the call fails, and takes the second answer; a 4xx is never asked twice", async () => {
    const run = async (...steps: ProviderTransport[]) => {
      let calls = 0;
      const { s } = sessions({ bedrock: () => async (request) => { const step = steps[Math.min(calls, steps.length - 1)]!; calls += 1; return step(request); } });
      const probe = await s.probe(A, connection(ROLE_A));
      return { state: probe.models?.[SONNET], calls };
    };
    const boom: ProviderTransport = async () => { throw new Error("socket"); };
    const real = answer(200, REAL_MAX_TOKENS_0_ANSWER);
    expect(await run(answer(503), real)).toEqual({ state: "ready", calls: 2 });
    expect(await run(boom, answer(400, "ValidationException\n{}"))).toEqual({ state: "ready", calls: 2 });
    expect(await run(answer(500), answer(403, "AccessDeniedException\n{}"))).toEqual({ state: "refused", calls: 2 });
    // Still failing on the second ask: AWS did not answer. Exactly two asks, never a third.
    expect(await run(answer(503), answer(502))).toEqual({ state: "no_answer", calls: 2 });
    expect(await run(boom, boom)).toEqual({ state: "no_answer", calls: 2 });
    // Anything AWS did answer is final on the first ask.
    for (const status of [200, 400, 403, 404, 429]) expect((await run(answer(status, status === 200 ? REAL_MAX_TOKENS_0_ANSWER : "{}"))).calls, String(status)).toBe(1);
    // An odd 200 is final too (not a 5xx): asked once, no_answer.
    expect(await run(answer(200, "{}"))).toEqual({ state: "no_answer", calls: 1 });
    // Only a 5xx or a failed call is asked again: every other status is one ask (a retry on "any 4xx" or "any status over 400" would be caught here).
    for (const status of [401, 408, 413, 422, 424, 499]) expect(await run(answer(status, "{}")), String(status)).toEqual({ state: "no_answer", calls: 1 });
  });

  it("a check the caller itself aborted is not asked again: no_answer after one ask", async () => {
    const stopper = new AbortController();
    let calls = 0;
    const { s } = sessions({ bedrock: () => async () => { calls += 1; stopper.abort(); throw new Error("aborted"); } });
    const probe = await s.probe(A, connection(ROLE_A), stopper.signal);
    expect(probe.models).toEqual({ [SONNET]: "no_answer" });
    expect(calls).toBe(1);
  });

  it("does not ask again when a whole ask no longer fits in the probe's budget (the retry can't take the probe past Cloud's wait)", async () => {
    const holder: { clock?: { at: number } } = {};
    let calls = 0;
    const { s, clock } = sessions({ bedrock: () => async () => { calls += 1; holder.clock!.at += PROBE_BUDGET_MS - 2_000; throw new Error("socket"); } });
    holder.clock = clock;
    expect((await s.probe(A, connection(ROLE_A))).models).toEqual({ [SONNET]: "no_answer" });
    // 20 s of the 22 s budget were used by the first ask: less than one 5 s ask is left.
    expect(calls).toBe(1);
    // With the budget left, the same failure is asked twice.
    calls = 0;
    const fresh = sessions({ bedrock: () => async () => { calls += 1; throw new Error("socket"); } });
    expect((await fresh.s.probe(A, connection(ROLE_A))).models).toEqual({ [SONNET]: "no_answer" });
    expect(calls).toBe(2);
  });

  it("a logger that throws never changes a check's answer", async () => {
    const { s } = sessions({ log: () => { throw new Error("log down"); }, bedrock: () => answer(200, REAL_MAX_TOKENS_0_ANSWER) });
    expect((await s.probe(A, connection(ROLE_A))).models).toEqual({ [SONNET]: "ready" });
  });

  it("logs each model check's company, HTTP status and Bedrock's error type, never AWS's words, an account id or an ARN", async () => {
    const lines: Array<Record<string, string | number | boolean>> = [];
    const words = 'AccessDeniedException\n{"message":"User: arn:aws:sts::111111111111:assumed-role/RovaraBedrockInvoke-org_x/org_x is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:eu-west-1:111111111111:inference-profile/x"}';
    const { s } = sessions({ log: (line) => lines.push(line), bedrock: () => answer(403, words) });
    expect((await s.probe(A, connection(ROLE_A))).models).toEqual({ [SONNET]: "refused" });
    const checks = lines.filter((line) => line.event === "bedrock_model_check");
    expect(checks).toEqual([{ event: "bedrock_model_check", company: A, model: SONNET, attempt: 1, status: 403, errorType: "AccessDeniedException", state: "refused" }]);
    // The company id (org_*) ties a line to a company; nothing else of the customer's (account id, role ARN, AWS's words) is logged.
    const text = JSON.stringify(lines);
    for (const never of ["111111111111", "assumed-role", "not authorized", "arn:aws", ROLE_A]) expect(text).not.toContain(never);
  });

  it("logs both asks when it retries, and a failed call as an error name only", async () => {
    const lines: Array<Record<string, string | number | boolean>> = [];
    let n = 0;
    const { s } = sessions({ log: (line) => lines.push(line), bedrock: () => async (request) => { n += 1; if (n === 1) { const e = new Error("connect ECONNRESET 111111111111"); e.name = "TimeoutError"; throw e; } return answer(503, 'ServiceUnavailableException\n{"message":"try later"}')(request); } });
    expect((await s.probe(A, connection(ROLE_A))).models).toEqual({ [SONNET]: "no_answer" });
    expect(lines.filter((line) => line.event === "bedrock_model_check")).toEqual([
      { event: "bedrock_model_check", company: A, model: SONNET, attempt: 1, status: 0, errorType: "none", error: "TimeoutError", state: "retry" },
      { event: "bedrock_model_check", company: A, model: SONNET, attempt: 2, status: 503, errorType: "ServiceUnavailableException", state: "no_answer" },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/ECONNRESET|111111111111|try later/u);
  });

  it("an STS outage or a malformed company is unavailable", async () => {
    const { s, aws } = sessions({ bedrock: () => answer(400) });
    expect((await s.probe("org_x", connection(ROLE_A))).result).toBe("unavailable");
    aws.down = true;
    expect((await s.probe(A, connection(ROLE_A))).result).toBe("unavailable");
  });
});
