// TE-H1 slice 2 (DEC 241a) on real Docker, the real executor image and its sandboxed Chromium (the CI `linux-runtime` job: ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE). Everywhere else it skips.
// The project's app runs in one container with NO network (standing in for the task sandbox: its only address is its own loopback), and the capture container shares that container's network namespace and nothing else
// (`--network container:<it>`, the executor's own flags: every capability dropped, the pinned seccomp profile, a read-only root). It reaches the app on the shared loopback, takes the masked pictures and prints them.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, encodeBrowserEvidenceExecutorPlan } from "../../packages/contracts/src/index.js";
import { verifyExecutorSeccompProfile } from "../../packages/verifier/src/host/executor-seccomp.js";
import { browserEvidenceExecutorArgs, parseCaptureOutput } from "../../packages/worker/src/browser-evidence-run.js";
import { repoExecutorSeccompProfilePath } from "../../scripts/executor-smoke.js";

const docker = (args: string[], timeout = 120_000) => spawnSync("docker", args, { encoding: "buffer", timeout, maxBuffer: 16 * 1024 * 1024 });

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("browser evidence: the capture container shares only the sandbox's network", () => {
  it("reaches the app that listens only on the sandbox's own loopback, takes a JPEG per page within the cap, and says why a page was not taken", () => {
    const fixture = join(process.cwd(), "tests/fixtures/browser-evidence-app");
    const image = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
    const sandbox = `rovara-be-sbx-${randomBytes(4).toString("hex")}`;
    const capture = `rovara-be-${randomBytes(6).toString("hex")}`;
    const port = 4321;
    try {
      const started = docker(["run", "--detach", "--rm", "--pull=never", "--name", sandbox, "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-v", `${fixture}:/fixture:ro`,
        "--env", `PORT=${String(port)}`, "--workdir", "/fixture/after", image, "node", "../server.mjs"]);
      expect(started.status, started.stderr.toString()).toBe(0);
      const plan = encodeBrowserEvidenceExecutorPlan({ port, readyPath: "/health", routes: ["/checkout", "/missing"], maskSelectors: [], runMs: 60_000, pageMs: 15_000 });
      const args = browserEvidenceExecutorArgs({ image, sandbox, name: capture, seccompProfile: verifyExecutorSeccompProfile(repoExecutorSeccompProfilePath()), plan });
      // The only thing shared is the network namespace: the arguments have no mount, no environment and no other network.
      expect(args.filter((value) => value === "--network")).toHaveLength(1);
      expect(args).not.toContain("-v");
      const result = docker(args, 280_000);
      expect(result.status, result.stderr.toString()).toBe(0);
      const parsed = parseCaptureOutput(result.stdout, ["/checkout", "/missing"]);
      if (parsed === undefined) throw new Error(`the capture program's output was not understood: ${result.stdout.toString("utf8").slice(0, 400)}`);
      expect(parsed.app).toBe("ready");
      const checkout = parsed.shots.get("/checkout");
      if (checkout?.t !== "shot" || !checkout.ok) throw new Error(`the changed page was not shown: ${JSON.stringify(checkout)}`);
      const bytes = Buffer.from(checkout.jpegBase64, "base64");
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES);
      expect(parsed.shots.get("/missing")).toMatchObject({ ok: false, reason: "page_did_not_load" });
      // A port nothing listens on in the shared namespace is "the app did not start" within the plan's time, never a picture of something else.
      const none = docker(browserEvidenceExecutorArgs({ image, sandbox, name: `${capture}x`, seccompProfile: verifyExecutorSeccompProfile(repoExecutorSeccompProfilePath()), plan: encodeBrowserEvidenceExecutorPlan({ port: port + 1, routes: ["/checkout"], maskSelectors: [], runMs: 2_000, pageMs: 2_000 }) }), 120_000);
      expect(none.status, none.stderr.toString()).toBe(0);
      expect(parseCaptureOutput(none.stdout, ["/checkout"])?.app).toBe("time_limit");
    } finally {
      docker(["rm", "--force", capture]);
      docker(["rm", "--force", `${capture}x`]);
      docker(["rm", "--force", sandbox]);
    }
  }, 600_000);
});
