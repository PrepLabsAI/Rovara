// TE-H1 browser evidence on real Docker, the real executor image and its sandboxed Chromium (the CI `linux-runtime` job: ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE). Everywhere else it skips;
// tests/unit/browser-evidence-chromium.test.ts runs the same driver where a local Chromium is installed. The container runs as the worker's Docker host runs the executor
// (`executorContainerArgs`: the pinned seccomp profile, every capability dropped, read-only), with no network: the fixture app answers on the container's own loopback.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_MAX_BYTES, BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS } from "../../packages/contracts/src/browser-evidence.js";
import { executorContainerArgs } from "../../packages/verifier/src/host/executor-container.js";
import { verifyExecutorSeccompProfile } from "../../packages/verifier/src/host/executor-seccomp.js";
import { repoExecutorSeccompProfilePath } from "../../scripts/executor-smoke.js";

type Shot = { sha256: string; bytes: number; jpeg: boolean };
type Video = { video?: { bytes: number; webm: boolean }; videoNotKept?: string };
type Row = ({ route: string; status: "shown"; before: Shot; after: Shot; consoleErrors: { before: number; after: number } } | { route: string; status: "not_run"; reason: string }) & Video;
type Out = { changed: { notRun: string | null; routes: Row[] }; masked: { notRun: string | null; routes: Row[] }; withVideo: { notRun: string | null; routes: Row[] } };

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("browser evidence in the executor image", () => {
  it("starts the app with its start command, keeps masked before and after JPEGs within the e2e cap, and says Not run for a page that does not load", () => {
    const fixture = join(process.cwd(), "tests/fixtures/browser-evidence-app");
    const image = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
    const args = ["run", "--rm", "--pull=never", "--network", "none", ...executorContainerArgs(verifyExecutorSeccompProfile(repoExecutorSeccompProfilePath())),
      "-v", `${fixture}:/fixture:ro`, image, "node", "/fixture/run-in-executor.mjs"];
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 280_000 });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Out;
    expect(out.changed.notRun, result.stderr).toBeNull();
    const [checkout, missing] = out.changed.routes;
    expect(missing).toEqual({ route: "/missing", status: "not_run", reason: "page_did_not_load" });
    if (checkout?.status !== "shown") throw new Error(`the changed page was not shown: ${JSON.stringify(checkout)}`);
    for (const shot of [checkout.before, checkout.after]) {
      expect(shot.jpeg).toBe(true);
      expect(shot.bytes).toBeGreaterThan(0);
      expect(shot.bytes).toBeLessThanOrEqual(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES);
    }
    expect(checkout.before.sha256).not.toBe(checkout.after.sha256);
    expect(checkout.consoleErrors).toEqual({ before: 0, after: 1 });
    const after = (route: string) => { const row = out.masked.routes.find((item) => item.route === route); if (row?.status !== "shown") throw new Error(`${route} was not shown`); return row.after.sha256; };
    expect(after("/masked-a")).toBe(after("/masked-b"));
    expect(after("/email-a")).toBe(after("/email-b"));
    // Slice 4: video on failure. The page that works on the base code and fails on the candidate has a recording of its load, or says why it has none; the screenshots of the other pages are the same either way, and a
    // healthy page has neither. (Whether this image's Chromium can record at all is what the first run of this assertion shows: where it cannot, the page says "not recorded" and nothing else changes.)
    expect(out.withVideo.notRun, result.stderr).toBeNull();
    const video = (route: string) => { const row = out.withVideo.routes.find((item) => item.route === route); if (row === undefined) throw new Error(`${route} is missing`); return row; };
    expect(video("/regress-ok").status).toBe("shown");
    expect(video("/regress-ok").video).toBeUndefined();
    expect(video("/regress-ok").videoNotKept).toBeUndefined();
    expect(video("/checkout").status).toBe("shown");
    expect(video("/regress")).toMatchObject({ status: "not_run", reason: "page_did_not_load" });
    for (const route of ["/regress", "/checkout"]) {
      const row = video(route);
      if (row.video === undefined) expect(BROWSER_EVIDENCE_VIDEO_NOT_KEPT_REASONS as readonly string[], `${route}: ${row.videoNotKept ?? "no reason"}`).toContain(row.videoNotKept);
      else { expect(row.video.webm, route).toBe(true); expect(row.video.bytes, route).toBeLessThanOrEqual(BROWSER_EVIDENCE_VIDEO_MAX_BYTES); }
    }
  }, 300_000);
});
