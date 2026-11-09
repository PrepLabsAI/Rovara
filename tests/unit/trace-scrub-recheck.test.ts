// Proof and evidence fix round 2 (Opus re-check probes, C2): each probe from the review is a test here. The structure is the same as the review's: a small stored zip, scrubbed with no help from the caller unless
// the test names a known secret, then read back independently.
import { describe, expect, it } from "vitest";
import { crc32, inflateRawSync } from "node:zlib";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { TRACE_BLANKED, blankQueryText, scrubTrace } from "../../packages/verifier/src/executor/trace-scrub.js";

// Built at run time so the file holds no key-shaped literal.
const RST = ["rst", "9f8e7d6c5b4a3210"].join("-");
const IDT = ["idt", "0123456789abcdef"].join("-");

function zip(files: Record<string, string | Buffer>): Uint8Array {
  const parts: Buffer[] = []; const cd: Buffer[] = []; let off = 0;
  for (const [n, t] of Object.entries(files)) {
    const name = Buffer.from(n); const data = Buffer.from(t); const crc = crc32(data) >>> 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, name, data); cd.push(c, name); off += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(cd); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); const k = Object.keys(files).length; e.writeUInt16LE(k, 8); e.writeUInt16LE(k, 10); e.writeUInt32LE(dir.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, e]));
}
function entries(z: Uint8Array): Map<string, string> {
  const v = Buffer.from(z); const eocd = v.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const count = v.readUInt16LE(eocd + 10); let at = v.readUInt32LE(eocd + 16); const out = new Map<string, string>();
  for (let i = 0; i < count; i += 1) { const nl = v.readUInt16LE(at + 28); const m = v.readUInt16LE(at + 10); const sz = v.readUInt32LE(at + 20); const lo = v.readUInt32LE(at + 42); const st = lo + 30 + v.readUInt16LE(lo + 26) + v.readUInt16LE(lo + 28); const raw = v.subarray(st, st + sz); out.set(v.toString("utf8", at + 46, at + 46 + nl), (m === 8 ? inflateRawSync(raw) : raw).toString("latin1")); at += 46 + nl + v.readUInt16LE(at + 30) + v.readUInt16LE(at + 32); }
  return out;
}
const L = (o: unknown) => JSON.stringify(o);
const none = () => false;
const text = (z: { zip: Uint8Array } | null) => (z === null ? null : [...entries(z.zip).entries()].map(([name, body]) => `${name}:${body}`).join("\n"));
const run = (files: Record<string, string | Buffer>, known: string[] = [], contains: (bytes: Uint8Array) => boolean = none, accountContains?: (bytes: Uint8Array) => boolean) =>
  scrubTrace(zip({ "trace.trace": "", ...files }), contains, { secrets: known, ...(accountContains === undefined ? {} : { accountContains }) });
const net = (request: Record<string, unknown>, response: Record<string, unknown> = {}) => L({ type: "resource-snapshot", snapshot: { request: { headers: [], ...request }, response } });

describe("every query value goes, whatever its length, whatever the carrier (P1-P4)", () => {
  it("P1: HAR queryString and postData params arrays are blanked even for a 6-digit code", () => {
    const out = text(run({ "trace.network": net({ url: "https://app.test/verify?otp=482913", queryString: [{ name: "otp", value: "482913" }], postData: { params: [{ name: "pin", value: "7731" }] } }) }));
    expect(out).not.toContain("482913");
    expect(out).not.toContain("7731");
    expect(out).toContain('"name":"otp","value":"<blanked>"');
  });
  it("P2: a relative URL's query token, in a DOM snapshot's href and anywhere else", () => {
    const out = text(run({ "trace.trace": L({ type: "frame-snapshot", snapshot: { pageId: "p", timestamp: 1, html: ["A", { href: "/reset?token=" + RST + "" }, "reset"] } }) }));
    expect(out).not.toContain("" + RST + "");
  });
  it("P2b: the token read from a relative or in-text URL is a round secret everywhere else it appears (the page source, another snapshot)", () => {
    const out = text(run({
      "trace.trace": L({ type: "event", params: { url: "/reset?token=" + RST + "" } }),
      "resources/page.html": "<a href='/somewhere'>use code " + RST + "</a>",
    }));
    expect(out).not.toContain("" + RST + "");
    expect(out).toContain("resources/page.html:<blanked>");
  });
  it("P3: ws and wss addresses", () => {
    expect(text(run({ "trace.trace": L({ type: "event", params: { url: "wss://app.test/socket?session=ws-sess-11223344556677", other: "ws://h/p?a=1&b=2" } }) }))).not.toMatch(/ws-sess-11223344556677|a=1|b=2/u);
  });
  it("P4: a URL inside a longer string, and a fragment that carries a token", () => {
    const out = text(run({ "trace.trace": L({ type: "console", text: "redirecting to https://app.test/cb?code=oauthcode-aabbccddeeff then #access_token=frag-tok-0123456789&x=1" }) }));
    expect(out).not.toContain("oauthcode-aabbccddeeff");
    expect(out).not.toContain("frag-tok-0123456789");
    expect(out).toContain("https://app.test/cb?code=<blanked>");
  });
  it("blanks short values, keeps keys, paths and empty values, and is idempotent", () => {
    expect(blankQueryText("/p?a=1&b=&c=xyz#h=2")).toBe(`/p?a=${TRACE_BLANKED}&b=&c=${TRACE_BLANKED}#h=${TRACE_BLANKED}`);
    expect(blankQueryText(blankQueryText("/p?a=1"))).toBe(blankQueryText("/p?a=1"));
    expect(blankQueryText("no query here")).toBe("no query here");
    expect(blankQueryText("https://user:pw@host/p")).toBe("https://host/p");
    expect(blankQueryText("a#anchor")).toBe("a#anchor");
  });
});

describe("harvest reads the shapes real apps use (P5, P6, P9)", () => {
  it("P5: simplejwt's access and refresh fields", () => {
    const out = text(run({ "trace.network": net({ url: "https://app.test/api/token" }, { content: { _sha1: "a.json" } }), "resources/a.json": L({ access: "acc-0011223344556677", refresh: "ref-8899aabbccddeeff" }) }));
    expect(out).not.toContain("ref-8899aabbccddeeff");
    expect(out).not.toContain("acc-0011223344556677");
  });
  it("P6: a form-encoded body", () => {
    const out = text(run({ "trace.network": net({ url: "https://app.test/oauth/token", postData: { _sha1: "b.txt" } }), "resources/b.txt": "grant_type=refresh_token&refresh_token=form-rt-0123456789abcdef" }));
    expect(out).not.toContain("form-rt-0123456789abcdef");
  });
  it("JSON nested inside a string is read as the body it is", () => {
    const out = text(run({ "trace.trace": L({ type: "console", text: JSON.stringify({ id_token: "nested-idt-0123456789abcd" }) }), "resources/n.txt": "x nested-idt-0123456789abcd y" }));
    expect(out).not.toContain("nested-idt-0123456789abcd");
  });
  it("P9: a secret the caller knows, held in a JSON body that escapes the slash", () => {
    const out = text(run({ "trace.network": "", "resources/c.json": '{"x":"abc\\/def\\/ghijkl"}' }, ["abc/def/ghijkl"]));
    expect(out).not.toContain("ghijkl");
  });
});

describe("a secret split across strings is refused with the REAL searcher (P7)", () => {
  it("a known secret in two strings of one line", () => {
    expect(run({ "trace.trace": L({ type: "event", a: "known-secret-", b: "part-two-xyz" }) }, ["known-secret-part-two-xyz"])).toBeNull();
  });
  it("positive control: the same two strings with no known secret are kept", () => {
    expect(run({ "trace.trace": L({ type: "event", a: "known-secret-", b: "part-two-xyz" }) })).not.toBeNull();
  });
  it("a secret in an object KEY is refused too", () => {
    expect(run({ "trace.trace": L({ type: "event", "known-secret-part-two-xyz": 1 }) }, ["known-secret-part-two-xyz"])).toBeNull();
  });
});

describe("entry names are an allow-list (P8)", () => {
  it("drops an entry that is not a line file, a resource or a screencast image, and counts it", () => {
    const out = run({ "extra/net.json": L({ headers: { "x-api-key": "unk-entry-key-00112233" }, url: "https://a.test/?t=zzzzzzzzzzzz" }), "notes.txt": "hello", "resources/ok.json": "{}", "screencast/f.jpeg": Buffer.from([0xff, 0xd8, 0xff, 1, 2]) });
    expect([...entries(out!.zip).keys()]).toEqual(["trace.trace", "resources/ok.json", "screencast/f.jpeg"]);
    expect(out!.stats.droppedEntries).toBe(2);
  });
  it("refuses an archive with no trace file at all", () => {
    expect(scrubTrace(zip({ "resources/a.json": "{}" }), none)).toBeNull();
  });
  it("does not take a nested path for a line file", () => {
    expect([...entries(run({ "deep/trace.network": L({ type: "x" }) })!.zip).keys()]).toEqual(["trace.trace"]);
  });
});

describe("a snapshot that shows a round secret takes the frames that show it with it (P10)", () => {
  const TOKEN = "shown-token-1234567890";
  const files = (extra: Record<string, string | Buffer> = {}) => ({
    "trace.network": net({ url: "https://a.test/x", headers: [{ name: "authorization", value: `Bearer ${TOKEN}` }] }),
    "trace.trace": [
      L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 100, html: ["DIV", {}, "Welcome"] } }),
      L({ type: "screencast-frame", pageId: "p1", file: "screencast/early.jpeg", timestamp: 110 }),
      L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 200, html: ["DIV", {}, "Welcome back"] } }),
      L({ type: "screencast-frame", pageId: "p1", file: "screencast/mid.jpeg", timestamp: 250 }),
      L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 300, html: ["DIV", {}, `Your token: ${TOKEN}`] } }),
      L({ type: "screencast-frame", pageId: "p1", file: "screencast/late.jpeg", timestamp: 310 }),
      L({ type: "screencast-frame", pageId: "p2", file: "screencast/other-page.jpeg", timestamp: 320 }),
    ].join("\n"),
    "screencast/early.jpeg": Buffer.from([0xff, 0xd8, 0xff, 1]), "screencast/mid.jpeg": Buffer.from([0xff, 0xd8, 0xff, 2]), "screencast/late.jpeg": Buffer.from([0xff, 0xd8, 0xff, 3]), "screencast/other-page.jpeg": Buffer.from([0xff, 0xd8, 0xff, 4]),
    ...extra,
  });
  it("drops the snapshot, and the frames of that page after its last clean snapshot, with their images; keeps the earlier frame and other pages", () => {
    const out = run(files())!;
    const kept = entries(out.zip);
    expect(out.stats).toMatchObject({ droppedSnapshots: 1, droppedFrames: 2, secrets: expect.any(Number) as number });
    expect([...kept.keys()].filter((name) => name.startsWith("screencast/")).sort()).toEqual(["screencast/early.jpeg", "screencast/other-page.jpeg"]);
    const lines = kept.get("trace.trace")!.split("\n").map((line) => JSON.parse(line) as { type: string; file?: string });
    expect(lines.filter((line) => line.type === "screencast-frame").map((line) => line.file)).toEqual(["screencast/early.jpeg", "screencast/other-page.jpeg"]);
    expect(lines.filter((line) => line.type === "frame-snapshot")).toHaveLength(2);
    expect(text(out)).not.toContain(TOKEN);
  });
  it("positive control: with the token nowhere in the snapshot, nothing is dropped", () => {
    const clean = files({ "trace.trace": files()["trace.trace"].replace(TOKEN, "nothing") });
    const out = run(clean)!;
    expect(out.stats).toMatchObject({ droppedSnapshots: 0, droppedFrames: 0 });
    expect([...entries(out.zip).keys()].filter((name) => name.startsWith("screencast/"))).toHaveLength(4);
  });
  it("refuses the trace when the snapshot that shows the secret names no page or no time", () => {
    for (const snapshot of [{ timestamp: 300 }, { pageId: "p1" }, { pageId: "p1", timestamp: "late" }]) {
      const bad = L({ type: "frame-snapshot", snapshot: { ...snapshot, html: ["DIV", {}, `Your token: ${TOKEN}`] } });
      expect(run(files({ "trace.trace": bad }))).toBeNull();
    }
  });
  it("drops a snapshot that shows only the account's own password, but keeps every frame (a password input renders as dots)", () => {
    const PASSWORD = "planted-Password-7f3a91c2d4e8b0aa";
    const r = createCredentialRedactor([{ profileId: "buyer", email: "buyer@example.test", password: PASSWORD }]);
    const trace = [L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 100, html: ["INPUT", { type: "password", value: PASSWORD }] } }), L({ type: "screencast-frame", pageId: "p1", file: "screencast/a.jpeg", timestamp: 110 })].join("\n");
    const base = { "trace.trace": trace, "screencast/a.jpeg": Buffer.from([0xff, 0xd8, 0xff, 1]) };
    const withScope = run(base, [], (bytes) => r.contains(bytes), (bytes) => r.contains(bytes, "accounts"))!;
    expect(withScope.stats).toMatchObject({ droppedSnapshots: 1, droppedFrames: 0 });
    expect([...entries(withScope.zip).keys()]).toContain("screencast/a.jpeg");
    // without the account-only scope every hit counts as a round secret: the stricter reading drops the frames
    const strict = run(base, [], (bytes) => r.contains(bytes))!;
    expect(strict.stats).toMatchObject({ droppedSnapshots: 1, droppedFrames: 1 });
  });
  it("keeps the counts of what it did", () => {
    const out = run({ ...files(), "resources/body.json": L({ id_token: "" + IDT + "" }), "trace.network": net({ url: "https://a.test/x?code=123456", headers: [{ name: "authorization", value: `Bearer ${TOKEN}` }] }, { content: { _sha1: "body.json" } }) })!;
    expect(out.stats.blankedResources).toBeGreaterThanOrEqual(1);
    expect(out.stats.blankedValues).toBeGreaterThan(0);
    expect(out.stats.droppedSnapshots).toBe(1);
    expect(out.stats.droppedFrames).toBe(2);
  });
});
