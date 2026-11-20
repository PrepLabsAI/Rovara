// Device testing slice 2: the whole device-executor program over scripted tools. The runner (slice 1), the Android driver, the real JPEG encoder and the answer's checks work together: a screen
// with a secret in it comes out painted, a run that cannot boot says why, a screen that cannot be read is withheld even under the admin's fixture-data choice, and what is printed is believed
// by the worker only through its own checks.
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_STEP_MS, deviceEvidenceCheck, deviceEvidenceLines, type DeviceEvidenceOutcome } from "../../packages/contracts/src/device-evidence.js";
import { checkKindInfo } from "../../packages/contracts/src/check-kinds.js";
import { DEVICE_ENV, prepareWritableAvd, runDevicePlan } from "../../packages/verifier/src/executor/device-evidence-entry.js";
import { decodeDeviceExecutorPlan, encodeDeviceExecutorOutput, encodeDeviceExecutorPlan, parseDeviceExecutorOutput, type DeviceExecutorPlanInput } from "../../packages/verifier/src/host/device-executor.js";
import { answer, fakeAndroid, rawScreencap, type FakeAndroidScript } from "../support/device-command-fake.js";

const W = 96;
const H = 64;
const box = (l: number, t: number, r: number, b: number) => `[${String(l)},${String(t)}][${String(r)},${String(b)}]`;
const dump = (...nodes: string[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><displays><display id="0"><window id="1"><hierarchy rotation="0">${nodes.join("")}</hierarchy></window></display></displays>`;
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

describe("runDevicePlan", () => {

  it("the printed line is believed by the worker, and is a picture only: kind visual, never proof, labelled as an emulator", async () => {
    const { captured, plan } = await run();
    const parsed = parseDeviceExecutorOutput(new TextEncoder().encode(`${encodeDeviceExecutorOutput(captured)}\n`), plan)!;
    expect(parsed.steps).toHaveLength(2);
    const ref = (bytes: Uint8Array) => ({ kind: "jpeg" as const, sha256: "a".repeat(64), bytes: bytes.byteLength, retentionClass: "evidence-std" as const });
    const outcome: DeviceEvidenceOutcome = { ...parsed, steps: parsed.steps.map((row) => (row.status === "shown" ? { ...row, before: ref(row.before.bytes), after: ref(row.after.bytes) } : row)) };
    const { check } = deviceEvidenceCheck(outcome);
    expect(check).toMatchObject({ kind: "visual", runBy: "rovara", label: "Device evidence: Android emulator", stage: "sandbox" });
    expect(checkKindInfo("visual")?.countsTowardProof).toBe(false);
    const lines = deviceEvidenceLines(outcome, {});
    expect(lines[0]).toContain("Ran on an Android emulator in Rovara's sandbox");
    expect(lines.filter((row) => row.includes("before and after screenshots")).every((row) => row.includes("does not count as change proof"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/fake/iu);
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

  it("holds the run to the plan's own time limit", async () => {
    // Each tool call takes 400 ms of the plan's 1,000 ms: the run ends before the device is ready.
    const { captured } = await run({}, { ...baseInput, runMs: 1_000 }, 400);
    expect(captured).toMatchObject({ notRun: "time_limit", steps: [] });
  });
});

describe("the AVD the emulator starts from", () => {
  it("is a private, writable copy of the image's AVD with its .ini pointing at the copy, and the image's own directory is never written", () => {
    const root = mkdtempSync(join(tmpdir(), "rovara-avd-test-"));
    const from = join(root, "image");
    const to = join(root, "copy");
    mkdirSync(join(from, "rovara.avd", "sub"), { recursive: true });
    writeFileSync(join(from, "rovara.avd", "config.ini"), "hw.ramSize=2048\n");
    writeFileSync(join(from, "rovara.avd", "sub", "x.img"), "x");
    writeFileSync(join(from, "rovara.ini"), "path=/opt/android-avd/rovara.avd\n");
    prepareWritableAvd("rovara", from, to);
    expect(readFileSync(join(to, "rovara.avd", "config.ini"), "utf8")).toBe("hw.ramSize=2048\n");
    expect(readFileSync(join(to, "rovara.avd", "sub", "x.img"), "utf8")).toBe("x");
    expect(readFileSync(join(to, "rovara.ini"), "utf8")).toBe(`avd.ini.encoding=UTF-8\npath=${to}/rovara.avd\ntarget=android-34\n`);
    expect(() => { accessSync(join(to, "rovara.avd"), constants.W_OK); }).not.toThrow();
    expect(readFileSync(join(from, "rovara.ini"), "utf8")).toBe("path=/opt/android-avd/rovara.avd\n");
    expect(DEVICE_ENV.ANDROID_AVD_HOME).toBe("/tmp/rovara-avd");
  });
});
