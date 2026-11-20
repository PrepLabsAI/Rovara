// TE-H1 slice 4: the capture program's video lines. It records only when its plan says so, prints a video only for a page that failed or showed errors, at most two and four MiB of them, drops every video
// when any page of its side was withheld for what it showed, and never prints more than its output bound.
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_EXECUTOR_VIDEO_OUTPUT_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BrowserEvidenceExecutorLineSchema,
  type BrowserEvidenceExecutorPlan,
} from "../../packages/contracts/src/index.js";
import { runCapture, type CaptureDeps } from "../../packages/verifier/src/executor/browser-evidence-entry.js";

const plan = (over: Partial<BrowserEvidenceExecutorPlan> = {}): BrowserEvidenceExecutorPlan => ({ port: 4321, readyPath: "/health", routes: ["/a", "/b", "/c"], maskSelectors: [], runMs: 30_000, pageMs: 15_000, ...over });
const jpeg = (size = 500, seed = 1) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed, 3); return bytes; };
const webm = (size = 800, seed = 9) => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed, 4); return bytes; };
type Capture = CaptureDeps["driver"]["capture"];
const run = async (planned: BrowserEvidenceExecutorPlan, capture: (route: string) => unknown) => {
  const asked: Array<{ route: string; video: unknown }> = [];
  const lines = await runCapture(planned, { waitReady: async () => "ready", driver: { capture: (async (_side, route, options) => { asked.push({ route, video: (options as { video?: unknown }).video }); return capture(route); }) as Capture } });
  return { lines, asked };
};
const shot = (lines: Awaited<ReturnType<typeof runCapture>>, route: string) => lines.find((line) => line.t === "shot" && line.route === route) as Record<string, unknown> | undefined;
const failing = (video?: Uint8Array) => ({ ok: false, reason: "page_did_not_load", ...(video === undefined ? {} : { video }) });

describe("the capture program with video", () => {

  it("prints a video for a failed page and a page with errors, and none for a healthy page or for a plan that did not ask", async () => {
    const answers: Record<string, unknown> = { "/a": failing(webm()), "/b": { ok: true, bytes: jpeg(), consoleErrors: 2, video: webm(800, 3) }, "/c": { ok: true, bytes: jpeg(), consoleErrors: 0, video: webm(800, 4) } };
    const { lines } = await run(plan({ video: true }), (route) => answers[route]);
    expect(typeof shot(lines, "/a")?.["videoBase64"]).toBe("string");
    expect(typeof shot(lines, "/b")?.["videoBase64"]).toBe("string");
    expect(Object.keys(shot(lines, "/c") ?? {})).not.toContain("videoBase64");
    for (const line of lines) expect(BrowserEvidenceExecutorLineSchema.safeParse(line).success).toBe(true);
    expect(Buffer.from(String(shot(lines, "/a")?.["videoBase64"]), "base64").equals(Buffer.from(webm()))).toBe(true);
    // Without the plan's `video`, a driver that hands one over is not believed.
    const off = await run(plan(), (route) => answers[route]);
    for (const route of ["/a", "/b", "/c"]) expect(Object.keys(shot(off.lines, route) ?? {})).not.toContain("videoBase64");
  });

  it("prints at most two videos and four MiB of them; the rest say over the size cap", async () => {
    const { lines } = await run(plan({ video: true, routes: ["/a", "/b", "/c"] }), (route) => failing(webm(1_000, route.charCodeAt(1))));
    expect(["/a", "/b", "/c"].map((route) => typeof shot(lines, route)?.["videoBase64"])).toEqual(["string", "string", "undefined"]);
    expect(shot(lines, "/c")?.["videoNotKept"]).toBe("over_size_cap");
  });

  it("holds one video to the 2 MiB cap and to being a WebM", async () => {
    const answers: Record<string, unknown> = { "/a": failing(webm(BROWSER_EVIDENCE_VIDEO_MAX_BYTES + 1)), "/b": failing(new TextEncoder().encode("not a video")), "/c": failing(webm(BROWSER_EVIDENCE_VIDEO_MAX_BYTES)) };
    const { lines } = await run(plan({ video: true }), (route) => answers[route]);
    expect(shot(lines, "/a")?.["videoNotKept"]).toBe("over_size_cap");
    expect(shot(lines, "/b")?.["videoNotKept"]).toBe("not_recorded");
    expect(typeof shot(lines, "/c")?.["videoBase64"]).toBe("string");
    const printed = lines.map((line) => Buffer.byteLength(JSON.stringify(line)) + 1).reduce((sum, size) => sum + size, 0);
    expect(printed).toBeLessThanOrEqual(BROWSER_EVIDENCE_EXECUTOR_VIDEO_OUTPUT_MAX_BYTES);
  });

  it("a driver that records nothing, or throws, leaves no video line and no invented reason (the runner says not recorded)", async () => {
    const { lines } = await run(plan({ video: true, routes: ["/a", "/b"] }), (route) => { if (route === "/b") throw new Error("secret /home/me"); return failing(); });
    expect(shot(lines, "/a")).toEqual({ t: "shot", route: "/a", ok: false, reason: "page_did_not_load" });
    expect(shot(lines, "/b")).toEqual({ t: "shot", route: "/b", ok: false, reason: "capture_failed" });
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("a page the driver calls withheld (a mask had to rewrite its text), healthy or not, drops every video of this side and is said in its own line", async () => {
    const answers: Record<string, unknown> = { "/a": failing(webm()), "/b": { ok: true, bytes: jpeg(), consoleErrors: 0, videoNotKept: "withheld" }, "/c": { ok: true, bytes: jpeg(), consoleErrors: 4, video: webm(800, 6) } };
    const { lines } = await run(plan({ video: true }), (route) => answers[route]);
    for (const route of ["/a", "/b", "/c"]) expect(Object.keys(shot(lines, route) ?? {}), route).not.toContain("videoBase64");
    expect(shot(lines, "/b")?.["videoNotKept"]).toBe("withheld");
    expect(shot(lines, "/a")?.["videoNotKept"]).toBe("withheld");
    expect(shot(lines, "/c")?.["videoNotKept"]).toBe("withheld");
    for (const line of lines) expect(BrowserEvidenceExecutorLineSchema.safeParse(line).success).toBe(true);
    // A plan that did not ask for video believes no such word from a driver.
    const off = await run(plan(), (route) => answers[route]);
    for (const route of ["/a", "/b", "/c"]) expect(Object.keys(shot(off.lines, route) ?? {}), route).not.toContain("videoNotKept");
  });
});
