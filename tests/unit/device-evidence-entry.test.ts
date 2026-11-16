// Device testing slice 2: the whole device-executor program over scripted tools. The runner (slice 1), the Android driver, the real JPEG encoder and the answer's checks work together: a screen
// with a secret in it comes out painted, a run that cannot boot says why, a screen that cannot be read is withheld even under the admin's fixture-data choice, and what is printed is believed
// by the worker only through its own checks.
import { describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_STEP_MS, deviceEvidenceCheck, deviceEvidenceLines, type DeviceEvidenceOutcome } from "../../packages/contracts/src/device-evidence.js";
import { checkKindInfo } from "../../packages/contracts/src/check-kinds.js";
import { runDevicePlan } from "../../packages/verifier/src/executor/device-evidence-entry.js";
import { decodeDeviceExecutorPlan, encodeDeviceExecutorOutput, encodeDeviceExecutorPlan, parseDeviceExecutorOutput, type DeviceExecutorPlanInput } from "../../packages/verifier/src/host/device-executor.js";
import { decodeJpeg } from "../support/device-jpeg-decode.js";
import { answer, fakeAndroid, rawScreencap, type FakeAndroidScript } from "../support/device-command-fake.js";

const W = 96;
const H = 64;
const box = (l: number, t: number, r: number, b: number) => `[${String(l)},${String(t)}][${String(r)},${String(b)}]`;
const dump = (...nodes: string[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;
const SCREEN = dump(
  `<node class="android.widget.TextView" text="Total: 12" bounds="${box(0, 0, 96, 16)}" />`,
  `<node class="android.widget.TextView" text="Contact: sam@example.org" bounds="${box(0, 16, 96, 32)}" />`,
  `<node class="android.widget.EditText" password="true" text="••••" bounds="${box(0, 32, 96, 48)}" />`,
);
const baseInput: DeviceExecutorPlanInput = {
  appId: "io.rovara.fixture", flows: [{ id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text", text: "Continue" }] }] }],
  notShown: [], moreNotShown: 0, maskIds: [], runMs: DEVICE_EVIDENCE_RUN_MS, stepMs: DEVICE_EVIDENCE_STEP_MS,
};
async function run(script: FakeAndroidScript = {}, input: DeviceExecutorPlanInput = baseInput, tick = 0) {
  let t = 0;
  const fake = fakeAndroid({ wmSize: `Physical size: ${String(W)}x${String(H)}\n`, dump: SCREEN, screencap: answer(rawScreencap(W, H, { shade: 235 })), ...script, first: (file, args) => { t += tick; return script.first?.(file, args); } });
  const plan = decodeDeviceExecutorPlan(encodeDeviceExecutorPlan(input))!;
  const captured = await runDevicePlan(plan, { command: fake.port, writeFile: fake.writeFile, now: () => t, sleep: (ms) => { t += ms; return Promise.resolve(); } });
  return { captured, plan, ...fake };
}
const pixel = (rgba: Uint8Array, x: number, y: number) => rgba[(y * W + x) * 4]!;

describe("runDevicePlan", () => {
  it("runs every step on the base build then on the candidate, paints the screen's secrets, and stops the emulator each time", async () => {
    const { captured, starts, runs } = await run();
    expect(captured.device).toBe("android_emulator");
    expect(captured.isolation).toBe("sandbox");
    expect(captured.steps.map((row) => [row.flow, row.step, row.status])).toEqual([["main", "open", "shown"], ["main", "next", "shown"]]);
    expect(starts.filter((row) => row.file.endsWith("/emulator"))).toHaveLength(2);
    expect(starts.every((row) => row.stops.length === 1 && !row.running)).toBe(true);
    expect(runs.filter((row) => row.args.includes("install")).map((row) => row.args.at(-1))).toEqual(["/apps/before.apk", "/apps/after.apk"]);
    for (const row of captured.steps) {
      if (row.status !== "shown") throw new Error("shown expected");
      for (const side of [row.before, row.after]) {
        const picture = decodeJpeg(side.bytes);
        expect([picture.width, picture.height]).toEqual([W, H]);
        // the title row stays light, the email row and the password row are painted black, the area below is untouched
        expect(pixel(picture.rgba, 48, 8)).toBeGreaterThan(200);
        expect(pixel(picture.rgba, 48, 24)).toBeLessThan(30);
        expect(pixel(picture.rgba, 48, 40)).toBeLessThan(30);
        expect(pixel(picture.rgba, 48, 56)).toBeGreaterThan(200);
      }
    }
  });

  it("the printed line is believed by the worker, and is a picture only: kind visual, never proof, labelled as an emulator", async () => {
    const { captured, plan } = await run();
    const parsed = parseDeviceExecutorOutput(new TextEncoder().encode(`${encodeDeviceExecutorOutput(captured)}\n`), plan)!;
    expect(parsed.steps).toHaveLength(2);
    const ref = (bytes: Uint8Array) => ({ kind: "jpeg" as const, sha256: "a".repeat(64), bytes: bytes.byteLength, retentionClass: "evidence-std" as const });
    const outcome: DeviceEvidenceOutcome = { ...parsed, steps: parsed.steps.map((row) => (row.status === "shown" ? { ...row, before: ref(row.before.bytes), after: ref(row.after.bytes) } : row)) };
    const { check } = deviceEvidenceCheck(outcome);
    expect(check).toMatchObject({ kind: "visual", runBy: "rovara", label: "Device evidence: Android emulator", stage: "sandbox" });
    expect(checkKindInfo("visual").countsTowardProof).toBe(false);
    const lines = deviceEvidenceLines(outcome, {});
    expect(lines[0]).toContain("Ran on an Android emulator in Rovara's sandbox");
    expect(lines.filter((row) => row.includes("before and after screenshots")).every((row) => row.includes("does not count as change proof"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/fake/iu);
  });

  it("runs a step's Maestro flow between the pictures: the launch flow, then the step's own", async () => {
    const { files } = await run();
    const flows = [...files.values()];
    expect(flows.filter((text) => text.includes("clearState: true"))).toHaveLength(4);
    expect(flows.filter((text) => text.includes("tapOn:") && text.includes("\"Continue\""))).toHaveLength(2);
  });

  it("says why when the emulator does not boot: no step, the fixed reason, and the emulator stopped", async () => {
    const { captured, starts } = await run({ boot: [""] });
    expect(captured).toMatchObject({ notRun: "device_did_not_start", steps: [] });
    expect(starts.every((row) => !row.running)).toBe(true);
  });

  it("says the app did not build when it does not install", async () => {
    expect((await run({ install: answer("Failure [INSTALL_FAILED_OLDER_SDK]", 1) })).captured).toMatchObject({ notRun: "app_did_not_build", steps: [] });
  });

  it("withholds a screen it cannot read, and the admin's fixture-data choice does not change that (it waives a screen with no tree, never one that failed to read)", async () => {
    for (const fixtureDataOnly of [false, true]) {
      const { captured } = await run({ cat: answer("", 1) }, { ...baseInput, fixtureDataOnly });
      expect(captured.steps.map((row) => (row.status === "not_run" ? row.reason : "shown"))).toEqual(["unreadable_screen", "unreadable_screen"]);
      expect(captured.unmasked).toBe(0);
    }
  });

  it("withholds a screen whose secret it cannot paint, never shows it", async () => {
    const noBounds = dump(`<node class="android.widget.TextView" text="Contact: sam@example.org" />`);
    const { captured } = await run({ dump: noBounds });
    expect(captured.steps.every((row) => row.status === "not_run" && row.reason === "masked_content")).toBe(true);
  });

  it("a step that fails stops its flow's later steps and says so, and the picture of the step before it stays", async () => {
    const { captured } = await run({ maestro: (text) => (text.includes("Continue") ? answer("Element not found", 1) : answer("ok")) });
    expect(captured.steps.map((row) => (row.status === "not_run" ? row.reason : "shown"))).toEqual(["shown", "step_failed"]);
  });

  it("shows a game or canvas screen only under the admin's fixture-data choice, and counts it", async () => {
    const game = dump(`<node class="android.view.SurfaceView" bounds="${box(0, 0, 96, 64)}" />`);
    expect((await run({ dump: game })).captured.steps.map((row) => (row.status === "not_run" ? row.reason : "shown"))).toEqual(["unreadable_screen", "unreadable_screen"]);
    const allowed = await run({ dump: game }, { ...baseInput, fixtureDataOnly: true });
    expect(allowed.captured.steps.map((row) => row.status)).toEqual(["shown", "shown"]);
    expect(allowed.captured.unmasked).toBe(2);
    const first = allowed.captured.steps[0]!;
    if (first.status !== "shown") throw new Error("shown expected");
    // the surface is painted whatever the choice says: the screen has no text to vouch for, so it is its own black rectangle
    expect(pixel(decodeJpeg(first.before.bytes).rgba, 48, 32)).toBeLessThan(30);
  });

  it("holds the run to the plan's own time limit", async () => {
    // Each tool call takes 400 ms of the plan's 1,000 ms: the run ends before the device is ready.
    const { captured } = await run({}, { ...baseInput, runMs: 1_000 }, 400);
    expect(captured).toMatchObject({ notRun: "time_limit", steps: [] });
  });
});
