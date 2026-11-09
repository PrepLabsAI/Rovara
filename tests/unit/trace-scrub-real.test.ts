// Proof and evidence B4 fix round 1 (Opus review C2): the trace scrub against a REAL Playwright trace. The fixture was recorded by tests/support/real-playwright-trace.ts (login with a JSON token answer, a
// localStorage token, a query-string token, a custom auth header, a bearer header, a cookie, and a page that shows the token); the same recording is made live when this host can launch Chromium.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { TRACE_BLANKED, scrubTrace } from "../../packages/verifier/src/executor/trace-scrub.js";
import { TRACE_SECRETS, recordRealTrace } from "../support/real-playwright-trace.js";

const FIXTURE = readFileSync("tests/fixtures/playwright-trace/real-trace.zip");
const live = await recordRealTrace();
const liveBefore = await recordRealTrace({ traceBeforeAuth: true });

/** Every entry of a zip, by name, as text (latin1 keeps bytes one for one). Read independently of the scrubber's own reader. */
function entriesOf(zip: Uint8Array): Map<string, string> {
  const view = Buffer.from(zip); const out = new Map<string, string>();
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
const whole = (zip: Uint8Array) => [...entriesOf(zip).entries()].filter(([name]) => !name.endsWith(".jpeg")).map(([, text]) => text).join("\n");
const redactor = () => createCredentialRedactor([{ profileId: "buyer", email: "buyer@example.test", password: TRACE_SECRETS.password }]);
/** What the executor tells its ledger for the round: the session cookie and the localStorage token. */
const registered = (...values: string[]) => { const r = redactor(); for (const value of values) r.addSessionSecret(value); return r; };

describe.each([["the committed fixture", FIXTURE], ...(live === undefined ? [] : [["a trace recorded now", live] as [string, Buffer]])])("scrubbing %s", (_name, trace) => {
  const secretsIn = (zip: Uint8Array) => Object.entries(TRACE_SECRETS).filter(([, value]) => whole(zip).includes(value)).map(([name]) => name);

  it("positive control: the raw trace really holds the login token, the bearer, the custom header, the query tokens, the cookie and the password", () => {
    expect(secretsIn(trace).sort()).toEqual(["customHeader", "loginIdToken", "loginRefreshToken", "password", "queryToken", "sessionCookie", "signedQuery"].sort());
  });

  it("removes every one of them, from every entry, in every spelling", () => {
    const out = scrubTrace(trace, (bytes) => redactor().contains(bytes));
    expect(out).not.toBeNull();
    expect(secretsIn(out!.zip)).toEqual([]);
    for (const value of Object.values(TRACE_SECRETS)) {
      for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")]) expect(whole(out!.zip), form).not.toContain(form);
    }
  });

  it("learns the login token and the custom header from the trace itself, with no help from the caller", () => {
    // The caller's scan knows only the account password; the id token, refresh token, query tokens, custom header and cookie come from harvesting.
    const out = scrubTrace(trace, (bytes) => redactor().contains(bytes))!;
    expect(out.stats.secrets).toBeGreaterThanOrEqual(6);
    expect(out.stats.droppedSnapshots).toBeGreaterThan(0);
    expect(out.stats.blankedResources).toBeGreaterThan(0);
  });

  it("drops the DOM snapshots that show the token and keeps the rest of the structure", () => {
    const before = entriesOf(trace).get("trace.trace")!.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    const after = entriesOf(scrubTrace(trace, (bytes) => redactor().contains(bytes))!.zip).get("trace.trace")!.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    const count = (lines: Array<{ type: string }>, type: string) => lines.filter((line) => line.type === type).length;
    expect(count(after, "frame-snapshot")).toBeLessThan(count(before, "frame-snapshot"));
    expect(count(after, "before")).toBe(count(before, "before"));
    expect(count(after, "context-options")).toBe(1);
    expect(entriesOf(scrubTrace(trace, (bytes) => redactor().contains(bytes))!.zip).get("trace.trace")).not.toContain(TRACE_SECRETS.loginIdToken);
  });

  it("keeps only allow-listed header values and blanks every query value and fragment, keeping the paths", () => {
    const out = entriesOf(scrubTrace(trace, (bytes) => redactor().contains(bytes))!.zip).get("trace.network")!.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { snapshot: { request: { url: string; headers: Array<{ name: string; value: string }>; cookies?: Array<{ value: string }> }; response: { headers: Array<{ name: string; value: string }> } } });
    const urls = out.map((entry) => entry.snapshot.request.url);
    expect(urls.some((url) => url.includes("/api/me?access_token=" + TRACE_BLANKED))).toBe(true);
    expect(urls.some((url) => url.includes("/asset.json?sig=" + TRACE_BLANKED) && !url.includes("#"))).toBe(true);
    for (const entry of out) {
      for (const header of [...entry.snapshot.request.headers, ...entry.snapshot.response.headers]) {
        const allowed = ["content-type", "content-length", "accept", "accept-encoding", "accept-language", "user-agent", "host", "date", "connection", "keep-alive", "transfer-encoding", "cache-control", "vary", "content-encoding", "x-request-id", "x-amzn-requestid"].includes(header.name.toLowerCase());
        if (!allowed) expect(header.value, header.name).toBe(TRACE_BLANKED);
      }
      for (const cookie of entry.snapshot.request.cookies ?? []) expect(cookie.value).toBe(TRACE_BLANKED);
    }
    // the names stay, so a reader sees which headers were sent
    expect(out[2]!.snapshot.request.headers.map((header) => header.name)).toContain("x-session");
    expect(out[2]!.snapshot.request.headers.map((header) => header.name)).toContain("authorization");
  });

  it("blanks the request body that carried the password and the login answer, and keeps harmless bodies", () => {
    const original = entriesOf(trace);
    const out = entriesOf(scrubTrace(trace, (bytes) => redactor().contains(bytes))!.zip);
    const blobs = [...out.entries()].filter(([name]) => name.startsWith("resources/"));
    expect(blobs.some(([, text]) => text === TRACE_BLANKED)).toBe(true);
    expect(blobs.some(([, text]) => text === JSON.stringify({ name: "buyer" }))).toBe(true);
    // every entry is kept except the screencast frames that showed the token (dropped with their frames)
    const kept = [...out.keys()];
    expect(kept.filter((name) => !name.startsWith("screencast/"))).toEqual([...original.keys()].filter((name) => !name.startsWith("screencast/")));
    // Which frames could show the token, worked out here apart from the scrubber: on a page whose DOM snapshot shows a round secret, every frame after that page's last clean snapshot.
    // A frame before it is a picture of a page whose DOM held no secret, so it is kept.
    const events = original.get("trace.trace")!.split("\n").filter(Boolean).map((line) => ({ line, event: JSON.parse(line) as { type?: string; pageId?: string; timestamp?: number; file?: string; snapshot?: { pageId?: string; timestamp?: number } } }));
    const roundSecrets = Object.entries(TRACE_SECRETS).filter(([name]) => name !== "password").map(([, value]) => value);
    const snapshots = events.filter(({ event }) => event.type === "frame-snapshot").map(({ line, event }) => ({ page: event.snapshot!.pageId!, time: event.snapshot!.timestamp!, secret: roundSecrets.some((value) => line.includes(value)) }));
    const cleanSince = new Map<string, number>();
    for (const page of new Set(snapshots.filter((item) => item.secret).map((item) => item.page))) {
      const ofPage = snapshots.filter((item) => item.page === page).sort((a, b) => a.time - b.time);
      const firstHit = ofPage.findIndex((item) => item.secret);
      cleanSince.set(page, firstHit > 0 ? ofPage[firstHit - 1]!.time : Number.NEGATIVE_INFINITY);
    }
    expect(cleanSince.size, "positive control: a DOM snapshot shows the token").toBeGreaterThan(0);
    const frames = events.filter(({ event }) => event.type === "screencast-frame").map(({ event }) => event);
    const mayShow = new Set(frames.filter((frame) => cleanSince.has(frame.pageId!) && frame.timestamp! > cleanSince.get(frame.pageId!)!).map((frame) => frame.file!));
    const screencastsBefore = [...original.keys()].filter((name) => name.startsWith("screencast/"));
    expect(kept.filter((name) => name.startsWith("screencast/"))).toEqual(screencastsBefore.filter((name) => !mayShow.has(name)));
    // The committed fixture holds two frames taken after the token appeared, so it proves a drop really happens. A trace recorded now, on a loaded host, may hold none in that window (the screencast lags): then nothing is dropped, and nothing showed the token.
    if (trace === FIXTURE) expect(kept.length).toBeLessThan(original.size);
  });

  it("writes a zip with no external attributes, no extra fields, and the same names in the same order", () => {
    const zip = Buffer.from(scrubTrace(trace, (bytes) => redactor().contains(bytes))!.zip);
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const count = zip.readUInt16LE(eocd + 10); let at = zip.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      expect(zip.readUInt32LE(at + 38), "external attributes").toBe(0);
      expect(zip.readUInt16LE(at + 30), "extra length").toBe(0);
      const nameLength = zip.readUInt16LE(at + 28); names.push(zip.toString("utf8", at + 46, at + 46 + nameLength)); at += 46 + nameLength;
    }
    const original = [...entriesOf(trace).keys()];
    expect(names.every((name) => original.includes(name))).toBe(true);
    expect(names).toEqual(original.filter((name) => names.includes(name)));
  });
});

describe("the order of authentication and tracing (the localStorage token)", () => {
  it.skipIf(live === undefined || liveBefore === undefined)("a trace started AFTER the auth is applied never records the localStorage token, and one started BEFORE records it in the init script", () => {
    expect(whole(live!)).not.toContain(TRACE_SECRETS.localStorageToken);
    expect(whole(liveBefore!)).toContain(TRACE_SECRETS.localStorageToken);
  });

  it.skipIf(liveBefore === undefined)("even a trace started in the wrong order loses the token once the round's secrets are registered (every cookie and localStorage value)", () => {
    const out = scrubTrace(liveBefore!, (bytes) => registered(TRACE_SECRETS.localStorageToken, TRACE_SECRETS.sessionCookie).contains(bytes))!;
    expect(whole(out.zip)).not.toContain(TRACE_SECRETS.localStorageToken);
    expect(whole(out.zip)).not.toContain(TRACE_SECRETS.sessionCookie);
  });

  it.skipIf(liveBefore === undefined)("positive control: with the localStorage token NOT registered, the wrong-order trace is not scrubbed of it by the structural rules alone", () => {
    const out = scrubTrace(liveBefore!, (bytes) => redactor().contains(bytes))!;
    expect(whole(out.zip)).toContain(TRACE_SECRETS.localStorageToken);
  });

  it("the committed fixture was recorded in the right order", () => {
    expect(whole(FIXTURE)).not.toContain(TRACE_SECRETS.localStorageToken);
  });
});

describe("the executor's case adapter orders authentication before tracing (C2)", () => {
  it("applies the approved authentication to the owned context before it starts the trace, and registers the round's cookies and localStorage values whenever media can be kept", () => {
    const source = readFileSync("packages/verifier/src/web-runtime.ts", "utf8");
    const applied = source.indexOf("await ports.applyToOwnedBrowserContext(session.sessionRef, context, operationSignal);");
    const started = source.indexOf("tracing = await startWebCaseTrace({ media: ports.media, context });");
    expect(applied).toBeGreaterThan(0);
    expect(started).toBeGreaterThan(applied);
    const host = readFileSync("packages/verifier/src/executor/host.ts", "utf8");
    expect(host).toMatch(/if \(screenshots \|\| mediaWanted\) \{[\s\S]*registerSessionSecret\(cookie\.value\)[\s\S]*registerSessionSecret\(entry\.value\)/u);
    // `mediaWanted` is video OR traces (a round with traces on and video and screenshots off must still register the round's secrets)
    expect(host).toMatch(/const mediaWanted = [^;]*capture\.video === true \|\| [^;]*capture\.traces === true;/u);
  });
});
