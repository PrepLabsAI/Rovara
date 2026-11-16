// TE-H1 slice 2 (DEC 241): the wire contract. The chunked callback's single upload (checked whole before anything is kept), the worker feature and the invocation field, the download rule for a v2 pack's pairs,
// the pack read back as the outcome the pull request's text lines are written from, and the capture program's plan.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, WorkerInvocationSchema } from "../../packages/contracts/src/protocol.js";
import {
  BROWSER_EVIDENCE_FEATURE, BROWSER_EVIDENCE_NOT_ON_CLOUD, BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES, BROWSER_EVIDENCE_UPLOAD_MAX_BYTES, BrowserEvidenceExecutorLineSchema, browserEvidenceOutcomeOfPack,
  browserEvidencePanelOf, browserEvidenceServableImages, decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceUpload, encodeBrowserEvidenceExecutorPlan, encodeBrowserEvidenceUpload, servableBrowserEvidenceImage,
} from "../../packages/contracts/src/browser-evidence-wire.js";
import { BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, BROWSER_EVIDENCE_TOTAL_MAX_BYTES, addBrowserEvidenceToPack, browserEvidenceLines, type BrowserEvidenceCaptured, type BrowserEvidenceOutcome } from "../../packages/contracts/src/browser-evidence.js";
import { EvidencePackV2Schema, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const shot = (seed: string, size = 500) => { const bytes = jpeg(seed, size); return { bytes, sha256: sha(bytes) }; };
const captured = (): BrowserEvidenceCaptured => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [{ route: "/users/[id]", reason: "dynamic_route" }], moreNotShown: 0,
  routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 2 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }],
});

describe("the browser-evidence upload", () => {
  it("round-trips a run: the same routes, the same bytes, the same digests, and not a byte more", () => {
    const bytes = encodeBrowserEvidenceUpload(captured());
    const back = decodeBrowserEvidenceUpload(bytes);
    expect(back).toEqual(captured());
    // Every bound is the run's own: 4 MiB of pictures and a small header.
    expect(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES).toBe(BROWSER_EVIDENCE_TOTAL_MAX_BYTES + BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES);
    expect(bytes.byteLength).toBeLessThan(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES);
  });

  it("refuses a run that did not happen only when it says so, and carries its reason", () => {
    const none: BrowserEvidenceCaptured = { isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "no_changed_page" };
    expect(decodeBrowserEvidenceUpload(encodeBrowserEvidenceUpload(none))).toEqual(none);
  });

  it("refuses every malformed byte string with one fixed sentence and returns nothing of it", () => {
    const good = encodeBrowserEvidenceUpload(captured());
    const mutate = (change: (copy: Uint8Array) => Uint8Array) => () => decodeBrowserEvidenceUpload(change(Uint8Array.from(good)));
    const sentence = "browser evidence upload is not valid";
    expect(mutate((copy) => { copy[0] = 0x58; return copy; })).toThrow(sentence);          // magic
    expect(mutate((copy) => copy.subarray(0, copy.byteLength - 1))).toThrow(sentence);     // a picture cut short
    expect(mutate((copy) => { const longer = new Uint8Array(copy.byteLength + 1); longer.set(copy); return longer; })).toThrow(sentence); // a byte nobody checked
    expect(mutate((copy) => { new DataView(copy.buffer).setUint32(4, BROWSER_EVIDENCE_UPLOAD_HEADER_MAX_BYTES + 1, false); return copy; })).toThrow(sentence); // header too long
    expect(mutate((copy) => { new DataView(copy.buffer).setUint32(4, 0, false); return copy; })).toThrow(sentence);
    expect(() => decodeBrowserEvidenceUpload(new Uint8Array(3))).toThrow(sentence);
    expect(() => decodeBrowserEvidenceUpload(new Uint8Array(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES + 1))).toThrow(sentence);
    expect(() => decodeBrowserEvidenceUpload("RBE1" as unknown as Uint8Array)).toThrow(sentence);
  });

  it("holds every picture to the screenshot cap and the whole run to its 4 MiB, on the way in and on the way out", () => {
    const big = shot("c", BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES + 1);
    expect(() => encodeBrowserEvidenceUpload({ ...captured(), routes: [{ route: "/a", status: "shown", before: big, after: shot("b"), consoleErrors: { before: 0, after: 0 } }] })).toThrow();
    const full = (n: number) => Array.from({ length: n }, (_, index) => ({ route: `/p${String(index)}`, status: "shown" as const, before: shot(String(index), BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES), after: shot(String(index + 5), BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES), consoleErrors: { before: 0, after: 0 } }));
    // 4 routes x 2 x 512 KiB = 4 MiB: exactly the budget; the fifth route would pass it.
    expect(() => encodeBrowserEvidenceUpload({ ...captured(), routes: full(4), notShown: [] })).not.toThrow();
    expect(() => encodeBrowserEvidenceUpload({ ...captured(), routes: full(5), notShown: [] })).toThrow();
  });

  it("refuses a header that names a picture size other than the bytes that follow, and a header that is not a run", () => {
    const good = encodeBrowserEvidenceUpload(captured());
    const text = new TextDecoder().decode(good.subarray(8, 8 + new DataView(good.buffer, good.byteOffset).getUint32(4, false)));
    const header = JSON.parse(text) as { routes: Array<{ before?: { bytes: number } }> };
    header.routes[0]!.before!.bytes = 600;
    const encoded = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(8 + encoded.byteLength + 1_000);
    out.set(good.subarray(0, 4)); new DataView(out.buffer).setUint32(4, encoded.byteLength, false); out.set(encoded, 8); out.set(jpeg("a"), 8 + encoded.byteLength); out.set(jpeg("b"), 8 + encoded.byteLength + 500);
    expect(() => decodeBrowserEvidenceUpload(out)).toThrow();
    const notARun = new TextEncoder().encode(JSON.stringify({ routes: "x" }));
    const bad = new Uint8Array(8 + notARun.byteLength);
    bad.set(good.subarray(0, 4)); new DataView(bad.buffer).setUint32(4, notARun.byteLength, false); bad.set(notARun, 8);
    expect(() => decodeBrowserEvidenceUpload(bad)).toThrow();
  });
});

describe("the feature and the payload field", () => {
  it("is a worker invocation feature, so the dispatcher can refuse an older worker", () => {
    expect(BROWSER_EVIDENCE_FEATURE).toBe("task.browserEvidence.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(BROWSER_EVIDENCE_FEATURE);
  });

  const recipe = { startCommand: "npm run start", port: 4321, routes: [{ path: "/checkout", files: ["src/checkout/**"] }] };
  const invocation = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ protocolVersion: 1, kind: "task", operationId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: "00000000-0000-4000-8000-000000000003", prompt: "check", ...payload } }).success;
  it("is accepted only for a verification run with the evidence capture, and only as the owner's strict recipe", () => {
    expect(invocation({ workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: recipe, readiness: [] })).toBe(true);
    expect(invocation({ workflowMode: "CHECKS", browserEvidence: recipe })).toBe(false);
    expect(invocation({ workflowMode: "IMPLEMENT", evidenceCapture: true, browserEvidence: recipe })).toBe(false);
    expect(invocation({ workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: { ...recipe, extra: 1 } })).toBe(false);
    expect(invocation({ workflowMode: "CHECKS", evidenceCapture: true, browserEvidence: { ...recipe, port: 80 } })).toBe(false);
  });

  it("has fixed words for Cloud, which has no browser evidence yet", () => { expect(BROWSER_EVIDENCE_NOT_ON_CLOUD).toBe("Browser evidence is not on Cloud yet"); });
});

const ref = (seed: string) => { const picture = shot(seed); return { kind: "jpeg" as const, sha256: picture.sha256, bytes: 500, retentionClass: "evidence-std" as const }; };
const outcome = (): BrowserEvidenceOutcome => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [{ route: "/users/[id]", reason: "dynamic_route" }], moreNotShown: 3,
  routes: [{ route: "/checkout", status: "shown", before: ref("a"), after: ref("b"), consoleErrors: { before: 0, after: 0 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }],
});
const basePack = (digest = "c".repeat(64)): EvidencePackV2 => ({ schemaVersion: 2, candidate: { digest, repositories: [] }, producer: { edition: "code", isolation: "sandbox" }, level: { reached: "sandbox_only", required: [] }, result: "verified", checks: [], notTested: [] });
const withBrowser = (given: BrowserEvidenceOutcome = outcome()) => { const pack = addBrowserEvidenceToPack(basePack(), given); expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true); return pack; };

describe("the download rule for a v2 pack's pairs", () => {
  it("serves only the pictures the CURRENT pack's browser-evidence check names, for exactly this candidate", () => {
    const pack = withBrowser();
    const images = browserEvidenceServableImages(pack, "c".repeat(64));
    expect(images.map((image) => image.sha256).sort()).toEqual([ref("a").sha256, ref("b").sha256].sort());
    expect(servableBrowserEvidenceImage(pack, "c".repeat(64), ref("a").sha256)?.kind).toBe("jpeg");
    // A digest the store holds but the pack does not name, another candidate's pack, no candidate, no pack.
    expect(servableBrowserEvidenceImage(pack, "c".repeat(64), shot("z").sha256)).toBeUndefined();
    expect(servableBrowserEvidenceImage(pack, "d".repeat(64), ref("a").sha256)).toBeUndefined();
    expect(servableBrowserEvidenceImage(pack, undefined, ref("a").sha256)).toBeUndefined();
    expect(servableBrowserEvidenceImage(undefined, "c".repeat(64), ref("a").sha256)).toBeUndefined();
  });

  it("does not serve pairs of a check that is not the browser-evidence check, nor a ref that is not a JPEG", () => {
    const pack = withBrowser();
    const other = { ...pack, checks: pack.checks.map((check) => ({ ...check, id: "something_else" })) };
    expect(browserEvidenceServableImages(other, "c".repeat(64))).toEqual([]);
    const notVisual = { ...pack, checks: pack.checks.map((check) => ({ ...check, kind: "test" })) };
    expect(browserEvidenceServableImages(notVisual, "c".repeat(64))).toEqual([]);
    const logRef = { kind: "log_txt" as const, sha256: "e".repeat(64), bytes: 10, retentionClass: "evidence-short" as const };
    const withLog = { ...pack, checks: pack.checks.map((check) => ({ ...check, pairs: [{ id: "/x", before: logRef, after: ref("b") }] })) };
    expect(browserEvidenceServableImages(withLog as unknown as EvidencePackV2, "c".repeat(64)).map((image) => image.sha256)).toEqual([ref("b").sha256]);
  });
});

describe("the pack read back as an outcome", () => {
  it("reads what the pack says: the pairs, the not-run and not-shown rows, who ran it, and writes the same lines the outcome would", () => {
    const pack = withBrowser();
    const back = browserEvidenceOutcomeOfPack(pack, "c".repeat(64))!;
    expect(back.routes).toEqual([
      { route: "/checkout", status: "shown", before: ref("a"), after: ref("b"), consoleErrors: { before: 0, after: 0 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" },
    ]);
    expect(back.notShown).toEqual(outcome().notShown);
    expect(back.moreNotShown).toBe(3);
    expect(browserEvidenceLines(back, {})).toEqual(browserEvidenceLines({ ...outcome() }, {}));
    const panel = browserEvidencePanelOf(back)!;
    expect(panel.runBy).toBe("Run by Rovara in its sandbox");
    expect(panel.notProof).toContain("does not count as change proof");
    expect(panel.pairs).toEqual([{ route: "/checkout", before: ref("a").sha256, after: ref("b").sha256 }]);
    expect(panel.notes).toEqual(["/settings: Not run: the page did not load", "/users/[id]: Not shown: needs a route in the recipe", "3 more changed pages not shown: more changed pages than the cap"]);
    expect(JSON.stringify(panel.notes) + JSON.stringify(browserEvidenceLines(back, {}))).not.toContain(ref("a").sha256);
  });

  it("reads a run that did not happen, and reads nothing for another candidate, another producer, or words it does not know", () => {
    const none = addBrowserEvidenceToPack(basePack(), { isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: "no_changed_page" });
    expect(browserEvidenceOutcomeOfPack(none, "c".repeat(64))?.notRun).toBe("no_changed_page");
    const pack = withBrowser();
    expect(browserEvidenceOutcomeOfPack(pack, "d".repeat(64))).toBeUndefined();
    expect(browserEvidenceOutcomeOfPack({ ...pack, producer: { edition: "code", isolation: "sealed" } } as EvidencePackV2, "c".repeat(64))).toBeUndefined();
    const odd = { ...pack, notTested: pack.notTested.map((row) => (row.reason.startsWith("Not run") ? { ...row, reason: "Not run: someone else's words" } : row)) };
    expect(browserEvidenceOutcomeOfPack(odd, "c".repeat(64))).toBeUndefined();
    expect(browserEvidenceOutcomeOfPack(basePack(), "c".repeat(64))).toBeUndefined();
    expect(browserEvidencePanelOf(undefined)).toBeUndefined();
  });
});

describe("the capture program's plan and answer", () => {
  const plan = { port: 4321, readyPath: "/health", routes: ["/checkout"], maskSelectors: [".secret"], runMs: 30_000, pageMs: 15_000 };
  it("round-trips as one argument and refuses anything that is not exactly a plan", () => {
    const argument = encodeBrowserEvidenceExecutorPlan(plan);
    expect(argument).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeBrowserEvidenceExecutorPlan(argument)).toEqual(plan);
    expect(decodeBrowserEvidenceExecutorPlan("")).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan("a b")).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan("A".repeat(16_385))).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan(Buffer.from(JSON.stringify({ ...plan, extra: 1 })).toString("base64url"))).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan(Buffer.from(JSON.stringify({ ...plan, port: 80 })).toString("base64url"))).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan(Buffer.from(JSON.stringify({ ...plan, routes: ["https://evil.example/"] })).toString("base64url"))).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan(Buffer.from(JSON.stringify({ ...plan, routes: ["/a", "/b", "/c", "/d", "/e", "/f"] })).toString("base64url"))).toBeUndefined();
    expect(decodeBrowserEvidenceExecutorPlan(42)).toBeUndefined();
    expect(() => encodeBrowserEvidenceExecutorPlan({ ...plan, port: 80 })).toThrow();
  });
  it("holds a printed line to its schema: a picture over the cap, a route off the origin, an unknown reason", () => {
    const line = (value: unknown) => BrowserEvidenceExecutorLineSchema.safeParse(value).success;
    expect(line({ t: "app", status: "ready" })).toBe(true);
    expect(line({ t: "shot", route: "/a", ok: true, consoleErrors: 0, jpegBase64: Buffer.from(jpeg("a")).toString("base64") })).toBe(true);
    expect(line({ t: "shot", route: "/a", ok: true, consoleErrors: 0, jpegBase64: "A".repeat(800_000) })).toBe(false);
    expect(line({ t: "shot", route: "http://x/", ok: false, reason: "capture_failed" })).toBe(false);
    expect(line({ t: "shot", route: "/a", ok: false, reason: "because" })).toBe(false);
    expect(line({ t: "app", status: "ready", extra: 1 })).toBe(false);
  });
});
