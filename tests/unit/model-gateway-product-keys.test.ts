import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { ProductKeyError, PRODUCT_DEFAULT_CAPS, isKeyRow } from "../../packages/model-gateway/src/product-keys.js";
import { kmsProductKeyService, localProductKeyService, ProductKeySealer, SealedProductKeyRefused } from "../../packages/model-gateway/src/product-seal.js";
import { now } from "./model-gateway-fixture.js";
import { admin, change, cid, COMPANY, connected, geminiKey, iss, maintainer, pid, storeKit } from "./model-gateway-product-fixture.js";

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ProductKeyError ? e.code : `other:${String(e)}`; } };
const everything = (kit: ReturnType<typeof storeKit>) => JSON.stringify([...kit.table.rows.entries()]);

describe("product key store: write-only, sealed, revisioned", () => {
  it("connect stores only a sealed key; no answer, document, audit or receipt row carries it", async () => {
    const kit = await connected();
    const view = await kit.store.view(iss, cid, pid);
    expect(view).toMatchObject({ revision: 1, owner: pid, pending: false, caps: PRODUCT_DEFAULT_CAPS, sources: [{ sourceId: "src_gem", provider: "gemini", hasKey: true, available: true }] });
    expect(JSON.stringify(view)).not.toContain(kit.key);
    expect(everything(kit)).not.toContain(kit.key);
    expect(everything(kit)).not.toContain(Buffer.from(kit.key).toString("base64url"));
    const audit = [...kit.table.rows.entries()].filter(([k]) => k.includes("#audit#"));
    expect(audit).toHaveLength(1); expect(audit[0]![1].item).toMatchObject({ action: "product_ai.connect", by: "c".repeat(64), role: "project_maintainer", sourceId: "src_gem" });
    expect(JSON.stringify(audit)).not.toContain("fingerprint");
    const resolution = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    expect(await kit.store.useKey(iss, cid, resolution)).toBe(kit.key);
  });
  it("every row key starts with the install + company leading key", async () => {
    const kit = await connected();
    expect([...kit.table.rows.keys()].every((k) => k.startsWith(`CO#${JSON.stringify([iss, cid])}#`))).toBe(true);
  });
  it("a sealed key copied to another company, project, source or version does not open", async () => {
    const service = localProductKeyService(randomBytes(32)); const sealer = new ProductKeySealer(service);
    const row = { iss, cid, owner: pid, sourceId: "src_a", versionId: randomUUID() };
    const sealed = await sealer.seal("secret-value-1234", row);
    expect(await sealer.open(sealed, row)).toBe("secret-value-1234");
    for (const other of [{ cid: `org_${"b".repeat(20)}` }, { owner: "api" }, { sourceId: "src_b" }, { versionId: randomUUID() }, { iss: "https://install-b.example/v1/auth" }]) {
      await expect(sealer.open(sealed, { ...row, ...other })).rejects.toBeInstanceOf(SealedProductKeyRefused);
    }
    await expect(new ProductKeySealer(localProductKeyService(randomBytes(32))).open(sealed, row)).rejects.toBeInstanceOf(SealedProductKeyRefused);
  });
  it("the GCM additional data binds the row on its own, even under a key service that ignores the context", async () => {
    const blind = localProductKeyService(randomBytes(32));
    const contextBlind = { generateDataKey: () => blind.generateDataKey({}), unwrapDataKey: (w: Uint8Array) => blind.unwrapDataKey(w, {}) };
    const sealer = new ProductKeySealer(contextBlind);
    const row = { iss, cid, owner: pid, sourceId: "src_a", versionId: randomUUID() };
    const sealed = await sealer.seal("secret-value-1234", row);
    expect(await sealer.open(sealed, row)).toBe("secret-value-1234");
    for (const other of [{ cid: `org_${"b".repeat(20)}` }, { owner: "api" }, { sourceId: "src_b" }, { versionId: randomUUID() }, { iss: "https://install-b.example/v1/auth" }]) {
      await expect(sealer.open(sealed, { ...row, ...other })).rejects.toBeInstanceOf(SealedProductKeyRefused);
    }
  });
  it("the KMS adapter names the key, passes the row context, and maps only KMS refusals to 'refused'", async () => {
    const calls: unknown[] = [];
    const kms = { generateDataKey: async (input: unknown) => { calls.push(input); return { Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array([1, 2, 3]) }; }, decrypt: async (input: unknown) => { calls.push(input); return { Plaintext: new Uint8Array(32).fill(7) }; } };
    const sealer = new ProductKeySealer(kmsProductKeyService(kms, "alias/product"));
    const row = { iss, cid, owner: pid, sourceId: "src_a", versionId: randomUUID() };
    expect(await sealer.open(await sealer.seal("abcdefgh", row), row)).toBe("abcdefgh");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ KeyId: "alias/product", KeySpec: "AES_256", EncryptionContext: { purpose: "rovara-product-ai-key", install: iss, company: cid, owner: pid, source: "src_a", version: row.versionId } });
    expect(calls[1]).toMatchObject({ KeyId: "alias/product", EncryptionContext: { company: cid, source: "src_a", version: row.versionId } });
    const refusing = new ProductKeySealer(kmsProductKeyService({ ...kms, decrypt: async () => { throw Object.assign(new Error("x"), { name: "InvalidCiphertextException" }); } }, "k"));
    await expect(refusing.open(await sealer.seal("abcdefgh", row), row)).rejects.toBeInstanceOf(SealedProductKeyRefused);
    const outage = new ProductKeySealer(kmsProductKeyService({ ...kms, decrypt: async () => { throw Object.assign(new Error("throttled detail"), { name: "ThrottlingException" }); } }, "k"));
    await expect(outage.open(await sealer.seal("abcdefgh", row), row)).rejects.toThrow("product keys unavailable");
  });
  it("rotation promotes the new version to AWSCURRENT and demotes the old to AWSPREVIOUS with a 7-day purge", async () => {
    const kit = await connected();
    const before = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    const next = geminiKey();
    await kit.store.rotate({ ...change(pid, 1, maintainer), sourceId: "src_gem", key: next });
    const after = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    expect(after.versionId).not.toBe(before.versionId);
    expect(await kit.store.useKey(iss, cid, after)).toBe(next);
    expect(await kit.store.useKey(iss, cid, before)).toBeUndefined();
    const old = [...kit.table.rows.entries()].find(([k]) => k.endsWith(before.versionId))![1].item;
    expect(old.stage).toBe("AWSPREVIOUS"); expect(old.purgeAfter).toBe(Math.floor((now + 7 * 86_400_000) / 1000));
  });
  it("revision fences: a stale expected revision is refused and writes nothing", async () => {
    const kit = await connected();
    const rows = everything(kit);
    expect(await code(kit.store.rotate({ ...change(pid, 0, maintainer), sourceId: "src_gem", key: geminiKey() }))).toBe("stale");
    expect(everything(kit)).toBe(rows);
  });
  it("a replayed request id is idempotent; the same id with a different intent is refused", async () => {
    const kit = storeKit();
    const key = geminiKey();
    const first = { ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini" as const, key };
    await kit.store.connect(first);
    expect((await kit.store.connect(first)).revision).toBe(1);
    expect(await code(kit.store.connect({ ...first, key: geminiKey() }))).toBe("invalid");
    expect(await code(kit.store.connect({ ...first, sourceId: "src_other" }))).toBe("invalid");
  });
  it("roles: a project maintainer can change the project; company sources and the ceiling are admin-only", async () => {
    const kit = storeKit();
    expect(await code(kit.store.connect({ ...change(COMPANY, 0, maintainer), sourceId: "src_co", provider: "gemini", key: geminiKey() }))).toBe("forbidden");
    expect(await code(kit.store.setCeiling({ ...change(COMPANY, 0, maintainer), ceiling: { taskMicros: 1 } }))).toBe("forbidden");
    expect(await code(kit.store.connect({ ...change(COMPANY, 0, admin), sourceId: "src_co", provider: "gemini", key: geminiKey() }))).toBe("ok");
  });
  it("the company ceiling clamps project caps (DEC 157)", async () => {
    const kit = await connected();
    await kit.store.setCaps({ ...change(pid, 1, maintainer), caps: { taskMicros: 5_000_000, projectMonthMicros: 90_000_000 } });
    await kit.store.setCeiling({ ...change(COMPANY, 0), ceiling: { taskMicros: 3_000_000, companyMonthMicros: 70_000_000 } });
    expect(await kit.store.resolve(iss, cid, pid, "gemini")).toMatchObject({ caps: { taskMicros: 3_000_000, projectMonthMicros: 70_000_000 }, companyMonthMicros: 70_000_000 });
  });
  it("input is checked at runtime with fixed words and no echo", async () => {
    const kit = storeKit();
    const secret = geminiKey();
    for (const bad of [
      { ...change(pid, 0), sourceId: "SRC", provider: "gemini", key: secret },
      { ...change(pid, 0), sourceId: "src_a", provider: "openai", key: secret },
      { ...change(pid, 0), sourceId: "src_a", provider: "vertex", key: secret }, // A Gemini key is not a Vertex credential (and this store has no Vertex check).
      { ...change(pid, 0), sourceId: "src_a", provider: "gemini", key: "has space in it" },
      { ...change(pid, 0), requestId: "nope", sourceId: "src_a", provider: "gemini", key: secret },
      { ...change(pid, 0), actor: { id: "x", role: "company_admin" }, sourceId: "src_a", provider: "gemini", key: secret },
      { ...change("Bad Project", 0), sourceId: "src_a", provider: "gemini", key: secret },
    ]) {
      const result = await kit.store.connect(bad as never).then(() => undefined, (e: unknown) => e);
      expect(result).toBeInstanceOf(ProductKeyError); expect(String((result as Error).message)).not.toContain(secret);
    }
    expect(kit.table.rows.size).toBe(0);
  });
  it("a damaged stored document is 'unavailable', never a guess", async () => {
    const kit = await connected();
    const docKey = [...kit.table.rows.keys()].find((k) => k.includes("#doc#"))!;
    kit.table.rows.set(docKey, { version: 1, item: { sources: "x", removed: [] } });
    expect(await code(kit.store.view(iss, cid, pid))).toBe("unavailable");
  });
  it("one source per provider per project", async () => {
    const kit = await connected();
    expect(await code(kit.store.connect({ ...change(pid, 1), sourceId: "src_two", provider: "gemini", key: geminiKey() }))).toBe("invalid");
  });
  it("isKeyRow identifies only sealed-key rows", () => {
    expect(isKeyRow(`CO#x#key#web#src_a#v`)).toBe(true); expect(isKeyRow(`CO#x#doc#web`)).toBe(false);
  });
});
