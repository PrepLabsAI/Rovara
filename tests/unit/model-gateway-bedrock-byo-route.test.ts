// DEC 238 slice 1: the agent route on a company's OWN Bedrock (`bedrock_byo`). The call goes to Bedrock in the connection's Region,
// signed with the customer's role assumed as THAT company, for a model the company picked only. Bedrock bills the customer: the
// gateway writes no billable line, prices at the dearer of the Bedrock and Anthropic list rows, and counts it under the one
// combined company cap. A refusal is free and says what to fix; there is never a fallback to another source; and two companies
// never share a connection or a session.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { DynamoPriceSnapshotStore } from "../../packages/model-gateway/src/dynamo-prices.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { agentSourceSwitchedOn, parseAiSourceKinds, resolveAgentSource, storedBedrock, type AgentAiSource, type AgentAiSourceReader, type ByoBedrock } from "../../packages/model-gateway/src/agent-ai.js";
import { loadSwitches } from "../../infra/lib/model-gateway-switches.js";
import type { AwsCredentials, CredentialSource } from "../../packages/model-gateway/src/aws.js";
import type { BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import type { AssumeResult, BedrockSessionSource } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import type { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import type { ProductKeyRow } from "../../packages/model-gateway/src/product-seal.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_SOURCE_NOT_OFFERED, AGENT_SOURCE_SWITCHED_OFF, BEDROCK_ANTHROPIC_VERSION, BYO_BEDROCK_MODEL, BYO_BEDROCK_MODEL_NOT_ENABLED, BYO_BEDROCK_NOT_CONNECTED, BYO_BEDROCK_REFUSED, byoBedrockQuota, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps, claims, jwk, kid, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";

const AGENT_ENVS = ["beta"] as const; // production joins in its own commit (DEC 254zzz524: beta proof first)
const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const MODEL = claims.mdl[0]!; // "claude-sonnet-4-5"
const ID_A = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ID_B = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ROLE = (cid: string) => `arn:aws:iam::${cid === cidA ? "111111111111" : "222222222222"}:role/RovaraBedrockInvoke-${cid}`;
const conn = (cid: string): BedrockConnection => ({ scheme: "assume_role", roleArn: ROLE(cid), region: cid === cidA ? "eu-west-1" : "us-west-2", models: { [MODEL]: cid === cidA ? ID_A : ID_B }, allowGlobal: false });

class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { return this.saved.get(cid); }
}
class CompanyKeys implements LearningKeySource {
  reads: string[] = [];
  async connected(): Promise<boolean> { return true; }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.reads.push(cid); return `customer-key-${cid}`; }
}
class Sessions implements BedrockSessionSource {
  readonly asked: Array<{ row: ProductKeyRow; roleArn: string }> = [];
  readonly forgotten: ProductKeyRow[] = [];
  result: (cid: string) => AssumeResult = (cid) => ({ ok: true, credentials: { accessKeyId: `ASIA${cid.slice(4, 20).toUpperCase()}`, secretAccessKey: "s", sessionToken: "t", expiresAt: Date.now() + 3600_000 } });
  async credentials(row: ProductKeyRow, connection: BedrockConnection): Promise<AssumeResult> { this.asked.push({ row, roleArn: connection.roleArn }); return this.result(row.cid); }
  forget(row: ProductKeyRow): void { this.forgotten.push(row); }
}

function gateway(options: { bedrock?: (region: string) => ProviderTransport; overrides?: Partial<GatewayDependencies>; byo?: false; connections?: Map<string, BedrockConnection>; anthropicPrice?: number; switchedOn?: ReadonlySet<string> } = {}) {
  const choices = new Choices(); const companyKeys = new CompanyKeys(); const sessions = new Sessions();
  const keySent: ProviderRequest[] = [];
  const sent: Array<{ region: string; request: ProviderRequest; credentials: AwsCredentials }> = [];
  const priced: Array<[string, string]> = [];
  const refused: string[] = [];
  const connections = options.connections ?? new Map([[cidA, conn(cidA)], [cidB, conn(cidB)]]);
  const read: string[] = [];
  const byo: ByoBedrock = {
    async connection(iss, cid) {
      read.push(cid);
      const c = connections.get(cid);
      return c === undefined ? undefined : { row: { iss, cid, owner: "_company", sourceId: "src_bedrock", versionId: "11111111-1111-4111-8111-111111111111" }, connection: c };
    },
    sessions,
    transport: (region: string, credentials: CredentialSource) => async (request) => {
      const creds = await credentials();
      sent.push({ region, request, credentials: creds });
      return (options.bedrock?.(region) ?? (async () => ({ status: 200, body: answer() })))(request);
    },
    async refused(_iss, cid) { refused.push(cid); },
  };
  const base = setup({
    agentKeys: companyKeys,
    agentAi: { sources: choices, ...(options.byo === false ? {} : { byo }), ...(options.switchedOn === undefined ? {} : { switchedOn: options.switchedOn }) },
    keys: { keyFor: async () => "rovara-install-key" },
    transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
    prices: { priceFor: (provider, model) => { priced.push([provider, model]); return provider === "anthropic" ? { inputMicrosPerMTok: options.anthropicPrice ?? 3_000_000, outputMicrosPerMTok: 15_000_000 } : { inputMicrosPerMTok: 3_300_000, outputMicrosPerMTok: 15_000_000 }; } },
    ...options.overrides,
  });
  return { ...base, choices, companyKeys, sessions, keySent, sent, priced, refused, read };
}
const error = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const committed = async (meter: InMemoryMeter, cid = cidA) => (await meter.read({ ...scope, cid })).filter((row) => row.item === "company").reduce((sum, row) => sum + row.committed, 0);
const failing = (status: number, text = "{}"): ProviderTransport => async () => ({ status, body: (async function* () { yield Buffer.from(text); })() });

describe("agent route: the company's own Bedrock (DEC 238)", () => {
  it("sends to Bedrock in the connection's Region with the customer role's session; no key, no Rovara account, no billable line", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps, { ...requestBody, metadata: { user_id: "u1" } }, mint(), undefined, { "anthropic-beta": "interleaved-thinking-2025-05-14" });
    expect(sink.status).toBe(200);
    expect(sink.text()).toContain("event: message_stop");
    expect(g.keySent).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
    expect(g.sent).toHaveLength(1);
    const { region, request, credentials } = g.sent[0]!;
    expect(region).toBe("eu-west-1");
    expect(credentials.accessKeyId).toBe("ASIAAAAAAAAAAAAAAAAA");
    expect(request.path).toBe(`/model/${encodeURIComponent(ID_A)}/invoke-with-response-stream`);
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(request.key).toMatch(/^byo-bedrock-[0-9a-f-]{36}$/u);
    expect(JSON.parse(Buffer.from(request.body).toString("utf8"))).toEqual({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, messages: requestBody.messages, max_tokens: requestBody.max_tokens, anthropic_beta: ["interleaved-thinking-2025-05-14"] });
    // The session is the verified company's own row.
    expect(g.sessions.asked).toEqual([{ row: { iss: claims.iss, cid: cidA, owner: "_company", sourceId: "src_bedrock", versionId: "11111111-1111-4111-8111-111111111111" }, roleArn: ROLE(cidA) }]);
    // Customer pays AWS: no billable line.
    expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
  });

  it("prices at the dearer of the Bedrock row and the Anthropic row of the model it stands for, and counts under the company's spend", async () => {
    const g = gateway({ bedrock: () => async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 100, output_tokens: 10 } })); })() }), anthropicPrice: 4_000_000 });
    g.choices.saved.set(cidA, "bedrock_byo");
    expect((await call(g.deps, { ...requestBody, stream: false })).status).toBe(200);
    expect(g.priced).toEqual([["bedrock", ID_A], ["anthropic", MODEL]]);
    // input at max(3.3, 4.0) = $4/M, output $15/M: 100 x 4 + 10 x 15 = 550 micro-dollars.
    expect(await committed(g.meter)).toBe(550);
  });

  it("two companies on their own Bedrock never meet: each its own connection, Region, role and session; B's key company unaffected", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "bedrock_byo"); g.choices.saved.set(cidB, "bedrock_byo");
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.read).toEqual([cidA, cidB]);
    expect(g.sent.map((s) => [s.region, s.request.path, s.credentials.accessKeyId])).toEqual([
      ["eu-west-1", `/model/${encodeURIComponent(ID_A)}/invoke-with-response-stream`, "ASIAAAAAAAAAAAAAAAAA"],
      ["us-west-2", `/model/${encodeURIComponent(ID_B)}/invoke-with-response-stream`, "ASIABBBBBBBBBBBBBBBB"],
    ]);
    expect(g.sessions.asked.map((a) => [a.row.cid, a.roleArn])).toEqual([[cidA, ROLE(cidA)], [cidB, ROLE(cidB)]]);
    expect(await committed(g.meter, cidA)).toBeGreaterThan(0);
    expect(await committed(g.meter, cidB)).toBeGreaterThan(0);
    // B switches to its own Anthropic key: only B's key is read, A's Bedrock untouched.
    g.choices.saved.set(cidB, "anthropic_key");
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.companyKeys.reads).toEqual([cidB]);
    expect(g.sent).toHaveLength(2);
  });

  it("no connection saved: refused before any hold, never sent on its key or anywhere else", async () => {
    const g = gateway({ connections: new Map([[cidB, conn(cidB)]]) });
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: BYO_BEDROCK_NOT_CONNECTED.code, message: BYO_BEDROCK_NOT_CONNECTED.message });
    expect(g.sent).toEqual([]); expect(g.keySent).toEqual([]); expect(g.companyKeys.reads).toEqual([]); expect(g.sessions.asked).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
    g.choices.saved.set(cidB, "bedrock_byo");
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
  });

  it("a gateway without BYO Bedrock refuses the choice (no fallback), and an unreadable connection is the fixed 503", async () => {
    const off = gateway({ byo: false });
    off.choices.saved.set(cidA, "bedrock_byo");
    expect(error(await call(off.deps))).toEqual({ type: AGENT_SOURCE_NOT_OFFERED.code, message: AGENT_SOURCE_NOT_OFFERED.message });
    expect(off.keySent).toEqual([]);
    const broken = gateway();
    broken.choices.saved.set(cidA, "bedrock_byo");
    (broken.deps.agentAi!.byo as ByoBedrock).connection = async () => { throw new Error("store down"); };
    const sink = await call(broken.deps);
    expect(sink.status).toBe(503);
    expect(broken.sent).toEqual([]); expect(await committed(broken.meter)).toBe(0);
  });

  it("only a model the company picked: another is refused before any hold", async () => {
    const g = gateway({ connections: new Map([[cidA, { ...conn(cidA), models: { "claude-opus-5-5": "eu.anthropic.claude-opus-5-5" } }]]) });
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(sink.status).toBe(400);
    expect(error(sink)).toEqual({ type: BYO_BEDROCK_MODEL.code, message: BYO_BEDROCK_MODEL.message });
    expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
  });

  it("the role refused at assume time: free, says to test the connection, recorded on the settings page", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "bedrock_byo"); g.choices.saved.set(cidB, "bedrock_byo");
    g.sessions.result = (cid) => cid === cidA ? { ok: false, reason: "refused" } : new Sessions().result(cid);
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message });
    expect(g.sent).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
    expect(g.refused).toEqual([cidA]);
    // An STS outage: the fixed 503, free, and not recorded as a refusal.
    g.sessions.result = () => ({ ok: false, reason: "unavailable" });
    expect((await call(g.deps)).status).toBe(503);
    expect(g.refused).toEqual([cidA]);
    expect(await committed(g.meter)).toBe(0);
    // B is unaffected by A's refusal.
    g.sessions.result = (cid) => new Sessions().result(cid);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
  });

  it("Bedrock refusals are free: 'model not enabled yet' in its own words; any other 401/403 forgets the session", async () => {
    const notEnabled = '{"message":"Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:Subscribe)."}';
    const g = gateway({ bedrock: () => failing(403, notEnabled) });
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: BYO_BEDROCK_MODEL_NOT_ENABLED.code, message: BYO_BEDROCK_MODEL_NOT_ENABLED.message });
    expect(sink.text()).not.toContain("Marketplace");
    expect(await committed(g.meter)).toBe(0);
    for (const status of [401, 403]) {
      const h = gateway({ bedrock: () => failing(status, '{"message":"not authorized to perform: bedrock:InvokeModel on arn:aws:bedrock:secret"}') });
      h.choices.saved.set(cidA, "bedrock_byo");
      const refused = await call(h.deps);
      expect(error(refused)).toEqual({ type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message });
      expect(refused.text()).not.toContain("arn:aws");
      expect(h.sessions.forgotten.map((r) => r.cid)).toEqual([cidA]);
      expect(await committed(h.meter)).toBe(0);
    }
    for (const status of [400, 500, 503]) {
      const h = gateway({ bedrock: () => failing(status) });
      h.choices.saved.set(cidA, "bedrock_byo");
      expect((await call(h.deps)).status).toBe(502);
      expect(await committed(h.meter)).toBe(0);
    }
  });

  it("a Bedrock throttle in the company's own account (a model whose quota is 0 there) names the quota and the Region, free", async () => {
    const canary = '{"message":"Too many tokens. arn:aws:bedrock:eu-west-1:111111111111:inference-profile/secret"}';
    const g = gateway({ bedrock: () => failing(429, canary) });
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    const quota = byoBedrockQuota("eu-west-1");
    expect(sink.status).toBe(429);
    expect(error(sink)).toEqual({ type: quota.code, message: quota.message });
    expect(quota.message).toContain("eu-west-1");
    expect(quota.message).toMatch(/quota/u);
    expect(sink.text()).not.toContain("arn:aws");
    expect(await committed(g.meter)).toBe(0);
    expect(g.sessions.forgotten).toEqual([]);
    expect(byoBedrockQuota("us-west-2").message).toContain("us-west-2");
  });

  it("review: the own-Bedrock throttle is logged as the fixed reason bedrock_429 (payer bedrock_byo), never with AWS text", async () => {
    const logs: unknown[] = [];
    const g = gateway({ bedrock: () => failing(429, '{"message":"BYO-CANARY Too many tokens"}'), overrides: { log: (line) => { logs.push(line); } } });
    g.choices.saved.set(cidA, "bedrock_byo");
    expect((await call(g.deps)).status).toBe(429);
    expect(logs.filter((line) => (line as { event?: unknown }).event === "refused")).toEqual([
      { event: "refused", code: "rate_limit_error", status: 429, upstreamStatus: 429, route: "agent", payer: "bedrock_byo", reason: "bedrock_429" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("BYO-CANARY");
  });

  it("the one combined company cap applies", async () => {
    const g = gateway({ overrides: { caps: new FixedCapsSource({ ...caps, companyMonth: 1 }) } });
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(sink.status).toBe(422);
    expect(error(sink)).toEqual({ type: "budget_exceeded", message: "Budget has been exceeded! Team=company" });
    expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]);
  });
});

// DEC 254zzz524: the company's own Bedrock for the AGENTS on beta and production. The per-environment source-kind list
// (ops/pipeline/switches.json `aiSourceKinds`, GATEWAY_AI_SOURCE_KINDS) is the only switch; these tests run the agent route with the very kinds each row names.
const kindsOf = (env: "beta" | "production") => parseAiSourceKinds(loadSwitches().environments[env].aiSourceKinds);
const withoutBedrock = (env: "beta" | "production") => new Set([...kindsOf(env)].filter((kind) => kind !== "bedrock"));
describe.each(AGENT_ENVS)("agent route on the company's own Bedrock with %s's source kinds (DEC 254zzz524)", (env) => {
  const switchedOn = kindsOf(env);
  const own = (extra: Parameters<typeof gateway>[0] = {}) => { const g = gateway({ switchedOn, ...extra }); g.choices.saved.set(cidA, "bedrock_byo"); return g; };

  it("the row names bedrock, and that is what lets the agents' own-Bedrock source through (and only that)", () => {
    expect(switchedOn.has("bedrock")).toBe(true);
    expect(agentSourceSwitchedOn("bedrock_byo", switchedOn)).toBe(true);
    expect(agentSourceSwitchedOn("bedrock_byo", withoutBedrock(env))).toBe(false);
    expect(withoutBedrock(env).size).toBeGreaterThan(0);
  });

  it("an agent call goes through the company's role to Bedrock in its Region, picked model only, no key, no Rovara account, no billable line", async () => {
    const g = own();
    const sink = await call(g.deps);
    expect(sink.status).toBe(200);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]!.region).toBe("eu-west-1");
    expect(g.sent[0]!.request.path).toBe(`/model/${encodeURIComponent(ID_A)}/invoke-with-response-stream`);
    expect(g.sent[0]!.request.key).toMatch(/^byo-bedrock-[0-9a-f-]{36}$/u);
    expect(g.sessions.asked.map((a) => [a.row.cid, a.roleArn])).toEqual([[cidA, ROLE(cidA)]]);
    expect(g.keySent).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
  });

  it("metering: list price (the dearer of the Bedrock and Anthropic rows) under the company's spend; no bill line", async () => {
    const usage = () => async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 100, output_tokens: 10 } })); })() });
    const g = own({ bedrock: usage, anthropicPrice: 4_000_000 });
    expect((await call(g.deps, { ...requestBody, stream: false })).status).toBe(200);
    expect(g.priced).toEqual([["bedrock", ID_A], ["anthropic", MODEL]]);
    expect(await committed(g.meter)).toBe(550);
    expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
    // The Bedrock row dearer than the Anthropic row: the Bedrock row is the list price.
    const dearer = own({ bedrock: usage, anthropicPrice: 1_000_000 });
    expect((await call(dearer.deps, { ...requestBody, stream: false })).status).toBe(200);
    expect(await committed(dearer.meter)).toBe(Math.ceil((100 * 3_300_000 + 10 * 15_000_000) / 1_000_000));
  });

  it("the one combined company cap holds before any role session or send", async () => {
    const g = own({ overrides: { caps: new FixedCapsSource({ ...caps, companyMonth: 1 }) } });
    const sink = await call(g.deps);
    expect(sink.status).toBe(422);
    expect(error(sink)).toEqual({ type: "budget_exceeded", message: "Budget has been exceeded! Team=company" });
    expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]);
  });

  it("refusal words, all free and before any hold: no role connected, a model not picked, the role refused at assume time, Bedrock refusing the role, model not enabled", async () => {
    const none = own({ connections: new Map([[cidB, conn(cidB)]]) });
    let sink = await call(none.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_NOT_CONNECTED.code, message: BYO_BEDROCK_NOT_CONNECTED.message }]);
    expect(none.sent).toEqual([]); expect(none.sessions.asked).toEqual([]); expect(await committed(none.meter)).toBe(0);

    const unpicked = own({ connections: new Map([[cidA, { ...conn(cidA), models: { "claude-opus-5-5": "eu.anthropic.claude-opus-5-5" } }]]) });
    sink = await call(unpicked.deps);
    expect([sink.status, error(sink)]).toEqual([400, { type: BYO_BEDROCK_MODEL.code, message: BYO_BEDROCK_MODEL.message }]);
    expect(unpicked.sent).toEqual([]); expect(unpicked.sessions.asked).toEqual([]); expect(await committed(unpicked.meter)).toBe(0);

    const denied = own();
    denied.sessions.result = () => ({ ok: false, reason: "refused" });
    sink = await call(denied.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message }]);
    expect(denied.sent).toEqual([]); expect(denied.refused).toEqual([cidA]); expect(await committed(denied.meter)).toBe(0);

    const awsDenied = own({ bedrock: () => failing(403, '{"message":"not authorized to perform: bedrock:InvokeModel on arn:aws:bedrock:secret"}') });
    sink = await call(awsDenied.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message }]);
    expect(sink.text()).not.toContain("arn:aws");
    expect(awsDenied.sessions.forgotten.map((r) => r.cid)).toEqual([cidA]); expect(await committed(awsDenied.meter)).toBe(0);

    const notEnabled = own({ bedrock: () => failing(403, '{"message":"Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:Subscribe)."}') });
    sink = await call(notEnabled.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_MODEL_NOT_ENABLED.code, message: BYO_BEDROCK_MODEL_NOT_ENABLED.message }]);
    expect(await committed(notEnabled.meter)).toBe(0);
  });

  it("with the kinds minus bedrock the same saved choice is refused before anything is read, held or sent (the list is the switch)", async () => {
    const g = own({ switchedOn: withoutBedrock(env) });
    const sink = await call(g.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message }]);
    expect(g.read).toEqual([]); expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]); expect(g.keySent).toEqual([]); expect(await committed(g.meter)).toBe(0);
  });

  it("DEC 254zzz525: a connected role with NO saved choice never uses Bedrock: the agent call goes to Rovara's AI as today (an own Anthropic key still precedes it)", async () => {
    // The company's role is connected (the gateway can read it) but nothing is saved: the call is Rovara AI's, never the role's.
    const rovaraSent: ProviderRequest[] = [];
    const g = gateway({ switchedOn });
    g.companyKeys.connected = async () => false; // no own Anthropic key
    g.deps.agentAi = { ...g.deps.agentAi!, rovara: { models: new Map([[MODEL, "us.anthropic.claude-sonnet-4-5"]]), exempt: new Set<string>(), transport: async (request: ProviderRequest) => { rovaraSent.push(request); return { status: 200, body: answer() }; } } };
    const sink = await call(g.deps);
    expect(sink.status).toBe(200);
    expect(rovaraSent).toHaveLength(1);
    expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]); expect(g.read).toEqual([]);
    const ports = (keyConnected: boolean) => ({ sources: { sourceFor: async () => undefined }, keys: { connected: async () => keyConnected, bedrockConnected: async () => true } });
    expect(await resolveAgentSource(ports(false), claims.iss, cidA)).toEqual({ source: "rovara", via: "default" });
    expect(await resolveAgentSource(ports(true), claims.iss, cidA)).toEqual({ source: "anthropic_key", via: "own_key" });
  });

  it("DEC 254zzz525: an EXPLICIT choice with the role connected uses Bedrock; with the role missing or refused it is refused in the company's words and NEVER falls back to Rovara's AI (Rovara would pay)", async () => {
    const rovara = (sent: ProviderRequest[]) => ({ models: new Map([[MODEL, "us.anthropic.claude-sonnet-4-5"]]), exempt: new Set<string>(), transport: (async (request: ProviderRequest) => { sent.push(request); return { status: 200, body: answer() }; }) as ProviderTransport });
    const withRovara = (g: ReturnType<typeof gateway>, sent: ProviderRequest[]) => { g.deps.agentAi = { ...g.deps.agentAi!, rovara: rovara(sent) }; return g; };
    const sent: ProviderRequest[] = [];
    const ok = withRovara(own(), sent);
    expect((await call(ok.deps)).status).toBe(200);
    expect(ok.sent).toHaveLength(1); expect(sent).toEqual([]);
    const missing = withRovara(own({ connections: new Map([[cidB, conn(cidB)]]) }), sent);
    let sink = await call(missing.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_NOT_CONNECTED.code, message: BYO_BEDROCK_NOT_CONNECTED.message }]);
    const refusedRole = own();
    refusedRole.sessions.result = () => ({ ok: false, reason: "refused" });
    sink = await call(withRovara(refusedRole, sent).deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message }]);
    const awsRefused = withRovara(own({ bedrock: () => failing(403, '{"message":"not authorized"}') }), sent);
    sink = await call(awsRefused.deps);
    expect([sink.status, error(sink)]).toEqual([403, { type: BYO_BEDROCK_REFUSED.code, message: BYO_BEDROCK_REFUSED.message }]);
    expect(sent).toEqual([]);
    expect(await committed(missing.meter) + await committed(refusedRole.meter) + await committed(awsRefused.meter)).toBe(0);
  });
});

describe("the deployed ByoBedrock over the key store", () => {
  it("opens only the asking company's connection; a removed source is not connected; an unreadable one throws", async () => {
    const opened: Array<[string, string]> = [];
    const store = {
      companyBedrock: async (_iss: string, cid: string) => cid === cidA ? { sourceId: "src_bedrock", owner: "_company", provider: "bedrock" as const, caps: { taskMicros: 1, projectMonthMicros: 1 }, versionId: "v1" } : undefined,
      useKey: async (_iss: string, cid: string) => { opened.push([cid, "v1"]); return JSON.stringify(conn(cidA)); },
      recordWarning: async () => undefined,
    };
    const byo = storedBedrock(store, new Sessions());
    expect((await byo.connection(claims.iss, cidA))?.connection.roleArn).toBe(ROLE(cidA));
    expect(await byo.connection(claims.iss, cidB)).toBeUndefined();
    expect(opened).toEqual([[cidA, "v1"]]);
    const gone = storedBedrock({ ...store, useKey: async () => undefined }, new Sessions());
    expect(await gone.connection(claims.iss, cidA)).toBeUndefined();
    const bad = storedBedrock({ ...store, useKey: async () => "{}" }, new Sessions());
    await expect(bad.connection(claims.iss, cidA)).rejects.toThrow();
  });
});

// ---- the process ----------------------------------------------------------------------------------------------------------
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:111122223333:secret:rovara-cloud/test/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: "gwp-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:111122223333:key/0b5d3f9e-1111-2222-3333-444455556666",
  [GATEWAY_ENV.productMeterTable]: "gwp-meter", [GATEWAY_ENV.productLedgerTable]: "gwp-ledger", [GATEWAY_ENV.productMarkersTable]: "gwp-markers", [GATEWAY_ENV.evalStagesTable]: "gwp-stages",
};
const VERTEX_ENV = { [GATEWAY_ENV.vertexFederationRole]: "arn:aws:iam::111122223333:role/vertex", [GATEWAY_ENV.productMacKey]: "arn:aws:kms:us-west-2:111122223333:key/0b5d3f9e-1111-2222-3333-4444555566aa" };
const BYO_ENV = { [GATEWAY_ENV.bedrockBrokerRole]: "arn:aws:iam::111122223333:role/RovaraBedrockBroker-staging", [GATEWAY_ENV.bedrockExternalIdKey]: "arn:aws:kms:us-west-2:111122223333:key/0b5d3f9e-1111-2222-3333-4444555566bb" };
const COMPANY_MODE = { ...ENV, ...PRODUCT_ENV, ...VERTEX_ENV, [GATEWAY_ENV.agentKeys]: "company" };

describe("gateway settings GATEWAY_BEDROCK_BROKER_ROLE / _EXTERNAL_ID_KEY", () => {
  it("absent: off; both set in company-key mode with the MAC key: on", () => {
    expect(Object.hasOwn(readGatewayConfig(COMPANY_MODE) as ServeConfig, "bedrockByo")).toBe(false);
    expect((readGatewayConfig({ ...COMPANY_MODE, ...BYO_ENV }) as ServeConfig).bedrockByo).toEqual({ brokerRoleArn: BYO_ENV[GATEWAY_ENV.bedrockBrokerRole], externalIdKeyArn: BYO_ENV[GATEWAY_ENV.bedrockExternalIdKey] });
  });
  it("never alone, never outside company-key mode or without the MAC key; malformed refused by name", () => {
    expect(() => readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.bedrockBrokerRole]: BYO_ENV[GATEWAY_ENV.bedrockBrokerRole] })).toThrow(new GatewayConfigError(GATEWAY_ENV.bedrockExternalIdKey));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.bedrockExternalIdKey]: BYO_ENV[GATEWAY_ENV.bedrockExternalIdKey] })).toThrow(new GatewayConfigError(GATEWAY_ENV.bedrockBrokerRole));
    expect(() => readGatewayConfig({ ...ENV, ...PRODUCT_ENV, ...VERTEX_ENV, ...BYO_ENV })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
    expect(() => readGatewayConfig({ ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.agentKeys]: "company", ...BYO_ENV })).toThrow(new GatewayConfigError(GATEWAY_ENV.productMacKey));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, ...BYO_ENV, [GATEWAY_ENV.bedrockBrokerRole]: "arn:aws:iam::111122223333:role/AnyRole" })).toThrow(new GatewayConfigError(GATEWAY_ENV.bedrockBrokerRole));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, ...BYO_ENV, [GATEWAY_ENV.bedrockExternalIdKey]: "alias/x" })).toThrow(new GatewayConfigError(GATEWAY_ENV.bedrockExternalIdKey));
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("gateway process: each company's own Bedrock from its saved choice", () => {
  async function serve(byoOn: boolean, priced = false, kinds?: ReadonlySet<string>) {
    const wire = new WireDynamo(Object.values(TABLES), { namespaceTables: true });
    const credentials = async () => ({ accessKeyId: "AKIATEST", secretAccessKey: "x" });
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    for (const cid of [cidA, cidB]) await db.put(TABLES.companies, { pk: `COMPANY#${cid}`, sk: "SETTINGS", companyId: cid, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    await db.put(TABLES.companies, { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "bedrock_byo", version: 1 });
    await db.put(TABLES.companies, { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "anthropic_key", version: 1 });
    if (priced) expect(await new DynamoPriceSnapshotStore(db, TABLES.prices).save({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 2, entries: [ID_A, ID_B].map(model => ({ provider: "bedrock", model, kind: "chat" as const, inputMicrosPerMTok: 3_300_000, outputMicrosPerMTok: 15_000_000 })) } } }, 0)).toBe(true);
    const g = gateway();
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0, agentKeys: "company", ...(byoOn ? { bedrockByo: { brokerRoleArn: BYO_ENV[GATEWAY_ENV.bedrockBrokerRole], externalIdKeyArn: BYO_ENV[GATEWAY_ENV.bedrockExternalIdKey] } } : {}), ...(kinds === undefined ? {} : { aiSourceKinds: kinds }) };
    const started = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "rovara-install-key" }, agentKeys: g.companyKeys, byoBedrock: g.deps.agentAi!.byo!,
      transport: async (request) => { g.keySent.push(request); return { status: 200, body: answer() }; },
    });
    running.push(started);
    return { started, g };
  }
  function post(server: RunningGateway["server"], token: string, url = "/v1/messages"): Promise<FakeResponse> {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": token } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    server.emit("request", req, res);
    return done;
  }

  it("A goes to its own Bedrock; B on its own key; neither touches the other", async () => {
    const s = await serve(true, true);
    expect((await post(s.started.server, mint({ cid: cidA }))).statusCode).toBe(200);
    expect((await post(s.started.server, mint({ cid: cidB }))).statusCode).toBe(200);
    expect(s.g.sent.map((x) => x.region)).toEqual(["eu-west-1"]);
    expect(s.g.companyKeys.reads).toEqual([cidB]);
  });

  it("no authoritative snapshot: A is refused before STS or transport; B on its own key works", async () => {
    const s = await serve(true);
    expect((await post(s.started.server, mint({ cid: cidA }))).statusCode).toBe(409);
    expect(s.g.sessions.asked).toEqual([]); expect(s.g.sent).toEqual([]);
    expect((await post(s.started.server, mint({ cid: cidB }))).statusCode).toBe(200);
  });

  for (const env of AGENT_ENVS) {
    it(`DEC 254zzz524 (${env}'s source kinds): the deployed process sends A's agent call to its own Bedrock; with the kinds minus bedrock it is refused before STS or transport`, async () => {
      const s = await serve(true, true, kindsOf(env));
      expect((await post(s.started.server, mint({ cid: cidA }))).statusCode).toBe(200);
      expect(s.g.sent.map((x) => x.region)).toEqual(["eu-west-1"]);
      expect(s.g.sessions.asked.map((a) => a.row.cid)).toEqual([cidA]);
      expect((await post(s.started.server, mint({ cid: cidB }))).statusCode).toBe(200);
      expect(s.g.companyKeys.reads).toEqual([cidB]);
      const off = await serve(true, true, withoutBedrock(env));
      const refused = await post(off.started.server, mint({ cid: cidA }));
      expect(JSON.parse(refused.text())).toEqual({ error: { type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message } });
      expect(off.g.sent).toEqual([]); expect(off.g.sessions.asked).toEqual([]);
    });
  }

  it("not configured: A is refused (no fallback), B unaffected; the Bedrock service paths are not served", async () => {
    const s = await serve(false);
    const refused = await post(s.started.server, mint({ cid: cidA }));
    expect(JSON.parse(refused.text())).toEqual({ error: { type: AGENT_SOURCE_NOT_OFFERED.code, message: AGENT_SOURCE_NOT_OFFERED.message } });
    expect((await post(s.started.server, mint({ cid: cidB }))).statusCode).toBe(200);
    expect(s.g.sent).toEqual([]);
    expect((await post(s.started.server, mint({ cid: cidA }), "/v1/service/bedrock-setup")).statusCode).toBe(404);
  });
});

it("DEC 328: own Bedrock calls never read the paused install setting", async () => {
  let reads = 0;
  const g = gateway({ overrides: { rovaraAiSetting: { enabled: async () => { reads++; return false; } } } });
  g.choices.saved.set(cidA, "bedrock_byo");
  expect((await call(g.deps)).status).toBe(200);
  expect(reads).toBe(0);
  expect(g.sent).toHaveLength(1);
  expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
});
