// Device testing slice 2: the Android emulator driver against scripted adb, emulator and Maestro. What it starts, with which arguments and environment; what it answers when the emulator does not
// boot, the app does not install or a step fails; how it reads the screen (the UI dump as a view tree, `screencap` as pixels); and that it fails closed on everything it cannot read.
import { describe, expect, it } from "vitest";
import { DEVICE_UNREADABLE_TREE } from "../../packages/contracts/src/device-evidence-android.js";
import {
  ANDROID_BOOT_MS, androidEmulatorArgs, createAndroidEmulatorDriver, rawScreencapFrame, type AndroidDriverOptions,
} from "../../packages/verifier/src/executor/device-android.js";
import { ADB, EMULATOR, MAESTRO, answer, fakeAndroid, rawScreencap, type FakeAndroidScript, type RecordedRun } from "../support/device-command-fake.js";

const APP = "io.rovara.fixture";
const ENV = Object.freeze({ PATH: "/usr/bin", HOME: "/home/android", ANDROID_SDK_ROOT: "/opt/android-sdk" });
const FLOWS = [{ id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text" as const, text: "Continue" }] }] }];
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><displays><display id="0"><window id="1"><hierarchy rotation="0"><node class="android.widget.TextView" text="Total: 12" bounds="[0,100][720,300]" /><node class="android.widget.EditText" password="true" text="••••" bounds="[0,300][720,500]" /></hierarchy></window></display></displays>`;

function clock() {
  let t = 1_000;
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve(); }, advance: (ms: number) => { t += ms; } };
}
function setup(script: FakeAndroidScript = {}, over: Partial<AndroidDriverOptions> = {}, tick = 0, talks = true) {
  const time = clock();
  const fake = fakeAndroid({ ...script, first: (file, args) => { time.advance(tick); return script.first?.(file, args); } });
  const diag: Array<[string, string, string | undefined]> = [];
  const driver = createAndroidEmulatorDriver({
    command: fake.port, appId: APP, apps: { before: "/apps/before.apk", after: "/apps/after.apk" }, flows: FLOWS, tools: { adb: ADB, emulator: EMULATOR, maestro: MAESTRO, avd: "rovara" }, scratchDir: "/tmp/rovara-device",
    env: ENV, writeFile: fake.writeFile, now: time.now, sleep: time.sleep, ...(talks ? { diag: (stage: string, note: string, detail?: string) => { diag.push([stage, note, detail]); } } : {}), ...over,
  });
  return { ...fake, driver, time, diag };
}
const maestroRuns = (runs: RecordedRun[]) => runs.filter((row) => row.file === MAESTRO);

describe("androidEmulatorArgs", () => {
  it("starts the image's own AVD headless and read-only, with no snapshot, sound, camera or metrics, and KVM or nothing", () => {
    expect(androidEmulatorArgs({ avd: "rovara", port: 5554 })).toEqual(["-avd", "rovara", "-port", "5554", "-read-only", "-no-snapshot", "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-gpu", "swiftshader_indirect",
      "-accel", "on", "-camera-back", "none", "-camera-front", "none", "-netdelay", "none", "-netspeed", "full", "-memory", "2048", "-cores", "2"]);
  });
});

describe("createAndroidEmulatorDriver", () => {
  it("refuses settings it was not built for", () => {
    const base = { command: fakeAndroid().port, appId: APP, apps: { before: "/apps/before.apk", after: "/apps/after.apk" }, flows: FLOWS, tools: { adb: ADB, emulator: EMULATOR, maestro: MAESTRO, avd: "rovara" }, scratchDir: "/tmp/x", env: ENV, writeFile: () => Promise.resolve() };
    for (const over of [{ appId: "app" }, { appId: "io.x\n--- " }, { apps: { before: "relative.apk", after: "/a.apk" } }, { apps: { before: "/a.apk", after: "/a b.apk" } }, { apps: { before: "/a.apk", after: "/a.apk; rm" } }, { apps: { before: "/a/../b.apk", after: "/b.apk" } },
      { scratchDir: "tmp" }, { scratchDir: "/tmp/a b" }, { tools: { adb: "adb", emulator: EMULATOR, maestro: MAESTRO, avd: "rovara" } }, { tools: { adb: ADB, emulator: EMULATOR, maestro: MAESTRO, avd: "a b" } }, { port: 5555 }]) {
      expect(() => createAndroidEmulatorDriver({ ...base, ...over }), JSON.stringify(over)).toThrow();
    }
    expect(() => createAndroidEmulatorDriver(base)).not.toThrow();
  });

  describe("prepare", () => {

    it("says the emulator did not start when it exits before the boot is done", async () => {
      const setupped = setup({ boot: ["", "", "", ""] });
      const racing = setupped.driver.prepare("before", { timeoutMs: 600_000 });
      setupped.starts.find((row) => row.file === EMULATOR)!.running = false;
      expect(await racing).toBe("device_did_not_start");
      expect(setupped.runs.some((row) => row.args.includes("install"))).toBe(false);
    });

    it("says the device did not start when adb's server cannot stay up (its port was taken first), and believes nothing it said", async () => {
      const setupped = setup({ boot: ["", "", "", ""] });
      const racing = setupped.driver.prepare("before", { timeoutMs: 600_000 });
      setupped.starts.find((row) => row.file === ADB)!.running = false;
      expect(await racing).toBe("device_did_not_start");
      // it gave up at once, not after the boot limit
      expect(setupped.time.now() - 1_000).toBeLessThan(10_000);
      expect(setupped.runs.some((row) => row.args.includes("install"))).toBe(false);
    });

    it("says the emulator did not start when the boot takes longer than its own limit, and the time limit when the run's time ends first", async () => {
      const never = setup({ boot: [""] });
      expect(await never.driver.prepare("before", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(never.time.now() - 1_000).toBeGreaterThanOrEqual(ANDROID_BOOT_MS);
      expect(never.time.now() - 1_000).toBeLessThan(ANDROID_BOOT_MS + 20_000);
      const short = setup({ boot: [""] });
      expect(await short.driver.prepare("before", { timeoutMs: 30_000 })).toBe("time_limit");
      expect(short.time.now() - 1_000).toBeLessThan(40_000);
    });

    it("says the emulator did not start when its screen size or a setting cannot be read", async () => {
      expect(await setup({ wmSize: "nothing" }).driver.prepare("before", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(await setup({ settings: 1 }).driver.prepare("before", { timeoutMs: 600_000 })).toBe("device_did_not_start");
    });

    it("says the device did not start when Maestro cannot start, and the time limit when it runs out of time", async () => {
      expect(await setup({ maestro: () => answer("boom", 1) }).driver.prepare("before", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(await setup({ maestro: () => answer("", null, { timedOut: true }) }).driver.prepare("before", { timeoutMs: 600_000 })).toBe("time_limit");
    });

    it("answers the time limit when the run's time ends while the app installs, and starts no Maestro after that", async () => {
      const slow = setup({}, {}, 10_000);
      expect(await slow.driver.prepare("before", { timeoutMs: 45_000 })).toBe("time_limit");
      expect(slow.runs.some((row) => row.args.includes("install"))).toBe(true);
      expect(maestroRuns(slow.runs)).toHaveLength(0);
    });

    it("answers the time limit when the runner already stopped it (a prepare that answered late), and goes no further", async () => {
      const racing = setup({ boot: ["", "", "1"] });
      const pending = racing.driver.prepare("before", { timeoutMs: 600_000 });
      await racing.driver.stop("before");
      expect(await pending).toBe("time_limit");
      expect(racing.runs.some((row) => row.args.includes("install"))).toBe(false);
      expect(maestroRuns(racing.runs)).toHaveLength(0);
    });
  });

  describe("steps", () => {

    it("runs a step's actions as a Maestro flow, and a step with none runs nothing", async () => {
      const { driver, runs, files } = setup();
      await driver.prepare("before", { timeoutMs: 600_000 });
      const before = maestroRuns(runs).length;
      expect(await driver.performStep("before", "main", "open", { timeoutMs: 30_000 })).toBe("ok");
      expect(maestroRuns(runs)).toHaveLength(before);
      expect(await driver.performStep("before", "main", "next", { timeoutMs: 30_000 })).toBe("ok");
      expect(files.get(maestroRuns(runs)[before]!.args[3]!)).toBe("appId: io.rovara.fixture\n---\n- tapOn:\n    text: \"Continue\"\n");
      // a step the plan does not know has no actions
      expect(await driver.performStep("before", "main", "unknown", { timeoutMs: 30_000 })).toBe("ok");
    });

    it("does nothing on a side that was not prepared, or was stopped", async () => {
      const { driver, runs } = setup();
      expect(await driver.startFlow("before", "main", { timeoutMs: 30_000 })).toBe("step_failed");
      expect(await driver.performStep("before", "main", "next", { timeoutMs: 30_000 })).toBe("step_failed");
      await driver.prepare("before", { timeoutMs: 600_000 });
      await driver.stop("before");
      const count = runs.length;
      expect(await driver.startFlow("before", "main", { timeoutMs: 30_000 })).toBe("step_failed");
      expect(await driver.performStep("before", "main", "next", { timeoutMs: 30_000 })).toBe("step_failed");
      expect(runs).toHaveLength(count);
    });
  });

  describe("reading the screen", () => {

    it("is unreadable (not null: a failed read is never 'no tree') when the dump fails, cannot be read, is too big or is not a dump", async () => {
      for (const script of [{ dump: answer("ERROR: could not get idle state", 1) }, { dump: DUMP, cat: answer("", 1) }, { dump: answer("ERROR: could not get idle state", 1), cat: answer(DUMP) }, { dump: DUMP, cat: answer("x", 0, { tooLarge: true }) }, { dump: DUMP, cat: answer("x", 0, { timedOut: true }) },
        { dump: "not xml" }, { dump: "" }, { dump: "<displays>" }, { dump: DUMP.replace("<displays><display id=\"0\"><window id=\"1\">", "").replace("</window></display></displays>", "") }]) {
        const { driver } = setup(script);
        await driver.prepare("before", { timeoutMs: 600_000 });
        const tree = await driver.readTree("before", { timeoutMs: 20_000 });
        expect(tree, JSON.stringify(script)).toEqual(DEVICE_UNREADABLE_TREE);
      }
    });

    it("is unreadable on a side that is not ready, and never starts anything for it", async () => {
      const { driver, runs } = setup({ dump: DUMP });
      expect(await driver.readTree("before", { timeoutMs: 20_000 })).toEqual(DEVICE_UNREADABLE_TREE);
      expect(await driver.screenshot("before", { timeoutMs: 20_000 })).toBeUndefined();
      expect(runs).toHaveLength(0);
    });

    it("is not a frame when the program failed, ran out of time or printed too much", async () => {
      for (const screencap of [answer(rawScreencap(4, 4), 1), answer(rawScreencap(4, 4), 0, { timedOut: true }), answer(rawScreencap(4, 4), 0, { tooLarge: true })]) {
        const { driver } = setup({ screencap });
        await driver.prepare("before", { timeoutMs: 600_000 });
        expect(await driver.screenshot("before", { timeoutMs: 20_000 })).toBeUndefined();
      }
    });
  });

  describe("stop", () => {

    it("is harmless on a side that never started, and when its own commands fail", async () => {
      const idle = setup();
      await expect(idle.driver.stop("before")).resolves.toBeUndefined();
      expect(idle.runs).toHaveLength(0);
      const failing = setup({ first: (_file, args) => (args.includes("emu") ? answer("", null, { timedOut: true }) : undefined) });
      await failing.driver.prepare("before", { timeoutMs: 600_000 });
      await expect(failing.driver.stop("before")).resolves.toBeUndefined();
    });
  });

  describe("what it says", () => {
    it("says nothing unless asked, and a log that throws changes no answer", async () => {
      const quiet = setup({});
      expect(await quiet.driver.prepare("before", { timeoutMs: 600_000 })).toBe("ready");
      const throwing = setup({}, { diag: () => { throw new Error("log failed"); } });
      expect(await throwing.driver.prepare("before", { timeoutMs: 600_000 })).toBe("ready");
    });
  });
});

describe("rawScreencapFrame", () => {
  it("refuses a frame of another format, a short or long one, a header that is not 12 or 16, and one over the pixel cap", () => {
    const good = rawScreencap(3, 2);
    for (const bad of [rawScreencap(3, 2, { format: 4 }), rawScreencap(3, 2, { format: 0 }), good.slice(0, good.length - 1), new Uint8Array([...good, 0]), new Uint8Array(11), new Uint8Array(0), new Uint8Array([...good.slice(0, 8), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...good.slice(16)])]) {
      expect(rawScreencapFrame(bad)).toBeUndefined();
    }
    const huge = new Uint8Array(16);
    new DataView(huge.buffer).setUint32(0, 4_000, true);
    new DataView(huge.buffer).setUint32(4, 4_000, true);
    new DataView(huge.buffer).setUint32(8, 1, true);
    expect(rawScreencapFrame(huge)).toBeUndefined();
    const zero = new Uint8Array(16);
    new DataView(zero.buffer).setUint32(8, 1, true);
    expect(rawScreencapFrame(zero)).toBeUndefined();
  });
});
