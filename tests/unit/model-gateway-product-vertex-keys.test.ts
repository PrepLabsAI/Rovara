import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { denyNetwork } from "./model-gateway-no-network.js";
import { InMemoryProductKeyTable, ProductKeyError, ProductKeyStore, type VertexCheck } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";
import { parseStoredVertexCredential, parseVertexConnect, serializeVertexCredential, vertexSetupSteps, vertexSummary } from "../../packages/model-gateway/src/product-vertex-credential.js";
import { admin, cid, iss, maintainer, pid, change, geminiKey } from "./model-gateway-product-fixture.js";
import { audienceOf, keyFile } from "./model-gateway-vertex-fake.js";
beforeAll(denyNetwork);

const fed = (extra: Record<string, unknown> = {}) => JSON.stringify({ scheme: "federation", projectId: "acme-tests", location: "us-central1", audience: audienceOf("pool-a"), ...extra });
const keyText = (k = keyFile(), extra: Record<string, unknown> = {}) => JSON.stringify({ scheme: "service_account_key", location: "europe-west4", keyFile: k.file, ...extra });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProductKeyError ? e.code : `threw ${String(e)}`));
function kit(check?: VertexCheck) {
  const table = new InMemoryProductKeyTable();
  const sealer = new ProductKeySealer(localProductKeyService(randomBytes(32)));
  const checks: Array<{ cid: string; scheme: string }> = [];
  const store = new ProductKeyStore({ table, sealer, fingerprint: hmacFingerprinter(randomBytes(32)), now: () => 1_800_000_000_000, ...(check === undefined ? {} : { vertexCheck: async (c, cred) => { checks.push({ cid: c, scheme: cred.scheme }); return check(c, cred); } }) });
  return { table, store, sealer, checks };
}
const ok: VertexCheck = async () => "ok";

describe("Vertex credential parsing", () => {
  it("accepts a federation setup and a key file; the stored form is canonical and re-parses", () => {
    const f = parseVertexConnect(fed({ serviceAccount: "rovara-tests@acme-tests.iam.gserviceaccount.com" }))!;
    expect(f).toEqual({ scheme: "federation", projectId: "acme-tests", location: "us-central1", audience: audienceOf("pool-a"), serviceAccount: "rovara-tests@acme-tests.iam.gserviceaccount.com" });
    expect(parseStoredVertexCredential(serializeVertexCredential(f))).toEqual(f);
    const k = keyFile();
    const s = parseVertexConnect(keyText(k))!;
    expect(s).toMatchObject({ scheme: "service_account_key", projectId: "acme-tests", location: "europe-west4", clientEmail: k.file.client_email, privateKeyId: k.file.private_key_id });
    expect(parseStoredVertexCredential(serializeVertexCredential(s))).toEqual(s);
    // Only what the token flow needs is kept: no client id, cert URLs or other fields of the file.
    expect(Object.keys(JSON.parse(serializeVertexCredential(s)) as object).sort()).toEqual(["clientEmail", "location", "privateKey", "privateKeyId", "projectId", "scheme"]);
    // An explicit project wins over the file's; the global location is allowed.
    expect(parseVertexConnect(keyText(k, { projectId: "other-proj", location: "global" }))).toMatchObject({ projectId: "other-proj", location: "global" });
    // The key file may be given as the JSON text Google downloads.
    expect(parseVertexConnect(JSON.stringify({ scheme: "service_account_key", location: "us-east4", keyFile: JSON.stringify(k.file) }))).toMatchObject({ clientEmail: k.file.client_email });
  });
  it("refuses anything unexpected, with no partial parse", () => {
    const k = keyFile();
    const bad: unknown[] = [
      "not json", "[]", fed({ extra: 1 }), fed({ projectId: "Acme" }), fed({ projectId: "ab" }), fed({ location: "us" }), fed({ location: "us-central1/../x" }), fed({ location: "eu" }),
      fed({ audience: "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool-a/providers/aws" }), fed({ audience: `${audienceOf("pool-a")}/x` }), fed({ audience: audienceOf("pool-a").replace("global", "us") }),
      fed({ serviceAccount: "someone@gmail.com" }), fed({ serviceAccount: 5 }), JSON.stringify({ scheme: "other" }),
      keyText(k, { keyFile: { ...k.file, token_uri: "https://evil.example/token" } }), keyText(k, { keyFile: { ...k.file, type: "authorized_user" } }),
      keyText(k, { keyFile: { ...k.file, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" } }), keyText(k, { keyFile: { ...k.file, universe_domain: "evil.example" } }),
      keyText(k, { keyFile: { ...k.file, client_email: "x@gmail.com" } }), keyText(k, { keyFile: { ...k.file, private_key_id: "zz" } }), keyText(k, { keyFile: { ...k.file, surprise: true } }),
      keyText(k, { keyFile: { ...k.file, project_id: undefined } }),
    ];
    for (const text of bad) expect(parseVertexConnect(text as string), String(text).slice(0, 80)).toBeUndefined();
    expect(parseStoredVertexCredential("{}")).toBeUndefined();
  });
  it("the non-secret summary never carries the private key", () => {
    const k = keyFile();
    const summary = vertexSummary(parseVertexConnect(keyText(k))!);
    expect(summary).toEqual({ scheme: "service_account_key", projectId: "acme-tests", location: "europe-west4", serviceAccount: k.file.client_email });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  });
});

describe("Vertex in the product key store", () => {
  it("connects a federation setup only after the connection test passes; seals the canonical form; shows a summary", async () => {
    const s = kit(ok);
    const view = await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() });
    expect(s.checks).toEqual([{ cid, scheme: "federation" }]);
    expect(view.sources[0]).toMatchObject({ sourceId: "src_vx", provider: "vertex", hasKey: true, vertex: { scheme: "federation", projectId: "acme-tests", location: "us-central1" } });
    const resolution = (await s.store.resolve(iss, cid, pid, "vertex"))!;
    expect(parseStoredVertexCredential((await s.store.useKey(iss, cid, resolution))!)).toEqual(parseVertexConnect(fed()));
  });
  it("a too-open pool can't be saved (fixed words); a refused or unreachable check saves nothing", async () => {
    for (const [result, expected] of [["too_open", "too_open"], ["refused", "refused"], ["unavailable", "unavailable"]] as const) {
      const s = kit(async () => result);
      const error = await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() }).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(ProductKeyError); expect((error as ProductKeyError).code).toBe(expected);
      expect(s.table.rows.size).toBe(0);
    }
    expect(new ProductKeyError("too_open").message).toBe("This Google setup would trust any Rovara company. Add the attribute condition from the setup steps, then test again.");
  });
  it("a check that throws is 'unavailable'; with no check at all Vertex can't be connected (fail closed)", async () => {
    expect(await code(kit(async () => { throw new Error("x"); }).store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() }))).toBe("unavailable");
    const s = kit();
    expect(await code(s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() }))).toBe("unavailable");
    expect(s.table.rows.size).toBe(0);
  });
  it("a key file is write-only: never in a view, an audit row, an error or the document; rotation re-tests and demotes the old version", async () => {
    const s = kit(ok);
    const k1 = keyFile(); const k2 = keyFile();
    await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: keyText(k1) });
    const view = await s.store.rotate({ ...change(pid, 1, admin), sourceId: "src_vx", key: keyText(k2) });
    expect(s.checks.map((c) => c.scheme)).toEqual(["service_account_key", "service_account_key"]);
    expect(view.sources[0]!.vertex).toMatchObject({ scheme: "service_account_key", serviceAccount: k2.file.client_email });
    const everything = JSON.stringify([...s.table.rows.entries()].map(([key, r]) => (key.includes("#key#") ? { key, stage: r.item.stage } : { key, item: r.item }))) + JSON.stringify(view);
    for (const pem of [k1.pem, k2.pem]) for (const line of pem.split("\n").slice(1, 4)) expect(everything).not.toContain(line);
    const stages = [...s.table.rows.entries()].filter(([key]) => key.includes("#key#")).map(([, r]) => r.item.stage).sort();
    expect(stages).toEqual(["AWSCURRENT", "AWSPREVIOUS"]);
    const opened = parseStoredVertexCredential((await s.store.useKey(iss, cid, (await s.store.resolve(iss, cid, pid, "vertex"))!))!);
    expect(opened).toMatchObject({ privateKeyId: k2.file.private_key_id });
  });
  it("rotation to a setup that fails the check changes nothing", async () => {
    const results: Array<"ok" | "too_open"> = ["ok", "too_open"];
    const s = kit(async () => results.shift()!);
    await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() });
    const before = JSON.stringify([...s.table.rows.entries()]);
    expect(await code(s.store.rotate({ ...change(pid, 1, admin), sourceId: "src_vx", key: fed({ location: "europe-west4" }) }))).toBe("too_open");
    expect(JSON.stringify([...s.table.rows.entries()])).toBe(before);
  });
  it("invalid Vertex input is refused before the check runs, with no echo", async () => {
    const s = kit(ok);
    const k = keyFile();
    const text = keyText(k, { keyFile: { ...k.file, token_uri: "https://evil.example/token" } });
    const error = await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: text }).then(() => undefined, (e: unknown) => e) as ProductKeyError;
    expect(error.code).toBe("invalid"); expect(error.message).not.toContain("BEGIN"); expect(s.checks).toHaveLength(0);
    // A Gemini key is not a Vertex credential.
    expect(await code(s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: geminiKey() }))).toBe("invalid");
  });
  it("the check is run for the change's company only", async () => {
    const s = kit(ok);
    const other = `org_${"z".repeat(20)}`;
    await s.store.connect({ ...change(pid, 0, maintainer), cid: other, sourceId: "src_vx", provider: "vertex", key: fed() });
    expect(s.checks[0]!.cid).toBe(other);
    expect(await s.store.resolve(iss, cid, pid, "vertex")).toBeUndefined();
  });
  it("Gemini and Vertex can both be connected to one project; a company Vertex source can be linked", async () => {
    const s = kit(ok);
    await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key: geminiKey() });
    await s.store.connect({ ...change(pid, 1, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() });
    expect((await s.store.resolve(iss, cid, pid, "vertex"))?.sourceId).toBe("src_vx");
    await s.store.connect({ iss, cid, owner: "_company", requestId: randomUUID(), expectedRevision: 0, actor: admin, sourceId: "src_cvx", provider: "vertex", key: fed() });
    await s.store.link({ ...change("api", 0, maintainer), sourceId: "src_l", companySourceId: "src_cvx" });
    expect(await s.store.resolve(iss, cid, "api", "vertex")).toMatchObject({ owner: "_company", sourceId: "src_cvx" });
  });
  it("a stored document with a malformed Vertex summary is 'unavailable'", async () => {
    const s = kit(ok);
    await s.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: fed() });
    const docKey = [...s.table.rows.keys()].find((k) => k.includes("#doc#"))!;
    const item = structuredClone(s.table.rows.get(docKey)!.item) as { sources: Array<Record<string, unknown>> };
    item.sources[0]!.vertex = { scheme: "federation", projectId: "BAD", location: "us-central1" };
    s.table.rows.set(docKey, { version: 1, item });
    expect(await code(s.store.view(iss, cid, pid))).toBe("unavailable");
  });
});

describe("Vertex setup steps (connect text)", () => {
  it("names the company's own session ARN in the condition and no other company's", () => {
    const steps = vertexSetupSteps({ awsAccountId: "111122223333", roleName: "RovaraProductAiFederation", cid });
    expect(steps.condition).toBe(`assertion.arn == 'arn:aws:sts::111122223333:assumed-role/RovaraProductAiFederation/${cid}'`);
    expect(steps.awsAccountId).toBe("111122223333");
    expect(steps.steps.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(steps)).not.toMatch(/org_(?!a{20})[0-9a-z]{20}/u);
    expect(steps.steps.map((s) => s.title).join(" ")).toContain("Vertex AI User");
  });
  it("refuses inputs that could not form a valid ARN", () => {
    expect(() => vertexSetupSteps({ awsAccountId: "1", roleName: "R", cid })).toThrow();
    expect(() => vertexSetupSteps({ awsAccountId: "111122223333", roleName: "R", cid: "org_x" })).toThrow();
  });
});
