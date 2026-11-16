// TE-H1 slice 4: the runner's video rules over a fake driver. A video is asked for only on the candidate's side and only when the run says video is wanted (the recipe's fixture-data choice); it is kept only
// for a page that failed or showed errors after the change; it is held to the WebM check, the per-video and per-run caps and the credential scan; and ONE page withheld for what it showed (either side)
// takes every video of the run with it, because a page that showed a secret in a recipe that says "fixture data only" means the recording cannot be trusted either.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES } from "../../packages/contracts/src/browser-evidence.js";
import { runBrowserEvidence, type BrowserEvidenceDriver, type BrowserEvidenceSide } from "../../packages/verifier/src/executor/browser-evidence.js";

const jpegOf = (seed: string, size = 2_000) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0) || 1, 3); return bytes; };
const webmOf = (seed: string, size = 5_000) => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed.charCodeAt(0) || 1, 4); return bytes; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Answer = Record<string, unknown>;
function fakeDriver(answer: (side: BrowserEvidenceSide, route: string) => Answer | undefined) {
  const asked: Array<{ side: BrowserEvidenceSide; route: string; video: unknown }> = [];
  const driver: BrowserEvidenceDriver = {
    async startApp() { return "ready"; },
    async stopApp() { /* nothing */ },
    async capture(side, route, options) {
      asked.push({ side, route, video: (options as { video?: unknown }).video });
      return (answer(side, route) ?? { ok: true, bytes: jpegOf(`${side}${route}`), consoleErrors: 0 }) as never;
    },
  };
  return { driver, asked };
}
const base = { isolation: "sandbox" as const, notShown: [], moreNotShown: 0, maskSelectors: [...BROWSER_EVIDENCE_DEFAULT_MASK_SELECTORS] };
const failing = (video?: Uint8Array, extra: Answer = {}): Answer => ({ ok: false, reason: "page_did_not_load", ...(video === undefined ? {} : { video }), ...extra });

describe("runBrowserEvidence with video on failure", () => {
  it("asks for a video only on the candidate's side, and only when the run says video is wanted", async () => {
    const wanted = fakeDriver(() => undefined);
    await runBrowserEvidence({ ...base, routes: ["/a"], driver: wanted.driver, video: true });
    expect(wanted.asked.map((row) => [row.side, row.video])).toEqual([["before", undefined], ["after", true]]);
    const off = fakeDriver(() => undefined);
    await runBrowserEvidence({ ...base, routes: ["/a"], driver: off.driver });
    expect(off.asked.map((row) => row.video)).toEqual([undefined, undefined]);
  });

  it("keeps the video of a page that failed after the change, and of a page with errors after it; never the video of a healthy page", async () => {
    const { driver } = fakeDriver((side, route) => {
      if (side === "before") return undefined;
      if (route === "/broken") return failing(webmOf("a"));
      if (route === "/noisy") return { ok: true, bytes: jpegOf("n"), consoleErrors: 3, video: webmOf("b") };
      return { ok: true, bytes: jpegOf("h"), consoleErrors: 0, video: webmOf("c") };
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/broken", "/noisy", "/healthy"], driver, video: true });
    const byRoute = Object.fromEntries(got.routes.map((row) => [row.route, row]));
    expect(byRoute["/broken"]).toMatchObject({ status: "not_run", reason: "page_did_not_load", video: { sha256: sha(webmOf("a")) } });
    expect(byRoute["/noisy"]).toMatchObject({ status: "shown", video: { sha256: sha(webmOf("b")) } });
    expect(Object.keys(byRoute["/healthy"] ?? {})).not.toContain("video");
    expect(Object.keys(byRoute["/healthy"] ?? {})).not.toContain("videoNotKept");
  });

  it("a video is never kept when the run did not ask for one, even if a driver hands one over", async () => {
    const { driver } = fakeDriver((side) => (side === "after" ? failing(webmOf("a")) : undefined));
    const got = await runBrowserEvidence({ ...base, routes: ["/a"], driver });
    expect(got.routes[0]).toEqual({ route: "/a", status: "not_run", reason: "page_did_not_load" });
  });

  it("a page that failed on the base code has no candidate capture and so no video", async () => {
    const { driver, asked } = fakeDriver((side) => (side === "before" ? failing() : undefined));
    const got = await runBrowserEvidence({ ...base, routes: ["/new-page"], driver, video: true });
    expect(asked.filter((row) => row.side === "after")).toEqual([]);
    expect(got.routes[0]).toEqual({ route: "/new-page", status: "not_run", reason: "page_did_not_load" });
  });

  it("a failed page whose recording is missing or says why not carries the fixed reason, never a guess", async () => {
    const { driver } = fakeDriver((side, route) => {
      if (side === "before") return undefined;
      if (route === "/none") return failing();
      if (route === "/says") return failing(undefined, { videoNotKept: "not_recorded" });
      return failing(undefined, { videoNotKept: "my own words" });
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/none", "/says", "/odd"], driver, video: true });
    expect(got.routes.map((row) => (row as { videoNotKept?: string }).videoNotKept)).toEqual(["not_recorded", "not_recorded", "not_recorded"]);
  });

  it("holds a video to being a WebM, within 2 MiB, with no credential in its bytes", async () => {
    const secret = "hunter2-secret";
    const { driver } = fakeDriver((side, route) => {
      if (side === "before") return undefined;
      if (route === "/text") return failing(new TextEncoder().encode("not a video"));
      if (route === "/big") return failing(webmOf("a", BROWSER_EVIDENCE_VIDEO_MAX_BYTES + 1));
      if (route === "/secret") { const bytes = webmOf("a"); bytes.set(new TextEncoder().encode(secret), 100); return failing(bytes); }
      return failing(webmOf("z"));
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/text", "/big", "/secret", "/ok"], driver, video: true, redactor: { contains: (bytes) => Buffer.from(bytes).includes(Buffer.from(secret)) } });
    const note = (route: string) => (got.routes.find((row) => row.route === route) as { videoNotKept?: string; video?: unknown });
    expect(note("/text").videoNotKept).toBe("not_recorded");
    expect(note("/big").videoNotKept).toBe("over_size_cap");
    expect(note("/secret").videoNotKept).toBe("withheld");
    expect(note("/ok").video).toBeDefined();
  });

  it("a redactor that throws withholds the video (fail closed)", async () => {
    const { driver } = fakeDriver((side) => (side === "after" ? failing(webmOf("a")) : undefined));
    // (A scan that throws on a picture withholds the page; this one throws only on a recording, so the page itself is shown.)
    const got = await runBrowserEvidence({ ...base, routes: ["/a"], driver, video: true, redactor: { contains: (bytes) => { if (bytes[0] === 0x1a) throw new Error("boom"); return false; } } });
    expect(got.routes[0]).toMatchObject({ videoNotKept: "withheld" });
  });

  it("keeps at most two videos and four MiB of video in a run: the rest say over the size cap", async () => {
    const { driver } = fakeDriver((side, route) => (side === "after" ? failing(webmOf(route.slice(-1), 1_000)) : undefined));
    const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b", "/c"], driver, video: true });
    expect(got.routes.map((row) => (row as { video?: unknown }).video !== undefined)).toEqual([true, true, false]);
    expect(got.routes[2]).toMatchObject({ videoNotKept: "over_size_cap" });
    // Exactly the run's video budget (two videos at the per-video cap) is kept, whole.
    const full = fakeDriver((side, route) => (side === "after" ? failing(webmOf(route.slice(-1), BROWSER_EVIDENCE_VIDEO_MAX_BYTES)) : undefined));
    const two = await runBrowserEvidence({ ...base, routes: ["/a", "/b"], driver: full.driver, video: true });
    expect(two.routes.map((row) => (row as { video?: unknown }).video !== undefined)).toEqual([true, true]);
    expect(BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES).toBe(2 * BROWSER_EVIDENCE_VIDEO_MAX_BYTES);
  });

  it("ONE page withheld for what it showed, on either side, takes every video of the run with it", async () => {
    for (const maskedSide of ["before", "after"] as const) {
      const { driver } = fakeDriver((side, route) => {
        if (route === "/leaky" && side === maskedSide) return { ok: false, reason: "masked_content" };
        if (side === "after" && route === "/broken") return failing(webmOf("a"));
        return undefined;
      });
      const got = await runBrowserEvidence({ ...base, routes: ["/broken", "/leaky"], driver, video: true });
      const broken = got.routes.find((row) => row.route === "/broken") as { video?: unknown; videoNotKept?: string };
      expect(broken.video, maskedSide).toBeUndefined();
      expect(broken.videoNotKept, maskedSide).toBe("withheld");
      expect(got.routes.find((row) => row.route === "/leaky")).toEqual({ route: "/leaky", status: "not_run", reason: "masked_content" });
    }
    // Positive control: without the leaky page the same video is kept.
    const { driver } = fakeDriver((side, route) => (side === "after" && route === "/broken" ? failing(webmOf("a")) : undefined));
    const got = await runBrowserEvidence({ ...base, routes: ["/broken"], driver, video: true });
    expect((got.routes[0] as { video?: unknown }).video).toBeDefined();
  });

  it("a picture caught by the credential scan counts as a page withheld for what it showed", async () => {
    const { driver } = fakeDriver((side, route) => {
      if (side === "after" && route === "/broken") return failing(webmOf("a"));
      if (side === "after" && route === "/shown") { const bytes = jpegOf("s"); bytes.set(new TextEncoder().encode("hunter2-secret"), 50); return { ok: true, bytes, consoleErrors: 0 }; }
      return undefined;
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/broken", "/shown"], driver, video: true, redactor: { contains: (bytes) => Buffer.from(bytes).includes(Buffer.from("hunter2-secret")) } });
    expect(got.routes.find((row) => row.route === "/shown")).toMatchObject({ reason: "masked_content" });
    expect(got.routes.find((row) => row.route === "/broken")).toMatchObject({ videoNotKept: "withheld" });
  });

  it("a page that ran out of time, or could not be photographed, keeps no recording even if the driver hands one over: its text was never read and verified", async () => {
    for (const reason of ["time_limit", "capture_failed"] as const) {
      const { driver } = fakeDriver((side) => (side === "after" ? { ok: false, reason, video: webmOf("a") } : undefined));
      const got = await runBrowserEvidence({ ...base, routes: ["/slow"], driver, video: true });
      expect(got.routes[0], reason).toEqual({ route: "/slow", status: "not_run", reason });
    }
  });

  it("a page the driver calls withheld (a mask had to rewrite its text), healthy or not, takes every video of the run with it", async () => {
    const { driver } = fakeDriver((side, route) => {
      if (side === "before") return undefined;
      if (route === "/broken") return failing(webmOf("a"));
      if (route === "/noisy") return { ok: true, bytes: jpegOf("n"), consoleErrors: 2, video: webmOf("b") };
      // A healthy page (no errors, so its own recording would be dropped anyway) whose text a mask had to rewrite.
      return { ok: true, bytes: jpegOf("h"), consoleErrors: 0, videoNotKept: "withheld" };
    });
    const got = await runBrowserEvidence({ ...base, routes: ["/broken", "/noisy", "/email"], driver, video: true });
    const row = (route: string) => got.routes.find((entry) => entry.route === route) as { status: string; video?: unknown; videoNotKept?: string };
    expect(row("/broken")).toMatchObject({ videoNotKept: "withheld" });
    expect(row("/noisy")).toMatchObject({ status: "shown", videoNotKept: "withheld" });
    expect(Object.keys(row("/email"))).not.toContain("videoNotKept");
    expect(row("/broken").video).toBeUndefined();
    expect(row("/noisy").video).toBeUndefined();
    // Positive control: the same run without the page that said so keeps both.
    const clean = fakeDriver((side, route) => (side === "after" && route === "/broken" ? failing(webmOf("a")) : side === "after" && route === "/noisy" ? { ok: true, bytes: jpegOf("n"), consoleErrors: 2, video: webmOf("b") } : undefined));
    const kept = await runBrowserEvidence({ ...base, routes: ["/broken", "/noisy"], driver: clean.driver, video: true });
    expect(kept.routes.map((entry) => (entry as { video?: unknown }).video !== undefined)).toEqual([true, true]);
  });

  it("a run without video is the run it was: no video key on any page, whatever the pages did", async () => {
    const { driver } = fakeDriver((side, route) => (side === "after" && route === "/b" ? failing() : undefined));
    const got = await runBrowserEvidence({ ...base, routes: ["/a", "/b"], driver });
    for (const row of got.routes) { expect(Object.keys(row)).not.toContain("video"); expect(Object.keys(row)).not.toContain("videoNotKept"); }
  });
});
