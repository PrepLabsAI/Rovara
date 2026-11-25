// The task-ended notice (POST /v1/service/task-ended): Code tells the gateway a task ended, the gateway records `ENDED#<task>` in the markers table, and
// the task's next call is refused. Run over the wire-level DynamoDB (conditions evaluated), the real signed-token verifier and the real server.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoEndedTasks, ENDED_TASK_RETENTION_SECONDS, companyPartition } from "../../packages/model-gateway/src/dynamo-meter.js";
import { EVAL_CAP_AUDIENCE } from "../../packages/model-gateway/src/eval-cap.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import {
  answerTaskEnded, TASK_ENDED_AUDIENCE, TASK_ENDED_BODY_MAX, TASK_ENDED_PATH, TASK_ENDED_TOKEN_KIND, type TaskEndedHandlerOptions, type TaskEndedLog,
} from "../../packages/model-gateway/src/task-ended-notice.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { answer, call, claims, jwk, keys, kid, mint, now, scope, setup, sse } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const MARKERS = "gw-markers";
const secs = now / 1000;
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" });

function mintNotice(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const body = { iss: ISS, aud: TASK_ENDED_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const verify = () => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, TASK_ENDED_TOKEN_KIND);

function world(clock: { at: number } = { at: now }) {
  const wire = new WireDynamo([MARKERS]);
  const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
  const ended = new DynamoEndedTasks(db, MARKERS, () => clock.at);
  const logs: TaskEndedLog[] = [];
  const opts: TaskEndedHandlerOptions = { verify: verify(), ended, log: (line) => logs.push(line), now: () => now };
  return { wire, db, ended, logs, opts, clock };
}
async function notice(opts: TaskEndedHandlerOptions, body: unknown, o: { token?: string | undefined; headers?: Record<string, string>; method?: string; raw?: Buffer } = {}) {
  const bytes = o.raw ?? Buffer.from(JSON.stringify(body));
  const token = "token" in o ? o.token : mintNotice();
  return answerTaskEnded(opts, {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...o.headers },
    body: (async function* () { yield bytes; })(),
  });
}
const ENDED = (task: string, company = A) => ({ status: 200, body: { company, task, ended: true } });
const UNSIGNED = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } };
const INVALID = { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } };
const FORBIDDEN = { status: 403, body: { error: { type: "forbidden", message: "the notice is not for this company" } } };
const rows = (w: ReturnType<typeof world>) => w.wire.items(MARKERS).filter((item) => typeof item.sk === "string" && item.sk.startsWith("ENDED#"));

describe("the notice ends the task", () => {
  it("a notice records ENDED#<task> and the task's next call is refused 403 task_ended with nothing sent", async () => {
    const w = world();
    const f = setup({ ended: w.ended });
    expect((await call(f.deps)).status).toBe(200);
    expect(f.calls).toHaveLength(1);

    expect(await notice(w.opts, { company: A, task: scope.tid })).toEqual(ENDED(scope.tid));
    expect(await w.ended.isEnded(ISS, A, scope.tid)).toBe(true);

    const refused = await call(f.deps);
    expect(refused.status).toBe(403);
    expect(refused.text()).toContain("task_ended");
    expect(f.calls).toHaveLength(1);
    expect((await call(f.deps, undefined, mint({ tid: "task_2" }))).status).toBe(200);
  });

  it("the row is keyed by install, company and task, carries its own expiry, and is what the gateway's reader looks for", async () => {
    const w = world();
    await notice(w.opts, { company: A, task: "task_9" });
    expect(rows(w)).toEqual([{ pk: companyPartition(ISS, A), sk: "ENDED#task_9", task: "task_9", endedAt: now, expiresAt: secs + ENDED_TASK_RETENTION_SECONDS }]);
    expect(ENDED_TASK_RETENTION_SECONDS).toBe(7 * 24 * 3600);
    expect(w.logs).toEqual([{ event: "task_ended_notice", outcome: "recorded" }]);
  });

  it("a repeat notice is the same answer and changes nothing (not the row, not its expiry); a task is never un-ended", async () => {
    const clock = { at: now };
    const w = world(clock);
    const first = await notice(w.opts, { company: A, task: "task_9" });
    const before = JSON.stringify(rows(w));
    clock.at = now + 3 * 24 * 3600_000;
    expect(await notice(w.opts, { company: A, task: "task_9" })).toEqual(first);
    expect(await notice(w.opts, { company: A, task: "task_9" })).toEqual(first);
    expect(JSON.stringify(rows(w))).toBe(before);
    expect(await w.ended.isEnded(ISS, A, "task_9")).toBe(true);
    expect(w.logs.map((l) => l.outcome)).toEqual(["recorded", "repeat", "repeat"]);
  });

  it("an unknown task (never called) is recorded, and ends only that task of that company", async () => {
    const w = world();
    expect(await notice(w.opts, { company: A, task: "never-called" })).toEqual(ENDED("never-called"));
    expect(await w.ended.isEnded(ISS, A, "never-called")).toBe(true);
    expect(await w.ended.isEnded(ISS, A, "task_1")).toBe(false);
    // The same task id of another company, or another install, is another key.
    expect(await w.ended.isEnded(ISS, B, "never-called")).toBe(false);
    expect(await w.ended.isEnded("https://other.invalid", A, "never-called")).toBe(false);
    // A task closed before its first call has its first call refused.
    const f = setup({ ended: w.ended });
    await notice(w.opts, { company: A, task: scope.tid });
    expect((await call(f.deps)).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  it("a call already in flight when the notice lands is stopped at its next chunk and settled once (hold closed), not left open", async () => {
    const w = world();
    const f = setup({ ended: w.ended });
    f.deps.transport = async () => ({ status: 200, body: (async function* () {
      yield sse("message_start", { message: { usage: { input_tokens: 1 } } });
      expect((await notice(w.opts, { company: A, task: scope.tid })).status).toBe(200);
      yield sse("content_block_delta", { delta: { text: "after-notice" } }); yield* answer();
    })() });
    const r = await call(f.deps);
    expect(r.destroyed).toBe(true); expect(r.text()).not.toContain("after-notice");
    expect(f.logs.filter((x) => (x as { event: string }).event === "settled")).toHaveLength(1);
    expect((await f.meter.read(scope))[0]!.reservedMicros).toBe(0);
  });
});

describe("whose notice it is", () => {
  it("another company's notice is refused, logged without ids, and writes nothing (neither company's task is ended)", async () => {
    const w = world();
    const mismatch = await notice(w.opts, { company: B, task: scope.tid });
    expect(mismatch).toEqual(FORBIDDEN);
    expect(rows(w)).toEqual([]);
    expect(w.wire.calls.filter((c) => c.operation === "PutItem")).toHaveLength(0);
    expect(await w.ended.isEnded(ISS, A, scope.tid)).toBe(false);
    expect(await w.ended.isEnded(ISS, B, scope.tid)).toBe(false);
    expect(w.logs).toEqual([{ event: "task_ended_notice", outcome: "refused", reason: "company_mismatch" }]);
    expect(JSON.stringify([mismatch, w.logs])).not.toContain(B);
    // Company B's own token ends company B's task, in company B's partition only.
    expect(await notice(w.opts, { company: B, task: scope.tid }, { token: mintNotice({ cid: B }) })).toEqual(ENDED(scope.tid, B));
    expect(await w.ended.isEnded(ISS, B, scope.tid)).toBe(true);
    expect(await w.ended.isEnded(ISS, A, scope.tid)).toBe(false);
  });

  it("an unsigned call, another audience, a task token, a wrong key and an x-api-key are 401 and write nothing", async () => {
    const w = world();
    const body = { company: A, task: "task_9" };
    for (const token of [undefined, "x.y.z", mint(), mintNotice({ aud: SERVICE_TOKEN_AUDIENCE }), mintNotice({ aud: EVAL_CAP_AUDIENCE }), mintNotice({ cid: "org_short" }), mintNotice({ iss: "https://other.invalid" }), mintNotice({ exp: secs - 5 }), mintNotice({}, { kid: "AAAAAAAAAAAAAAAA" }), mintNotice({ extra: 1 })]) {
      expect(await notice(w.opts, body, { token })).toEqual(UNSIGNED);
    }
    expect(await notice(w.opts, body, { headers: { "x-api-key": mintNotice() } })).toEqual(UNSIGNED);
    expect(rows(w)).toEqual([]);
  });

  it("a body that is not exactly {company, task}, or whose task is not a task id, is 400; over the limit 413; not a POST 405", async () => {
    const w = world();
    for (const body of [{ company: A }, { task: "task_9" }, { company: A, task: "task_9", extra: 1 }, { company: A, task: "" }, { company: A, task: "a b" }, { company: A, task: "t".repeat(129) }, { company: A, task: 9 }, { company: 1, task: "task_9" }, [], null, "x"]) {
      expect(await notice(w.opts, body)).toEqual(INVALID);
    }
    expect(await notice(w.opts, undefined, { raw: Buffer.from("{nope") })).toEqual(INVALID);
    expect(await notice(w.opts, { company: A, task: "task_9" }, { headers: { "content-type": "text/plain" } })).toEqual(INVALID);
    expect((await notice(w.opts, undefined, { raw: Buffer.alloc(TASK_ENDED_BODY_MAX + 1, 32) })).status).toBe(413);
    expect((await notice(w.opts, { company: A, task: "task_9" }, { method: "GET" })).status).toBe(405);
    expect(rows(w)).toEqual([]);
    expect(TASK_ENDED_PATH).toBe("/v1/service/task-ended");
  });
});

describe("a store fault", () => {
  it("is 503 with nothing recorded and no ids in the answer or the log; the same notice sent again succeeds", async () => {
    const w = world();
    w.wire.fault((c) => c.operation === "PutItem", { kind: "error", status: 400, type: "AccessDeniedException" }, 1);
    const failed = await notice(w.opts, { company: A, task: "task_9" });
    expect(failed.status).toBe(503);
    expect(rows(w)).toEqual([]);
    expect(await w.ended.isEnded(ISS, A, "task_9")).toBe(false);
    expect(JSON.stringify([failed, w.logs])).not.toContain("task_9");
    expect(w.logs).toEqual([{ event: "task_ended_notice", outcome: "unavailable" }]);
    expect(await notice(w.opts, { company: A, task: "task_9" })).toEqual(ENDED("task_9"));
    expect(await w.ended.isEnded(ISS, A, "task_9")).toBe(true);
  });

  it("a write that applied but lost its answer is repeated as a repeat: still ended, still one row", async () => {
    const w = world();
    w.wire.fault((c) => c.operation === "PutItem", { kind: "lost-after-apply" }, 1);
    const lost = await notice(w.opts, { company: A, task: "task_9" });
    expect([200, 503]).toContain(lost.status);
    expect(await notice(w.opts, { company: A, task: "task_9" })).toEqual(ENDED("task_9"));
    expect(rows(w)).toHaveLength(1);
  });
});
