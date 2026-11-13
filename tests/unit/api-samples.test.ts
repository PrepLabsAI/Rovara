// API samples built on an allow-list, recorded under the executor's budget and credential scan, read back by the broker, and diffed structurally against the baseline's.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_SAMPLE_MAX_BYTES, E2ECapturePolicySchema, EvidencePackSchema, buildApiSample, diffApiSamples, parseApiSample, type ApiSample, type EvidenceEnvironment } from "../../packages/contracts/src/index.js";
import { CAPTURE_API_SAMPLES_MAX, CAPTURE_DIR, admittedCapturePolicy, captureApiSampleFileName, createCaptureRecorder, finalizeCaptureArtifacts } from "../../packages/verifier/src/executor/capture.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { recordApiSample } from "../../packages/verifier/src/api-runtime.js";
import { apiEvidenceOf, readCaptureApiSamples, scenarioSamplesOf } from "../../packages/core/src/e2e/api-evidence.js";
import { buildEvidencePack } from "../../packages/core/src/core/proof/evidence-pack.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const enc = (value: unknown) => Buffer.from(JSON.stringify(value));
const roots: string[] = [];
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "apisample-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const EMAIL = "rovara-orders-owner-ab12cd@example.test";
const redactor = () => createCredentialRedactor([{ profileId: "orders-owner", email: EMAIL, password: PASSWORD }]);
const JSON_CT = { "content-type": "application/json; charset=utf-8" };
const build = (over: Partial<Parameters<typeof buildApiSample>[0]> = {}) => {
  const built = buildApiSample({ method: "GET", path: "/orders", status: 200, responseHeaders: JSON_CT, responseBody: enc({ orders: [{ id: "o-1", total: 12.5, paid: true }] }), ...over });
  // Every test here expects a built sample; a missing one fails at the first property read.
  return { built, sample: (built.bytes === undefined ? undefined : parseApiSample(built.bytes)) as NonNullable<ReturnType<typeof parseApiSample>> };
};

describe("headers are an allow-list", () => {
  it("keeps content-type, length, cache-control and a request id, and drops everything else", () => {
    const { sample } = build({
      requestHeaders: { Authorization: "Bearer abc.def.ghi", Cookie: "session=zzz", "X-Custom": "1", "Content-Type": "application/json" },
      responseHeaders: { ...JSON_CT, "Set-Cookie": "session=rotated", "X-Request-Id": "req-123", "X-Amzn-Trace-Id": "Root=1-abc", "Cache-Control": "no-store", "Content-Length": "88", Server: "nginx" },
    });
    expect(sample.request.headers).toEqual({ "content-type": "application/json" });
    expect(Object.keys(sample.response.headers).sort()).toEqual(["cache-control", "content-length", "content-type", "x-request-id"]);
    expect(JSON.stringify(sample)).not.toMatch(/Bearer|session=|nginx|Root=1/u);
  });
  it("drops an allowed header whose value is not one plain printable line", () => {
    const { sample } = build({ responseHeaders: { ...JSON_CT, "x-request-id": "a\r\nSet-Cookie: x" } });
    expect(sample.response.headers["x-request-id"]).toBeUndefined();
  });
});

describe("bodies are structure with placeholders", () => {
  it("replaces every leaf by its type, keeps keys, and leaves nothing of the values", () => {
    const { sample } = build({ responseBody: enc({ customer: "Ada Lovelace", orders: [{ id: "o-1", total: 12.5, paid: true, note: null }], token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }) });
    expect(sample.response.body).toEqual({ kind: "json", value: { customer: "<string 12>", orders: [{ id: "<string 3>", total: "<number>", paid: "<bool>", note: null }], token: "<string 40>" } });
  });
  it("keeps the value only at a path on the approved safe list, and nowhere else", () => {
    const { sample } = build({ safePaths: ["orders[].status", "count"], responseBody: enc({ count: 3, orders: [{ status: "shipped", email: "a@b.test" }], status: "visible-elsewhere" }) });
    expect(sample.response.body).toEqual({ kind: "json", value: { count: 3, orders: [{ status: "shipped", email: "<string 8>" }], status: "<string 17>" } });
  });
  it("ignores a malformed safe-path list instead of widening what is shown", () => {
    const { sample } = build({ safePaths: ["$..*", "a b"], responseBody: enc({ a: "secret-value" }) });
    expect(JSON.stringify(sample)).not.toContain("secret-value");
  });
  it("hides a key that is a token, an id or an address", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const { sample } = build({ responseBody: enc({ [uuid]: 1, [EMAIL]: 2, ["a".repeat(30)]: 3, name: 4 }) });
    const value = (sample.response.body as { kind: "json"; value: Record<string, unknown> }).value;
    expect(Object.keys(value).sort()).toEqual([`<key ${EMAIL.length}>`, "<key 30>", "<key 36>", "name"].sort());
    expect(JSON.stringify(sample)).not.toContain(uuid);
    expect(JSON.stringify(sample)).not.toContain(EMAIL);
  });
  it("records a non-JSON, a broken-JSON and an empty body as what they are, never their bytes", () => {
    expect(build({ responseHeaders: { "content-type": "text/csv" }, responseBody: Buffer.from("a,b\n1,2") }).sample.response.body).toEqual({ kind: "non_json", bytes: 7 });
    expect(build({ responseBody: Buffer.from("{not json") }).sample.response.body).toEqual({ kind: "non_json", bytes: 9 });
    expect(build({ responseBody: new Uint8Array() }).sample.response.body).toEqual({ kind: "empty" });
    expect(build({ responseHeaders: {}, responseBody: enc({ a: 1 }) }).sample.response.body).toEqual({ kind: "non_json", bytes: 7 });
  });
  it("bounds depth, keys and nodes, and says it was cut", () => {
    let deep: unknown = "leaf"; for (let level = 0; level < 20; level += 1) deep = { next: deep };
    const cut = build({ responseBody: enc(deep) }).sample.response.body as { truncated?: true; value: unknown };
    expect(cut.truncated).toBe(true);
    const wide = build({ responseBody: enc(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))) }).sample.response.body as { truncated?: true; value: Record<string, unknown> };
    expect(Object.keys(wide.value)).toHaveLength(40);
    expect(wide.truncated).toBe(true);
    const long = build({ responseBody: enc(Array.from({ length: 5_000 }, (_, index) => ({ id: index }))) }).sample.response.body as { truncated?: true };
    expect(long.truncated).toBe(true);
  });
  it("cuts a sample that is too big to its first level, and withholds one that still is", () => {
    const big = build({ safePaths: Array.from({ length: 50 }, (_, index) => `a${index}`), responseBody: enc(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`a${index}`, "x".repeat(200)]))), requestBody: enc({ q: "y".repeat(10) }) });
    expect(big.built.bytes!.byteLength).toBeLessThanOrEqual(API_SAMPLE_MAX_BYTES);
    const tooBig = buildApiSample({ method: "GET", path: `/${"p".repeat(299)}`, status: 200, responseHeaders: JSON_CT, responseBody: enc({}), requestHeaders: Object.fromEntries(Array.from({ length: 1 }, () => ["content-type", "application/json"])) });
    expect(tooBig.bytes === undefined || tooBig.bytes.byteLength <= API_SAMPLE_MAX_BYTES).toBe(true);
    expect(buildApiSample({ method: "GET", path: "no-slash", status: 200 })).toEqual({ bytes: undefined, withheld: "invalid" });
    expect(buildApiSample({ method: "GET", path: "/x", status: 99 })).toEqual({ bytes: undefined, withheld: "invalid" });
  });
  it("redacts a secret-shaped value even where the path is approved as safe", () => {
    const { sample } = build({ safePaths: ["note"], responseBody: enc({ note: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789 end" }) });
    expect(JSON.stringify(sample)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("the run's credential scan over a sample", () => {
  const records = async (body: unknown, safePaths: string[], policy = { screenshots: false, apiSamples: true }) => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy, caseIds: ["case-a"], redactor: redactor() });
    const { bytes } = buildApiSample({ method: "POST", path: "/login", status: 200, responseHeaders: JSON_CT, responseBody: enc(body), safePaths });
    return { entry: await recorder.record({ caseId: "case-a", kind: "api-sample", bytes: bytes!, step: 0 }), root };
  };
  it("positive control: an approved-safe value that is the account password is dropped, with no file", async () => {
    const { entry, root } = await records({ echoed: PASSWORD }, ["echoed"]);
    expect(entry).toMatchObject({ kind: "api-sample", omitted: "credential-match" });
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([]);
  });
  it("drops it when the secret is spelled as base64, percent-encoded or hex", async () => {
    for (const spelled of [Buffer.from(`ab:${PASSWORD}`).toString("base64"), encodeURIComponent(PASSWORD), Buffer.from(PASSWORD).toString("hex"), EMAIL]) {
      const { entry } = await records({ v: spelled }, ["v"]);
      expect(entry?.omitted, spelled).toBe("credential-match");
    }
  });
  it("keeps the same sample when the value is not approved (it is a placeholder), so the drop above is the scan's and not luck", async () => {
    const { entry, root } = await records({ echoed: PASSWORD }, []);
    expect(entry?.omitted).toBeUndefined();
    expect((await readdir(join(root, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([captureApiSampleFileName(0, 0)]);
  });
});

describe("the recorder and the settled listing", () => {
  const policy = { screenshots: false, apiSamples: true };
  const sample = (n: number) => buildApiSample({ method: "GET", path: `/orders/${n}`, status: 200, responseHeaders: JSON_CT, responseBody: enc({ n: "x".repeat(n + 1) }) }).bytes!;
  it("is off unless the admitted policy asks, and a policy written before it reads as before", () => {
    expect(admittedCapturePolicy({ screenshots: true, traces: false })).toEqual({ screenshots: true });
    expect(admittedCapturePolicy({ screenshots: false, traces: false, apiSamples: true })).toEqual({ screenshots: false, apiSamples: true });
    const old = { screenshots: true, traces: false, video: false, downloads: true };
    expect(E2ECapturePolicySchema.parse(old)).toEqual(old);
    expect(E2ECapturePolicySchema.parse({ ...old, apiSamples: true }).apiSamples).toBe(true);
  });
  it("takes nothing when API samples are not admitted", async () => {
    const recorder = createCaptureRecorder({ root: await temp(), policy: { screenshots: true }, caseIds: ["case-a"], redactor: redactor() });
    expect(recorder.enabled("api-sample")).toBe(false);
    expect(await recorder.record({ caseId: "case-a", kind: "api-sample", bytes: sample(1), step: 0 })).toBeNull();
  });
  it("needs the request step it records, and still refuses a trace", async () => {
    const recorder = createCaptureRecorder({ root: await temp(), policy, caseIds: ["case-a"], redactor: redactor() });
    await expect(recorder.record({ caseId: "case-a", kind: "api-sample", bytes: sample(1) })).rejects.toThrow(/request step/);
    await expect(recorder.record({ caseId: "case-a", kind: "trace" as never, bytes: sample(1), step: 0 })).rejects.toThrow(/trace capture is not supported/);
  });
  it("keeps five samples a case; the sixth is a recorded drop, and screenshots count separately", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: { screenshots: true, mode: "all", apiSamples: true }, caseIds: ["case-a"], redactor: redactor() });
    const out = [];
    for (let step = 0; step < CAPTURE_API_SAMPLES_MAX + 1; step += 1) out.push(await recorder.record({ caseId: "case-a", kind: "api-sample", bytes: sample(step), step }));
    expect(out.slice(0, 5).every((entry) => entry?.omitted === undefined)).toBe(true);
    expect(out[5]?.omitted).toBe("budget");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    expect((await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg, step: 0 }))?.omitted).toBeUndefined();
  });
  it("lists samples after the case's screenshots, sheds them first under budget, and removes them when not admitted", async () => {
    const root = await temp();
    const recorder = createCaptureRecorder({ root, policy: { screenshots: true, apiSamples: true }, caseIds: ["case-a"], redactor: redactor() });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 1)]);
    await recorder.record({ caseId: "case-a", kind: "screenshot", bytes: jpeg });
    await recorder.record({ caseId: "case-a", kind: "api-sample", bytes: sample(1), step: 0 });
    const tight = await finalizeCaptureArtifacts({ outDir: root, policy: { screenshots: true, apiSamples: true }, caseIds: ["case-a"], redactor: redactor(), budgetBytes: 2_700 });
    expect(tight.map((entry) => [entry.kind, entry.omitted])).toEqual([["screenshot", undefined], ["api-sample", "budget"]]);
    const root2 = await temp();
    await createCaptureRecorder({ root: root2, policy: { screenshots: false, apiSamples: true }, caseIds: ["case-a"], redactor: redactor() }).record({ caseId: "case-a", kind: "api-sample", bytes: sample(2), step: 1 });
    expect(await finalizeCaptureArtifacts({ outDir: root2, policy: { screenshots: true }, caseIds: ["case-a"], redactor: redactor() })).toEqual([]);
    expect((await readdir(join(root2, CAPTURE_DIR))).filter((name) => name !== "entries")).toEqual([]);
  });
  it("is read back by the host with its name and step, and a sample carrying a credential is held back", async () => {
    const out = await temp();
    await mkdir(join(out, "observations"), { recursive: true });
    await mkdir(join(out, CAPTURE_DIR), { recursive: true });
    const clean = sample(3); const dirty = Buffer.concat([sample(4), Buffer.from(PASSWORD)]);
    await writeFile(join(out, CAPTURE_DIR, captureApiSampleFileName(0, 0)), clean);
    await writeFile(join(out, CAPTURE_DIR, captureApiSampleFileName(0, 1)), dirty);
    const row = (bytes: Uint8Array, step: number) => ({ caseId: "case-a", kind: "api-sample", sha256: sha(bytes), bytes: bytes.byteLength, step });
    await writeFile(join(out, "artifacts.json"), JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: [row(clean, 0), row(dirty, 1)] }));
    const result = { schemaVersion: "e2e-executor-result/v1", exitCode: 0, reason: null, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:01:00.000Z",
      node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: "r", groupId: "g", shards: [] } as never;
    const snapshot = await snapshotExecutorOutput(out, result, { containsCredential: (bytes) => redactor().contains(bytes) });
    expect(snapshot.executorEvidence.captures!.files.map((file) => file.name)).toEqual([captureApiSampleFileName(0, 0)]);
    expect(snapshot.executorEvidence.captures!.artifacts).toMatchObject([{ kind: "api-sample", step: 0 }, { kind: "api-sample", step: 1, omitted: "credential-match" }]);
  });
});

describe("recording from the API runtime", () => {
  const response = { status: 200, body: enc({ ok: "yes" }), contentType: "application/json" };
  it("builds the sample from the response and records it under the request step", async () => {
    const seen: Array<{ step: number; kind: string; bytes: Uint8Array }> = [];
    await recordApiSample({ samples: { record: async (item) => { seen.push(item); } }, caseId: "case-a", step: 2, method: "POST", path: "/orders", requestBody: { qty: 3 }, response });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ step: 2, kind: "api-sample" });
    const parsed = parseApiSample(seen[0]!.bytes)!;
    expect(parsed.request.body).toEqual({ kind: "json", value: { qty: "<number>" } });
    expect(parsed.response.body).toEqual({ kind: "json", value: { ok: "<string 3>" } });
  });
  it("passes the approved safe paths, and defaults to none", async () => {
    const seen: Uint8Array[] = [];
    await recordApiSample({ samples: { safePaths: ["ok"], record: async (item) => { seen.push(item.bytes); } }, caseId: "c", step: 0, method: "GET", path: "/x", requestBody: undefined, response });
    expect((parseApiSample(seen[0]!)!.response.body as { kind: "json"; value: { ok: string } }).value.ok).toBe("yes");
  });
  it("does nothing without a port, and absorbs a recorder that refuses", async () => {
    await expect(recordApiSample({ samples: undefined, caseId: "c", step: 0, method: "GET", path: "/x", requestBody: undefined, response })).resolves.toBeUndefined();
    await expect(recordApiSample({ samples: { record: async () => { throw new Error("budget"); } }, caseId: "c", step: 0, method: "GET", path: "/x", requestBody: undefined, response })).resolves.toBeUndefined();
  });
});

describe("the structural diff", () => {
  const sampleOf = (body: unknown, over: Partial<Parameters<typeof buildApiSample>[0]> = {}): ApiSample => parseApiSample(buildApiSample({ method: "GET", path: "/orders", status: 200, responseHeaders: JSON_CT, responseBody: enc(body), ...over }).bytes!)!;
  it("is no_baseline without a baseline sample", () => {
    expect(diffApiSamples(undefined, sampleOf({ a: 1 }))).toEqual({ diff: "no_baseline", changedPaths: [] });
  });
  it("is none when only the hidden values or their lengths differ", () => {
    expect(diffApiSamples(sampleOf({ name: "Ann", items: [{ id: "a" }] }), sampleOf({ name: "Bartholomew", items: [{ id: "bb" }, { id: "c" }] }))).toEqual({ diff: "none", changedPaths: [] });
  });
  it("names added, removed and retyped paths, never a value", () => {
    const result = diffApiSamples(sampleOf({ total: 1, gone: "x", kind: "a" }), sampleOf({ total: "1", fresh: true, kind: "a" }));
    expect(result.diff).toBe("changed");
    expect(result.changedPaths).toEqual(["$.fresh", "$.gone", "$.total"]);
  });
  it("compares the values of approved paths, and the status", () => {
    const before = sampleOf({ state: "open" }, { safePaths: ["state"] });
    expect(diffApiSamples(before, sampleOf({ state: "closed" }, { safePaths: ["state"] })).changedPaths).toEqual(["$.state"]);
    expect(diffApiSamples(before, sampleOf({ state: "open" }, { safePaths: ["state"], status: 500 })).changedPaths).toEqual(["$status"]);
  });
  it("caps the paths it lists at fifty", () => {
    const wide = (prefix: string) => sampleOf(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${prefix}${index}`, 1])));
    expect(diffApiSamples(wide("a"), wide("b")).changedPaths).toHaveLength(50);
  });
});

describe("the broker reads samples back and builds the api rows", () => {
  const sampleFile = (name: string, body: unknown, step: number) => { const data = buildApiSample({ method: "GET", path: "/orders", status: 200, responseHeaders: JSON_CT, responseBody: enc(body) }).bytes!; return { name, step, data }; };
  const evidenceOf = (files: Array<{ caseId: string; step: number; name: string; data: Uint8Array }>, extra: Record<string, unknown> = {}) => ({
    captures: {
      artifacts: files.map((file) => ({ caseId: file.caseId, kind: "api-sample", sha256: sha(file.data), bytes: file.data.byteLength, step: file.step, ...extra })),
      files: files.map((file) => ({ name: file.name, sha256: sha(file.data), bytes: file.data.byteLength, base64: Buffer.from(file.data).toString("base64") })),
    },
  });
  const ids = new Set(["case-a"]);
  it("returns each case's samples in step order, each held to its listed digest and the sample schema", () => {
    const one = sampleFile("case-0-api-2.json", { a: 1 }, 2); const two = sampleFile("case-0-api-0.json", { b: 1 }, 0);
    const read = readCaptureApiSamples(evidenceOf([{ caseId: "case-a", ...one }, { caseId: "case-a", ...two }]), ids);
    expect(read.get("case-a")?.map((item) => item.step)).toEqual([0, 2]);
  });
  it("ignores a dropped sample, a foreign case, tampered bytes, a name for another step, bytes that are no sample, and a sixth sample", () => {
    const good = sampleFile("case-0-api-0.json", { a: 1 }, 0);
    expect(readCaptureApiSamples(evidenceOf([{ caseId: "case-a", ...good }], { omitted: "budget" }), ids).size).toBe(0);
    expect(readCaptureApiSamples(evidenceOf([{ caseId: "case-z", ...good }]), ids).size).toBe(0);
    const tampered = evidenceOf([{ caseId: "case-a", ...good }]);
    tampered.captures.files[0]!.base64 = Buffer.from(sampleFile("x", { z: 1 }, 0).data).toString("base64");
    expect(readCaptureApiSamples(tampered, ids).size).toBe(0);
    expect(readCaptureApiSamples(evidenceOf([{ caseId: "case-a", ...good, name: "case-0-api-1.json" }]), ids).size).toBe(0);
    const junk = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(readCaptureApiSamples(evidenceOf([{ caseId: "case-a", step: 0, name: "case-0-api-0.json", data: junk }]), ids).size).toBe(0);
    const six = Array.from({ length: 6 }, (_, step) => ({ caseId: "case-a", ...sampleFile(`case-0-api-${step}.json`, { [`k${step}`]: 1 }, step) }));
    expect(readCaptureApiSamples(evidenceOf(six), ids).get("case-a")).toHaveLength(5);
  });
  it("does not take a screenshot's entry for a sample, nor a sample's for a screenshot", () => {
    const good = sampleFile("case-0-api-0.json", { a: 1 }, 0);
    const wrongKind = evidenceOf([{ caseId: "case-a", ...good }]);
    (wrongKind.captures.artifacts[0] as { kind: string }).kind = "screenshot";
    expect(readCaptureApiSamples(wrongKind, ids).size).toBe(0);
  });
  it("diffs a candidate scenario against the baseline by request step", () => {
    const mk = (body: unknown, step: number) => { const data = buildApiSample({ method: "GET", path: "/o", status: 200, responseHeaders: JSON_CT, responseBody: enc(body) }).bytes!; return { step, sha256: sha(data), data, sample: parseApiSample(data)! }; };
    const candidate = scenarioSamplesOf([{ cases: [{ caseId: "c1", scenarioId: "orders" }, { caseId: "c2", scenarioId: "pay" }], samples: new Map([["c1", [mk({ a: 1, b: 2 }, 0), mk({ x: 1 }, 1)]], ["c2", [mk({ p: 1 }, 0)]]]) }]);
    const baseline = scenarioSamplesOf([{ cases: [{ caseId: "b1", scenarioId: "orders" }], samples: new Map([["b1", [mk({ a: 1 }, 0), mk({ x: 1 }, 1)]]]) }]);
    const built = apiEvidenceOf({ candidate, baseline });
    expect(built.api.map((row) => [row.scenarioId, row.diff, row.changedPaths])).toEqual([["orders", "changed", ["step 0 $.b"]], ["pay", "no_baseline", []]]);
    expect(built.api[0]?.samples.every((ref) => ref.kind === "api_sample_json" && ref.retentionClass === "evidence-std")).toBe(true);
    expect(apiEvidenceOf({ candidate }).api.every((row) => row.diff === "no_baseline")).toBe(true);
    const same = apiEvidenceOf({ candidate, baseline: candidate });
    expect(same.api.map((row) => row.diff)).toEqual(["none", "none"]);
    // a baseline whose steps share none with the candidate's compares nothing
    expect(apiEvidenceOf({ candidate: candidate.slice(0, 1), baseline: [{ scenarioId: "orders", samples: [mk({ a: 1 }, 7)] }] }).api[0]?.diff).toBe("no_baseline");
  });
  it("makes rows the evidence pack accepts, and the pack drops a sample the store does not hold", () => {
    const data = buildApiSample({ method: "GET", path: "/o", status: 200, responseHeaders: JSON_CT, responseBody: enc({ a: 1 }) }).bytes!;
    const candidate = [{ scenarioId: "orders", samples: [{ step: 0, sha256: sha(data), data, sample: parseApiSample(data)! }] }];
    const built = apiEvidenceOf({ candidate });
    const DIGEST = "c".repeat(64);
    const environment: EvidenceEnvironment = { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }] };
    const common = { candidateDigest: DIGEST, checks: [], environment, rawText: JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], api: built.api }) };
    const whole = buildEvidencePack({ ...common, storedArtifacts: new Map(built.artifacts.map((item) => [item.ref.sha256, { kind: item.ref.kind, bytes: item.ref.bytes }])) });
    expect(whole.problems).toEqual([]);
    expect(EvidencePackSchema.safeParse(whole.pack).success).toBe(true);
    expect(whole.pack?.api[0]).toMatchObject({ scenarioId: "orders", diff: "no_baseline" });
    expect(buildEvidencePack({ ...common, storedArtifacts: new Map() }).pack?.api[0]?.samples).toEqual([]);
  });
});

describe("small things in the samples and the evidence lines", () => {
  it("M6: a sample's path is a fixed path: a query or a fragment withholds the sample", () => {
    for (const path of ["/orders?token=abc", "/orders#frag", "/o?"]) expect(buildApiSample({ method: "GET", path, status: 200 })).toEqual({ bytes: undefined, withheld: "invalid" });
    expect(buildApiSample({ method: "GET", path: "/orders/42", status: 200 }).bytes).toBeDefined();
  });
  it("M6: changed paths carry real key names from bodies, so no pull request line may print them (they are not among the fixed evidence words)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["packages/core/src/core/proof/evidence-lines.ts", "packages/core/src/core/proof/proof-section.ts"]) expect(readFileSync(file, "utf8"), file).not.toMatch(/changedPaths/u);
  });
});
