// B5: the DynamoDB adapter behind the product key store, the KMS client that seals keys, the production eval approvals and
// budget (B7's records), the learning key source (#57) and the overrun marks. Through the real wire: the gateway's own signed
// DynamoDB requests against the fake service, so conditions, transactions and TTL attributes are DynamoDB's.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { awsKms } from "../../packages/model-gateway/src/aws-kms.js";
import type { WireRequest } from "../../packages/model-gateway/src/aws.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoProductKeyTable, PRODUCT_KEYS_TTL_ATTRIBUTE, productKeyTableKey } from "../../packages/model-gateway/src/dynamo-product-keys.js";
import { DynamoProductOverrunTasks } from "../../packages/model-gateway/src/dynamo-product-overrun.js";
import { EVAL_APPROVAL_FRESH_MS, storedEvalApprovals, storedEvalBudget } from "../../packages/model-gateway/src/eval-approvals.js";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { CURRENT_STAGE, LEARNING_OWNER, PRODUCT_COMPANY_OWNER, ProductKeyError, ProductKeyStore, type ProductActor } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, kmsProductKeyService, localProductKeyService, ProductKeySealer, SealedProductKeyRefused } from "../../packages/model-gateway/src/product-seal.js";
import { now } from "./model-gateway-fixture.js";
import { geminiKey } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const ISS = "https://code.example.com/v1/auth";
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const PROJECT = "web";
const admin: ProductActor = { id: "b".repeat(64), role: "company_admin" };
const maintainer: ProductActor = { id: "c".repeat(64), role: "project_maintainer" };
const creds = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" });

function kit() {
  const wire = new WireDynamo(["gw-product-keys", "gw-pmarkers"]);
  const db = new Dynamo({ region: "us-west-2", credentials: creds, transport: wire.transport });
  const table = new DynamoProductKeyTable(db, "gw-product-keys");
  const keyService = localProductKeyService(randomBytes(32));
  const clock = { at: now };
  const store = new ProductKeyStore({ table, sealer: new ProductKeySealer(keyService), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => clock.at, providers: ["gemini", "anthropic", "openai"] });
  return { wire, db, table, store, clock, keyService, rows: () => wire.items("gw-product-keys") };
}
const change = (cid: string, owner: string, expectedRevision: number, actor: ProductActor = maintainer) => ({ iss: ISS, cid, owner, requestId: randomUUID(), expectedRevision, actor });

describe("product key table: keys and isolation", () => {
  it("splits a store key into the company partition and the row, refusing anything else", () => {
    expect(productKeyTableKey(`CO#${JSON.stringify([ISS, A])}#doc#web`)).toEqual({ pk: `CO#${JSON.stringify([ISS, A])}`, sk: "doc#web" });
    // An issuer holding "]#" is still split at the end of the JSON array, never inside it.
    const odd = "https://x.example/]#/v1/auth";
    expect(productKeyTableKey(`CO#${JSON.stringify([odd, A])}#key#web#src_a#v`)).toEqual({ pk: `CO#${JSON.stringify([odd, A])}`, sk: "key#web#src_a#v" });
    for (const bad of ["doc#web", `CO#${JSON.stringify([ISS])}#doc`, `CO#${JSON.stringify([ISS, A])}#`, `XX#${JSON.stringify([ISS, A])}#doc#web`]) expect(() => productKeyTableKey(bad)).toThrow();
  });

  it("connect, rotate, remove and recover through DynamoDB: one transaction each, key rows at the right stage, purge by TTL", async () => {
    const k = kit();
    const key1 = geminiKey(); const key2 = geminiKey();
    const v1 = await k.store.connect({ ...change(A, PROJECT, 0), sourceId: "src_gem", provider: "gemini", key: key1 });
    expect(v1.revision).toBe(1);
    const resolved = (await k.store.resolve(ISS, A, PROJECT, "gemini"))!;
    expect(await k.store.useKey(ISS, A, resolved)).toBe(key1);
    // Every row of the company sits under its own partition; the doc, receipt, audit and key rows were one transaction.
    expect(k.rows().every((row) => row.pk === `CO#${JSON.stringify([ISS, A])}`)).toBe(true);
    expect(k.wire.calls.filter((c) => c.operation === "TransactWriteItems")).toHaveLength(1);
    // The receipt expires a day later (TTL attribute); the doc and audit row are kept.
    const receipt = k.rows().find((row) => String(row.sk).startsWith("req#"))!;
    expect(receipt[PRODUCT_KEYS_TTL_ATTRIBUTE]).toBe(Math.floor(now / 1000) + 86_400);
    expect(k.rows().find((row) => String(row.sk).startsWith("doc#"))![PRODUCT_KEYS_TTL_ATTRIBUTE]).toBeUndefined();
    // Never the key in clear on any row (the sealed text only), never in the audit row.
    expect(JSON.stringify(k.rows())).not.toContain(key1);
    expect(JSON.stringify(k.rows().find((row) => String(row.sk).startsWith("audit#")))).not.toMatch(/sealed|fingerprint/u);

    await k.store.rotate({ ...change(A, PROJECT, 1), sourceId: "src_gem", key: key2 });
    const rotated = (await k.store.resolve(ISS, A, PROJECT, "gemini"))!;
    expect(await k.store.useKey(ISS, A, rotated)).toBe(key2);
    // The old version is AWSPREVIOUS, purged after 7 days, and reads as absent.
    const old = k.rows().find((row) => row.sk === `key#${PROJECT}#src_gem#${resolved.versionId}`)!;
    expect(old.f_stage).toBe("AWSPREVIOUS");
    expect(old[PRODUCT_KEYS_TTL_ATTRIBUTE]).toBe(Math.floor((now + 7 * 86_400_000) / 1000));
    expect(await k.store.useKey(ISS, A, resolved)).toBeUndefined();

    await k.store.remove({ ...change(A, PROJECT, 2), sourceId: "src_gem" });
    expect(await k.store.resolve(ISS, A, PROJECT, "gemini")).toBeUndefined();
    expect(await k.store.useKey(ISS, A, rotated)).toBeUndefined();
    await k.store.recover({ ...change(A, PROJECT, 3), sourceId: "src_gem" });
    const back = k.rows().find((row) => row.sk === `key#${PROJECT}#src_gem#${rotated.versionId}`)!;
    expect(back.f_stage).toBe(CURRENT_STAGE);
    expect(back[PRODUCT_KEYS_TTL_ATTRIBUTE]).toBeUndefined();
    expect(await k.store.useKey(ISS, A, rotated)).toBe(key2);
  });

  it("refuses a key-row read that does not name AWSCURRENT before any DynamoDB call", async () => {
    const k = kit();
    await k.store.connect({ ...change(A, PROJECT, 0), sourceId: "src_gem", provider: "gemini", key: geminiKey() });
    const keyRow = k.rows().find((row) => String(row.sk).startsWith("key#"))!;
    const before = k.wire.calls.length;
    await expect(k.table.get(`${String(keyRow.pk)}#${String(keyRow.sk)}`)).rejects.toThrow(/AWSCURRENT/u);
    expect(k.wire.calls.length).toBe(before);
  });

  it("a stale revision, a lost race or a replayed request with another intent writes nothing", async () => {
    const k = kit();
    await k.store.connect({ ...change(A, PROJECT, 0), sourceId: "src_gem", provider: "gemini", key: geminiKey() });
    const rows = JSON.stringify(k.rows());
    await expect(k.store.setCaps({ ...change(A, PROJECT, 0), caps: { taskMicros: 1, projectMonthMicros: 2 } })).rejects.toThrow(new ProductKeyError("stale"));
    // Two changes on the same revision at once: exactly one applies (the doc's version condition).
    const results = await Promise.allSettled([
      k.store.setCaps({ ...change(A, PROJECT, 1), caps: { taskMicros: 1, projectMonthMicros: 2 } }),
      k.store.setCaps({ ...change(A, PROJECT, 1), caps: { taskMicros: 3, projectMonthMicros: 4 } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(JSON.stringify(k.rows())).not.toBe(rows);
    const c = change(A, PROJECT, 2);
    await k.store.setCaps({ ...c, caps: { taskMicros: 5, projectMonthMicros: 6 } });
    // The same request id again: idempotent; with another intent: refused.
    expect((await k.store.setCaps({ ...c, caps: { taskMicros: 5, projectMonthMicros: 6 } })).revision).toBe(3);
    await expect(k.store.setCaps({ ...c, caps: { taskMicros: 7, projectMonthMicros: 8 } })).rejects.toThrow(new ProductKeyError("invalid"));
  });

  it("two companies: the same project name and source id stay apart, and a sealed key copied to the other company does not open", async () => {
    const k = kit();
    const keyA = geminiKey(); const keyB = geminiKey();
    await k.store.connect({ ...change(A, PROJECT, 0), sourceId: "src_gem", provider: "gemini", key: keyA });
    await k.store.connect({ ...change(B, PROJECT, 0), sourceId: "src_gem", provider: "gemini", key: keyB });
    const ra = (await k.store.resolve(ISS, A, PROJECT, "gemini"))!; const rb = (await k.store.resolve(ISS, B, PROJECT, "gemini"))!;
    expect(await k.store.useKey(ISS, A, ra)).toBe(keyA);
    expect(await k.store.useKey(ISS, B, rb)).toBe(keyB);
    // B with A's resolution names a row in B's partition: nothing there.
    expect(await k.store.useKey(ISS, B, ra)).toBeUndefined();
    // Copy A's sealed row into B's partition under B's version id: the seal is bound to the company and version, so it fails.
    const aRow = k.rows().find((row) => row.pk === `CO#${JSON.stringify([ISS, A])}` && String(row.sk).startsWith("key#"))!;
    await k.db.put("gw-product-keys", { ...aRow, pk: `CO#${JSON.stringify([ISS, B])}`, sk: `key#${PROJECT}#src_gem#${rb.versionId}` });
    await expect(k.store.useKey(ISS, B, rb)).rejects.toBeInstanceOf(SealedProductKeyRefused);
    // Views never carry a key.
    expect(JSON.stringify(await k.store.view(ISS, A, PROJECT))).not.toContain(keyA);
  });
});

describe("product key table: conditions are DynamoDB's own", () => {
  it("a put or check at another version, or a put of an existing row as new, writes nothing", async () => {
    const k = kit();
    const doc = `CO#${JSON.stringify([ISS, A])}#doc#web`;
    expect(await k.table.transact([{ key: doc, put: { sources: [] }, condition: { absent: true } }])).toBe(true);
    expect(await k.table.transact([{ key: doc, put: { sources: [] }, condition: { absent: true } }])).toBe(false);
    expect(await k.table.transact([{ key: doc, put: { sources: [1] }, condition: { version: 5 } }])).toBe(false);
    expect((await k.table.get(doc))!).toEqual({ version: 1, item: { sources: [] } });
    // A check at the wrong version fails the whole transaction, including a write to another row.
    const other = `CO#${JSON.stringify([ISS, A])}#doc#api`;
    expect(await k.table.transact([{ key: doc, check: { version: 2 } }, { key: other, put: { sources: [] }, condition: { absent: true } }])).toBe(false);
    expect(await k.table.get(other)).toBeUndefined();
    expect(await k.table.transact([{ key: doc, put: { sources: [2] }, condition: { version: 1 } }])).toBe(true);
    expect((await k.table.get(doc))!.version).toBe(2);
  });
  it("the sealed text is bound to the row on its own (GCM additional data), even under a key service that ignored the context", async () => {
    const local = localProductKeyService(randomBytes(32));
    // A key service that binds nothing: only the seal's own binding is left.
    const lenient = { generateDataKey: () => local.generateDataKey({}), unwrapDataKey: (wrapped: Uint8Array) => local.unwrapDataKey(wrapped, {}) };
    const sealer = new ProductKeySealer(lenient);
    const row = { iss: ISS, cid: A, owner: PROJECT, sourceId: "src_gem", versionId: "v1" };
    const sealed = await sealer.seal("secret-key-value", row);
    expect(await sealer.open(sealed, row)).toBe("secret-key-value");
    for (const moved of [{ ...row, cid: B }, { ...row, owner: "api" }, { ...row, versionId: "v2" }, { ...row, sourceId: "src_x" }, { ...row, iss: "https://other.example/v1/auth" }]) {
      await expect(sealer.open(sealed, moved)).rejects.toBeInstanceOf(SealedProductKeyRefused);
    }
  });
});

describe("eval approvals and budgets (the records Cloud's settings routes write)", () => {
  const approval = { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 50, maxCostMicros: 500_000 };
  it("records the approver as the actor, re-reads on every hold, and stops counting after 15 minutes (stale) or when withdrawn", async () => {
    const k = kit();
    const source = storedEvalApprovals(k.store, () => k.clock.at);
    expect(await source.current(ISS, A, PROJECT)).toBeUndefined();
    await k.store.setEvalApproval({ ...change(A, PROJECT, 0), approval, provider: "github" });
    expect(await source.current(ISS, A, PROJECT)).toEqual({ ...approval, approver: { personId: maintainer.id, provider: "github" } });
    expect(await source.roleOf(ISS, A, PROJECT, { personId: maintainer.id, provider: "github" })).toBe("maintainer");
    expect(await source.roleOf(ISS, A, PROJECT, { personId: admin.id, provider: "github" })).toBeUndefined();
    // Another company's project of the same name has no approval.
    expect(await source.current(ISS, B, PROJECT)).toBeUndefined();
    k.clock.at = now + EVAL_APPROVAL_FRESH_MS;
    expect(await source.current(ISS, A, PROJECT)).toBe("stale");
    expect(await source.roleOf(ISS, A, PROJECT, { personId: maintainer.id, provider: "github" })).toBeUndefined();
    k.clock.at = now;
    await k.store.setEvalApproval({ ...change(A, PROJECT, 1, admin), approval: null, provider: "github" });
    expect(await source.current(ISS, A, PROJECT)).toBeUndefined();
  });
  it("the project's budget, else DEC 203's default; invalid values are refused", async () => {
    const k = kit();
    const budget = storedEvalBudget(k.store);
    expect(await budget(ISS, A, PROJECT)).toEqual({ calls: 400, costMicros: 4_000_000 });
    await k.store.setEvalBudget({ ...change(A, PROJECT, 0), budget: { calls: 20, costMicros: 200_000 } });
    expect(await budget(ISS, A, PROJECT)).toEqual({ calls: 20, costMicros: 200_000 });
    expect(await budget(ISS, B, PROJECT)).toEqual({ calls: 400, costMicros: 4_000_000 });
    for (const bad of [{ calls: 0, costMicros: 1 }, { calls: 1, costMicros: 0 }, { calls: 1.5, costMicros: 1 }, { calls: 1, costMicros: 1, extra: 1 }]) {
      await expect(k.store.setEvalBudget({ ...change(A, PROJECT, 1), budget: bad })).rejects.toThrow(new ProductKeyError("invalid"));
    }
    await expect(k.store.setEvalApproval({ ...change(A, PROJECT, 1), approval: { ...approval, inputsDigest: "not-a-digest" }, provider: "github" })).rejects.toThrow(new ProductKeyError("invalid"));
    await expect(k.store.setEvalBudget({ ...change(A, PRODUCT_COMPANY_OWNER, 0, admin), budget: { calls: 1, costMicros: 1 } })).rejects.toThrow(new ProductKeyError("invalid"));
  });
});

describe("learning key source (#57, PRODUCT-LEARNING-CONNECT-ROUTE): the company's own learning accounts in the same sealed store", () => {
  it("is the company's learning document only, never a project's or the product sources', never linked; each provider answers only its own account", async () => {
    const k = kit();
    const keys = storedLearningKeys(k.store);
    expect(await keys.connected(ISS, A, "anthropic")).toBe(false);
    const anthropic = ["sk", "ant", randomBytes(16).toString("hex")].join("-");
    const openai = ["sk", "proj", randomBytes(16).toString("hex")].join("-");
    // Never in a project or in the company's product sources; only a company admin.
    await expect(k.store.connect({ ...change(A, PROJECT, 0), sourceId: "src_anthropic", provider: "anthropic", key: anthropic })).rejects.toThrow(new ProductKeyError("invalid"));
    await expect(k.store.connect({ ...change(A, PRODUCT_COMPANY_OWNER, 0, admin), sourceId: "src_anthropic", provider: "anthropic", key: anthropic })).rejects.toThrow(new ProductKeyError("invalid"));
    await expect(k.store.connect({ ...change(A, PRODUCT_COMPANY_OWNER, 0, admin), sourceId: "src_openai", provider: "openai", key: openai })).rejects.toThrow(new ProductKeyError("invalid"));
    await expect(k.store.connect({ ...change(A, LEARNING_OWNER, 0, maintainer), sourceId: "src_anthropic", provider: "anthropic", key: anthropic })).rejects.toThrow(new ProductKeyError("forbidden"));
    await k.store.connect({ ...change(A, LEARNING_OWNER, 0, admin), sourceId: "src_anthropic", provider: "anthropic", key: anthropic });
    expect(await keys.connected(ISS, A, "anthropic")).toBe(true);
    expect(await keys.keyFor(ISS, A, "anthropic")).toBe(anthropic);
    // Another provider's path never gets this key.
    for (const provider of ["openai", "gemini", "vertex"] as const) {
      expect(await keys.connected(ISS, A, provider)).toBe(false);
      expect(await keys.keyFor(ISS, A, provider)).toBeUndefined();
    }
    await k.store.connect({ ...change(A, LEARNING_OWNER, 1, admin), sourceId: "src_openai", provider: "openai", key: openai });
    expect(await keys.keyFor(ISS, A, "openai")).toBe(openai);
    expect(await keys.keyFor(ISS, A, "anthropic")).toBe(anthropic);
    // One account per provider; the product-only Vertex is not a learning account.
    await expect(k.store.connect({ ...change(A, LEARNING_OWNER, 2, admin), sourceId: "src_anthropic2", provider: "anthropic", key: anthropic })).rejects.toThrow(new ProductKeyError("invalid"));
    await expect(k.store.connect({ ...change(A, LEARNING_OWNER, 2, admin), sourceId: "src_vertex", provider: "vertex", key: "{}" })).rejects.toThrow(new ProductKeyError("invalid"));
    // Two companies never meet.
    expect(await keys.connected(ISS, B, "anthropic")).toBe(false);
    expect(await keys.keyFor(ISS, B, "anthropic")).toBeUndefined();
    // Never linked into a project (it is not among the company's product sources at all).
    await expect(k.store.link({ ...change(A, PROJECT, 0), sourceId: "src_lnk", companySourceId: "src_anthropic" })).rejects.toThrow(new ProductKeyError("not_found"));
    expect(await k.store.choices(ISS, A)).toEqual([]);
    // A Gemini learning account is not a product source: the product route never resolves it.
    await k.store.connect({ ...change(A, LEARNING_OWNER, 2, admin), sourceId: "src_gemini", provider: "gemini", key: geminiKey() });
    expect(await k.store.resolve(ISS, A, PROJECT, "gemini")).toBeUndefined();
    // The learning document never links to the company's product sources either.
    // (Company B: its learning document is empty, so only that rule can refuse it.)
    await k.store.connect({ ...change(B, PRODUCT_COMPANY_OWNER, 0, admin), sourceId: "src_shared", provider: "gemini", key: geminiKey() });
    await expect(k.store.link({ ...change(B, LEARNING_OWNER, 0, admin), sourceId: "src_lnk", companySourceId: "src_shared" })).rejects.toThrow(new ProductKeyError("invalid"));
    // A provider refusal is recorded on that account (shown in Settings), never on another one.
    await keys.refused?.(ISS, A, "openai");
    const marked = await k.store.view(ISS, A, LEARNING_OWNER);
    expect(marked.sources.find((s) => s.provider === "openai")?.warning).toEqual({ status: 401, at: now });
    expect(marked.sources.find((s) => s.provider === "anthropic")?.warning).toBeUndefined();
    await k.store.remove({ ...change(A, LEARNING_OWNER, marked.revision, admin), sourceId: "src_anthropic" });
    expect(await keys.connected(ISS, A, "anthropic")).toBe(false);
    expect(await keys.keyFor(ISS, A, "anthropic")).toBeUndefined();
    // The learning document holds no caps, ceiling, eval budget or approval.
    const after = await k.store.view(ISS, A, LEARNING_OWNER);
    expect(after).not.toHaveProperty("caps");
    expect(after).not.toHaveProperty("evalBudget");
    await expect(k.store.setEvalBudget({ ...change(A, LEARNING_OWNER, after.revision, admin), budget: { calls: 1, costMicros: 1 } })).rejects.toThrow(new ProductKeyError("invalid"));
  });
});

describe("KMS client (aws-kms.ts): the two calls, bound to the row's encryption context", () => {
  it("speaks KMS's JSON protocol, and a refusal is told apart from an outage", async () => {
    const requests: WireRequest[] = [];
    const plaintext = randomBytes(32); const wrapped = randomBytes(64);
    let answer: { status: number; body: unknown } = { status: 200, body: { Plaintext: plaintext.toString("base64"), CiphertextBlob: wrapped.toString("base64"), KeyId: "k" } };
    const kms = awsKms({ region: "us-west-2", credentials: creds, transport: async (request) => { requests.push(request); return { status: answer.status, body: Buffer.from(JSON.stringify(answer.body)) }; } });
    const keyArn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000";
    const service = kmsProductKeyService(kms, keyArn);
    const context = { purpose: "rovara-product-ai-key", install: ISS, company: A, owner: PROJECT, source: "src_gem", version: "v" };
    const made = await service.generateDataKey(context);
    expect(Buffer.from(made.plaintext).equals(plaintext)).toBe(true);
    expect(requests[0]!.url).toBe("https://kms.us-west-2.amazonaws.com/");
    expect(requests[0]!.headers["x-amz-target"]).toBe("TrentService.GenerateDataKey");
    expect(requests[0]!.headers.authorization).toMatch(/\/us-west-2\/kms\/aws4_request/u);
    expect(JSON.parse(requests[0]!.body.toString())).toEqual({ KeyId: keyArn, KeySpec: "AES_256", EncryptionContext: context });
    answer = { status: 200, body: { Plaintext: plaintext.toString("base64") } };
    expect(Buffer.from(await service.unwrapDataKey(wrapped, context)).equals(plaintext)).toBe(true);
    expect(JSON.parse(requests[1]!.body.toString())).toEqual({ KeyId: keyArn, CiphertextBlob: wrapped.toString("base64"), EncryptionContext: context });
    answer = { status: 400, body: { __type: "InvalidCiphertextException", message: "x" } };
    await expect(service.unwrapDataKey(wrapped, context)).rejects.toBeInstanceOf(SealedProductKeyRefused);
    answer = { status: 400, body: { __type: "AccessDeniedException", message: "x" } };
    await expect(service.unwrapDataKey(wrapped, context)).rejects.toThrow("product keys unavailable");
  });
});

describe("overrun marks (DEC 165) shared by every gateway task", () => {
  it("blocks one task of one company only, expiring after twice the token's life", async () => {
    const k = kit();
    const marks = new DynamoProductOverrunTasks(k.db, "gw-pmarkers", () => now);
    expect(await marks.isBlocked(ISS, A, "task_1")).toBe(false);
    await marks.block(ISS, A, "task_1");
    expect(await marks.isBlocked(ISS, A, "task_1")).toBe(true);
    expect(await marks.isBlocked(ISS, A, "task_2")).toBe(false);
    expect(await marks.isBlocked(ISS, B, "task_1")).toBe(false);
    const row = k.wire.items("gw-pmarkers")[0]!;
    expect(row).toMatchObject({ pk: `CO#${JSON.stringify([ISS, A])}`, sk: "PRODUCT_OVERRUN#task_1", expiresAt: Math.floor(now / 1000) + 1800 });
  });
});
