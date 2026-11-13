// Video and traces behind the gate. Each condition of the gate refuses on its own; a trace is scrubbed and scanned inflated; nothing is written unless the policy was admitted with
// proof of run-scoped accounts; the broker scrubs a trace again and keeps its own bytes; and a file the pack withholds is listed for deletion.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { evaluateMediaGate, evaluatePublicationGate, type MediaGateInput, type EvidenceEnvironment, type EvidenceRaw } from "../../packages/contracts/src/index.js";
import { MEDIA_DIR, MEDIA_LISTING_FILE, MEDIA_VIDEO_MAX_BYTES, MEDIA_TRACE_MAX_BYTES, admittedMediaPolicy, createMediaRecorder, finalizeMedia, mediaFileName } from "../../packages/verifier/src/executor/media.js";
import { TRACE_BLANKED, scrubTraceLines, scrubTraceZip } from "../../packages/verifier/src/executor/trace-scrub.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { finishWebCaseMedia, startWebCaseTrace, type E2EWebMediaPorts } from "../../packages/verifier/src/web-runtime.js";
import type { RevocationReport } from "../../packages/core/src/e2e/run-scoped-accounts.js";
import { attachMedia, prepareMediaArtifacts, publicationMediaFor } from "../../packages/core/src/e2e/media-evidence.js";
import { buildEvidencePack } from "../../packages/core/src/core/proof/evidence-pack.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "media-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
const EMAIL = "rovara-orders-owner-ab12cd@example.test";
const SESSION = "sess-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const redactor = () => createCredentialRedactor([{ profileId: "orders-owner", email: EMAIL, password: PASSWORD }]);

// ---- a minimal zip writer for the tests (the scrubber's own reader is under test, so it is not used to build them)
function zip(entries: Array<{ name: string; data: Uint8Array | string; method?: 0 | 8; flags?: number }>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data); const method = entry.method ?? 8; const packed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name); const crc = zlibCrc32(data) >>> 0; const flags = entry.flags ?? 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flags, 8); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, packed); central.push(head, name); offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
function unzipEntries(bytes: Uint8Array): Map<string, string> {
  const view = Buffer.from(bytes); const out = new Map<string, string>();
  const eocd = view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const count = view.readUInt16LE(eocd + 10); let at = view.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.readUInt16LE(at + 28); const extra = view.readUInt16LE(at + 30); const comment = view.readUInt16LE(at + 32);
    const method = view.readUInt16LE(at + 10); const packed = view.readUInt32LE(at + 20); const local = view.readUInt32LE(at + 42);
    const name = view.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    const raw = view.subarray(start, start + packed);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("latin1"));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const networkLine = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "resource-snapshot", snapshot: {
  request: { url: "https://app.test/api/orders", method: "GET", headers: [{ name: "Cookie", value: `session=${SESSION}` }, { name: "Accept", value: "application/json" }, { name: "Authorization", value: "Bearer abc.def.ghi" }], cookies: [{ name: "session", value: SESSION }] },
  response: { status: 200, headers: [{ name: "Set-Cookie", value: `session=${SESSION}; HttpOnly` }, { name: "Content-Type", value: "application/json" }], cookies: [{ name: "session", value: SESSION }] }, ...over } });
const goodTrace = () => zip([
  { name: "trace.network", data: `${networkLine()}\n${networkLine()}\n` },
  { name: "trace.trace", data: `${JSON.stringify({ type: "before", title: "click", params: { selector: "#buy" } })}\n` },
  { name: "resources/page@1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), method: 0 },
]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(1_000, 7)]);

describe("the media gate", () => {
  const ok: MediaGateInput = { capture: { video: true, traces: true }, tier: "sandbox", accounts: [{ provisioner: "seed_command", profileId: "buyer" }], data: "synthetic", companyAllows: { video: true, trace: true } };
  it("allows both when every condition holds", () => {
    expect(evaluateMediaGate(ok)).toMatchObject({ allowed: { video: true, trace: true }, reasons: {}, tierAllowed: true });
  });
  it("refuses a registered (long-lived) account, even one among run-scoped ones", () => {
    const result = evaluateMediaGate({ ...ok, accounts: [...ok.accounts, { provisioner: "registered", profileId: "old" }] });
    expect(result.allowed).toEqual({ video: false, trace: false });
    expect(result.reasons).toEqual({ video: "account_not_run_scoped", trace: "account_not_run_scoped" });
  });
  it("refuses an environment with no account at all, as it cannot show the accounts are run-scoped", () => {
    expect(evaluateMediaGate({ ...ok, accounts: [] }).reasons.video).toBe("account_not_run_scoped");
  });
  it("allows media only in a sandbox or a per-task preview, never on a shared pre-prod, whatever its accounts (I1)", () => {
    for (const accounts of [ok.accounts, [{ provisioner: "cognito_test_pool" as const, profileId: "a" }], [{ provisioner: "cognito_test_pool" as const, profileId: "a" }, { provisioner: "http_hook" as const, profileId: "b" }]]) {
      const result = evaluateMediaGate({ ...ok, tier: "shared", accounts });
      expect(result.allowed).toEqual({ video: false, trace: false });
      expect(result.reasons).toEqual({ video: "tier_not_allowed", trace: "tier_not_allowed" });
      expect(result.tierAllowed).toBe(false);
    }
    expect(evaluateMediaGate({ ...ok, tier: "preview" })).toMatchObject({ allowed: { video: true, trace: true }, tierAllowed: true });
    expect(evaluateMediaGate({ ...ok, tier: "sandbox" }).tierAllowed).toBe(true);
  });
  it("refuses data that is not known to be synthetic", () => {
    for (const data of ["unknown", "real"] as const) expect(evaluateMediaGate({ ...ok, data }).reasons).toEqual({ video: "data_not_synthetic", trace: "data_not_synthetic" });
  });
  it("refuses a kind the company has not switched on, and leaves the other alone", () => {
    const result = evaluateMediaGate({ ...ok, companyAllows: { video: false, trace: true } });
    expect(result.allowed).toEqual({ video: false, trace: true });
    expect(result.reasons).toEqual({ video: "company_setting_off" });
  });
  it("refuses at publication until the revocation is confirmed, and allows at admission when it is not yet known", () => {
    expect(evaluateMediaGate({ ...ok, revocationConfirmed: false }).reasons.video).toBe("revocation_not_confirmed");
    expect(evaluateMediaGate({ ...ok, revocationConfirmed: true }).allowed.video).toBe(true);
    expect(evaluateMediaGate({ ...ok, revocationConfirmed: undefined }).allowed.video).toBe(true);
  });
  it("at publication the revocation proof must be exactly true: undefined and false both refuse (I2)", () => {
    const publication = (revocationConfirmed: boolean | undefined) => evaluatePublicationGate({ capture: ok.capture, tier: ok.tier, accounts: ok.accounts, data: ok.data, companyAllows: ok.companyAllows, revocationConfirmed });
    expect(publication(true).allowed).toEqual({ video: true, trace: true });
    for (const value of [false, undefined]) expect(publication(value)).toMatchObject({ allowed: { video: false, trace: false }, reasons: { video: "revocation_not_confirmed", trace: "revocation_not_confirmed" } });
    // admission, by contrast, may leave the proof open
    expect(evaluateMediaGate({ ...ok, revocationConfirmed: undefined }).allowed.video).toBe(true);
  });
  it("names the first failing condition in the design's order", () => {
    const all = evaluateMediaGate({ capture: { video: true, traces: false }, tier: "shared", accounts: [{ provisioner: "registered", profileId: "x" }], data: "real", companyAllows: { video: false, trace: false }, revocationConfirmed: false });
    expect(all.reasons).toEqual({ video: "account_not_run_scoped" });
  });
  it("says nothing about a kind that was not asked for", () => {
    expect(evaluateMediaGate({ ...ok, capture: { video: false, traces: false }, data: "real" })).toMatchObject({ allowed: { video: false, trace: false }, reasons: {} });
  });
});

describe("scrubbing a trace", () => {
  it("blanks cookie, set-cookie and authorization wherever they sit, and keeps the rest", () => {
    const scrubbed = scrubTraceLines(`${networkLine()}\n`)!;
    expect(scrubbed).not.toContain(SESSION);
    expect(scrubbed).not.toContain("Bearer abc");
    const row = JSON.parse(scrubbed.trim()) as { snapshot: { request: { url: string; headers: Array<{ name: string; value: string }>; cookies: Array<{ name: string; value: string }> }; response: { status: number; headers: Array<{ name: string; value: string }>; cookies: Array<{ value: string }> } } };
    expect(row.snapshot.request.url).toBe("https://app.test/api/orders");
    expect(row.snapshot.response.status).toBe(200);
    expect(row.snapshot.request.headers.find((header) => header.name === "Accept")?.value).toBe("application/json");
    expect(row.snapshot.response.headers.find((header) => header.name === "Content-Type")?.value).toBe("application/json");
    expect(row.snapshot.request.headers.filter((header) => header.value === TRACE_BLANKED)).toHaveLength(2);
    expect(row.snapshot.request.cookies).toEqual([{ name: "session", value: TRACE_BLANKED }]);
    expect(row.snapshot.response.cookies).toEqual([{ name: "session", value: TRACE_BLANKED }]);
  });
  it("blanks headers held as object keys, in any letter case", () => {
    const scrubbed = scrubTraceLines(`${JSON.stringify({ headers: { Authorization: "Bearer zzz", COOKIE: "a=b", "x-api-key": ["k1", "k2"], accept: "text/html" } })}\n`)!;
    expect(JSON.parse(scrubbed.trim())).toEqual({ headers: { Authorization: TRACE_BLANKED, COOKIE: TRACE_BLANKED, "x-api-key": [TRACE_BLANKED, TRACE_BLANKED], accept: "text/html" } });
  });
  it("refuses a line that is not JSON, rather than keeping it unscrubbed", () => {
    expect(scrubTraceLines(`${networkLine()}\nnot json at all\n`)).toBeNull();
  });
  it("rewrites the network and trace files of a zip and leaves other entries as they were", () => {
    const out = scrubTraceZip(goodTrace(), () => false)!;
    const files = unzipEntries(out);
    expect([...files.keys()]).toEqual(["trace.network", "trace.trace", "resources/page@1.png"]);
    expect(files.get("trace.network")).not.toContain(SESSION);
    expect(files.get("trace.network")).toContain(TRACE_BLANKED);
    expect(files.get("trace.trace")).toContain("#buy");
    expect(Buffer.from(files.get("resources/page@1.png")!, "latin1").subarray(1, 4).toString()).toBe("PNG");
  });
  it("makes a zip other tools accept, and scrubbing it again changes nothing", () => {
    const once = scrubTraceZip(goodTrace(), () => false)!;
    const twice = scrubTraceZip(once, () => false)!;
    expect([...unzipEntries(twice).entries()]).toEqual([...unzipEntries(once).entries()]);
    const dir = mkdtempSync(join(tmpdir(), "zipcheck-"));
    roots.push(dir);
    writeFileSync(join(dir, "t.zip"), once);
    const checked = spawnSync("unzip", ["-t", join(dir, "t.zip")], { encoding: "utf8" });
    if (checked.error === undefined) expect(checked.status, checked.stdout).toBe(0);
  });
  it("finds a credential INSIDE a compressed entry, which a scan of the zip bytes would miss", () => {
    const hiding = zip([{ name: "trace.trace", data: `${JSON.stringify({ type: "log", text: `typed ${PASSWORD} into the form` })}\n` }]);
    expect(redactor().contains(hiding)).toBe(false);
    const scrubbed = scrubTraceZip(hiding, (bytes) => redactor().contains(bytes));
    expect(scrubbed).not.toBeNull();
    expect(unzipEntries(scrubbed!).get("trace.trace")).not.toContain(PASSWORD);
    expect(unzipEntries(scrubbed!).get("trace.trace")).toContain(TRACE_BLANKED);
    // with no scan, nothing is found and nothing changes: the positive control that the blanking above is the scan's doing
    expect(unzipEntries(scrubTraceZip(hiding, () => false)!).get("trace.trace")).toContain(PASSWORD);
  });
  it("blanks a blob entry that carries a credential, and keeps the entry's place", () => {
    const blob = zip([{ name: "trace.trace", data: "{}\n" }, { name: "resources/body.txt", data: `hello ${EMAIL}` }]);
    const scrubbed = unzipEntries(scrubTraceZip(blob, (bytes) => redactor().contains(bytes))!);
    expect([...scrubbed.keys()]).toEqual(["trace.trace", "resources/body.txt"]);
    expect(scrubbed.get("resources/body.txt")).toBe(TRACE_BLANKED);
  });
  it("refuses a credential that is in an image entry (it cannot be blanked and the entry is not text)", () => {
    expect(scrubTraceZip(zip([{ name: "trace.trace", data: "{}\n" }, { name: "screencast/p.jpeg", data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(PASSWORD)]) }]), (bytes) => redactor().contains(bytes))).toBeNull();
  });
  it("refuses what it cannot read whole: encrypted, unknown method, duplicate or unsafe names, truncation, a wrong size or checksum, no entries, not a zip", () => {
    const good = goodTrace();
    expect(scrubTraceZip(zip([{ name: "trace.trace", data: "{}\n", flags: 1 }]), () => false)).toBeNull();
    expect(scrubTraceZip(zip([{ name: "a", data: "x" }, { name: "a", data: "y" }]), () => false)).toBeNull();
    for (const name of ["../escape", "/abs", "a\\b", "dir/"]) expect(scrubTraceZip(zip([{ name, data: "x" }]), () => false), name).toBeNull();
    expect(scrubTraceZip(good.subarray(0, good.length - 30), () => false)).toBeNull();
    expect(scrubTraceZip(Buffer.from("PK\u0003\u0004 not really"), () => false)).toBeNull();
    expect(scrubTraceZip(new Uint8Array(), () => false)).toBeNull();
    const corrupt = Buffer.from(good); corrupt[60] = corrupt[60]! ^ 0xff;
    expect(scrubTraceZip(corrupt, () => false)).toBeNull();
    const wrongCrc = Buffer.from(zip([{ name: "trace.trace", data: "{}\n", method: 0 }])); wrongCrc.writeUInt32LE(0xdeadbeef, 14);
    const head = wrongCrc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); wrongCrc.writeUInt32LE(0xdeadbeef, head + 16);
    expect(scrubTraceZip(wrongCrc, () => false)).toBeNull();
  });
  it("refuses a zip bomb by what it inflates to", () => {
    const bomb = zip([{ name: "resources/zeros.bin", data: Buffer.alloc(70 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(1_000_000);
    expect(scrubTraceZip(bomb, () => false)).toBeNull();
  });
  it("refuses a zip64 archive and a central directory that points outside the file", () => {
    const z64 = Buffer.from(zip([{ name: "a", data: "x" }])); z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    expect(scrubTraceZip(z64, () => false)).toBeNull();
    const far = Buffer.from(zip([{ name: "a", data: "x" }])); far.writeUInt32LE(far.length + 100, far.length - 22 + 16);
    expect(scrubTraceZip(far, () => false)).toBeNull();
  });
});

describe("the zip structure and the new scrub rules (C2, M3, M4)", () => {
  it("refuses a drive-lettered name and a name with a control character", () => {
    for (const name of ["C:evil.txt", "a\u0001b", "dir/\u007fx"]) expect(scrubTraceZip(zip([{ name, data: "x" }]), () => false), JSON.stringify(name)).toBeNull();
  });
  it("refuses an archive whose local header names another file than the central directory does", () => {
    const bytes = Buffer.from(zip([{ name: "trace.trace", data: "{}\n" }]));
    bytes.write("trace.tracX", 30); // the local header's name
    expect(scrubTraceZip(bytes, () => false)).toBeNull();
  });
  it("refuses entries that overlap: a second entry whose local header sits inside the first entry's data (a zip within a zip)", () => {
    const inner = zip([{ name: "resources/b.bin", data: "y".repeat(40), method: 0 }]);
    const innerLocal = inner.subarray(0, 30 + "resources/b.bin".length + 40);
    const bData = Buffer.from("y".repeat(40));
    const trace = Buffer.from("{}\n");
    const crcOf = (data: Uint8Array) => zlibCrc32(data) >>> 0;
    const localOf = (name: string, data: Uint8Array) => { const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crcOf(data), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); return Buffer.concat([head, Buffer.from(name), data]); };
    const centralOf = (name: string, data: Uint8Array, offset: number) => {
      const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
      head.writeUInt32LE(crcOf(data), 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
      return Buffer.concat([head, Buffer.from(name)]);
    };
    const endOf = (count: number, directory: Buffer, offset: number) => { const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return end; };
    // nested: a.bin's data holds b.bin's whole local entry, and the central directory lists b.bin at that inner offset
    const localA = localOf("resources/a.bin", innerLocal);
    const localT = localOf("trace.trace", trace);
    const innerOffset = 30 + "resources/a.bin".length;
    const dirNested = Buffer.concat([centralOf("resources/a.bin", innerLocal, 0), centralOf("resources/b.bin", bData, innerOffset), centralOf("trace.trace", trace, localA.length)]);
    const nested = Buffer.concat([localA, localT, dirNested, endOf(3, dirNested, localA.length + localT.length)]);
    expect(scrubTraceZip(nested, () => false)).toBeNull();
    // positive control: the same entries side by side, each with its own bytes, are read
    const side = zip([{ name: "resources/a.bin", data: innerLocal, method: 0 }, { name: "resources/b.bin", data: bData, method: 0 }, { name: "trace.trace", data: "{}\n", method: 0 }]);
    expect(scrubTraceZip(side, () => false)).not.toBeNull();
  });
  it("writes zero external attributes and no extra field, so a mode or a symlink in the input is dropped (M3)", () => {
    const bytes = Buffer.from(zip([{ name: "trace.trace", data: "{}\n" }]));
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const dir = bytes.readUInt32LE(eocd + 16);
    bytes.writeUInt32LE(0xa1ff0000, dir + 38); // a symlink with mode 0777 in the input's external attributes
    const out = Buffer.from(scrubTraceZip(bytes, () => false)!);
    const outDir = out.readUInt32LE(out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16);
    expect(out.readUInt32LE(outDir + 38)).toBe(0);
    expect(out.readUInt16LE(outDir + 30)).toBe(0);
  });
  it("refuses an archive that inflates past the total cap even when each entry is under the entry cap", () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ name: `resources/z${index}.bin`, data: Buffer.alloc(30 * 1024 * 1024) }));
    expect(scrubTraceZip(zip(entries), () => false)).toBeNull();
  });
  it("blanks every query value and fragment in a URL anywhere in a line, keeping scheme, host and path", () => {
    const line = JSON.stringify({ type: "before", params: { url: "https://app.test/cb?code=abc123def456&state=x&code=again99#frag-tok", note: "see https://other.test/p?a=1" } });
    const out = JSON.parse(scrubTraceLines(`${line}\n`)!) as { params: { url: string; note: string } };
    expect(out.params.url).toBe(`https://app.test/cb?code=${TRACE_BLANKED}&state=${TRACE_BLANKED}`);
    // a URL inside a longer string is blanked too (the text pass)
    expect(out.params.note).toBe(`see https://other.test/p?a=${TRACE_BLANKED}`);
    expect(scrubTraceLines(`${JSON.stringify({ u: "https://user:pw@app.test/x?y=1" })}\n`)).toBe(`${JSON.stringify({ u: `https://app.test/x?y=${TRACE_BLANKED}` })}\n`);
  });
  it("keeps only allow-listed header values in a request, whatever the header is called", () => {
    const line = JSON.stringify({ request: { headers: [{ name: "X-Goog-Api-Key", value: "AIzaSyplanted-0123456789" }, { name: "x-session", value: "sess-planted-0123456789" }, { name: "Content-Type", value: "application/json" }, { name: "Referer", value: "https://app.test/?t=1" }] } });
    const headers = (JSON.parse(scrubTraceLines(`${line}\n`)!) as { request: { headers: Array<{ name: string; value: string }> } }).request.headers;
    expect(headers.map((header) => [header.name, header.value])).toEqual([["X-Goog-Api-Key", TRACE_BLANKED], ["x-session", TRACE_BLANKED], ["Content-Type", "application/json"], ["Referer", TRACE_BLANKED]]);
  });
  it("refuses a trace where a secret was split across strings and so survives the string-level blanking", () => {
    const secret = "split-secret-value-0123456789";
    const parts = zip([{ name: "trace.trace", data: `${JSON.stringify({ type: "log", text: [secret.slice(0, 16), secret.slice(16)] })}\n` }]);
    const hit = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8").replace(/["[\],]/gu, "").includes(secret);
    expect(scrubTraceZip(parts, hit)).toBeNull();
  });
});

describe("the executor's media recorder", () => {
  it("is off unless the host was given proof the accounts are run-scoped", () => {
    expect(admittedMediaPolicy({ video: false, traces: false })).toEqual({ video: false, trace: false });
    expect(() => admittedMediaPolicy({ video: true, traces: false })).toThrow(/run-scoped/);
    expect(() => admittedMediaPolicy({ video: false, traces: true }, { runScoped: false })).toThrow(/run-scoped/);
    expect(admittedMediaPolicy({ video: true, traces: true }, { runScoped: true })).toEqual({ video: true, trace: true });
  });
  it("writes nothing for a kind that is not admitted", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: false, trace: true }, caseIds: ["case-a"], redactor: redactor() });
    expect(recorder.enabled("video")).toBe(false);
    expect(await recorder.record({ caseId: "case-a", kind: "video", bytes: WEBM })).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });
  it("keeps a clean video and a trace that is scrubbed on disk", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: true, trace: true }, caseIds: ["case-a", "case-b"], redactor: redactor() });
    expect(await recorder.record({ caseId: "case-b", kind: "video", bytes: WEBM })).toMatchObject({ caseId: "case-b", kind: "video", bytes: WEBM.length });
    const trace = await recorder.record({ caseId: "case-b", kind: "trace", bytes: goodTrace() });
    expect(trace?.omitted).toBeUndefined();
    const onDisk = await readFile(join(root, MEDIA_DIR, mediaFileName(1, "trace")));
    expect(sha(onDisk)).toBe(trace?.sha256);
    expect(unzipEntries(onDisk).get("trace.network")).not.toContain(SESSION);
    expect(await readFile(join(root, MEDIA_DIR, mediaFileName(1, "video")))).toEqual(WEBM);
  });
  it("records what the scrub did on the trace's entry, and the listing keeps the counts", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: false, trace: true }, caseIds: ["a"], redactor: redactor() });
    const entry = await recorder.record({ caseId: "a", kind: "trace", bytes: goodTrace() });
    expect(entry?.scrub).toMatchObject({ blankedValues: expect.any(Number) as number, droppedSnapshots: 0, droppedFrames: 0, droppedEntries: 0, secrets: expect.any(Number) as number });
    expect(entry?.scrub?.blankedValues).toBeGreaterThan(0);
    const listing = await finalizeMedia({ outDir: root, policy: { video: false, trace: true }, caseIds: ["a"] });
    expect(listing[0]?.scrub).toEqual(entry?.scrub);
  });
  it("drops a file that is not the kind it says, over its cap, or one a second time", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: true, trace: true }, caseIds: ["case-a", "case-b", "case-c"], redactor: redactor() });
    expect(await recorder.record({ caseId: "case-a", kind: "video", bytes: Buffer.from("not a webm file") })).toMatchObject({ omitted: "not_that_kind" });
    expect(await recorder.record({ caseId: "case-a", kind: "trace", bytes: WEBM })).toMatchObject({ omitted: "not_that_kind" });
    expect(await recorder.record({ caseId: "case-b", kind: "video", bytes: Buffer.concat([WEBM, Buffer.alloc(MEDIA_VIDEO_MAX_BYTES)]) })).toMatchObject({ omitted: "size_over_cap" });
    const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(MEDIA_TRACE_MAX_BYTES)]);
    expect(await recorder.record({ caseId: "case-b", kind: "trace", bytes: big })).toMatchObject({ omitted: "size_over_cap" });
    await recorder.record({ caseId: "case-c", kind: "video", bytes: WEBM });
    await expect(recorder.record({ caseId: "case-c", kind: "video", bytes: WEBM })).rejects.toThrow(/one file/);
    await expect(recorder.record({ caseId: "nope", kind: "video", bytes: WEBM })).rejects.toThrow(/unknown case/);
    await expect(recorder.record({ caseId: "case-a", kind: "gif" as never, bytes: WEBM })).rejects.toThrow(/unknown media kind/);
    expect((await readdir(join(root, MEDIA_DIR))).filter((name) => name !== "entries")).toEqual([mediaFileName(2, "video")]);
  });
  it("keeps at most one round's worth of video", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: true, trace: false }, caseIds: ["a", "b", "c"], redactor: redactor() });
    const chunk = Buffer.concat([WEBM, Buffer.alloc(9 * 1_048_576)]);
    expect((await recorder.record({ caseId: "a", kind: "video", bytes: chunk }))?.omitted).toBeUndefined();
    expect((await recorder.record({ caseId: "b", kind: "video", bytes: chunk }))?.omitted).toBeUndefined();
    expect((await recorder.record({ caseId: "c", kind: "video", bytes: chunk }))?.omitted).toBe("size_over_cap");
  });
  it("positive control: a video carrying the password is dropped with no file, and the same video without it is kept", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: true, trace: true }, caseIds: ["a", "b"], redactor: redactor() });
    expect(await recorder.record({ caseId: "a", kind: "video", bytes: Buffer.concat([WEBM, Buffer.from(PASSWORD)]) })).toMatchObject({ omitted: "unsafe_content" });
    expect((await recorder.record({ caseId: "b", kind: "video", bytes: WEBM }))?.omitted).toBeUndefined();
    expect((await readdir(join(root, MEDIA_DIR))).filter((name) => name !== "entries")).toEqual([mediaFileName(1, "video")]);
  });
  it("keeps a trace with a credential inside it only with the credential blanked, and drops one it cannot scrub", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy: { video: false, trace: true }, caseIds: ["a", "b"], redactor: redactor() });
    const kept = await recorder.record({ caseId: "a", kind: "trace", bytes: zip([{ name: "trace.trace", data: `${JSON.stringify({ text: PASSWORD })}\n` }]) });
    expect(kept?.omitted).toBeUndefined();
    expect(unzipEntries(await readFile(join(root, MEDIA_DIR, mediaFileName(0, "trace")))).get("trace.trace")).not.toContain(PASSWORD);
    expect(await recorder.record({ caseId: "b", kind: "trace", bytes: zip([{ name: "trace.network", data: "garbage line\n" }]) })).toMatchObject({ omitted: "unsafe_content" });
    expect((await readdir(join(root, MEDIA_DIR))).filter((name) => name !== "entries")).toEqual([mediaFileName(0, "trace")]);
  });
});

describe("settling a group's media", () => {
  const policy = { video: true, trace: true };
  it("lists what was kept and dropped, and removes the working files", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy, caseIds: ["a", "b"], redactor: redactor() });
    await recorder.record({ caseId: "a", kind: "video", bytes: WEBM });
    await recorder.record({ caseId: "b", kind: "video", bytes: Buffer.from("junk") });
    const listing = await finalizeMedia({ outDir: root, policy, caseIds: ["a", "b"] });
    expect(listing.map((row) => [row.caseId, row.kind, row.omitted])).toEqual([["a", "video", undefined], ["b", "video", "not_that_kind"]]);
    expect(JSON.parse(await readFile(join(root, MEDIA_LISTING_FILE), "utf8"))).toMatchObject({ schemaVersion: "e2e-executor-media/v1" });
    expect(await readdir(join(root, MEDIA_DIR))).toEqual([mediaFileName(0, "video")]);
  });
  it("removes a media file nobody listed, one that differs from its listing, and one for a kind not admitted", async () => {
    const root = await temp();
    const recorder = createMediaRecorder({ root, policy, caseIds: ["a", "b"], redactor: redactor() });
    await recorder.record({ caseId: "a", kind: "video", bytes: WEBM });
    await writeFile(join(root, MEDIA_DIR, mediaFileName(1, "trace")), goodTrace());
    await writeFile(join(root, MEDIA_DIR, "stray.webm"), WEBM);
    await finalizeMedia({ outDir: root, policy, caseIds: ["a", "b"] });
    expect(await readdir(join(root, MEDIA_DIR))).toEqual([mediaFileName(0, "video")]);
    const root2 = await temp();
    await createMediaRecorder({ root: root2, policy, caseIds: ["a"], redactor: redactor() }).record({ caseId: "a", kind: "video", bytes: WEBM });
    await writeFile(join(root2, MEDIA_DIR, mediaFileName(0, "video")), Buffer.concat([WEBM, Buffer.from("swapped")]));
    const swapped = await finalizeMedia({ outDir: root2, policy, caseIds: ["a"] });
    expect(swapped[0]?.omitted).toBe("unsafe_content");
    expect(await readdir(join(root2, MEDIA_DIR))).toEqual([]);
    const root3 = await temp();
    await createMediaRecorder({ root: root3, policy, caseIds: ["a"], redactor: redactor() }).record({ caseId: "a", kind: "video", bytes: WEBM });
    expect(await finalizeMedia({ outDir: root3, policy: { video: false, trace: false }, caseIds: ["a"] })).toEqual([]);
    expect(await readdir(root3)).toEqual([]);
  });
});

describe("the web case hooks", () => {
  const ports = (over: Partial<E2EWebMediaPorts> = {}, calls: string[] = []): E2EWebMediaPorts => ({ trace: true, tracePath: (caseId) => `/scratch/${caseId}.zip`, readFile: async () => goodTrace(), record: async (input) => { calls.push(`${input.kind}:${input.caseId}`); }, ...over });
  const context = (calls: string[], fail = false) => ({ tracing: { start: async () => { calls.push("start"); if (fail) throw new Error("no tracing"); }, stop: async (options: { path: string }) => { calls.push(`stop ${options.path}`); } } }) as never;
  it("starts a trace only when media is supplied and a trace is admitted", async () => {
    const calls: string[] = [];
    expect(await startWebCaseTrace({ media: undefined, context: context(calls) })).toBe(false);
    expect(await startWebCaseTrace({ media: ports({ trace: false }), context: context(calls) })).toBe(false);
    expect(await startWebCaseTrace({ media: ports(), context: null })).toBe(false);
    expect(calls).toEqual([]);
    expect(await startWebCaseTrace({ media: ports(), context: context(calls) })).toBe(true);
    expect(await startWebCaseTrace({ media: ports(), context: context(calls, true) })).toBe(false);
  });
  it("stops the trace, records it and the video, and does nothing without media", async () => {
    const calls: string[] = [];
    await finishWebCaseMedia({ media: ports({ readVideo: async () => WEBM }, calls), caseId: "case-a", context: context(calls), tracing: true });
    expect(calls).toEqual(["stop /scratch/case-a.zip", "trace:case-a", "video:case-a"]);
    const none: string[] = [];
    await finishWebCaseMedia({ media: undefined, caseId: "case-a", context: context(none), tracing: true });
    await finishWebCaseMedia({ media: ports({}, none), caseId: "case-a", context: context(none), tracing: false });
    expect(none).toEqual([]);
  });
  it("absorbs a trace that cannot be stopped or read and a video that cannot be read", async () => {
    await expect(finishWebCaseMedia({ media: ports({ readFile: async () => { throw new Error("gone"); }, readVideo: async () => { throw new Error("gone"); } }), caseId: "a", context: context([]), tracing: true })).resolves.toBeUndefined();
    await expect(finishWebCaseMedia({ media: ports({ record: async () => { throw new Error("refused"); } }), caseId: "a", context: context([]), tracing: true })).resolves.toBeUndefined();
  });
});

describe("the broker keeps its own bytes and the pack applies the gate", () => {
  const contains = (bytes: Uint8Array) => redactor().contains(bytes);
  const OPEN_GATE = { allowed: { video: true, trace: true } };
  it("reads, scrubs and returns NOTHING of a kind the gate refuses, so a withheld video is never stored (I4)", () => {
    const refused = prepareMediaArtifacts([{ scenarioId: "a", kind: "video", bytes: WEBM }, { scenarioId: "a", kind: "trace", bytes: goodTrace() }], { contains, gate: { allowed: { video: false, trace: true } } });
    expect(refused.problems).toEqual([{ scenarioId: "a", kind: "video", problem: "gate_refused" }]);
    expect(refused.artifacts.map((item) => item.ref.kind)).toEqual(["trace_zip"]);
    expect(refused.rows).toEqual([{ scenarioId: "a", trace: refused.artifacts[0]!.ref }]);
    const none = prepareMediaArtifacts([{ scenarioId: "a", kind: "video", bytes: WEBM }, { scenarioId: "a", kind: "trace", bytes: goodTrace() }], { contains, gate: { allowed: { video: false, trace: false } } });
    expect(none).toMatchObject({ rows: [], artifacts: [] });
    expect(none.problems.map((item) => item.problem)).toEqual(["gate_refused", "gate_refused"]);
  });
  it("scrubs a worker's trace again and stores the broker's copy under the digest of what it stores", () => {
    const dirty = zip([{ name: "trace.trace", data: "{}\n" }, { name: "trace.network", data: `${networkLine()}\n` }]);
    const prepared = prepareMediaArtifacts([{ scenarioId: "checkout", kind: "trace", bytes: dirty }], { contains, gate: OPEN_GATE });
    expect(prepared.problems).toEqual([]);
    const stored = prepared.artifacts[0]!;
    expect(stored.ref.sha256).toBe(sha(stored.data));
    expect(stored.ref.sha256).not.toBe(sha(dirty));
    expect(unzipEntries(stored.data).get("trace.network")).not.toContain(SESSION);
    expect(prepared.rows).toEqual([{ scenarioId: "checkout", trace: stored.ref }]);
  });
  it("leaves out a trace it cannot scrub, a video with a credential, the wrong kind, an over-cap file and a second of a kind", () => {
    const prepared = prepareMediaArtifacts([
      { scenarioId: "a", kind: "trace", bytes: zip([{ name: "trace.network", data: "not json\n" }]) },
      { scenarioId: "b", kind: "video", bytes: Buffer.concat([WEBM, Buffer.from(EMAIL)]) },
      { scenarioId: "c", kind: "video", bytes: goodTrace() },
      { scenarioId: "d", kind: "video", bytes: Buffer.concat([WEBM, Buffer.alloc(MEDIA_VIDEO_MAX_BYTES)]) },
      { scenarioId: "e", kind: "video", bytes: WEBM }, { scenarioId: "e", kind: "video", bytes: Buffer.concat([WEBM, Buffer.from("x")]) },
    ], { contains, gate: OPEN_GATE });
    expect(prepared.problems.map((item) => [item.scenarioId, item.problem])).toEqual([["a", "unsafe_content"], ["b", "unsafe_content"], ["c", "not_that_kind"], ["d", "over_cap"], ["e", "duplicate"]]);
    expect(prepared.rows.map((row) => row.scenarioId)).toEqual(["e"]);
    expect(prepared.artifacts).toHaveLength(1);
  });
  it("hands back what the broker's own scrub did to each trace it kept", () => {
    const prepared = prepareMediaArtifacts([{ scenarioId: "checkout", kind: "trace", bytes: goodTrace() }, { scenarioId: "checkout", kind: "video", bytes: WEBM }], { contains, gate: OPEN_GATE });
    expect(prepared.scrubbed).toHaveLength(1);
    expect(prepared.scrubbed[0]).toMatchObject({ scenarioId: "checkout", stats: { blankedValues: expect.any(Number) as number } });
  });
  it("adds media to the rows, with a row of its own for a scenario that had no strip", () => {
    const strip = [{ scenarioId: "s1", strip: { before: [], after: [] }, consoleErrors: 0 }] as NonNullable<EvidenceRaw["browser"]>;
    const ref = { kind: "webm" as const, sha256: "a".repeat(64), bytes: 10, retentionClass: "evidence-short" as const };
    const out = attachMedia(strip, [{ scenarioId: "s1", video: ref }, { scenarioId: "s2", video: ref }]);
    expect(out.map((row) => [row.scenarioId, row.video?.sha256])).toEqual([["s1", ref.sha256], ["s2", ref.sha256]]);
  });

  const DIGEST = "c".repeat(64);
  const env = (kind: "run_scoped" | "registered"): EvidenceEnvironment => ({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [{ profileId: "buyer", kind }] });
  const gateInput = { capture: { video: true, traces: true }, tier: "sandbox" as const, accounts: [{ provisioner: "seed_command" as const, profileId: "buyer" }], data: "synthetic" as const, companyAllows: { video: true, trace: true } };
  /** A revocation report: whole (settled at once), held until a given time, refused, or missing. */
  const WHOLE: RevocationReport = { confirmed: true, accounts: [{ profileId: "buyer", sessionsEnded: true, revoked: true, accountGone: true, existenceControl: true, sessionProof: "dead", recorded: true }] };
  const HELD: RevocationReport = { confirmed: false, heldUntil: "2026-11-03T11:00:00.000Z", accounts: [{ ...WHOLE.accounts[0]!, sessionProof: "not_possible" }] };
  const REFUSED: RevocationReport = { confirmed: false, holdRefused: "token_lifetime_over_max_hold", accounts: [{ ...WHOLE.accounts[0]!, sessionProof: "not_possible" }] };
  const AT = Date.parse("2026-11-03T10:30:00.000Z");
  function pack(kind: "run_scoped" | "registered", revocation: RevocationReport | undefined, companyAllows = { video: true, trace: true }, over: { data?: "synthetic" | "unknown"; now?: number } = {}) {
    // The caller here stored both kinds (a gate that said yes at that moment); the pack builder applies the publication gate again, so what it keeps never depends on the earlier call.
    const prepared = prepareMediaArtifacts([{ scenarioId: "checkout", kind: "video", bytes: WEBM }, { scenarioId: "checkout", kind: "trace", bytes: goodTrace() }], { contains, gate: OPEN_GATE });
    const browser = attachMedia([], prepared.rows);
    const built = buildEvidencePack({ candidateDigest: DIGEST, checks: [], environment: env(kind), rawText: JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], browser }),
      storedArtifacts: new Map(prepared.artifacts.map((item) => [item.ref.sha256, { kind: item.ref.kind, bytes: item.ref.bytes }])),
      media: publicationMediaFor({ ...gateInput, companyAllows, revocation, now: over.now ?? AT, ...(over.data === undefined ? {} : { data: over.data }) }).media });
    return { built, prepared };
  }
  it("keeps the video and the trace only with run-scoped accounts, the company's switch and the revocation proof", () => {
    const { built } = pack("run_scoped", WHOLE);
    expect(built.pack?.browser[0]?.video?.kind).toBe("webm");
    expect(built.pack?.browser[0]?.trace?.kind).toBe("trace_zip");
    expect(built.withheldArtifacts).toEqual([]);
  });
  it("withholds both, and lists both for deletion, when the revocation is not confirmed", () => {
    const { built, prepared } = pack("run_scoped", REFUSED);
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld).toEqual([{ artifact: "video", reason: "revocation_not_confirmed" }, { artifact: "trace", reason: "revocation_not_confirmed" }]);
    expect(built.withheldArtifacts.map((ref) => ref.sha256).sort()).toEqual(prepared.artifacts.map((item) => item.ref.sha256).sort());
  });
  it("publication reads the proof through revocationSettledAt only: a held report keeps both withheld until its hold has run out, then keeps them", () => {
    const early = pack("run_scoped", HELD, undefined, { now: Date.parse("2026-11-03T10:59:59.000Z") });
    expect(early.built.pack?.browser[0]?.video).toBeUndefined();
    expect(early.built.pack?.browser[0]?.withheld?.map((item) => item.reason)).toEqual(["revocation_not_confirmed", "revocation_not_confirmed"]);
    const settled = pack("run_scoped", HELD, undefined, { now: Date.parse("2026-11-03T11:00:00.000Z") });
    expect(settled.built.pack?.browser[0]?.video?.kind).toBe("webm");
    expect(settled.built.pack?.browser[0]?.trace?.kind).toBe("trace_zip");
    // a report taken as `confirmed: true` is not taken at its word: a flag that disagrees with its parts does not publish
    const lying = pack("run_scoped", { ...HELD, confirmed: true }, undefined, { now: AT });
    expect(lying.built.pack?.browser[0]?.video).toBeUndefined();
  });
  it("a refused hold never publishes, however long one waits", () => {
    expect(pack("run_scoped", REFUSED, undefined, { now: AT + 400 * 24 * 3_600_000 }).built.pack?.browser[0]?.video).toBeUndefined();
  });
  it("withholds both when the revocation proof is missing (undefined), not only when it is false (I2)", () => {
    const { built } = pack("run_scoped", undefined);
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld?.map((item) => item.reason)).toEqual(["revocation_not_confirmed", "revocation_not_confirmed"]);
  });
  it("re-applies the data check at publication: data not known to be synthetic withholds both, though the pack's own schema says synthetic (I2)", () => {
    const { built, prepared } = pack("run_scoped", WHOLE, { video: true, trace: true }, { data: "unknown" });
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.trace).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld?.map((item) => item.reason)).toEqual(["data_not_synthetic", "data_not_synthetic"]);
    expect(built.withheldArtifacts).toHaveLength(prepared.artifacts.length);
  });
  it("never keeps a kind when the gate result says no, whatever the other three inputs say", () => {
    const prepared = prepareMediaArtifacts([{ scenarioId: "checkout", kind: "video", bytes: WEBM }], { contains, gate: OPEN_GATE });
    const media = publicationMediaFor({ ...gateInput, companyAllows: { video: true, trace: true }, revocation: WHOLE, now: AT }).media;
    const built = buildEvidencePack({ candidateDigest: DIGEST, checks: [], environment: env("run_scoped"), rawText: JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], browser: attachMedia([], prepared.rows) }),
      storedArtifacts: new Map(prepared.artifacts.map((item) => [item.ref.sha256, { kind: item.ref.kind, bytes: item.ref.bytes }])),
      media: { ...media, gate: { allowed: { video: false, trace: true }, reasons: { video: "data_not_synthetic" } } } });
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld).toEqual([{ artifact: "video", reason: "data_not_synthetic" }]);
  });
  it("withholds for a registered account and for a company that has not switched the kind on", () => {
    expect(pack("registered", WHOLE).built.pack?.browser[0]?.withheld?.map((item) => item.reason)).toEqual(["account_not_run_scoped", "account_not_run_scoped"]);
    const off = pack("run_scoped", WHOLE, { video: false, trace: true }).built.pack?.browser[0];
    expect(off?.video).toBeUndefined();
    expect(off?.withheld).toEqual([{ artifact: "video", reason: "company_setting_off" }]);
    expect(off?.trace?.kind).toBe("trace_zip");
  });
});
