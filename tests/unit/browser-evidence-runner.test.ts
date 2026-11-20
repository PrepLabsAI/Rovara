
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

  it("checks the time before every page: a page reached after the limit is never opened", async () => {
    let clock = 0;
    const { driver, calls } = fakeDriver({ capture: () => { clock += 60_000; return undefined; } });
    const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b", "/c"], driver, now: () => clock, limits: { runMs: 100_000 } });
    expect(calls.filter((c) => c.op === "capture").map((c) => `${c.side}${c.route ?? ""}`)).toEqual(["before/a", "before/b"]);
    expect(got.routes.map((r) => (r.status === "shown" ? "shown" : r.reason))).toEqual(["time_limit", "time_limit", "time_limit"]);
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

  it("an app whose start answers only after the run gave up on it is still stopped once it answers", async () => {
    const calls: string[] = [];
    let finishStart: (value: "ready") => void = () => undefined;
    const driver: BrowserEvidenceDriver = {
      startApp(side) { calls.push(`start:${side}`); return new Promise((resolve) => { finishStart = resolve; }); },
      async capture() { calls.push("capture"); return { ok: false, reason: "page_did_not_load" }; },
      async stopApp(side) { calls.push(`stop:${side}`); },
    };
    const got = await runBrowserEvidence({ ...base, routes: ["/a"], driver, limits: { runMs: 50 } });
    expect(got.notRun).toBe("app_did_not_start");
    expect(calls).toEqual(["start:before", "stop:before"]);
    finishStart("ready");
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(calls).toEqual(["start:before", "stop:before", "stop:before"]);
  });

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
