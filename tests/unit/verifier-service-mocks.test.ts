// Proof and test environment E8: the service mock server (SageMaker Runtime shaped), the recorder, the inferred schema, unmatched modes, fault injection. Real HTTP on loopback.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceMockFixtureSetSchema, ServiceMockJsonSchemaSchema, awsEndpointUrlVariable, serviceMockFixtureSetDigest, serviceMockRequestHash, type ServiceMockFixtureSet, type TestEnvProdDeny } from "@agentx/contracts";
import { ServiceMockAdditionSetSchema, serviceMockAdditionsListing } from "@agentx/contracts";
import { createSyntheticGenerator } from "../../packages/verifier/src/data-guard.js";
import { FixtureSetRefused, additionsFromPreprod, additionsFromSchema, pinAdditionSet, inferJsonSchema, recordFixtureSet, schemaAccepts, startServiceMock, synthesizeFromSchema, type RecordInput, type RunningServiceMock } from "../../packages/verifier/src/service-mocks/index.js";

const DENY: TestEnvProdDeny = { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] };
const SERVICE = { name: "partner-scorer", kind: "sagemaker_runtime" as const, target: "partner-scorer" };
const NOW = () => new Date("2026-10-30T10:00:00.000Z");
const json = "application/json";
const request = (body: unknown): RecordInput => ({ method: "POST", pathAndQuery: "/endpoints/partner-scorer/invocations", contentType: json, body: JSON.stringify(body) });
const answer = (score: number) => ({ status: 200, contentType: json, body: JSON.stringify({ score, model: "v3", scoredAt: "2026-10-30T09:00:00.000Z" }), latencyMs: 12 });

async function recorded(inputs: RecordInput[] = [request({ partner: "p1", region: "emea" }), request({ partner: "p2", region: "apac" })]) {
  const outcome = await recordFixtureSet({ service: SERVICE, revision: 1, inputs, deny: DENY, now: NOW, send: (item) => Promise.resolve(answer(item.body.includes("p1") ? 0.9 : 0.4)) });
  if (!outcome.ok) throw new Error(`recording failed: ${outcome.reason}`);
  return outcome;
}

const running: RunningServiceMock[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((mock) => mock.close())); });
async function serve(set: ServiceMockFixtureSet, unmatched: "fail" | "schema_synth" = "fail", digest = serviceMockFixtureSetDigest(set)) {
  const mock = await startServiceMock({ fixtureSet: set, expectedDigest: digest, unmatched });
  running.push(mock);
  return mock;
}
const invoke = (mock: RunningServiceMock, body: unknown, endpoint = "partner-scorer", init: RequestInit = {}) =>
  fetch(`${mock.url}/endpoints/${endpoint}/invocations`, { method: "POST", headers: { "content-type": json }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });
const control = (mock: RunningServiceMock, path: string, init: RequestInit = {}, token = mock.controlToken) => fetch(`${mock.url}/__rovara/${path}`, { ...init, headers: { "x-rovara-control": token, "content-type": json } });

describe("the recorder", () => {
  it("records each synthetic input's answer, infers both schemas, and pins the set by digest", async () => {
    const { set, digest, duplicates } = await recorded([request({ partner: "p1", region: "emea" }), request({ region: "emea", partner: "p1" }), request({ partner: "p2", region: "apac" })]);
    expect(duplicates).toBe(1);
    expect(set.entries).toHaveLength(2);
    expect(set.syntheticOnly).toBe(true);
    expect(set.requestSchema).toMatchObject({ type: "object", required: ["partner", "region"] });
    expect(set.responseSchema?.properties?.scoredAt).toMatchObject({ type: "string", format: "date-time" });
    expect(set.responseSchema?.properties?.score).toEqual({ type: "number" });
    expect(digest).toBe(serviceMockFixtureSetDigest(set));
    expect(ServiceMockFixtureSetSchema.safeParse(set).success).toBe(true);
  });
  it("sends nothing to pre-prod when an input holds personal data or names production", async () => {
    let sent = 0;
    for (const body of [{ partner: "jane.roe@acme-corp.com" }, { callback: "https://a.prod.example.com/x" }]) {
      const outcome = await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request(body)], deny: DENY, now: NOW, send: () => { sent += 1; return Promise.resolve(answer(1)); } });
      expect(outcome).toMatchObject({ ok: false, reason: "data_guard", phase: "inputs" });
    }
    expect(sent).toBe(0);
  });
  it("blocks the whole set when an answer holds personal data, with no matched text in the report", async () => {
    const outcome = await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request({ partner: "p1" })], deny: DENY, now: NOW, send: () => Promise.resolve({ status: 200, contentType: json, body: JSON.stringify({ contact: "jane.roe@acme-corp.com" }), latencyMs: 1 }) });
    expect(outcome).toMatchObject({ ok: false, reason: "data_guard", phase: "responses", report: { ok: false, findings: [{ kind: "email", source: "fixture", path: "entries[0].response" }] } });
    expect(JSON.stringify(outcome)).not.toContain("acme-corp");
  });
  it("does not record a server error, a failure to send, an oversized answer, or nothing at all", async () => {
    const base = { service: SERVICE, revision: 1, deny: DENY, now: NOW };
    expect(await recordFixtureSet({ ...base, inputs: [request({ a: 1 })], send: () => Promise.resolve({ ...answer(1), status: 503 }) })).toEqual({ ok: false, reason: "preprod_error" });
    expect(await recordFixtureSet({ ...base, inputs: [request({ a: 1 })], send: () => Promise.reject(new Error("secret detail")) })).toEqual({ ok: false, reason: "send_failed" });
    expect(await recordFixtureSet({ ...base, inputs: [request({ a: 1 })], send: () => Promise.resolve({ ...answer(1), body: "x".repeat(70_000) }) })).toEqual({ ok: false, reason: "response_too_large" });
    expect(await recordFixtureSet({ ...base, inputs: [], send: () => Promise.resolve(answer(1)) })).toEqual({ ok: false, reason: "no_inputs" });
    expect(await recordFixtureSet({ ...base, inputs: [request("x".repeat(70_000))], send: () => Promise.resolve(answer(1)) })).toEqual({ ok: false, reason: "input_too_large" });
  });
  it("does not record a refusal (bad credentials, throttling, timeout) as the service's answer", async () => {
    for (const status of [401, 403, 407, 408, 429]) {
      expect(await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request({ a: 1 })], deny: DENY, now: NOW, send: () => Promise.resolve({ ...answer(1), status }) })).toEqual({ ok: false, reason: "preprod_error" });
    }
    expect((await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request({ a: 1 })], deny: DENY, now: NOW, send: () => Promise.resolve({ ...answer(1), status: 404 }) })).ok).toBe(true);
  });
  it("blocks the set when a pre-prod answer echoes a credential (review I7), and the set is not returned", async () => {
    const key = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const outcome = await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request({ a: 1 })], deny: DENY, now: NOW, send: () => Promise.resolve({ status: 200, contentType: json, body: JSON.stringify({ debug: `key ${key}` }), latencyMs: 1 }) });
    expect(outcome).toMatchObject({ ok: false, reason: "data_guard", phase: "responses", report: { findings: [{ kind: "secret", source: "fixture", path: "entries[0].response" }] } });
    expect(JSON.stringify(outcome)).not.toContain(key);
  });
  it("stops a call that never answers", async () => {
    const outcome = await recordFixtureSet({ service: SERVICE, revision: 1, inputs: [request({ a: 1 })], deny: DENY, now: NOW, perCallTimeoutMs: 20, send: (_item, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
    expect(outcome).toEqual({ ok: false, reason: "send_failed" });
  });
});

describe("the mock server", () => {
  it("answers a recorded request exactly, whatever the key order of its JSON, and counts it", async () => {
    const { set } = await recorded();
    const mock = await serve(set);
    const first = await invoke(mock, { region: "emea", partner: "p1" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe(json);
    expect(await first.json()).toMatchObject({ score: 0.9, model: "v3" });
    expect(mock.usage()).toEqual({ service: "partner-scorer", matched: 1, unmatchedFailed: 0, synthesized: 0, faultsInjected: [], additionsServed: 0 });
  });
  it("fails loudly for a request it has no recording for, and for another endpoint, and counts each", async () => {
    const { set } = await recorded();
    const mock = await serve(set);
    const unknown = await invoke(mock, { partner: "p9", region: "emea" });
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toBe("mock had no recording");
    expect((await invoke(mock, { partner: "p1", region: "emea" }, "other-endpoint")).status).toBe(500);
    expect((await fetch(`${mock.url}/somewhere/else`, { method: "POST", body: "{}" })).status).toBe(500);
    expect(mock.usage()).toMatchObject({ matched: 0, unmatchedFailed: 3, synthesized: 0 });
  });
  it("refuses to serve a set that does not hash to its pinned digest, or that is not a fixture set", async () => {
    const { set } = await recorded();
    const tampered = { ...set, entries: [{ ...set.entries[0]!, response: { ...set.entries[0]!.response, body: '{"score":1}' } }, ...set.entries.slice(1)] };
    await expect(startServiceMock({ fixtureSet: tampered, expectedDigest: serviceMockFixtureSetDigest(set), unmatched: "fail" })).rejects.toThrow(FixtureSetRefused);
    await expect(startServiceMock({ fixtureSet: { nonsense: true }, expectedDigest: "a".repeat(64), unmatched: "fail" })).rejects.toMatchObject({ reason: "unreadable" });
  });
  it("answers a body over 64 KiB with 413 and counts it as unrecorded", async () => {
    const { set } = await recorded();
    const mock = await serve(set);
    const response = await invoke(mock, `{"pad":"${"x".repeat(70_000)}"}`);
    expect(response.status).toBe(413);
    expect(mock.usage().unmatchedFailed).toBe(1);
  });
  it("listens on loopback only", async () => {
    const { set } = await recorded();
    expect((await serve(set)).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });
  it("is reached through the SDK's endpoint variable, which names the SageMaker Runtime", () => {
    expect(awsEndpointUrlVariable("SageMaker Runtime")).toBe("AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME");
  });
});

describe("unmatched requests: schema_synth", () => {
  it("answers a schema-valid request with a deterministic answer that satisfies the response schema, and counts it as synthesized", async () => {
    const { set } = await recorded();
    const mock = await serve(set, "schema_synth");
    const first = await invoke(mock, { partner: "p9", region: "latam" });
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-rovara-mock")).toBe("synthesized");
    expect(schemaAccepts(set.responseSchema!, body)).toBe(true);
    expect(await (await invoke(mock, { partner: "p9", region: "latam" })).json()).toEqual(body);
    expect(mock.usage()).toMatchObject({ matched: 0, unmatchedFailed: 0, synthesized: 2 });
  });
  it("still fails a request that does not satisfy the request schema, or when there is no response schema", async () => {
    const { set } = await recorded();
    const mock = await serve(set, "schema_synth");
    expect((await invoke(mock, { partner: 7 })).status).toBe(500);
    expect((await invoke(mock, "not json")).status).toBe(500);
    const bare = { ...set, responseSchema: null };
    const second = await serve(bare, "schema_synth");
    expect((await invoke(second, { partner: "p9", region: "x" })).status).toBe(500);
    expect(mock.usage()).toMatchObject({ unmatchedFailed: 2, synthesized: 0 });
  });
  it("never synthesizes in the default mode", async () => {
    const { set } = await recorded();
    expect((await invoke(await serve(set, "fail"), { partner: "p9", region: "latam" })).status).toBe(500);
  });
});

describe("new cases: additions made in the task (owner decision Q9, review I8)", () => {
  const fresh = request({ partner: "p-new", region: "latam" });
  const serveWith = async (set: ServiceMockFixtureSet, digest: string, additions: unknown, pinned: string | undefined, deny: TestEnvProdDeny | null = DENY) => {
    const mock = await startServiceMock({ fixtureSet: set, expectedDigest: digest, unmatched: "fail", additions, ...(pinned === undefined ? {} : { expectedAdditionsDigest: pinned }), ...(deny === null ? {} : { deny }) });
    running.push(mock);
    return mock;
  };
  it("covers the old cases from the pinned set and the new case from the broker-pinned addition, and lists it", async () => {
    const { set, digest } = await recorded();
    const made = additionsFromSchema(set, [fresh], DENY, NOW());
    if (!made.ok) throw new Error(made.reason);
    expect(made.set.additions[0]?.origin).toBe("schema");
    const mock = await serveWith(set, digest, made.set, pinAdditionSet(made.set));
    expect((await invoke(mock, { partner: "p1", region: "emea" })).status).toBe(200);
    const added = await invoke(mock, { partner: "p-new", region: "latam" });
    expect(added.status).toBe(200);
    expect(schemaAccepts(set.responseSchema!, await added.json())).toBe(true);
    // A third request neither has still fails loudly.
    expect((await invoke(mock, { partner: "p-other", region: "latam" })).status).toBe(500);
    expect(mock.usage()).toMatchObject({ matched: 1, additionsServed: 1, unmatchedFailed: 1, synthesized: 0 });
    const listing = serviceMockAdditionsListing(made.set);
    expect(listing).toMatchObject({ service: "partner-scorer", baseFixtureDigest: digest, additionsDigest: pinAdditionSet(made.set), bySchema: 1, byPreprod: 0 });
    expect(JSON.stringify(listing)).not.toContain("p-new");
  });
  it("records a new case from pre-prod through the same guard, and refuses one the pinned set already answers", async () => {
    const { set } = await recorded();
    const sent: string[] = [];
    const context = { deny: DENY, now: NOW, send: (item: RecordInput) => { sent.push(item.body); return Promise.resolve(answer(0.7)); } };
    const made = await additionsFromPreprod(set, [fresh], context);
    expect(made.ok && made.set.additions.map((addition) => addition.origin)).toEqual(["preprod"]);
    expect(await additionsFromPreprod(set, [request({ partner: "p1", region: "emea" })], context)).toEqual({ ok: false, reason: "already_recorded", at: 0 });
    expect(await additionsFromPreprod(set, [request({ mail: "jane.roe@acme-corp.com" })], context)).toMatchObject({ ok: false, reason: "data_guard" });
    expect(sent).toHaveLength(1);
  });
  it("refuses a schema answer for a request outside the schema, a body that is not JSON, a base with no response schema, and one already recorded", async () => {
    const { set } = await recorded();
    expect(additionsFromSchema(set, [request({ partner: 7 })], DENY, NOW())).toEqual({ ok: false, reason: "request_not_in_schema", at: 0 });
    expect(additionsFromSchema(set, [{ ...fresh, body: "nope" }], DENY, NOW())).toEqual({ ok: false, reason: "not_json", at: 0 });
    expect(additionsFromSchema({ ...set, responseSchema: null }, [fresh], DENY, NOW())).toEqual({ ok: false, reason: "no_response_schema" });
    expect(additionsFromSchema(set, [request({ partner: "p1", region: "emea" })], DENY, NOW())).toEqual({ ok: false, reason: "already_recorded", at: 0 });
    expect(additionsFromSchema(set, [], DENY, NOW())).toEqual({ ok: false, reason: "no_inputs" });
  });
  it("never serves a set the broker did not pin: no digest, no deny list, a different digest, or edited after pinning", async () => {
    const { set, digest } = await recorded();
    const made = additionsFromSchema(set, [fresh], DENY, NOW());
    if (!made.ok) throw new Error(made.reason);
    const pinned = pinAdditionSet(made.set);
    await expect(serveWith(set, digest, made.set, undefined)).rejects.toMatchObject({ reason: "additions_unpinned" });
    await expect(serveWith(set, digest, made.set, pinned, null)).rejects.toMatchObject({ reason: "additions_unpinned" });
    await expect(serveWith(set, digest, made.set, "e".repeat(64))).rejects.toMatchObject({ reason: "additions_unpinned" });
    const edited = { ...made.set, additions: [{ ...made.set.additions[0]!, entry: { ...made.set.additions[0]!.entry, response: { ...made.set.additions[0]!.entry.response, body: '{"score":1,"model":"v3","scoredAt":"2026-01-01T00:00:00.000Z"}' } } }] };
    await expect(serveWith(set, digest, edited, pinned)).rejects.toMatchObject({ reason: "additions_unpinned" });
    await expect(serveWith(set, digest, { nonsense: 1 }, pinned)).rejects.toThrow(FixtureSetRefused);
  });
  it("a task that wrote its own 'schema' answer and pinned it itself is refused: the answer is not what the schema makes", async () => {
    const { set, digest } = await recorded();
    const made = additionsFromSchema(set, [fresh], DENY, NOW());
    if (!made.ok) throw new Error(made.reason);
    const entry = made.set.additions[0]!.entry;
    const forged = ServiceMockAdditionSetSchema.parse({ ...made.set, additions: [{ origin: "schema", entry: { ...entry, response: { ...entry.response, body: '{"score":1,"model":"v3","scoredAt":"2026-01-01T00:00:00.000Z"}' } } }] });
    await expect(serveWith(set, digest, forged, pinAdditionSet(forged))).rejects.toMatchObject({ reason: "additions_forged" });
    const wrongStatus = ServiceMockAdditionSetSchema.parse({ ...made.set, additions: [{ origin: "schema", entry: { ...entry, response: { ...entry.response, status: 500 } } }] });
    await expect(serveWith(set, digest, wrongStatus, pinAdditionSet(wrongStatus))).rejects.toMatchObject({ reason: "additions_forged" });
    const outsideSchema = ServiceMockAdditionSetSchema.parse({ ...made.set, additions: [{ origin: "schema", entry: { ...entry, request: { contentType: "application/json", body: '{"partner":7}' } } }] });
    await expect(serveWith(set, digest, outsideSchema, pinAdditionSet(outsideSchema))).rejects.toMatchObject({ reason: "additions_forged" });
  });
  it("refuses additions for another base set, and additions that hold personal data or a credential", async () => {
    const { set, digest } = await recorded();
    const made = additionsFromSchema(set, [fresh], DENY, NOW());
    if (!made.ok) throw new Error(made.reason);
    const otherBase = ServiceMockAdditionSetSchema.parse({ ...made.set, baseFixtureDigest: "d".repeat(64) });
    await expect(serveWith(set, digest, otherBase, pinAdditionSet(otherBase))).rejects.toMatchObject({ reason: "additions_forged" });
    const pre = await additionsFromPreprod(set, [fresh], { deny: DENY, now: NOW, send: () => Promise.resolve(answer(0.7)) });
    if (!pre.ok) throw new Error(pre.reason);
    const dirty = ServiceMockAdditionSetSchema.parse({ ...pre.set, additions: [{ origin: "preprod", entry: { ...pre.set.additions[0]!.entry, response: { ...pre.set.additions[0]!.entry.response, body: '{"contact":"jane.roe@acme-corp.com"}' } } }] });
    await expect(serveWith(set, digest, dirty, pinAdditionSet(dirty))).rejects.toMatchObject({ reason: "additions_unsafe" });
    // A pre-prod addition the broker recorded and pinned is served.
    expect((await invoke(await serveWith(set, digest, pre.set, pinAdditionSet(pre.set)), { partner: "p-new", region: "latam" })).status).toBe(200);
  });
  it("serves additions only after the pinned set, never over a pinned recording", async () => {
    const { set, digest } = await recorded();
    const made = additionsFromSchema(set, [fresh], DENY, NOW());
    if (!made.ok) throw new Error(made.reason);
    const pinnedEntry = set.entries[0]!;
    const sneaky = ServiceMockAdditionSetSchema.parse({ ...made.set, additions: [{ origin: "preprod", entry: { ...pinnedEntry, response: { ...pinnedEntry.response, body: '{"score":0}' } } }] });
    const mock = await serveWith(set, digest, sneaky, pinAdditionSet(sneaky));
    expect(await (await invoke(mock, { partner: "p1", region: "emea" })).json()).toMatchObject({ score: 0.9 });
    expect(mock.usage()).toMatchObject({ matched: 1, additionsServed: 0 });
  });
});

describe("fault injection", () => {
  const withFaults = async () => {
    const { set } = await recorded();
    const faulty = ServiceMockFixtureSetSchema.parse({ ...set, faults: [{ name: "slow-down", kind: "throttle", status: 429, delayMs: 0 }, { name: "boom", kind: "http_5xx", status: 503, delayMs: 0 }, { name: "hang", kind: "timeout", delayMs: 10 }] });
    return serve(faulty);
  };
  it("needs the run's control token, which is not an open path for the app", async () => {
    const mock = await withFaults();
    expect((await control(mock, "usage", {}, "wrong")).status).toBe(403);
    expect((await fetch(`${mock.url}/__rovara/usage`)).status).toBe(403);
    expect((await control(mock, "usage")).status).toBe(200);
  });
  it("arms a named fault for the next requests, then goes back to recordings, and counts it", async () => {
    const mock = await withFaults();
    expect((await control(mock, "fault", { method: "POST", body: JSON.stringify({ name: "slow-down", count: 2 }) })).status).toBe(204);
    for (let index = 0; index < 2; index += 1) {
      const response = await invoke(mock, { partner: "p1", region: "emea" });
      expect(response.status).toBe(429);
      expect(response.headers.get("x-amzn-errortype")).toBe("ThrottlingException");
    }
    expect((await invoke(mock, { partner: "p1", region: "emea" })).status).toBe(200);
    await control(mock, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    expect((await invoke(mock, { partner: "p1", region: "emea" })).status).toBe(503);
    const usage = await (await control(mock, "usage")).json() as { faultsInjected: unknown; matched: number };
    expect(usage.faultsInjected).toEqual([{ name: "slow-down", count: 2 }, { name: "boom", count: 1 }]);
    expect(usage.matched).toBe(1);
  });
  it("a stray request to another endpoint does not use up an armed fault", async () => {
    const mock = await withFaults();
    await control(mock, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    expect((await invoke(mock, { partner: "p1", region: "emea" }, "other-endpoint")).status).toBe(500);
    expect((await fetch(`${mock.url}/elsewhere`, { method: "POST", body: "{}" })).status).toBe(500);
    expect((await invoke(mock, { partner: "p1", region: "emea" })).status).toBe(503);
    expect((await invoke(mock, { partner: "p1", region: "emea" })).status).toBe(200);
  });
  it("drops the connection for a timeout fault, and refuses a fault the set does not have", async () => {
    const mock = await withFaults();
    await control(mock, "fault", { method: "POST", body: JSON.stringify({ name: "hang" }) });
    await expect(invoke(mock, { partner: "p1", region: "emea" })).rejects.toThrow();
    expect((await control(mock, "fault", { method: "POST", body: JSON.stringify({ name: "nope" }) })).status).toBe(404);
    expect((await control(mock, "fault", { method: "POST", body: "{" })).status).toBe(400);
  });
});

describe("the schema helpers", () => {
  it("infers required keys, formats and element types, and leaves a mixed-type part unconstrained", () => {
    const schema = inferJsonSchema([{ id: "3f2a9c1e-1111-4222-8333-444455556666", tags: ["a"], n: 1, mixed: 1 }, { id: "3f2a9c1e-1111-4222-8333-444455556667", tags: [], n: 2.5, mixed: "x", extra: true }])!;
    expect(schema.required).toEqual(["id", "mixed", "n", "tags"]);
    expect(schema.properties?.id).toEqual({ type: "string", format: "uuid" });
    expect(schema.properties?.n).toEqual({ type: "number" });
    expect(schema.properties?.mixed).toBeUndefined();
    expect(schema.properties?.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(inferJsonSchema([])).toBeNull();
    expect(inferJsonSchema([1, "a"])).toBeNull();
  });
  it("stops describing a shape at the contract's depth: the schema stays valid and the deeper part is unconstrained", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    const schema = inferJsonSchema([deep])!;
    expect(ServiceMockJsonSchemaSchema.safeParse(schema).success).toBe(true);
    let levels = 0;
    for (let node: typeof schema | undefined = schema; node !== undefined; node = node.properties?.child) levels += 1;
    expect(levels).toBe(32);
    expect(schemaAccepts(schema, deep)).toBe(true);
  });
  it("accepts what it should and refuses what it should", () => {
    const schema = { type: "object" as const, required: ["a"], additionalProperties: false as const, properties: { a: { type: "integer" as const, minimum: 1, maximum: 5 }, b: { type: "string" as const, format: "date" as const, maxLength: 10 } } };
    expect(schemaAccepts(schema, { a: 3, b: "2026-01-02" })).toBe(true);
    for (const bad of [{}, { a: 0 }, { a: 6 }, { a: 1.5 }, { a: 2, c: 1 }, { a: 2, b: "yesterday" }, [], null]) expect(schemaAccepts(schema, bad)).toBe(false);
  });
  it("synthesizes values that satisfy the schema, repeatably", () => {
    const schema = inferJsonSchema([{ id: "3f2a9c1e-1111-4222-8333-444455556666", score: 0.5, ok: true, items: [{ name: "n", at: "2026-01-01T00:00:00Z" }] }])!;
    const a = synthesizeFromSchema(schema, createSyntheticGenerator(5));
    expect(schemaAccepts(schema, a)).toBe(true);
    expect(a).toEqual(synthesizeFromSchema(schema, createSyntheticGenerator(5)));
  });
});

const hasBoto3 = (() => { try { execFileSync("python3", ["-I", "-c", "import boto3"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe("a real boto3 client", () => {
  it.runIf(hasBoto3)("invokes the mocked endpoint through AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME with no change to the code", async () => {
    const { set } = await recorded();
    const mock = await serve(set);
    const script = "import boto3,json;c=boto3.client('sagemaker-runtime',region_name='us-west-2');r=c.invoke_endpoint(EndpointName='partner-scorer',ContentType='application/json',Body=json.dumps({'partner':'p1','region':'emea'}));print(r['Body'].read().decode())";
    // Asynchronously: the mock server runs in this process, and a blocking call would leave it unable to answer boto3 (the request would time out).
    const { stdout: out } = await promisify(execFile)("python3", ["-I", "-c", script], { env: { PATH: process.env.PATH ?? "", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", [awsEndpointUrlVariable("SageMaker Runtime")]: mock.url }, encoding: "utf8" });
    expect(JSON.parse(out)).toMatchObject({ score: 0.9 });
  });
  it("hashes a request the way the server does (a boto3-shaped request with a charset parameter finds the recording)", async () => {
    const { set } = await recorded();
    const mock = await serve(set);
    const hash = serviceMockRequestHash({ service: "sagemaker_runtime", target: "partner-scorer", method: "POST", contentType: "application/json; charset=utf-8", body: '{"region":"emea","partner":"p1"}' });
    expect(set.entries.some((entry) => entry.requestHash === hash)).toBe(true);
    expect((await invoke(mock, '{"region":"emea","partner":"p1"}', "partner-scorer", { headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
  });
});
