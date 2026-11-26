// Proof and evidence fix round 2 (Opus re-check probes, C2): each probe from the review is a test here. The structure is the same as the review's: a small stored zip, scrubbed with no help from the caller unless
// the test names a known secret, then read back independently.
import { describe, expect, it } from "vitest";
import { crc32, inflateRawSync } from "node:zlib";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { TRACE_BLANKED, blankQueryText, scrubTrace } from "../../packages/verifier/src/executor/trace-scrub.js";
import { markupTextOf } from "../../packages/verifier/src/executor/trace-scrub-markup.js";


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
  it("blanks short values, keeps keys, paths and empty values, and is idempotent", () => {
    expect(blankQueryText("/p?a=1&b=&c=xyz#h=2")).toBe(`/p?a=${TRACE_BLANKED}&b=&c=${TRACE_BLANKED}#h=${TRACE_BLANKED}`);
    expect(blankQueryText(blankQueryText("/p?a=1"))).toBe(blankQueryText("/p?a=1"));
    expect(blankQueryText("no query here")).toBe("no query here");
    expect(blankQueryText("https://user:pw@host/p")).toBe("https://host/p");
    expect(blankQueryText("a#anchor")).toBe("a#anchor");
  });
  it("PC-N2: blanks a bare token after ? or # (no key), and a ;jsessionid value, and keeps a short anchor", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
    expect(blankQueryText(`https://app.test/cb#${jwt}`)).toBe(`https://app.test/cb#${TRACE_BLANKED}`);
    expect(blankQueryText("/reset?0a1b2c3d4e5f6a7b8c9d")).toBe(`/reset?${TRACE_BLANKED}`);
    expect(blankQueryText("/app;jsessionid=ABCDEF0123456789/home")).toBe(`/app;jsessionid=${TRACE_BLANKED}`.concat("/home"));
    expect(blankQueryText("/app;JSESSIONID=ABCDEF0123456789?x=1")).toBe(`/app;JSESSIONID=${TRACE_BLANKED}?x=${TRACE_BLANKED}`);
    expect(blankQueryText(blankQueryText(`/app;jsessionid=ABCDEF0123456789#${jwt}`))).toBe(blankQueryText(`/app;jsessionid=ABCDEF0123456789#${jwt}`));
    expect(blankQueryText("is this it? yes #buy")).toBe("is this it? yes #buy");
  });
});

describe("harvest reads the shapes real apps use (P5, P6, P9)", () => {
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
});

describe("PC-N5: HTML-safe JSON escapes, inline form bodies and web-storage pairs (before media is turned on)", () => {
  it("finds a known secret that a JSON encoder wrote with \\u0026, \\u003c, \\u003e or \\u002b (Go style, either hex case)", () => {
    const secret = "pa+ss&w<rd>-0123456789";
    for (const escaped of ["pa\\u002bss\\u0026w\\u003crd\\u003e-0123456789", "pa\\u002Bss\\u0026w\\u003Crd\\u003E-0123456789"]) {
      const out = text(run({ "trace.network": "", "resources/r.json": `{"password":"${escaped}"}` }, [secret]));
      expect(out).not.toContain("0123456789");
    }
  });
  it("harvests the sensitive fields of a form body held inline in postData.text", () => {
    const body = "grant_type=refresh_token&refresh_token=inline-rt-0123456789abcdef";
    const out = text(run({ "trace.network": net({ url: "https://app.test/oauth/token", postData: { mimeType: "application/x-www-form-urlencoded", text: body } }), "resources/p.txt": "echo inline-rt-0123456789abcdef echo" }));
    expect(out).not.toContain("inline-rt-0123456789abcdef");
  });
  it("harvests the values of localStorage and sessionStorage pairs of a storage state, whatever their names", () => {
    const state = { cookies: [], origins: [{ origin: "https://app.test", localStorage: [{ name: "view", value: "ls-value-0123456789abcd" }], sessionStorage: [{ name: "tab", value: "ss-value-0123456789abcd" }] }] };
    const out = text(run({ "trace.trace": L({ type: "context-options", storageState: state }), "resources/s.txt": "a ls-value-0123456789abcd b ss-value-0123456789abcd c" }));
    expect(out).not.toContain("ls-value-0123456789abcd");
    expect(out).not.toContain("ss-value-0123456789abcd");
  });
});

describe("PC-N4: a secret split across sibling DOM nodes of a snapshot", () => {
  const SHOWN = "split-value-0123456789";
  const trace = [
    L({ type: "screencast-frame", pageId: "p1", file: "screencast/early.jpeg", timestamp: 90 }),
    L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 100, html: ["DIV", {}, "Welcome"] } }),
    L({ type: "frame-snapshot", snapshot: { pageId: "p1", timestamp: 200, html: ["DIV", {}, ["SPAN", {}, SHOWN.slice(0, 11)], ["SPAN", {}, SHOWN.slice(11)]] } }),
    L({ type: "screencast-frame", pageId: "p1", file: "screencast/late.jpeg", timestamp: 210 }),
  ].join("\n");
  it("drops the snapshot and the page's frames after the last clean one, and keeps the rest of the trace", () => {
    const out = run({ "trace.trace": trace, "screencast/early.jpeg": Buffer.from([0xff, 0xd8, 0xff, 1]), "screencast/late.jpeg": Buffer.from([0xff, 0xd8, 0xff, 2]) }, [SHOWN]);
    expect(out).not.toBeNull();
    expect(out!.stats).toMatchObject({ droppedSnapshots: 1, droppedFrames: 1 });
    expect(text(out)).not.toContain(SHOWN.slice(0, 11));
    expect([...entries(out!.zip).keys()]).toEqual(expect.arrayContaining(["screencast/early.jpeg"]));
    expect([...entries(out!.zip).keys()]).not.toContain("screencast/late.jpeg");
  });
});

describe("PC-N4: a secret split by markup inside a captured HTML resource", () => {
  const VALUE = "html-split-0123456789";
  it.each([
    ["a comment (React's text separator)", "<p>html-spl<!-- -->it-0123456789</p>"],
    ["a span", "<p><span>html-spl</span><span>it-0123456789</span></p>"],
    ["a tag with attributes and a comment", '<div>html-spl<b class="x" data-k="x"></b><!-- a > b -->it-0123456789</div>'],
  ])("blanks the resource when the secret is split by %s", (_name, html) => {
    const out = text(run({ "trace.network": "", "resources/page.html": html }, [VALUE]));
    expect(out).not.toContain("0123456789");
    expect(out).toContain(`resources/page.html:${TRACE_BLANKED}`);
  });
  it("keeps an HTML resource that holds no secret, split or whole", () => {
    const out = text(run({ "trace.network": "", "resources/page.html": "<p>hello<!-- -->world</p>" }, [VALUE]));
    expect(out).toContain("<p>hello<!-- -->world</p>");
  });
});

describe("PC-N4: the markup scan of a resource blob (review P3 delta)", () => {
  const VALUE = "html-split-0123456789";
  const blanked = (html: string) => text(run({ "trace.network": "", "resources/page.html": html }, [VALUE]))!.includes(`resources/page.html:${TRACE_BLANKED}`);
  it.each([
    ["<!--> (an empty comment)", "<p>html-spl<!-->it-0123456789</p>"],
    ["<!---> (an empty comment)", "<p>html-spl<!--->it-0123456789</p>"],
    ["a soft hyphen character", "html-spl\u00adit-0123456789"],
    ["&shy;", "html-spl&shy;it-0123456789"],
    ["a zero-width space", "html-spl\u200bit-0123456789"],
    ["a zero-width non-joiner", "html-spl\u200cit-0123456789"],
    ["a zero-width joiner", "html-spl\u200dit-0123456789"],
    ["a word joiner", "html-spl\u2060it-0123456789"],
    ["a byte-order mark", "html-spl\ufeffit-0123456789"],
    ["&#x200B;", "html-spl&#x200B;it-0123456789"],
    ["&#x00AD;", "html-spl&#x00ad;it-0123456789"],
    ["&#8203;", "html-spl&#8203;it-0123456789"],
    ["&#173;", "html-spl&#173;it-0123456789"],
    ["&#65279;", "html-spl&#65279;it-0123456789"],
    ["&ZeroWidthSpace;", "html-spl&ZeroWidthSpace;it-0123456789"],
    ["&zwnj; and &zwj;", "html-spl&zwnj;&zwj;it-0123456789"],
    ["&NoBreak;", "html-spl&NoBreak;it-0123456789"],
    ["an invisible character inside a comment-split secret", "<p>html-s<!-- -->pl&shy;it-0123456789</p>"],
  ])("blanks a resource whose secret is split by %s", (_name, html) => { expect(blanked(html)).toBe(true); });
  it("keeps a resource whose text only looks alike", () => {
    expect(blanked("<p>html-spl</p><p>other-0123456789</p>")).toBe(false);
    expect(blanked("a < b and c > d, 1<2, <3 html-spl&amp;it-0123456789 is not it")).toBe(false);
  });
  it("treats an unclosed comment, a lone < and a tag longer than the cap as text", () => {
    expect(markupTextOf("a<!-- never closed b")).toBe("a<!-- never closed b");
    expect(markupTextOf("a<b")).toBe("a<b");
    expect(blanked(`html-spl<a ${"x".repeat(5_000)}>it-0123456789`)).toBe(false);
  });
  it.each([["<", "<".repeat(1_000_000)], ["<a", "<a".repeat(500_000)], ["<!--", "<!--".repeat(250_000)], ["<a >... with no end", `${"<a ".repeat(333_000)}`], ["&#0", "&#0".repeat(333_000)]])("scans a 1 MB blob of %s in linear time", (_name, blob) => {
    const started = performance.now();
    const out = markupTextOf(blob);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(out.length).toBeGreaterThan(0);
  });
  it("scans a 32 MB blob of < in a few seconds", () => {
    const started = performance.now();
    markupTextOf("<".repeat(32 * 1024 * 1024));
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

describe("PC-N4: quoted > and entities with no semicolon in a resource blob (review P3 leftovers)", () => {
  const VALUE = "html-split-0123456789";
  const blanked = (html: string) => text(run({ "trace.network": "", "resources/page.html": html }, [VALUE]))!.includes(`resources/page.html:${TRACE_BLANKED}`);
  it.each([
    ["a > inside a double-quoted value", '<p>html-spl<b data-k=">" class="x">it-0123456789</p>'],
    ["a > inside a single-quoted value", "<p>html-spl<b data-k='a>b'>it-0123456789</p>"],
    ["a > in a title value", 'html-spl<b title="x>y">it-0123456789'],
    ["a > in a value with spaces around the =", 'html-spl<b title = ">" >it-0123456789'],
    ["a > in a single-quoted value holding a double quote", "html-spl<b t='\"x>y'>it-0123456789"],
    ["a quoted value that never closes (the tag ends at its first >)", '<p>html-spl<b data-k="x>it-0123456789</p>'],
    ["a single-quoted value that never closes", "<p>html-spl<b data-k='x>it-0123456789</p>"],
    ["an apostrophe in an unquoted value (title=O'Brien)", "html-spl<span data-x=O'Brien>it-0123456789</span> isn't <br>"],
    ["a quote in an attribute name", "html-spl<b x'y>it-0123456789 don't</b>"],
    ["a quote inside <!...>", 'html-spl<!x">it-0123456789 "q" a "b <br>'],
    ["a quote inside <?...>", 'html-spl<?x">it-0123456789 "q" a "b <br>'],
    ["&#173 with no semicolon", "html-spl&#173it-0123456789"],
    ["&#xAD with no semicolon", "html-spl&#xADit-0123456789"],
    ["&#8203 with no semicolon", "html-spl&#8203it-0123456789"],
    ["&#x200B with no semicolon", "html-spl&#x200Bit-0123456789"],
    ["&shy with no semicolon", "html-spl&shyit-0123456789"],
    ["&#173 at the end of a word", "html-spl&#173 it-0123456789".replace(" ", "")],
  ])("blanks a resource whose secret is split by %s", (_name, html) => { expect(blanked(html)).toBe(true); });
  it("opens a quote only after an = (as a browser reads an attribute value)", () => {
    expect(markupTextOf("a<b x'y>c")).toBe("ac");
    expect(markupTextOf("a<b t=O'B>c'd>e")).toBe("ac'd>e");
    expect(markupTextOf('a<b t = ">" >c')).toBe("ac");
    expect(markupTextOf("a<b t='\"x>y'>c")).toBe("ac");
    expect(markupTextOf('a<b t="1"u=\'>\'>c')).toBe("ac");
    expect(markupTextOf('a<b ="x>y">c')).toBe('ay">c'); // a leading = starts a name; the quote is part of it
    expect(markupTextOf('a<b t=="x>y">c')).toBe('ay">c'); // the second = starts an unquoted value
    expect(markupTextOf('a</b t=">">c')).toBe("ac");
    expect(markupTextOf('a</b="x>y">c')).toBe('ay">c'); // an end tag's name runs to a space, / or >
  });
  it("ends <!...>, <?...> and </ + a non-letter at the first > whatever quotes it holds", () => {
    expect(markupTextOf('a<!x">c">d')).toBe('ac">d');
    expect(markupTextOf("a<?x'>c'>d")).toBe("ac'>d");
    expect(markupTextOf('a</ x">c">d')).toBe('ac">d');
    expect(markupTextOf("a<!DOCTYPE html>b")).toBe("ab");
  });
  it("keeps a quote that is in the text, and a > after a quote-less tag", () => {
    expect(markupTextOf("it's a \"q\" <b>bold</b> > done")).toBe("it's a \"q\" bold > done");
  });
  it("reads a longer number or name as itself, and &shy plus letters as a soft hyphen then the letters", () => {
    expect(markupTextOf("a&#1730b&#xADE;c&#x20000;d&shyness")).toBe("a&#1730b&#xADE;c&#x20000;d" + "ness");
    expect(markupTextOf("a&#173b&#xADg")).toBe("abg");
    expect(markupTextOf("a&#173;b&#xAD;c&shy;d")).toBe("abcd");
    expect(markupTextOf("a&zwnjb&NoBreakc&SHY;d")).toBe("a&zwnjb&NoBreakc&SHY;d");
  });
  it("does not let a quote opened past the tag cap, or junk quotes, end a tag late", () => {
    expect(markupTextOf(`a<b t="${"x".repeat(5_000)}">c`)).toContain("x");
    expect(blanked(`html-spl<a t="${"x".repeat(5_000)}>">it-0123456789`)).toBe(false);
  });
  it.each([["<a \" (an open quote in a name)", '<a "'.repeat(250_000)], ["<a ' (an open quote in a name)", "<a '".repeat(250_000)], ['<a x=" (an open value)', '<a x="'.repeat(166_000)], ["<a x=' (an open value)", "<a x='".repeat(166_000)], ['<a x=">"... (every > quoted)', '<a x=">"'.repeat(111_000)], ["<a x='>'... (every > quoted)", "<a x='>'".repeat(111_000)]])("scans a 1 MB blob of %s in linear time", (_name, blob) => {
    const started = performance.now();
    const out = markupTextOf(blob);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(out.length).toBeGreaterThan(0);
  });
  it.each([["a quote in an attribute name", '<a "'], ["an open single quote", "<a '"], ["an open value", '<a x="']])("still blanks a quoted > after 20,000 copies of %s", (_name, junk) => {
    expect(blanked(`${junk.repeat(20_000)}${"z".repeat(5_000)}\nhtml-spl<b title="x>y">it-0123456789`)).toBe(true);
  });
  it("scans 32 MB of open-quote junk in a few seconds", () => {
    const started = performance.now();
    markupTextOf('<a x="'.repeat(5_000_000));
    markupTextOf('<a "'.repeat(8_000_000));
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
