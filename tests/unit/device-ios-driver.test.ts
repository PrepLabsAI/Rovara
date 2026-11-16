// Device testing slice 4: the iOS simulator driver against a scripted Mac (the project's build, `xcrun simctl`, Maestro). What it runs and with which environment and folder; which simulator it picks; that
// it creates, uses and deletes ONLY a simulator of its own; what it answers when the build, the app folder, the simulator, the install or a step fails; how it reads the screen (Maestro's hierarchy as a view
// tree in pixels, `simctl io screenshot` as pixels); and that it fails closed on everything it cannot read.
import { describe, expect, it } from "vitest";
import { DEVICE_UNREADABLE_TREE } from "../../packages/contracts/src/device-evidence-android.js";
import { IOS_BOOT_MS, IOS_SIMULATOR_PREFIX, chooseIosSimulator, createIosSimulatorDriver, type IosDriverOptions } from "../../packages/verifier/src/executor/device-ios.js";
import { png } from "../support/device-png-encode.js";
import { answer } from "../support/device-command-fake.js";
import { MAESTRO_IOS, PIXELS, RUNTIMES, SHELL, UDID, XCRUN, fakeIos, hierarchy, maestroRuns, simctlRuns, type FakeIosScript } from "../support/device-ios-fake.js";

const BUNDLE = "io.rovara.fixture-app";
const BUILD_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/Users/dev", TMPDIR: "/tmp/rovara-run" });
const TOOL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/Users/dev", JAVA_HOME: "/opt/jdk" });
const FLOWS = [{ id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text" as const, text: "Continue" }] }] }];

function clock() { let t = 1_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }
function setup(script: FakeIosScript = {}, over: Partial<IosDriverOptions> = {}, options: { tick?: number; built?: string | undefined } = {}) {
  const time = clock();
  const fake = fakeIos({ ...script, first: (file, args) => { time.advance(options.tick ?? 0); return script.first?.(file, args); } });
  const diag: Array<[string, string, string | undefined]> = [];
  const builtCalls: Array<[string, string]> = [];
  const driver = createIosSimulatorDriver({
    command: fake.port, bundleId: BUNDLE, buildCommand: "xcodebuild -scheme App -sdk iphonesimulator -derivedDataPath build", appFile: "build/App.app", checkouts: { before: "/work/base", after: "/work/head" },
    flows: FLOWS, tools: { shell: SHELL, xcrun: XCRUN, maestro: MAESTRO_IOS }, scratchDir: "/tmp/rovara-run/scratch", buildEnv: BUILD_ENV, toolEnv: TOOL_ENV,
    files: { writeFile: fake.writeFile, readFile: fake.readFile, removeFile: fake.removeFile, builtApp: (checkout, appFile) => { builtCalls.push([checkout, appFile]); return Promise.resolve("built" in options ? options.built : `${checkout}/build/App.app`.replace("/work/head", "/work/head")); } },
    randomHex: () => "abc123", now: time.now, diag: (stage, note, detail) => { diag.push([stage, note, detail]); }, ...over,
  });
  return { ...fake, driver, time, diag, builtCalls };
}

describe("chooseIosSimulator", () => {
  it("takes the newest AVAILABLE iOS runtime and on it the newest numbered iPhone (not a Pro, an SE or an iPad)", () => {
    expect(chooseIosSimulator(JSON.parse(RUNTIMES))).toEqual({ runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" });
  });
  it("falls back to the first iPhone by name when none is numbered, and compares versions as numbers (17.10 is newer than 17.9)", () => {
    const rt = (version: string, names: string[], extra: Record<string, unknown> = {}) => ({ identifier: `rt-${version}`, version, platform: "iOS", isAvailable: true, supportedDeviceTypes: names.map((name) => ({ name, identifier: `dt-${name.replace(/\W/gu, "")}` })), ...extra });
    expect(chooseIosSimulator({ runtimes: [rt("17.9", ["iPhone 15"]), rt("17.10", ["iPhone Air", "iPhone 16 Pro"])] })).toEqual({ runtime: "rt-17.10", deviceType: "dt-iPhone16Pro" });
    expect(chooseIosSimulator({ runtimes: [rt("17.9", ["iPhone 15"]), rt("17.10", ["iPhone 16"])] })).toEqual({ runtime: "rt-17.10", deviceType: "dt-iPhone16" });
  });
  it("is undefined, never a guess, when there is no usable iOS runtime or the list is not that shape", () => {
    const iPhone = [{ name: "iPhone 16", identifier: "dt-1" }];
    const base = { identifier: "rt", version: "18.0", platform: "iOS", isAvailable: true, supportedDeviceTypes: iPhone };
    for (const value of [undefined, null, 5, "x", [], {}, { runtimes: "x" }, { runtimes: [] }, { runtimes: [{ ...base, isAvailable: false }] }, { runtimes: [{ ...base, isAvailable: "true" }] }, { runtimes: [{ ...base, platform: "tvOS", name: "tvOS 18" }] },
      { runtimes: [{ ...base, supportedDeviceTypes: [{ name: "iPad", identifier: "x" }] }] }, { runtimes: [{ ...base, supportedDeviceTypes: "x" }] }, { runtimes: [{ ...base, version: "latest" }] }, { runtimes: [{ ...base, identifier: "a b" }] },
      { runtimes: [{ ...base, supportedDeviceTypes: [{ name: "iPhone 16", identifier: "a;b" }] }] }, { runtimes: [5, null] }, { runtimes: Array.from({ length: 201 }, () => base) }]) {
      expect(chooseIosSimulator(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
    }
    expect(chooseIosSimulator({ runtimes: [base] })).toEqual({ runtime: "rt", deviceType: "dt-1" });
  });
});

describe("createIosSimulatorDriver", () => {
  it("refuses settings it was not built for", () => {
    const fake = fakeIos();
    const base: IosDriverOptions = {
      command: fake.port, bundleId: BUNDLE, buildCommand: "make app", appFile: "build/App.app", checkouts: { before: "/work/base", after: "/work/head" }, flows: FLOWS, tools: { shell: SHELL, xcrun: XCRUN, maestro: MAESTRO_IOS },
      scratchDir: "/tmp/x", buildEnv: BUILD_ENV, toolEnv: TOOL_ENV, files: { writeFile: fake.writeFile, readFile: fake.readFile, removeFile: fake.removeFile, builtApp: () => Promise.resolve(undefined) },
    };
    for (const over of [{ bundleId: "app" }, { bundleId: "io.x\n---" }, { bundleId: "io.x y" }, { buildCommand: "" }, { buildCommand: "x".repeat(501) }, { buildCommand: "make\nrm -rf /" }, { appFile: "build/App.apk" }, { appFile: "/abs/App.app" },
      { appFile: "../App.app" }, { appFile: "a//App.app" }, { appFile: "a/./App.app" }, { checkouts: { before: "work", after: "/b" } }, { checkouts: { before: "/a b", after: "/b" } }, { checkouts: { before: "/a/../b", after: "/b" } },
      { checkouts: { before: "/same", after: "/same" } }, { scratchDir: "tmp" }, { scratchDir: "/tmp/a b" }, { tools: { shell: "sh", xcrun: XCRUN, maestro: MAESTRO_IOS } }, { tools: { shell: SHELL, xcrun: XCRUN, maestro: "/m a" } }]) {
      expect(() => createIosSimulatorDriver({ ...base, ...over }), JSON.stringify(over)).toThrow("the iOS driver settings are not valid");
    }
    expect(() => createIosSimulatorDriver(base)).not.toThrow();
  });
  it("is an iOS simulator, never a fake", () => { expect(setup().driver.kind).toBe("ios_simulator"); });

  describe("prepare", () => {
    it("builds this side's app in this side's checkout with the scrubbed environment, makes and boots a simulator of its own, installs, warms Maestro up, and says ready", async () => {
      const { driver, runs, files, builtCalls } = setup();
      expect(await driver.prepare("after", { timeoutMs: 600_000 })).toBe("ready");
      const build = runs[0]!;
      expect([build.file, build.args]).toEqual([SHELL, ["-c", "xcodebuild -scheme App -sdk iphonesimulator -derivedDataPath build"]]);
      expect(build.options).toMatchObject({ cwd: "/work/head", env: BUILD_ENV, discardOutput: true });
      expect(builtCalls).toEqual([["/work/head", "build/App.app"]]);
      expect(simctlRuns(runs).map((row) => row.slice(0, 2))).toEqual([["list", "runtimes"], ["create", `${IOS_SIMULATOR_PREFIX}abc123`], ["bootstatus", UDID], ["io", UDID], ["install", UDID]]);
      expect(simctlRuns(runs)[1]).toEqual(["create", `${IOS_SIMULATOR_PREFIX}abc123`, "com.apple.CoreSimulator.SimDeviceType.iPhone-16", "com.apple.CoreSimulator.SimRuntime.iOS-18-2"]);
      expect(simctlRuns(runs)[2]).toEqual(["bootstatus", UDID, "-b"]);
      expect(simctlRuns(runs)[4]).toEqual(["install", UDID, "/work/head/build/App.app"]);
      for (const row of runs.filter((r) => r.file !== SHELL)) expect(row.options.env, row.args.join(" ")).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/Users/dev" });
      const warm = maestroRuns(runs)[0]!;
      expect(warm.args.slice(0, 3)).toEqual(["--device", UDID, "test"]);
      expect(files.get(warm.args[3]!)).toBe(`appId: "${BUNDLE}"\n---\n- launchApp:\n    clearState: true\n    stopApp: true\n    permissions:\n      all: deny\n`);
    });
    it("builds the base side in the base checkout, so the two sides never share a build", async () => {
      const { driver, runs } = setup();
      await driver.prepare("before", { timeoutMs: 600_000 });
      expect(runs[0]!.options.cwd).toBe("/work/base");
    });
    it("says the app did not build when the build fails, and starts nothing else (no simulator is made)", async () => {
      const { driver, runs, simulators } = setup({ build: answer("", 2) });
      expect(await driver.prepare("after", { timeoutMs: 600_000 })).toBe("app_did_not_build");
      expect(runs).toHaveLength(1);
      expect(simulators.size).toBe(0);
    });
    it("says the app did not build when the build produces no .app folder inside the checkout, before any simulator is made", async () => {
      for (const built of [undefined, "relative/App.app", "/work/head/build/App", "/work/head/a b/App.app"]) {
        const { driver, runs } = setup({}, {}, { built });
        expect(await driver.prepare("after", { timeoutMs: 600_000 }), String(built)).toBe("app_did_not_build");
        expect(simctlRuns(runs)).toEqual([]);
      }
    });
    it("says time limit when the build runs out of time", async () => {
      const { driver } = setup({ build: answer("", null, { timedOut: true }) });
      expect(await driver.prepare("after", { timeoutMs: 600_000 })).toBe("time_limit");
    });
    it("says needs macOS when `xcrun simctl` is not there, and the device did not start when there is no usable runtime or the list is not JSON", async () => {
      expect(await setup({ runtimes: answer("", null) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("needs_macos");
      expect(await setup({ runtimes: answer("", 127) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("needs_macos");
      for (const runtimes of [answer("{}"), answer("not json"), answer("", 1), answer(RUNTIMES, 0, { tooLarge: true })]) {
        const { driver, runs } = setup({ runtimes });
        expect(await driver.prepare("after", { timeoutMs: 600_000 })).toBe("device_did_not_start");
        expect(simctlRuns(runs).some((row) => row[0] === "create")).toBe(false);
      }
    });
    it("says the device did not start when the simulator cannot be made, prints something that is not an id, or does not boot; and deletes the simulator it made", async () => {
      expect(await setup({ create: answer("", 1) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(await setup({ create: answer("not-an-id\n") }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      const { driver, runs, simulators } = setup({ bootstatus: answer("", 1) });
      expect(await driver.prepare("after", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(simulators.has(UDID)).toBe(true);
      await driver.stop("after");
      expect(simctlRuns(runs).slice(-2)).toEqual([["shutdown", UDID], ["delete", UDID]]);
      expect(simulators.size).toBe(0);
    });
    it("says the device did not start when there is no first screenshot (the screen's size is needed to read the tree)", async () => {
      for (const script of [{ screenshot: answer("", 1) }, { png: undefined }, { png: png(2, 2, () => [0, 0, 0]).subarray(0, 40) }] as FakeIosScript[]) {
        expect(await setup(script).driver.prepare("after", { timeoutMs: 600_000 }), JSON.stringify(Object.keys(script))).toBe("device_did_not_start");
      }
    });
    it("says the app did not build when it will not install", async () => {
      expect(await setup({ install: answer("error", 1) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("app_did_not_build");
    });
    it("says the device did not start when Maestro cannot warm up, and time limit when it runs out of time", async () => {
      expect(await setup({ maestro: () => answer("boom", 1) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("device_did_not_start");
      expect(await setup({ maestro: () => answer("", null, { timedOut: true }) }).driver.prepare("after", { timeoutMs: 600_000 })).toBe("time_limit");
    });
    it("gives the boot no more than its own limit, and every command no more than the time left", async () => {
      const { driver, runs } = setup();
      await driver.prepare("after", { timeoutMs: 1_000_000 });
      const boot = runs.find((row) => row.args[1] === "bootstatus")!;
      expect(boot.options.timeoutMs).toBe(IOS_BOOT_MS);
      const tight = setup({}, {}, { tick: 400 });
      expect(await tight.driver.prepare("after", { timeoutMs: 1_000 })).toBe("time_limit");
      const latest = setup({}, {}, { tick: 10 });
      await latest.driver.prepare("after", { timeoutMs: 600_000 });
      for (const row of latest.runs) expect(row.options.timeoutMs).toBeLessThanOrEqual(600_000);
    });
    it("stops at once when stopped during prepare, and says time limit", async () => {
      const holder: { driver?: ReturnType<typeof setup>["driver"] } = {};
      const s = setup({ first: (file, args) => { if (file === XCRUN && args[1] === "list") void holder.driver?.stop("after"); return undefined; } });
      holder.driver = s.driver;
      expect(await s.driver.prepare("after", { timeoutMs: 600_000 })).toBe("time_limit");
      expect(simctlRuns(s.runs).some((row) => row[0] === "create")).toBe(false);
    });
    it("never starts a command with a shell for anything but the project's own build, and never passes the build's environment to a tool or the tools' environment to the build", async () => {
      const { driver, runs } = setup();
      await driver.prepare("after", { timeoutMs: 600_000 });
      expect(runs.filter((row) => row.file === SHELL)).toHaveLength(1);
      for (const row of runs.filter((r) => r.file !== SHELL)) expect(row.options.env).not.toHaveProperty("TMPDIR");
      expect(runs[0]!.options.env).not.toHaveProperty("JAVA_HOME");
    });
  });

  describe("flows and steps", () => {
    async function ready(script: FakeIosScript = {}) { const s = setup(script); await s.driver.prepare("after", { timeoutMs: 600_000 }); return s; }
    it("starts a flow from a clean state, and does what a step's actions say as a Maestro flow", async () => {
      const { driver, runs, files } = await ready();
      expect(await driver.startFlow("after", "main", { timeoutMs: 30_000 })).toBe("ok");
      expect(await driver.performStep("after", "main", "next", { timeoutMs: 30_000 })).toBe("ok");
      const last = maestroRuns(runs).at(-1)!;
      expect(files.get(last.args[3]!)).toBe(`appId: "${BUNDLE}"\n---\n- tapOn:\n    text: "Continue"\n`);
      expect(last.options.env).toMatchObject({ MAESTRO_CLI_NO_ANALYTICS: "true", JAVA_HOME: "/opt/jdk" });
    });
    it("does nothing for a step with no actions, and answers step_failed or time_limit as Maestro does", async () => {
      const { driver, runs } = await ready();
      const before = maestroRuns(runs).length;
      expect(await driver.performStep("after", "main", "open", { timeoutMs: 30_000 })).toBe("ok");
      expect(maestroRuns(runs)).toHaveLength(before);
      // The warm-up flow (a launch) passes; the step's own flow (a tap) is the one that fails or runs out of time.
      expect(await (await ready({ maestro: (flow) => (flow.includes("tapOn") ? answer("no", 1) : answer("")) })).driver.performStep("after", "main", "next", { timeoutMs: 30_000 })).toBe("step_failed");
      expect(await (await ready({ maestro: (flow) => (flow.includes("tapOn") ? answer("", null, { timedOut: true }) : answer("")) })).driver.performStep("after", "main", "next", { timeoutMs: 30_000 })).toBe("time_limit");
    });
    it("answers step_failed for everything before prepare or after stop", async () => {
      const fresh = setup();
      expect(await fresh.driver.startFlow("after", "main", { timeoutMs: 1_000 })).toBe("step_failed");
      expect(await fresh.driver.performStep("after", "main", "next", { timeoutMs: 1_000 })).toBe("step_failed");
      const { driver } = await ready();
      await driver.stop("after");
      expect(await driver.startFlow("after", "main", { timeoutMs: 1_000 })).toBe("step_failed");
      expect(await driver.performStep("after", "main", "next", { timeoutMs: 1_000 })).toBe("step_failed");
    });
  });

  describe("reading the screen", () => {
    async function ready(script: FakeIosScript = {}) { const s = setup(script); await s.driver.prepare("after", { timeoutMs: 600_000 }); return s; }
    it("reads the tree from Maestro's hierarchy, in the screenshot's pixels", async () => {
      const { driver, runs } = await ready();
      const tree = await driver.readTree("after", { timeoutMs: 20_000 });
      expect(tree).toEqual({ width: PIXELS.width, height: PIXELS.height, nodes: [
        { text: "Total: 12", bounds: { x: 30, y: 300, width: 570, height: 120 } }, { text: "••••", secure: true, bounds: { x: 30, y: 600, width: 1110, height: 120 } },
      ] });
      const call = maestroRuns(runs).at(-1)!;
      expect(call.args).toEqual(["--device", UDID, "hierarchy"]);
    });
    it("is unreadable (never a smaller tree) when the hierarchy fails, is too large, times out, is not the tree, or the simulator is not ready", async () => {
      for (const hier of [answer("", 1), answer("{}", 0, { tooLarge: true }), answer("", null, { timedOut: true }), "garbage", hierarchy().replace("390", "400")]) {
        const { driver } = await ready({ hierarchy: hier });
        expect(await driver.readTree("after", { timeoutMs: 20_000 }), JSON.stringify(hier)?.slice(0, 60)).toEqual(DEVICE_UNREADABLE_TREE);
      }
      expect(await setup().driver.readTree("after", { timeoutMs: 20_000 })).toEqual(DEVICE_UNREADABLE_TREE);
      const { driver } = await ready();
      await driver.stop("after");
      expect(await driver.readTree("after", { timeoutMs: 20_000 })).toEqual(DEVICE_UNREADABLE_TREE);
    });
    it("takes a screenshot as a frame, through a file of its own that it removes after", async () => {
      const { driver, runs, removed, files } = await ready();
      const frame = (await driver.screenshot("after", { timeoutMs: 20_000 })) as { width: number; height: number; rgba: Uint8Array };
      expect([frame.width, frame.height, frame.rgba.length]).toEqual([PIXELS.width, PIXELS.height, PIXELS.width * PIXELS.height * 4]);
      expect([...frame.rgba.subarray(0, 4)]).toEqual([230, 230, 230, 255]);
      const shot = simctlRuns(runs).filter((row) => row[0] === "io").at(-1)!;
      expect(shot.slice(0, 4)).toEqual(["io", UDID, "screenshot", "--type=png"]);
      expect(shot[4]).toMatch(/^\/tmp\/rovara-run\/scratch\/shot-\d+\.png$/u);
      expect(removed).toContain(shot[4]);
      expect(files.has(shot[4]!)).toBe(false);
    });
    it("has no frame when the screenshot fails, times out, writes no file, is not a PNG, or the simulator is not ready", async () => {
      const later = <T>(value: T, first: unknown) => (call: number) => (call === 1 ? first : value) as never;
      const good = png(PIXELS.width, PIXELS.height, () => [230, 230, 230], { channels: 3 });
      for (const script of [{ screenshot: later(answer("", 1), answer()) }, { screenshot: later(answer("", null, { timedOut: true }), answer()) }, { png: later(undefined, good) }, { png: later(new Uint8Array([1, 2, 3]), good) },
        { png: later(good.subarray(0, 40), good) }] as FakeIosScript[]) {
        const { driver } = await ready(script);
        expect(await driver.screenshot("after", { timeoutMs: 20_000 }), JSON.stringify(Object.keys(script))).toBeUndefined();
      }
      expect(await setup().driver.screenshot("after", { timeoutMs: 20_000 })).toBeUndefined();
    });
  });

  describe("stop", () => {
    it("shuts down and deletes exactly the simulator it created, and never touches any other", async () => {
      const { driver, runs, simulators } = setup();
      await driver.prepare("after", { timeoutMs: 600_000 });
      simulators.add("DEVELOPER-OWN-SIMULATOR");
      await driver.stop("after");
      expect(simctlRuns(runs).filter((row) => row[0] === "shutdown" || row[0] === "delete")).toEqual([["shutdown", UDID], ["delete", UDID]]);
      expect([...simulators]).toEqual(["DEVELOPER-OWN-SIMULATOR"]);
      const count = runs.length;
      await driver.stop("after");
      expect(runs).toHaveLength(count);
    });
    it("does nothing when nothing was made, and never acts on an id that is not what `simctl create` printed", async () => {
      const fresh = setup();
      await fresh.driver.stop("before");
      expect(fresh.runs).toHaveLength(0);
      const odd = setup({ create: answer("booted; rm -rf /\n") });
      await odd.driver.prepare("after", { timeoutMs: 600_000 });
      await odd.driver.stop("after");
      expect(simctlRuns(odd.runs).some((row) => row[0] === "delete" || row[0] === "shutdown")).toBe(false);
    });
    it("still deletes the simulator when the shutdown fails, and keeps the sides apart", async () => {
      const { driver, runs } = setup({ first: (file, args) => (file === XCRUN && args[1] === "shutdown" ? answer("", 1) : undefined) });
      await driver.prepare("before", { timeoutMs: 600_000 });
      await driver.stop("before");
      expect(simctlRuns(runs).filter((row) => row[0] === "delete")).toEqual([["delete", UDID]]);
    });
  });
});
