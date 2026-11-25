// RF-5 (route A): the eval's Bedrock calls. Worker, then the Cloud gateway's Bedrock product route (outside the stage's hold, per-call holds at the gateway), then the company's own AWS role.
// No network and no AWS: every request goes to an injected fetch that answers like the gateway contract. The real model helper (the HTTP loop), the real bridge and the real stage meter are in the loop for the end-to-end test.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_BEDROCK_COST_WORDS, EVAL_BEDROCK_ROW, EVAL_DRAFT_PROVIDERS, EVAL_PRODUCT_ROWS, EvalDiscoverySuiteSchema, attestRovaraOnlyBaseCheckout, evalJudgePinOf, evalProductRowLabel, evalCommandFingerprintOf,
  type EvalSpendGrant, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressScope,
} from "@agentx/contracts";
import { createEvalGatewayAccess, EVAL_GATEWAY_SCOPE_HEADER } from "../../packages/worker/src/verification/eval-gateway-access.js";
import { createEvalMeter, type EvalModelHold } from "../../packages/worker/src/verification/eval-model-access.js";
import { openMeteredStage } from "../../packages/worker/src/verification/eval-spend-guard.js";
import { modelEgressFromEvalCall } from "../../packages/worker/src/verification/eval-runner.js";
import { createBridgedEvalExec, type FreshEvalSandbox, type FreshEvalSandboxRun } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { evalModelPathPattern } from "../../packages/worker/src/verification/eval-wiring.js";
import { bridgeModelBackend } from "../../packages/worker/src/model-helper-bridge-backend.js";
import { parseModelTarget } from "../../packages/worker/src/model-helper-http.js";
import { evalApprovalSentence } from "../../packages/broker/src/core/setup-agent/eval-cost.js";
import { startWorld, type World } from "../support/model-helper-world.js";

const GATEWAY = "https://gateway.example.test";
const TASK_TOKEN = "task-token-abcdefghijklmnop";
const SCOPE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MODEL = "us.anthropic.claude-sonnet-4-6-v1:0";
const ENCODED = "us.anthropic.claude-sonnet-4-6-v1%3A0";
const grant: EvalSpendGrant = { company: "company-a", project: "project-a", selection: "eval", role: "owner", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
const enc = new TextEncoder();
const bedrockFrame = (over: Partial<ModelEgressFrame> = {}): ModelEgressFrame => ({
  row: "bedrock", method: "POST", path: `/model/${ENCODED}/converse`, query: "",
  headers: [["content-type", "application/json"], ["accept", "application/json"], ["authorization", "AWS4-HMAC-SHA256 Credential=x"], ["x-amz-date", "20261125T000000Z"], ["x-amz-security-token", "t"], ["x-rovara-eval-scope", "forged"]],
  body: enc.encode('{"messages":[]}'), ...over,
});
const geminiFrame = (): ModelEgressFrame => ({ row: "gemini", method: "POST", path: "/v1beta/models/gemini-2.5-flash:generateContent", query: "", headers: [["content-type", "application/json"]], body: enc.encode("{}") });

interface Sent { url: string; path: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal | undefined }
type Answer = (sent: Sent, index: number) => Response | Promise<Response>;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A gateway: the stage hold and release, the Gemini route (one NDJSON answer) and the Bedrock route (`bedrock`). Records every request. */
function gateway(bedrock: Answer = () => json({ output: {} })) {
  const sent: Sent[] = []; let calls = 0; let open = 0; let peak = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = init?.body instanceof Uint8Array ? init.body : typeof init?.body === "string" ? enc.encode(init.body) : new Uint8Array(0);
    const s: Sent = { url, path: new URL(url).pathname, headers, body, signal: init?.signal ?? undefined };
    sent.push(s);
    if (s.path === "/v1/product/eval/hold") { const asked = JSON.parse(new TextDecoder().decode(body)) as { calls: number; costMicros: number }; return json({ scope: SCOPE, calls: asked.calls, costMicros: asked.costMicros, expiresAt: 1 }); }
    if (s.path === "/v1/product/eval/release") return json({ released: 0 });
    if (s.path.startsWith("/v1/product/bedrock/")) { open++; peak = Math.max(peak, open); try { return await bedrock(s, calls++); } finally { open--; } }
    const lines = [{ kind: "head", status: 200, headers: [["content-type", "application/json"]] }, { kind: "chunk", b64: Buffer.from("{}").toString("base64") }, { kind: "settle", status: 200, class: "ok", costMicros: 10, estimated: false }];
    return new Response(lines.map(l => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  const bedrockSent = () => sent.filter(s => s.path.startsWith("/v1/product/bedrock/"));
  const releases = () => sent.filter(s => s.path === "/v1/product/eval/release").map(s => JSON.parse(new TextDecoder().decode(s.body)) as { scope: string; calls: number; costMicros: number; unknown: boolean });
  return { fetchImpl, sent, bedrockSent, releases, peak: () => peak };
}
const accessOf = (g: ReturnType<typeof gateway>) => createEvalGatewayAccess(GATEWAY, async () => TASK_TOKEN, { fetch: g.fetchImpl });
async function holdOf(g: ReturnType<typeof gateway>, calls = 5, costMicros = 500): Promise<EvalModelHold> {
  const hold = await accessOf(g).hold({ grant, calls, costMicros });
  if (hold === undefined) throw new Error("no hold");
  return hold;
}
async function events(hold: EvalModelHold, frame: ModelEgressFrame = bedrockFrame(), scope: ModelEgressScope = hold.scope, signal?: AbortSignal): Promise<ModelEgressEvent[]> {
  const out: ModelEgressEvent[] = [];
  for await (const e of hold.egress.forward(scope, frame, signal === undefined ? undefined : { signal })) out.push(e);
  return out;
}
const settleOf = (list: ModelEgressEvent[]) => list[list.length - 1] as Extract<ModelEgressEvent, { kind: "settle" }>;
const textOf = (list: ModelEgressEvent[]): string => Buffer.concat(list.flatMap(e => (e.kind === "chunk" ? [e.bytes] : []))).toString("utf8");
const eventStream = (chunks: Uint8Array[]): Response => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
/** Bytes that are not valid UTF-8 and split a multibyte sequence across chunks, like an event stream's binary frames. */
const BINARY = [Uint8Array.from([0, 0, 0, 77, 0, 0, 0, 40, 255, 254, 195]), Uint8Array.from([169, 128, 0, 1, 2, 253])];

describe("the Bedrock lane of the stage's hold egress", () => {
  it("sends a Bedrock call to the gateway's Bedrock product route with the task token alone: no scope header, no sandbox credential, the model id decoded once, and settles cost 0 with the call counted", async () => {
    const g = gateway(); const hold = await holdOf(g);
    const out = await events(hold);
    expect(g.bedrockSent()).toHaveLength(1);
    const call = g.bedrockSent()[0]!;
    expect(call.url).toBe(`${GATEWAY}/v1/product/bedrock/model/${MODEL}/converse`);
    expect(call.headers).toEqual({ "content-type": "application/json", accept: "application/json", "x-api-key": TASK_TOKEN });
    expect(call.headers[EVAL_GATEWAY_SCOPE_HEADER]).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toMatch(/authorization|x-amz|forged/iu);
    expect(settleOf(out)).toMatchObject({ class: "ok", costMicros: 0 });
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(g.releases()).toEqual([{ scope: SCOPE, calls: 1, costMicros: 0, unknown: false }]);
  });
  it("a Gemini call in the same hold still goes under the stage's scope header and is the only one whose cost is on the line", async () => {
    const g = gateway(); const hold = await holdOf(g);
    await events(hold, geminiFrame());
    await events(hold);
    const gemini = g.sent.find(s => s.path.startsWith("/v1/product/gemini/"))!;
    expect(gemini.headers[EVAL_GATEWAY_SCOPE_HEADER]).toBe(SCOPE);
    expect(g.bedrockSent()).toHaveLength(1);
    await hold.release({ calls: 2, costMicros: 10, unknown: false });
    expect(g.releases()[0]).toMatchObject({ calls: 2, costMicros: 10, unknown: false });
  });
  it("hands binary event-stream bytes on untouched, split multibyte sequences included", async () => {
    const g = gateway(() => eventStream(BINARY)); const hold = await holdOf(g);
    const out = await events(hold, bedrockFrame({ path: `/model/${ENCODED}/converse-stream` }));
    expect(out[0]).toMatchObject({ kind: "head", status: 200, headers: [["content-type", "application/vnd.amazon.eventstream"]] });
    expect(Buffer.concat(out.flatMap(e => (e.kind === "chunk" ? [e.bytes] : [])))).toEqual(Buffer.concat(BINARY));
    expect(settleOf(out)).toMatchObject({ class: "ok", costMicros: 0 });
  });
  it("calls go one at a time (the gateway admits one call in flight per company and source), in the order they came", async () => {
    const order: string[] = [];
    const g = gateway(async (_s, index) => { order.push(`start-${String(index)}`); await new Promise(resolve => setTimeout(resolve, 20)); order.push(`end-${String(index)}`); return json({ output: {} }); });
    const hold = await holdOf(g);
    await Promise.all([events(hold), events(hold), events(hold)]);
    expect(g.peak()).toBe(1);
    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
  });
  it("the stage's second lines hold: a spent held count and a released hold refuse a Bedrock call with the cap words before anything is sent", async () => {
    const g = gateway(); const hold = await holdOf(g, 1, 100);
    await events(hold);
    const refused = await events(hold);
    expect(settleOf(refused)).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
    expect(JSON.parse(textOf(refused))).toHaveProperty("message");
    expect(g.bedrockSent()).toHaveLength(1);
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(settleOf(await events(hold)).class).toBe("cap");
    expect(g.bedrockSent()).toHaveLength(1);
  });
  it("a call the caller stops reading before its settle leaves the cost unknown: the release says so and nothing more is sent", async () => {
    const g = gateway(() => eventStream(BINARY)); const hold = await holdOf(g);
    for await (const event of hold.egress.forward(hold.scope, bedrockFrame())) { if (event.kind === "head") break; }
    expect(settleOf(await events(hold)).class).toBe("cap");
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(g.releases()[0]).toMatchObject({ unknown: true });
    expect(g.bedrockSent()).toHaveLength(1);
  });
  it("the product egress's own refusals reach the stage with fixed words and send nothing: a model ARN, a feature header, another operation, a query, a wrong scope", async () => {
    const g = gateway(); const hold = await holdOf(g);
    const cases: ModelEgressFrame[] = [
      bedrockFrame({ path: "/model/arn:aws:bedrock:us-east-1:acct:inference-profile%2Fx/converse" }),
      bedrockFrame({ headers: [["content-type", "application/json"], ["x-amzn-bedrock-guardrailidentifier", "g"]] }),
      bedrockFrame({ path: `/model/${ENCODED}/count-tokens` }),
      bedrockFrame({ query: "x=1" }),
      bedrockFrame({ method: "GET" }),
    ];
    for (const frame of cases) {
      const out = await events(hold, frame);
      expect(settleOf(out), JSON.stringify(frame.path)).toMatchObject({ class: "refused", costMicros: 0 });
    }
    expect(g.bedrockSent()).toEqual([]);
    expect(settleOf(await events(hold, bedrockFrame(), Object.freeze({}) as ModelEgressScope)).refusal).toBe("not_found");
  });
  it("never lets the task token out in an answer: an echo is cut and the call reads as a provider error", async () => {
    const g = gateway(() => eventStream([enc.encode(`xx${TASK_TOKEN.slice(0, 5)}`), enc.encode(`${TASK_TOKEN.slice(5)}yy`)]));
    const hold = await holdOf(g);
    const out = await events(hold);
    expect(Buffer.concat(out.flatMap(e => (e.kind === "chunk" ? [e.bytes] : []))).toString("latin1")).not.toContain(TASK_TOKEN);
    expect(settleOf(out).class).toBe("provider_error");
  });
});

describe("through the stage's meter: any Bedrock call that did not answer ok makes the round Not run", () => {
  const classOf = async (answer: Answer) => {
    const g = gateway(answer);
    const reservation = await createEvalMeter(accessOf(g)).reserve({ approval: grant, calls: 3, costMicros: 300 });
    const result = await reservation!.call(bedrockFrame());
    await reservation!.close();
    return { result, g };
  };
  it("an ok call is counted with cost 0 and its events; a hold release gives back everything", async () => {
    const { result, g } = await classOf(() => json({ output: {} }));
    expect(result).toMatchObject({ class: "ok", calls: 1, costMicros: 0 });
    expect(result.events).toBeDefined();
    expect(g.releases()).toEqual([{ scope: SCOPE, calls: 1, costMicros: 0, unknown: false }]);
  });
  it.each([
    ["provider_limited", 429, "rate_limit"], ["provider_quota", 429, "quota"], ["product_key_refused", 502, "key_refused"], ["budget_exceeded", 429, "cap"], ["busy", 429, "cap"],
  ] as const)("the gateway's %s answer (%i) is class %s and no events: the stage fails the round, never a failed question", async (type, status, cls) => {
    const { result } = await classOf(() => json({ error: { type, message: "x" } }, status));
    expect(result.class).toBe(cls);
    expect(result.events).toBeUndefined();
    expect(result.costMicros).toBe(0);
  });
  it("the stage guard turns the first non-ok Bedrock call into the round's one stated reason", async () => {
    const g = gateway(() => json({ error: { type: "provider_limited", message: "x" } }, 429));
    const stage = await openMeteredStage({ grant, meter: createEvalMeter(accessOf(g)), calls: 3, costMicros: 300 });
    await expect(stage!.call(bedrockFrame())).rejects.toThrow();
    await stage!.close();
    expect(stage!.failure()).toBe("rate_limit");
    expect(stage!.callFailure()).toBe("rate_limit");
    expect(stage!.usage()).toEqual({ calls: 1, costMicros: 0 });
  });
});

describe("the model pin for the bedrock row", () => {
  const pin = evalModelPathPattern(EVAL_BEDROCK_ROW, MODEL);
  it("takes the four product operations for the plan's model alone, with the colon literal or as an SDK writes it (%3A)", () => {
    for (const op of ["converse", "converse-stream", "invoke", "invoke-with-response-stream"]) {
      expect(pin.test(`/model/${ENCODED}/${op}`), op).toBe(true);
      expect(pin.test(`/model/${MODEL}/${op}`), op).toBe(true);
      expect(pin.test(`/model/${ENCODED.replace("%3A", "%3a")}/${op}`), op).toBe(true);
    }
  });
  it("refuses another model, another operation, a prefix or suffix of the id, an ARN, a dot segment, a query and the Google forms", () => {
    for (const path of [
      `/model/us.anthropic.claude-opus-5-v1%3A0/converse`, `/model/${ENCODED}/count-tokens`, `/model/${ENCODED}/converse/x`, `/model/x${ENCODED}/converse`, `/model/${ENCODED}x/converse`,
      `/model/us.anthropic.claude-sonnet-4-6-v1%3A01/converse`, `/model/arn:aws:bedrock:us-east-1:1:inference-profile%2Fx/converse`, `/model/../${ENCODED}/converse`, `/model/${ENCODED}/converse?x=1`,
      `/v1beta/models/${MODEL}:generateContent`, `/model/${ENCODED}`, `model/${ENCODED}/converse`,
    ]) expect(pin.test(path), path).toBe(false);
    expect(evalModelPathPattern("gemini", MODEL).test(`/model/${ENCODED}/converse`)).toBe(false);
    expect(evalModelPathPattern("vertex", MODEL).test(`/model/${ENCODED}/converse`)).toBe(false);
  });
  it("the pin for a model with no colon needs none, and a dot in an id is a dot (not any character)", () => {
    const plain = evalModelPathPattern(EVAL_BEDROCK_ROW, "amazon.nova-pro-v1");
    expect(plain.test("/model/amazon.nova-pro-v1/converse")).toBe(true);
    expect(plain.test("/model/amazonXnova-pro-v1/converse")).toBe(false);
  });
});

describe("the bedrock row in the eval contracts", () => {
  const hash = "a".repeat(64);
  const judge = { kind: "rule" as const, scoringPath: "evals/scoring.py" };
  it("is a row of its own that serves models of every vendor, is named for a person, and is a draft provider", () => {
    expect(EVAL_PRODUCT_ROWS[EVAL_BEDROCK_ROW]).toBe("bedrock");
    expect(evalProductRowLabel("bedrock")).toBe("Amazon Bedrock");
    expect([...EVAL_DRAFT_PROVIDERS]).toContain("bedrock");
    const pins = (row: string, j: Parameters<typeof evalJudgePinOf>[0]["judge"] = judge) => evalJudgePinOf({ catalogRowId: row, judge: j, scoringHash: hash });
    expect(pins("bedrock")).not.toBe(pins("gemini"));
    expect(pins("bedrock")).not.toBe(pins("vertex"));
    for (const model of ["us.anthropic.claude-sonnet-4-6-v1:0", "amazon.nova-pro-v1:0", "meta.llama3-1-70b-instruct-v1:0", "mistral.mistral-large-2407-v1:0"]) {
      expect(() => pins("bedrock", { kind: "model", model, version: "v1", scoringPath: "evals/scoring.py" }), model).not.toThrow();
    }
    expect(() => pins("bedrock", { kind: "model", model: "not-a-known-vendor-model", version: "v1", scoringPath: "evals/scoring.py" })).toThrow();
    // The Google rows still take Google models alone.
    expect(() => pins("gemini", { kind: "model", model: "us.anthropic.claude-sonnet-4-6-v1:0", version: "v1", scoringPath: "evals/scoring.py" })).toThrow();
  });
  it("a suite may name the bedrock row with a Bedrock model, and refuses a model no vendor family owns", () => {
    const command = { executable: "node", args: ["evals/run.js"], cwd: "." };
    const report = { cwd: ".", argument: "rovara-measures.json" };
    const suite = (over: Record<string, unknown> = {}) => ({
      selection: "evals/demo", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }], command, report, commandFingerprint: evalCommandFingerprintOf(command, report), judge,
      subsetSupported: true, catalogRowId: "bedrock", model: MODEL, modelVersion: "v1", image: `registry.example/worker@sha256:${"e".repeat(64)}`, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10, ...over,
    });
    expect(EvalDiscoverySuiteSchema.safeParse(suite()).success).toBe(true);
    expect(EvalDiscoverySuiteSchema.safeParse(suite({ model: "not-a-known-vendor-model" })).success).toBe(false);
    expect(EvalDiscoverySuiteSchema.safeParse(suite({ catalogRowId: "openai" })).success).toBe(false);
    expect(EvalDiscoverySuiteSchema.safeParse(suite({ catalogRowId: "gemini" })).success).toBe(false);
  });
  it("the approval sentence of a bedrock suite says whose cap counts the money; every other suite's sentence is as it was", () => {
    const dollars = { perCheckLowMicros: 100_000, perCheckHighMicros: 300_000, monthlyCapMicros: 5_000_000 };
    const plain = evalApprovalSentence(dollars);
    expect(plain).toBe(evalApprovalSentence(dollars, "gemini"));
    expect(plain).toBe(evalApprovalSentence(dollars, "vertex"));
    expect(plain).not.toContain("Bedrock");
    const bedrock = evalApprovalSentence(dollars, "bedrock");
    expect(bedrock).toContain(EVAL_BEDROCK_COST_WORDS);
    expect(EVAL_BEDROCK_COST_WORDS).toContain("counted by the company's gateway cap");
    expect(bedrock.endsWith("Approve?")).toBe(true);
  });
});

describe("the helper's path rule for a Bedrock model id", () => {
  it("lets %3A through (an AWS SDK writes the colon of a model id that way) and hands the path on exactly as it came, with the token segment parsed", () => {
    const token = "ab".repeat(16);
    const parsed = parseModelTarget(`/p/bedrock/x/${token}/model/${ENCODED}/converse`);
    expect(parsed).toMatchObject({ ok: true, target: { rowId: "bedrock", token, rest: `/model/${ENCODED}/converse`, query: "" } });
    // An encoded slash, dot or backslash in the id is still refused (it could change the path a later layer reads).
    for (const bad of ["%2F", "%2f", "%2e", "%5c", "%00"]) expect(parseModelTarget(`/p/bedrock/x/${token}/model/a${bad}b/converse`).ok, bad).toBe(false);
  });
});

describe("end to end: the sandbox's AWS client, the helper, the bridge, the stage and the gateway", () => {
  const roots: string[] = []; const worlds: World[] = [];
  afterEach(async () => {
    await Promise.all(worlds.splice(0).map(w => w.close()));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  const location = { root: "/r", cwd: ".", argument: "report.json", notBeforeMs: 1 };
  interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
  /** What the AWS SDK would send: a signed POST with the percent-encoded model id, to the endpoint the sandbox was given. */
  const post = (base: string, path: string, headers: Record<string, string>, body: string): Promise<Raw> => new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({ host: url.hostname, port: url.port, method: "POST", path, headers: { connection: "close", ...headers }, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
  const SIGNED = { "content-type": "application/json", authorization: "AWS4-HMAC-SHA256 Credential=rovara-test-key/20261125/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=abc", "x-amz-date": "20261125T000000Z", "x-amz-security-token": "dummy", "x-amz-content-sha256": "abc", "amz-sdk-invocation-id": "id", accept: "application/vnd.amazon.eventstream" };

  async function run(answer: Answer, paths: string[], over: { calls?: number } = {}) {
    const root = await mkdtemp(join(tmpdir(), "rf5-")); roots.push(root);
    const g = gateway(answer);
    const reservation = (await createEvalMeter(accessOf(g)).reserve({ approval: grant, calls: over.calls ?? 5, costMicros: 500 }))!;
    const pin = evalModelPathPattern(EVAL_BEDROCK_ROW, MODEL);
    const answers: Raw[] = [];
    const sandbox: FreshEvalSandbox = {
      available: () => true,
      async run(input: FreshEvalSandboxRun) {
        // The helper the sandbox reaches: the real HTTP loop in real mode over this run's bridge socket.
        const world = await startWorld({ mode: "real", backend: bridgeModelBackend(input.model.socketPath) }); worlds.push(world);
        for (const path of paths) answers.push(await post(world.base, `/p/bedrock/x/${input.model.token}${path}`, SIGNED, '{"messages":[{"role":"user","content":[{"text":"hi"}]}]}'));
        return { report: location, ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: "a".repeat(40) }) } : {}) };
      },
    };
    const exec = createBridgedEvalExec({ sandbox, runDir: root, modelAllowed: frame => frame.row === EVAL_BEDROCK_ROW && pin.test(frame.path) });
    const outcome = await exec.run({ side: "new", ids: ["q1"], runs: 1, egress: modelEgressFromEvalCall(frame => reservation.call(frame)), scope: Object.freeze({}) as unknown as ModelEgressScope, signal: new AbortController().signal }).then(result => ({ result }), (error: unknown) => ({ error }));
    await reservation.close();
    return { g, answers, outcome };
  }

  it("a Converse call with a %3A model id reaches the gateway's Bedrock route decoded, signed headers and the sandbox's key stripped, the task token only as x-api-key; the answer comes back whole; the release says one call at no cost", async () => {
    const { g, answers, outcome } = await run(() => json({ output: { message: { role: "assistant", content: [{ text: "ok" }] } }, usage: { inputTokens: 1, outputTokens: 1 } }), [`/model/${ENCODED}/converse`]);
    expect("result" in outcome && outcome.result.changedPromptCalls).toBe(1);
    expect(g.bedrockSent()).toHaveLength(1);
    expect(g.bedrockSent()[0]!.url).toBe(`${GATEWAY}/v1/product/bedrock/model/${MODEL}/converse`);
    expect(g.bedrockSent()[0]!.headers).toEqual({ "content-type": "application/json", accept: "application/vnd.amazon.eventstream", "x-api-key": TASK_TOKEN });
    expect(answers[0]!.status).toBe(200);
    expect(JSON.parse(answers[0]!.body.toString())).toMatchObject({ output: { message: { role: "assistant" } } });
    expect(g.releases()).toEqual([{ scope: SCOPE, calls: 1, costMicros: 0, unknown: false }]);
    // The task token never reached the sandbox: not in an answer's headers or body.
    for (const answer of answers) expect(JSON.stringify(answer.headers) + answer.body.toString("latin1")).not.toContain(TASK_TOKEN);
  });
  it("a ConverseStream answer reaches the sandbox as ONE buffered answer with its binary bytes untouched (the helper buffers the whole answer; only the content type passes)", async () => {
    const { answers, outcome } = await run(() => eventStream(BINARY), [`/model/${ENCODED}/converse-stream`]);
    expect("result" in outcome).toBe(true);
    expect(answers[0]!.status).toBe(200);
    expect(answers[0]!.headers["content-type"]).toBe("application/vnd.amazon.eventstream");
    expect(answers[0]!.body).toEqual(Buffer.concat(BINARY));
  });
  it("a call for another model never leaves the worker: the pin fails the run before the stage or the gateway sees it", async () => {
    const { g, outcome } = await run(() => json({}), [`/model/us.anthropic.claude-opus-5-v1%3A0/converse`]);
    expect("error" in outcome).toBe(true);
    expect(g.bedrockSent()).toEqual([]);
  });
  it("a gateway refusal (the provider's limit) fails the round at the stage: the exec's run is the stage's, not a failed question", async () => {
    const root = await mkdtemp(join(tmpdir(), "rf5-")); roots.push(root);
    const g = gateway(() => json({ error: { type: "provider_limited", message: "x" } }, 429));
    const stage = (await openMeteredStage({ grant, meter: createEvalMeter(accessOf(g)), calls: 3, costMicros: 300 }))!;
    const answers: Raw[] = [];
    const sandbox: FreshEvalSandbox = {
      available: () => true,
      async run(input) {
        const world = await startWorld({ mode: "real", backend: bridgeModelBackend(input.model.socketPath) }); worlds.push(world);
        answers.push(await post(world.base, `/p/bedrock/x/${input.model.token}/model/${ENCODED}/converse`, SIGNED, "{}"));
        return { report: location };
      },
    };
    const exec = createBridgedEvalExec({ sandbox, runDir: root, modelAllowed: () => true });
    await exec.run({ side: "new", ids: ["q1"], runs: 1, egress: modelEgressFromEvalCall(frame => stage.call(frame)), scope: Object.freeze({}) as unknown as ModelEgressScope, signal: new AbortController().signal }).catch(() => undefined);
    await stage.close();
    expect(stage.failure()).toBe("rate_limit");
    expect(answers[0]!.status).toBe(503);
    expect(stage.usage()).toEqual({ calls: 1, costMicros: 0 });
  });
});
