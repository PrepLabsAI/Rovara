// TE-H1 slice 4: video on failure, the contract half. A video cannot be masked frame by frame the way a screenshot is (it records the live page, before any scrub), so it is recorded only when the
// project's recipe says its app shows fixture data only (an admin's choice, saved on the owner's own page) and never for an app behind a login. It is kept only for a page that failed or showed errors, under the
// evidence store's own `webm` rules (company-scoped, short retention), bounded in count, size and time, and shown as a download behind sign-in, never on GitHub.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_VIDEOS_MAX, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS, BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS, BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_CHECK_ID,
  BrowserEvidenceRecipeSchema, addBrowserEvidenceToPack, browserEvidenceCheck, browserEvidenceLines, browserEvidenceVideoEligible, browserEvidenceVideoWanted, checkedBrowserEvidenceCaptured,
  type BrowserEvidenceCaptured, type BrowserEvidenceOutcome,
} from "../../packages/contracts/src/browser-evidence.js";
import {
  BROWSER_EVIDENCE_UPLOAD_MAX_BYTES, browserEvidenceOutcomeOfPack, browserEvidencePanelOf, browserEvidenceServableVideos, decodeBrowserEvidenceUpload, encodeBrowserEvidenceUpload, servableBrowserEvidenceImage, servableBrowserEvidenceVideo,
} from "../../packages/contracts/src/browser-evidence-wire.js";
import { EvidencePackV2Schema, type ArtifactRef, type EvidencePackV2 } from "../../packages/contracts/src/evidence.js";
import { checkKindInfo } from "../../packages/contracts/src/check-kinds.js";
import { proofHolds, type TestProof } from "../../packages/contracts/src/test-proof.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const webm = (seed: string, size = 900) => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed.charCodeAt(0), 4); return bytes; };
const shot = (seed: string, size = 500) => { const bytes = jpeg(seed, size); return { bytes, sha256: sha(bytes) }; };
const clip = (seed: string, size = 900) => { const bytes = webm(seed, size); return { bytes, sha256: sha(bytes) }; };

const RECIPE = { startCommand: "npm start", port: 3000, routes: [{ path: "/checkout", files: ["src/checkout/**"] }] };
const SIGN_IN = { path: "/login", usernameSelector: "#u", passwordSelector: "#p", submitSelector: "#go", successPath: "/home", credentialRef: "be-shop-signin" };

const capturedWithVideo = (): BrowserEvidenceCaptured => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [
    { route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 2 }, video: clip("v") },
    { route: "/settings", status: "not_run", reason: "page_did_not_load", video: clip("w") },
    { route: "/orders", status: "not_run", reason: "page_did_not_load", videoNotKept: "over_size_cap" },
  ],
});

describe("the recipe's video choice", () => {
  it("is off unless the recipe says fixtureDataOnly: true, exactly", () => {
    expect(browserEvidenceVideoWanted(RECIPE)).toBe(false);
    expect(browserEvidenceVideoWanted({ ...RECIPE, video: { fixtureDataOnly: true } })).toBe(true);
    for (const video of [{ fixtureDataOnly: false }, {}, { fixtureDataOnly: "yes" }, { fixtureDataOnly: true, extra: 1 }, true, "on", null]) {
      expect(BrowserEvidenceRecipeSchema.safeParse({ ...RECIPE, video }).success).toBe(false);
      expect(browserEvidenceVideoWanted({ ...RECIPE, video })).toBe(false);
    }
    expect(browserEvidenceVideoWanted(undefined)).toBe(false);
  });

  it("is refused for an app behind a login (a typed account would be in the recording), whole recipe or nothing", () => {
    expect(BrowserEvidenceRecipeSchema.safeParse({ ...RECIPE, signIn: SIGN_IN }).success).toBe(true);
    const both = BrowserEvidenceRecipeSchema.safeParse({ ...RECIPE, signIn: SIGN_IN, video: { fixtureDataOnly: true } });
    expect(both.success).toBe(false);
    expect(browserEvidenceVideoWanted({ ...RECIPE, signIn: SIGN_IN, video: { fixtureDataOnly: true } })).toBe(false);
  });

  it("a recipe without the field parses to exactly what it did before (no key added)", () => {
    const parsed = BrowserEvidenceRecipeSchema.parse(RECIPE);
    expect(Object.keys(parsed).sort()).toEqual(["port", "routes", "startCommand"]);
  });
});

describe("which pages may keep a video", () => {
  it("a page that did not load, or a page with errors after; never a page whose text was not read and verified (it could not be photographed, ran out of time, or was withheld for what it showed)", () => {
    expect(browserEvidenceVideoEligible({ status: "not_run", reason: "page_did_not_load" })).toBe(true);
    for (const reason of ["capture_failed", "time_limit", "masked_content", "over_size_cap", "app_did_not_start", "not_stored", "sign_in_failed", "no_recipe"] as const) expect(browserEvidenceVideoEligible({ status: "not_run", reason })).toBe(false);
    expect(browserEvidenceVideoEligible({ status: "shown", consoleErrors: { after: 1 } })).toBe(true);
    expect(browserEvidenceVideoEligible({ status: "shown", consoleErrors: { after: 0 } })).toBe(false);
  });

  it("a run that carries a video of a healthy page, or of a withheld page, is refused whole", () => {
    const healthy = capturedWithVideo();
    healthy.routes = [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 0 }, video: clip("v") }];
    expect(() => checkedBrowserEvidenceCaptured(healthy)).toThrow();
    const withheld = capturedWithVideo();
    withheld.routes = [{ route: "/settings", status: "not_run", reason: "masked_content", video: clip("v") }];
    expect(() => checkedBrowserEvidenceCaptured(withheld)).toThrow();
    for (const reason of ["capture_failed", "time_limit"] as const) {
      const unread = capturedWithVideo();
      unread.routes = [{ route: "/settings", status: "not_run", reason, video: clip("v") }];
      expect(() => checkedBrowserEvidenceCaptured(unread), reason).toThrow();
    }
    expect(() => checkedBrowserEvidenceCaptured(capturedWithVideo())).not.toThrow();
  });
});

describe("the video's bounds", () => {
  const failing = (count: number, size: number, seedOffset = 0) => Array.from({ length: count }, (_, index) => ({ route: `/p${String(index)}`, status: "not_run" as const, reason: "page_did_not_load" as const, video: clip(String.fromCharCode(97 + index + seedOffset), size) }));
  const run = (routes: BrowserEvidenceCaptured["routes"]): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 1, notShown: [], moreNotShown: 0, routes });

  it("one video is at most 2 MiB, a run keeps at most two and at most 4 MiB of video", () => {
    expect(BROWSER_EVIDENCE_VIDEO_MAX_BYTES).toBe(2 * 1_048_576);
    expect(BROWSER_EVIDENCE_VIDEOS_MAX).toBe(2);
    expect(BROWSER_EVIDENCE_VIDEO_TOTAL_MAX_BYTES).toBe(4 * 1_048_576);
    expect(() => checkedBrowserEvidenceCaptured(run(failing(2, BROWSER_EVIDENCE_VIDEO_MAX_BYTES)))).not.toThrow();
    expect(() => checkedBrowserEvidenceCaptured(run(failing(1, BROWSER_EVIDENCE_VIDEO_MAX_BYTES + 1)))).toThrow();
    expect(() => checkedBrowserEvidenceCaptured(run(failing(3, 1_000)))).toThrow();
    expect(() => checkedBrowserEvidenceCaptured(run(failing(1, 0)))).toThrow();
  });

  it("a video is a WebM: anything else is refused (the digest is checked where it is stored)", () => {
    const bad = run(failing(1, 1_000));
    const row = bad.routes[0];
    if (row === undefined || row.status !== "not_run" || row.video === undefined) throw new Error("setup");
    row.video.bytes[0] = 0;
    expect(() => checkedBrowserEvidenceCaptured(bad)).toThrow();
  });

  it("a video and a 'not kept' reason are not both on one page, and the reasons are fixed words", () => {
    const both = run([{ route: "/a", status: "not_run", reason: "page_did_not_load", video: clip("v"), videoNotKept: "over_size_cap" }]);
    expect(() => checkedBrowserEvidenceCaptured(both)).toThrow();
    expect(() => checkedBrowserEvidenceCaptured(run([{ route: "/a", status: "not_run", reason: "page_did_not_load", videoNotKept: "because I said so" as never }]))).toThrow();
    expect([...BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS]).toEqual(["over_size_cap", "withheld", "not_recorded", "not_stored"]);
    for (const reason of BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS) expect(BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS[reason]).toMatch(/^[a-z][a-z ,]+$/u);
  });
});

describe("the upload carries the videos and nothing else changes", () => {
  it("round-trips pictures and videos, byte for byte, and fits the cap that now includes the video budget", () => {
    const bytes = encodeBrowserEvidenceUpload(capturedWithVideo());
    expect(decodeBrowserEvidenceUpload(bytes)).toEqual(capturedWithVideo());
    expect(bytes.byteLength).toBeLessThan(BROWSER_EVIDENCE_UPLOAD_MAX_BYTES);
  });

  it("a run with no video is encoded byte for byte as before (the same header, the same order)", () => {
    const plain: BrowserEvidenceCaptured = { isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0, routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 2 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }] };
    const bytes = encodeBrowserEvidenceUpload(plain);
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, false);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as { routes: Array<Record<string, unknown>> };
    expect(header.routes.flatMap((row) => Object.keys(row))).not.toContain("video");
    expect(header.routes.flatMap((row) => Object.keys(row))).not.toContain("videoNotKept");
    expect(bytes.byteLength).toBe(8 + headerLength + 500 + 500);
  });

  it("a header whose video size is not the bytes that follow is refused", () => {
    const good = encodeBrowserEvidenceUpload(capturedWithVideo());
    expect(() => decodeBrowserEvidenceUpload(good.subarray(0, good.byteLength - 1))).toThrow("browser evidence upload is not valid");
    const longer = new Uint8Array(good.byteLength + 1);
    longer.set(good);
    expect(() => decodeBrowserEvidenceUpload(longer)).toThrow("browser evidence upload is not valid");
  });
});

// ---- the pack

const ref = (kind: "jpeg" | "webm", seed: string, bytes = 700): ArtifactRef => ({ kind, sha256: sha(new TextEncoder().encode(`${kind}${seed}`)), bytes, retentionClass: kind === "jpeg" ? "evidence-std" : "evidence-short" });
const outcome = (): BrowserEvidenceOutcome => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [
    { route: "/checkout", status: "shown", before: ref("jpeg", "b"), after: ref("jpeg", "a"), consoleErrors: { before: 0, after: 2 }, video: ref("webm", "v") },
    { route: "/settings", status: "not_run", reason: "page_did_not_load", video: ref("webm", "w") },
    { route: "/orders", status: "not_run", reason: "page_did_not_load", videoNotKept: "withheld" },
  ],
});
const basePack = (): EvidencePackV2 => ({
  schemaVersion: 2, candidate: { digest: "a".repeat(64), repositories: [] }, producer: { edition: "code", isolation: "sandbox" }, level: { reached: "sandbox_only", required: [] }, result: "verified",
  checks: [{ id: "unit", kind: "test", label: "Unit tests", before: "failed", after: "passed", class: "fixed", durationMs: 10 }], notTested: [],
});

const built = (pack: EvidencePackV2) => pack.checks.find((check) => check.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID)!;

describe("the pack's video check", () => {
  it("is a second check of the `visual` kind (never proof), one pair per kept video, with the not-kept ones as fixed 'Not kept' rows", () => {
    const built = browserEvidenceCheck(outcome());
    expect(built.videoCheck).toMatchObject({ id: BROWSER_EVIDENCE_VIDEO_CHECK_ID, kind: "visual", runBy: "rovara", stage: "sandbox", class: "not_rerun" });
    expect(built.videoCheck?.pairs?.map((pair) => ({ id: pair.id, after: pair.after?.kind, before: pair.before }))).toEqual([{ id: "/checkout", after: "webm", before: undefined }, { id: "/settings", after: "webm", before: undefined }]);
    expect(built.notTested).toContainEqual({ what: "Browser evidence video: /orders", reason: `Not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS.withheld}` });
    expect(built.check.kind).toBe("visual");
  });

  it("a run with no video has no second check and no extra row (absent = today's behaviour)", () => {
    const plain = outcome();
    plain.routes = [{ route: "/checkout", status: "shown", before: ref("jpeg", "b"), after: ref("jpeg", "a"), consoleErrors: { before: 0, after: 0 } }];
    const built = browserEvidenceCheck(plain);
    expect(built.videoCheck).toBeUndefined();
    expect(built.notTested).toEqual([]);
  });

  it("is added with the main check, refused twice, and refused over the pack's limits; the pack still parses strictly and TESTPROOF ignores both", () => {
    const pack = addBrowserEvidenceToPack(basePack(), outcome());
    expect(pack.checks.map((check) => check.id)).toEqual(["unit", "browser_evidence", BROWSER_EVIDENCE_VIDEO_CHECK_ID]);
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
    expect(() => addBrowserEvidenceToPack(pack, outcome())).toThrow();
    expect(() => addBrowserEvidenceToPack({ ...basePack(), checks: [{ id: BROWSER_EVIDENCE_VIDEO_CHECK_ID, kind: "visual", label: "x", before: "not_run", after: "not_run", class: "not_rerun", durationMs: 0 }] }, outcome())).toThrow();
    expect(checkKindInfo("visual")?.countsTowardProof).toBe(false);
    const proof: TestProof = { schemaVersion: 1, candidateDigest: "d".repeat(64), status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, durationMs: 10,
      items: [{ checkId: BROWSER_EVIDENCE_VIDEO_CHECK_ID, label: "Browser evidence video", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }] };
    expect(proofHolds({ facts: { proof, checkKinds: { [BROWSER_EVIDENCE_VIDEO_CHECK_ID]: "e2e" } }, mode: "hold" }).provenCount).toBe(1);
    expect(proofHolds({ facts: { proof, checkKinds: { [BROWSER_EVIDENCE_VIDEO_CHECK_ID]: built(pack).kind } }, mode: "hold" }).provenCount).toBe(0);
  });

  it("reads back as the same outcome: the videos on their pages, the not-kept reasons, nothing guessed", () => {
    const pack = addBrowserEvidenceToPack(basePack(), outcome());
    const back = browserEvidenceOutcomeOfPack(pack, "a".repeat(64));
    expect(back?.routes.map((row) => ({ route: row.route, video: row.video?.sha256, notKept: row.videoNotKept }))).toEqual([
      { route: "/checkout", video: ref("webm", "v").sha256, notKept: undefined },
      { route: "/settings", video: ref("webm", "w").sha256, notKept: undefined },
      { route: "/orders", video: undefined, notKept: "withheld" },
    ]);
    // A video pair for a page the outcome does not have, a pair that is not a WebM, and a 'Not kept' row with words of its own all read as NO outcome.
    const stray = { ...pack, checks: pack.checks.map((check) => (check.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID ? { ...check, pairs: [...(check.pairs ?? []), { id: "/nowhere", after: ref("webm", "z") }] } : check)) };
    expect(browserEvidenceOutcomeOfPack(stray, "a".repeat(64))).toBeUndefined();
    const notWebm = { ...pack, checks: pack.checks.map((check) => (check.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID ? { ...check, pairs: [{ id: "/checkout", after: ref("jpeg", "z") }] } : check)) };
    expect(browserEvidenceOutcomeOfPack(notWebm, "a".repeat(64))).toBeUndefined();
    const words = { ...pack, notTested: pack.notTested.map((row) => (row.what.startsWith("Browser evidence video") ? { ...row, reason: "Not kept: my own words" } : row)) };
    expect(browserEvidenceOutcomeOfPack(words, "a".repeat(64))).toBeUndefined();
  });
});

describe("the download rule for videos", () => {
  it("serves a video only when the CURRENT pack's video check names it, for exactly this candidate, as a WebM", () => {
    const pack = addBrowserEvidenceToPack(basePack(), outcome());
    const digest = "a".repeat(64);
    expect(browserEvidenceServableVideos(pack, digest).map((item) => item.sha256).sort()).toEqual([ref("webm", "v").sha256, ref("webm", "w").sha256].sort());
    expect(servableBrowserEvidenceVideo(pack, digest, ref("webm", "v").sha256)?.kind).toBe("webm");
    expect(servableBrowserEvidenceVideo(pack, "b".repeat(64), ref("webm", "v").sha256)).toBeUndefined();
    expect(servableBrowserEvidenceVideo(pack, digest, ref("webm", "unknown").sha256)).toBeUndefined();
    // A picture's digest is never a video, and a video's digest is never served as a picture.
    expect(servableBrowserEvidenceVideo(pack, digest, ref("jpeg", "a").sha256)).toBeUndefined();
    expect(servableBrowserEvidenceImage(pack, digest, ref("webm", "v").sha256)).toBeUndefined();
    // Another check that happens to name a WebM serves nothing.
    const other = { ...pack, checks: pack.checks.map((check) => (check.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID ? { ...check, id: "smoke" } : check)) };
    expect(browserEvidenceServableVideos(other, digest)).toEqual([]);
  });

  it("a video check that names a picture (or a recording over the cap) serves nothing", () => {
    const pack = addBrowserEvidenceToPack(basePack(), outcome());
    const digest = "a".repeat(64);
    for (const bad of [ref("jpeg", "a"), ref("webm", "big", BROWSER_EVIDENCE_VIDEO_MAX_BYTES + 1)]) {
      const tampered = { ...pack, checks: pack.checks.map((check) => (check.id === BROWSER_EVIDENCE_VIDEO_CHECK_ID ? { ...check, pairs: [{ id: "/checkout", after: bad }] } : check)) };
      expect(browserEvidenceServableVideos(tampered, digest)).toEqual([]);
    }
  });

  it("the task page's panel lists the videos by route and digest, and has no `videos` key without one", () => {
    const panel = browserEvidencePanelOf(outcome());
    expect(panel?.videos).toEqual([{ route: "/checkout", sha256: ref("webm", "v").sha256 }, { route: "/settings", sha256: ref("webm", "w").sha256 }]);
    expect(panel?.notes).toContain(`/orders: Video not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS.withheld}`);
    const plain = outcome();
    plain.routes = [{ route: "/checkout", status: "shown", before: ref("jpeg", "b"), after: ref("jpeg", "a"), consoleErrors: { before: 0, after: 0 } }];
    expect(Object.keys(browserEvidencePanelOf(plain) ?? {})).not.toContain("videos");
  });
});

describe("the pull request's lines about a video", () => {
  it("say a video is kept (download behind sign-in) or not kept (fixed words), never where the file is, and add nothing for a run without one", () => {
    const lines = browserEvidenceLines(outcome(), { taskLink: "https://rovara.example/proof/abc" });
    expect(lines.join("\n")).toContain("`/checkout`: before and after screenshots, 2 console errors after");
    expect(lines.find((line) => line.includes("/settings"))).toContain("Video of the failure: kept (download behind sign-in)");
    expect(lines.find((line) => line.includes("/orders"))).toContain(`Video of the failure: Not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS.withheld}`);
    for (const line of lines) { expect(line).not.toMatch(/[a-f0-9]{64}/u); expect(line).not.toContain("webm"); }
    const plain = outcome();
    plain.routes = [{ route: "/checkout", status: "shown", before: ref("jpeg", "b"), after: ref("jpeg", "a"), consoleErrors: { before: 0, after: 0 } }];
    expect(browserEvidenceLines(plain, {}).join("\n")).not.toContain("Video");
  });
});
