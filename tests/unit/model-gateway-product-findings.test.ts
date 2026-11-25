// PARKED-F1-HANDOFF-2026-11-14 section 2: every finding that carries into the gateway, one block each, named by its id.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { ProductKeyError, CURRENT_STAGE, PRODUCT_RECOVERY_DAYS } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, PRODUCT_KEY_PURPOSE } from "../../packages/model-gateway/src/product-seal.js";
import { iamWildcardMatches, productKeyDenyStatement, PRODUCT_RUNTIME_ROLE_NAME, roleCoveredByStsPatterns } from "../../packages/model-gateway/src/product-policy.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { MAX_BODY_BYTES } from "../../packages/model-gateway/src/guard.js";
import { PRODUCT_NOT_SET_UP } from "../../packages/model-gateway/src/product-route.js";
import { call, mint, MemorySink } from "./model-gateway-fixture.js";
import { change, cid, COMPANY, connected, geminiBody, geminiKey, iss, maintainer, pid, productCall, productGateway, productScope, storeKit, streamPath } from "./model-gateway-product-fixture.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ProductKeyError ? e.code : `other:${String(e)}`; } };
const DAY = 86_400_000;

async function companyLinked() {
  const kit = storeKit();
  const key = geminiKey();
  await kit.store.connect({ ...change(COMPANY, 0), sourceId: "src_shared", provider: "gemini", key });
  await kit.store.connect({ ...change(COMPANY, 1), sourceId: "src_other", provider: "gemini", key: geminiKey() });
  for (const project of ["web", "api"]) await kit.store.link({ ...change(project, 0, maintainer), sourceId: "src_link", companySourceId: "src_shared" });
  return { kit, key };
}

describe("F1-d M1: removing a company source removes it everywhere at once", () => {
  it("after removal nothing returns the key for linked projects, deletion is scheduled with a 7-day window, and it is no longer offered", async () => {
    const { kit, key } = await companyLinked();
    const before = (await kit.store.resolve(iss, cid, "web", "gemini"))!;
    expect(await kit.store.useKey(iss, cid, before)).toBe(key);
    await kit.store.remove({ ...change(COMPANY, 2), sourceId: "src_shared" });
    for (const project of ["web", "api"]) {
      expect(await kit.store.resolve(iss, cid, project, "gemini")).toBeUndefined();
      expect((await kit.store.view(iss, cid, project)).sources[0]).toMatchObject({ sourceId: "src_link", available: false });
    }
    // Even a resolution taken before removal no longer opens the key (the row left AWSCURRENT in the same transaction).
    expect(await kit.store.useKey(iss, cid, before)).toBeUndefined();
    const row = [...kit.table.rows.entries()].find(([k]) => k.includes("#key#_company#src_shared#"))![1].item;
    expect(row.stage).toBe("scheduled_deletion");
    expect(row.purgeAfter).toBe(Math.floor((1_800_000_000_000 + PRODUCT_RECOVERY_DAYS * DAY) / 1000));
    expect((await kit.store.choices(iss, cid)).map((c) => c.sourceId)).toEqual(["src_other"]);
    expect((await kit.store.view(iss, cid, COMPANY)).removed).toEqual([{ sourceId: "src_shared", provider: "gemini", recoverUntil: 1_800_000_000_000 + 7 * DAY }]);
    // And the product route answers "not set up" for a linked project, sending nothing.
    const g = await productGateway({ kit, connect: false });
    const sink = await productCall(g.deps);
    expect(sink.status).toBe(404); expect(sink.text()).toContain(PRODUCT_NOT_SET_UP); expect(g.productCalls).toHaveLength(0);
  });
  it("a link can't commit against a company source removed between the read and the write", async () => {
    const kit = storeKit();
    await kit.store.connect({ ...change(COMPANY, 0), sourceId: "src_shared", provider: "gemini", key: geminiKey() });
    // Simulate the race directly: bump the company document's version after the link has read it.
    const original = kit.table.transact.bind(kit.table);
    kit.table.transact = async (writes) => {
      if (writes.some((w) => "check" in w)) await kit.store.remove({ ...change(COMPANY, 1), sourceId: "src_shared" });
      kit.table.transact = original; return original(writes);
    };
    expect(await code(kit.store.link({ ...change(pid, 0, maintainer), sourceId: "src_link", companySourceId: "src_shared" }))).toBe("stale");
    expect((await kit.store.view(iss, cid, pid)).sources).toEqual([]);
  });
});

describe("REVIEW-1 L2 and L3: links and warnings follow the exact source", () => {
  it("a company source id re-used after its window is a new source: old links stay unavailable and never spend through it", async () => {
    const { kit } = await companyLinked();
    await kit.store.remove({ ...change(COMPANY, 2), sourceId: "src_shared" });
    kit.advance(PRODUCT_RECOVERY_DAYS * DAY + 1);
    await kit.store.connect({ ...change(COMPANY, 3), sourceId: "src_shared", provider: "gemini", key: geminiKey() });
    expect(await kit.store.resolve(iss, cid, "web", "gemini")).toBeUndefined();
    expect((await kit.store.view(iss, cid, "web")).sources[0]).toMatchObject({ linkedTo: "src_shared", available: false });
  });
  it("a recovered company source keeps serving its links", async () => {
    const { kit, key } = await companyLinked();
    await kit.store.remove({ ...change(COMPANY, 2), sourceId: "src_shared" });
    await kit.store.recover({ ...change(COMPANY, 3), sourceId: "src_shared" });
    expect(await kit.store.useKey(iss, cid, (await kit.store.resolve(iss, cid, "web", "gemini"))!)).toBe(key);
  });
  it("a late 401 from the old key never marks a freshly rotated key", async () => {
    const kit = await connected();
    const old = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    await kit.store.rotate({ ...change(pid, 1, maintainer), sourceId: "src_gem", key: geminiKey() });
    await kit.store.recordWarning(iss, cid, old, 401);
    expect((await kit.store.view(iss, cid, pid)).sources[0]!.warning).toBeUndefined();
    await kit.store.recordWarning(iss, cid, (await kit.store.resolve(iss, cid, pid, "gemini"))!, 403);
    expect((await kit.store.view(iss, cid, pid)).sources[0]!.warning?.status).toBe(403);
  });
});

describe("F1-d M2 (a): re-adding a source id inside the recovery window", () => {
  it("is refused before anything is written, recover restores it, and the document never freezes", async () => {
    const kit = await connected();
    await kit.store.remove({ ...change(pid, 1, maintainer), sourceId: "src_gem" });
    const rows = JSON.stringify([...kit.table.rows.entries()]);
    expect(await code(kit.store.connect({ ...change(pid, 2, maintainer), sourceId: "src_gem", provider: "gemini", key: geminiKey() }))).toBe("in_recovery");
    expect(JSON.stringify([...kit.table.rows.entries()])).toBe(rows);
    // Not frozen: other changes still apply at the same revision.
    await kit.store.setCaps({ ...change(pid, 2, maintainer), caps: { taskMicros: 1, projectMonthMicros: 2 } });
    await kit.store.recover({ ...change(pid, 3, maintainer), sourceId: "src_gem" });
    const resolution = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    expect(await kit.store.useKey(iss, cid, resolution)).toBe(kit.key);
  });
  it("after the window the id is free again and recover answers not found", async () => {
    const kit = await connected();
    await kit.store.remove({ ...change(pid, 1, maintainer), sourceId: "src_gem" });
    kit.advance(PRODUCT_RECOVERY_DAYS * DAY + 1);
    expect(await code(kit.store.recover({ ...change(pid, 2, maintainer), sourceId: "src_gem" }))).toBe("not_found");
    expect(await code(kit.store.connect({ ...change(pid, 2, maintainer), sourceId: "src_gem", provider: "gemini", key: geminiKey() }))).toBe("ok");
    expect((await kit.store.view(iss, cid, pid)).removed).toEqual([]);
  });
});

describe("F1-d M2 (b): a failed write never blocks rotation of other sources", () => {
  it("a failed seal or a failed transaction for one source leaves no state, no pending marker, and rotating another source works", async () => {
    let failSeal = false; let failCommit = false;
    const kit = storeKit({ beforeCommit: () => (failCommit ? false : undefined) });
    const real = kit.keyService;
    const sealer = { generateDataKey: async (c: Readonly<Record<string, string>>) => { if (failSeal) throw new Error("kms down"); return real.generateDataKey(c); }, unwrapDataKey: (w: Uint8Array, c: Readonly<Record<string, string>>) => real.unwrapDataKey(w, c) };
    const { ProductKeyStore } = await import("../../packages/model-gateway/src/product-keys.js");
    const { ProductKeySealer } = await import("../../packages/model-gateway/src/product-seal.js");
    const store = new ProductKeyStore({ table: kit.table, sealer: new ProductKeySealer(sealer), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => 1_800_000_000_000 });
    await store.connect({ ...change(COMPANY, 0), sourceId: "src_a", provider: "gemini", key: geminiKey() });
    const rows = kit.table.rows.size;
    failSeal = true;
    expect(await code(store.connect({ ...change(COMPANY, 1), sourceId: "src_b", provider: "gemini", key: geminiKey() }))).toBe("other:Error: kms down");
    failSeal = false; failCommit = true;
    expect(await code(store.connect({ ...change(COMPANY, 1), sourceId: "src_b", provider: "gemini", key: geminiKey() }))).toBe("stale");
    expect(kit.table.rows.size).toBe(rows);
    failCommit = false;
    const view = await store.rotate({ ...change(COMPANY, 1), sourceId: "src_a", key: geminiKey() });
    expect(view).toMatchObject({ revision: 2, pending: false, sources: [{ sourceId: "src_a" }] });
    expect(typeof view.lastRequestId).toBe("string");
  });
});

describe("F1-d L1: product AI failures never take the agent route down", () => {
  it("with the product store unreadable, the agent route still answers and the product route answers a fixed 503", async () => {
    const g = await productGateway();
    g.kit.table.get = async () => { throw new Error("table down with detail"); };
    expect((await call(g.deps)).status).toBe(200);
    const sink = await productCall(g.deps);
    expect(sink.status).toBe(503); expect(sink.text()).not.toContain("detail");
  });
  it("with no product source at all the agent route is untouched", async () => {
    const g = await productGateway({ connect: false });
    expect((await call(g.deps)).status).toBe(200);
  });
});

describe("F1-d L2: no operator or install role can read product keys", () => {
  it("the deny statement covers every decrypt path for the product purpose except the gateway runtime role", () => {
    const runtime = `arn:aws:iam::123456789012:role/${PRODUCT_RUNTIME_ROLE_NAME}`;
    const s = productKeyDenyStatement(runtime);
    expect(s).toMatchObject({ Effect: "Deny", Resource: "*", Condition: { StringEquals: { "kms:EncryptionContext:purpose": PRODUCT_KEY_PURPOSE }, ArnNotEquals: { "aws:PrincipalArn": runtime } } });
    for (const action of ["kms:Decrypt", "kms:ReEncryptFrom", "kms:GenerateDataKey"]) expect((s.Action as string[]).some((a) => iamWildcardMatches(a, action))).toBe(true);
    // Local evaluation of the condition: only the exact runtime role is exempt (no wildcard can widen it).
    const exempt = (arn: string) => arn === (s.Condition as { ArnNotEquals: Record<string, string> }).ArnNotEquals["aws:PrincipalArn"];
    expect(exempt("arn:aws:iam::123456789012:role/operator-admin")).toBe(false);
    expect(exempt(`${runtime}-copy`)).toBe(false);
    expect(exempt(runtime)).toBe(true);
    expect(() => productKeyDenyStatement("arn:aws:iam::123456789012:role/rovara-*")).toThrow();
    expect(() => productKeyDenyStatement("not-an-arn")).toThrow();
    // The live IAM simulation against the deployed roles is the staging row DEFERRED PRODUCT-KEYS-IAM-SIM.
  });
});

describe("F1-d L3 / F1e R4: every key read names AWSCURRENT", () => {
  it("the store's key reads always send the stage, a read without it is denied, and a non-current row is never returned", async () => {
    const kit = await connected();
    await kit.store.rotate({ ...change(pid, 1, maintainer), sourceId: "src_gem", key: geminiKey() });
    const r = (await kit.store.resolve(iss, cid, pid, "gemini"))!;
    await kit.store.useKey(iss, cid, r);
    const keyReads = kit.table.reads.filter((x) => x.key.includes("#key#"));
    expect(keyReads.length).toBeGreaterThan(0);
    expect(keyReads.every((x) => x.stage === CURRENT_STAGE)).toBe(true);
    await expect(kit.table.get(keyReads[0]!.key)).rejects.toThrow("AccessDenied");
    const previous = [...kit.table.rows.entries()].find(([, v]) => v.item.stage === "AWSPREVIOUS")![0];
    expect(await kit.table.get(previous, { stage: CURRENT_STAGE })).toBeUndefined();
  });
});

describe("F1-d L4: fingerprints are a keyed HMAC", () => {
  it("the stored fingerprint is not a plain SHA-256 of the key and changes with the HMAC secret", async () => {
    const kit = await connected();
    const row = [...kit.table.rows.entries()].find(([k]) => k.includes("#key#"))![1].item;
    expect(row.fingerprint).not.toBe(createHash("sha256").update(kit.key).digest("hex"));
    const input = { cid, owner: pid, sourceId: "src_gem", key: kit.key };
    expect(row.fingerprint).toBe(await hmacFingerprinter(kit.fingerprintSecret)(input));
    expect(row.fingerprint).not.toBe(await hmacFingerprinter(randomBytes(32))(input));
    expect(() => hmacFingerprinter(randomBytes(16))).toThrow();
  });
});

describe("F1e L9: the runtime role name matches no STS wildcard", () => {
  it("evaluated by wildcard (not string equality) against every sts:AssumeRole/TagSession resource on this base, with a positive control", () => {
    const account = "123456789012";
    const roleArn = `arn:aws:iam::${account}:role/${PRODUCT_RUNTIME_ROLE_NAME}`;
    // The only STS statement in Rovara Cloud (Cloud's infra/lib/cloud-release-pipeline.ts, pinned in Rovara Cloud): the CDK bootstrap roles.
    const patterns = [{ actions: ["sts:AssumeRole"], resources: [`arn:aws:iam::${account}:role/cdk-hnb659fds-*-${account}-us-west-2`] }, { actions: ["sts:*"], resources: [`arn:aws:iam::${account}:role/connector-secrets*`, `arn:aws:iam::${account}:role/agentx-*`] }];
    expect(roleCoveredByStsPatterns(roleArn, patterns)).toBe(false);
    // Positive control: the parked F1e name was covered by the connector-secrets* wildcard.
    expect(roleCoveredByStsPatterns(`arn:aws:iam::${account}:role/connector-secrets-product-ai`, patterns)).toBe(true);
    expect(roleCoveredByStsPatterns(roleArn, [{ actions: ["*"], resources: ["*"] }])).toBe(true);
    // Boundary sizes and the exact-name lookup entries are pinned by the infra lane (DEFERRED PRODUCT-KEYS-ROLE-BOUNDARY).
  });
});

describe("F1e meter L1-L9 on the product route", () => {
  it("a not-sent fault costs nothing; a fault after send settles the full hold", async () => {
    for (const notSent of [true, false]) {
      const g = await productGateway({ transport: async () => { throw notSent ? new NotSentError() : new Error("reset"); } });
      await productCall(g.deps);
      const row = (await g.productMeter.read(productScope))[0]!;
      expect(row.reservedMicros).toBe(0); expect(notSent ? row.spentMicros === 0 : row.spentMicros > 0).toBe(true);
    }
  });
  it("a settle after close adds nothing", async () => {
    const g = await productGateway();
    const reserved = await g.productMeter.reserve({ scope: productScope, caps: { task: 1000, projectMonth: 1000, combinedCompanyMonth: 1000 }, estimateMicros: 10 });
    if (!reserved.ok) throw new Error("reserve");
    await g.productMeter.settle(reserved.reservation, 7); await g.productMeter.settle(reserved.reservation, 500);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(7);
  });
  it("an oversize body is refused 413, never truncated, and nothing is sent", async () => {
    const g = await productGateway();
    const sink = await productCall(g.deps, streamPath, Buffer.alloc(MAX_BODY_BYTES + 1, 0x20));
    expect(sink.status).toBe(413); expect(g.productCalls).toHaveLength(0);
  });
  it("a throw after the head still writes exactly one settle", async () => {
    const g = await productGateway();
    const sink = new MemorySink(); sink.write = async () => { throw new Error("client gone"); };
    await handleGateway(g.deps, { method: "POST", url: streamPath, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield Buffer.from(JSON.stringify(geminiBody)); })() }, sink);
    expect(g.logs.filter((l) => (l as { event: string }).event === "settled")).toHaveLength(1);
    expect((await g.productMeter.read(productScope))[0]!.reservedMicros).toBe(0);
  });
});

describe("Price M1/M2/L4/L5 under DEC 216: one resolver, never refused, never $0", () => {
  it("an unknown or unreadable price holds a cautious estimate, settles above zero, is marked estimated, and the marker survives a re-read", async () => {
    for (const prices of [{ priceFor: () => undefined }, { priceFor: () => { throw new Error("x"); } }, { priceFor: () => ({ inputMicrosPerMTok: Number.NaN, outputMicrosPerMTok: 1 }) }, { priceFor: () => ({ inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }) }]) {
      const g = await productGateway({ overrides: { prices } });
      expect((await productCall(g.deps)).status).toBe(200);
      const rows = await g.productMeter.read(productScope);
      expect(rows[0]!.spentMicros).toBeGreaterThan(0); expect(rows[0]!.estimatedMicros).toBe(rows[0]!.spentMicros);
      const pending = (await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 1)).items[0]!;
      expect(JSON.parse(JSON.stringify(pending))).toMatchObject({ status: "pending", provider: "gemini" });
    }
  });
  it("a known price holds less than an unknown one", async () => {
    const holds: number[] = [];
    for (const prices of [{ priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }) }, { priceFor: () => undefined }]) {
      let seen = 0;
      const g = await productGateway({ overrides: { prices }, transport: async () => { seen = 1; return { status: 500, body: (async function* () { /* */ })() }; } });
      await productCall(g.deps); expect(seen).toBe(1);
      holds.push((await g.productMeter.read(productScope))[0]!.spentMicros);
    }
    expect(holds[0]!).toBeLessThan(holds[1]!);
  });
});

describe("Plan 7.4 gaps (b) and (c) on the product route", () => {
  it("(b) a stopped task's next call is refused before anything is held or sent", async () => {
    const g = await productGateway();
    g.ended.end(iss, cid, "task_1");
    const sink = await productCall(g.deps);
    expect(sink.status).toBe(403); expect(g.productCalls).toHaveLength(0);
    expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
  });
  it("(c) a token in Google's places (x-goog-api-key, ?key=) is refused, and the token never reaches the provider or the answer", async () => {
    const g = await productGateway({ transport: async (r) => ({ status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: Buffer.from(r.key).toString("base64") }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\r\n\r\n`); })() }) });
    const token = mint();
    expect((await productCall(g.deps, streamPath, geminiBody, token, { "x-goog-api-key": "dummy-key-1234" })).status).toBe(400);
    expect((await productCall(g.deps, `${streamPath}&key=${token}`)).status).toBe(404);
    const answer = await productCall(g.deps, streamPath, geminiBody, token);
    // The provider tried to echo the project key (base64): the stream is cut, and neither the key nor the token is shown.
    expect(answer.text()).not.toContain(Buffer.from(g.key).toString("base64")); expect(answer.text()).not.toContain(token);
    for (const sent of g.productCalls) { expect(JSON.stringify(sent.headers)).not.toContain(token); expect(Buffer.from(sent.body).toString()).not.toContain(token); }
  });
});
