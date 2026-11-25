import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createTaskTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryEndedTasks } from "../../packages/model-gateway/src/ended.js";
import { handleGateway, type GatewayDependencies, type GatewaySink } from "../../packages/model-gateway/src/server.js";

export const now = 1_800_000_000_000;
export const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const kid = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
export const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig", rovara_purpose: "task" };
export const claims = { iss: "https://install-a.example/v1/auth", aud: "rovara-model-gateway", jti: randomUUID(), iat: now / 1000, nbf: now / 1000 - 30, exp: now / 1000 + 900, cid: `org_${"a".repeat(20)}`, pid: "web", per: "a".repeat(64), pay: { kind: "member", developerId: "a".repeat(64) }, tid: "task_1", ws: randomUUID(), op: randomUUID(), stp: "build", src: "app", mdl: ["claude-sonnet-4-5"] };
export const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, per: claims.per };
export const caps = { task: 1_000_000_000, personMonth: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 };
export const requestBody = { model: claims.mdl[0], messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true };
export function mint(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-task+jwt", kid, ...header }), JSON.stringify({ ...claims, ...changes })].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
export function verifier() {
  return createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now });
}
export function sse(type: string, value: Record<string, unknown> = {}): Buffer {
  return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
}
export async function* answer() {
  yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
  yield sse("message_delta", { usage: { output_tokens: 5 } });
  yield sse("message_stop");
}
export class MemorySink implements GatewaySink {
  status = 0;
  headers: Readonly<Record<string, string>> = {};
  chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  head(status: number, headers: Readonly<Record<string, string>>) { this.status = status; this.headers = headers; }
  async write(chunk: Uint8Array) { this.chunks.push(Buffer.from(chunk)); }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
export function setup(overrides: Partial<GatewayDependencies> = {}) {
  const meter = new InMemoryMeter(() => now);
  const ended = new InMemoryEndedTasks();
  const calls: Array<{ headers: Readonly<Record<string, string>> }> = [];
  const logs: unknown[] = [];
  const providerKey = `fixture-${randomUUID()}`;
  const deps: GatewayDependencies = { verifyToken: verifier(), metrics: { overrunBusy: () => undefined }, modelLimits: { maxOutputTokens: () => 128_000 }, now: () => now, ended, meter, caps: new FixedCapsSource(caps), prices: { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }) }, keys: { keyFor: async () => providerKey }, transport: async (request) => { calls.push(request); return { status: 200, body: answer() }; }, log: (event) => logs.push(event), ...overrides };
  return { deps, meter, ended, calls, logs, providerKey };
}
export async function call(deps: GatewayDependencies, body: unknown = requestBody, token = mint(), sink = new MemorySink(), headers: Record<string, string> = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token, ...headers }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
