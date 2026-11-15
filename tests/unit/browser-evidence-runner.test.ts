// TE-H1 slice 1: the browser-evidence runner over a fake driver. Before (the base code) and after (the candidate) for each picked route, inside one time limit and one byte
// budget, with the e2e screenshot cap, the credential scan, and the app always stopped. A page that cannot be shown is "Not run" with a fixed reason, never a guess.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, BROWSER_EVIDENCE_TOTAL_MAX_BYTES } from "../../packages/contracts/src/browser-evidence.js";
import { BROWSER_EVIDENCE_STOP_MS, runBrowserEvidence, type BrowserEvidenceDriver, type BrowserEvidenceSide } from "../../packages/verifier/src/executor/browser-evidence.js";

const jpegOf = (seed: string, size = 2_000) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  const body = new TextEncoder().encode(seed);
  for (let i = 3; i < size; i += 1) bytes[i] = body[i % body.length]!;
  return bytes;
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Call = { op: "start" | "stop" | "capture"; side: BrowserEvidenceSide; route?: string; masks?: readonly string[]; timeoutMs?: number };
function fakeDriver(over: Partial<{ start: (side: BrowserEvidenceSide) => unknown; capture: (side: BrowserEvidenceSide, route: string) => unknown }> = {}) {
  const calls: Call[] = [];
  const driver: BrowserEvidenceDriver = {
    async startApp(side, options) { calls.push({ op: "start", side, timeoutMs: options.timeoutMs }); return (over.start?.(side) ?? "ready") as never; },
    async stopApp(side) { calls.push({ op: "stop", side }); },
    async capture(side, route, options) {
      calls.push({ op: "capture", side, route, masks: options.maskSelectors, timeoutMs: options.timeoutMs });
      const answer = over.capture?.(side, route);
      return (answer === undefined ? { ok: true, bytes: jpegOf(`${side}${route}`), consoleErrors: side === "after" ? 1 : 0 } : answer) as never;
    },
  };
  return { driver, calls };
}
const base = { isolation: "sandbox" as const, notShown: [], moreNotShown: 0, maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS] };

describe("runBrowserEvidence", () => {
  it("photographs every route on the base code, then on the candidate, with the masks, and stops the app each time", async () => {
    const { driver, calls } = fakeDriver();
    const got = await runBrowserEvidence({ ...base, routes: ["/checkout", "/settings"], driver });
    expect(calls.map((c) => `${c.op}:${c.side}${c.route ?? ""}`)).toEqual(["start:before", "capture:before/checkout", "capture:before/settings", "stop:before", "start:after", "capture:after/checkout", "capture:after/settings", "stop:after"]);
    for (const call of calls.filter((c) => c.op === "capture")) expect(call.masks).toEqual(base.maskSelectors);
    expect(got.routes).toEqual([
      { route: "/checkout", status: "shown", before: { sha256: sha(jpegOf("before/checkout")), bytes: jpegOf("before/checkout") }, after: { sha256: sha(jpegOf("after/checkout")), bytes: jpegOf("after/checkout") }, consoleErrors: { before: 0, after: 1 } },
      { route: "/settings", status: "shown", before: { sha256: sha(jpegOf("before/settings")), bytes: jpegOf("before/settings") }, after: { sha256: sha(jpegOf("after/settings")), bytes: jpegOf("after/settings") }, consoleErrors: { before: 0, after: 1 } },
    ]);
    expect(got.isolation).toBe("sandbox");
    expect(got.notRun).toBeUndefined();
  });

  it("always passes the default masks, even when the caller hands fewer", async () => {
    const { driver, calls } = fakeDriver();
    await runBrowserEvidence({ ...base, maskSelectors: [".iban"], routes: ["/a"], driver });
    for (const call of calls.filter((c) => c.op === "capture")) expect(call.masks).toEqual([...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, ".iban"]);
  });

  it("a page that does not load on either side is Not run for that route only", async () => {
    const { driver } = fakeDriver({ capture: (side, route) => (side === "after" && route === "/b" ? { ok: false, reason: "page_did_not_load" } : undefined) });
    const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b"], driver });
    expect(got.routes.map((r) => r.status)).toEqual(["shown", "not_run"]);
    expect(got.routes[1]).toEqual({ route: "/b", status: "not_run", reason: "page_did_not_load" });
  });

  it("drops a screenshot over the e2e cap, one that is not a JPEG, and one that carries a credential; the pair's other image is dropped too", async () => {
    const over = jpegOf("x", BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES + 1);
    const atCap = jpegOf("y", BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const secret = jpegOf("SECRET-VALUE");
    const { driver } = fakeDriver({ capture: (side, route) => side === "after" ? ({ "/over": { ok: true, bytes: over, consoleErrors: 0 }, "/cap": { ok: true, bytes: atCap, consoleErrors: 0 }, "/png": { ok: true, bytes: png, consoleErrors: 0 }, "/secret": { ok: true, bytes: secret, consoleErrors: 0 } } as Record<string, unknown>)[route] : undefined });
    const contains = (bytes: Uint8Array) => Buffer.from(bytes).includes("SECRET-VALUE");
    const got = await runBrowserEvidence({ ...base, routes: ["/over", "/cap", "/png", "/secret"], driver, redactor: { contains } });
    expect(got.routes.map((r) => (r.status === "shown" ? "shown" : r.reason))).toEqual(["over_size_cap", "shown", "capture_failed", "masked_content"]);
    expect(JSON.stringify(got.routes.filter((r) => r.status === "not_run"))).not.toMatch(/bytes|sha256/u);
  });

  it("keeps the whole run inside one byte budget: the route that would pass it is Not run", async () => {
    const big = (side: BrowserEvidenceSide, route: string) => ({ ok: true, bytes: jpegOf(`${side}${route}`, BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES), consoleErrors: 0 });
    const { driver } = fakeDriver({ capture: big });
    const got = await runBrowserEvidence({ ...base, routes: ["/1", "/2", "/3", "/4", "/5"], driver });
    const kept = got.routes.filter((r) => r.status === "shown");
    expect(kept.length * 2 * BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES).toBeLessThanOrEqual(BROWSER_EVIDENCE_TOTAL_MAX_BYTES);
    expect(got.routes.at(-1)).toEqual({ route: "/5", status: "not_run", reason: "over_size_cap" });
    const small = await runBrowserEvidence({ ...base, routes: ["/1", "/2"], driver: fakeDriver({ capture: big }).driver, limits: { totalBytes: 3 * BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES } });
    expect(small.routes.map((r) => r.status)).toEqual(["shown", "not_run"]);
  });

  it("an app that does not start is Not run for every route, nothing is captured, and the app is still stopped", async () => {
    for (const start of [() => "app_did_not_start", () => { throw new Error("spawn ENOENT /home/ada/secret"); }, () => "weird"]) {
      const { driver, calls } = fakeDriver({ start: (side) => (side === "before" ? start() : "ready") });
      const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b"], driver });
      expect(got.notRun).toBe("app_did_not_start");
      expect(got.routes).toEqual([]);
      expect(calls.filter((c) => c.op === "capture")).toEqual([]);
      expect(calls.filter((c) => c.op === "stop").map((c) => c.side)).toEqual(["before"]);
      expect(JSON.stringify(got)).not.toContain("secret");
    }
  });

  it("stops at the run's time limit: later routes are Not run (time limit) and never opened; each page gets at most what is left", async () => {
    let clock = 0;
    const { driver, calls } = fakeDriver({ capture: () => { clock += 40_000; return undefined; } });
    const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b", "/c"], driver, now: () => clock, limits: { runMs: 100_000, pageMs: 15_000 } });
    expect(got.routes.map((r) => (r.status === "shown" ? "shown" : r.reason))).toEqual(["time_limit", "time_limit", "time_limit"]);
    expect(calls.filter((c) => c.op === "capture").length).toBeLessThanOrEqual(3);
    for (const call of calls.filter((c) => c.op === "capture" || c.op === "start")) expect(call.timeoutMs).toBeLessThanOrEqual(100_000);
    expect(calls.filter((c) => c.op === "stop").length).toBe(calls.filter((c) => c.op === "start").length);
  });

  it("a driver that throws or answers nonsense is capture_failed, with no echo of its error, and the app is still stopped", async () => {
    for (const answer of [() => { throw new Error("net::ERR at https://user:pw@host/"); }, () => ({ ok: true, bytes: "not bytes" }), () => null, () => ({ ok: false, reason: "my own words" }), () => ({ ok: true, bytes: jpegOf("z"), consoleErrors: -1 })]) {
      const { driver, calls } = fakeDriver({ capture: (side) => (side === "after" ? answer() : undefined) });
      const got = await runBrowserEvidence({ ...base, routes: ["/a"], driver });
      expect(got.routes).toEqual([{ route: "/a", status: "not_run", reason: "capture_failed" }]);
      expect(JSON.stringify(got)).not.toMatch(/pw@|my own words/u);
      expect(calls.filter((c) => c.op === "stop").map((c) => c.side)).toEqual(["before", "after"]);
    }
  });

  it("a driver that never answers cannot hold the run: the page is Not run (time limit) at the page's time, and the app is still stopped, within a bound", async () => {
    const calls: string[] = [];
    const never = <T>() => new Promise<T>(() => undefined);
    const driver: BrowserEvidenceDriver = {
      async startApp(side) { calls.push(`start:${side}`); return "ready"; },
      capture() { calls.push("capture"); return never(); },
      stopApp(side) { calls.push(`stop:${side}`); return never(); },
    };
    const started = Date.now();
    const got = await runBrowserEvidence({ ...base, routes: ["/a"], driver, limits: { pageMs: 50 } });
    expect(got.routes).toEqual([{ route: "/a", status: "not_run", reason: "time_limit" }]);
    expect(calls).toEqual(["start:before", "capture", "stop:before"]);
    expect(Date.now() - started).toBeLessThan(BROWSER_EVIDENCE_STOP_MS + 5_000);
    const hungStart: BrowserEvidenceDriver = { startApp: () => never(), capture: () => never(), async stopApp() { calls.push("stopped"); } };
    expect((await runBrowserEvidence({ ...base, routes: ["/a"], driver: hungStart, limits: { runMs: 50 } })).notRun).toBe("app_did_not_start");
    expect(calls.at(-1)).toBe("stopped");
  }, 30_000);

  it("refuses input it was not built for instead of trimming it", async () => {
    const { driver } = fakeDriver();
    await expect(runBrowserEvidence({ ...base, routes: ["/1", "/2", "/3", "/4", "/5", "/6"], driver })).rejects.toThrow("browser evidence input is not valid");
    await expect(runBrowserEvidence({ ...base, routes: ["checkout"], driver })).rejects.toThrow("browser evidence input is not valid");
    await expect(runBrowserEvidence({ ...base, isolation: "imported" as never, routes: ["/a"], driver })).rejects.toThrow("browser evidence input is not valid");
    await expect(runBrowserEvidence({ ...base, moreNotShown: 1_000_001, routes: ["/a"], driver })).rejects.toThrow("browser evidence input is not valid");
    await expect(runBrowserEvidence({ ...base, notShown: [{ route: "/x", reason: "because" as never }], routes: ["/a"], driver })).rejects.toThrow("browser evidence input is not valid");
    await expect(runBrowserEvidence({ ...base, maskSelectors: Array.from({ length: 21 }, (_, i) => `.m${i}`), routes: ["/a"], driver })).rejects.toThrow("browser evidence input is not valid");
  });
});
