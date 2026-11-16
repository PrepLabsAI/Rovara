// Device testing slice 4 (DEC 244) on a real Mac: the CI `device-ios` job. A real iOS simulator, a real `xcodebuild`-style build (swiftc, no project) and real Maestro, through the same door the laptop uses
// (`runHostDeviceEvidence`: the project's switch AND the recipe's opt-in "not in a sandbox"). A tiny fixture app (tests/fixtures/device-evidence-ios-app: a headline, a line with an email address, a password
// field, a button) is built from two checkouts with two different headlines.
//   * it needs Xcode's simulator and Maestro: without them it SKIPS with the reason, on the log and as a warning annotation, never a silent pass (ROVARA_DEVICE_REQUIRE_IOS=1 makes it fail instead);
//   * the run is checked end to end: a masked before and after picture of each step, the email and the password painted black, the button's tap taking effect (so Maestro ran), kind visual, the words
//     "developer machine" and "not in a sandbox";
//   * afterwards the machine is as it was: every simulator the run made is gone, and no other was touched (the list is read before and after).
// UNVERIFIED before CI: the lane that wrote this had no Xcode. The first run of this job is the first real run of the iOS driver; expect to read it and adjust (Maestro's hierarchy shape, boot time).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEVICE_HOST_RUN_ACK, deviceEvidenceCheck, deviceEvidenceLines, type DeviceEvidenceOutcome } from "../../packages/contracts/src/device-evidence.js";
import { createHostDeviceFiles, runHostDeviceEvidence } from "../../packages/verifier/src/executor/device-host.js";
import { encodeDeviceJpeg } from "../../packages/verifier/src/executor/device-jpeg.js";
import { IOS_SIMULATOR_PREFIX } from "../../packages/verifier/src/executor/device-ios.js";
import { createNodeCommandPort } from "../../packages/verifier/src/executor/device-process.js";
import { decodeJpeg } from "../support/device-jpeg-decode.js";
import { iosHere, skipIosWithReason } from "../support/device-ios-host.js";

const wanted = process.platform === "darwin";
const FIXTURE = join(process.cwd(), "tests/fixtures/device-evidence-ios-app");
const simulators = (): string[] => {
  const row = spawnSync("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1_048_576 });
  const parsed = JSON.parse(row.stdout) as { devices: Record<string, Array<{ udid: string; name: string }>> };
  return Object.values(parsed.devices).flat().map((device) => `${device.udid} ${device.name}`).sort();
};

describe.runIf(wanted)("device evidence: the iOS simulator on a Mac", () => {
  const root = mkdtempSync(join(tmpdir(), "rovara-device-ios-"));
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it("takes masked before and after pictures of a real app on a real simulator, outside a sandbox because the project said so, and leaves the machine's simulators as it found them", async (context) => {
    const here = iosHere();
    if (!here.ok) skipIosWithReason((note) => context.skip(note), here.reason);
    const maestro = here.ok ? here.maestro : "";
    const checkouts = { before: join(root, "base"), after: join(root, "head") };
    mkdirSync(checkouts.before, { recursive: true });
    mkdirSync(checkouts.after, { recursive: true });
    writeFileSync(join(checkouts.before, "headline.txt"), "Total: 10");
    writeFileSync(join(checkouts.after, "headline.txt"), "Total: 12");
    const scratchDir = join(root, "scratch");
    mkdirSync(scratchDir, { mode: 0o700 });
    const recipe = {
      platform: "ios", buildCommand: `sh ${join(FIXTURE, "build.sh")}`, appFile: "build/Fixture.app", appId: "io.rovara.fixture-app", outsideSandbox: DEVICE_HOST_RUN_ACK,
      flows: [{ id: "main", files: ["App/**"], steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text", text: "Continue" }] }] }],
    };
    const canBind = (port: number) => new Promise<boolean>((resolve) => { const server = createServer(); server.once("error", () => { resolve(false); }); server.listen(port, "127.0.0.1", () => { server.close(() => { resolve(true); }); }); });
    const before = simulators();
    const stages: string[] = [];
    const started = Date.now();
    const got = await runHostDeviceEvidence({
      policy: { status: "resolved", values: { device_evidence: { value: "on", origin: "changed_here" } } }, recipe, changedFiles: ["App/Checkout.swift"], host: { platform: process.platform },
      checkouts, ios: { maestro }, scratchDir, env: process.env, command: createNodeCommandPort(), files: createHostDeviceFiles(), canBind,
      encodeJpeg: (frame) => encodeDeviceJpeg(frame, 512 * 1_024), diag: (stage, note, detail) => { stages.push(`${stage}: ${note}${detail === undefined ? "" : ` | ${detail.replace(/\s+/gu, " ")}`}`); },
    });
    process.stdout.write(`iOS run finished in ${String(Math.round((Date.now() - started) / 1000))} s\n${stages.join("\n")}\n`);
    expect(got.status).toBe("captured");
    if (got.status !== "captured") return;
    const captured = got.captured;
    process.stdout.write(`result: ${JSON.stringify({ ...captured, steps: captured.steps.map((row) => (row.status === "shown" ? { flow: row.flow, step: row.step, status: row.status } : row)) })}\n`);
    if (captured.notRun !== undefined || captured.steps.some((row) => row.status !== "shown")) throw new Error(`the run did not show every step: ${JSON.stringify({ notRun: captured.notRun, steps: captured.steps.map((row) => (row.status === "shown" ? "shown" : row.reason)) })}\n${stages.slice(-20).join("\n")}`);
    expect(captured.device).toBe("ios_simulator");
    expect(captured.isolation).toBe("developer_machine");

    for (const row of captured.steps) {
      if (row.status !== "shown") throw new Error("shown expected");
      for (const side of [row.before, row.after]) {
        const picture = decodeJpeg(side.bytes);
        expect(picture.width).toBeGreaterThan(300);
        expect(picture.height).toBeGreaterThan(picture.width);
        // The email line and the password field are painted black: two bands of about 60 points (180 pixels at 3x, 120 at 2x) across the screen's width; the headline and the button are not.
        const darkRows = Array.from({ length: picture.height }, (_row, y) => {
          let dark = 0;
          for (let x = 0; x < picture.width; x += 1) if (picture.rgba[(y * picture.width + x) * 4]! < 40) dark += 1;
          return dark / picture.width;
        }).filter((share) => share > 0.5).length;
        expect(darkRows, `${row.flow}/${row.step}: rows painted black`).toBeGreaterThanOrEqual(Math.round(picture.height * 0.03));
        expect(darkRows, `${row.flow}/${row.step}: rows painted black`).toBeLessThanOrEqual(Math.round(picture.height * 0.4));
      }
    }
    // The two builds differ on the first step (their headlines), and on each side the second step differs from the first (the tap on "Continue" changed the headline: Maestro really ran).
    const [open, next] = captured.steps;
    if (open?.status !== "shown" || next?.status !== "shown") throw new Error("two shown steps expected");
    expect(open.before.sha256).not.toBe(open.after.sha256);
    expect(next.before.sha256).not.toBe(open.before.sha256);
    expect(next.after.sha256).not.toBe(open.after.sha256);

    // Visual evidence only, and it says where it ran.
    const ref = (bytes: Uint8Array) => ({ kind: "jpeg" as const, sha256: "a".repeat(64), bytes: bytes.byteLength, retentionClass: "evidence-std" as const });
    const outcome: DeviceEvidenceOutcome = { ...captured, steps: captured.steps.map((row) => (row.status === "shown" ? { ...row, before: ref(row.before.bytes), after: ref(row.after.bytes) } : row)) };
    expect(deviceEvidenceCheck(outcome).check).toMatchObject({ kind: "visual", runBy: "rovara", label: "Device evidence: iOS simulator" });
    expect(deviceEvidenceLines(outcome, {})[0]).toContain("not in a sandbox");

    // The machine as it was: no simulator of this run is left, and none that was there is gone.
    const after = simulators();
    expect(after.filter((row) => row.includes(IOS_SIMULATOR_PREFIX)), "simulators of this run left behind").toEqual(before.filter((row) => row.includes(IOS_SIMULATOR_PREFIX)));
    expect(after).toEqual(before);
  }, 1_200_000);
});
